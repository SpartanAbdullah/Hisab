#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Hisaab — database trust-boundary test harness
# ----------------------------------------------------------------------------
# Builds a throwaway Supabase-shaped Postgres, applies the whole SQL corpus in
# the canonical order, then runs supabase/tests/tests/*.sql as role
# `authenticated`. Any failed assertion fails the script.
#
#   ./supabase/tests/run.sh                 # docker run postgres:15, apply, test
#   ./supabase/tests/run.sh --keep          # leave the container up afterwards
#   ./supabase/tests/run.sh --apply-only    # migrations only, no tests
#   ./supabase/tests/run.sh --shell         # apply, then drop into psql
#
# CI (.github/workflows/db-tests.yml) sets HISAAB_TEST_DSN to a service
# container instead, and this script skips the docker lifecycle entirely.
#
# Env:
#   HISAAB_TEST_DSN   full libpq URI; if set, no container is created
#   PG_IMAGE          default postgres:15
#   PG_PORT           host port for the throwaway container (default 55432)
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

PG_IMAGE="${PG_IMAGE:-postgres:15}"
PG_PORT="${PG_PORT:-55432}"
CONTAINER="hisaab-db-tests-$$"
KEEP=0
APPLY_ONLY=0
SHELL_AFTER=0

for arg in "$@"; do
  case "$arg" in
    --keep)       KEEP=1 ;;
    --apply-only) APPLY_ONLY=1 ;;
    --shell)      SHELL_AFTER=1; KEEP=1 ;;
    -h|--help)    sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'
[ -t 1 ] || { RED=''; GREEN=''; DIM=''; OFF=''; }

fail() { echo "${RED}✗ $*${OFF}" >&2; exit 1; }
info() { echo "${DIM}· $*${OFF}"; }

# ── 1. get a database ───────────────────────────────────────────────────────
OWN_CONTAINER=0
if [ -n "${HISAAB_TEST_DSN:-}" ]; then
  DSN="$HISAAB_TEST_DSN"
  info "using HISAAB_TEST_DSN"
else
  command -v docker >/dev/null 2>&1 || fail "docker not found and HISAAB_TEST_DSN unset"
  OWN_CONTAINER=1
  info "starting $PG_IMAGE as $CONTAINER on :$PG_PORT"
  docker run -d --rm --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=hisaab \
    -p "$PG_PORT:5432" \
    "$PG_IMAGE" >/dev/null
  DSN="postgresql://postgres:postgres@127.0.0.1:$PG_PORT/hisaab"
fi

cleanup() {
  local rc=$?
  if [ "$OWN_CONTAINER" = 1 ] && [ "$KEEP" = 0 ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  elif [ "$OWN_CONTAINER" = 1 ]; then
    echo "${DIM}· container kept: docker exec -it $CONTAINER psql -U postgres hisaab${OFF}"
    echo "${DIM}·   remove with:  docker rm -f $CONTAINER${OFF}"
  fi
  exit $rc
}
trap cleanup EXIT

# psql runs inside the container when we own it (no local client needed on
# Windows/macOS dev boxes), otherwise from the host.
if [ "$OWN_CONTAINER" = 1 ]; then
  psql_run() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -X -q \
                 -U postgres -d hisaab "$@"; }
else
  command -v psql >/dev/null 2>&1 || fail "psql not on PATH"
  psql_run() { psql -v ON_ERROR_STOP=1 -X -q "$DSN" "$@"; }
fi

# ── 2. wait for readiness ───────────────────────────────────────────────────
info "waiting for postgres"
for i in $(seq 1 60); do
  if psql_run -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && fail "postgres never became ready"
  sleep 1
done
psql_run -c "SELECT 'PostgreSQL ' || current_setting('server_version')" -t -A

# ── 3. scaffold ─────────────────────────────────────────────────────────────
info "applying scaffold.sql"
psql_run < "$HERE/scaffold.sql" \
  || fail "scaffold.sql failed"

# ── 4. the corpus, in canonical order ───────────────────────────────────────
COUNT=0
while IFS= read -r line; do
  # strip comments / blanks / CR (this repo is edited on Windows)
  line="${line%%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  f="$ROOT/$line"
  [ -f "$f" ] || fail "apply-order.txt names a missing file: $line"
  COUNT=$((COUNT + 1))
  printf '%s[%02d] %s%s\n' "$DIM" "$COUNT" "$line" "$OFF"
  psql_run < "$f" > /dev/null \
    || fail "migration failed: $line"
done < "$HERE/apply-order.txt"
echo "${GREEN}✓ $COUNT files applied cleanly${OFF}"

if [ "$APPLY_ONLY" = 1 ]; then
  echo "--apply-only: stopping before tests"
  exit 0
fi

# ── 5. tests ────────────────────────────────────────────────────────────────
# Each file is a self-contained psql script. They share one database and run in
# filename order (00-…, 10-…, 20-…) because later files reuse the fixture users
# and group created by 00-fixtures.sql.
echo
info "running tests"
TESTS=$(ls "$HERE"/tests/*.sql | sort)
[ -n "$TESTS" ] || fail "no test files in $HERE/tests"

RC=0
for t in $TESTS; do
  name="$(basename "$t")"
  printf '%s──%s %s\n' "$DIM" "$OFF" "$name"
  # Assertions RAISE NOTICE; a failed one is recorded in test.results and
  # surfaced (as a hard error) by 99-summary.sql. Capture psql's own exit code
  # separately from the formatting pipeline — grep matching nothing is not a
  # test failure, but a non-zero psql IS.
  set +e
  out="$(psql_run < "$t" 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out" | grep -E '^(NOTICE|ERROR|DETAIL|psql)' \
    | sed 's/^NOTICE:  //' || true
  if [ "$rc" != 0 ]; then
    echo "${RED}✗ $name failed (psql exit $rc)${OFF}" >&2
    RC=1
  fi
done

if [ "$SHELL_AFTER" = 1 ]; then
  docker exec -it "$CONTAINER" psql -U postgres -d hisaab
fi

if [ "$RC" != 0 ]; then
  echo "${RED}✗ database tests FAILED${OFF}" >&2
  exit 1
fi
echo "${GREEN}✓ database tests passed${OFF}"

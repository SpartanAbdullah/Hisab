-- ════════════════════════════════════════════════════════════════════════════
-- 99 · Tally.
--
-- test.summary() prints the totals and RAISEs if ANY assertion failed or if
-- zero assertions were recorded (a harness that silently ran nothing must not
-- report green). psql runs with ON_ERROR_STOP=1, so that RAISE fails the file,
-- which fails run.sh, which fails the CI job.
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
RESET ROLE;

SELECT suite,
       count(*)                              AS assertions,
       count(*) FILTER (WHERE NOT passed)    AS failed
  FROM test.results
 GROUP BY suite
 ORDER BY suite;

SELECT test.summary();

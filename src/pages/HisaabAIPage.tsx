import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Send, Check, X, ShieldCheck, Flame, CalendarClock, Ghost, ChevronRight } from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useRecurringStore } from '../stores/recurringStore';
import { useAsyncLoad } from '../hooks/useAsyncLoad';
import { PageErrorState } from '../components/PageErrorState';
import { useToast } from '../components/Toast';
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  formatMoney,
} from '../lib/constants';
import { type ParsedExpense, type Direction } from '../lib/nlExpenseParser';
import { pickAccountForDraft, buildTransactionFromDraft } from '../lib/nlExpenseToTransaction';
import { routeAssistantInput } from '../lib/hisaabAssistant';
import type { ParsedGroupExpense } from '../lib/nlGroupExpenseParser';
import { equalSplits } from '../lib/splitMath';
import { parseAmountExpression } from '../lib/parseAmountExpression';
import { upcomingRenewals, detectGhosts, describeGhost } from '../lib/subscriptionMetrics';
import { computeMonthlyWrap } from '../lib/monthlyWrap';
import { computeLoggingStreak } from '../lib/loggingStreak';
import { useAppModeStore } from '../stores/appModeStore';
import { useSplitStore } from '../stores/splitStore';
import { getActiveGroupMembers } from '../lib/groupActiveMembers';
import type { Account, SplitGroup, Currency } from '../db';

const NAVY_BLOOM =
  'radial-gradient(120% 90% at 80% 10%, rgba(124,92,255,0.32) 0%, rgba(124,92,255,0) 55%), radial-gradient(80% 70% at 10% 100%, rgba(217,97,74,0.18) 0%, rgba(217,97,74,0) 60%)';

const EXAMPLE_PROMPTS = ['add 3 aed for karak', 'How do subscriptions work?', 'Which mode should I use?'];
const SPLITS_EXAMPLES = ['How do I split a bill?', 'How do I settle up?', 'Should I use Full Tracker?'];

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; text: string; suggestions?: string[] }
  | { id: number; role: 'chip'; draft: ParsedExpense; resolved?: string }
  | { id: number; role: 'groupchip'; draft: ParsedGroupExpense; groupId: string; resolved?: string };

function currentUserId(): string {
  return localStorage.getItem('hisaab_supabase_uid') ?? '';
}

// Fuzzy-match a parsed group-name hint against the user's groups.
function matchGroups(hint: string | null, groups: SplitGroup[]): SplitGroup[] {
  if (!hint) return [];
  const h = hint.toLowerCase();
  return groups.filter((g) => g.name.toLowerCase().includes(h) || h.includes(g.name.toLowerCase()));
}

function primaryCurrency(): string {
  return localStorage.getItem('hisaab_primary_currency') || 'AED';
}

export function HisaabAIPage() {
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const transactions = useTransactionStore((s) => s.transactions);
  const loadTransactions = useTransactionStore((s) => s.loadTransactions);
  const processTransaction = useTransactionStore((s) => s.processTransaction);
  const groups = useSplitStore((s) => s.groups);
  const loadGroups = useSplitStore((s) => s.loadGroups);
  const addGroupExpense = useSplitStore((s) => s.addGroupExpense);
  const templates = useRecurringStore((s) => s.templates);
  const loadTemplates = useRecurringStore((s) => s.loadTemplates);
  const mode = useAppModeStore((s) => s.mode);
  const isFull = mode === 'full_tracker';
  const navigate = useNavigate();
  const toast = useToast();

  const load = useCallback(async () => {
    await Promise.all([loadAccounts(), loadTransactions(), loadGroups(), loadTemplates()]);
  }, [loadAccounts, loadTransactions, loadGroups, loadTemplates]);
  const { status: loadStatus, error: loadError, retry: retryLoad } = useAsyncLoad(load);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busyChipId, setBusyChipId] = useState<number | null>(null);
  const nextId = useRef(1);
  const scrollAnchor = useRef<HTMLDivElement>(null);

  const mkId = () => nextId.current++;

  useEffect(() => {
    scrollAnchor.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // ── This month, in the primary currency (no cross-currency summing) ──
  const summary = useMemo(() => {
    const cur = primaryCurrency();
    const ym = new Date().toISOString().slice(0, 7);
    const monthExpenses = transactions.filter(
      (t) => t.type === 'expense' && t.currency === cur && (t.createdAt ?? '').slice(0, 7) === ym,
    );
    const spent = monthExpenses.reduce((a, t) => a + t.amount, 0);
    const byCat = new Map<string, number>();
    for (const t of monthExpenses) {
      const k = t.category || 'Other';
      byCat.set(k, (byCat.get(k) ?? 0) + t.amount);
    }
    const top = [...byCat.entries()]
      .map(([name, amt]) => ({ name, amt }))
      .sort((a, b) => b.amt - a.amt)
      .slice(0, 5);
    return { cur, spent, top, count: monthExpenses.length };
  }, [transactions]);

  // Gentle nudges + streak (Full Tracker feed only). All on-device.
  const todayIso = new Date().toISOString().slice(0, 10);
  const streak = useMemo(
    () => computeLoggingStreak(transactions.filter((t) => t.type === 'expense').map((t) => t.createdAt), todayIso),
    [transactions, todayIso],
  );
  const renewals = useMemo(() => upcomingRenewals(templates, todayIso, 7), [templates, todayIso]);
  const ghosts = useMemo(() => detectGhosts(templates, todayIso), [templates, todayIso]);
  const wrapAvailable = useMemo(
    () => !!computeMonthlyWrap(transactions, (localStorage.getItem('hisaab_primary_currency') as Currency) || 'AED'),
    [transactions],
  );

  // Resolve a parsed split into either a group confirm-chip, or guidance that
  // asks which group / how much when we can't pin it down.
  const buildGroupReply = (draft: ParsedGroupExpense): Msg[] => {
    if (!draft.canCreate) {
      return [{ id: mkId(), role: 'ai', text: draft.clarify ?? 'How much should I split?' }];
    }
    if (groups.length === 0) {
      return [{
        id: mkId(),
        role: 'ai',
        text: "You don't have any groups yet. Create one on the Groups tab, then I can split expenses into it.",
      }];
    }
    const matches = matchGroups(draft.groupNameHint, groups);
    let group: SplitGroup | null = null;
    if (matches.length === 1) group = matches[0];
    else if (!draft.groupNameHint && groups.length === 1) group = groups[0];

    if (group) return [{ id: mkId(), role: 'groupchip', draft, groupId: group.id }];

    const picks = (matches.length > 1 ? matches : groups).slice(0, 4);
    const amt = draft.amount ?? 0;
    return [{
      id: mkId(),
      role: 'ai',
      text: draft.groupNameHint
        ? `I couldn't pin down "${draft.groupNameHint}" — which group?`
        : 'Which group should I split this into?',
      suggestions: picks.map((g) => `split ${amt} ${draft.description} with ${g.name}`),
    }];
  };

  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const userMsg: Msg = { id: mkId(), role: 'user', text };
    const reply = routeAssistantInput(text, { mode, defaultCurrency: primaryCurrency() });

    let aiMsgs: Msg[];
    if (reply.kind === 'group' && reply.group) {
      aiMsgs = buildGroupReply(reply.group);
    } else if (reply.kind === 'command' && reply.command) {
      if (isFull && reply.command.canPost) {
        aiMsgs = [{ id: mkId(), role: 'chip', draft: reply.command }];
      } else if (isFull) {
        // Understood a money intent but the amount is missing — guide, don't post.
        aiMsgs = [{ id: mkId(), role: 'ai', text: reply.command.clarify ?? "How much was it?" }];
      } else {
        // Splits-only has no personal accounts to post against — route to the split flow.
        aiMsgs = [{
          id: mkId(),
          role: 'ai',
          text: "In Splits mode I track shared expenses, not personal accounts. Tell me to \"split\" it with a group, or switch to Full Tracker in Settings to log it as your own expense.",
          suggestions: reply.suggestions,
        }];
      }
    } else if (reply.kind === 'knowledge' && reply.knowledge) {
      aiMsgs = [{ id: mkId(), role: 'ai', text: reply.knowledge.answer }];
    } else {
      aiMsgs = [{ id: mkId(), role: 'ai', text: reply.text ?? 'Try one of these:', suggestions: reply.suggestions }];
    }

    setMessages((m) => [...m, userMsg, ...aiMsgs]);
    setInput('');
  };

  const confirmChip = async (chipId: number, input: ReturnType<typeof buildTransactionFromDraft>, summaryText: string) => {
    if (!input) return;
    setBusyChipId(chipId);
    try {
      await processTransaction(input);
      await Promise.all([loadAccounts(), loadTransactions()]);
      setMessages((m) =>
        m
          .map((msg) => (msg.id === chipId && msg.role === 'chip' ? { ...msg, resolved: summaryText } : msg))
          .concat({ id: mkId(), role: 'ai', text: `Done — ${summaryText} logged. Anything else? Try 'careem 30'.` }),
      );
      toast.show({ type: 'success', title: 'Saved', subtitle: summaryText });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not save',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    } finally {
      setBusyChipId(null);
    }
  };

  const confirmGroupChip = async (chipId: number, group: SplitGroup, amount: number, description: string) => {
    const activeMembers = getActiveGroupMembers(group);
    const memberIds = activeMembers.map((m) => m.id);
    const payerId = activeMembers.find((m) => m.profileId === currentUserId())?.id;
    if (memberIds.length === 0) {
      toast.show({ type: 'error', title: 'No active members to split with' });
      return;
    }
    if (!payerId) {
      toast.show({
        type: 'error',
        title: "Couldn't find you in this group",
        subtitle: 'Open the group to add this expense.',
      });
      return;
    }
    setBusyChipId(chipId);
    try {
      const splits = equalSplits(amount, memberIds);
      await addGroupExpense({
        groupId: group.id,
        description,
        amount,
        paidBy: payerId,
        splitType: 'equal',
        splits,
        category: '',
        notes: '',
      });
      await loadGroups();
      const summaryText = `${formatMoney(amount, group.currency)} · ${description} · split ${memberIds.length} ways`;
      setMessages((m) =>
        m
          .map((msg) => (msg.id === chipId && msg.role === 'groupchip' ? { ...msg, resolved: summaryText } : msg))
          .concat({ id: mkId(), role: 'ai', text: `Done — added to ${group.name}. ${summaryText}.` }),
      );
      toast.show({ type: 'success', title: 'Split added', subtitle: summaryText });
    } catch (err) {
      toast.show({
        type: 'error',
        title: 'Could not add split',
        subtitle: err instanceof Error ? err.message : 'Try again.',
      });
    } finally {
      setBusyChipId(null);
    }
  };

  const cancelChip = (chipId: number) => {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === chipId && (msg.role === 'chip' || msg.role === 'groupchip')
          ? { ...msg, resolved: 'cancelled' }
          : msg,
      ),
    );
  };

  return (
    <main className="min-h-dvh bg-cream-bg pb-44">
      {/* ── Navy hero ── */}
      <div className="relative overflow-hidden text-white" style={{ background: 'var(--color-navy-800)' }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: NAVY_BLOOM }} />
        <div className="relative px-5 pt-6 pb-7">
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'linear-gradient(135deg, var(--color-accent-500), var(--color-accent-600))' }}
            >
              <Sparkles size={18} className="text-white" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-semibold tracking-tight">Hisaab AI</span>
              <span className="text-[8px] font-bold tracking-[0.1em] px-1.5 py-[3px] rounded-full bg-white/15 text-white/80">
                BETA
              </span>
            </div>
            <div className="ml-auto flex items-center gap-1.5 text-[10.5px] text-white/60">
              <ShieldCheck size={12} className="text-white/60" /> On-device
            </div>
          </div>

          {/* This month headline — only meaningful in Full Tracker (Splits Only
              has no personal accounts). In Splits mode the AI is a guide + split helper. */}
          {isFull ? (
            <>
              <p className="text-[11px] text-white/55 font-semibold tracking-[0.12em] uppercase mt-5 mb-2">
                Spent this month
              </p>
              {summary.count > 0 ? (
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[40px] font-semibold tracking-tight tabular-nums leading-none">
                    {summary.spent.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </span>
                  <span className="text-[15px] font-medium text-white/50">{summary.cur}</span>
                </div>
              ) : (
                <p className="text-[13px] text-white/70 leading-relaxed mt-1">
                  Log a few expenses and I&rsquo;ll show you where your money goes — and one thing you can do about it.
                </p>
              )}
            </>
          ) : (
            <p className="text-[13px] text-white/70 leading-relaxed mt-4">
              Your shared expenses, samjho. Tell me to split a bill, ask who owes whom, or ask how anything in Hisaab works.
            </p>
          )}
        </div>
      </div>

      <div className="px-5 -mt-4 relative space-y-4">
        {loadStatus === 'error' && (
          <PageErrorState
            variant="inline"
            title="Couldn't load your data"
            message={loadError ?? 'Some data failed to load.'}
            onRetry={retryLoad}
          />
        )}

        {/* Streak — gentle encouragement only, never shaming (Full Tracker) */}
        {isFull && streak.streak > 0 && (
          <div className="flex items-center gap-2.5 rounded-2xl bg-cream-card border border-cream-border px-4 py-3">
            <div className="w-8 h-8 rounded-xl bg-accent-50 flex items-center justify-center shrink-0">
              <Flame size={16} className="text-accent-600" />
            </div>
            <p className="text-[12.5px] text-ink-700">
              <span className="font-semibold text-ink-900">{streak.streak}-day</span> logging streak
              {streak.loggedToday ? ' — nice work.' : ' — log one today to keep it going.'}
            </p>
          </div>
        )}

        {/* Where it goes — real data, tappable into the category detail */}
        {isFull && summary.top.length > 0 && (
          <div className="rounded-2xl bg-cream-card border border-cream-border p-4">
            <p className="text-[11px] font-semibold tracking-[0.12em] uppercase text-ink-500 mb-3">
              Where it goes
            </p>
            <div className="space-y-1">
              {summary.top.map((c, i) => {
                const max = summary.top[0].amt || 1;
                const pct = Math.round((c.amt / max) * 100);
                return (
                  <button
                    key={c.name}
                    onClick={() => navigate(`/hisaab-ai/insight/${encodeURIComponent(c.name)}`)}
                    className="w-full flex items-center gap-2.5 py-1.5 text-left active:opacity-70 transition-opacity"
                  >
                    <span className="w-20 text-[11.5px] text-ink-600 truncate shrink-0">{c.name}</span>
                    <div className="flex-1 h-2 rounded-full bg-cream-soft overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: i === 0 ? 'var(--color-pay-600)' : 'var(--color-ink-300)',
                        }}
                      />
                    </div>
                    <span className="w-14 text-right text-[11.5px] font-semibold text-ink-900 tabular-nums shrink-0">
                      {formatMoney(c.amt, summary.cur).replace(`${summary.cur} `, '')}
                    </span>
                    <ChevronRight size={13} className="text-ink-300 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* For you — gentle in-app nudges (renewals + forgotten subs) */}
        {isFull && (renewals.length > 0 || ghosts.length > 0) && (
          <div className="space-y-2">
            {renewals.slice(0, 1).map((r) => (
              <div
                key={`r-${r.template.id}`}
                className="flex items-center gap-2.5 rounded-2xl bg-info-50 border border-cream-border px-4 py-3"
              >
                <CalendarClock size={16} className="text-info-600 shrink-0" />
                <p className="text-[12.5px] text-info-600">
                  <span className="font-semibold">{r.template.label || 'A subscription'}</span> renews{' '}
                  {r.daysUntil === 0 ? 'today' : `in ${r.daysUntil}d`} ·{' '}
                  {formatMoney(r.template.amount, r.template.currency)}
                </p>
              </div>
            ))}
            {ghosts.slice(0, 1).map((g) => (
              <button
                key={`g-${g.template.id}`}
                onClick={() => navigate('/subscriptions')}
                className="w-full flex items-center gap-2.5 rounded-2xl bg-pay-50 border border-pay-100 px-4 py-3 text-left active:opacity-70 transition-opacity"
              >
                <Ghost size={16} className="text-pay-text shrink-0" />
                <p className="text-[12.5px] text-pay-text flex-1">
                  <span className="font-semibold">{g.template.label || g.template.category}</span> —{' '}
                  {describeGhost(g, todayIso)}
                </p>
                <ChevronRight size={13} className="text-pay-text shrink-0" />
              </button>
            ))}
          </div>
        )}

        {/* Monthly wrap teaser */}
        {isFull && wrapAvailable && (
          <button
            onClick={() => navigate('/hisaab-ai/wrap')}
            className="w-full flex items-center gap-3 rounded-2xl text-left text-white p-4 active:opacity-90 transition-opacity"
            style={{ background: 'var(--color-navy-800)' }}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'rgba(255,255,255,0.08)' }}
            >
              <Sparkles size={18} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13.5px] font-semibold">Last month, wrapped</p>
              <p className="text-[11px] text-white/60 mt-0.5">A calm month-in-review — no scores, no judgement.</p>
            </div>
            <ChevronRight size={16} className="text-white/60 shrink-0" />
          </button>
        )}

        {/* ── Conversation ── */}
        <div className="space-y-3">
          {/* Intro / first-run guidance — always visible so a new user is never lost */}
          <AIBubble>
            <p>
              {isFull
                ? "Salaam! Tell me what you spent in plain words and I'll log it — I always show a card to confirm first, so nothing is saved without your tap. You can also ask me how anything in Hisaab works."
                : "Salaam! I'm your Hisaab guide. Ask me how to split a bill, settle up, or which mode fits you — and I'll point you the right way."}
            </p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {(isFull ? EXAMPLE_PROMPTS : SPLITS_EXAMPLES).map((q) => (
                <SuggestionChip key={q} q={q} onTap={() => submit(q)} />
              ))}
            </div>
          </AIBubble>

          {messages.map((m) => {
            if (m.role === 'user') return <UserBubble key={m.id}>{m.text}</UserBubble>;
            if (m.role === 'ai')
              return (
                <AIBubble key={m.id}>
                  <p>{m.text}</p>
                  {m.suggestions && m.suggestions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {m.suggestions.map((q) => (
                        <SuggestionChip key={q} q={q} onTap={() => submit(q)} />
                      ))}
                    </div>
                  )}
                </AIBubble>
              );
            if (m.role === 'groupchip') {
              const g = groups.find((x) => x.id === m.groupId) ?? null;
              return (
                <GroupChipCard
                  key={m.id}
                  draft={m.draft}
                  group={g}
                  resolved={m.resolved}
                  busy={busyChipId === m.id}
                  onConfirm={(amount, description) => g && confirmGroupChip(m.id, g, amount, description)}
                  onCancel={() => cancelChip(m.id)}
                />
              );
            }
            return (
              <ChipCard
                key={m.id}
                draft={m.draft}
                accounts={accounts}
                resolved={m.resolved}
                busy={busyChipId === m.id}
                onConfirm={(input, summaryText) => confirmChip(m.id, input, summaryText)}
                onCancel={() => cancelChip(m.id)}
                onAddAccount={() => navigate('/accounts')}
              />
            );
          })}
          <div ref={scrollAnchor} />
        </div>
      </div>

      {/* ── Pinned ask bar (above the bottom nav) ── */}
      <div
        className="fixed left-1/2 -translate-x-1/2 w-full max-w-[480px] px-5 z-30"
        style={{ bottom: 'calc(70px + env(safe-area-inset-bottom))' }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="flex items-center gap-2 rounded-2xl bg-white border border-cream-border p-2 pl-4"
          style={{ boxShadow: '0 8px 24px -12px rgba(11,14,42,0.35)' }}
        >
          <Sparkles size={16} className="text-accent-600 shrink-0" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isFull ? 'Add an expense — e.g. karak 3 aed' : 'Ask me anything about Hisaab'}
            className="flex-1 min-w-0 text-[13px] text-ink-900 placeholder:text-ink-400 bg-transparent outline-none"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={!input.trim()}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0 disabled:opacity-40 active:scale-95 transition-transform"
            style={{ background: 'var(--color-accent-600)' }}
          >
            <Send size={15} />
          </button>
        </form>
      </div>
    </main>
  );
}

function SuggestionChip({ q, onTap }: { q: string; onTap: () => void }) {
  return (
    <button
      onClick={onTap}
      className="text-[11.5px] font-medium px-3 py-1.5 rounded-full bg-cream-soft border border-cream-border text-ink-700 active:scale-95 transition-transform"
    >
      {q}
    </button>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-ink-900 text-white text-[13px] leading-snug">
        {children}
      </div>
    </div>
  );
}

function AIBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: 'linear-gradient(135deg, var(--color-accent-500), var(--color-accent-600))' }}
      >
        <Sparkles size={13} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-md bg-cream-card border border-cream-border px-3.5 py-3 text-[13px] leading-relaxed text-ink-800">
        {children}
      </div>
    </div>
  );
}

function GroupChipCard({
  draft,
  group,
  resolved,
  busy,
  onConfirm,
  onCancel,
}: {
  draft: ParsedGroupExpense;
  group: SplitGroup | null;
  resolved?: string;
  busy: boolean;
  onConfirm: (amount: number, description: string) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(draft.amount ?? ''));
  const [description, setDescription] = useState(draft.description);

  if (resolved === 'cancelled') {
    return <AIBubble>No problem — I didn&rsquo;t add that split.</AIBubble>;
  }
  if (!group) {
    return <AIBubble>That group isn&rsquo;t available anymore — try again from the Groups tab.</AIBubble>;
  }

  const activeMembers = getActiveGroupMembers(group);
  const n = activeMembers.length;
  const amt = parseAmountExpression(amount) ?? parseFloat(amount);
  const amountValid = Number.isFinite(amt) && amt > 0;
  const perHead = amountValid && n > 0 ? amt / n : 0;

  return (
    <div className="flex gap-2.5">
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: 'linear-gradient(135deg, var(--color-accent-500), var(--color-accent-600))' }}
      >
        <Sparkles size={13} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-md bg-cream-card border border-cream-border p-3.5">
        {resolved && resolved !== 'cancelled' ? (
          <div className="flex items-center gap-2 text-[13px] text-receive-text font-semibold">
            <Check size={15} /> {resolved}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[15px]">{group.emoji}</span>
              <span className="text-[13px] font-semibold text-ink-900">{group.name}</span>
              <span className="text-[11px] text-ink-500">· split equally</span>
            </div>
            <div className="flex items-center gap-2 mb-2.5">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.+\-*/() ]/g, ''))}
                onBlur={() => { const r = parseAmountExpression(amount); if (r != null) setAmount(String(r)); }}
                className="w-24 text-[18px] font-semibold text-ink-900 tabular-nums bg-cream-soft border border-cream-border rounded-lg px-2.5 py-1.5 outline-none focus:border-accent-500"
              />
              <span className="text-[13px] font-medium text-ink-500">{group.currency}</span>
            </div>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What for?"
              className="w-full text-[13px] text-ink-900 placeholder:text-ink-400 bg-cream-soft border border-cream-border rounded-lg px-2.5 py-2 mb-2.5 outline-none focus:border-accent-500"
            />
            <p className="text-[11.5px] text-ink-500 mb-3">
              Split among {n} {n === 1 ? 'member' : 'members'}
              {amountValid ? ` · ~${formatMoney(perHead, group.currency)} each` : ''}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => amountValid && onConfirm(amt, description.trim() || draft.description)}
                disabled={busy || !amountValid}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[12.5px] font-semibold text-white disabled:opacity-40 active:scale-[0.98] transition-transform"
                style={{ background: 'var(--color-accent-600)' }}
              >
                <Check size={14} /> {busy ? 'Adding…' : 'Confirm & split'}
              </button>
              <button
                onClick={onCancel}
                disabled={busy}
                aria-label="Cancel"
                className="px-3 rounded-xl border border-cream-border text-ink-500 active:bg-cream-soft transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface ChipCardProps {
  draft: ParsedExpense;
  accounts: Account[];
  resolved?: string;
  busy: boolean;
  onConfirm: (input: ReturnType<typeof buildTransactionFromDraft>, summaryText: string) => void;
  onCancel: () => void;
  onAddAccount: () => void;
}

function ChipCard({ draft, accounts, resolved, busy, onConfirm, onCancel, onAddAccount }: ChipCardProps) {
  const [direction, setDirection] = useState<Direction>(draft.direction);
  const [amount, setAmount] = useState(String(draft.amount ?? ''));
  const defaultAccount = useMemo(() => pickAccountForDraft(draft, accounts), [draft, accounts]);
  const [accountId, setAccountId] = useState(defaultAccount?.id ?? '');
  const cats: readonly string[] = direction === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const [category, setCategory] = useState<string>(
    draft.category && cats.includes(draft.category) ? draft.category : 'Other',
  );
  const labelIsEcho = !!draft.category && draft.label.toLowerCase() === draft.category.toLowerCase();
  const [note, setNote] = useState(labelIsEcho ? '' : draft.label);

  // Keep the category valid when the user flips direction.
  useEffect(() => {
    if (!cats.includes(category)) setCategory('Other');
  }, [direction, cats, category]);

  if (resolved === 'cancelled') {
    return <AIBubble>No problem — I didn&rsquo;t save that. Tell me again whenever you&rsquo;re ready.</AIBubble>;
  }

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const amt = parseAmountExpression(amount) ?? parseFloat(amount);
  const amountValid = Number.isFinite(amt) && amt > 0;

  if (accounts.length === 0) {
    return (
      <AIBubble>
        <p>I&rsquo;ve got the details, but you need an account to save it to first.</p>
        <button
          onClick={onAddAccount}
          className="mt-2.5 text-[12px] font-semibold text-white rounded-lg px-3 py-2 active:scale-95 transition-transform"
          style={{ background: 'var(--color-accent-600)' }}
        >
          Add an account
        </button>
      </AIBubble>
    );
  }

  const handleConfirm = () => {
    if (!account || !amountValid) return;
    const input = buildTransactionFromDraft(
      { amount: amt, direction, category: category === 'Other' ? null : category, label: note || category },
      account,
    );
    const sign = direction === 'income' ? '+' : '−';
    const summaryText = `${sign} ${formatMoney(amt, account.currency)}${note ? ` · ${note}` : ''} → ${account.name}`;
    onConfirm(input, summaryText);
  };

  return (
    <div className="flex gap-2.5">
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: 'linear-gradient(135deg, var(--color-accent-500), var(--color-accent-600))' }}
      >
        <Sparkles size={13} className="text-white" />
      </div>
      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-md bg-cream-card border border-cream-border p-3.5">
        {resolved && resolved !== 'cancelled' ? (
          <div className="flex items-center gap-2 text-[13px] text-receive-text font-semibold">
            <Check size={15} /> {resolved}
          </div>
        ) : (
          <>
            <p className="text-[12px] text-ink-500 mb-3">
              {draft.currencyAssumed && draft.currency
                ? `Got it — saving in ${account?.currency ?? draft.currency}. Confirm or tweak:`
                : "Here's what I understood — confirm or tweak:"}
            </p>

            {/* direction toggle */}
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {(['expense', 'income'] as Direction[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`py-1.5 rounded-lg text-[11.5px] font-semibold capitalize transition-colors ${
                    direction === d
                      ? d === 'income'
                        ? 'bg-receive-50 text-receive-text border border-receive-100'
                        : 'bg-pay-50 text-pay-text border border-pay-100'
                      : 'bg-cream-soft text-ink-500 border border-cream-border'
                  }`}
                >
                  {d === 'income' ? 'Money in' : 'Money out'}
                </button>
              ))}
            </div>

            {/* amount + currency */}
            <div className="flex items-center gap-2 mb-2.5">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.+\-*/() ]/g, ''))}
                onBlur={() => { const r = parseAmountExpression(amount); if (r != null) setAmount(String(r)); }}
                className="w-24 text-[18px] font-semibold text-ink-900 tabular-nums bg-cream-soft border border-cream-border rounded-lg px-2.5 py-1.5 outline-none focus:border-accent-500"
              />
              <span className="text-[13px] font-medium text-ink-500">{account?.currency ?? ''}</span>
            </div>

            {/* account */}
            <label className="block text-[10px] font-semibold text-ink-500 uppercase tracking-[0.1em] mb-1">
              {direction === 'income' ? 'To account' : 'From account'}
            </label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full text-[13px] text-ink-900 bg-cream-soft border border-cream-border rounded-lg px-2.5 py-2 mb-2.5 outline-none focus:border-accent-500"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                </option>
              ))}
            </select>

            {/* category */}
            <label className="block text-[10px] font-semibold text-ink-500 uppercase tracking-[0.1em] mb-1">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full text-[13px] text-ink-900 bg-cream-soft border border-cream-border rounded-lg px-2.5 py-2 mb-2.5 outline-none focus:border-accent-500"
            >
              {cats.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            {/* note */}
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className="w-full text-[13px] text-ink-900 placeholder:text-ink-400 bg-cream-soft border border-cream-border rounded-lg px-2.5 py-2 mb-3 outline-none focus:border-accent-500"
            />

            <div className="flex gap-2">
              <button
                onClick={handleConfirm}
                disabled={busy || !amountValid}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[12.5px] font-semibold text-white disabled:opacity-40 active:scale-[0.98] transition-transform"
                style={{ background: 'var(--color-accent-600)' }}
              >
                <Check size={14} /> {busy ? 'Saving…' : 'Confirm & add'}
              </button>
              <button
                onClick={onCancel}
                disabled={busy}
                aria-label="Cancel"
                className="px-3 rounded-xl border border-cream-border text-ink-500 active:bg-cream-soft transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

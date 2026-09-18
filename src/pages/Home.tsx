import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency } from '../lib/format'
import { toLocalIsoDate, todayIso, parseLocalDate } from '../lib/date'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, CreditCard as CreditCardIcon, Layers, PiggyBank, Wallet, SlidersHorizontal, X, TrendingUp, RotateCcw } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { computeProjection, horizonCycles, inCycleWindow, horizonRangeEnd, THREE_CYCLES_AHEAD, buildPersonalTrendSeries, type ProjectionHorizon } from '../lib/projection'
import { averageAdHocSpendForCycle, daysOfSpendHistory, forecastSpendForCycle, hasAnyMatchingSpend, hasSpendHistory, MIN_SPEND_HISTORY_DAYS, type SpendScope } from '../lib/averageSpendForecast'
import { summarizeLoanProgress, summarizeLoan } from '../lib/ledgerLoans'
import { computeJointSummary, buildJointPersonGroups, type JointPersonGroup } from '../lib/jointLedger'
import { computeJointAccountProjection, jointAccountSignedAmount, buildJointTrendSeries } from '../lib/jointAccountLedger'
import { computeHouseholdProjections, buildHouseholdTrendSeries, buildHouseholdPersonGroups, type HouseholdPersonGroup } from '../lib/householdLedger'
import { nextMinimumChargeAmount, totalPaidForCard, withLiveBalance, creditCardCyclePeriods, buildCreditCardCycleSections, buildCreditCardTrendSeries, type CreditCardCycleSection } from '../lib/creditCards'
import { resolveCycleBounds } from '../lib/pensionLedger'
import { findApplicableSnapshot } from '../lib/salaryLedger'
import { addDays } from 'date-fns'
import {
  savingsPotBalanceAsOf,
  projectedBalanceAt,
  amountNeededPerPayPeriod,
  buildSavingsPotScheduleRows,
  buildSavingsPotTrendSeries,
  type SavingsPotScheduleRow,
  type SavingsPotPillGranularity,
  type SavingsPotPillPoint,
  type SavingsPotTrendSeries,
} from '../lib/savingsPotLedger'
import { computePotProjection, potSignedAmount, buildPotTrendSeries } from '../lib/potLedger'
import { isLedgerTransaction, signedAmount, type BalanceSpendGranularity, type BalanceSpendTrendSeries } from '../lib/runningBalance'
import { computeCycleSummary, compareByDateSalaryFirst } from '../lib/cycleSummary'
import { WalletStack } from '../components/WalletStack'
import { BankCard } from '../components/BankCard'
import { ProgressRing } from '../components/ProgressRing'
import { CategoryIcon } from '../components/CategoryIcon'
import { BalanceSpendChart, SavingsPotPillChart, shortDayLabel, type BalanceSpendView } from '../components/TrendChart'
import { SAVINGS_CATEGORY_ID, CREDIT_CARD_CATEGORY_ID } from '../types/ledger'
import { seededCategoryIdForIcon, distinctByCategory, DEFAULT_POT_CATEGORY_ICON, DEFAULT_POT_CATEGORY_ICON_COLOR } from '../lib/categories'
import { visibleLoanCards, loanCyclePeriods, buildLoanCycleSections, loanTrendAsBalanceSeries, loanSignedAmount, buildLoanTrendEvents, LOAN_PAYMENT_KIND_LABELS } from '../lib/loanLedger'
import type { AppDataV2, CreditCard, Loan, Pot, SavingsPot, Transaction } from '../types/ledger'

// ── Deck construction — doc addendum on Summary card visibility ────────
// 'personal' is always present (it's the primary viewer's own account).
// 'joint'/'household' only make sense once a second person and a joint
// cost both exist. Credit cards are scoped to the primary person's own
// cards only — this app has no "switch active viewer" concept.

type DeckEntry =
  | { kind: 'personal' }
  | { kind: 'joint' }
  | { kind: 'household' }
  | { kind: 'credit_card'; cardId: string }
  | { kind: 'loan'; loanId: string }
  | { kind: 'savings_pot'; potId: string }
  | { kind: 'pot'; potId: string }

// Deck order (Adam-specified, 2026-09-10): Personal, Joint*, Pots*,
// Credit Card(s)*, Savings Pots*, Household*. Each conditional entry
// keeps its own pre-existing visibility rule below — only the ORDER
// changed, not which cards appear or when.
function buildDeck(data: AppDataV2): DeckEntry[] {
  const deck: DeckEntry[] = [{ kind: 'personal' }]

  const hasJointItem = data.recurringTemplates.some((t) => t.location === 'joint') || data.loans.some((l) => l.location === 'joint' && l.active)
  if (data.people.length >= 2 && hasJointItem) deck.push({ kind: 'joint' })

  // Pots backlog item, Phase 7 (2026-09 session) — Adam's own spec: "it
  // get's its own swipe card in the Summary page. It's ledger should
  // match the same style as the Personal swipe card... There should be
  // no pie chart." A Pot is architecturally its own thing (see Pot's own
  // header comment in types/ledger.ts), so it gets its own deck kind
  // rather than being folded into 'savings_pot'.
  const myBillsPots = (data.pots ?? []).filter((p) => p.personId === data.primaryPersonId && p.active)
  for (const p of myBillsPots) deck.push({ kind: 'pot', potId: p.id })

  // A combined "All Cards" entry used to be appended here once the
  // person had more than one active card — removed (Adam-specified,
  // 2026-09-12): each credit card already gets its own deck entry, and
  // the extra combined one wasn't wanted alongside them.
  const myCards = data.creditCards.filter((c) => c.ownerId === data.primaryPersonId && c.active)
  for (const c of myCards) deck.push({ kind: 'credit_card', cardId: c.id })

  // PROMPT-08a Part C — one card per loan this person owns, placed with
  // the other debt rather than among the savings cards. Visibility
  // (ownership, and hidden once settled OR fully repaid) is
  // `isLoanCardVisible`'s call, not re-derived here — see lib/loanLedger.ts.
  for (const l of visibleLoanCards(data)) deck.push({ kind: 'loan', loanId: l.id })

  // REDESIGN (Adam-specified, 2026-09-02 — "it needs its own hero card,
  // like credit cards/joint account in the swipe deck, and not to be in
  // any way part of the personal card's screen render"): each pot is now
  // a genuine swipeable deck entry, same as a credit card, NOT content
  // bolted onto 'personal'. Nothing about Personal's own DeckHero/
  // ProgressRingsSection touches savings pots any more — see this
  // section's own removal note there.
  const myPots = data.savingsPots.filter((p) => p.personId === data.primaryPersonId && p.active)
  for (const p of myPots) deck.push({ kind: 'savings_pot', potId: p.id })

  if (data.people.length >= 2) deck.push({ kind: 'household' })

  return deck
}

/**
 * Stable string key for a `DeckEntry` — needed for the wallet-stack's MRU
 * reorder state, which tracks *which entries* have been tapped-to-front
 * across renders, not their (unstable, buildDeck-order-dependent) index.
 */
function deckEntryKey(e: DeckEntry): string {
  switch (e.kind) {
    case 'credit_card':
      return `credit_card:${e.cardId}`
    case 'loan':
      return `loan:${e.loanId}`
    case 'savings_pot':
      return `savings_pot:${e.potId}`
    case 'pot':
      return `pot:${e.potId}`
    default:
      return e.kind
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

const HORIZON_LABELS: Record<ProjectionHorizon, string> = { current_cycle: 'This cycle', three_cycles: 'Next 3 cycles' }
type Grouping = 'list' | 'category' | 'person'
type Order = 'date' | 'amount'

// The seeded "Loan" category (see lib/categories.ts's DEFAULT_LOAN_CATEGORY_ID
// equivalent in Loans.tsx) doubles as the fixed group header for every
// loan_payment transaction in the "group by category" view below — a
// stable id to fold into, not the category any individual loan actually
// carries (that stays freely assignable and still shows on each row).
const LOANS_GROUP_CATEGORY_ID = seededCategoryIdForIcon('loan')

// The seeded "Joint" category — also the fixed categoryId every
// joint_deposit/joint_withdrawal transaction is created with (see
// LedgerContext.tsx's JOINT_ACCOUNT_CATEGORY_ID, same constant by a
// different name since this file can't import from the context file).
const JOINT_ACCOUNT_GROUP_CATEGORY_ID = seededCategoryIdForIcon('joint')

/**
 * The category a transaction's amount counts toward in the "group by
 * category" summary view — distinct from `t.categoryId`, which is the
 * transaction's own real, freely-assignable category and is what still
 * shows on its individual row (via TransactionRow, unaffected by this).
 * Loan payments and everything credit-card-related always fold into
 * their own fixed bucket regardless of what category the underlying
 * loan/card/bill is actually tagged with — so "how much went to loans"
 * or "how much went on the card" stays answerable in one place, while
 * each loan/card/bill is still free to carry its own category for its
 * own icon everywhere else. Savings intentionally isn't handled here:
 * generated savings transactions already always carry
 * SAVINGS_CATEGORY_ID directly (no separate real category to preserve),
 * so grouping by `categoryId` already does the right thing for them.
 */
/** Synthetic, collision-proof group keys for a Pot/SavingsPot's own deposit/withdrawal/interest activity — never a real Category.id, so a pot named the same as a real category can never merge with it. */
function potGroupCategoryId(potId: string): string {
  return `pot:${potId}`
}
function savingsPotGroupCategoryId(savingsPotId: string): string {
  return `savingspot:${savingsPotId}`
}

function groupingCategoryId(t: Transaction): string {
  if (t.type === 'loan_payment') return LOANS_GROUP_CATEGORY_ID
  if (t.type === 'credit_card_payment' || t.type === 'credit_card_spend') return CREDIT_CARD_CATEGORY_ID
  // 2026-09-18 (Adam-reported) — a `paymentMethod === 'card'` transaction
  // with no `creditCardId` is a DEBIT card payment, not a credit card one.
  // This used to fold it into the Credit Card bucket regardless of its own
  // categoryId; it now falls through to that categoryId below, same as
  // Cash. A genuine credit-card entity transaction is still caught above by
  // `type`, which is what actually identifies it.
  // 2026-09-14 — a Pot/SavingsPot's own deposit/withdrawal/interest
  // transaction groups under THAT pot's own name, never the shared
  // "Savings" category. Deliberately scoped to just these types — a
  // pot-FUNDED bill_payment/loan_payment also carries `potId` (see
  // TransactionType's own comment on pot_withdrawal) but is handled by
  // the loan_payment check above / falls through to its own real
  // categoryId below, exactly as before this change.
  if (t.potId && (t.type === 'pot_deposit' || t.type === 'pot_withdrawal' || t.type === 'transfer')) return potGroupCategoryId(t.potId)
  if (t.savingsPotId && (t.type === 'savings_deposit' || t.type === 'savings_withdrawal' || t.type === 'savings_interest' || t.type === 'transfer')) {
    return savingsPotGroupCategoryId(t.savingsPotId)
  }
  return t.categoryId
}

/**
 * The Pot/SavingsPot a single transaction's OWN icon should come from —
 * same gating `groupingCategoryId` already applies (pot_deposit/
 * pot_withdrawal/transfer for a Pot; savings_deposit/savings_withdrawal/
 * savings_interest/transfer for a Savings Pot; a pot-FUNDED bill_payment/
 * loan_payment falls through to its own real category, not this). 2026-
 * 09-14 (Adam-reported) — TransactionRow's own icon used to read
 * `t.categoryId` directly, so every `transfer` (whatever pot it actually
 * moved money into/out of) rendered the same generic "Savings" category
 * icon instead of that specific pot's own chosen one; the grouped view
 * (CategoryGroupedList) already got this right via `groupingCategoryId`,
 * this reuses that exact same resolution for the single-row case.
 */
function iconPotOrSavingsPotFor(t: Transaction, data: AppDataV2): Pot | SavingsPot | undefined {
  const key = groupingCategoryId(t)
  if (key.startsWith('pot:')) return data.pots.find((p) => p.id === key.slice(4))
  if (key.startsWith('savingspot:')) return data.savingsPots.find((p) => p.id === key.slice(11))
  return undefined
}

/**
 * NET sum of everything still pending inside the horizon — outgoings as
 * negatives, incoming (salary, bonuses, a transfer from a family member,
 * any ad-hoc income) as positives.
 *
 * This deliberately REPLACES an earlier outgoings-only version. That one
 * excluded pending income on the reasoning that salary is already
 * reflected in Projected, so counting it here too would read as "net cash
 * flow" rather than "money due to go out." Confirmed as the wrong call in
 * practice: logging a +£100 transfer moved Projected and appeared in the
 * ledger list, but Pending didn't budge, which reads as the app having
 * simply missed the entry. It also left the hero's three figures unable
 * to be reconciled against each other by eye.
 *
 * Netting them makes the hero self-consistent — Current balance + Pending
 * is now exactly Projected, for every horizon — which is a stronger
 * property than the old label precision was worth. There is no
 * double-counting either way: Projected is computed independently in
 * projection.ts and never reads this function.
 *
 * `amountSign` defaults to the personal ledger's own signedAmount, but
 * takes an override (2026-09-12, hero-card consistency sweep) for a
 * non-personal ledger with its own type-derived sign convention —
 * potSignedAmount for Pot's hero, same "amountSign override" pattern
 * CycleGroupedList/CategoryGroupedList etc. already use.
 */
function pendingNetTotal(transactions: Transaction[], amountSign: (t: Transaction) => number = signedAmount): number {
  return round2(transactions.filter((t) => t.status === 'pending' && isLedgerTransaction(t)).reduce((sum, t) => sum + amountSign(t), 0))
}

export function Home() {
  const { data } = useLedgerData()
  // Keys the user has explicitly tapped-to-select, oldest first, most
  // recent (= frontmost) last. Starts empty — nobody's tapped anything
  // yet, so Personal stays front, matching the old activeIndex default.
  const [mruSelections, setMruSelections] = useState<string[]>([])
  // Defaults to "Next 3 cycles" with cycle-end (month-end) totals on —
  // canShowCycleTotals also requires grouping 'list' + order 'date',
  // which are themselves already the defaults below, so this combination
  // renders the cycle-grouped view immediately rather than the plain
  // date-ordered one.
  // 2026-09-17 (Adam): the default view is This cycle. With cycleTotals on
  // (also default), it renders as the SAME collapsed cycle pill the Next 3
  // cycles view shows for the current cycle — one pill instead of three.
  // The horizon is a pill of its own, not a filter, so it is deliberately
  // absent from activeFilterLabels and from resetToDefault.
  const [horizon, setHorizon] = useState<ProjectionHorizon>('current_cycle')
  const [grouping, setGrouping] = useState<Grouping>('list')
  const [order, setOrder] = useState<Order>('date')
  const [cycleTotals, setCycleTotals] = useState(true)
  // Off by default — cleared payments start hidden everywhere on this
  // page (rows AND, in the category view, the per-category total), the
  // same as before this toggle existed; switching it on reveals them
  // again in both places at once, since a category total that includes
  // rows the person can't see was the whole problem this toggle exists
  // to fix.
  const [showCleared, setShowCleared] = useState(false)
  // 2026-09-13 (dev.md item 2, Adam-specified) — "Group by direction", an
  // independent toggle available on every deck card, off by default
  // (unlike cycleTotals). Independent of Cycle-end totals: with totals
  // off, it splits the whole flat window into Incoming/Outgoing pills;
  // with totals on, those same two pills nest inside each cycle section
  // instead, alongside the existing per-cycle closing balance.
  const [groupByDirection, setGroupByDirection] = useState(false)
  // 2026-09-13 (average spend forecast, Adam-specified) — Personal and
  // Joint cards only, off by default. Threaded exactly like
  // groupByDirection; the per-card gating (which entry.kind actually
  // offers it, and only once Cycle-end totals is on) lives in
  // activeFilterLabels/FiltersSheet, not here.
  const [averageSpendForecast, setAverageSpendForecast] = useState(false)

  const deck = useMemo(() => buildDeck(data), [data])

  // Full display order, back-to-front, re-derived every render from the
  // canonical buildDeck order plus the MRU pointer — never-selected
  // entries keep buildDeck's own relative order (further back); among
  // ever-selected entries, order follows recency, most recent last
  // (frontmost). "Bring to front, others keep relative order" falls out
  // of this for free, including for the previous front card. An entry
  // removed from buildDeck (e.g. a deleted pot/card) simply can't appear
  // in canonicalKeysReversed and gets filtered out of mruSelections the
  // same render.
  const backToFront = useMemo(() => {
    const canonicalKeysReversed = deck.map(deckEntryKey).reverse()
    const liveMru = mruSelections.filter((k) => canonicalKeysReversed.includes(k))
    return [...canonicalKeysReversed.filter((k) => !liveMru.includes(k)), ...liveMru]
  }, [deck, mruSelections])

  const activeEntry = deck.find((e) => deckEntryKey(e) === backToFront[backToFront.length - 1]) ?? deck[0]
  // Gated by the same predicate that decides whether the toggle is even
  // offered, so a value left switched on from an earlier selection can't
  // silently reshape a view whose control is hidden.
  const cycleTotalsActive = !!activeEntry && cycleTotals && canShowCycleTotals(activeEntry, horizon, grouping, order)

  function onSelect(key: string) {
    setMruSelections((prev) => [...prev.filter((k) => k !== key), key])
  }

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Home</h1>
      </header>

      <WalletStack
        items={backToFront.map((key) => {
          const entry = deck.find((e) => deckEntryKey(e) === key)!
          return { key, node: <DeckHero entry={entry} data={data} horizon={horizon} averageSpendForecast={averageSpendForecast} />, label: heroLabel(entry, data) }
        })}
        onSelect={onSelect}
        // Salary card only — the joint/household/credit-card faces have no
        // salary-vs-outgoings picture of their own to break down.
        belowCards={
          activeEntry?.kind === 'personal' ? (
            <SalaryBreakdownCard data={data} horizon={horizon} />
          ) : activeEntry?.kind === 'joint' ? (
            <JointBreakdownCard data={data} horizon={horizon} />
          ) : undefined
        }
      />

      <div className="mt-6">
        <DeckControls
          entry={activeEntry}
          data={data}
          horizon={horizon}
          setHorizon={setHorizon}
          grouping={grouping}
          setGrouping={setGrouping}
          order={order}
          setOrder={setOrder}
          cycleTotals={cycleTotals}
          setCycleTotals={setCycleTotals}
          showCleared={showCleared}
          setShowCleared={setShowCleared}
          groupByDirection={groupByDirection}
          setGroupByDirection={setGroupByDirection}
          averageSpendForecast={averageSpendForecast}
          setAverageSpendForecast={setAverageSpendForecast}
        />
        <DeckDetail
          entry={activeEntry}
          data={data}
          horizon={horizon}
          setHorizon={setHorizon}
          grouping={grouping}
          setGrouping={setGrouping}
          order={order}
          setOrder={setOrder}
          cycleTotals={cycleTotalsActive}
          showCleared={showCleared}
          groupByDirection={groupByDirection}
          averageSpendForecast={averageSpendForecast}
        />
      </div>
    </div>
  )
}

// ── Savings pot deck detail (backlog item a, redesigned 2026-09-02 per
// Adam's explicit instruction: "it needs its own hero card, like credit
// cards/joint account in the swipe deck, and not to be in any way part
// of the personal card's screen render"). This is now the DeckDetail for
// a single 'savings_pot' deck entry — same role CreditCardDetail plays
// for a credit card, rendered below that pot's OWN hero card in the
// swipe deck, never inside Personal's. The pie-chart ring (targetAmount)
// lives HERE now too, not in ProgressRingsSection — matching Adam's
// original wording ("shows... on the home page SAVINGS card") more
// literally than the first pass did. ──
function SavingsPotDetail({
  pot,
  data,
  horizon,
  cycleTotals,
  showCleared,
  groupByDirection,
}: {
  pot: SavingsPot
  data: AppDataV2
  horizon: ProjectionHorizon
  cycleTotals: boolean
  showCleared: boolean
  groupByDirection?: boolean
}) {
  const balance = savingsPotBalanceAsOf(pot, data.transactions, new Date())

  // BUGFIX (Adam-reported, 2026-09-03): this used to always show a fixed
  // "This cycle end / Next cycle end" pair regardless of the horizon
  // pill, and the ledger list below it never varied with the pill either
  // — the SAME fixed last-2/next-12 window every time. Both are now
  // driven by `horizon`, using horizonRangeEnd — the exact function
  // Personal's own hero card/projection uses — so "This cycle" and "Next
  // 3 cycles" mean the same date range here as they do everywhere else
  // in this app, and picking one actually changes what's on screen.
  const showProjection = horizon === 'three_cycles'
  const cycleStart = resolveCycleBounds(data, data.primaryPersonId, new Date()).start
  const horizonEnd = horizonRangeEnd(data, data.primaryPersonId, horizon, new Date())
  const primaryPayCycle = data.payCycles.find((c) => c.personId === data.primaryPersonId)
  const projectedBalance = showProjection ? projectedBalanceAt(pot, balance, data.transactions, new Date(), horizonEnd, data.recurringTemplates, primaryPayCycle) : balance
  // Header caption (Adam-specified, 2026-09-12 — "match the bills card"):
  // unlike `projectedBalance` above (short-circuited to `balance` outside
  // "Next 3 cycles" purely for the ring's own showProjection gating), this
  // is a genuine per-horizon projection always, same as Pot's own caption
  // (computePotProjection's projectedBalance is never short-circuited
  // either) — horizonEnd is already the right cycle-end for whichever
  // horizon is selected.
  const captionProjectedBalance = projectedBalanceAt(pot, balance, data.transactions, new Date(), horizonEnd, data.recurringTemplates, primaryPayCycle)

  const person = data.people.find((p) => p.id === data.primaryPersonId)
  const currentSnapshot = person ? findApplicableSnapshot(person, todayIso()) : null
  const goalLabel = currentSnapshot && pot.targetDate ? amountNeededPerPayPeriod(pot, balance, currentSnapshot.payFrequency) : null

  const target = pot.targetAmount ?? 0
  const percent = target > 0 ? Math.min(100, (balance / target) * 100) : 0
  // BUGFIX (Adam-reported, 2026-09-03): the ring never had a
  // projectedPercent at all — it showed the same "today" figure no
  // matter which horizon was selected, unlike the loan/goal rings in
  // ProgressRingsSection, which show current% AND, once "Next 3 cycles"
  // is picked, a second projected% with the "£X by [horizon]" caption.
  // Same treatment here now, for the same reason: a target you're saving
  // toward should visibly move when you look further ahead.
  const projectedPercent = showProjection && target > 0 ? Math.min(100, (projectedBalance / target) * 100) : undefined
  const savingsCategory = data.categories.find((c) => c.id === SAVINGS_CATEGORY_ID)

  // REMOVED (Adam-specified, 2026-09-03): the static "This cycle end /
  // Next cycle end" row — it duplicated what the ledger list below (now
  // itself horizon-filtered) already shows, and never actually reflected
  // the current horizon selection the way its own labels implied.
  const activity = buildSavingsPotScheduleRows(pot, data.transactions, new Date(), data.recurringTemplates, primaryPayCycle)
    .filter((r) => (r.status === 'cleared' || r.status === 'pending') && r.date >= toLocalIsoDate(cycleStart) && r.date <= toLocalIsoDate(horizonEnd))
    .sort((a, b) => a.date.localeCompare(b.date))

  // BUGFIX (Adam-reported, 2026-09 session) — this list never carried a
  // rolling balance the way Personal/Joint/Pot's shared list components
  // all do (DateOrderedList's own `running` fold). Anchored on the real
  // balance the DAY BEFORE this window starts (not `balance` above,
  // which is as-of TODAY, not as-of cycleStart) — the same
  // "openingRunningBalance, then fold forward through the visible rows
  // in order" shape those shared components use, just computed locally
  // here since `activity`'s rows are this component's own synthetic
  // schedule shape, not real Transactions savingsPotBalanceAsOf can
  // re-query directly for anything past `cycleStart`.
  const openingRunningBalance = savingsPotBalanceAsOf(pot, data.transactions, addDays(cycleStart, -1))
  let runningTotal = openingRunningBalance
  const activityWithRunning = activity.map((row) => {
    runningTotal += row.type === 'savings_withdrawal' ? -row.amount : row.amount
    return { row, running: runningTotal }
  })
  // Respects "Show cleared" the same way every other flat list on this
  // page does — computed AFTER the running fold above, so hiding a row
  // never changes the balance figures, only which rows render.
  const visibleActivity = activityWithRunning.filter(({ row }) => showCleared || row.status !== 'cleared')

  // Cycle-end totals (Adam-specified, 2026-09-12): Savings Pots now get
  // the same "Show cleared"/"Cycle-end totals" toggles every other
  // household-pay-cycle-based card (Personal/Joint/Household/Pot) already
  // has, using the SAME cycle boundaries (horizonCycles) — explicitly NOT
  // a credit card's own billing-cycle dates, which stay untouched. Reuses
  // `activity`/`openingRunningBalance` above (already the right window
  // and anchor), just re-partitioned into per-cycle sections.
  const cycles = horizonCycles(data, pot.personId, horizon, new Date())

  return (
    <div className="flex flex-col gap-4">
      <HomeSection>
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">{pot.name}</h2>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">
          £{formatCurrency(balance)} now · £{formatCurrency(captionProjectedBalance)} projected · {HORIZON_LABELS[horizon].toLowerCase()}
        </p>

        {goalLabel && (
          <p className="text-xs text-center mb-4" style={{ color: 'var(--color-coral)' }}>
            Save £{formatCurrency(goalLabel.amountPerPeriod)} per {goalLabel.periodLabel} to hit £{formatCurrency(target)} by {pot.targetDate}
          </p>
        )}

        {cycleTotals ? (
          <SavingsPotCycleGroupedList rows={activity} openingRunningBalance={openingRunningBalance} cycles={cycles} showCleared={showCleared} groupByDirection={groupByDirection} />
        ) : groupByDirection ? (
          <DirectionGroupedRows
            items={visibleActivity}
            isIncoming={({ row }) => row.type !== 'savings_withdrawal'}
            amountOf={({ row }) => row.amount}
            dateOf={({ row }) => row.date}
            keyOf={({ row }) => `${row.type}-${row.date}`}
            renderRow={({ row }) => <SavingsPotActivityRow row={row} />}
          />
        ) : (
          <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
            {visibleActivity.map(({ row, running }) => (
              <SavingsPotActivityRow key={`${row.type}-${row.date}`} row={row} runningBalance={running} />
            ))}
            {visibleActivity.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] text-center py-6">Nothing in {horizon === 'current_cycle' ? 'this cycle' : 'the next 3 cycles'}.</p>}
          </div>
        )}
      </HomeSection>

      <HomeSection>
        <TrendPreview
          cardName={pot.name}
          color={pot.color}
          caption="Today's balance"
          savingsPot={{ buildSeries: (g) => buildSavingsPotTrendSeries(data, pot, g, new Date()) }}
        />
      </HomeSection>

      {/* DOC NOTE: the 2026-09-15 prompt doc claimed Savings Pot renders no
          ring today ("joint/pot/savings_pot currently have no such ring"),
          used to justify excluding it from the Pie Charts section — but
          this card DOES already render a target-progress ring below,
          whenever a targetAmount is set (see the REPOSITIONED comment
          this section's content is moved from, unchanged). Following the
          doc's own GENERAL rule (relocate whatever already renders today)
          rather than its specific enumeration, which appears to have
          missed this one. */}
      {target > 0 && (
        <CollapsiblePieSection>
          <div className="flex flex-col items-center gap-1" style={{ borderColor: 'var(--color-track)' }}>
            <ProgressRing
              percent={percent}
              projectedPercent={projectedPercent}
              value={`£${formatCurrency(balance)}`}
              label={`of £${formatCurrency(target)}`}
              size={160}
              strokeWidth={14}
              icon={<CategoryIcon category={savingsCategory} size={26} />}
            />
            {showProjection && projectedBalance > balance && (
              <p className="text-[11px]" style={{ color: 'var(--color-coral)' }}>
                projected £{formatCurrency(projectedBalance)} by {HORIZON_LABELS[horizon].toLowerCase()}
              </p>
            )}
          </div>
        </CollapsiblePieSection>
      )}
    </div>
  )
}

/** Interest is always shown positive/green here, per Adam's spec — deposits are also positive (money added to the pot), only a withdrawal shows negative. Same "type-derived sign, not direction-derived" idea CardActivityRow already uses for credit cards, since a pot's OWN ledger and the personal ledger read opposite signs off the same transaction. */
function SavingsPotActivityRow({
  row,
  runningBalance,
}: {
  row: { date: string; type: 'savings_deposit' | 'savings_withdrawal' | 'savings_interest'; amount: number; status: 'cleared' | 'pending' }
  /** Omitted when this row is shown inside a direction-grouped pill (DirectionGroupedRows) — there's no single meaningful running balance across only the incoming or only the outgoing rows. */
  runningBalance?: number
}) {
  const isNegative = row.type === 'savings_withdrawal'
  const label = row.type === 'savings_deposit' ? 'Deposit' : row.type === 'savings_withdrawal' ? 'Withdrawal' : 'Interest'
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm text-[var(--color-ink)]">{label}</p>
        <p className="text-[11px] text-[var(--color-ink-muted)]">
          {row.date}
          {row.status === 'pending' ? ' · Pending' : ''}
        </p>
      </div>
      <div className="text-right">
        <p className="text-sm font-mono font-semibold" style={{ color: isNegative ? 'var(--color-negative)' : 'var(--color-positive)' }}>
          {isNegative ? '-' : '+'}£{formatCurrency(row.amount)}
        </p>
        {runningBalance !== undefined && <p className="text-[10px] text-[var(--color-ink-faint)] tabular-nums">£{formatCurrency(runningBalance)}</p>}
      </div>
    </div>
  )
}

/**
 * Savings Pot's own "Cycle-end totals" view (Adam-specified, 2026-09-12)
 * — same collapsed-by-default, per-cycle-section-with-subtotal shape as
 * `CycleGroupedList` (used by Personal/Joint/Pot), same household
 * pay-cycle boundaries (`horizonCycles`), just built against
 * `SavingsPotScheduleRow`'s synthetic shape instead of a real
 * `Transaction[]` — a savings pot's activity is assembled from generated
 * schedule rows, not real transactions, so it can't share `TransactionRow`
 * the way the Transaction-backed lists do. Rendered via the SAME
 * `SavingsPotActivityRow` the flat (non-cycle) view already uses.
 */
function SavingsPotCycleGroupedList({
  rows,
  openingRunningBalance,
  cycles,
  showCleared,
  groupByDirection,
}: {
  rows: SavingsPotScheduleRow[]
  openingRunningBalance: number
  cycles: { start: Date; end: Date }[]
  showCleared: boolean
  groupByDirection?: boolean
}) {
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  // 2026-09-13 — see CycleGroupedList's identical effect for the full
  // reasoning: every cycle auto-expands while "Group by direction" is
  // on, so its nested Incoming/Outgoing subtotal pills are visible
  // without an extra manual tap per cycle.
  useEffect(() => {
    setToggled(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupByDirection])
  const toggle = (key: string) =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const ordered = rows.slice().sort((a, b) => a.date.localeCompare(b.date))
  let running = openingRunningBalance
  const withRunning = ordered.map((row) => {
    running += row.type === 'savings_withdrawal' ? -row.amount : row.amount
    return { row, running }
  })

  let carried = openingRunningBalance
  const sections = cycles.map((cycle, i) => {
    const startIso = toLocalIsoDate(cycle.start)
    const endIso = toLocalIsoDate(cycle.end)
    // 2026-09-14 — bounded on both ends for every section, including the
    // current one (see CycleGroupedList's own comment on the identical
    // fix, same reported bug). `closing` still reflects older history
    // that landed before this cycle's own start via `upToEnd`, which
    // isn't lower-bounded — only the rendered row list is.
    const sectionRows = withRunning.filter(({ row }) => row.date >= startIso && row.date <= endIso)
    const upToEnd = withRunning.filter(({ row }) => row.date <= endIso)
    const closing = upToEnd.length > 0 ? upToEnd[upToEnd.length - 1].running : carried
    carried = closing
    const visibleRows = sectionRows.filter(({ row }) => showCleared || row.status !== 'cleared')
    return { key: startIso, isCurrent: i === 0, startIso, endIso, visibleRows, closing }
  })

  return (
    <div className="flex flex-col gap-2">
      {sections.map((section) => {
        const expanded = groupByDirection ? !toggled.has(section.key) : toggled.has(section.key)
        return (
          <div key={section.key} className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-bg)' }}>
            <button onClick={() => toggle(section.key)} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left">
              <span className="flex items-center gap-1.5 min-w-0">
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                <span className="text-xs font-semibold text-[var(--color-ink)] truncate">
                  {section.isCurrent ? 'Current cycle' : `${formatCycleDate(section.startIso)} – ${formatCycleDate(section.endIso)}`}
                </span>
              </span>
              {!expanded && (
                <span className="text-xs font-mono font-semibold tabular-nums shrink-0" style={{ color: 'var(--color-ink-muted)' }}>
                  £{formatCurrency(section.closing)}
                </span>
              )}
            </button>

            {expanded && (
              <div className="px-3 pb-1">
                {groupByDirection ? (
                  <DirectionGroupedRows
                    items={section.visibleRows}
                    isIncoming={({ row }) => row.type !== 'savings_withdrawal'}
                    amountOf={({ row }) => row.amount}
                    dateOf={({ row }) => row.date}
                    keyOf={({ row }) => `${row.type}-${row.date}`}
                    renderRow={({ row }) => <SavingsPotActivityRow row={row} />}
                  />
                ) : (
                  <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
                    {section.visibleRows.map(({ row, running }) => (
                      <SavingsPotActivityRow key={`${row.type}-${row.date}`} row={row} runningBalance={running} />
                    ))}
                    {section.visibleRows.length === 0 && (
                      <p className="text-[11px] text-[var(--color-ink-muted)] text-center py-3">Nothing in this cycle.</p>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between pt-2 pb-2 mt-1 border-t" style={{ borderColor: 'var(--color-track)' }}>
                  <span className="text-[11px] font-medium text-[var(--color-ink-muted)]">Balance at {formatCycleDate(section.endIso)}</span>
                  <span className="text-sm font-mono font-semibold tabular-nums text-[var(--color-ink)]">£{formatCurrency(section.closing)}</span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function CardRow({
  label,
  value,
  emphasized,
  light,
  small,
}: {
  label: string
  value: number
  emphasized?: boolean
  light?: boolean
  /** 2026-09-13 (Adam-specified) — Joint hero's per-person name rows read slightly smaller than every other CardRow label, now that "Current balance" leads the card as the more prominent figure. */
  small?: boolean
}) {
  const negative = value < 0
  // BUGFIX (Adam-reported, 2026-09 session — "joint account swipe card
  // text is the same colour as the card, can't see it") — CardRow's own
  // text colour was hardcoded to white regardless of which BankCard
  // variant it sat inside. That's correct for 'coral'/'dark'/'custom'
  // (all dark backgrounds, matching BankCard's own textColor logic) but
  // Joint uses variant="light" (a pale background, dark text) — white on
  // white was genuinely invisible, not just low-contrast. `light` lets a
  // caller opt into BankCard's own light-variant colours instead.
  const labelColor = light ? 'rgba(26,26,26,0.65)' : 'rgba(255,255,255,0.85)'
  const valueColor = light ? '#1a1a1a' : '#fff'
  return (
    <div className="flex items-baseline justify-between">
      <span className={`font-body ${small ? 'text-[11px]' : 'text-[13px]'} uppercase tracking-wider`} style={{ color: labelColor, opacity: emphasized ? 1 : 0.9 }}>
        {label}
      </span>
      <span className={`font-display tabular-nums ${emphasized ? 'text-xl font-bold' : 'text-base font-semibold'}`} style={{ color: valueColor }}>
        {negative ? '-' : ''}£{formatCurrency(Math.abs(value))}
      </span>
    </div>
  )
}

// ── Pop-down breakdown — the salary hero's second layer ───────────────
// Sits BEHIND the hero card (SwipeCards' `belowCards` slot renders at a
// lower z-index than the card track) with a negative top margin, so
// collapsed it shows nothing but a chevron strip peeking out from under
// the card's bottom edge, and expanding it looks like the card was
// hiding it all along rather than a new panel appearing.

/** Horizontal inset each side, so the card is 14px narrower than the hero.
 *  SwipeCards pads each slide by 2px (px-0.5), so the hero's own edge is
 *  already 2px in from this container — hence 7 + 2, not a bare 7. */
const BREAKDOWN_INSET = 9
/** How far the card tucks up behind the hero. Matched by an equal paddingTop
 *  so the content itself never lands underneath the card. */
const BREAKDOWN_TUCK = 26

function BreakdownRow({ label, value, emphasized, muted }: { label: string; value: number; emphasized?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={`${emphasized ? 'text-xs font-semibold' : 'text-[11px]'}`} style={{ color: muted ? 'var(--color-ink-faint)' : emphasized ? 'var(--color-ink)' : 'var(--color-ink-muted)' }}>
        {label}
      </span>
      <span className={`font-mono tabular-nums ${emphasized ? 'text-sm font-semibold' : 'text-xs'}`} style={{ color: muted ? 'var(--color-ink-faint)' : 'var(--color-ink)' }}>
        {value < 0 ? '-' : ''}£{formatCurrency(Math.abs(value))}
      </span>
    </div>
  )
}

function SalaryBreakdownCard({ data, horizon }: { data: AppDataV2; horizon: ProjectionHorizon }) {
  const [open, setOpen] = useState(false)
  const payCycle = data.payCycles.find((pc) => pc.personId === data.primaryPersonId)

  const summary = useMemo(() => {
    if (!payCycle) return null
    const projection = computeProjection(data, data.primaryPersonId, payCycle, horizon)
    const cycles = horizonCycles(data, data.primaryPersonId, horizon, new Date())
    return computeCycleSummary(projection.transactions, projection.clearedBalance, {
      startIso: toLocalIsoDate(cycles[0].start),
      endIso: toLocalIsoDate(cycles[cycles.length - 1].end),
    })
  }, [data, payCycle, horizon])

  if (!summary) return null

  return (
    <div style={{ marginLeft: BREAKDOWN_INSET, marginRight: BREAKDOWN_INSET, marginTop: -BREAKDOWN_TUCK }}>
      <div className="rounded-b-3xl overflow-hidden shadow-lg" style={{ background: 'var(--color-surface-raised)', paddingTop: BREAKDOWN_TUCK }}>
        <div
          style={{
            maxHeight: open ? 480 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            transition: 'max-height 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease',
          }}
        >
          <div className="px-4 pt-3 pb-1 flex flex-col gap-3.5">
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{HORIZON_LABELS[horizon]}</p>

            <div className="flex flex-col gap-1">
              <BreakdownRow label="Income" value={summary.income.total} emphasized />
              <BreakdownRow label="Salary & bonuses" value={summary.income.salary} />
              <BreakdownRow label="Withdrawals" value={summary.income.withdrawals} />
              <BreakdownRow label="Other income" value={summary.income.other} />
            </div>

            <div className="flex flex-col gap-1 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
              <BreakdownRow label="Outgoings" value={summary.outgoings.total} emphasized />
              <BreakdownRow label="Standing orders" value={summary.outgoings.standingOrder} />
              <BreakdownRow label="Direct debits (incl. loans)" value={summary.outgoings.directDebit} />
              <BreakdownRow label="Deposits" value={summary.outgoings.deposits} />
              <BreakdownRow label="Other" value={summary.outgoings.other} />
            </div>

            <div className="flex flex-col gap-1 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
              <BreakdownRow label="Current balance" value={summary.currentBalance} />
              <BreakdownRow label="Available" value={summary.available} emphasized />
              {/* Spelled out because the three figures above deliberately
                  DON'T add up to this one — see CycleSummary.available. */}
              <p className="text-[10px] text-[var(--color-ink-faint)] leading-snug mt-0.5">
                Balance plus everything still to come in, less everything still to go out. Anything that's already cleared is counted once, in the balance.
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-center py-1.5"
          aria-expanded={open}
          aria-label={open ? 'Hide income and outgoings breakdown' : 'Show income and outgoings breakdown'}
        >
          {open ? <ChevronUp size={16} className="text-[var(--color-ink-muted)]" /> : <ChevronDown size={16} className="text-[var(--color-ink-muted)]" />}
        </button>
      </div>
    </div>
  )
}

/**
 * Joint's own pulldown breakdown (Adam-specified, 2026-09 session) —
 * same shell/mechanics as SalaryBreakdownCard immediately above
 * (BREAKDOWN_INSET/TUCK, tucked-chevron toggle), but Deposits/Outgoings
 * instead of Income/Outgoings, and Outgoings gets a per-person
 * sub-breakdown (each person's £ share AND % share of the total,
 * computeJointSummary's own perPerson array — the exact figures the old
 * duplicate top ledger on the Joint detail card used to show before it
 * was removed, now surfaced here instead where they don't compete with
 * the real ledger for attention).
 */
function JointBreakdownCard({ data, horizon }: { data: AppDataV2; horizon: ProjectionHorizon }) {
  const [open, setOpen] = useState(false)

  const summary = useMemo(() => {
    if (!data.jointAccount) return null
    const cycles = horizonCycles(data, data.primaryPersonId, horizon, new Date())
    const bounds = { start: cycles[0].start, end: cycles[cycles.length - 1].end }
    const outgoings = computeJointSummary(data, bounds.start, bounds.end)
    const jointProjection = computeJointAccountProjection(data, horizon)
    const startIso = toLocalIsoDate(bounds.start)
    const endIso = toLocalIsoDate(bounds.end)
    const transfers = (jointProjection?.transactions ?? []).filter((t) => t.type === 'transfer' && t.date >= startIso && t.date <= endIso)
    // A transfer's own `direction` is the PERSONAL ledger's sign (see
    // buildTransferTransaction in lib/transferLedger.ts: 'out' when
    // personal is the source, 'in' when personal is the destination) —
    // so a genuine DEPOSIT into the joint account (personal -> joint) is
    // direction 'out', and a genuine WITHDRAWAL (joint -> personal) is
    // direction 'in'. BUGFIX: this previously filtered direction === 'in'
    // for the row labelled "Deposits", which actually summed withdrawals.
    const deposits = transfers.filter((t) => t.direction === 'out').reduce((sum, t) => sum + t.amount, 0)
    const withdrawals = transfers.filter((t) => t.direction === 'in').reduce((sum, t) => sum + t.amount, 0)
    return { deposits: round2(deposits), withdrawals: round2(withdrawals), outgoings }
  }, [data, horizon])

  if (!summary) return null

  return (
    <div style={{ marginLeft: BREAKDOWN_INSET, marginRight: BREAKDOWN_INSET, marginTop: -BREAKDOWN_TUCK }}>
      <div className="rounded-b-3xl overflow-hidden shadow-lg" style={{ background: 'var(--color-surface-raised)', paddingTop: BREAKDOWN_TUCK }}>
        <div
          style={{
            maxHeight: open ? 480 : 0,
            opacity: open ? 1 : 0,
            overflow: 'hidden',
            transition: 'max-height 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease',
          }}
        >
          <div className="px-4 pt-3 pb-1 flex flex-col gap-3.5">
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{HORIZON_LABELS[horizon]}</p>

            <div className="flex flex-col gap-1">
              <BreakdownRow label="Deposits" value={summary.deposits} emphasized />
              <BreakdownRow label="Withdrawals" value={summary.withdrawals} emphasized />
            </div>

            <div className="flex flex-col gap-1 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
              <BreakdownRow label="Outgoings" value={summary.outgoings.totalOutgoings} emphasized />
              {summary.outgoings.perPerson.map((p) => (
                <BreakdownRow
                  key={p.personId}
                  label={`${p.name} — ${summary.outgoings.totalOutgoings > 0 ? Math.round((p.amount / summary.outgoings.totalOutgoings) * 100) : 0}%`}
                  value={p.amount}
                  muted
                />
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center justify-center py-1.5"
          aria-expanded={open}
          aria-label={open ? 'Hide deposits and outgoings breakdown' : 'Show deposits and outgoings breakdown'}
        >
          {open ? <ChevronUp size={16} className="text-[var(--color-ink-muted)]" /> : <ChevronDown size={16} className="text-[var(--color-ink-muted)]" />}
        </button>
      </div>
    </div>
  )
}

/**
 * The `bankLabel`/`accountLabel` text a `DeckHero` shows for this entry,
 * combined into one string for the wallet stack's sliver aria-labels —
 * copied from DeckHero's own per-kind switch below (not derived from it)
 * so the two can't silently drift apart; a reader auditing this file sees
 * both switches side by side.
 */
function heroLabel(entry: DeckEntry, data: AppDataV2): string {
  const primaryPerson = data.people.find((p) => p.id === data.primaryPersonId)
  switch (entry.kind) {
    case 'personal':
      return `${primaryPerson?.name ?? 'Me'} Personal`
    case 'joint':
      return `${primaryPerson?.name ?? 'Me'} Joint`
    case 'household':
      return 'Household Combined'
    case 'credit_card': {
      const card = data.creditCards.find((c) => c.id === entry.cardId)
      return `${card?.name ?? 'Credit Card'} Credit Card`
    }
    case 'loan': {
      const loan = data.loans.find((l) => l.id === entry.loanId)
      return `${loan?.name ?? 'Loan'} Loan`
    }
    case 'savings_pot': {
      const pot = data.savingsPots.find((p) => p.id === entry.potId)
      return `${pot?.name ?? 'Savings'} Savings`
    }
    case 'pot': {
      const pot = (data.pots ?? []).find((p) => p.id === entry.potId)
      return `${pot?.name ?? 'Pot'} Pot`
    }
  }
}

// ── Hero faces — compact BankCard fronts, swiped between ──────────────

function DeckHero({ entry, data, horizon, averageSpendForecast }: { entry: DeckEntry; data: AppDataV2; horizon: ProjectionHorizon; averageSpendForecast?: boolean }) {
  const primaryPerson = data.people.find((p) => p.id === data.primaryPersonId)

  switch (entry.kind) {
    case 'personal': {
      const payCycle = data.payCycles.find((pc) => pc.personId === data.primaryPersonId)
      if (!payCycle) {
        return (
          <BankCard variant="coral" bankLabel={primaryPerson?.name ?? 'Me'} accountLabel="Personal">
            <p className="text-sm text-white/80 mt-6">No pay cycle set up yet — head to the Salary page.</p>
          </BankCard>
        )
      }
      const projection = computeProjection(data, data.primaryPersonId, payCycle, horizon)
      // 2026-09-14 (average spend forecast, now reaching into the current
      // cycle too) — the hero's own "Projected" figure has to reflect the
      // forecast the same way CycleGroupedList's per-cycle closing balance
      // already does, or the two would disagree once the toggle is on.
      const forecastCycles = horizonCycles(data, data.primaryPersonId, horizon, new Date())
      const personalForecastTotal = averageSpendForecast
        ? [...buildForecastByCycle(data, { location: 'personal', ownerId: data.primaryPersonId }, data.primaryPersonId, forecastCycles).values()].reduce((sum, f) => sum + f.forecastAmount, 0)
        : 0
      return (
        <BankCard variant="coral" bankLabel={primaryPerson?.name ?? 'Me'} accountLabel="Personal">
          <div className="mt-6 space-y-1.5">
            <CardRow label="Current balance" value={projection.clearedBalance} />
            <CardRow label="Pending" value={pendingNetTotal(projection.transactions)} />
            <CardRow label={`Projected · ${HORIZON_LABELS[horizon]}`} value={round2(projection.projectedBalance - personalForecastTotal)} emphasized />
          </div>
        </BankCard>
      )
    }
    case 'joint': {
      // UAT 2026-09-11 — this used to always call resolveCycleBounds(...,
      // new Date()) and hardcode the "This cycle" label, ignoring
      // `horizon` entirely, unlike every other hero face (and unlike this
      // same card's own pulldown, JointBreakdownCard above, which already
      // threads horizon through horizonCycles correctly) — so neither the
      // numbers nor the row label ever responded to the This cycle/Next 3
      // cycles toggle. Matches JointBreakdownCard's own bounds-resolution
      // now.
      const cycles = horizonCycles(data, data.primaryPersonId, horizon, new Date())
      const bounds = { start: cycles[0].start, end: cycles[cycles.length - 1].end }
      const summary = computeJointSummary(data, bounds.start, bounds.end)
      // 2026-09-13 (Adam-specified) — a real "Current balance" row now
      // leads the card, same figure JointDetail/JointBreakdownCard's own
      // clearedBalance already shows (computeJointAccountProjection),
      // rendered here only once the joint account actually exists (mirrors
      // JointDetail's own "no joint account set up yet" guard).
      const jointProjection = computeJointAccountProjection(data, horizon)
      // 2026-09-14 (average spend forecast) — same reasoning as Personal's
      // own hero above: the forecast has to reduce this "Projected"
      // figure (here, the total outgoings — see the comment below) or the
      // hero and JointDetail's own CycleGroupedList would disagree.
      const jointForecastTotal = averageSpendForecast
        ? [...buildForecastByCycle(data, { location: 'joint' }, data.primaryPersonId, cycles).values()].reduce((sum, f) => sum + f.forecastAmount, 0)
        : 0
      return (
        <BankCard variant="light" bankLabel={primaryPerson?.name ?? 'Me'} accountLabel="Joint">
          <div className="mt-6 space-y-1.5">
            {jointProjection && <CardRow label="Current balance" value={jointProjection.clearedBalance} light />}
            {/* Hero-card consistency sweep (Adam-specified, 2026-09-12):
                every other hero ends on an emphasized "Projected ·
                {horizon}" row — Joint's own row used to be first, labelled
                with just the bare horizon ("NEXT 3 CYCLES"). Same number
                as before (total owed across the household this horizon,
                summary.totalOutgoings — Adam's own call: this stays what
                it means today, only the label/position changes), moved to
                match every other card's own bottom-row convention. The
                exception to the Personal-card standard this sweep
                otherwise follows: individual names/shares take the place
                of a single "Current balance" row, since a joint account
                has no per-person balance of its own to show instead. */}
            {summary.perPerson.map((p) => (
              <CardRow key={p.personId} label={p.name} value={p.amount} light small />
            ))}
            <CardRow label={`Projected · ${HORIZON_LABELS[horizon]}`} value={round2(summary.totalOutgoings + jointForecastTotal)} emphasized light />
          </div>
        </BankCard>
      )
    }
    case 'household': {
      // Personal-only, matching HouseholdDetail's own data source
      // (Adam-specified, 2026-09-03) — no joint bills folded in here
      // either, so the hero and the list below it can never disagree.
      const results = computeHouseholdProjections(data, horizon)
      const totalCleared = results.reduce((sum, r) => sum + r.clearedBalance, 0)
      const totalProjected = results.reduce((sum, r) => sum + r.projectedBalance, 0)
      const totalPendingOutgoing = results.reduce((sum, r) => sum + pendingNetTotal(r.transactions), 0)
      return (
        <BankCard variant="dark" bankLabel="Household" accountLabel="Combined">
          <div className="mt-6 space-y-1.5">
            <CardRow label="Current balance" value={totalCleared} />
            <CardRow label="Pending" value={totalPendingOutgoing} />
            <CardRow label={`Projected · ${HORIZON_LABELS[horizon]}`} value={totalProjected} emphasized />
          </div>
        </BankCard>
      )
    }
    case 'credit_card': {
      const stored = data.creditCards.find((c) => c.id === entry.cardId)
      if (!stored) return null
      // BUGFIX (Batch 8, 2026-09-07, Bug 9.1, Adam-reported): this used to
      // always derive the balance as of TODAY regardless of `horizon` —
      // correct for "This cycle" but silently wrong for "Next 3 cycles"
      // (a purchase dated later this cycle, or in a future cycle within
      // the horizon, never showed up here at all). Same fix shape as the
      // Savings pot hero card's own 2026-09-03 bugfix just below —
      // horizonRangeEnd is the SAME function computeProjection uses for
      // Personal's hero card, so this now genuinely varies with the
      // toggle the way every other hero card already does.
      const cardAsOf = horizon === 'three_cycles' ? horizonRangeEnd(data, data.primaryPersonId, horizon, new Date()) : new Date()
      // Derived balance, not the stored anchor — see cardBalanceAsOf.
      // The minimum due has to be computed against the live figure too,
      // or a percent-of-balance card would quote a minimum for a debt
      // that's already been partly paid off.
      const card = withLiveBalance(stored, data.transactions, cardAsOf)
      // Same shared generator the Summary page uses, so an overridden
      // charge shows the overridden figure here too rather than the
      // un-overridden computed one. See nextMinimumChargeAmount.
      const minPayment = nextMinimumChargeAmount(stored, data.transactions) ?? 0
      return (
        <BankCard variant="custom" customColor={card.color} bankLabel={card.name} accountLabel="Credit Card" icon={<CreditCardIcon size={18} strokeWidth={1.5} color="#fff" />}>
          <div className="mt-6 space-y-1.5">
            <CardRow label="Owed" value={card.currentBalance} />
            <CardRow label="Min. due" value={minPayment} emphasized />
          </div>
        </BankCard>
      )
    }
    case 'loan': {
      const loan = data.loans.find((l) => l.id === entry.loanId)
      if (!loan) return null
      // Owed now · projected · due date (Adam, 2026-09-18), mirroring the
      // credit card hero this sits next to in the deck. "Projected" is
      // owed-at-the-horizon-end, the same owed-today-vs-owed-later sense a
      // card means by it — a debt has no projected BALANCE the way a cash
      // account does. Both figures come from summarizeLoan, so they cannot
      // disagree with the ledger or the trend chart's own headline.
      const loanAsOf = horizon === 'three_cycles' ? horizonRangeEnd(data, data.primaryPersonId, horizon, new Date()) : new Date()
      const owedNow = summarizeLoan(loan, new Date()).remainingBalance
      const owedProjected = summarizeLoan(loan, loanAsOf).remainingBalance
      // The loan's OWN shared-palette colour, never its category's — loans
      // overwhelmingly share the one seeded "Loan" category, so keying off
      // that made every loan card identical (Adam, 2026-09-18). See
      // Loan.color and pickNextSharedCardColor.
      return (
        <BankCard variant="custom" customColor={loan.color} bankLabel={loan.name} accountLabel="Loan" icon={<Layers size={18} strokeWidth={1.5} color="#fff" />}>
          <div className="mt-6 space-y-1.5">
            <CardRow label="Owed" value={owedNow} />
            <CardRow label="Projected" value={owedProjected} emphasized />
          </div>
        </BankCard>
      )
    }
    case 'savings_pot': {
      const pot = data.savingsPots.find((p) => p.id === entry.potId)
      if (!pot) return null
      const balance = savingsPotBalanceAsOf(pot, data.transactions, new Date())
      // BUGFIX (Adam-reported, 2026-09-03): this used to always project
      // to THIS cycle's end regardless of `horizon` — correct for "This
      // cycle" but silently wrong for "Next 3 cycles" (labelled
      // correctly, computed identically to the current-cycle figure).
      // horizonRangeEnd is the SAME function computeProjection uses for
      // Personal's own hero card — current cycle end for 'current_cycle',
      // 3-cycles-ahead end for 'three_cycles' — so this now genuinely
      // varies with the toggle the way every other hero card already does.
      const horizonEnd = horizonRangeEnd(data, data.primaryPersonId, horizon, new Date())
      const primaryPayCycleForPot = data.payCycles.find((c) => c.personId === data.primaryPersonId)
      const projectedBalance = projectedBalanceAt(pot, balance, data.transactions, new Date(), horizonEnd, data.recurringTemplates, primaryPayCycleForPot)
      // Hero-card consistency sweep (Adam-specified, 2026-09-12): every
      // other hero shows Current balance/Pending/Projected — this one had
      // no Pending row at all. savingsPotBalanceAsOf (what both `balance`
      // and `projectedBalance` are ultimately built from) has no cleared/
      // pending split of its own — it just sums every transaction dated on
      // or before its asOf date, whatever its status. So `balance` (as of
      // today) and `projectedBalance` (as of horizonEnd) are already the
      // two true anchors; Pending is simply their difference — anything
      // else (e.g. re-deriving it from a separately-filtered pending-only
      // row list) risks double-counting rows already baked into `balance`
      // and not reconciling (Current balance + Pending = Projected, same
      // property Personal's own pendingNetTotal is built to guarantee).
      const savingsPending = round2(projectedBalance - balance)
      return (
        <BankCard variant="custom" customColor={pot.color} bankLabel={pot.name} accountLabel="Savings" icon={<PiggyBank size={18} strokeWidth={1.5} color="#fff" />}>
          <div className="mt-6 space-y-1.5">
            <CardRow label="Current balance" value={balance} />
            <CardRow label="Pending" value={savingsPending} />
            <CardRow label={`Projected · ${HORIZON_LABELS[horizon]}`} value={projectedBalance} emphasized />
          </div>
        </BankCard>
      )
    }
    // Pots backlog item, Phase 7 (2026-09 session) — reuses
    // computePotProjection directly (the SAME function PotDetail below
    // uses for the full ledger) rather than a second, parallel balance
    // calculation, so the hero figure and the detail card underneath it
    // can never quietly disagree the way the SavingsPot hero/detail split
    // above had to be BUGFIXed for.
    case 'pot': {
      const pot = (data.pots ?? []).find((p) => p.id === entry.potId)
      if (!pot) return null
      const projection = computePotProjection(data, pot, horizon, new Date())
      return (
        <BankCard variant="custom" customColor={pot.color} bankLabel={pot.name} accountLabel="Pot" icon={<Wallet size={18} strokeWidth={1.5} color="#fff" />}>
          <div className="mt-6 space-y-1.5">
            <CardRow label="Current balance" value={projection.clearedBalance} />
            {/* Hero-card consistency sweep (Adam-specified, 2026-09-12) —
                same Current balance/Pending/Projected shape as Personal.
                potSignedAmount, not the personal ledger's default sign —
                same override PotDetail's own ledger list already passes
                to CategoryGroupedList/AmountOrderedList above. */}
            <CardRow label="Pending" value={pendingNetTotal(projection.transactions, (t) => potSignedAmount(t, pot.id))} />
            <CardRow label={`Projected · ${HORIZON_LABELS[horizon]}`} value={projection.projectedBalance} emphasized />
          </div>
        </BankCard>
      )
    }
  }
}

// ── Detail section — full list/toggles/pie, rendered below the deck for whichever card is active ──

function DeckDetail(props: {
  entry: DeckEntry
  data: AppDataV2
  horizon: ProjectionHorizon
  setHorizon: (v: ProjectionHorizon) => void
  grouping: Grouping
  setGrouping: (v: Grouping) => void
  order: Order
  setOrder: (v: Order) => void
  cycleTotals: boolean
  showCleared: boolean
  groupByDirection: boolean
  averageSpendForecast: boolean
}) {
  const { entry, data } = props
  switch (entry.kind) {
    case 'personal':
      return <PersonalDetail {...props} />
    case 'joint':
      return <JointDetail {...props} />
    case 'household':
      return <HouseholdDetail {...props} />
    case 'credit_card': {
      const card = data.creditCards.find((c) => c.id === entry.cardId)
      return card ? (
        <CreditCardDetail card={card} data={data} horizon={props.horizon} cycleTotals={props.cycleTotals} showCleared={props.showCleared} groupByDirection={props.groupByDirection} />
      ) : null
    }
    case 'savings_pot': {
      const pot = data.savingsPots.find((p) => p.id === entry.potId)
      return pot ? (
        <SavingsPotDetail pot={pot} data={data} horizon={props.horizon} cycleTotals={props.cycleTotals} showCleared={props.showCleared} groupByDirection={props.groupByDirection} />
      ) : null
    }
    case 'pot': {
      const pot = (data.pots ?? []).find((p) => p.id === entry.potId)
      return pot ? <PotDetail {...props} pot={pot} /> : null
    }
    case 'loan': {
      const loan = data.loans.find((l) => l.id === entry.loanId)
      return loan ? <LoanDetail loan={loan} data={data} horizon={props.horizon} cycleTotals={props.cycleTotals} showCleared={props.showCleared} /> : null
    }
  }
}

/**
 * The single predicate deciding whether cycle-end totals apply — used
 * both to show the toggle and to decide whether to render the grouped
 * list, so the control and the behaviour can never disagree.
 *
 * Widened (Adam-specified, 2026-09-03) from 'personal'-only to also cover
 * 'household' and 'joint', now that both get the same ledger-parity
 * toolkit. 'person' grouping is included alongside 'list' — Adam's
 * original spec for the group-by-person view: "the same options to
 * follow... include cycle-end totals." (Since 2026-09-14 on Joint and
 * 2026-09-16 on Household, Person grouping is a fixed cycle-outer view
 * that ignores this toggle — see JointDetail/HouseholdDetail.)
 *
 * 2026-09-17 (Adam-specified): the horizon no longer matters. This used to
 * require 'three_cycles', on the reasoning that "this cycle" is a single
 * span with nothing to subtotal — but that made the toggle grey out and
 * fall back to the flat list exactly when This cycle became the default
 * view. One cycle still subtotals perfectly well, and renders as the same
 * collapsed pill the current cycle gets under Next 3 cycles, which is the
 * point. `horizon` stays in the signature (unused) so every call site
 * keeps reading the same way.
 *
 * Widened again (Adam-specified, 2026-09-08) for 'credit_card' — a
 * genuinely different case from the other four, which all share one
 * grouping/order toolkit built around the household's OWN pay cycle.
 * A credit card has no "Group by"/"Order by" of its own (DeckControls'
 * `showGroupOrder` never includes it), so `grouping`/`order` are just
 * whatever the page's shared state happens to be — irrelevant here,
 * checked anyway only so a value doesn't accidentally matter — and BOTH
 * horizons apply (a card's own "this cycle"/"next 3 cycles" periods are
 * always meaningful, unlike the personal/household/joint case where
 * "this cycle" is a single span with nothing to subtotal).
 *
 * Widened again (Adam-specified, 2026-09-12) for 'savings_pot' — grouped
 * with personal/household/joint/pot, NOT with credit_card: a Savings Pot
 * uses the household's own pay-cycle boundaries (horizonCycles), same as
 * that group, unlike a credit card's own billing-cycle dates, which stay
 * untouched by this change.
 */
function canShowCycleTotals(entry: DeckEntry, _horizon: ProjectionHorizon, grouping: Grouping, order: Order): boolean {
  // A loan card has no group-by/order-by of its own (see
  // DECK_CONTROLS_SHOW_GROUP_ORDER), so those two are always at their
  // defaults here — cycle-end totals simply apply, as on a credit card.
  if (entry.kind === 'credit_card' || entry.kind === 'loan') return order === 'date' && grouping !== 'category'
  return (
    (entry.kind === 'personal' || entry.kind === 'household' || entry.kind === 'joint' || entry.kind === 'pot' || entry.kind === 'savings_pot') &&
    order === 'date' &&
    grouping !== 'category'
  )
}

/**
 * The forecast row data for every cycle (current AND future, since the
 * 2026-09-14 rewrite — see
 * PROMPT-average-spend-forecast-current-cycle-2026-09-14.md) that needs
 * one. Shared between PersonalDetail (`{ location: 'personal', ownerId }`)
 * and JointDetail (`{ location: 'joint' }`); `personId` is always
 * `data.primaryPersonId` for BOTH — the joint account has no independent
 * "joint pay cycle" concept of its own, it borrows the primary person's.
 * Keyed by each cycle's own start date (ISO) so `CycleGroupedList` can
 * look a cycle's forecast up by its own `section.startIso`. Returns an
 * empty map (not undefined) when there's no spend history to build a
 * daily rate from at all — simplifies every caller to a single
 * `.get(...)` with no extra null-check.
 */
function buildForecastByCycle(data: AppDataV2, scope: SpendScope, personId: string, cycles: { start: Date; end: Date }[]): Map<string, { forecastAmount: number; realSpend: number }> {
  const map = new Map<string, { forecastAmount: number; realSpend: number }>()
  const asOfDate = new Date()
  if (!hasSpendHistory(data, scope, personId, asOfDate)) return map
  for (const cycle of cycles) {
    const averageForThisCycle = averageAdHocSpendForCycle(data, scope, personId, cycle, asOfDate)
    if (averageForThisCycle <= 0) continue
    const { forecastAmount, realSpend } = forecastSpendForCycle(data, scope, averageForThisCycle, cycle)
    if (forecastAmount > 0) map.set(toLocalIsoDate(cycle.start), { forecastAmount, realSpend })
  }
  return map
}

const DECK_CONTROLS_SHOW_GROUP_ORDER = (entry: DeckEntry) =>
  entry.kind === 'personal' || entry.kind === 'household' || entry.kind === 'joint' || entry.kind === 'pot'

/**
 * 2026-09-13 (deck controls cleanup, Adam-specified) — a plain-English
 * list of everything about the current view that differs from ITS OWN
 * default, used for both the Filters button's active dot and the
 * one-line caption underneath it. Deliberately compares each control
 * against its own default rather than a blanket "is this switch on" —
 * Cycle-end totals defaults to ON, so turning it OFF is just as much a
 * non-default view as turning something else on (Adam's own question,
 * settled live: "what about toggling cycle end off?"). Group by/Order by
 * are only checked for card kinds that actually offer them — the
 * grouping/order state is shared page-wide, so a stale 'category' left
 * over from viewing a DIFFERENT card must never light this card's own
 * dot (Show cleared/Cycle-end totals/Group by direction have no such
 * cross-card leakage risk, since their own defaults are globally
 * consistent regardless of which card is showing).
 */
function activeFilterLabels(
  entry: DeckEntry,
  grouping: Grouping,
  order: Order,
  showCleared: boolean,
  cycleTotals: boolean,
  groupByDirection: boolean,
  averageSpendForecast: boolean,
): string[] {
  const showGroupOrder = DECK_CONTROLS_SHOW_GROUP_ORDER(entry)
  const labels: string[] = []
  if (showGroupOrder && grouping !== 'list') labels.push(`Group by ${grouping === 'category' ? 'category' : 'person'}`)
  if (showGroupOrder && order !== 'date') labels.push('Order by amount')
  if (showCleared) labels.push('Show cleared')
  if (!cycleTotals) labels.push('Cycle-end totals off')
  if (groupByDirection) labels.push('Group by direction')
  // Personal/Joint only — the toggle doesn't exist for any other card
  // kind, so a stale `true` from viewing Personal must never light
  // Household/Pot/Credit Card/Savings Pot's own dot (unlike Cycle-end
  // totals/Group by direction, which genuinely apply everywhere, this
  // one doesn't).
  if ((entry.kind === 'personal' || entry.kind === 'joint') && averageSpendForecast) labels.push('Average spend forecast')
  return labels
}

// ── Deck controls — cycle toggle + a single "Filters" button, living
// BETWEEN the hero deck and the detail card (not inside either one).
// 2026-09-13 cleanup (Adam-specified — see
// PROMPT-deck-controls-cleanup-2026-09-13.md): this used to be the cycle
// toggle plus up to 2 inline dropdowns and 4 stacked toggle switches,
// always visible — cluttered on a narrow phone screen. Now only the
// cycle toggle stays inline; everything else lives behind one Filters
// button (FiltersSheet, below), with an active-state dot + one-line
// caption so the collapsed state doesn't hide WHAT changed, only the
// controls for changing it. ──

function DeckControls({
  entry,
  data,
  horizon,
  setHorizon,
  grouping,
  setGrouping,
  order,
  setOrder,
  cycleTotals,
  setCycleTotals,
  showCleared,
  setShowCleared,
  groupByDirection,
  setGroupByDirection,
  averageSpendForecast,
  setAverageSpendForecast,
}: {
  entry: DeckEntry
  data: AppDataV2
  horizon: ProjectionHorizon
  setHorizon: (v: ProjectionHorizon) => void
  grouping: Grouping
  setGrouping: (v: Grouping) => void
  order: Order
  setOrder: (v: Order) => void
  cycleTotals: boolean
  setCycleTotals: (v: boolean) => void
  showCleared: boolean
  setShowCleared: (v: boolean) => void
  groupByDirection: boolean
  setGroupByDirection: (v: boolean) => void
  averageSpendForecast: boolean
  setAverageSpendForecast: (v: boolean) => void
}) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const activeLabels = activeFilterLabels(entry, grouping, order, showCleared, cycleTotals, groupByDirection, averageSpendForecast)
  const isNonDefault = activeLabels.length > 0

  function resetToDefault() {
    if (DECK_CONTROLS_SHOW_GROUP_ORDER(entry)) {
      setGrouping('list')
      setOrder('date')
    }
    setShowCleared(false)
    setCycleTotals(true)
    setGroupByDirection(false)
    setAverageSpendForecast(false)
  }

  return (
    <div className="mb-5 px-1">
      <div className="flex items-center justify-between">
        <CycleToggle value={horizon} onChange={setHorizon} />
        <div className="flex items-center gap-3">
          {/* "Reset to default", added 2026-09-13 (Adam-specified) —
              shown next to the Filters button itself (a second copy also
              lives inside FiltersSheet's header, next to its own close
              icon), gated by the exact same `isNonDefault` check the
              active count uses, so it only ever appears when there's
              actually something to reset. 2026-09-14: swapped from a
              text label to a RotateCcw icon, matching the Filters
              button's own icon-only treatment. */}
          {isNonDefault && (
            <button onClick={resetToDefault} aria-label="Reset to default" style={{ color: 'var(--color-coral)' }}>
              <RotateCcw size={17} />
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setFiltersOpen(true)}
              aria-label="Filters"
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-track)' }}
            >
              <SlidersHorizontal size={17} style={{ color: 'var(--color-ink)' }} />
            </button>
            {/* 2026-09-13 follow-up (Adam-specified) — a bare red NUMBER,
                no circular badge/dot behind it — see activeFilterLabels'
                own comment for the "differs from ITS OWN default" rule
                the count itself is built from. */}
            {isNonDefault && (
              <span
                className="absolute font-mono font-bold"
                style={{ top: -6, right: -6, fontSize: 13, lineHeight: 1, color: 'var(--color-coral)' }}
              >
                {activeLabels.length}
              </span>
            )}
          </div>
        </div>
      </div>
      {isNonDefault && (
        <p className="text-[11px] mt-2" style={{ color: 'var(--color-ink-faint)' }}>
          {activeLabels.join(' · ')}
        </p>
      )}
      {filtersOpen && (
        <FiltersSheet
          entry={entry}
          data={data}
          horizon={horizon}
          grouping={grouping}
          setGrouping={setGrouping}
          order={order}
          setOrder={setOrder}
          cycleTotals={cycleTotals}
          setCycleTotals={setCycleTotals}
          showCleared={showCleared}
          setShowCleared={setShowCleared}
          groupByDirection={groupByDirection}
          setGroupByDirection={setGroupByDirection}
          averageSpendForecast={averageSpendForecast}
          setAverageSpendForecast={setAverageSpendForecast}
          onClose={() => setFiltersOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * 2026-09-13 (deck controls cleanup, Adam-specified) — everything that
 * used to live in DeckControls' own always-visible dropdown/toggle stack
 * now lives here instead, opened from the Filters button. Group by/Order
 * by become segmented pill rows (every option visible at once, no
 * tap-to-open dropdown); every toggle becomes a full-width row with room
 * for a short helper caption on the less self-explanatory ones. Every
 * pick still applies live the instant it's tapped — there is nothing to
 * "cancel," so the X and a tap on the backdrop both just close the
 * sheet (Adam-specified: "any selections made are instant, so no need
 * for a cancel button").
 */
function FiltersSheet({
  entry,
  data,
  horizon,
  grouping,
  setGrouping,
  order,
  setOrder,
  cycleTotals,
  setCycleTotals,
  showCleared,
  setShowCleared,
  groupByDirection,
  setGroupByDirection,
  averageSpendForecast,
  setAverageSpendForecast,
  onClose,
}: {
  entry: DeckEntry
  data: AppDataV2
  horizon: ProjectionHorizon
  grouping: Grouping
  setGrouping: (v: Grouping) => void
  order: Order
  setOrder: (v: Order) => void
  cycleTotals: boolean
  setCycleTotals: (v: boolean) => void
  showCleared: boolean
  setShowCleared: (v: boolean) => void
  groupByDirection: boolean
  setGroupByDirection: (v: boolean) => void
  averageSpendForecast: boolean
  setAverageSpendForecast: (v: boolean) => void
  onClose: () => void
}) {
  const showGroupOrder = DECK_CONTROLS_SHOW_GROUP_ORDER(entry)
  // Household's "group by person" splits each person's own SEPARATE
  // personal ledger out. Joint's own "group by person" (added 2026-09-13,
  // Adam-specified — previously deliberately excluded, 2026-09-03) is a
  // genuinely different thing: ONE shared ledger split into each
  // person's SHARE of joint bills/loans/transfers, plus an unattributed
  // "Spend" bucket — see buildJointPersonGroups' own comment. Personal
  // still has no "group by person" at all — it's already one person.
  const groupingOptions: { value: Grouping; label: string }[] =
    entry.kind === 'household' || entry.kind === 'joint'
      ? [
          { value: 'list', label: 'List' },
          { value: 'category', label: 'Category' },
          { value: 'person', label: 'Person' },
        ]
      : [
          { value: 'list', label: 'List' },
          { value: 'category', label: 'Category' },
        ]
  // 2026-09-13 follow-up (Adam-specified) — these three toggles used to
  // be HIDDEN outright whenever the current Group by/Order by pick made
  // them inapplicable. Adam's own ask: grey them out (disabled) instead,
  // so every toggle this card kind can ever offer stays visible, and
  // it's clear WHY one can't be tapped right now rather than it just
  // vanishing. `canShowCycleTotals` is still the single source of truth
  // for whether Cycle-end totals currently applies — only what happens
  // when it's false changed (disabled, not omitted).
  //
  // Cycle-end totals needs a continuous date-ordered running balance to
  // take a subtotal FROM (list + date) — see canShowCycleTotals' own
  // comment. It no longer needs multiple cycles: under "This cycle" it
  // renders that one cycle as the same collapsed pill (Adam, 2026-09-17).
  const cycleTotalsApplicable = canShowCycleTotals(entry, horizon, grouping, order)
  // Independent of Cycle-end totals, but still only meaningful for 'list'
  // grouping + 'date' order on a Group-by/Order-by card: 'category'/
  // 'person' already split the ledger a different way
  // (CategoryGroupedList doesn't accept a groupByDirection prop, and
  // 'person' routes CycleGroupedList through its own mutually exclusive
  // groupByPerson mode), and AmountOrderedList doesn't either.
  // Credit Card/Savings Pot have no Group-by/Order-by of their own to
  // conflict with, so it's always applicable there.
  // A loan's ledger only ever moves one way — repayments toward the debt —
  // so splitting it into Incoming/Outgoing says nothing (Adam, 2026-09-18).
  // Greyed out rather than hidden, same as everything else here.
  const groupByDirectionApplicable = entry.kind !== 'loan' && (!showGroupOrder || (grouping === 'list' && order === 'date'))
  // Why Group by/Order by can't be tapped on this card, in the person's own
  // terms rather than just a dimmed control.
  const groupOrderUnavailableReason =
    entry.kind === 'loan'
      ? 'Every row here is this loan, so there is nothing to group or reorder'
      : entry.kind === 'credit_card'
        ? "This card's own activity is always listed by date"
        : 'Not available for this card'
  // 2026-09-13 (average spend forecast) — Personal/Joint only (this part
  // STAYS a hide, not a grey-out — Household/Pot/Credit Card/Savings Pot
  // don't have this feature at all, that's not a "current selection"
  // problem the way the other two are).
  const showAverageSpendForecastRow = entry.kind === 'personal' || entry.kind === 'joint'
  // 2026-09-14 (Adam-reported) — used to also require Cycle-end totals
  // genuinely ON, back when the forecast row only ever rendered inside
  // CycleGroupedList — which meant it was unreachable under the "This
  // cycle" horizon toggle entirely (canShowCycleTotals requires
  // 'three_cycles'), even though that's most people's default/typical
  // view. DateOrderedList now renders the same forecast row as its own
  // last line whenever Cycle-end totals ISN'T applicable/on, so the
  // toggle only actually needs 'list' grouping + 'date' order (same
  // "flat, continuous running balance" requirement as
  // groupByDirectionApplicable above) — not a specific horizon or
  // Cycle-end totals state any more.
  const averageSpendForecastScope: SpendScope | undefined =
    entry.kind === 'personal' ? { location: 'personal', ownerId: data.primaryPersonId } : entry.kind === 'joint' ? { location: 'joint' } : undefined
  const hasForecastHistory = averageSpendForecastScope ? hasSpendHistory(data, averageSpendForecastScope, data.primaryPersonId, new Date()) : false
  // Distinguishes "no matching spend logged at all" from "some, just not the 2-week minimum
  // yet" for the toggle's own help text — hasSpendHistory alone only tells you pass/fail.
  const hasAnySpendAtAll = averageSpendForecastScope ? hasAnyMatchingSpend(data, averageSpendForecastScope) : false
  const forecastHistoryDays = averageSpendForecastScope ? daysOfSpendHistory(data, averageSpendForecastScope, data.primaryPersonId, new Date()) : 0
  const averageSpendForecastApplicable = grouping === 'list' && order === 'date' && hasForecastHistory
  const isNonDefault = activeFilterLabels(entry, grouping, order, showCleared, cycleTotals, groupByDirection, averageSpendForecast).length > 0

  function resetToDefault() {
    if (showGroupOrder) {
      setGrouping('list')
      setOrder('date')
    }
    setShowCleared(false)
    setCycleTotals(true)
    setGroupByDirection(false)
    setAverageSpendForecast(false)
  }

  // 2026-09-13 (Adam-reported) — raising z-index alone did NOT clear
  // BottomNav, because this sheet was rendered inline inside #app-shell/
  // #app-content's own DOM tree, not at the document root. EVERY other
  // modal in this app (ConfirmModal, CategoryIconPickerModal, etc.) uses
  // `createPortal(..., document.body)` for exactly this reason — a
  // portalled node sits outside the app shell's stacking context
  // entirely, so z-index actually behaves as written. Mirrors
  // CategoryIconPickerModal's own bottom-sheet shape (single backdrop+
  // sheet div, `items-end` flex, `paddingBottom` clearing the real nav
  // bar height) rather than reinventing a two-div fixed-position layout.
  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(5,7,13,0.72)' }} onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[80vh] overflow-y-auto"
        style={{
          background: 'var(--color-bg-elevated)',
          borderTop: '1px solid var(--color-track)',
          borderRadius: '24px 24px 0 0',
          padding: '20px',
          paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
          boxShadow: '0 -12px 32px rgba(0,0,0,0.4)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-3.5">
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'var(--color-track)' }} />
          <div className="w-full flex items-center justify-between">
            <span className="font-display text-base font-semibold text-[var(--color-ink)]">Ledger view</span>
            <div className="flex items-center gap-3">
              {/* 2026-09-14 — relocated here from the bottom of the sheet's
                  control list, as an icon (RotateCcw) rather than a text
                  label, sitting immediately left of the close icon. */}
              {isNonDefault && (
                <button onClick={resetToDefault} aria-label="Reset to default" style={{ color: 'var(--color-coral)' }}>
                  <RotateCcw size={18} />
                </button>
              )}
              <button onClick={onClose} className="text-[var(--color-ink-muted)]" aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 mt-4">
          {/* 2026-09-18 (Adam-reported, on the loan and credit card cards) —
              Group by / Order by are now DISABLED rather than removed on the
              card kinds that don't offer them, extending the exact rule Adam
              already asked for on the three toggles below: "the unavailable
              filter options should be visible but greyed out". Every control
              the sheet can ever show is now always present, so the sheet's
              shape doesn't change from card to card and it's obvious WHY
              something can't be tapped. `showGroupOrder` still decides
              applicability — only what happens when it's false changed. */}
          <>
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">Group by</span>
              <div className="flex gap-1.5">
                {groupingOptions.map((opt) => (
                  <button
                    key={opt.value}
                    disabled={!showGroupOrder}
                    onClick={() => setGrouping(opt.value)}
                    className="flex-1 py-2 rounded-full text-sm font-medium disabled:opacity-40"
                    style={{ background: grouping === opt.value ? 'var(--color-coral)' : 'var(--color-surface)', color: grouping === opt.value ? '#fff' : 'var(--color-ink-muted)' }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {!showGroupOrder && <span className="text-[11px] text-[var(--color-ink-faint)]">{groupOrderUnavailableReason}</span>}
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">Order by</span>
              <div className="flex gap-1.5">
                {(
                  [
                    { value: 'date', label: 'Date' },
                    { value: 'amount', label: 'Amount' },
                  ] as { value: Order; label: string }[]
                ).map((opt) => (
                  <button
                    key={opt.value}
                    disabled={!showGroupOrder || grouping === 'category'}
                    onClick={() => setOrder(opt.value)}
                    className="flex-1 py-2 rounded-full text-sm font-medium disabled:opacity-40"
                    style={{ background: order === opt.value ? 'var(--color-coral)' : 'var(--color-surface)', color: order === opt.value ? '#fff' : 'var(--color-ink-muted)' }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ height: 1, background: 'var(--color-surface-raised)' }} />
          </>

          {/* Unlike cycle-end totals below, this one applies to every
              grouping/order combination — list, category, and amount all
              have SOME notion of "hide the rows that already cleared"
              (and, for category, a total to match), so it's never gated
              on the current view the way cycle-end totals is. */}
          <ToggleSwitch full label="Show cleared" help="Include already-cleared transactions in the list" checked={showCleared} onChange={setShowCleared} />
          <ToggleSwitch
            full
            label="Cycle-end totals"
            help={cycleTotalsApplicable ? 'Subtotal each pay cycle' : "Not available for this Group by/Order by"}
            checked={cycleTotals}
            onChange={setCycleTotals}
            disabled={!cycleTotalsApplicable}
          />
          <ToggleSwitch
            full
            label="Group by direction"
            help={groupByDirectionApplicable ? 'Split into incoming / outgoing' : entry.kind === 'loan' ? 'A loan only has repayments going one way' : 'Only available for List + Date'}
            checked={groupByDirection}
            onChange={setGroupByDirection}
            disabled={!groupByDirectionApplicable}
          />
          {showAverageSpendForecastRow && (
            <ToggleSwitch
              full
              label="Average spend forecast"
              help={
                averageSpendForecastApplicable
                  ? 'Include a spend estimate at the end of each cycle'
                  : hasForecastHistory
                    ? 'Requires List grouping, Order by date'
                    : hasAnySpendAtAll
                      ? `Needs ${MIN_SPEND_HISTORY_DAYS} days of spend history (${forecastHistoryDays} so far)`
                      : 'No spend history yet to estimate from'
              }
              checked={averageSpendForecast}
              onChange={setAverageSpendForecast}
              disabled={!averageSpendForecastApplicable}
            />
          )}

          <button onClick={onClose} className="w-full py-3 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-coral)' }}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Trends feature (2026-09-15 build) ──────────────────────────────────

/** Small pill button, reused by TrendsModal's granularity selector and Balance/Spend toggle — same visual language as CycleToggle below, generalised to N options instead of 2. */
function SegmentedControl<T extends string>({ options, value, onChange, fullWidth }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; fullWidth?: boolean }) {
  return (
    <div className={`flex items-center gap-1 p-1 rounded-full ${fullWidth ? 'w-full' : ''}`} style={{ background: 'var(--color-bg)' }}>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${fullWidth ? 'flex-1' : ''}`}
          style={{
            background: value === opt.value ? 'var(--color-surface-raised)' : 'transparent',
            color: value === opt.value ? 'var(--color-ink)' : 'var(--color-ink-muted)',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

const BALANCE_SPEND_GRANULARITY_OPTIONS: { value: BalanceSpendGranularity; label: string }[] = [
  { value: 'this_cycle', label: 'This Cycle' },
  { value: 'next_3_cycles', label: 'Next 3 Cycles' },
]
const SAVINGS_POT_GRANULARITY_OPTIONS: { value: SavingsPotPillGranularity; label: string }[] = [
  { value: 'this_cycle', label: 'This Cycle' },
  { value: 'last_6_cycles', label: 'Last 6 Cycles' },
  { value: 'year', label: 'Year' },
]

/**
 * The full interactive Trends modal for one card instance — copies
 * FiltersSheet's portal/backdrop/safe-area structure EXACTLY (per the
 * prompt doc's own instruction, this is the fix for the bug where the
 * bottom nav rendered above a modal that wasn't portalled to
 * document.body). This modal's own granularity/Balance-Spend selection is
 * entirely separate from — and ignores — whatever filter is active on the
 * home page itself.
 */
function TrendsModal({
  cardName,
  color,
  balanceSpend,
  savingsPot,
  onClose,
}: {
  cardName: string
  color: string
  onClose: () => void
  /** Present for personal/joint/household/credit_card/pot cards. `dayIcons` — icon-only (no amounts) category icons for whatever transactions occurred that day, per the spec's tooltip requirement. */
  balanceSpend?: {
    buildSeries: (granularity: BalanceSpendGranularity) => BalanceSpendTrendSeries | null
    dayDetails?: (dateIso: string) => { icons: { key: string; node: ReactNode }[]; netAmount: number }
    /**
     * One range, balance only — a loan card (PROMPT-08a Part C: "balance
     * view only... a single time range: all time"). Hides both the
     * Balance/Spend toggle and the This cycle / Next 3 cycles control,
     * since neither means anything for a series that always covers the
     * loan's whole life. `buildSeries` is still called, and simply
     * ignores the granularity it is handed.
     */
    fixedRange?: boolean
  }
  /** Present for savings_pot cards only. */
  savingsPot?: { buildSeries: (granularity: SavingsPotPillGranularity) => SavingsPotTrendSeries }
}) {
  const [bsGranularity, setBsGranularity] = useState<BalanceSpendGranularity>('this_cycle')
  const [spGranularity, setSpGranularity] = useState<SavingsPotPillGranularity>('this_cycle')
  const [view, setView] = useState<BalanceSpendView>('balance')
  const [activePillPoint, setActivePillPoint] = useState<SavingsPotPillPoint | null>(null)
  const [activeBsPoint, setActiveBsPoint] = useState<{ date: string; value: number } | null>(null)

  const bsSeries = balanceSpend ? balanceSpend.buildSeries(bsGranularity) : null
  const spSeries = savingsPot ? savingsPot.buildSeries(spGranularity) : null

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(5,7,13,0.72)' }} onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[80vh] overflow-y-auto"
        style={{
          background: 'var(--color-bg-elevated)',
          borderTop: '1px solid var(--color-track)',
          borderRadius: '24px 24px 0 0',
          padding: '20px',
          paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
          boxShadow: '0 -12px 32px rgba(0,0,0,0.4)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-3.5">
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'var(--color-track)' }} />
          <div className="w-full flex items-center justify-between">
            <span className="font-display text-base font-semibold text-[var(--color-ink)]">{cardName} trends</span>
            <button onClick={onClose} aria-label="Close" className="p-1">
              <X size={20} className="text-[var(--color-ink-muted)]" />
            </button>
          </div>

          {balanceSpend && (
            <>
              <div className="w-full flex items-center justify-between" style={balanceSpend.fixedRange ? { display: 'none' } : undefined}>
                <SegmentedControl
                  options={[
                    { value: 'balance' as const, label: 'Balance' },
                    { value: 'spend' as const, label: 'Spend' },
                  ]}
                  value={view}
                  onChange={(v) => {
                    setView(v)
                    setActiveBsPoint(null)
                  }}
                />
              </div>

              {/* Callout: card headline by default (no background — only a real tap-and-hold
                  tooltip gets one), swaps to the held point's own date + net £IN/OUT + icons on
                  the left once active. The left column reserves a fixed-height second row
                  whenever a point is active, so hovering a day with no transactions doesn't
                  shrink the box relative to one with several category icons. */}
              <div
                className="w-full rounded-2xl p-3 flex items-center justify-between gap-2"
                style={activeBsPoint ? { background: 'var(--color-bg)' } : undefined}
                data-testid="trend-tooltip"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--color-ink)]">{activeBsPoint ? shortDayLabel(activeBsPoint.date) : cardName}</p>
                  {activeBsPoint && (
                    // Fixed height, not a min-height: CategoryIcon renders each icon inside a
                    // `size + 16` chip (32px at the size={16} this row uses), which is TALLER
                    // than a 20px min-height, so the row still grew whenever a day actually had
                    // icons — a min-height only binds when content is smaller than it, never
                    // caps content that's larger. Height 32 + overflow hidden makes this row's
                    // height constant regardless of whether today has 0 icons or several.
                    <div className="flex items-center gap-1.5 mt-0.5" style={{ height: 32, overflow: 'hidden' }}>
                      {(() => {
                        const details = balanceSpend.dayDetails?.(activeBsPoint.date)
                        if (!details) return null
                        return (
                          <>
                            {details.netAmount !== 0 && (
                              <span className="text-xs text-[var(--color-ink-muted)] shrink-0">
                                £{Math.round(Math.abs(details.netAmount)).toLocaleString('en-GB')} {details.netAmount > 0 ? 'IN' : 'OUT'}:
                              </span>
                            )}
                            {details.icons.map((ic) => (
                              <span key={ic.key}>{ic.node}</span>
                            ))}
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
                <p className="text-lg font-mono font-semibold text-[var(--color-ink)] shrink-0">
                  £{formatCurrency(activeBsPoint ? activeBsPoint.value : view === 'balance' ? bsSeries?.balance[bsSeries.balance.length - 1]?.clearedBalance ?? 0 : bsSeries?.spend[bsSeries.spend.length - 1]?.spendToDate ?? 0)}
                </p>
              </div>

              <div className="w-full">
                {bsSeries ? (
                  <BalanceSpendChart series={bsSeries} view={view} color={color} interactive height={220} onActivePointChange={setActiveBsPoint} />
                ) : (
                  <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">No data for this account yet.</p>
                )}
              </div>

              {!balanceSpend.fixedRange && (
                <div className="w-full flex items-center justify-between gap-2">
                  <SegmentedControl fullWidth options={BALANCE_SPEND_GRANULARITY_OPTIONS} value={bsGranularity} onChange={(g) => { setBsGranularity(g); setActiveBsPoint(null) }} />
                </div>
              )}
            </>
          )}

          {savingsPot && spSeries && (
            <>
              <div className="w-full rounded-2xl p-3" style={activePillPoint ? { background: 'var(--color-bg)' } : undefined} data-testid="trend-tooltip">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-[var(--color-ink)]">{activePillPoint ? activePillPoint.tooltipLabel : cardName}</span>
                  <span className="text-lg font-mono font-semibold text-[var(--color-ink)]">
                    £{formatCurrency(activePillPoint ? activePillPoint.endBalance : spSeries.points[spSeries.points.length - 1]?.endBalance ?? 0)}
                  </span>
                </div>
                {/* Always rendered at a fixed height, active or not (Adam, 2026-09-16: the box's
                    height must not change) — the net headline and the small gross in/out
                    sub-label share ONE non-wrapping row, so any period, including one with both a
                    deposit and a withdrawal, fits the same box. The in/out figures are what name
                    a drop's cause (PROMPT-04 Bug B); individual transactions are deliberately
                    not listed. */}
                <div className="flex items-baseline justify-between gap-2 whitespace-nowrap overflow-hidden" style={{ height: 16 }}>
                  {activePillPoint && (
                    <>
                      {/* Styled like the other cards' "£X IN/OUT" tooltip label (Adam, 2026-09-16):
                          muted capitalised text, with only the arrow coloured. Pence kept, unlike the
                          line chart's whole pounds, because pot movements are often small. */}
                      <span className="text-xs text-[var(--color-ink-muted)] truncate flex items-center gap-1">
                        {activePillPoint.netChange < 0 ? (
                          <>
                            <ArrowDown size={12} className="shrink-0" style={{ color: 'var(--color-coral)' }} aria-hidden />
                            £{formatCurrency(Math.abs(activePillPoint.netChange))} OUT
                          </>
                        ) : activePillPoint.netChange > 0 ? (
                          <>
                            <ArrowUp size={12} className="shrink-0" style={{ color: 'var(--color-positive)' }} aria-hidden />
                            £{formatCurrency(activePillPoint.netChange)} SAVED
                          </>
                        ) : (
                          'No change'
                        )}
                      </span>
                      {(activePillPoint.moneyIn > 0 || activePillPoint.moneyOut > 0) && (
                        <span className="text-[10px] font-mono text-[var(--color-ink-faint)] shrink-0">
                          £{formatCurrency(activePillPoint.moneyIn)} in · £{formatCurrency(activePillPoint.moneyOut)} out
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="w-full">
                <SavingsPotPillChart series={spSeries} color={color} interactive height={160} onActivePointChange={setActivePillPoint} />
              </div>

              <div className="w-full flex items-center justify-between gap-2">
                <SegmentedControl fullWidth options={SAVINGS_POT_GRANULARITY_OPTIONS} value={spGranularity} onChange={(g) => { setSpGranularity(g); setActivePillPoint(null) }} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The Trends section's inline, non-interactive preview — small chart +
 * headline figure + a "View trends" affordance. Tapping anywhere in the
 * section (or the button) opens the full TrendsModal for this card.
 */
/** Category icons + net signed movement for whatever ledger-eligible transactions landed on `dateIso` — the Balance/Spend chart tooltip's requirement (icons per the prompt doc; the net "£X IN/OUT" figure per the reference screenshots, shown left of the icons). */
function dayDetailsForDay(transactions: Transaction[], categories: AppDataV2['categories'], dateIso: string): { icons: { key: string; node: ReactNode }[]; netAmount: number } {
  const dayTx = transactions.filter((t) => t.date === dateIso && isLedgerTransaction(t))
  // One icon per CATEGORY, not per transaction (Adam, 2026-09-17): three
  // shops on the same day used to show the same icon three times, which says
  // nothing the first one didn't. Keyed by category so the row stays a
  // distinct list; first occurrence wins, so the order still follows the
  // day's own transaction order. An uncategorised row (no matching category)
  // collapses under one key for the same reason.
  const icons = distinctByCategory(dayTx).map((t) => {
    const category = categories.find((c) => c.id === t.categoryId)
    return { key: t.categoryId || 'uncategorised', node: <CategoryIcon category={category} size={16} /> }
  })
  const netAmount = dayTx.reduce((sum, t) => sum + signedAmount(t), 0)
  return { icons, netAmount }
}

function TrendPreview({
  cardName,
  color,
  caption,
  balanceSpend,
  savingsPot,
}: {
  cardName: string
  color: string
  caption: string
  balanceSpend?: {
    buildSeries: (granularity: BalanceSpendGranularity) => BalanceSpendTrendSeries | null
    dayDetails?: (dateIso: string) => { icons: { key: string; node: ReactNode }[]; netAmount: number }
    /**
     * One range, balance only — a loan card (PROMPT-08a Part C: "balance
     * view only... a single time range: all time"). Hides both the
     * Balance/Spend toggle and the This cycle / Next 3 cycles control,
     * since neither means anything for a series that always covers the
     * loan's whole life. `buildSeries` is still called, and simply
     * ignores the granularity it is handed.
     */
    fixedRange?: boolean
  }
  savingsPot?: { buildSeries: (granularity: SavingsPotPillGranularity) => SavingsPotTrendSeries }
}) {
  const [open, setOpen] = useState(false)
  const previewSeries = balanceSpend ? balanceSpend.buildSeries('this_cycle') : null
  const previewPillSeries = savingsPot ? savingsPot.buildSeries('this_cycle') : null

  // Trend-indicator caption: compares this cycle's spend-to-date against the
  // same relative day last cycle (the one comparison the data layer already
  // computes, via `previousPeriodSpend` — there's no previous-period BALANCE
  // series today, so this reads spend trajectory rather than balance
  // trajectory even on a card whose headline above is a balance figure).
  // Falls back to the caller's own static caption when there's no prior
  // cycle to compare against yet (new account, or a card with no
  // balanceSpend comparison data at all, e.g. Savings Pot).
  let displayCaption = caption
  if (previewSeries && previewSeries.previousPeriodSpend.length > 0) {
    const idx = previewSeries.days.indexOf(previewSeries.todayIso)
    const current = previewSeries.spend[idx]?.spendToDate
    const previous = previewSeries.previousPeriodSpend[idx]?.spendToDate
    if (current != null && previous != null) {
      const delta = Math.round(current - previous)
      if (delta !== 0) {
        displayCaption = `Tracking £${Math.abs(delta).toLocaleString('en-GB')} ${delta > 0 ? 'more' : 'less'} than last cycle`
      }
    }
  }

  return (
    <>
      {/* Whole section is the tap target ("the card is the button", per Adam's own
          entry-point spec) — the "View trends" pill below the chart is a visual
          affordance matching the reference mockup, not a second independent control,
          so this stays a single <button> rather than nesting one inside the other. */}
      <button onClick={() => setOpen(true)} className="w-full text-left">
        <h3 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-1">Trends</h3>
        <p className="text-xs text-[var(--color-ink-faint)] mb-2">{displayCaption}</p>
        <div className="pointer-events-none">
          {previewSeries ? (
            <BalanceSpendChart series={previewSeries} view="balance" color={color} height={64} />
          ) : previewPillSeries ? (
            <SavingsPotPillChart series={previewPillSeries} color={color} height={48} />
          ) : null}
        </div>
        <div
          className="w-full mt-3 flex items-center justify-center gap-1.5 text-xs font-semibold uppercase tracking-wide"
          style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)', borderRadius: 12, padding: '9px 0' }}
        >
          <TrendingUp size={13} />
          View trends
        </div>
      </button>
      {open && <TrendsModal cardName={cardName} color={color} balanceSpend={balanceSpend} savingsPot={savingsPot} onClose={() => setOpen(false)} />}
    </>
  )
}

function ToggleSwitch({
  label,
  checked,
  onChange,
  help,
  full,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  /** 2026-09-13 (deck controls cleanup) — a short helper caption under the label, only used in the `full` (FiltersSheet row) layout. */
  help?: string
  /** 2026-09-13 (deck controls cleanup) — the full-width "settings row" layout FiltersSheet uses (label + optional help on the left, a slightly larger switch on the right), instead of the compact inline label+switch pair used elsewhere on this page. */
  full?: boolean
  /** 2026-09-13 follow-up (Adam-specified) — greyed out and non-interactive when the current Group by/Order by selection makes this control inapplicable, rather than hiding the row outright. `full` layout only. */
  disabled?: boolean
}) {
  if (full) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className="w-full flex items-center justify-between gap-3 text-left"
        style={{ opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-[var(--color-ink)]">{label}</span>
          {help && <span className="text-[11px] text-[var(--color-ink-muted)]">{help}</span>}
        </span>
        <span
          className="relative inline-block rounded-full transition-colors shrink-0"
          style={{ width: 38, height: 22, background: checked ? 'var(--color-coral)' : 'var(--color-track)' }}
        >
          <span
            className="absolute rounded-full bg-white transition-transform"
            style={{ width: 18, height: 18, top: 2, left: 2, transform: checked ? 'translateX(16px)' : 'translateX(0)', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }}
          />
        </span>
      </button>
    )
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-[11px] font-medium"
      style={{ color: 'var(--color-ink-muted)' }}
    >
      <span>{label}</span>
      <span
        className="relative inline-block rounded-full transition-colors shrink-0"
        style={{ width: 34, height: 20, background: checked ? 'var(--color-coral)' : 'var(--color-track)' }}
      >
        <span
          className="absolute rounded-full bg-white transition-transform"
          style={{ width: 16, height: 16, top: 2, left: 2, transform: checked ? 'translateX(14px)' : 'translateX(0)', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }}
        />
      </span>
    </button>
  )
}

function CycleToggle({ value, onChange }: { value: ProjectionHorizon; onChange: (v: ProjectionHorizon) => void }) {
  return (
    <div className="flex gap-1.5">
      {(['current_cycle', 'three_cycles'] as ProjectionHorizon[]).map((h) => (
        <button
          key={h}
          onClick={() => onChange(h)}
          className="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors"
          style={{ background: value === h ? 'var(--color-coral)' : 'var(--color-surface)', color: value === h ? '#fff' : 'var(--color-ink-muted)' }}
        >
          {HORIZON_LABELS[h]}
        </button>
      ))}
    </div>
  )
}

function TransactionRow({
  t,
  data,
  runningBalance,
  amountSign,
}: {
  t: Transaction
  data: AppDataV2
  runningBalance?: number
  // Overrides the default personal-ledger sign (direction-derived) for
  // contexts where the SAME transaction reads the opposite way — the
  // joint account's own ledger, where a joint_deposit is a positive even
  // though it's an 'out' on the depositing person's own personal ledger.
  // See jointAccountLedger.ts's jointAccountSignedAmount. Defaults to the
  // ordinary personal convention everywhere else, so every existing call
  // site is unaffected.
  amountSign?: (t: Transaction) => number
}) {
  const category = data.categories.find((c) => c.id === t.categoryId)
  const potOrSavingsPot = iconPotOrSavingsPotFor(t, data)
  const potIconCategory = potOrSavingsPot
    ? { icon: potOrSavingsPot.categoryIcon ?? DEFAULT_POT_CATEGORY_ICON, iconColor: potOrSavingsPot.categoryIconColor ?? DEFAULT_POT_CATEGORY_ICON_COLOR }
    : undefined
  const signed = amountSign ? amountSign(t) : signedAmount(t)
  const isPositive = signed > 0
  return (
    <div className="flex items-center gap-3 py-2">
      <CategoryIcon category={potIconCategory ?? category} size={14} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] truncate">{t.note || category?.name || t.type}</p>
        <p className="text-[11px] text-[var(--color-ink-muted)]">
          {t.date}
          {/* Both states are labelled explicitly, not just pending. Once
              cleared rows sit in the same cycle sections as pending ones
              (cycle-end totals view), an unlabelled row reads as "no
              status" rather than "cleared". Cleared carries the heavier
              weight so the two stay legible at a glance in a mixed
              section. */}
          {t.status === 'pending' && ' · Pending'}
          {t.status === 'cleared' && (
            <>
              {' · '}
              <span className="font-semibold text-[var(--color-ink)]">Cleared</span>
            </>
          )}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-mono font-semibold" style={{ color: isPositive ? 'var(--color-positive)' : 'var(--color-ink)' }}>
          {isPositive ? '+' : '-'}£{formatCurrency(Math.abs(signed))}
        </p>
        {runningBalance !== undefined && <p className="text-[10px] text-[var(--color-ink-faint)] tabular-nums">£{formatCurrency(runningBalance)}</p>}
      </div>
    </div>
  )
}

/**
 * 2026-09-13 (dev.md item 2, Adam-specified) — "Group by direction":
 * splits whatever set of rows it's given into two independently
 * expandable/collapsible pills, Incoming and Outgoing. Both pills
 * default to COLLAPSED (2026-09-13 follow-up, Adam-specified: turning
 * the toggle on should surface the incoming/outgoing SUBTOTALS, not
 * dump every individual transaction on screen) — each pill's header
 * always shows its own running total regardless of expand state, so the
 * subtotal is visible immediately either way; expanding one is an
 * explicit further step to see its rows. Each pill's own rows are
 * always ordered by date regardless of the page's "Order by" setting —
 * Adam's own spec says the revealed rows are "ordered by date," and a
 * direction split has no obviously meaningful "by amount" ordering of
 * its own. Generic over the row shape so it can sit inside
 * CycleGroupedList/DateOrderedList (real Transactions) AND
 * SavingsPotCycleGroupedList/SavingsPotDetail's flat list (synthetic
 * SavingsPotScheduleRow) and the credit-card equivalents, without
 * duplicating this rendering four times over.
 */
function DirectionGroupedRows<T>({
  items,
  isIncoming,
  amountOf,
  dateOf,
  keyOf,
  renderRow,
  incomingLabel = 'Incoming',
  outgoingLabel = 'Outgoing',
}: {
  items: T[]
  isIncoming: (item: T) => boolean
  /** Always a positive magnitude — sign is implied by which pill it's in, not read from here. */
  amountOf: (item: T) => number
  dateOf: (item: T) => string
  keyOf: (item: T) => string
  renderRow: (item: T) => ReactNode
  incomingLabel?: string
  outgoingLabel?: string
}) {
  const [collapsed, setCollapsed] = useState<Set<'in' | 'out'>>(() => new Set(['in', 'out']))
  const toggle = (which: 'in' | 'out') =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(which)) next.delete(which)
      else next.add(which)
      return next
    })

  const incoming = items.filter(isIncoming).slice().sort((a, b) => dateOf(a).localeCompare(dateOf(b)))
  const outgoing = items.filter((i) => !isIncoming(i)).slice().sort((a, b) => dateOf(a).localeCompare(dateOf(b)))
  const incomingTotal = incoming.reduce((sum, i) => sum + amountOf(i), 0)
  const outgoingTotal = outgoing.reduce((sum, i) => sum + amountOf(i), 0)

  function Pill({ which, label, total, rows }: { which: 'in' | 'out'; label: string; total: number; rows: T[] }) {
    const expanded = !collapsed.has(which)
    return (
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--color-bg)' }}>
        <button onClick={() => toggle(which)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left">
          <span className="flex items-center gap-1.5 min-w-0">
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            <span className="text-xs font-semibold text-[var(--color-ink)] truncate">{label}</span>
          </span>
          <span className="text-xs font-mono font-semibold tabular-nums shrink-0" style={{ color: which === 'in' ? 'var(--color-positive)' : 'var(--color-ink-muted)' }}>
            {which === 'in' ? '+' : '-'}£{formatCurrency(total)}
          </span>
        </button>
        {expanded && (
          <div className="px-3 pb-2 flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
            {rows.map((r) => (
              <div key={keyOf(r)}>{renderRow(r)}</div>
            ))}
            {rows.length === 0 && <p className="text-[11px] text-[var(--color-ink-muted)] text-center py-2">Nothing {label.toLowerCase()}.</p>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Pill which="in" label={incomingLabel} total={incomingTotal} rows={incoming} />
      <Pill which="out" label={outgoingLabel} total={outgoingTotal} rows={outgoing} />
    </div>
  )
}

/** Compact "14 Sep" style label for cycle boundary dates — parsed as local, never via Date.toISOString, per the app's timezone rule. */
function formatCycleDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/**
 * The date-ordered list, split into one collapsible section per pay
 * cycle in the horizon, each closing with the projected balance at that
 * cycle's end.
 *
 * The running balance is ONE continuous fold across every section, not a
 * per-section restart: a cycle's closing figure is the balance carried
 * out of it, so it has to include everything before it. That's also why
 * a section's subtotal is the running balance on its LAST row rather
 * than the sum of its own rows — those are different numbers, and only
 * the former answers "what will I actually have on the 13th".
 *
 * Cleared rows are folded into the running-balance fold and each
 * section's closing total the same as pending ones, so those figures
 * stay correct regardless of `showCleared` — it only controls whether
 * cleared rows are rendered as individual lines within an expanded
 * section (Summary-page-wide toggle, off by default; see
 * DateOrderedList's own comment). `section.rows` (used for the
 * fold/closing balance above) therefore stays the full set always; only
 * `visibleRows`, computed per section below at render time, respects the
 * toggle.
 *
 * Sections with no VISIBLE rows are still shown: an empty cycle (or one
 * whose only activity has already cleared, with the toggle off) is
 * meaningful information, and dropping it would make the horizon look
 * shorter than it is. Its subtotal is simply the balance carried in from
 * the previous cycle (or folded through whatever cleared automatically).
 */

/** 2026-09-13 (average spend forecast) — the row-shaped item DirectionGroupedRows folds a cycle's real transactions AND its (at most one) synthetic forecast row into, so the forecast row can sit inside the "Outgoing" pill alongside real expenses rather than needing its own separate treatment. */
type CycleRowItem = { kind: 'real'; t: Transaction; running: number } | { kind: 'forecast'; forecastAmount: number; realSpend: number; cycleEndIso: string }

/**
 * 2026-09-13 (average spend forecast, Adam-specified) — "a completely
 * different design to normal ledger rows", not a `TransactionRow` (this
 * isn't a real `Transaction` and shouldn't be forced into that shape).
 * The icon badge is deliberately the INVERSE of `CategoryIcon`'s own
 * treatment — a solid-filled coral circle with the glyph drawn in the
 * page's own background colour, so it reads as a cutout through the
 * fill rather than a coloured-icon-on-neutral-circle. Dashed outline +
 * italic muted label reinforce "this is an estimate, not a real entry."
 * The "Reduced from £X" caption only appears once the reduction
 * actually did something (`realSpend > 0`) — otherwise it's just noise
 * ("Reduced from £0" says nothing true).
 */
function ProjectedSpendRow({ forecastAmount, realSpend, runningBalance }: { forecastAmount: number; realSpend: number; runningBalance?: number }) {
  const averagePerCycle = round2(forecastAmount + realSpend)
  return (
    <div className="flex items-center gap-3 py-2 px-2 my-1 rounded-xl" style={{ border: '1px dashed var(--color-ink-faint)' }}>
      <span className="inline-flex items-center justify-center shrink-0 rounded-full" style={{ width: 30, height: 30, background: 'var(--color-coral)' }}>
        <TrendingUp size={14} strokeWidth={2} style={{ color: 'var(--color-bg)' }} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm italic" style={{ color: 'var(--color-ink-muted)' }}>
          Average spend forecast
        </p>
        {realSpend > 0 && (
          <p className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
            Reduced from £{formatCurrency(averagePerCycle)} · estimate
          </p>
        )}
      </div>
      <div className="text-right shrink-0">
        <span className="text-sm font-mono font-semibold" style={{ color: 'var(--color-ink-muted)' }}>
          -£{formatCurrency(forecastAmount)}
        </span>
        {/* 2026-09-14 (This-cycle horizon fix) — DateOrderedList's flat
            view has no cycle-section header to surface a closing balance
            the way CycleGroupedList's does, so this row carries its own,
            same caption style TransactionRow already gives every real
            row. Omitted (as before) inside CycleGroupedList, where the
            section header already shows it. */}
        {runningBalance !== undefined && <p className="text-[10px] text-[var(--color-ink-faint)] tabular-nums">£{formatCurrency(runningBalance)}</p>}
      </div>
    </div>
  )
}

/**
 * 2026-09-14 (Joint's "Group by Person," Adam-specified redesign) —
 * nested inside CycleGroupedList's own per-cycle body exactly like
 * DirectionGroupedRows is for "Group by direction" (see that component's
 * own comment) — this is what actually flips Joint's person split from
 * person-outer/cycle-inner (the old JointPersonGroupedList, now removed)
 * to cycle-outer/person-inner, matching the direction view's own shape:
 * a cycle expands to reveal each person's own pill, and a person's pill
 * expands to reveal their individual transactions.
 *
 * `groups` is scoped to just ONE cycle's already-visible rows (built via
 * `buildJointPersonGroups(data, section.visibleRows...)` at the call
 * site) — unlike DirectionGroupedRows' fixed Incoming/Outgoing pair,
 * the person list varies (2+ people, plus the unattributed "Spend"
 * bucket) and an empty bucket for THIS cycle specifically is just noise,
 * so empty groups are dropped entirely rather than shown with a "Nothing
 * here" placeholder each.
 *
 * 2026-09-16 (PROMPT-03) — renamed from JointPersonPills: Household's
 * "Group by Person" now renders through this too (fed by
 * householdLedger.ts's buildHouseholdPersonGroups instead), so the two
 * cards share ONE grouping implementation — a change here must be
 * checked on both. `amountSign` is whatever CycleGroupedList itself folds
 * with (jointAccountSignedAmount for Joint, signedAmount for Household),
 * so a pill's total always uses the same sign as the cycle around it.
 * Each pill's figure is that person's NET for this one cycle, not a
 * running balance.
 */
function PersonPills({ groups, data, amountSign }: { groups: (JointPersonGroup | HouseholdPersonGroup)[]; data: AppDataV2; amountSign: (t: Transaction) => number }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const nonEmpty = groups.filter((g) => g.transactions.length > 0)

  return (
    <div className="flex flex-col gap-1.5">
      {nonEmpty.map((group) => {
        const expanded = !collapsed.has(group.id)
        const total = round2(group.transactions.reduce((sum, t) => sum + amountSign(t), 0))
        const ordered = group.transactions.slice().sort(compareByDateSalaryFirst)
        return (
          <div key={group.id} className="rounded-xl overflow-hidden" style={{ background: 'var(--color-bg)' }}>
            <button onClick={() => toggle(group.id)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left">
              <span className="flex items-center gap-1.5 min-w-0">
                {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                <span className="text-xs font-semibold text-[var(--color-ink)] truncate">{group.name}</span>
              </span>
              <span className="text-xs font-mono font-semibold tabular-nums shrink-0" style={{ color: total >= 0 ? 'var(--color-positive)' : 'var(--color-ink-muted)' }}>
                {total >= 0 ? '+' : '-'}£{formatCurrency(Math.abs(total))}
              </span>
            </button>
            {expanded && (
              <div className="px-3 pb-2 flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
                {ordered.map((t) => (
                  <TransactionRow key={t.id} t={t} data={data} amountSign={amountSign} />
                ))}
              </div>
            )}
          </div>
        )
      })}
      {nonEmpty.length === 0 && <p className="text-[11px] text-[var(--color-ink-muted)] text-center py-2">Nothing in this cycle.</p>}
    </div>
  )
}

function CycleGroupedList({
  transactions,
  data,
  openingRunningBalance,
  cycles,
  showCleared,
  amountSign,
  groupByDirection,
  groupByPerson,
  buildPersonGroups,
  forecastByCycle,
}: {
  transactions: Transaction[]
  data: AppDataV2
  openingRunningBalance: number
  cycles: { start: Date; end: Date }[]
  showCleared: boolean
  amountSign?: (t: Transaction) => number
  groupByDirection?: boolean
  /** 2026-09-14 (Joint's "Group by Person," cycle-outer/person-inner redesign) — mutually exclusive with groupByDirection at the FiltersSheet level (Joint's own "Group by" pills only ever select one of List/Category/Person, and Direction is its own independent toggle only offered while grouping is List+Date). When on, each expanded cycle's body renders PersonPills instead of a flat/direction-split row list — see that component's own comment. Joint and (2026-09-16, PROMPT-03) Household; every other caller omits this entirely. */
  groupByPerson?: boolean
  /** Splits ONE cycle's visible rows into person pills while groupByPerson is on. Defaults to Joint's own buildJointPersonGroups (payee shares + "Spend"); Household passes buildHouseholdPersonGroups. */
  buildPersonGroups?: (rows: Transaction[]) => (JointPersonGroup | HouseholdPersonGroup)[]
  /** 2026-09-13 (average spend forecast) — one entry per FUTURE cycle that needs a synthetic forecast row, keyed by that cycle's own start date (ISO). Personal/Joint only; every other caller omits this entirely. See buildForecastByCycle's own comment. */
  forecastByCycle?: Map<string, { forecastAmount: number; realSpend: number }>
}) {
  const sign = amountSign ?? signedAmount
  // Collapse state tracks what's explicitly been TOGGLED away from its
  // default, so the default (every cycle collapsed, or expanded while
  // groupByDirection is on — see below) holds without seeding state per
  // cycle — including for a cycle that first appears mid-session as the
  // horizon rolls forward.
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  // 2026-09-13 (follow-up, Adam-specified) — turning "Group by direction"
  // on should surface the incoming/outgoing SUBTOTALS straight away,
  // which live inside each cycle's own expanded body — so every cycle
  // auto-expands the moment the toggle switches on (and any per-cycle
  // override a person made is dropped, so the toggle always produces a
  // clean, fully-expanded state rather than a confusing mix). The
  // DirectionGroupedRows pills nested inside default back to COLLAPSED
  // themselves (their own header still always shows the subtotal), so
  // this doesn't dump every individual transaction on screen. 2026-09-14:
  // same reasoning extended to groupByPerson — the two are mutually
  // exclusive (see groupByPerson's own comment) but share this effect.
  useEffect(() => {
    setToggled(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupByDirection, groupByPerson])
  const toggle = (key: string) =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // The fold runs over the whole window first, in one pass, so every
  // section's figures come from the same sequence regardless of what's
  // expanded — collapsing a section must not change any number.
  const ordered = transactions.slice().sort(compareByDateSalaryFirst)
  let running = openingRunningBalance
  const withRunning = ordered.map((t) => {
    running += sign(t)
    return { t, running }
  })

  let carried = openingRunningBalance
  const sections = cycles.map((cycle, i) => {
    const startIso = toLocalIsoDate(cycle.start)
    const endIso = toLocalIsoDate(cycle.end)
    // Every section, INCLUDING the first/current one, is bounded on both
    // ends by its own cycle window for DISPLAY purposes — a stored
    // transaction dated before the current cycle's start (but after the
    // opening balance date) is real ledger history, but it isn't part of
    // "this cycle" and showing it there was a reported bug (2026-09-14,
    // Adam: "extends beyond the bounds of the cycle... shows transactions
    // and payments from before the cycle's window", worse the longer it's
    // been since the account was last rebalanced). Its effect on the
    // BALANCE is still fully accounted for below via `upToEnd`, which
    // isn't lower-bounded — only the rendered row list is.
    const rows = withRunning.filter(({ t }) => t.date >= startIso && t.date <= endIso)
    // Balance carried OUT of this cycle — the running figure of the LAST
    // transaction dated on/before this cycle's end, cumulative across the
    // whole window regardless of this section's own display bound (so an
    // empty-looking current cycle still correctly reflects older history
    // that landed between the opening balance date and its own start),
    // or, if there's no transaction at all yet, whatever came in from the
    // cycle before.
    const upToEnd = withRunning.filter(({ t }) => t.date <= endIso)
    const realClosing = upToEnd.length > 0 ? upToEnd[upToEnd.length - 1].running : carried
    // 2026-09-13 (average spend forecast) — a forecast row for this
    // cycle (if any) reduces its closing balance by its own forecast
    // amount, same as a real expense would — and that ADJUSTED figure
    // is what carries forward into every later cycle's own opening
    // point, so the projected balance genuinely reflects it rather than
    // being a purely cosmetic row.
    const forecast = forecastByCycle?.get(startIso)
    const closing = forecast ? round2(realClosing - forecast.forecastAmount) : realClosing
    carried = closing
    // Respects the "Show cleared" toggle — computed here, AFTER `closing`
    // above already folded every row (cleared included), so this can
    // never change the balance figures, only which rows render.
    const visibleRows = rows.filter(({ t }) => showCleared || t.status !== 'cleared')
    return { key: startIso, isCurrent: i === 0, startIso, endIso, rows, visibleRows, closing, forecast }
  })

  return (
    <div className="flex flex-col gap-2">
      {sections.map((section) => {
        // Every cycle collapsed by default — except while "Group by
        // direction" (or, 2026-09-14, "Group by person") is on, when
        // every cycle auto-expands instead (see the useEffect above), so
        // its nested subtotal pills are visible without an extra manual
        // tap per cycle.
        const expanded = groupByDirection || groupByPerson ? !toggled.has(section.key) : toggled.has(section.key)
        return (
          <div key={section.key} className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-bg)' }}>
            <button onClick={() => toggle(section.key)} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left">
              <span className="flex items-center gap-1.5 min-w-0">
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                <span className="text-xs font-semibold text-[var(--color-ink)] truncate">
                  {section.isCurrent ? 'Current cycle' : `${formatCycleDate(section.startIso)} – ${formatCycleDate(section.endIso)}`}
                </span>
              </span>
              {/* The header carries no figures while expanded — the
                  subtotal row below is the one place the number lives, so
                  it can't be read twice and disagree. Collapsed, the
                  section's whole point would otherwise be hidden, so the
                  closing balance surfaces here instead. */}
              {!expanded && (
                <span className="text-xs font-mono font-semibold tabular-nums shrink-0" style={{ color: 'var(--color-ink-muted)' }}>
                  £{formatCurrency(section.closing)}
                </span>
              )}
            </button>

            {expanded && (
              <div className="px-3 pb-1">
                {groupByPerson ? (
                  <PersonPills groups={(buildPersonGroups ?? ((rows) => buildJointPersonGroups(data, rows)))(section.visibleRows.map(({ t }) => t))} data={data} amountSign={sign} />
                ) : groupByDirection ? (
                  <DirectionGroupedRows<CycleRowItem>
                    items={[
                      ...section.visibleRows.map((r): CycleRowItem => ({ kind: 'real', t: r.t, running: r.running })),
                      ...(section.forecast ? [{ kind: 'forecast' as const, forecastAmount: section.forecast.forecastAmount, realSpend: section.forecast.realSpend, cycleEndIso: section.endIso }] : []),
                    ]}
                    isIncoming={(item) => item.kind === 'real' && (amountSign ? amountSign(item.t) : signedAmount(item.t)) > 0}
                    amountOf={(item) => (item.kind === 'real' ? Math.abs(amountSign ? amountSign(item.t) : signedAmount(item.t)) : item.forecastAmount)}
                    dateOf={(item) => (item.kind === 'real' ? item.t.date : item.cycleEndIso)}
                    keyOf={(item) => (item.kind === 'real' ? item.t.id : 'forecast')}
                    renderRow={(item) => (item.kind === 'real' ? <TransactionRow t={item.t} data={data} amountSign={amountSign} /> : <ProjectedSpendRow forecastAmount={item.forecastAmount} realSpend={item.realSpend} />)}
                  />
                ) : (
                  <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
                    {section.visibleRows.map(({ t, running }) => (
                      <TransactionRow key={t.id} t={t} data={data} runningBalance={running} amountSign={amountSign} />
                    ))}
                    {section.visibleRows.length === 0 && !section.forecast && (
                      <p className="text-[11px] text-[var(--color-ink-muted)] text-center py-3">Nothing in this cycle.</p>
                    )}
                    {/* Always the LAST line in the cycle, regardless of date — Adam's own explicit requirement (see PROMPT-average-spend-forecast-toggle-2026-09-13.md). */}
                    {section.forecast && <ProjectedSpendRow forecastAmount={section.forecast.forecastAmount} realSpend={section.forecast.realSpend} />}
                  </div>
                )}
                <div
                  className="flex items-center justify-between pt-2 pb-2 mt-1 border-t"
                  style={{ borderColor: 'var(--color-track)' }}
                >
                  <span className="text-[11px] font-medium text-[var(--color-ink-muted)]">
                    Balance at {formatCycleDate(section.endIso)}
                  </span>
                  <span className="text-sm font-mono font-semibold tabular-nums text-[var(--color-ink)]">£{formatCurrency(section.closing)}</span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The list-by-date view. Cleared payments are hidden by default (the
 * "Show cleared" toggle, off by default) — they're still fully counted
 * in every balance figure regardless of the toggle: the fold below
 * starts from `openingRunningBalance` (the pay cycle's true anchor, not
 * a cleared-only shortcut) and runs over EVERY transaction, cleared
 * included, in date order — exactly the same fold CycleGroupedList does
 * — so a running balance shown against a visible row is correct whether
 * or not the cleared rows before it are currently on screen. Only
 * `visible`, computed after the fold, respects the toggle for display.
 */
function DateOrderedList({
  transactions,
  data,
  openingRunningBalance,
  showCleared,
  amountSign,
  groupByDirection,
  forecast,
  forecastEndIso,
  cycleStartIso,
  cycleEndIso,
}: {
  transactions: Transaction[]
  data: AppDataV2
  openingRunningBalance: number
  showCleared: boolean
  amountSign?: (t: Transaction) => number
  groupByDirection?: boolean
  /**
   * 2026-09-16 (Adam-reported — same bug as 758aeed's CycleGroupedList/
   * SavingsPotCycleGroupedList fix, just never applied here): this is the
   * "This cycle" horizon's own flat list (CycleGroupedList renders instead
   * once "Next 3 cycles"/Cycle-end totals is active) — `transactions` isn't
   * lower-bounded by the caller (a stored row between the account's
   * opening-balance date and this cycle's own start is still needed for the
   * RUNNING BALANCE fold below), so with Show cleared on, every cleared
   * transaction since the account's last rebalance rendered here, not just
   * this cycle's own. Optional purely so a caller with no real cycle concept
   * to bound by (none currently) doesn't have to invent one; every real
   * caller now passes it.
   */
  cycleStartIso?: string
  /** The last cycle end (2026-09-17, Adam-reported): without it, a row dated after the horizon (e.g. another household member whose own pay cycle ends later) showed here but not in CycleGroupedList. */
  cycleEndIso?: string
  /**
   * 2026-09-14 (Adam-reported, "This cycle" horizon) — the average spend
   * forecast used to only ever appear inside CycleGroupedList, which
   * requires Cycle-end totals to be applicable (horizon: 'three_cycles').
   * Under the "This cycle" toggle there's exactly one cycle and this flat
   * view renders instead — the forecast previously vanished there
   * entirely, even though the caption above it (PersonalDetail/
   * JointDetail's own "£X now · £Y projected") already correctly
   * subtracted it. Optional so every other DateOrderedList caller
   * (Household/Pot/Savings Pot/Credit Card, none of which have this
   * feature) is unaffected.
   */
  forecast?: { forecastAmount: number; realSpend: number }
  /** The forecast's own sort/group key — the current cycle's end date, same "always sorts as the last thing in the period" convention CycleGroupedList's own forecast row uses. Required whenever `forecast` is passed. */
  forecastEndIso?: string
}) {
  const sign = amountSign ?? signedAmount
  // Salary first within its own date (see compareByDateSalaryFirst) — the
  // running balance below is a fold in list order, so a bill sorted above
  // the salary that funds it would show a dip that never really happens.
  const ordered = transactions.slice().sort(compareByDateSalaryFirst)

  let running = openingRunningBalance
  const withRunning = ordered.map((t) => {
    running += sign(t)
    return { t, running }
  })
  const visible = withRunning.filter(({ t }) => (showCleared || t.status !== 'cleared') && (!cycleStartIso || t.date >= cycleStartIso) && (!cycleEndIso || t.date <= cycleEndIso))
  const hasForecast = !!forecast && forecast.forecastAmount > 0
  const finalRunning = visible.length > 0 ? visible[visible.length - 1].running : openingRunningBalance

  if (groupByDirection) {
    return (
      <DirectionGroupedRows<CycleRowItem>
        items={[
          ...visible.map((r): CycleRowItem => ({ kind: 'real', t: r.t, running: r.running })),
          ...(hasForecast ? [{ kind: 'forecast' as const, forecastAmount: forecast.forecastAmount, realSpend: forecast.realSpend, cycleEndIso: forecastEndIso! }] : []),
        ]}
        isIncoming={(item) => item.kind === 'real' && sign(item.t) > 0}
        amountOf={(item) => (item.kind === 'real' ? Math.abs(sign(item.t)) : item.forecastAmount)}
        dateOf={(item) => (item.kind === 'real' ? item.t.date : item.cycleEndIso)}
        keyOf={(item) => (item.kind === 'real' ? item.t.id : 'forecast')}
        renderRow={(item) => (item.kind === 'real' ? <TransactionRow t={item.t} data={data} amountSign={amountSign} /> : <ProjectedSpendRow forecastAmount={item.forecastAmount} realSpend={item.realSpend} />)}
      />
    )
  }

  return (
    <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
      {visible.map(({ t, running }) => (
        <TransactionRow key={t.id} t={t} data={data} runningBalance={running} amountSign={amountSign} />
      ))}
      {visible.length === 0 && !hasForecast && (
        <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">
          {showCleared ? 'Nothing in this window.' : 'Nothing pending in this window.'}
        </p>
      )}
      {/* Always the LAST line, regardless of date — same convention
          CycleGroupedList's own forecast row uses. */}
      {hasForecast && <ProjectedSpendRow forecastAmount={forecast.forecastAmount} realSpend={forecast.realSpend} runningBalance={round2(finalRunning - forecast.forecastAmount)} />}
    </div>
  )
}

/** Respects the "Show cleared" toggle (off by default); this list has no separate calculation to preserve, so it's simply a filter before sorting. */
function AmountOrderedList({
  transactions,
  data,
  showCleared,
  amountSign,
}: {
  transactions: Transaction[]
  data: AppDataV2
  showCleared: boolean
  amountSign?: (t: Transaction) => number
}) {
  const sorted = transactions
    .filter((t) => showCleared || t.status !== 'cleared')
    .slice()
    .sort((a, b) => b.amount - a.amount)
  return (
    <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
      {sorted.map((t) => (
        <TransactionRow key={t.id} t={t} data={data} amountSign={amountSign} />
      ))}
      {sorted.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">Nothing in this window.</p>}
    </div>
  )
}

/**
 * Respects the "Show cleared" toggle (off by default) for BOTH the row
 * listing and the per-category total/heading figure — `visibleItems`,
 * filtered once per group up front, is the one source both the total and
 * the rows are built from, so a category never shows a total that
 * includes money the person can't see a row for. A group whose every
 * item has cleared, with the toggle off, simply doesn't render — nothing
 * left to show a total FOR — rather than surfacing an empty section with
 * a nonzero header.
 */
function CategoryGroupedList({
  transactions,
  data,
  showCleared,
  amountSign,
}: {
  transactions: Transaction[]
  data: AppDataV2
  showCleared: boolean
  amountSign?: (t: Transaction) => number
}) {
  const sign = amountSign ?? ((t: Transaction) => (t.direction === 'in' ? t.amount : -t.amount))
  // Collapse state is tracked as the set of groups explicitly COLLAPSED,
  // not the set expanded — so expanded stays the default for every group,
  // including any that appears for the first time part-way through a
  // session (a new category, or one whose first transaction has just been
  // generated) without needing to seed state for it.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const groups = new Map<string, Transaction[]>()
  for (const t of transactions) {
    const key = groupingCategoryId(t)
    const list = groups.get(key) ?? []
    list.push(t)
    groups.set(key, list)
  }
  const sortedGroups = Array.from(groups.entries())
    .map(([groupKey, items]) => {
      const visibleItems = items.filter((t) => showCleared || t.status !== 'cleared')
      const total = visibleItems.reduce((s, t) => s + sign(t), 0)
      return { groupKey, visibleItems, total }
    })
    .filter((g) => g.visibleItems.length > 0)
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))

  return (
    <div className="flex flex-col gap-3">
      {sortedGroups.map(({ groupKey, visibleItems, total }) => {
        const potMatch = groupKey.startsWith('pot:') ? data.pots.find((p) => p.id === groupKey.slice(4)) : undefined
        const savingsPotMatch = groupKey.startsWith('savingspot:') ? data.savingsPots.find((p) => p.id === groupKey.slice(11)) : undefined
        const potOrSavingsPot = potMatch ?? savingsPotMatch
        const category = potOrSavingsPot ? undefined : data.categories.find((c) => c.id === groupKey)
        // The Loans/Credit Card buckets fall back to their own name even
        // if the underlying category record has been renamed away from
        // it, or (for the Borrowing bucket, which is an ordinary deletable
        // seeded category rather than a protected built-in) deleted
        // outright — the bucket itself is still meaningful either way.
        // A Pot/SavingsPot bucket falls back to "Uncategorised" only if
        // the pot itself has since been deleted (its own transactions
        // still exist in the window) — same reasoning, a different case.
        const fallbackName = groupKey === LOANS_GROUP_CATEGORY_ID ? 'Loans' : groupKey === CREDIT_CARD_CATEGORY_ID ? 'Credit Card' : groupKey === JOINT_ACCOUNT_GROUP_CATEGORY_ID ? 'Joint Account' : 'Uncategorised'
        // A Pot/SavingsPot's own chosen icon (CategoryIconPickerModal),
        // falling back to the shared generic pot icon if none was ever
        // picked — see potOrSavingsPot's own comment on categoryIcon.
        const potIconCategory = potOrSavingsPot
          ? { icon: potOrSavingsPot.categoryIcon ?? DEFAULT_POT_CATEGORY_ICON, iconColor: potOrSavingsPot.categoryIconColor ?? DEFAULT_POT_CATEGORY_ICON_COLOR }
          : undefined
        const isCollapsed = collapsed.has(groupKey)
        return (
          <div key={groupKey}>
            <button onClick={() => toggleGroup(groupKey)} className="w-full flex items-center gap-2 mb-1 text-left">
              <CategoryIcon category={potIconCategory ?? category} size={13} />
              <span className="text-xs font-semibold text-[var(--color-ink)] flex-1">
                {potOrSavingsPot?.name ?? category?.name ?? fallbackName}
                {isCollapsed && <span className="font-normal text-[var(--color-ink-faint)]"> · {visibleItems.length}</span>}
              </span>
              <span className="text-xs font-mono" style={{ color: total >= 0 ? 'var(--color-positive)' : 'var(--color-negative)' }}>
                {total >= 0 ? '+' : '-'}£{formatCurrency(Math.abs(total))}
              </span>
              {isCollapsed ? <ChevronDown size={13} className="text-[var(--color-ink-faint)]" /> : <ChevronUp size={13} className="text-[var(--color-ink-faint)]" />}
            </button>
            {!isCollapsed && (
              <div className="flex flex-col divide-y pl-6" style={{ borderColor: 'var(--color-track)' }}>
                {visibleItems.map((t) => (
                  <TransactionRow key={t.id} t={t} data={data} amountSign={amountSign} />
                ))}
              </div>
            )}
          </div>
        )
      })}
      {sortedGroups.length === 0 && (
        <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">
          {showCleared ? 'Nothing in this window.' : 'Nothing pending in this window.'}
        </p>
      )}
    </div>
  )
}

function PersonalDetail({
  data,
  horizon,
  grouping,
  order,
  cycleTotals,
  showCleared,
  groupByDirection,
  averageSpendForecast,
}: {
  data: AppDataV2
  horizon: ProjectionHorizon
  grouping: Grouping
  order: Order
  cycleTotals: boolean
  showCleared: boolean
  groupByDirection?: boolean
  averageSpendForecast?: boolean
}) {
  const payCycle = data.payCycles.find((pc) => pc.personId === data.primaryPersonId)
  if (!payCycle) return null

  const projection = computeProjection(data, data.primaryPersonId, payCycle, horizon)
  const ledgerTxns = projection.transactions.filter(isLedgerTransaction)
  // 2026-09-18 (Adam-reported) — the trend tooltip's category icons read
  // from a projection of their own, ALWAYS over the widest range the chart
  // can show (three cycles), never the page's horizon pill.
  //
  // The bug: the chart's This cycle / Next 3 cycles switch is the modal's
  // own, independent of the pill. With the pill on "This cycle" (the
  // default) and the chart on "Next 3 cycles", the line ran three cycles
  // out while the icons came from a one-cycle projection — so every day
  // past the current cycle's end had no icons at all. Adam saw them stop
  // dead around 4 Oct.
  //
  // A three-cycle projection is a strict superset of the one-cycle one
  // (same generators, wider range), so it serves both chart states, and
  // `dayDetailsForDay` filters to the exact date anyway. Reuses the
  // existing projection when the pill already says three cycles, so the
  // common case costs nothing extra.
  const trendIconTxns = horizon === 'three_cycles' ? projection.transactions : computeProjection(data, data.primaryPersonId, payCycle, 'three_cycles').transactions
  // Same helper computeProjection's own horizon end comes from, so the
  // sections tile the window exactly — no gap at either edge, and the
  // final section's closing balance is the projected balance by
  // construction rather than by coincidence.
  const cycles = horizonCycles(data, data.primaryPersonId, horizon, new Date())
  const forecastByCycle = averageSpendForecast ? buildForecastByCycle(data, { location: 'personal', ownerId: data.primaryPersonId }, data.primaryPersonId, cycles) : undefined
  // 2026-09-14 — the caption's "projected" figure has to match
  // CycleGroupedList's own final closing balance below it, which already
  // folds every cycle's forecast (including the current one) in.
  const forecastTotal = forecastByCycle ? [...forecastByCycle.values()].reduce((sum, f) => sum + f.forecastAmount, 0) : 0
  const displayedProjectedBalance = round2(projection.projectedBalance - forecastTotal)

  return (
    <div className="flex flex-col gap-4">
      <HomeSection>
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">Personal</h2>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">
          £{formatCurrency(projection.clearedBalance)} now · £{formatCurrency(displayedProjectedBalance)} projected · {HORIZON_LABELS[horizon].toLowerCase()}
        </p>

        {grouping === 'category' ? (
          <CategoryGroupedList transactions={inCycleWindow(ledgerTxns, cycles)} data={data} showCleared={showCleared} />
        ) : order === 'amount' ? (
          <AmountOrderedList transactions={inCycleWindow(ledgerTxns, cycles)} data={data} showCleared={showCleared} />
        ) : cycleTotals ? (
          <CycleGroupedList
            transactions={ledgerTxns}
            data={data}
            openingRunningBalance={projection.openingBalance}
            cycles={cycles}
            showCleared={showCleared}
            groupByDirection={groupByDirection}
            forecastByCycle={forecastByCycle}
          />
        ) : (
          <DateOrderedList
            transactions={ledgerTxns}
            data={data}
            openingRunningBalance={projection.openingBalance}
            showCleared={showCleared}
            groupByDirection={groupByDirection}
            cycleStartIso={toLocalIsoDate(cycles[0].start)}
            cycleEndIso={toLocalIsoDate(cycles[cycles.length - 1].end)}
            forecast={forecastByCycle?.get(toLocalIsoDate(cycles[0].start))}
            forecastEndIso={toLocalIsoDate(cycles[0].end)}
          />
        )}
      </HomeSection>

      <HomeSection>
        <TrendPreview
          cardName="Personal"
          color="var(--color-coral)"
          caption="Today's balance"
          balanceSpend={{
            buildSeries: (g) => buildPersonalTrendSeries(data, data.primaryPersonId, payCycle, g, new Date()),
            dayDetails: (d) => dayDetailsForDay(trendIconTxns, data.categories, d),
          }}
        />
      </HomeSection>

      {/* PROMPT-08a Part C — the per-loan rings have MOVED to each loan's
          own hero card; only the combined total stays here (Adam: "individual
          loan pie charts move off the personal card. The combined total pie
          chart stays on the personal card"). `individualRings={false}` is
          what does that; the Joint and Household callers are unchanged, since
          the loans they show belong to other people and so have no card of
          their own to move to. */}
      {data.loans.some((l) => l.location === 'personal' && l.ownerId === data.primaryPersonId && l.active) && (
        <CollapsiblePieSection>
          <LoanProgressRingsSection
            data={data}
            horizon={horizon}
            loans={data.loans.filter((l) => l.location === 'personal' && l.ownerId === data.primaryPersonId && l.active)}
            horizonEndDate={parseLocalDate(projection.horizonEnd)}
            individualRings={false}
          />
        </CollapsiblePieSection>
      )}
    </div>
  )
}

// ── Trends feature (2026-09-15 build) ──────────────────────────────────
// Extracted per the build plan: every `*Detail` function used to wrap its
// ENTIRE output (heading, balance caption, ledger list, AND the ring
// breakdown where applicable) in one shared `rounded-3xl p-5` div,
// duplicated inline across all 6 call sites. Splitting the combined card
// into three independently-backgrounded sections (Ledger, Trends, Pie
// Charts) needs that wrapper three times per card instead of once, so
// it's pulled out here rather than tripling the duplication.
function HomeSection({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-3xl p-5 ${className}`} style={{ background: 'var(--color-surface)' }}>
      {children}
    </div>
  )
}

/**
 * Every hero card's Pie Charts section, collapsible and COLLAPSED BY
 * DEFAULT — PROMPT-08a Part C, and deliberately a global change across all
 * of them (Personal, Joint, Household, Savings Pot, Credit Card and the
 * per-loan cards), not just the loan ones: "Every pie chart on every hero
 * card becomes collapsible, collapsed by default."
 *
 * The collapsed state is per-instance and starts closed on every render of
 * a card, which is the intent — "collapsed by default" is the default
 * every time you arrive at a card, not a preference to remember. That also
 * keeps it consistent with CategoryGroupedList's own collapse state, which
 * is likewise per-instance and not persisted.
 */
function CollapsiblePieSection({ title = 'Progress chart', children }: { title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <HomeSection>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-left"
        aria-expanded={open}
        aria-label={open ? `Hide ${title.toLowerCase()}` : `Show ${title.toLowerCase()}`}
      >
        <span className="font-body text-sm font-semibold text-[var(--color-ink)]">{title}</span>
        {open ? <ChevronUp size={16} className="text-[var(--color-ink-muted)]" /> : <ChevronDown size={16} className="text-[var(--color-ink-muted)]" />}
      </button>
      {open && <div className="mt-4">{children}</div>}
    </HomeSection>
  )
}

function LoanProgressRingsSection({
  data,
  horizon,
  loans,
  horizonEndDate,
  individualRings = true,
}: {
  data: AppDataV2
  horizon: ProjectionHorizon
  /**
   * PROMPT-08a Part C — false on the Personal card, where each loan now has
   * its own hero card carrying its own ring, so only the combined total
   * belongs here. Joint/Household keep their per-loan rings: those loans
   * can belong to other household members, who have no card in this deck.
   */
  individualRings?: boolean
  // Which loans this instance covers — Personal: this person's own
  // personal-location loans; Household: EVERY household member's
  // personal-location loans (Adam-specified, 2026-09-03: "Household pie
  // charts are personal loans only"); Joint: joint-location loans only
  // ("Joint account pie charts are joint account loans only"). Callers
  // decide the filter; this component just renders whatever it's given.
  loans: Loan[]
  horizonEndDate: Date
}) {
  // REDESIGN (Adam-specified, 2026-09-02): savings pots no longer show
  // ANYWHERE inside Personal's own card — including this ring, which
  // used to trigger for any pot with a targetAmount set. The pie-ring
  // treatment for a target now lives entirely inside that pot's OWN
  // deck-card detail (SavingsPotDetail, below) — same component
  // (ProgressRing), just moved to where it actually belongs per Adam's
  // own original spec wording: "shows... on the home page SAVINGS
  // card," not the personal one. This section is loans-only again.
  if (loans.length === 0) return null

  // Only the "Next 3 cycles" view shows a projected segment at all — "This
  // cycle" stays exactly the plain paid-so-far/saved-so-far ring it always
  // was. `horizonEndDate` is the right future point to project against —
  // callers pass whichever horizon-end applies to their own context
  // (a person's own projection, or the joint account's own).
  const showProjection = horizon === 'three_cycles'

  // Two genuinely different, both-legitimate loan figures (see
  // summarizeLoanProgress's own comment): `totalPaid`/`nominalRemaining`
  // is "how much cash will I ever hand over on this loan, including
  // interest not yet accrued" — the headline figure here, by explicit
  // request, since it's what a person budgeting against their real
  // monthly outgoings wants to see first. `capitalRemaining` (true
  // amortised principal — what a bank app's own "balance" figure shows)
  // is still shown, just demoted to a smaller, clearly-separate line, so
  // neither figure is lost or silently conflated with the other. The
  // ring itself fills by CASH progress (percentPaid), matching whichever
  // number is headlined, not by principal progress.
  const loanProgress = loans.map((loan) => summarizeLoanProgress(loan))
  const totalLoansBalance = loanProgress.reduce((sum, p) => sum + p.totalBalance, 0)
  const totalLoansPaid = loanProgress.reduce((sum, p) => sum + p.totalPaid, 0)
  const totalLoansNominalRemaining = loanProgress.reduce((sum, p) => sum + p.nominalRemaining, 0)
  const totalLoansCapitalRemaining = loanProgress.reduce((sum, p) => sum + p.capitalRemaining, 0)
  const totalLoansPercentPaid = totalLoansBalance > 0 ? Math.min(100, (totalLoansPaid / totalLoansBalance) * 100) : 0

  // Projected progress as of the horizon's end date — reusing
  // summarizeLoanProgress with a future asOfDate rather than re-deriving
  // anything from the projection's generated transactions:
  // buildLoanSchedule already bakes in every scheduled payment, one-off
  // overpayment, AND standing recurring overpayment between now and
  // then, regardless of "today", so this is exactly "where the loan will
  // genuinely be."
  const projectedLoanProgress = showProjection ? loans.map((loan) => summarizeLoanProgress(loan, horizonEndDate)) : null
  const totalLoansProjectedPaid = projectedLoanProgress?.reduce((sum, p) => sum + p.totalPaid, 0) ?? totalLoansPaid
  const totalLoansProjectedPercent = totalLoansBalance > 0 ? Math.min(100, (totalLoansProjectedPaid / totalLoansBalance) * 100) : 0
  const totalLoansProjectedNominalRemaining = projectedLoanProgress?.reduce((sum, p) => sum + p.nominalRemaining, 0) ?? totalLoansNominalRemaining
  const totalLoansProjectedCapitalRemaining = projectedLoanProgress?.reduce((sum, p) => sum + p.capitalRemaining, 0) ?? totalLoansCapitalRemaining

  return (
    // Trends feature (2026-09-15 build) — this used to open with `mt-5
    // pt-5 border-t`, a separator from whatever ledger content sat above
    // it in the same combined card. Now it's always the sole content of
    // its own collapsible "Progress chart" section (CollapsiblePieSection,
    // see every *Detail caller), so that top border/margin would just
    // leave a stray line at the top of an otherwise-empty card — dropped.
    <div className="flex flex-col gap-5">
      {loans.length > 0 && (
        <div>
          {/* No "Loans" sub-heading on ANY card (Adam, 2026-09-18). The
              collapsible section above is already titled "Progress chart",
              so a second heading immediately inside it only repeats what
              the person just tapped to open. */}
          <div className="flex flex-col items-center gap-5">
            {(individualRings ? loans : []).map((loan, i) => {
              const progress = loanProgress[i]
              const projected = projectedLoanProgress?.[i]
              const category = data.categories.find((c) => c.id === loan.categoryId)
              return (
                <div key={loan.id} className="flex flex-col items-center gap-1">
                  <ProgressRing
                    percent={progress.percentPaid}
                    projectedPercent={projected?.percentPaid}
                    value={`£${formatCurrency(progress.totalPaid)}`}
                    label={loan.name}
                    size={110}
                    strokeWidth={10}
                    icon={<CategoryIcon category={category} size={22} />}
                  />
                  <p className="text-[11px] text-[var(--color-ink-faint)]">
                    of £{formatCurrency(progress.totalBalance)} · {progress.percentPaid.toFixed(0)}
                    {showProjection && projected ? `→${projected.percentPaid.toFixed(0)}` : ''}% paid
                  </p>
                  {/* Next 3 cycles: every figure shown alongside its
                      projected counterpart (arrow notation, actual→projected)
                      rather than replacing the actual figure outright —
                      This Cycle view is untouched, showing only today's
                      real numbers, same as before. */}
                  <p className="text-[11px] text-[var(--color-ink-muted)]">
                    £{formatCurrency(progress.nominalRemaining)}
                    {showProjection && projected && (
                      <span style={{ color: 'var(--color-coral)' }}> → £{formatCurrency(projected.nominalRemaining)}</span>
                    )}{' '}
                    remaining
                  </p>
                  <p className="text-[10px] text-[var(--color-ink-faint)]">
                    £{formatCurrency(progress.capitalRemaining)}
                    {showProjection && projected && (
                      <span style={{ color: 'var(--color-coral)' }}> → £{formatCurrency(projected.capitalRemaining)}</span>
                    )}{' '}
                    capital owed
                  </p>
                  {showProjection && projected && (
                    <p className="text-[10px]" style={{ color: 'var(--color-coral)' }}>
                      by {HORIZON_LABELS[horizon].toLowerCase()}
                    </p>
                  )}
                </div>
              )
            })}

            {/* With the individual rings hidden (Personal card), the combined
                ring shows even for a single loan — it is the only ring left,
                and "the combined total stays on the personal card" holds
                whether there is one loan or five. Its separator only makes
                sense when there are rings above it to separate from. */}
            {(individualRings ? loans.length > 1 : loans.length > 0) && (
              <div
                className={`flex flex-col items-center gap-1 w-full${individualRings ? ' pt-5 mt-1 border-t' : ''}`}
                style={{ borderColor: 'var(--color-track)' }}
              >
                <ProgressRing
                  percent={totalLoansPercentPaid}
                  projectedPercent={showProjection ? totalLoansProjectedPercent : undefined}
                  value={`£${formatCurrency(totalLoansPaid)}`}
                  label="Total Loans"
                  size={160}
                  strokeWidth={14}
                  icon={<Layers size={28} strokeWidth={1.75} />}
                />
                <p className="text-[11px] text-[var(--color-ink-faint)]">
                  of £{formatCurrency(totalLoansBalance)} · {totalLoansPercentPaid.toFixed(0)}
                  {showProjection ? `→${totalLoansProjectedPercent.toFixed(0)}` : ''}% paid
                </p>
                <p className="text-[11px] text-[var(--color-ink-muted)]">
                  £{formatCurrency(totalLoansNominalRemaining)}
                  {showProjection && <span style={{ color: 'var(--color-coral)' }}> → £{formatCurrency(totalLoansProjectedNominalRemaining)}</span>} remaining
                </p>
                <p className="text-[10px] text-[var(--color-ink-faint)]">
                  £{formatCurrency(totalLoansCapitalRemaining)}
                  {showProjection && <span style={{ color: 'var(--color-coral)' }}> → £{formatCurrency(totalLoansProjectedCapitalRemaining)}</span>} capital owed
                </p>
                {showProjection && (
                  <p className="text-[10px]" style={{ color: 'var(--color-coral)' }}>
                    by {HORIZON_LABELS[horizon].toLowerCase()}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function JointDetail({
  data,
  horizon,
  grouping,
  order,
  cycleTotals,
  showCleared,
  groupByDirection,
  averageSpendForecast,
}: {
  data: AppDataV2
  horizon: ProjectionHorizon
  grouping: Grouping
  order: Order
  cycleTotals: boolean
  showCleared: boolean
  groupByDirection?: boolean
  averageSpendForecast?: boolean
}) {
  // BUGFIX (Adam-reported, 2026-09 session) — this used to also compute
  // an old flat per-item `summary` list (computeJointSummary) and render
  // it ABOVE the real ledger below, under a "This cycle (dates)" line and
  // a duplicate set of section headers — a second, less capable ledger
  // (no cycle-end totals, no category icons, didn't respect Show
  // Cleared) sitting on top of the real one. Removed entirely; the real
  // ledger below is the only one now, formatted exactly like Personal's
  // own detail card (title, straight into the list — no extra summary
  // line or "Real ledger" heading in between).
  const jointProjection = computeJointAccountProjection(data, horizon)
  // Same fix as PersonalDetail's `trendIconTxns` — see its comment there.
  const trendIconTxns = (horizon === 'three_cycles' ? jointProjection : computeJointAccountProjection(data, 'three_cycles'))?.transactions ?? []
  const cycles = horizonCycles(data, data.primaryPersonId, horizon, new Date())
  // Cycle boundaries borrow the primary person's own pay cycle — there's
  // no independent "joint pay cycle" concept in this app, same anchor
  // computeJointAccountProjection's own cycles use.
  const forecastByCycle = averageSpendForecast ? buildForecastByCycle(data, { location: 'joint' }, data.primaryPersonId, cycles) : undefined
  const forecastTotal = forecastByCycle ? [...forecastByCycle.values()].reduce((sum, f) => sum + f.forecastAmount, 0) : 0
  const displayedProjectedBalance = jointProjection ? round2(jointProjection.projectedBalance - forecastTotal) : 0

  const jointLoans = data.loans.filter((l) => l.location === 'joint' && l.active)

  return (
    <div className="flex flex-col gap-4">
      <HomeSection>
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">Joint</h2>

        {!jointProjection ? (
          <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">No joint account set up yet.</p>
        ) : (
          <>
          <p className="text-xs text-[var(--color-ink-faint)] mb-4">
            £{formatCurrency(jointProjection.clearedBalance)} now · £{formatCurrency(displayedProjectedBalance)} projected · {HORIZON_LABELS[horizon].toLowerCase()}
          </p>
          {grouping === 'person' ? (
            // 2026-09-14 (Adam-specified redesign) — cycle-outer,
            // person-inner, same shape as "Group by direction": always
            // routes through CycleGroupedList regardless of `order`/
            // `cycleTotals`, exactly like `grouping === 'category'`
            // below already ignores those two — Person grouping is now
            // its own fixed view, not a further order/totals choice.
            <CycleGroupedList
              transactions={jointProjection.transactions}
              data={data}
              openingRunningBalance={jointProjection.openingBalance}
              cycles={cycles}
              showCleared={showCleared}
              amountSign={jointAccountSignedAmount}
              groupByPerson
            />
          ) : grouping === 'category' ? (
            <CategoryGroupedList transactions={inCycleWindow(jointProjection.transactions, cycles)} data={data} showCleared={showCleared} amountSign={jointAccountSignedAmount} />
          ) : order === 'amount' ? (
            <AmountOrderedList transactions={inCycleWindow(jointProjection.transactions, cycles)} data={data} showCleared={showCleared} amountSign={jointAccountSignedAmount} />
          ) : cycleTotals ? (
            <CycleGroupedList
              transactions={jointProjection.transactions}
              data={data}
              openingRunningBalance={jointProjection.openingBalance}
              cycles={cycles}
              showCleared={showCleared}
              amountSign={jointAccountSignedAmount}
              groupByDirection={groupByDirection}
              forecastByCycle={forecastByCycle}
            />
          ) : (
            <DateOrderedList
              transactions={jointProjection.transactions}
              data={data}
              openingRunningBalance={jointProjection.openingBalance}
              showCleared={showCleared}
              amountSign={jointAccountSignedAmount}
              groupByDirection={groupByDirection}
              cycleStartIso={toLocalIsoDate(cycles[0].start)}
              cycleEndIso={toLocalIsoDate(cycles[cycles.length - 1].end)}
              forecast={forecastByCycle?.get(toLocalIsoDate(cycles[0].start))}
              forecastEndIso={toLocalIsoDate(cycles[0].end)}
            />
          )}
          </>
        )}
      </HomeSection>

      {jointProjection && (
        <HomeSection>
          <TrendPreview
            cardName="Joint"
            /* JUDGMENT CALL: --color-joint (#fdfdfd, near-white) is this
               app's existing BankCard BACKGROUND tint for Joint, not a
               usable chart-line colour — it would be invisible on the
               dark chart surface. --color-positive (existing accent,
               otherwise used for "money in"/gains) is used instead so
               Joint's trend reads as visually distinct from Personal's
               coral, without inventing a brand-new colour token. */
            color="var(--color-positive)"
            caption="Today's balance"
            balanceSpend={{
              buildSeries: (g) => buildJointTrendSeries(data, g, new Date()),
              dayDetails: (d) => dayDetailsForDay(trendIconTxns, data.categories, d),
            }}
          />
        </HomeSection>
      )}

      {/* "Joint account pie charts are joint account loans only" (Adam,
          2026-09-03) — joint-location loans, regardless of who's the
          nominal payee. Doc note: the 2026-09-15 prompt doc's own research
          missed that Joint already renders this ring today (it only listed
          Personal/Household as LoanProgressRingsSection's callers) — this
          Pie Charts section is included here because the doc's own GENERAL
          rule ("only render where a ring already renders today") says so,
          even though its specific enumeration list omitted Joint. */}
      {jointProjection && jointLoans.length > 0 && (
        <CollapsiblePieSection>
          <LoanProgressRingsSection data={data} horizon={horizon} loans={jointLoans} horizonEndDate={parseLocalDate(jointProjection.horizonEnd)} />
        </CollapsiblePieSection>
      )}
    </div>
  )
}

/**
 * Pots backlog item, Phase 7 (2026-09 session) — "It's ledger should
 * match the same style as the Personal swipe card, in that I can see
 * this cycle / next 3 cycles, and all other group by / sort by features,
 * with the same default settings and layout as Personal. There should be
 * no pie chart" (Adam's spec, verbatim). Structurally this is
 * PersonalDetail's own dispatch-to-the-shared-list-components pattern,
 * fed by computePotProjection instead of computeProjection, with
 * potSignedAmount passed as the amountSign override the same way
 * JointDetail passes jointAccountSignedAmount — see potSignedAmount's own
 * comment in potLedger.ts for why a pot needs its own sign function
 * rather than the generic one. Deliberately has NO LoanProgressRingsSection
 * — that section IS the pie chart Adam explicitly excluded, and it would
 * otherwise apply cleanly (a pot can fund a loan's regular payment).
 */
function PotDetail({
  pot,
  data,
  horizon,
  grouping,
  order,
  cycleTotals,
  showCleared,
  groupByDirection,
}: {
  pot: Pot
  data: AppDataV2
  horizon: ProjectionHorizon
  grouping: Grouping
  order: Order
  cycleTotals: boolean
  showCleared: boolean
  groupByDirection?: boolean
}) {
  const projection = computePotProjection(data, pot, horizon, new Date())
  // Same fix as PersonalDetail's `trendIconTxns` — see its comment there.
  const trendIconTxns = horizon === 'three_cycles' ? projection.transactions : computePotProjection(data, pot, 'three_cycles', new Date()).transactions
  const cycles = horizonCycles(data, pot.personId, horizon, new Date())

  return (
    <div className="flex flex-col gap-4">
      <HomeSection>
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">{pot.name}</h2>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">
          £{formatCurrency(projection.clearedBalance)} now · £{formatCurrency(projection.projectedBalance)} projected · {HORIZON_LABELS[horizon].toLowerCase()}
        </p>

        {grouping === 'category' ? (
          <CategoryGroupedList transactions={inCycleWindow(projection.transactions, cycles)} data={data} showCleared={showCleared} amountSign={potSignedAmount} />
        ) : order === 'amount' ? (
          <AmountOrderedList transactions={inCycleWindow(projection.transactions, cycles)} data={data} showCleared={showCleared} amountSign={potSignedAmount} />
        ) : cycleTotals ? (
          <CycleGroupedList
            transactions={projection.transactions}
            data={data}
            openingRunningBalance={projection.openingBalance}
            cycles={cycles}
            showCleared={showCleared}
            amountSign={potSignedAmount}
            groupByDirection={groupByDirection}
          />
        ) : (
          <DateOrderedList
            transactions={projection.transactions}
            data={data}
            openingRunningBalance={projection.openingBalance}
            showCleared={showCleared}
            amountSign={potSignedAmount}
            groupByDirection={groupByDirection}
            cycleStartIso={toLocalIsoDate(cycles[0].start)}
            cycleEndIso={toLocalIsoDate(cycles[cycles.length - 1].end)}
          />
        )}
      </HomeSection>

      <HomeSection>
        <TrendPreview
          cardName={pot.name}
          color={pot.color}
          caption="Today's balance"
          balanceSpend={{
            buildSeries: (g) => buildPotTrendSeries(data, pot, g, new Date()),
            dayDetails: (d) => dayDetailsForDay(trendIconTxns, data.categories, d),
          }}
        />
      </HomeSection>

      {/* No Pie Charts section for Pot (bills pot) — Adam-specified,
          verbatim in this card's own header comment above: "There should
          be no pie chart." Unchanged by the Trends split. */}
    </div>
  )
}

function HouseholdDetail({
  data,
  horizon,
  grouping,
  order,
  cycleTotals,
  showCleared,
  groupByDirection,
}: {
  data: AppDataV2
  horizon: ProjectionHorizon
  grouping: Grouping
  order: Order
  cycleTotals: boolean
  showCleared: boolean
  groupByDirection?: boolean
}) {
  // Personal-only (Adam-specified, 2026-09-03): "Household card should
  // not include joint bills at all. This is a summary of each person's
  // personal bills and transactions." No joint content of any kind shows
  // here any more — the joint account's own real ledger lives entirely on
  // the Joint card instead (see JointDetail above). The only
  // joint-account-related items that DO appear here are joint_deposit/
  // joint_withdrawal transactions, which arrive automatically since
  // they're ordinary personal-location rows on whichever person made
  // them — see householdLedger.ts's own header comment.
  const personProjections = computeHouseholdProjections(data, horizon)
  const missingCount = data.people.length - personProjections.length

  const combinedTransactions = personProjections.flatMap((pp) => pp.transactions)
  // Same fix as PersonalDetail's `trendIconTxns` — see its comment there.
  const trendIconTxns = horizon === 'three_cycles' ? combinedTransactions : computeHouseholdProjections(data, 'three_cycles').flatMap((pp) => pp.transactions)
  const combinedOpeningBalance = personProjections.reduce((sum, pp) => sum + pp.openingBalance, 0)
  const combinedClearedBalance = personProjections.reduce((sum, pp) => sum + pp.clearedBalance, 0)
  const combinedProjectedBalance = personProjections.reduce((sum, pp) => sum + pp.projectedBalance, 0)
  // Combined single fold in date order, same as the personal card's own
  // running balance — Adam's own spec for the ungrouped view. No single
  // "correct" cycle boundary exists once two people can have different
  // pay cycles, so this reuses the primary person's own cycle bounds,
  // same established convention the rest of this file already leans on
  // for a household-wide window (e.g. the original Joint card's hero).
  const combinedCycles = horizonCycles(data, data.primaryPersonId, horizon, new Date())

  // "Household pie charts are personal loans only" (Adam, 2026-09-03) —
  // every household member's OWN personal-location loans, not just the
  // primary person's (unlike Personal's own ring section, which is
  // deliberately scoped to just the viewer).
  const householdLoans = data.loans.filter((l) => l.location === 'personal' && l.active && data.people.some((p) => p.id === l.ownerId))
  const householdHorizonEnd = combinedCycles[combinedCycles.length - 1].end

  return (
    <div className="flex flex-col gap-4">
      <HomeSection>
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">Household</h2>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">
          £{formatCurrency(combinedClearedBalance)} now · £{formatCurrency(combinedProjectedBalance)} projected · {HORIZON_LABELS[horizon].toLowerCase()}
        </p>
        <div className="flex flex-col gap-1.5 mb-1">
          {personProjections.map((pp) => (
            <div key={pp.personId} className="flex items-center justify-between text-sm py-1">
              <span className="text-[var(--color-ink-muted)]">{pp.personName}</span>
              <span className="font-mono text-[var(--color-ink)]">£{formatCurrency(pp.clearedBalance)}</span>
            </div>
          ))}
        </div>
        {missingCount > 0 && (
          <p className="text-xs text-[var(--color-ink-faint)] mt-2">
            {missingCount} {missingCount === 1 ? "person doesn't" : "people don't"} have a pay cycle set up yet, so they're left out of this total.
          </p>
        )}
        <p className="text-xs text-[var(--color-ink-faint)] mt-2 mb-4">Each person's own personal bills and transactions — no joint bills here; see the Joint card for those.</p>

        {grouping === 'person' ? (
          // 2026-09-16 (PROMPT-03) — cycle-outer, person-inner, the same
          // shape and the same component Joint uses (see JointDetail):
          // replaces the old person-outer PersonGroupedList. Like Joint,
          // it ignores `order`/`cycleTotals` — Person grouping is its own
          // fixed view. Cycles are the combined list's own (primary
          // person's) cycles, so each cycle's person pills sum to exactly
          // what the ungrouped cycle-totals view shows for that cycle.
          <CycleGroupedList
            transactions={combinedTransactions}
            data={data}
            openingRunningBalance={combinedOpeningBalance}
            cycles={combinedCycles}
            showCleared={showCleared}
            groupByPerson
            buildPersonGroups={(rows) => buildHouseholdPersonGroups(personProjections, rows)}
          />
        ) : grouping === 'category' ? (
          <CategoryGroupedList transactions={inCycleWindow(combinedTransactions, combinedCycles)} data={data} showCleared={showCleared} />
        ) : order === 'amount' ? (
          <AmountOrderedList transactions={inCycleWindow(combinedTransactions, combinedCycles)} data={data} showCleared={showCleared} />
        ) : cycleTotals ? (
          <CycleGroupedList
            transactions={combinedTransactions}
            data={data}
            openingRunningBalance={combinedOpeningBalance}
            cycles={combinedCycles}
            showCleared={showCleared}
            groupByDirection={groupByDirection}
          />
        ) : (
          <DateOrderedList transactions={combinedTransactions} data={data} openingRunningBalance={combinedOpeningBalance} showCleared={showCleared} groupByDirection={groupByDirection} cycleStartIso={toLocalIsoDate(combinedCycles[0].start)} cycleEndIso={toLocalIsoDate(combinedCycles[combinedCycles.length - 1].end)} />
        )}
      </HomeSection>

      <HomeSection>
        <TrendPreview
          cardName="Household"
          color="var(--color-coral)"
          caption="Combined balance today"
          balanceSpend={{
            buildSeries: (g) => buildHouseholdTrendSeries(data, g, new Date()),
            dayDetails: (d) => dayDetailsForDay(trendIconTxns, data.categories, d),
          }}
        />
      </HomeSection>

      {householdLoans.length > 0 && (
        <CollapsiblePieSection>
          <LoanProgressRingsSection data={data} horizon={horizon} loans={householdLoans} horizonEndDate={householdHorizonEnd} />
        </CollapsiblePieSection>
      )}
    </div>
  )
}

function ordinalSuffix(day: number): string {
  if (day % 10 === 1 && day !== 11) return 'st'
  if (day % 10 === 2 && day !== 12) return 'nd'
  if (day % 10 === 3 && day !== 13) return 'rd'
  return 'th'
}

// PROMPT-01 Part B (2026-09-16) — typed to the fields this row actually
// reads, not `Transaction`, so it can render a GENERATED pending minimum
// charge (a projection with no Transaction.id) exactly like a real stored
// row. See the flat `activity` list below for why those now appear here.
type CardActivityItem = {
  id: string
  date: string
  type: 'credit_card_spend' | 'credit_card_payment'
  amount: number
  status: 'cleared' | 'pending'
  note?: string
}

function CardActivityRow({ t }: { t: CardActivityItem }) {
  const isSpend = t.type === 'credit_card_spend'
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm text-[var(--color-ink)]">{t.note || (isSpend ? 'Spend' : 'Payment')}</p>
        <p className="text-[11px] text-[var(--color-ink-muted)]">
          {t.date}
          {t.status === 'pending' ? ' · Pending' : ''}
        </p>
      </div>
      <p className="text-sm font-mono font-semibold" style={{ color: isSpend ? 'var(--color-negative)' : 'var(--color-positive)' }}>
        {isSpend ? '+' : '-'}£{formatCurrency(t.amount)}
      </p>
    </div>
  )
}

/**
 * UAT 2026-09-08 (Summary page cycle-end totals, Adam-specified) — the
 * credit-card equivalent of CycleGroupedList above, one section per this
 * card's OWN accounting period (creditCardCyclePeriods/
 * buildCreditCardCycleSections), each closing with the real balance DUE
 * on that period's own payment date — not a running-balance fold (which
 * would silently miss interest, since interest posts with no
 * transaction row of its own). Same "every cycle collapsed by default,
 * current cycle labelled specially" shape as CycleGroupedList, for
 * visual consistency between the two.
 */
function CreditCardCycleGroupedList({
  sections,
  showCleared,
  groupByDirection,
}: {
  sections: CreditCardCycleSection[]
  showCleared: boolean
  groupByDirection?: boolean
}) {
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  // 2026-09-13 — see CycleGroupedList's identical effect for the full
  // reasoning: every cycle auto-expands while "Group by direction" is
  // on, so its nested Payments/Spend subtotal pills are visible without
  // an extra manual tap per cycle.
  useEffect(() => {
    setToggled(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupByDirection])
  const toggle = (key: string) =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  function renderCardCycleRow(r: CreditCardCycleSection['rows'][number]) {
    const isSpend = r.type === 'credit_card_spend'
    const isMinimumCharge = r.type === 'credit_card_payment' && !r.sourceType
    return (
      <div className="flex items-center justify-between py-2">
        <div>
          <p className="text-sm text-[var(--color-ink)]">{r.note || (isSpend ? 'Spend' : isMinimumCharge ? 'Minimum charge' : 'Payment')}</p>
          <p className="text-[11px] text-[var(--color-ink-muted)]">
            {r.date}
            {r.status === 'pending' ? ' · Pending' : ''}
          </p>
        </div>
        <p className="text-sm font-mono font-semibold" style={{ color: isSpend ? 'var(--color-negative)' : 'var(--color-positive)' }}>
          {isSpend ? '+' : '-'}£{formatCurrency(r.amount)}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {sections.map((section, i) => {
        const key = toLocalIsoDate(section.dueDate)
        const expanded = groupByDirection ? !toggled.has(key) : toggled.has(key)
        const visibleRows = section.rows.filter((r) => showCleared || r.status !== 'cleared')
        return (
          <div key={key} className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-bg)' }}>
            <button onClick={() => toggle(key)} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left">
              <span className="flex items-center gap-1.5 min-w-0">
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                <span className="text-xs font-semibold text-[var(--color-ink)] truncate">
                  {i === 0 ? 'Current cycle' : `Due ${formatCycleDate(key)}`}
                </span>
              </span>
              {!expanded && <span className="text-xs font-mono text-[var(--color-ink)] shrink-0">£{formatCurrency(section.closingBalance)}</span>}
            </button>
            {expanded && (
              <div className="px-3 pb-2">
                {groupByDirection ? (
                  <DirectionGroupedRows
                    items={visibleRows}
                    isIncoming={(r) => r.type !== 'credit_card_spend'}
                    amountOf={(r) => r.amount}
                    dateOf={(r) => r.date}
                    keyOf={(r) => `${r.type}-${r.date}-${r.amount}`}
                    renderRow={renderCardCycleRow}
                    incomingLabel="Payments"
                    outgoingLabel="Spend"
                  />
                ) : (
                  <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
                    {/* UAT 2026-09-09 (retest) — "Show cleared" hides already-
                        cleared rows here too, same as every other list on this
                        page; `section.closingBalance` is untouched by this —
                        it stays the real balance due regardless of which rows
                        are currently visible. */}
                    {visibleRows.map((r, ri) => (
                      <div key={ri}>{renderCardCycleRow(r)}</div>
                    ))}
                    {visibleRows.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] text-center py-3">Nothing this period.</p>}
                  </div>
                )}
                <div className="flex items-center justify-between py-2">
                  <span className="text-xs font-semibold text-[var(--color-ink)]">Balance due {formatCycleDate(key)}</span>
                  <span className="text-sm font-mono font-semibold text-[var(--color-ink)]">£{formatCurrency(section.closingBalance)}</span>
                </div>
              </div>
            )}
          </div>
        )
      })}
      {sections.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] text-center py-6">No upcoming periods.</p>}
    </div>
  )
}

/**
 * A loan's own hero-card detail — PROMPT-08a Part C.
 *
 * Reads the SAME `loan_payment` rows the funding side shows, displayed
 * POSITIVE via `loanSignedAmount`: one stored row, two presentations.
 * Nothing here writes a transaction — see
 * DECISION-2026-09-18-loan-ledger-double-entry.md for why a second stored
 * mirror row was rejected.
 *
 * The cycles are the LOAN's own payment periods, never the household pay
 * cycle — the same rule a credit card follows for its statement periods,
 * and for the same reason (PROMPT-01 Part B: a pay-cycle window could not
 * show a charge falling one day past its end).
 *
 * Deliberately narrower than the other cards' controls: the horizon pill,
 * cycle-end totals and "show cleared" all apply (Adam, 2026-09-18: "it
 * should look exactly like everything else"), but group-by and order-by do
 * not — every row on one loan's ledger carries that loan's own category,
 * so grouping by it says nothing. `DECK_CONTROLS_SHOW_GROUP_ORDER` is what
 * enforces that.
 */
function LoanDetail({
  loan,
  data,
  horizon,
  cycleTotals,
  showCleared,
}: {
  loan: Loan
  data: AppDataV2
  horizon: ProjectionHorizon
  cycleTotals: boolean
  showCleared: boolean
}) {
  const asOf = new Date()
  const owedNow = summarizeLoan(loan, asOf).remainingBalance
  const owedProjected = summarizeLoan(loan, horizon === 'three_cycles' ? horizonRangeEnd(data, data.primaryPersonId, horizon, asOf) : asOf).remainingBalance
  const color = loan.color
  // parseLocalDate, never `new Date(iso)` — the latter parses an ISO date
  // as UTC and can report the previous day under BST. That is the exact
  // class of bug the 2026-09-15 date-parsing sweep exists for.
  const dueDayOfMonth = parseLocalDate(loan.startDate).getDate()

  // 1 period for "This cycle", 1 + THREE_CYCLES_AHEAD for "Next 3 cycles"
  // — the horizon chooses HOW MANY of the loan's own periods to show, and
  // never switches the ledger back to the pay cycle.
  const periods = loanCyclePeriods(loan, asOf, horizon === 'three_cycles' ? 1 + THREE_CYCLES_AHEAD : 1)
  const sections = buildLoanCycleSections(loan, data.transactions, periods)

  // The flat list is FLATTENED FROM THE SECTIONS, never filtered out of
  // data.transactions separately — that separation is exactly what let the
  // credit card's two toggle states disagree about the same card on the
  // same data (PROMPT-01 Part B). "Show cleared" applies to both paths
  // identically, and bounds cleared rows to the window like any other row
  // (the 2026-09-17 bug this must not reintroduce).
  const visibleRows = sections.flatMap((s) => s.rows).filter((t) => showCleared || t.status !== 'cleared')

  // Collapsed by default, same as every other card's cycle sections —
  // tracks what's been explicitly EXPANDED so a newly-appearing cycle
  // needs no seeding.
  const [expandedCycles, setExpandedCycles] = useState<Set<string>>(() => new Set())
  const trendSeries = loanTrendAsBalanceSeries(loan, asOf)
  // The chart's own events, spanning the loan's ENTIRE life — not the
  // cycles the ledger above happens to be showing. Same lesson as the
  // Personal card's `trendIconTxns` (2026-09-18): feed the tooltip from
  // the chart's range, or it goes blank wherever the ledger's window ends.
  const trendEvents = buildLoanTrendEvents(loan)

  return (
    <div className="flex flex-col gap-4">
      <HomeSection>
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">{loan.name}</h2>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">
          £{formatCurrency(owedNow)} owed · £{formatCurrency(owedProjected)} projected · due on the {dueDayOfMonth}
          {ordinalSuffix(dueDayOfMonth)}
        </p>

        {cycleTotals ? (
          /* Collapsed pills, exactly like every other card's cycle-end
             totals view (Adam, 2026-09-18 — "doesn't show collapsed pills
             like the other cards"). Same markup and same collapsed-by-
             default behaviour as CycleGroupedList, but kept local rather
             than reusing that component because it derives BOTH the row
             amounts and the running figure from one `amountSign`: a loan
             needs rows POSITIVE (money arriving at the debt) while the
             pill's figure counts DOWN (what's still owed). One sign can't
             be both. The figure comes from the amortisation schedule via
             buildLoanCycleSections, not from folding the rows. */
          <div className="flex flex-col gap-2">
            {sections.map((section) => {
              const rows = section.rows.filter((t) => showCleared || t.status !== 'cleared')
              const expanded = expandedCycles.has(section.endIso)
              return (
                <div key={section.endIso} className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-bg)' }}>
                  <button
                    onClick={() => setExpandedCycles((prev) => { const next = new Set(prev); if (next.has(section.endIso)) next.delete(section.endIso); else next.add(section.endIso); return next })}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
                    aria-expanded={expanded}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      <span className="text-xs font-semibold text-[var(--color-ink)] truncate">Due {formatCycleDate(section.endIso)}</span>
                    </span>
                    {!expanded && (
                      <span className="text-xs font-mono font-semibold tabular-nums shrink-0" style={{ color: 'var(--color-ink-muted)' }}>
                        £{formatCurrency(section.balanceAfter)}
                      </span>
                    )}
                  </button>
                  {expanded && (
                    <div className="px-3 pb-2">
                      <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
                        {rows.map((t) => (
                          <TransactionRow key={t.id} t={t} data={data} amountSign={loanSignedAmount} />
                        ))}
                        {rows.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-4">Nothing due this cycle.</p>}
                      </div>
                      <div className="flex items-center justify-between pt-2 text-xs">
                        <span className="text-[var(--color-ink-muted)]">Owed after this payment</span>
                        <span className="font-mono font-semibold tabular-nums text-[var(--color-ink)]">£{formatCurrency(section.balanceAfter)}</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
            {visibleRows.map((t) => (
              <TransactionRow key={t.id} t={t} data={data} amountSign={loanSignedAmount} />
            ))}
            {visibleRows.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">No payments in this window.</p>}
          </div>
        )}
      </HomeSection>

      {/* Balance view only, one range: all time (Adam's spec) — `fixedRange`
          hides the Balance/Spend toggle and the This cycle / Next 3 cycles
          control, so `buildSeries` ignores the granularity it is handed and
          always returns the loan's whole life. Everything else is the
          standard Trends experience every other card has: preview, "View
          trends", then the interactive modal with tap-and-hold tooltips.
          The x axis is the loan's payment dates plus any overpayment, which
          is what buildLoanTrendSeries produces. */}
      <HomeSection>
        <TrendPreview
          cardName={loan.name}
          color={color}
          caption={`£${formatCurrency(owedNow)} owed today`}
          balanceSpend={{
            buildSeries: () => trendSeries,
            // A loan's own tooltip, not the shared `dayDetailsForDay`.
            // Two reasons (both Adam, 2026-09-18): the amount reads IN,
            // not OUT — a repayment ARRIVES at the loan, which is the same
            // mirrored sign the ledger above uses — and the chip names
            // WHICH kind of payment it was, because every point on a loan
            // shares one category icon and so the icon says nothing.
            dayDetails: (d) => {
              const onDay = trendEvents.filter((e) => e.dateIso === d)
              const kinds = [...new Set(onDay.map((e) => e.kind))]
              return {
                netAmount: round2(onDay.reduce((sum, e) => sum + e.amount, 0)),
                icons: kinds.map((kind) => ({
                  key: kind,
                  node: (
                    <span className="text-[11px] px-2 py-1 rounded-full whitespace-nowrap" style={{ background: 'var(--color-surface)', color: 'var(--color-ink)' }}>
                      {LOAN_PAYMENT_KIND_LABELS[kind]}
                    </span>
                  ),
                })),
              }
            },
            fixedRange: true,
          }}
        />
      </HomeSection>

      {/* The loan's own pie chart — this is the per-loan ring that used to
          sit on the Personal card (Adam: "individual loan pie charts move
          off the personal card"). Collapsed by default like every other
          card's, and rendered through the same LoanProgressRingsSection so
          the ring, its projection and its caption cannot drift from the
          Joint/Household ones. `loans={[loan]}` means the combined "Total
          Loans" ring never appears here — that belongs to Personal. */}
      <CollapsiblePieSection>
        <LoanProgressRingsSection data={data} horizon={horizon} loans={[loan]} horizonEndDate={horizonRangeEnd(data, data.primaryPersonId, horizon, asOf)} />
      </CollapsiblePieSection>
    </div>
  )
}

function CreditCardDetail({
  card: storedCard,
  data,
  horizon,
  cycleTotals,
  showCleared,
  groupByDirection,
}: {
  card: CreditCard
  data: AppDataV2
  horizon: ProjectionHorizon
  cycleTotals: boolean
  showCleared: boolean
  groupByDirection?: boolean
}) {
  // Both halves of this ring are now derived from the same transaction
  // list under the same on-or-before-<asOf> rule: `paid` from the payment
  // transactions, `currentBalance` by replaying them against the anchor.
  // They previously came from two different mechanisms (transactions vs
  // a separately-mutated stored total) and could disagree — which is
  // what made the chart look half-updated after a payment.
  //
  // BUGFIX (Batch 8, 2026-09-07, Bug 9.1, Adam-reported): this used to
  // always derive as of TODAY regardless of `horizon`, same bug as the
  // hero card above — a purchase dated later in the horizon never showed
  // up in this pie chart either.
  const asOf = horizon === 'three_cycles' ? horizonRangeEnd(data, data.primaryPersonId, horizon, new Date()) : new Date()
  const card = withLiveBalance(storedCard, data.transactions, asOf)
  // Header caption (Adam-specified, 2026-09-12 — "match the bills card"):
  // a credit card has no "projected balance" the way a cash account
  // does — it's money owed, not saved — so "now"/"projected" here means
  // owed-today vs owed-as-of-`asOf` (the SAME horizon-aware balance
  // `card.currentBalance` above already is), not a genuine forward
  // projection the way Personal/Joint/Household/Pot/Savings Pot mean it.
  const nowOwed = withLiveBalance(storedCard, data.transactions, new Date()).currentBalance
  const paid = totalPaidForCard(card.id, data.transactions)
  const percentPaid = paid + card.currentBalance > 0 ? (paid / (paid + card.currentBalance)) * 100 : 0
  // The card's own colour overrides the category's colour for display
  // (types/ledger.ts: "categoryId: for icon; colour below overrides the
  // category's colour") — so the icon SHAPE comes from the category, but
  // is tinted with the card's own colour, not the category's.
  const category = data.categories.find((c) => c.id === card.categoryId)

  // UAT 2026-09-08 (Summary page cycle-end totals, Adam-specified) — this
  // card's OWN accounting periods (bounded by its paymentDayOfMonth, and
  // its own statement window if one's configured), not the household pay
  // cycle the flat `activity` list above is filtered to. "This cycle" is
  // 1 period; "Next 3 cycles" is the current one plus THREE_CYCLES_AHEAD
  // more, matching horizonCycles' own current-cycle-first convention.
  const cardCycles = creditCardCyclePeriods(storedCard, new Date(), horizon === 'three_cycles' ? 1 + THREE_CYCLES_AHEAD : 1)
  // BUGFIX (PROMPT-01 Part B, 2026-09-16, Adam-reported: "the minimum 100%
  // charge is not clearing the ledger in the home page credit hero card's
  // ledger") — built for BOTH toggle states now, not just cycleTotals-on.
  // The flat list below is derived from these same sections, so the two
  // states cannot disagree about the same card on the same data, which is
  // exactly what they did before: cycleTotals ON showed the upcoming
  // pending minimum charge, OFF showed only materialised rows.
  const cardCycleSections = buildCreditCardCycleSections(storedCard, data.transactions, cardCycles)
  // PROMPT-01 Part B — the flat (cycle-totals OFF) ledger, now derived by
  // flattening the sections above rather than filtering data.transactions
  // directly. This fixes two defects at once:
  //
  // 1. IT SHOWED ONLY MATERIALISED ROWS. Built purely from
  //    `data.transactions`, it could never show a pending minimum charge —
  //    the very row that tells the user what is about to clear their
  //    balance. The sections have included generated charges since the
  //    2026-09-08 cycle-totals work; the flat list never did.
  //
  // 2. IT USED THE HOUSEHOLD PAY CYCLE, violating the hard rule that a
  //    credit card uses its OWN pay cycle windows (Adam, 2026-09-15;
  //    APP-KNOWLEDGE.md §1.8). It filtered by
  //    `resolveCycleBounds(data, data.primaryPersonId, …)` /
  //    `horizonRangeEnd(…)` — for Adam's mum's cards that window ends
  //    2026-10-13, ONE DAY before the card's own due date of 2026-10-14,
  //    so the upcoming charge could not have appeared even once (1) was
  //    fixed. Both halves were required; neither alone is sufficient.
  //
  // No period maths changes here: `creditCardCyclePeriods` is confirmed
  // working and untouched. This only changes WHICH window the flat list
  // reads from — the card's own, which already existed and was already
  // correct and which the cycleTotals-on path was already using.
  //
  // EXPECTED, NOT A REGRESSION: a payment dated before the card's current
  // period (e.g. mum's 14 Sept cleared payment, which belongs to the
  // PREVIOUS period) correctly drops out of "This cycle" under the card's
  // own window, where the household cycle used to include it.
  //
  // The two deliberate earlier UAT fixes are preserved: the "Show cleared"
  // filter (2026-09-09) still applies, and rows still sort ASCENDING
  // (2026-09-09) so the flat list reads the same direction as the
  // cycle-grouped one rather than flipping with the toggle.
  const activity: CardActivityItem[] = cardCycleSections
    .flatMap((section) => section.rows)
    .filter((r) => showCleared || r.status !== 'cleared')
    .sort((a, b) => a.date.localeCompare(b.date))
    // A generated minimum charge is a projection with no Transaction.id,
    // so React keys come from the row's own identity instead. Date+type
    // alone can collide (two spends the same day), hence the index.
    .map((r, i) => ({ id: `${r.date}-${r.type}-${i}`, date: r.date, type: r.type, amount: r.amount, status: r.status, note: r.note }))

  return (
    <div className="flex flex-col gap-4">
      <HomeSection>
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">{card.name}</h2>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">
          £{formatCurrency(nowOwed)} owed · £{formatCurrency(card.currentBalance)} projected · due on the {card.paymentDayOfMonth}
          {ordinalSuffix(card.paymentDayOfMonth)}
        </p>

        {cycleTotals ? (
          <CreditCardCycleGroupedList sections={cardCycleSections} showCleared={showCleared} groupByDirection={groupByDirection} />
        ) : groupByDirection ? (
          <DirectionGroupedRows
            items={activity}
            isIncoming={(t) => t.type !== 'credit_card_spend'}
            amountOf={(t) => t.amount}
            dateOf={(t) => t.date}
            keyOf={(t) => t.id}
            renderRow={(t) => <CardActivityRow t={t} />}
            incomingLabel="Payments"
            outgoingLabel="Spend"
          />
        ) : (
          <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
            {activity.map((t) => (
              <CardActivityRow key={t.id} t={t} />
            ))}
            {activity.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">No activity yet.</p>}
          </div>
        )}
      </HomeSection>

      <HomeSection>
        <TrendPreview
          cardName={card.name}
          color={card.color}
          caption="Owed today"
          balanceSpend={{
            buildSeries: (g) => buildCreditCardTrendSeries(data, storedCard, g, new Date()),
            dayDetails: (d) => dayDetailsForDay(data.transactions.filter((t) => t.creditCardId === card.id), data.categories, d),
          }}
        />
      </HomeSection>

      <CollapsiblePieSection>
        <div className="flex justify-center my-4">
          <ProgressRing
            percent={percentPaid}
            value={`£${formatCurrency(card.currentBalance)}`}
            label="Outstanding"
            size={160}
            strokeWidth={14}
            color={card.color}
            icon={<CategoryIcon category={category ? { ...category, iconColor: card.color } : undefined} size={26} />}
          />
        </div>
        <p className="text-xs text-[var(--color-ink-muted)] text-center">£{formatCurrency(paid)} paid to date</p>
      </CollapsiblePieSection>
    </div>
  )
}


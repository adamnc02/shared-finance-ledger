// The downloadable cycle statement's DATA — one JSON payload, injected
// into the template at `__DATA__` (see statementFile.ts) and read by the
// plain JS inside the saved file.
//
// 🚨 THIS FILE IS A SERIALISER, NOT A SECOND ENGINE. Every figure here is
// produced by the same functions the Home page's own cards use:
// computeProjectionToDate, computeJointAccountProjectionToDate,
// computePotProjectionToDate, buildSavingsPotScheduleRows,
// buildLoanLedgerRows, buildCreditCardCycleSections. Re-deriving any of
// them here would give the app two numbers, both claiming to be the
// balance — which is worse than having no statement at all. The precedent
// is computeProjection itself, a thin wrapper over computeProjectionToDate
// for exactly this reason. See TECHNICAL.md §"The cycle statement".
//
// The file the person downloads NEVER computes a balance (the file never computes a balance): a row's
// running balance is a fact about that row, produced here, and trimming
// the view in the file does not change it.

import { addDays } from 'date-fns'
import type { AppDataV2, Transaction } from '../types/ledger'
import { buildDeck, deckEntryKey, heroLabel, type DeckEntry } from './deck'
import { computeProjectionToDate, cyclesInRange } from './projection'
import { computeJointAccountProjectionToDate, jointAccountSignedAmount } from './jointAccountLedger'
import { computePotProjectionToDate, potSignedAmount } from './potLedger'
import { buildSavingsPotScheduleRows, savingsPotBalanceAsOf } from './savingsPotLedger'
import { buildLoanLedgerRows, summarizeLoan } from './ledgerLoans'
import { creditCardCyclePeriodsInRange, buildCreditCardCycleSections, cardBalanceAsOf } from './creditCards'
import { isLedgerTransaction, signedAmount } from './runningBalance'
import { compareByDateSalaryFirst } from './cycleSummary'
import { toLocalIsoDate as toIso, parseLocalDate } from './date'
import { formatCurrency } from './format'

const round2 = (n: number) => Math.round(n * 100) / 100

/** One row of one card's table. Mirrors STATEMENT-PAYLOAD-CONTRACT.md exactly; the template reads these field names directly. */
export interface StatementRow {
  id: string
  date: string
  /**
   * 🚨 The reader never sees the word "payee" (the reader never sees the word "payee"). The app's
   * `Transaction.payee` keeps its internal name; everything the reader
   * sees says "description", because the column mixes counterparties with
   * plain descriptions and holds incoming money too, where nothing in the
   * cell is a payee at all.
   *
   * The VALUE is `transactionLabel` below — the same expression the Home
   * page's own TransactionRow renders. It is deliberately NOT `t.payee`:
   * the ledger list has never shown that field, and a statement showing a
   * different label from the card it claims to reproduce is the exact
   * class of disagreement this whole design guards against.
   */
  description: string
  /** Signed. Positive = into the account, by THIS card's own sign convention. */
  amount: number
  category: string
  /** `salary` is the sort tie-breaker — see `compareByDateSalaryFirst`. */
  kind: string
  direction: 'in' | 'out'
  status: 'cleared' | 'pending'
  /** Matches a `meta.cycles[].key`. */
  cycle: string
  /** 🚨 The running balance AFTER this row, computed HERE. The file never folds one. */
  balance: number
  /** Loan rows only — the split behind B12.10's two columns. */
  capital: number | null
  interest: number | null
  /** Pre-formatted for the table; the raw `amount`/`balance` are for the pivot's sums. One money formatter, never two (one money formatter, never two). */
  amountText: string
  balanceText: string
}

export interface StatementCard {
  id: string
  label: string
  kind: string
  sub: string
  openingBalance: number
  openingDate: string
  balanceLabel: string
  hasSplit: boolean
  rows: StatementRow[]
}

export interface StatementMeta {
  today: string
  generated: string
  appName: string
  selectedStart: string
  selectedEnd: string
  fullRangeStart: string
  fullRangeEnd: string
  earliestAvailable: string
  cycles: { key: string; label: string; start: string }[]
  /** Present ONLY when the chosen start was earlier than `earliestAvailable` (a clamped window explains itself). */
  clamp?: { requestedStart: string; reason: string }
}

export interface StatementPayload {
  meta: StatementMeta
  cards: StatementCard[]
}

/**
 * What a transaction is CALLED on the Home page's ledger list —
 * `t.note || category name || t.type`, exactly as TransactionRow renders
 * it. Extracted here (2026-09-24) rather than copied, so the statement
 * and the card can never disagree about what a row is called.
 */
export function transactionLabel(t: Pick<Transaction, 'note' | 'categoryId' | 'type'>, data: AppDataV2): string {
  return t.note || (data.categories.find((c) => c.id === t.categoryId)?.name ?? t.type)
}

/** A cycle's own label — "14 Sep – 13 Oct 2026". 🚨 Never a sort key: `meta.cycles[].start` is (sort by an ordering key, never by the label). */
export function cycleLabel(start: Date, end: Date): string {
  const s = start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const e = end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${s} – ${e}`
}

function categoryName(t: Pick<Transaction, 'categoryId' | 'type'>, data: AppDataV2): string {
  return data.categories.find((c) => c.id === t.categoryId)?.name ?? 'Uncategorised'
}

/** The row's `kind`, which the file uses for the salary tie-break and as a pivot dimension. */
function rowKind(t: Pick<Transaction, 'type'>): string {
  switch (t.type) {
    case 'salary':
    case 'bonus':
    case 'pension_income':
      return 'salary'
    case 'bill_payment':
      return 'bill'
    case 'loan_payment':
      return 'loan'
    case 'credit_card_payment':
    case 'credit_card_spend':
      return 'card'
    default:
      return 'adhoc'
  }
}

/**
 * Which cycle a date belongs to. Dates are all inside the window by the
 * time this is called, so the final cycle is the safe fallback for a row
 * landing exactly on a boundary the walk rounded differently.
 */
function cycleKeyFor(dateIso: string, cycles: { key: string; start: string; endIso: string }[]): string {
  for (const c of cycles) {
    if (dateIso >= c.start && dateIso <= c.endIso) return c.key
  }
  return cycles[cycles.length - 1]?.key ?? 'c1'
}

/**
 * The shared fold: order salary-first within each date, run the balance
 * forward from `opening` across EVERY row the engine returned, then keep
 * only the rows inside the window.
 *
 * 🚨 The fold runs over the full list and the trim happens afterwards —
 * never the other way round. The engines deliberately return rows reaching
 * back to the account's opening-balance date because the running balance
 * needs them (see computeProjectionToDate's own comment); folding only the
 * window's rows would start every statement from the wrong number.
 *
 * This is the same shape Home.tsx's DateOrderedList uses — opening balance,
 * then fold forward in list order — which is what makes A1's
 * "matches Home" check pass by construction rather than by coincidence.
 */
function foldAndTrim<T extends { date: string }>(
  all: T[],
  opening: number,
  sign: (t: T) => number,
  windowStart: string,
  windowEnd: string,
  compare: (a: T, b: T) => number,
): { rows: { row: T; balance: number }[]; openingInWindow: number } {
  const ordered = all.slice().sort(compare)
  let running = opening
  let openingInWindow = opening
  const withBalance: { row: T; balance: number }[] = []
  for (const row of ordered) {
    // The opening figure the statement PRINTS is the balance immediately
    // before the window's first row — not the account's own opening
    // balance, which can be months earlier.
    if (row.date < windowStart) {
      running = round2(running + sign(row))
      openingInWindow = running
      continue
    }
    running = round2(running + sign(row))
    if (row.date <= windowEnd) withBalance.push({ row, balance: running })
  }
  return { rows: withBalance, openingInWindow }
}

const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date)

export interface StatementOptions {
  /** The dates the person picked. The payload still carries the WHOLE containing cycles at both ends (the window is symmetric) — the file trims the view. */
  selectedStart: string
  selectedEnd: string
  asOfDate?: Date
  appName?: string
}

/**
 * The whole payload. One call, one substitution into the template.
 *
 * 🚨 Sections are `buildDeck(data)` minus `kind === 'household'` (the one deliberate exclusion —
 * Adam: "it's not that useful as a statement"). That is the one deliberate
 * departure from "one section per deck card", and it is a named exclusion
 * here rather than a silent filter somewhere in the rendering.
 */
export function buildStatementPayload(data: AppDataV2, options: StatementOptions): StatementPayload {
  const asOfDate = options.asOfDate ?? new Date()
  const personId = data.primaryPersonId
  const payCycle = data.payCycles.find((pc) => pc.personId === personId)
  const earliestAvailable = payCycle?.openingBalanceDate ?? options.selectedStart

  // B12.13 — a clamped window explains itself. Nothing dated before the
  // reconciliation point exists anywhere in this app (T2), so a range
  // reaching below it is not an error; it is silently empty, which is
  // indistinguishable from missing data unless the document says so.
  const clamped = options.selectedStart < earliestAvailable
  const selectedStart = clamped ? earliestAvailable : options.selectedStart
  const selectedEnd = options.selectedEnd < selectedStart ? selectedStart : options.selectedEnd

  const cycleBounds = cyclesInRange(data, personId, parseLocalDate(selectedStart), parseLocalDate(selectedEnd))
  const fullRangeStart = toIso(cycleBounds[0].start)
  const fullRangeEnd = toIso(cycleBounds[cycleBounds.length - 1].end)
  const cycles = cycleBounds.map((c, i) => ({ key: `c${i + 1}`, label: cycleLabel(c.start, c.end), start: toIso(c.start), endIso: toIso(c.end) }))

  const meta: StatementMeta = {
    today: toIso(asOfDate),
    generated: `${toIso(asOfDate)}T${String(asOfDate.getHours()).padStart(2, '0')}:${String(asOfDate.getMinutes()).padStart(2, '0')}`,
    appName: options.appName ?? 'Finance Ledger',
    selectedStart,
    selectedEnd,
    fullRangeStart,
    fullRangeEnd,
    earliestAvailable,
    cycles: cycles.map(({ key, label, start }) => ({ key, label, start })),
    ...(clamped
      ? {
          clamp: {
            requestedStart: options.selectedStart,
            reason: `The opening balance was reconciled on ${parseLocalDate(earliestAvailable).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}, so no earlier transactions are held.`,
          },
        }
      : {}),
  }

  const windowStartDate = parseLocalDate(fullRangeStart)
  const windowEndDate = parseLocalDate(fullRangeEnd)

  const cards = buildDeck(data)
    // 🚨 The named exclusion (the one deliberate exclusion from "one section per deck card"). Not a silent filter.
    .filter((entry) => entry.kind !== 'household')
    .map((entry) => buildCard(entry, data, { fullRangeStart, fullRangeEnd, windowStartDate, windowEndDate, cycles, asOfDate }))
    .filter((card): card is StatementCard => card !== null)

  return { meta, cards }
}

interface CardContext {
  fullRangeStart: string
  fullRangeEnd: string
  windowStartDate: Date
  windowEndDate: Date
  cycles: { key: string; label: string; start: string; endIso: string }[]
  asOfDate: Date
}

/**
 * A transaction-shaped row, in the shared row format.
 *
 * 🚨 `id` is the row's POSITION in the card, not the transaction's own id.
 * A generated occurrence — a bill that has not materialised yet — carries
 * `generated:<nanoid>`, freshly random on every call, so two statements
 * built from identical data would have had no row in common and could not
 * be diffed against each other. The id only has to be unique within the
 * file (the template uses it for collapse state), so position is both
 * sufficient and stable.
 */
function transactionRow(t: Transaction, index: number, balance: number, sign: (t: Transaction) => number, data: AppDataV2, ctx: CardContext, cardId: string): StatementRow {
  const amount = round2(sign(t))
  return {
    id: `${cardId}:${index}`,
    date: t.date,
    description: transactionLabel(t, data),
    amount,
    category: categoryName(t, data),
    kind: rowKind(t),
    direction: amount >= 0 ? 'in' : 'out',
    status: t.status,
    cycle: cycleKeyFor(t.date, ctx.cycles),
    balance,
    capital: null,
    interest: null,
    amountText: `${amount >= 0 ? '+' : '−'}£${formatCurrency(Math.abs(amount))}`,
    balanceText: `£${formatCurrency(balance)}`,
  }
}

function buildCard(entry: DeckEntry, data: AppDataV2, ctx: CardContext): StatementCard | null {
  const id = deckEntryKey(entry)
  const label = heroLabel(entry, data)
  const personId = data.primaryPersonId

  switch (entry.kind) {
    case 'personal': {
      const payCycle = data.payCycles.find((pc) => pc.personId === personId)
      if (!payCycle) return null
      const projection = computeProjectionToDate(data, personId, payCycle, ctx.windowEndDate, ctx.asOfDate)
      const { rows, openingInWindow } = foldAndTrim(
        projection.transactions.filter(isLedgerTransaction),
        projection.openingBalance,
        signedAmount,
        ctx.fullRangeStart,
        ctx.fullRangeEnd,
        compareByDateSalaryFirst,
      )
      return {
        id,
        label,
        kind: 'personal',
        sub: 'Personal current account',
        openingBalance: openingInWindow,
        openingDate: ctx.fullRangeStart,
        balanceLabel: 'Balance',
        hasSplit: false,
        rows: rows.map(({ row, balance }, i) => transactionRow(row, i, balance, signedAmount, data, ctx, id)),
      }
    }

    case 'joint': {
      const projection = computeJointAccountProjectionToDate(data, ctx.windowEndDate, ctx.asOfDate)
      if (!projection) return null
      const { rows, openingInWindow } = foldAndTrim(
        projection.transactions,
        projection.openingBalance,
        jointAccountSignedAmount,
        ctx.fullRangeStart,
        ctx.fullRangeEnd,
        compareByDateSalaryFirst,
      )
      return {
        id,
        label,
        kind: 'joint',
        sub: 'Joint account',
        openingBalance: openingInWindow,
        openingDate: ctx.fullRangeStart,
        balanceLabel: 'Balance',
        hasSplit: false,
        rows: rows.map(({ row, balance }, i) => transactionRow(row, i, balance, jointAccountSignedAmount, data, ctx, id)),
      }
    }

    case 'pot': {
      const pot = (data.pots ?? []).find((p) => p.id === entry.potId)
      if (!pot) return null
      const projection = computePotProjectionToDate(data, pot, ctx.windowEndDate, ctx.asOfDate)
      const sign = (t: Transaction) => potSignedAmount(t, pot.id)
      const { rows, openingInWindow } = foldAndTrim(projection.transactions, projection.openingBalance, sign, ctx.fullRangeStart, ctx.fullRangeEnd, compareByDateSalaryFirst)
      return {
        id,
        label,
        kind: 'pot',
        sub: `Bills pot · ${pot.name}`,
        openingBalance: openingInWindow,
        openingDate: ctx.fullRangeStart,
        balanceLabel: 'Pot balance',
        hasSplit: false,
        rows: rows.map(({ row, balance }, i) => transactionRow(row, i, balance, sign, data, ctx, id)),
      }
    }

    case 'savings_pot': {
      const pot = data.savingsPots.find((p) => p.id === entry.potId)
      if (!pot) return null
      const payCycle = data.payCycles.find((pc) => pc.personId === personId)
      // The pot's own rows, over THIS window rather than the info modal's
      // fixed ramp — see buildSavingsPotScheduleRows' `window` argument.
      const activity = buildSavingsPotScheduleRows(pot, data.transactions, ctx.asOfDate, data.recurringTemplates, payCycle, {
        start: ctx.windowStartDate,
        end: ctx.windowEndDate,
      }).filter((r) => r.date >= ctx.fullRangeStart && r.date <= ctx.fullRangeEnd)
      // Anchored on the real balance the day BEFORE the window opens —
      // the same anchor SavingsPotDetail uses for its own running figure.
      const opening = savingsPotBalanceAsOf(pot, data.transactions, addDays(ctx.windowStartDate, -1))
      // A withdrawal is the only negative: interest and deposits both add
      // to the pot (SavingsPotActivityRow's own "type-derived sign, not
      // direction-derived" rule — a pot's ledger and the personal ledger
      // read opposite signs off the same transaction).
      const sign = (r: { type: string; amount: number }) => (r.type === 'savings_withdrawal' ? -r.amount : r.amount)
      let running = opening
      const rows: StatementRow[] = activity.map((r, i) => {
        running = round2(running + sign(r))
        const amount = round2(sign(r))
        const description = r.type === 'savings_deposit' ? 'Deposit' : r.type === 'savings_withdrawal' ? 'Withdrawal' : 'Interest'
        return {
          id: `${id}:${i}`,
          date: r.date,
          description,
          amount,
          category: 'Savings',
          kind: 'adhoc',
          direction: amount >= 0 ? 'in' : 'out',
          status: r.status,
          cycle: cycleKeyFor(r.date, ctx.cycles),
          balance: running,
          capital: null,
          interest: null,
          amountText: `${amount >= 0 ? '+' : '−'}£${formatCurrency(Math.abs(amount))}`,
          balanceText: `£${formatCurrency(running)}`,
        }
      })
      return { id, label, kind: 'savings_pot', sub: `Savings · ${pot.name}`, openingBalance: opening, openingDate: ctx.fullRangeStart, balanceLabel: 'Pot balance', hasSplit: false, rows }
    }

    case 'loan': {
      const loan = data.loans.find((l) => l.id === entry.loanId)
      if (!loan) return null
      // 🚨 A loan's rows are the AMORTISATION ENGINE's own ledger rows, not
      // the loan card's transaction list.
      //
      // Both were tried (2026-09-24). Folding the card's transactions by
      // capital loses an ad-hoc overpayment entirely: the overpayment
      // lives on the loan (`loan.overpayments`), not in
      // `data.transactions`, so it has no transaction row to fold — and
      // the statement closed at £4,980.30 against the engine's £4,730.30,
      // understating the payment by the whole £250 while looking
      // perfectly plausible. Home's own loan card survives that because
      // its section CLOSING figure comes from the schedule; a statement
      // that prints a balance on every row cannot.
      //
      // So the rows come from buildLoanLedgerRows — the same function the
      // Loans page renders — which carries `capital`, `interest` and
      // `balanceAfter` straight from the engine. The rule that a loan
      // folds by CAPITAL then holds by construction, because nothing here
      // folds anything at all.
      const rows: StatementRow[] = buildLoanLedgerRows(loan)
        .filter((r) => r.date >= ctx.fullRangeStart && r.date <= ctx.fullRangeEnd)
        .sort(byDate)
        .map((r, i) => ({
          id: `${id}:${i}`,
          date: r.date,
          description: r.type,
          // Positive: from the loan's point of view the money is ARRIVING
          // (loanSignedAmount's convention, and the reason the loan card's
          // rows read positive while the personal card's read negative for
          // the same instalment).
          amount: round2(r.amount),
          category: categoryName({ categoryId: loan.categoryId, type: 'loan_payment' }, data),
          kind: 'loan',
          direction: 'in' as const,
          // The engine's rows carry no status of their own; "still to
          // come" means exactly "not yet reached", which is what the
          // band in the document draws.
          status: (r.date <= toIso(ctx.asOfDate) ? 'cleared' : 'pending') as 'cleared' | 'pending',
          cycle: cycleKeyFor(r.date, ctx.cycles),
          balance: round2(r.balanceAfter),
          capital: round2(r.capital),
          interest: round2(r.interest),
          amountText: `£${formatCurrency(Math.abs(r.amount))}`,
          balanceText: `£${formatCurrency(r.balanceAfter)}`,
        }))
      return {
        id,
        label,
        kind: 'loan',
        sub: `Loan · ${loan.name}`,
        // Owed the day before the window opens — the engine's own figure,
        // so the opening tile and the first row's balance agree.
        openingBalance: summarizeLoan(loan, addDays(ctx.windowStartDate, -1)).remainingBalance,
        openingDate: ctx.fullRangeStart,
        balanceLabel: 'Owed',
        hasSplit: rows.some((r) => r.interest !== null && r.interest > 0),
        rows,
      }
    }

    case 'credit_card': {
      const card = data.creditCards.find((c) => c.id === entry.cardId)
      if (!card) return null
      const periods = creditCardCyclePeriodsInRange(card, ctx.windowStartDate, ctx.windowEndDate)
      const sections = buildCreditCardCycleSections(card, data.transactions, periods)
      const flat = sections
        .flatMap((s) => s.rows)
        .filter((r) => r.date >= ctx.fullRangeStart && r.date <= ctx.fullRangeEnd)
        .sort(byDate)
      // 🚨 The card's balance per row is cardBalanceAsOf — the engine's
      // own replay against the card's `balanceAsOfDate` anchor — never a
      // fold of the rows. Interest has no row of its own to fold (see
      // CreditCardCycleSection.closingBalance' own comment), so summing
      // rows would silently omit it.
      const opening = cardBalanceAsOf(card, data.transactions, addDays(ctx.windowStartDate, -1))
      const rows: StatementRow[] = flat.map((r, i) => {
        const balance = cardBalanceAsOf(card, data.transactions, parseLocalDate(r.date))
        // Spend increases what is owed; a payment reduces it.
        const amount = r.type === 'credit_card_payment' ? round2(r.amount) : round2(-r.amount)
        return {
          id: `${id}:${i}`,
          date: r.date,
          description: r.note ?? (r.type === 'credit_card_payment' ? 'Payment' : 'Spend'),
          amount,
          category: r.type === 'credit_card_payment' ? 'Card payment' : 'Card spend',
          kind: 'card',
          direction: amount >= 0 ? 'in' : 'out',
          status: r.status,
          cycle: cycleKeyFor(r.date, ctx.cycles),
          balance,
          capital: null,
          interest: null,
          amountText: `${amount >= 0 ? '+' : '−'}£${formatCurrency(Math.abs(amount))}`,
          balanceText: `£${formatCurrency(balance)}`,
        }
      })
      return { id, label, kind: 'credit_card', sub: `Credit card · ${card.name}`, openingBalance: opening, openingDate: ctx.fullRangeStart, balanceLabel: 'Card balance', hasSplit: false, rows }
    }

    // 🚨 Household is excluded before this switch is reached (the one deliberate exclusion from "one section per deck card"). It
    // is listed here so a future card kind cannot fall through silently.
    case 'household':
      return null
  }
}

// ── Rendering the file ────────────────────────────────────────────────
//
// Generating a statement is ONE SUBSTITUTION: the template with its
// single `__DATA__` token replaced by the payload. There is no rendering
// step beyond that and there must never be one — the template is the
// artefact, reviewable in a diff, and the app's only job is to put the
// right data inside it.
//
// These live here rather than in statementFile.ts so the verify scripts
// can exercise them under `tsx`: statementFile.ts imports the template
// with Vite's `?raw`, which only a Vite build can resolve, and a check
// that cannot run outside the browser is not much of a check.

/**
 * 🚨 Asserted, never trusted. A template that silently stopped
 * substituting would produce a file that throws the moment it is opened,
 * and the failure would arrive on Adam's phone rather than in a test.
 */
export const STATEMENT_DATA_TOKEN = '__DATA__'

/**
 * The payload injected into the template.
 *
 * `JSON.stringify` output goes inside `<script type="application/json">`,
 * so the one sequence that could break out of that tag is `</script`. It
 * cannot appear in a JSON string unescaped, but a description someone
 * typed could contain it, so it is escaped here rather than assumed away:
 * `<` becomes `\u003c`, which JSON.parse reads back identically.
 */
export function renderStatementHtml(payload: StatementPayload, template: string): string {
  if (!template.includes(STATEMENT_DATA_TOKEN)) {
    throw new Error('The statement template has no __DATA__ token — nothing would be substituted.')
  }
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  // The function form of `replace` passes the JSON through untouched —
  // the string form would interpret `$&` and friends inside it.
  return template.replace(STATEMENT_DATA_TOKEN, () => json)
}

/** `finance-ledger-statement-2026-09-14-to-2026-11-13.html` — the window is in the name, so two saved statements never look alike. */
export function statementFilename(payload: StatementPayload): string {
  return `finance-ledger-statement-${payload.meta.selectedStart}-to-${payload.meta.selectedEnd}.html`
}

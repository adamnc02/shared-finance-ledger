// SYNC APP ONLY. AppDataV2 ⇄ rows, both directions. Pure: no PowerSync or
// Supabase import, so verify-mapping-nulls.ts runs it in Node against the
// real backups.
//
// Rules this file owns (each one fails SILENTLY if broken: the connector
// discards every 23xxx write, MIGRATION-LESSONS §27):
// - '' ↔ NULL on every id-shaped column (DATA-MODEL-REVIEW §11.1). Real data
//   uses '' for "no owner/payee"; Postgres rejects '' in an FK column with
//   23503. Up: '' → NULL. Down: NULL → '' where the app type requires a
//   string (ownerId, payee on templates/loans), otherwise the key is omitted.
// - Category ids carry '@<household_id>' (Adam, option B, MIGRATION-LESSONS
//   §31): appended to categories.id and every category_id going up,
//   stripped coming down. The app never sees it.
// - Derived ids for app items that have none, so two devices converge on
//   one row (the connector upserts on id):
//     pay_cycles: person id · joint_account: household id ·
//     occurrence/deposit overrides: '<parent>:<originalDate>' ·
//     interest / minimum-payment overrides: '<parent>:<date>' ·
//     calibration lines: '<loan>:<date>:<n>', n = earlier lines on that date ·
//     salary deductions: '<snapshot>:<deduction id>'. A deduction's own id is
//     NOT unique: a new salary snapshot copies the previous one's deductions,
//     ids and all (Adam's backup has '6Ib6JS' in two snapshots), and one
//     table-wide id would make the second upload overwrite the first.
// - Transaction.payee: NULL comes back ABSENT, not ''. Real data holds both
//   '' and absent for "no payee" (mum's: 30 '' / 40 absent), and every use
//   compares it with a person id, so the two behave identically. Only the
//   required-string payee/ownerId fields come back as ''.
// - An EMPTY optional child list (occurrenceOverrides: [] and the like) comes
//   back absent: no rows, no list. Every use guards it (`?? []`).
// - Array order ↔ `position` (20260919230000). toRows numbers each list
//   0..n-1; fromRows sorts by (position, id). The STORE decides real
//   positions for writes (powerSyncLedgerStore), so that deleting never
//   renumbers.
// - salary_deductions.sort_order = index in its snapshot's list.
// - jsonb columns are CANONICAL JSON text locally (keys sorted), because
//   Postgres re-orders jsonb keys: comparing raw strings would see a change
//   on every round trip and write it back forever.
// - Not synced: primaryPersonId (per device, the store handles it) and Pot's
//   superseded recurringDeposit* fields (never populated: ledger.ts; dropped
//   by DECISIONS Q7).

import type {
  AppDataV2,
  Category,
  CreditCard,
  JointAccountConfig,
  Loan,
  PayCycleConfig,
  Pension,
  Person,
  Pot,
  RecurringOccurrenceOverride,
  RecurringTemplate,
  SalarySnapshot,
  SalarySort,
  SavingsInterestMethod,
  SavingsPot,
  Transaction,
  TransferLocation,
} from '../../types/ledger'
import { salarySortPersonId } from '../salarySortLedger'
import type { SalaryDeduction } from '../tax'
import type { Scenario } from '../../types/models'

export type Value = string | number | boolean | null
export type Row = { id: string } & Record<string, Value>
/** Rows per Postgres table name (not the local sfl_ name). */
export type Rows = Record<string, Row[]>

export interface MappingContext {
  householdId: string
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Up: '' and undefined → NULL. Use on every id-shaped column. */
export const idUp = (v: string | undefined | null): string | null => (v === undefined || v === null || v === '' ? null : v)
/** Up: undefined → NULL. */
const up = <T extends Value>(v: T | undefined): T | null => (v === undefined ? null : v)

export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort)
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.keys(x as object)
          .sort()
          .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
      )
    }
    return x
  }
  return JSON.stringify(sort(v))
}
const jsonUp = (v: unknown): string | null => (v === undefined || v === null ? null : canonicalJson(v))

export const categoryIdUp = (id: string, ctx: MappingContext) => `${id}@${ctx.householdId}`
export function categoryIdDown(id: string): string {
  const at = id.lastIndexOf('@')
  return at === -1 ? id : id.slice(0, at)
}

/** Builds an object, leaving out every key whose value is undefined (so round trips deep-equal). */
function obj<T>(entries: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)) as T
}
// Down: NULL → undefined (key omitted) for optional fields.
const s = (v: Value | undefined): string | undefined => (v === null || v === undefined ? undefined : String(v))
const n = (v: Value | undefined): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number(v))
const b = (v: Value | undefined): boolean | undefined => (v === null || v === undefined ? undefined : v === true || v === 1 || v === '1' || v === 'true')
// A jsonb value stored double-encoded (a JSON string holding JSON: what the
// connector wrote before toServerRecord, UAT 2026-09-19) is unwrapped, with a
// warning, rather than handing the app a string where it expects an object.
let warnedDoubleEncoded = false
function j<T>(v: Value | undefined): T | undefined {
  if (v === null || v === undefined || v === '') return undefined
  let parsed: unknown = JSON.parse(String(v))
  if (typeof parsed === 'string' && /^\s*[[{]/.test(parsed)) {
    if (!warnedDoubleEncoded) console.warn('[powersync] a jsonb value on the server is double-encoded (stored as a string); reading it anyway')
    warnedDoubleEncoded = true
    parsed = JSON.parse(parsed)
  }
  return parsed as T
}
// Down, required fields.
const S = (v: Value | undefined): string => s(v) ?? ''
const N = (v: Value | undefined): number => n(v) ?? 0
const B = (v: Value | undefined): boolean => b(v) ?? false

// A flattened TransferLocation. The type column is `<prefix>_type` on
// recurring_templates (transfer_from_type) but `<prefix>_location_type` on
// transactions (from_location_type): pass it explicitly.
function transferUp(prefix: string, typeColumn: string, loc: TransferLocation | undefined): Record<string, Value> {
  return {
    [typeColumn]: loc?.type ?? null,
    [`${prefix}_savings_pot_id`]: idUp(loc?.savingsPotId),
    [`${prefix}_pot_id`]: idUp(loc?.potId),
  }
}
function transferDown(row: Row, prefix: string, typeColumn: string): TransferLocation | undefined {
  const type = s(row[typeColumn])
  if (!type) return undefined
  return obj<TransferLocation>({ type, savingsPotId: s(row[`${prefix}_savings_pot_id`]), potId: s(row[`${prefix}_pot_id`]) })
}

function overrideRows(parentCol: string, parentId: string, list: RecurringOccurrenceOverride[] | undefined, ctx: MappingContext): Row[] {
  return (list ?? []).map((o, i) => ({
    id: `${parentId}:${o.originalDate}`,
    household_id: ctx.householdId,
    [parentCol]: parentId,
    original_date: o.originalDate,
    date: up(o.date),
    amount: up(o.amount),
    deleted: up(o.deleted),
    position: i,
  }))
}
const overrideDown = (row: Row): RecurringOccurrenceOverride =>
  obj({ originalDate: S(row.original_date), date: s(row.date), amount: n(row.amount), deleted: b(row.deleted) })

function datedAmountRows(parentCol: string, parentId: string, list: { date: string; amount: number }[] | undefined, ctx: MappingContext): Row[] {
  return (list ?? []).map((o, i) => ({ id: `${parentId}:${o.date}`, household_id: ctx.householdId, [parentCol]: parentId, date: o.date, amount: o.amount, position: i }))
}

export const deductionRowId = (snapshotId: string, deductionId: string) => `${snapshotId}:${deductionId}`
const deductionIdDown = (snapshotId: string, rowId: string) => (rowId.startsWith(snapshotId + ':') ? rowId.slice(snapshotId.length + 1) : rowId)

/** '<loan>:<date>:<n>', n counting earlier lines with the same date (they can repeat: PROMPT-09 §3.2b). */
export function calibrationLineIds(loanId: string, lines: { date: string }[]): string[] {
  const seen = new Map<string, number>()
  return lines.map((l) => {
    const k = seen.get(l.date) ?? 0
    seen.set(l.date, k + 1)
    return `${loanId}:${l.date}:${k}`
  })
}

// ── app → rows ──────────────────────────────────────────────────────────────

export function toRows(data: AppDataV2, ctx: MappingContext): Rows {
  const h = { household_id: ctx.householdId }
  const rows: Rows = {}
  const push = (table: string, ...r: Row[]) => (rows[table] ??= []).push(...r)
  for (const table of TABLE_ORDER) rows[table] = []

  data.people.forEach((p, i) => {
    push('people', { id: p.id, ...h, name: p.name, color: up(p.color), position: i })
    p.salaryHistory.forEach((snap, si) => {
      push('salary_snapshots', {
        id: snap.id, ...h, person_id: p.id, effective_from: snap.effectiveFrom, gross_annual: snap.grossAnnual, tax_code: snap.taxCode,
        student_loan_plan: snap.studentLoanPlan, pay_frequency: snap.payFrequency, employer_pension_percent: up(snap.employerPensionPercent),
        end_date: up(snap.endDate), recorded_seq: snap.recordedSeq, position: si,
      })
      snap.deductions.forEach((d, di) =>
        push('salary_deductions', {
          id: deductionRowId(snap.id, d.id), ...h, salary_snapshot_id: snap.id, name: d.name, type: d.type, amount_type: d.amountType, amount: d.amount,
          percent_basis: up(d.percentBasis), sort_order: di, position: di,
        }),
      )
    })
    p.salaryOverrides.forEach((o, oi) =>
      push('salary_overrides', {
        id: o.id, ...h, person_id: p.id, pay_period_date: o.payPeriodDate, net_pay_override: o.netPayOverride, reason: up(o.reason),
        bonus_gross_amount: up(o.bonusGrossAmount), position: oi,
      }),
    )
  })

  data.categories.forEach((c, i) =>
    push('categories', { id: categoryIdUp(c.id, ctx), ...h, name: c.name, icon: c.icon, icon_color: c.iconColor, is_built_in: c.isBuiltIn ?? false, position: i }),
  )

  data.pots.forEach((p, i) =>
    push('pots', {
      id: p.id, ...h, person_id: p.personId, name: p.name, opening_balance: p.openingBalance, opening_date: p.openingDate, active: p.active,
      color: up(p.color), category_icon: up(p.categoryIcon), category_icon_color: up(p.categoryIconColor),
      is_coin_jar: up(p.isCoinJar), position: i,
    }),
  )

  data.savingsPots.forEach((sp, i) => {
    push('savings_pots', {
      id: sp.id, ...h, person_id: sp.personId, name: sp.name, opening_balance: sp.openingBalance, opening_date: sp.openingDate,
      active: sp.active, color: up(sp.color), interest_type: sp.interestMethod.type, interest_aer: sp.interestMethod.aer,
      interest_crediting_frequency: sp.interestMethod.type === 'aer_credited' ? sp.interestMethod.creditingFrequency : null,
      interest_effective_from: up(sp.interestEffectiveFrom), interest_history: jsonUp(sp.interestHistory),
      interest_destination_type: sp.interestDestination?.type ?? null,
      interest_destination_savings_pot_id: idUp(sp.interestDestination?.savingsPotId), interest_destination_pot_id: idUp(sp.interestDestination?.potId),
      recurring_deposit_amount: up(sp.recurringDepositAmount), recurring_deposit_day_of_month: up(sp.recurringDepositDayOfMonth),
      recurring_deposit_start_date: up(sp.recurringDepositStartDate), target_amount: up(sp.targetAmount), target_date: up(sp.targetDate),
      category_icon: up(sp.categoryIcon), category_icon_color: up(sp.categoryIconColor), position: i,
    })
    push('savings_pot_interest_overrides', ...datedAmountRows('savings_pot_id', sp.id, sp.interestOverrides, ctx))
    push('savings_pot_recurring_deposit_overrides', ...overrideRows('savings_pot_id', sp.id, sp.recurringDepositOverrides, ctx))
  })

  data.pensions.forEach((p, i) => {
    push('pensions', {
      id: p.id, ...h, person_id: p.personId, name: p.name, amount: p.amount, frequency: p.frequency, interval_weeks: up(p.intervalWeeks),
      anchor_date: p.anchorDate, active: p.active, schedule_from: up(p.scheduleFrom), adjust_for_non_working_day: p.adjustForNonWorkingDay,
      cycle_start_follows_payday: p.cycleStartFollowsPayday, amount_effective_from: up(p.amountEffectiveFrom),
      amount_history: jsonUp(p.amountHistory), position: i,
    })
    push('pension_occurrence_overrides', ...overrideRows('pension_id', p.id, p.occurrenceOverrides, ctx))
  })

  data.payCycles.forEach((pc, i) =>
    push('pay_cycles', {
      id: pc.personId, ...h, person_id: pc.personId, opening_balance: pc.openingBalance, opening_balance_date: pc.openingBalanceDate,
      payday_day_of_month: pc.paydayDayOfMonth, payday_adjust_for_non_working_day: pc.paydayAdjustForNonWorkingDay,
      cycle_start_day_of_month: pc.cycleStartDayOfMonth, cycle_start_follows_payday: up(pc.cycleStartFollowsPayday),
      follows_income_source_type: pc.followsIncomeSource?.type ?? null,
      follows_pension_id: pc.followsIncomeSource?.type === 'pension' ? idUp(pc.followsIncomeSource.pensionId) : null,
      payday_history: jsonUp(pc.paydayHistory), pay_schedule_kind: pc.paySchedule?.kind ?? null,
      pay_schedule_anchor: pc.paySchedule?.anchorPayDate ?? null, salary_sort_basis: up(pc.salarySortBasis),
      // PROMPT-13 B4. `jsonUp`, NOT `up` — §33: a jsonb column sent as the
      // text SQLite holds is stored as a jsonb STRING and comes back as
      // one, with no error anywhere. Same treatment as payday_history
      // directly above, for exactly the same reason.
      round_up_enabled: up(pc.roundUpEnabled), round_up_effective_from: up(pc.roundUpEffectiveFrom),
      round_up_history: jsonUp(pc.roundUpHistory), position: i,
    }),
  )

  data.recurringTemplates.forEach((t, i) => {
    push('recurring_templates', {
      id: t.id, ...h, name: t.name, amount: t.amount, category_id: categoryIdUp(t.categoryId, ctx), payment_method: t.paymentMethod,
      frequency: t.frequency, interval_weeks: up(t.intervalWeeks), anchor_date: t.anchorDate, anchor_day_of_month: up(t.anchorDayOfMonth),
      location: t.location, owner_id: idUp(t.ownerId), payee: idUp(t.payee), payee_share_percent: up(t.payeeSharePercent), pot_id: idUp(t.potId),
      location_effective_from: up(t.locationEffectiveFrom), location_history: jsonUp(t.locationHistory), active: t.active,
      amount_effective_from: up(t.amountEffectiveFrom), amount_history: jsonUp(t.amountHistory), kind: up(t.kind),
      ...transferUp('transfer_from', 'transfer_from_type', t.transferFrom), ...transferUp('transfer_to', 'transfer_to_type', t.transferTo),
      follows_payday: up(t.followsPayday), follows_cycle_start: up(t.followsCycleStart),
      recurring_transaction_type: up(t.recurringTransactionType), person_id: idUp(t.personId), position: i,
    })
    push('recurring_template_occurrence_overrides', ...overrideRows('recurring_template_id', t.id, t.occurrenceOverrides, ctx))
  })

  data.loans.forEach((l, i) => {
    push('loans', {
      id: l.id, ...h, name: l.name, monthly_payment: l.monthlyPayment, monthly_payment_effective_from: up(l.monthlyPaymentEffectiveFrom),
      monthly_payment_history: jsonUp(l.monthlyPaymentHistory), term_months: l.termMonths, start_date: l.startDate,
      category_id: categoryIdUp(l.categoryId, ctx), color: up(l.color), location: l.location, owner_id: idUp(l.ownerId), payee: idUp(l.payee),
      payee_share_percent: up(l.payeeSharePercent), pot_id: idUp(l.potId), location_effective_from: up(l.locationEffectiveFrom),
      location_history: jsonUp(l.locationHistory), schedule_from: up(l.scheduleFrom), recurring_overpayment: jsonUp(l.recurringOverpayment),
      principal: l.principal, lender: up(l.lender), apr: up(l.apr), advance_date: up(l.advanceDate),
      interest_convention_id: up(l.interestConventionId), calibrated_monthly_rate: up(l.calibratedMonthlyRate),
      settlement_multiplier: up(l.settlementMultiplier), active: l.active, closed_date: up(l.closedDate), settled_amount: up(l.settledAmount),
      position: i,
    })
    l.overpayments.forEach((o, oi) =>
      push('loan_overpayments', { id: o.id, ...h, loan_id: l.id, date: o.date, amount: o.amount, note: up(o.note), recast_mode: up(o.recastMode), position: oi }),
    )
    const lines = l.statementCalibrationLines ?? []
    const ids = calibrationLineIds(l.id, lines)
    lines.forEach((line, li) =>
      push('loan_statement_calibration_lines', { id: ids[li], ...h, loan_id: l.id, date: line.date, capital: line.capital, interest: line.interest, position: li }),
    )
  })

  data.creditCards.forEach((c, i) => {
    push('credit_cards', {
      id: c.id, ...h, name: c.name, category_id: categoryIdUp(c.categoryId, ctx), color: up(c.color), interest_rate_percent: c.interestRatePercent,
      current_balance: c.currentBalance, balance_as_of_date: c.balanceAsOfDate, minimum_payment_type: c.minimumPayment.type,
      minimum_payment_amount: c.minimumPayment.type === 'fixed' ? c.minimumPayment.amount : null,
      minimum_payment_percent: c.minimumPayment.type === 'percent_of_balance' ? c.minimumPayment.percent : null,
      payment_day_of_month: c.paymentDayOfMonth, statement_start_day: up(c.statementStartDay), statement_end_day: up(c.statementEndDay),
      owner_id: idUp(c.ownerId), location: up(c.location), pot_id: idUp(c.potId), location_effective_from: up(c.locationEffectiveFrom),
      location_history: jsonUp(c.locationHistory), schedule_from: up(c.scheduleFrom), active: c.active, position: i,
    })
    c.lumpPayments.forEach((p, pi) =>
      push('credit_card_lump_payments', { id: p.id, ...h, credit_card_id: c.id, date: p.date, amount: p.amount, note: up(p.note), position: pi }),
    )
    push('credit_card_minimum_payment_overrides', ...datedAmountRows('credit_card_id', c.id, c.minimumPaymentOverrides, ctx))
  })

  if (data.jointAccount) {
    push('joint_account', { id: ctx.householdId, ...h, opening_balance: data.jointAccount.openingBalance, opening_balance_date: data.jointAccount.openingBalanceDate })
  }

  data.transactions.forEach((t, i) =>
    push('transactions', {
      id: t.id, ...h, date: t.date, amount: t.amount, direction: t.direction, category_id: categoryIdUp(t.categoryId, ctx),
      payment_method: t.paymentMethod, status: t.status, type: t.type, note: up(t.note), location: t.location, owner_id: idUp(t.ownerId),
      payee: idUp(t.payee), payee_share_percent: up(t.payeeSharePercent), person_id: idUp(t.personId), source_type: up(t.sourceType),
      source_id: idUp(t.sourceId), occurrence_original_date: up(t.occurrenceOriginalDate), credit_card_id: idUp(t.creditCardId),
      savings_pot_id: idUp(t.savingsPotId), pot_id: idUp(t.potId), ...transferUp('from', 'from_location_type', t.fromLocation), ...transferUp('to', 'to_location_type', t.toLocation),
      follows_payday: up(t.followsPayday), follows_cycle_start: up(t.followsCycleStart),
      // PROMPT-13 B2. `amount` above is already the rounded figure.
      rounded_from: up(t.roundedFrom), rounding_pot_id: idUp(t.roundingPotId), position: i,
    }),
  )

  data.salarySorts.forEach((ss, i) => {
    push('salary_sorts', { id: ss.id, ...h, pay_date: ss.payDate, position: i })
    ss.targets.forEach((tg, ti) =>
      push('salary_sort_targets', {
        id: tg.id, ...h, salary_sort_id: ss.id, to_type: tg.to.type, to_savings_pot_id: idUp(tg.to.savingsPotId), to_pot_id: idUp(tg.to.potId),
        amount: tg.amount, transaction_id: idUp(tg.transactionId), position: ti,
      }),
    )
  })

  data.scenarios.forEach((sc, i) =>
    push('scenarios', {
      id: sc.id, name: sc.name, description: up(sc.description), include_in_cumulative: sc.includeInCumulative, actions: jsonUp(sc.actions ?? []), position: i,
    }),
  )

  return rows
}

// ── rows → app ──────────────────────────────────────────────────────────────

const byPosition = (a: Row, z: Row) => {
  const pa = typeof a.position === 'number' ? a.position : a.position == null ? Infinity : Number(a.position)
  const pz = typeof z.position === 'number' ? z.position : z.position == null ? Infinity : Number(z.position)
  return pa !== pz ? pa - pz : a.id < z.id ? -1 : a.id > z.id ? 1 : 0
}
function groupBy(rows: Row[] | undefined, col: string): Map<string, Row[]> {
  const out = new Map<string, Row[]>()
  for (const r of [...(rows ?? [])].sort(byPosition)) {
    const k = S(r[col])
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}
const sorted = (rows: Row[] | undefined) => [...(rows ?? [])].sort(byPosition)

/** Everything but primaryPersonId, which is per-device (the store adds it). */
export function fromRows(rows: Rows): Omit<AppDataV2, 'primaryPersonId'> {
  const snapshotsByPerson = groupBy(rows.salary_snapshots, 'person_id')
  const deductionsBySnapshot = groupBy(rows.salary_deductions, 'salary_snapshot_id')
  const salaryOverridesByPerson = groupBy(rows.salary_overrides, 'person_id')
  const spInterest = groupBy(rows.savings_pot_interest_overrides, 'savings_pot_id')
  const spDeposit = groupBy(rows.savings_pot_recurring_deposit_overrides, 'savings_pot_id')
  const pensionOverrides = groupBy(rows.pension_occurrence_overrides, 'pension_id')
  const rtOverrides = groupBy(rows.recurring_template_occurrence_overrides, 'recurring_template_id')
  const overpayments = groupBy(rows.loan_overpayments, 'loan_id')
  const calibration = groupBy(rows.loan_statement_calibration_lines, 'loan_id')
  const lumps = groupBy(rows.credit_card_lump_payments, 'credit_card_id')
  const minOverrides = groupBy(rows.credit_card_minimum_payment_overrides, 'credit_card_id')
  const targets = groupBy(rows.salary_sort_targets, 'salary_sort_id')

  const people: Person[] = sorted(rows.people).map((r) => ({
    id: r.id,
    name: S(r.name),
    color: S(r.color),
    salaryHistory: (snapshotsByPerson.get(r.id) ?? []).map((sr) =>
      obj<SalarySnapshot>({
        id: sr.id, personId: r.id, effectiveFrom: S(sr.effective_from), grossAnnual: N(sr.gross_annual), taxCode: S(sr.tax_code),
        studentLoanPlan: S(sr.student_loan_plan), payFrequency: S(sr.pay_frequency),
        deductions: (deductionsBySnapshot.get(sr.id) ?? []).map((d) =>
          obj<SalaryDeduction>({ id: deductionIdDown(sr.id, d.id), name: S(d.name), type: S(d.type), amountType: S(d.amount_type), amount: N(d.amount), percentBasis: s(d.percent_basis) }),
        ),
        employerPensionPercent: n(sr.employer_pension_percent), endDate: s(sr.end_date), recordedSeq: N(sr.recorded_seq),
      }),
    ),
    salaryOverrides: (salaryOverridesByPerson.get(r.id) ?? []).map((o) =>
      obj({ id: o.id, personId: r.id, payPeriodDate: S(o.pay_period_date), netPayOverride: N(o.net_pay_override), reason: s(o.reason), bonusGrossAmount: n(o.bonus_gross_amount) }),
    ),
  }))

  const categories: Category[] = sorted(rows.categories).map((r) =>
    obj<Category>({ id: categoryIdDown(r.id), name: S(r.name), icon: S(r.icon), iconColor: S(r.icon_color), isBuiltIn: B(r.is_built_in) ? true : undefined }),
  )

  const pots: Pot[] = sorted(rows.pots).map((r) =>
    obj<Pot>({
      id: r.id, personId: S(r.person_id), name: S(r.name), openingBalance: N(r.opening_balance), openingDate: S(r.opening_date), active: B(r.active),
      color: S(r.color), categoryIcon: s(r.category_icon), categoryIconColor: s(r.category_icon_color),
      isCoinJar: b(r.is_coin_jar),
    }),
  )

  const savingsPots: SavingsPot[] = sorted(rows.savings_pots).map((r) => {
    const interestMethod: SavingsInterestMethod =
      S(r.interest_type) === 'aer_credited'
        ? { type: 'aer_credited', aer: N(r.interest_aer), creditingFrequency: S(r.interest_crediting_frequency) as 'monthly' }
        : { type: 'daily_accrual_monthly_credited', aer: N(r.interest_aer) }
    const destType = s(r.interest_destination_type)
    const interest = spInterest.get(r.id)
    const deposits = spDeposit.get(r.id)
    return obj<SavingsPot>({
      id: r.id, personId: S(r.person_id), name: S(r.name), openingBalance: N(r.opening_balance), openingDate: S(r.opening_date), active: B(r.active),
      color: S(r.color), interestMethod, interestEffectiveFrom: s(r.interest_effective_from), interestHistory: j(r.interest_history),
      interestOverrides: interest?.map((o) => ({ date: S(o.date), amount: N(o.amount) })),
      interestDestination: destType
        ? obj<TransferLocation>({ type: destType, savingsPotId: s(r.interest_destination_savings_pot_id), potId: s(r.interest_destination_pot_id) })
        : undefined,
      recurringDepositAmount: n(r.recurring_deposit_amount), recurringDepositDayOfMonth: n(r.recurring_deposit_day_of_month),
      recurringDepositStartDate: s(r.recurring_deposit_start_date), recurringDepositOverrides: deposits?.map(overrideDown),
      targetAmount: n(r.target_amount), targetDate: s(r.target_date), categoryIcon: s(r.category_icon), categoryIconColor: s(r.category_icon_color),
    })
  })

  const pensions: Pension[] = sorted(rows.pensions).map((r) =>
    obj<Pension>({
      id: r.id, personId: S(r.person_id), name: S(r.name), amount: N(r.amount), frequency: S(r.frequency), intervalWeeks: n(r.interval_weeks),
      anchorDate: S(r.anchor_date), active: B(r.active), scheduleFrom: s(r.schedule_from), adjustForNonWorkingDay: B(r.adjust_for_non_working_day),
      cycleStartFollowsPayday: B(r.cycle_start_follows_payday), amountEffectiveFrom: s(r.amount_effective_from), amountHistory: j(r.amount_history),
      occurrenceOverrides: pensionOverrides.get(r.id)?.map(overrideDown),
    }),
  )

  const payCycles: PayCycleConfig[] = sorted(rows.pay_cycles).map((r) => {
    const src = s(r.follows_income_source_type)
    const kind = s(r.pay_schedule_kind)
    return obj<PayCycleConfig>({
      personId: S(r.person_id), openingBalance: N(r.opening_balance), openingBalanceDate: S(r.opening_balance_date),
      paydayDayOfMonth: N(r.payday_day_of_month), paydayAdjustForNonWorkingDay: B(r.payday_adjust_for_non_working_day),
      cycleStartDayOfMonth: N(r.cycle_start_day_of_month), cycleStartFollowsPayday: b(r.cycle_start_follows_payday),
      followsIncomeSource: src === 'pension' ? { type: 'pension', pensionId: S(r.follows_pension_id) } : src === 'salary' ? { type: 'salary' } : undefined,
      paydayHistory: j(r.payday_history),
      paySchedule: kind ? { kind: kind as 'four_weekly', anchorPayDate: S(r.pay_schedule_anchor) } : undefined,
      salarySortBasis: s(r.salary_sort_basis),
      roundUpEnabled: b(r.round_up_enabled), roundUpEffectiveFrom: s(r.round_up_effective_from),
      roundUpHistory: j(r.round_up_history),
    })
  })

  const recurringTemplates: RecurringTemplate[] = sorted(rows.recurring_templates).map((r) =>
    obj<RecurringTemplate>({
      id: r.id, name: S(r.name), amount: N(r.amount), categoryId: categoryIdDown(S(r.category_id)), paymentMethod: S(r.payment_method),
      frequency: S(r.frequency), intervalWeeks: n(r.interval_weeks), anchorDate: S(r.anchor_date), anchorDayOfMonth: n(r.anchor_day_of_month),
      location: S(r.location), ownerId: S(r.owner_id), payee: S(r.payee), payeeSharePercent: n(r.payee_share_percent), potId: s(r.pot_id),
      locationEffectiveFrom: s(r.location_effective_from), locationHistory: j(r.location_history), active: B(r.active),
      amountEffectiveFrom: s(r.amount_effective_from), amountHistory: j(r.amount_history), kind: s(r.kind),
      transferFrom: transferDown(r, 'transfer_from', 'transfer_from_type'), transferTo: transferDown(r, 'transfer_to', 'transfer_to_type'), followsPayday: b(r.follows_payday),
      followsCycleStart: b(r.follows_cycle_start), recurringTransactionType: s(r.recurring_transaction_type), personId: s(r.person_id),
      occurrenceOverrides: rtOverrides.get(r.id)?.map(overrideDown),
    }),
  )

  const loans: Loan[] = sorted(rows.loans).map((r) =>
    obj<Loan>({
      id: r.id, name: S(r.name), monthlyPayment: N(r.monthly_payment), monthlyPaymentEffectiveFrom: s(r.monthly_payment_effective_from),
      monthlyPaymentHistory: j(r.monthly_payment_history), termMonths: N(r.term_months), startDate: S(r.start_date),
      categoryId: categoryIdDown(S(r.category_id)), color: S(r.color), location: S(r.location), ownerId: S(r.owner_id), payee: S(r.payee),
      payeeSharePercent: n(r.payee_share_percent), potId: s(r.pot_id), locationEffectiveFrom: s(r.location_effective_from),
      locationHistory: j(r.location_history), scheduleFrom: s(r.schedule_from),
      overpayments: (overpayments.get(r.id) ?? []).map((o) => obj({ id: o.id, date: S(o.date), amount: N(o.amount), note: s(o.note), recastMode: s(o.recast_mode) })),
      recurringOverpayment: j(r.recurring_overpayment), principal: N(r.principal), lender: s(r.lender), apr: n(r.apr), advanceDate: s(r.advance_date),
      interestConventionId: s(r.interest_convention_id), calibratedMonthlyRate: n(r.calibrated_monthly_rate),
      settlementMultiplier: n(r.settlement_multiplier),
      statementCalibrationLines: calibration.get(r.id)?.map((c) => ({ date: S(c.date), capital: N(c.capital), interest: N(c.interest) })),
      active: B(r.active), closedDate: s(r.closed_date), settledAmount: n(r.settled_amount),
    }),
  )

  const creditCards: CreditCard[] = sorted(rows.credit_cards).map((r) =>
    obj<CreditCard>({
      id: r.id, name: S(r.name), categoryId: categoryIdDown(S(r.category_id)), color: S(r.color), interestRatePercent: N(r.interest_rate_percent),
      currentBalance: N(r.current_balance), balanceAsOfDate: S(r.balance_as_of_date),
      minimumPayment: S(r.minimum_payment_type) === 'percent_of_balance'
        ? { type: 'percent_of_balance', percent: N(r.minimum_payment_percent) }
        : { type: 'fixed', amount: N(r.minimum_payment_amount) },
      paymentDayOfMonth: N(r.payment_day_of_month), statementStartDay: n(r.statement_start_day), statementEndDay: n(r.statement_end_day),
      ownerId: S(r.owner_id), location: s(r.location), potId: s(r.pot_id), locationEffectiveFrom: s(r.location_effective_from),
      locationHistory: j(r.location_history), scheduleFrom: s(r.schedule_from),
      lumpPayments: (lumps.get(r.id) ?? []).map((p) => obj({ id: p.id, date: S(p.date), amount: N(p.amount), note: s(p.note) })),
      active: B(r.active), minimumPaymentOverrides: minOverrides.get(r.id)?.map((o) => ({ date: S(o.date), amount: N(o.amount) })),
    }),
  )

  const joint = rows.joint_account?.[0]
  const jointAccount: JointAccountConfig | null = joint
    ? { openingBalance: N(joint.opening_balance), openingBalanceDate: S(joint.opening_balance_date) }
    : null

  const transactions: Transaction[] = sorted(rows.transactions).map((r) =>
    obj<Transaction>({
      id: r.id, date: S(r.date), amount: N(r.amount), direction: S(r.direction), categoryId: categoryIdDown(S(r.category_id)),
      paymentMethod: S(r.payment_method), status: S(r.status), type: S(r.type), note: s(r.note), location: S(r.location), ownerId: S(r.owner_id),
      payee: s(r.payee), payeeSharePercent: n(r.payee_share_percent), personId: s(r.person_id), sourceType: s(r.source_type),
      sourceId: s(r.source_id), occurrenceOriginalDate: s(r.occurrence_original_date), creditCardId: s(r.credit_card_id),
      savingsPotId: s(r.savings_pot_id), potId: s(r.pot_id), fromLocation: transferDown(r, 'from', 'from_location_type'), toLocation: transferDown(r, 'to', 'to_location_type'),
      followsPayday: b(r.follows_payday), followsCycleStart: b(r.follows_cycle_start),
      roundedFrom: n(r.rounded_from), roundingPotId: s(r.rounding_pot_id),
    }),
  )

  // PROMPT-11: a sort's person is DERIVED from the owner of the transfers it created, not stored.
  // The pair is inseparable anyway (an empty sort isn't a sort), so there is no column to keep in
  // step, no migration, and no way for the two to disagree.
  const salarySorts: SalarySort[] = sorted(rows.salary_sorts).map((r) => ({
    id: r.id,
    payDate: S(r.pay_date),
    personId: salarySortPersonId(
      { targets: (targets.get(r.id) ?? []).map((t) => ({ transactionId: S(t.transaction_id) })) },
      transactions,
      people[0]?.id ?? '',
    ),
    targets: (targets.get(r.id) ?? []).map((t) => ({
      id: t.id,
      to: obj<TransferLocation>({ type: S(t.to_type), savingsPotId: s(t.to_savings_pot_id), potId: s(t.to_pot_id) }),
      amount: N(t.amount),
      transactionId: S(t.transaction_id),
    })),
  }))

  const scenarios: Scenario[] = sorted(rows.scenarios).map((r) =>
    obj<Scenario>({ id: r.id, name: S(r.name), description: s(r.description), includeInCumulative: B(r.include_in_cumulative), actions: j(r.actions) ?? [] }),
  )

  return { people, categories, recurringTemplates, loans, creditCards, pensions, savingsPots, pots, transactions, payCycles, salarySorts, scenarios, jointAccount }
}

/** Parent-first (FK order, tables.ts). Inserts run in this order, deletes in reverse. */
export const TABLE_ORDER = [
  'people', 'categories', 'pots', 'savings_pots', 'savings_pot_interest_overrides', 'savings_pot_recurring_deposit_overrides',
  'pensions', 'pension_occurrence_overrides', 'pay_cycles', 'salary_snapshots', 'salary_deductions', 'salary_overrides',
  'recurring_templates', 'recurring_template_occurrence_overrides', 'loans', 'loan_overpayments', 'loan_statement_calibration_lines',
  'credit_cards', 'credit_card_lump_payments', 'credit_card_minimum_payment_overrides', 'joint_account', 'transactions',
  'salary_sorts', 'salary_sort_targets', 'scenarios',
] as const

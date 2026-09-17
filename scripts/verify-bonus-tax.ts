// Bonus handling — reported as two separate faults with one shared cause.
//
// REPORTED (a): "Adding a bonus doesn't update net pay in the salary page
// OR the summary page."
// REPORTED (b): "Bonus should just be treated as taxable and NIable, and
// this net value added on to the original salary net pay. I think what is
// currently happening is the bonus gross pay is included in salary gross
// pay before deductions are made, which is incorrect."
//
// (b) was exactly right. computeNetBonusAmount recomputed the whole year
// with `grossAnnual + bonus`, which ran the bonus through every
// PERCENTAGE-based deduction as well — with a 12.5% salary-sacrifice
// pension, £125 of a £1,000 bonus vanished into the pension before tax
// was even considered. Fixed £ deductions were unaffected either way; it
// was specifically the percentage ones that scaled with the inflated
// gross.
//
// Confirmed against Adam's real backup figures: £56,650 gross, tax code
// 374L, 12.5% pension (salary sacrifice), £70.39 holiday buy (salary
// sacrifice), £10 charity (relief at source).

import { calculateBonusOnTop, calculateNetSalary, type SalaryInput } from '../src/lib/tax'
import { computeNetPayForPeriod, computeNetBonusAmount, computeSnapshotNetPayForPeriod } from '../src/lib/salaryLedger'
import { autoClearDuePayments } from '../src/lib/autoClear'
import type { AppDataV2, Person, PayCycleConfig } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = typeof actual === 'number' && typeof expected === 'number' && tolerance > 0 ? Math.abs(actual - expected) <= tolerance : a === e
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${e}, got ${a}`)
}

// Adam's real salary configuration, from the uploaded backup.
const realSalary: SalaryInput = {
  grossAnnual: 56650,
  taxCode: '374L',
  studentLoanPlan: 'none',
  payFrequency: 'monthly',
  deductions: [
    { id: 'V8QPgo', name: 'Pension', type: 'salary_sacrifice', amountType: 'percent', amount: 12.5 },
    { id: 'zldOlz', name: 'Holiday Buy', type: 'salary_sacrifice', amountType: 'fixed', amount: 70.39 },
    { id: 'IbU1gV', name: 'Charity', type: 'relief_at_source', amountType: 'fixed', amount: 10 },
  ],
  employerPensionPercent: 5,
}

// ---- 1. The corrected figure, on real data ----
// This figure moved from £2,938.18 to £2,938.89 when the engine switched to a
// real per-period PAYE calculation (Aug 2026). It is NOT a bonus regression —
// the bonus logic below is untouched. The baseline rose 71p because the old
// engine over-deducted: a 374L code grants £3,749 of allowance, not £3,740
// (digits × 10 + 9), and the per-period route floors taxable pay to whole
// pounds. Hand-check: free pay ceil(3749/12) = £312.42, taxable pay floors to
// £3,747, tax £870.46, NI £240.99 on the post-sacrifice £4,060.34.
const base = calculateNetSalary(realSalary)
check('Base net pay is unchanged by any of this', base.netPerPeriod, 2938.89, 0.01)

const bonus = calculateBonusOnTop(realSalary, 1000)
// £48,724 annual taxable, less a 374L allowance of £3,740, puts £7,284
// past the basic-rate limit — so the marginal rate here is 40%, not 20%.
check('£1,000 bonus: income tax at the 40% marginal rate', bonus.incomeTax, 400, 0.01)
// NI is per-period, not annualised (see calculateBonusOnTop's comment) —
// this period's niable pay is already £4,060.34, £128.66 short of the
// £4,189 monthly UEL. A £1,000 bonus in the SAME period blows through
// that: £128.66 at 8% (£10.29) + the remaining £871.34 at 2% (£17.43) =
// £27.72. The annual UEL having "room" left over the year doesn't matter —
// NI has no annual reconciliation.
check('£1,000 bonus: NI splits 8%/2% at the PERIOD upper earnings limit, not the annual one', bonus.nationalInsurance, 27.72, 0.01)
check('£1,000 bonus: student loan is NOT charged on a bonus', bonus.studentLoan, 0)
check('£1,000 bonus nets £572.28 — NOT the old £455, and not the annualised-NI £520 either', bonus.net, 572.28, 0.01)

// The specific regression: the old approach's £455 came from £125 of
// pension sacrifice being taken off the bonus first. Pin the gap so a
// reversion is unmistakable rather than just "a bit low".
check('No pension sacrifice is taken from the bonus (the £117.28 the old maths lost)', bonus.net - 455, 117.28, 0.01)
check('Net is exactly gross less tax and NI, nothing else', bonus.net, 1000 - bonus.incomeTax - bonus.nationalInsurance, 0.01)

// ---- 2. Deductions genuinely play no part ----
const noDeductions: SalaryInput = { ...realSalary, deductions: [] }
const bonusNoDeductions = calculateBonusOnTop(noDeductions, 1000)
// Removing deductions raises the taxable base, which CAN change the
// marginal rate — so these aren't identical in general. What must hold
// is that the bonus is never itself reduced by a deduction.
check('Without deductions the bonus still nets gross less tax and NI', bonusNoDeductions.net, 1000 - bonusNoDeductions.incomeTax - bonusNoDeductions.nationalInsurance, 0.01)

const biggerPension: SalaryInput = {
  ...realSalary,
  deductions: realSalary.deductions.map((d) => (d.name === 'Pension' ? { ...d, amount: 25 } : d)),
}
const bonusBiggerPension = calculateBonusOnTop(biggerPension, 1000)
check('Doubling the pension % does not shrink the bonus itself', bonusBiggerPension.net, 1000 - bonusBiggerPension.incomeTax - bonusBiggerPension.nationalInsurance, 0.01)
// Under the OLD maths this would have cost the bonus £250 of pension.
check('...and the bonus is worth strictly more than the old approach would have given', bonusBiggerPension.net > 1000 - 250 - bonusBiggerPension.incomeTax - bonusBiggerPension.nationalInsurance, true)

// ---- 3. Marginal, not average ----
const lowEarner: SalaryInput = { ...realSalary, grossAnnual: 20000, taxCode: '1257L', deductions: [] }
const smallBonus = calculateBonusOnTop(lowEarner, 1000)
check('A basic-rate earner pays 20% tax on the bonus', smallBonus.incomeTax, 200, 0.01)
check('...and 8% NI', smallBonus.nationalInsurance, 80, 0.01)

// A bonus that straddles the basic/higher boundary must be split across
// both rates, not charged wholly at either.
const straddler: SalaryInput = { ...realSalary, grossAnnual: 50000, taxCode: '1257L', deductions: [] }
const straddleBonus = calculateBonusOnTop(straddler, 2000)
check('A bonus straddling the higher-rate threshold is taxed across BOTH bands, not at one flat rate', straddleBonus.incomeTax > 2000 * 0.2 && straddleBonus.incomeTax < 2000 * 0.4, true)
// The split is £279/£1,721, not the £270/£1,730 this asserted before the tax
// code fix. A 1257L code grants £12,579 of allowance, so the higher-rate band
// starts at £50,279 of income (12,579 + the £37,700 basic band), not £50,270.
// The £9 of extra allowance moves £9 of the bonus from 40% down to 20%.
check('Specifically: £279 basic-rate then £1,721 at 40%', straddleBonus.incomeTax, 279 * 0.2 + 1721 * 0.4, 0.01)
// NI drops to 2% above the upper earnings limit — the mirror image.
check('NI on that same bonus mostly falls in the 2% band above the UEL', straddleBonus.nationalInsurance < 2000 * 0.08, true)

// A zero or absent bonus must be an exact zero, not a rounding artefact.
check('A zero bonus is exactly zero', calculateBonusOnTop(realSalary, 0).net, 0)
check('A negative bonus is treated as zero, not a refund', calculateBonusOnTop(realSalary, -500).net, 0)

// ---- 4. It reaches net pay for the period (reported fault (a)) ----
const person: Person = {
  id: 'me',
  name: 'Me',
  color: '#ff5b4c',
  salaryHistory: [{ id: 'snap-1', personId: 'me', effectiveFrom: '2026-01-01', ...realSalary }],
  salaryOverrides: [],
}
check('With no bonus, the period reports plain snapshot net pay', computeNetPayForPeriod(person, '2026-09-14'), 2938.89, 0.01)
check('computeNetBonusAmount agrees with calculateBonusOnTop', computeNetBonusAmount(person, '2026-09-14', 1000), 572.28, 0.01)

const withBonus: Person = {
  ...person,
  salaryOverrides: [{ id: 'ov-1', personId: 'me', payPeriodDate: '2026-09-14', netPayOverride: 3393.18, reason: 'Bonus', bonusGrossAmount: 1000 }],
}
check('Attaching a bonus raises that period\'s net pay to base + net bonus', computeNetPayForPeriod(withBonus, '2026-09-14'), 3511.17, 0.01)
check('Only the bonus period is affected — the next one is untouched', computeNetPayForPeriod(withBonus, '2026-10-14'), 2938.89, 0.01)

// ---- 5. The stored netPayOverride is a cache, not the truth ----
// It was written when the bonus was attached (3393.18, the OLD maths).
// Deriving instead means the corrected figure shows without any data
// migration, and — more importantly — means editing the salary
// afterwards can't leave the period reporting a stale number.
check('A stale stored netPayOverride is ignored in favour of the derived figure (self-healing, no migration needed)', computeNetPayForPeriod(withBonus, '2026-09-14') !== 3393.18, true)

const raisedSalary: Person = {
  ...withBonus,
  salaryHistory: [{ id: 'snap-1', personId: 'me', effectiveFrom: '2026-01-01', ...realSalary, grossAnnual: 70000 }],
}
const newBase = computeSnapshotNetPayForPeriod(raisedSalary, '2026-09-14')!
const newBonus = computeNetBonusAmount(raisedSalary, '2026-09-14', 1000)!
check('Raising the salary re-derives the bonus period rather than reporting the old cached total', computeNetPayForPeriod(raisedSalary, '2026-09-14'), newBase + newBonus, 0.01)

// A PLAIN manual override (no bonusGrossAmount) has no formula to
// re-derive from, so its stored figure is still authoritative.
const manualOverride: Person = {
  ...person,
  salaryOverrides: [{ id: 'ov-2', personId: 'me', payPeriodDate: '2026-09-14', netPayOverride: 1234.56, reason: 'Short month' }],
}
check('A plain manual override is still taken at face value', computeNetPayForPeriod(manualOverride, '2026-09-14'), 1234.56)

// ---- 6. It reaches the SUMMARY page, including an already-cleared payday ----
// Once a payday's date passes, autoClear materializes it into a stored
// transaction whose dedupeKey then suppresses regeneration forever. So
// attaching a bonus to that period used to change the Salary page but
// leave Home showing the old amount, with nothing flagging the mismatch.
const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 0,
  openingBalanceDate: '2026-08-01',
  paydayDayOfMonth: 14,
  paydayAdjustForNonWorkingDay: false,
  cycleStartDayOfMonth: 14,
}
const asOf = new Date(2026, 7, 22)
const baseData: AppDataV2 = {
  primaryPersonId: 'me',
  people: [person],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  transactions: [],
  payCycles: [payCycle],
  pensions: [],
  scenarios: [],
}
const settled = autoClearDuePayments(baseData, asOf)
const salaryTxn = settled.transactions.find((t) => t.type === 'salary' && t.date === '2026-08-14')
check('The 14 Aug payday was materialized and cleared', salaryTxn?.status, 'cleared')
check('...at plain snapshot net pay', salaryTxn?.amount, 2938.89, 0.01)

const withLateBonus: AppDataV2 = {
  ...settled,
  people: [{ ...person, salaryOverrides: [{ id: 'ov-3', personId: 'me', payPeriodDate: '2026-08-14', netPayOverride: 0, reason: 'Bonus', bonusGrossAmount: 1000 }] }],
}
const reconciled = autoClearDuePayments(withLateBonus, asOf)
const updatedTxn = reconciled.transactions.find((t) => t.type === 'salary' && t.date === '2026-08-14')
check('Attaching a bonus to an ALREADY-CLEARED payday updates the stored transaction (the summary-page gap)', updatedTxn?.amount, 3511.17, 0.01)
check('...without duplicating it', reconciled.transactions.filter((t) => t.type === 'salary' && t.date === '2026-08-14').length, 1)

const secondPass = autoClearDuePayments(reconciled, asOf)
check('Reconciliation is idempotent — a second pass returns the same reference (no update loop)', secondPass === reconciled, true)

console.log(failures === 0 ? '\nAll bonus tax checks passed.' : `\n${failures} bonus tax check(s) failed.`)
if (failures > 0) process.exit(1)

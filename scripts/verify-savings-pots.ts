import {
  newSavingsPot,
  savingsPotBalanceAsOf,
  generateSavingsDepositTransactions,
  generateSavingsInterestTransactions,
  depositOccurrencePreviews,
  schedulePreviewWindow,
  buildSavingsPotScheduleRows,
  applyInterestMethodChange,
  amountNeededPerPayPeriod,
  projectedTargetDate,
  projectedBalanceAt,
  setPausedDeposits,
  scheduledDepositDates,
} from '../src/lib/savingsPotLedger'
import { aerToPeriodicRate, aerToDailyRate, aerCreditedInterest, buildExampleLedger } from '../src/lib/savingsInterest'
import { computeProjection } from '../src/lib/projection'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import type { AppDataV2, Person, SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const basePot: SavingsPot = {
  ...newSavingsPot({
    personId: 'me',
    name: 'Rainy day',
    openingBalance: 1000,
    openingDate: '2026-01-01',
    interestMethod: { type: 'aer_credited', aer: 4.8, creditingFrequency: 'monthly' },
  }),
  id: 'pot-1',
}

// ---- 1. Rate conversion sanity ----
const monthlyRate = aerToPeriodicRate(4.8, 12)
check('12 months of the derived monthly rate compounds back to ~4.8% AER', Math.pow(1 + monthlyRate, 12) - 1, 0.048, 0.0005)
check('Daily rate compounds back to the same AER over 365 days', Math.pow(1 + aerToDailyRate(4.8), 365) - 1, 0.048, 0.0005)

// ---- 2. Balance derivation — folds openingBalance + deposits - withdrawals + interest, ignores anything before openingDate ----
const activity: Transaction[] = [
  { id: 't1', date: '2025-12-01', amount: 999, direction: 'in', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'pot-1' },
  { id: 't2', date: '2026-01-15', amount: 200, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'pot-1' },
  { id: 't3', date: '2026-02-01', amount: 50, direction: 'in', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_withdrawal', location: 'personal', ownerId: 'me', savingsPotId: 'pot-1' },
]
check('A transaction dated BEFORE openingDate is ignored entirely', savingsPotBalanceAsOf(basePot, [activity[0]], new Date('2026-01-01')), 1000)
check('Opening balance + one deposit', savingsPotBalanceAsOf(basePot, activity, new Date('2026-01-15')), 1200)
check('...+ one withdrawal', savingsPotBalanceAsOf(basePot, activity, new Date('2026-02-01')), 1150)

// ---- 3. AER-credited interest — one period, against balance at period start ----
const aerMethod = { type: 'aer_credited' as const, aer: 4.8, creditingFrequency: 'monthly' as const }
check('One month of interest on £1000 at 4.8% AER credited monthly', aerCreditedInterest(1000, aerMethod), 1000 * monthlyRate)
check('No interest on a zero/negative balance', aerCreditedInterest(0, aerMethod), 0)

const interestRows = generateSavingsInterestTransactions(basePot, [], new Date('2026-01-01'), new Date('2026-04-01'))
check('3 monthly interest credits generated Feb/Mar/Apr for a pot opened 1 Jan', interestRows.length, 3)
check('First credit lands 1 Feb (one month after opening)', interestRows[0].date, '2026-02-01')
check('Second credit COMPOUNDS on top of the first, not flat repeats', interestRows[1].amount > interestRows[0].amount, true)
check('Every generated interest row is tagged with the pot', interestRows.every((r) => r.savingsPotId === 'pot-1' && r.type === 'savings_interest'), true)
check('Every generated interest row is direction: in', interestRows.every((r) => r.direction === 'in'), true)
// 2026-09-14 — basePot has no interestDestination set, which defaults to
// "the same pot" (self): location is 'savings', NOT 'personal', so this
// never also counts toward the pot owner's personal cash balance — see
// scripts/verify-savings-interest-destination.ts for the full behaviour
// this default (and every other destination choice) is verified against.
check('Interest rows default to crediting the SAME pot, location: savings (not personal — would double-count)', interestRows.every((r) => r.location === 'savings'), true)

// ---- 4. Manual interest override wins over the generated figure ----
const overriddenPot: SavingsPot = { ...basePot, interestOverrides: [{ date: '2026-02-01', amount: 12.34 }] }
const overriddenRows = generateSavingsInterestTransactions(overriddenPot, [], new Date('2026-01-01'), new Date('2026-03-01'))
check('An overridden interest payment uses the manual figure, not the computed one', overriddenRows[0].amount, 12.34)
check('An overridden row carries no sourceType (hand-set beats generated, same convention as everywhere else)', overriddenRows[0].sourceType, undefined)

// ---- 5. Daily-accrual method — a mid-period deposit earns from its own date, not from the start of the month ----
const dailyPot: SavingsPot = { ...basePot, id: 'pot-2', interestMethod: { type: 'daily_accrual_monthly_credited', aer: 4.8 } }
const midMonthDeposit: Transaction = { id: 'd1', date: '2026-01-15', amount: 500, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'pot-2' }
const dailyRows = generateSavingsInterestTransactions(dailyPot, [midMonthDeposit], new Date('2026-01-01'), new Date('2026-02-01'))
const dailyRate = aerToDailyRate(4.8)
const expectedDailyInterest = 1000 * dailyRate * 14 + 1500 * dailyRate * 17 // 1-14 Jan at £1000, 15-31 Jan at £1500 (17 days: 15th through 31st)
check('Daily-accrual interest reflects the mid-month deposit earning from its own date', dailyRows[0].amount, expectedDailyInterest, 0.5)

const flatBalancePot: SavingsPot = { ...basePot, id: 'pot-3', interestMethod: { type: 'daily_accrual_monthly_credited', aer: 4.8 } }
const flatRows = generateSavingsInterestTransactions(flatBalancePot, [], new Date('2026-01-01'), new Date('2026-02-01'))
check('Daily-accrual on a flat £1000 balance for a 31-day January', flatRows[0].amount, 1000 * dailyRate * 31, 0.5)

// ---- 6. Recurring deposits — monthly walker, pause/unpause ----
const depositPot: SavingsPot = { ...basePot, id: 'pot-4', recurringDepositAmount: 100, recurringDepositDayOfMonth: 15, recurringDepositStartDate: '2026-01-15' }
const previews = depositOccurrencePreviews(depositPot, new Date('2026-01-01'), 3)
check('Next 3 recurring deposits land on the 15th of each month', previews.map((p) => p.date), ['2026-01-15', '2026-02-15', '2026-03-15'])

const pausedPot: SavingsPot = { ...depositPot, ...setPausedDeposits(depositPot, ['2026-03-15', '2026-04-15'], ['2026-03-15', '2026-04-15']) }
const pausedDeposits = generateSavingsDepositTransactions(pausedPot, new Date('2026-01-01'), new Date('2026-06-01'))
check('Marking Mar/Apr as paused skips exactly those two, generating Jan/Feb/May normally either side', pausedDeposits.map((d) => d.date), ['2026-01-15', '2026-02-15', '2026-05-15'])

// ---- 7. Ramp-up preview window — mirrors the CreditCard "only show real data" fix ----
const brandNewPot: SavingsPot = { ...basePot, id: 'pot-5', openingDate: '2026-03-01' }
const w0 = schedulePreviewWindow(brandNewPot, new Date('2026-03-01'))
check('A pot opened today shows no history before its own opening date', w0.start.toISOString().slice(0, 10), '2026-03-01')

const oneMonthOldPot: SavingsPot = { ...basePot, id: 'pot-6', openingDate: '2026-02-01' }
const w1 = schedulePreviewWindow(oneMonthOldPot, new Date('2026-03-01'))
check('A pot 1 month old shows last 1 month back (its own opening date)', w1.start.toISOString().slice(0, 10), '2026-02-01')

const matureP: SavingsPot = { ...basePot, id: 'pot-7', openingDate: '2025-01-01' }
const w2 = schedulePreviewWindow(matureP, new Date('2026-03-01'))
check('A pot 2+ months old shows exactly the last 2 months, not further back', w2.start.toISOString().slice(0, 10), '2026-01-01')
check('Every window\'s forward edge is 12 months out', w2.end.toISOString().slice(0, 10), '2027-03-01')

// ---- 8. Schedule rows — only interest is overridable ----
const rows = buildSavingsPotScheduleRows(depositPot, [], new Date('2026-01-15'))
check('Deposit rows are never overridable from the info-icon modal', rows.filter((r) => r.type === 'savings_deposit').every((r) => !r.overridable), true)
check('Interest rows ARE overridable', rows.filter((r) => r.type === 'savings_interest').every((r) => r.overridable), true)

// ---- 9. Rate change historization ----
const changed = applyInterestMethodChange(basePot, { type: 'aer_credited', aer: 5.1, creditingFrequency: 'monthly' }, '2026-06-01')
check('Changing the method records the OLD one in history with its true effective-from date', changed.interestHistory, [{ effectiveFrom: '2026-01-01', method: basePot.interestMethod }])
check('The new method becomes current', changed.interestMethod, { type: 'aer_credited', aer: 5.1, creditingFrequency: 'monthly' })

// ---- 10. Goal triggers — independent, per spec ----
const targetDatePot: SavingsPot = { ...basePot, id: 'pot-8', targetAmount: 2000, targetDate: '2026-07-01' }
const label = amountNeededPerPayPeriod(targetDatePot, 1000, 'monthly', new Date('2026-01-01'))
check('targetDate produces a per-pay-period figure using the given salary frequency', label !== null, true)
check('Roughly £166/month needed to go from £1000 to £2000 by 1 Jul (6 months)', label?.amountPerPeriod, 1000 / 6, 5)

const amountOnlyPot: SavingsPot = { ...basePot, id: 'pot-9', targetAmount: 2000 }
check('No targetDate set → the info label is not produced at all (independent trigger)', amountNeededPerPayPeriod(amountOnlyPot, 1000, 'monthly'), null)

const projected = projectedTargetDate(targetDatePot, 1000, [], new Date('2026-01-01'))
check('With no recurring deposits and only interest, a £2000 target from £1000 takes MUCH longer than 6 months (not driven by targetDate at all)', projected !== '2026-07-01', true)

// ---- 11. Example ledger for the explanation pop-up ----
const exampleAer = buildExampleLedger({ type: 'aer_credited', aer: 4.8, creditingFrequency: 'monthly' })
check('AER example ledger opens with the illustrative £1000 balance', exampleAer[0].amount, 1000)
check('AER example ledger shows 3 compounding interest credits after opening', exampleAer.length, 4)

const exampleDaily = buildExampleLedger({ type: 'daily_accrual_monthly_credited', aer: 4.8 })
check('Daily-accrual example ledger includes the illustrative mid-month deposit', exampleDaily.some((r) => r.label === 'Example deposit'), true)

// ---- 12. REGRESSION (Adam-reported, 2026-09-02): recurring deposits/interest must appear in computeProjection's OWN output — not just in savingsPotLedger.ts's own helpers. This is the actual bug: the Wallet ledger modal and Home's pot cards called the generators directly and worked fine; the Home page's PERSONAL LEDGER list (computeProjection) never called them at all, so only hand-logged deposits/withdrawals (real stored Transactions) ever showed up there. ----
const projPerson: Person = { id: 'p1', name: 'Pat', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }
const projPayCycle = { ...defaultPayCycleConfig('p1'), openingBalanceDate: '2026-01-01', openingBalance: 1000 }
// 2026-09-14 — interestDestination: personal explicitly, so this pot's
// generated interest is genuinely destined for THIS ledger; a pot with no
// destination set (self, the default — see the NEXT check below) must
// NOT show up here, or it would double-count the exact same money this
// whole feature was built to stop double-counting.
const recurringPot: SavingsPot = {
  ...basePot,
  id: 'pot-proj',
  personId: 'p1',
  recurringDepositAmount: 100,
  recurringDepositDayOfMonth: 15,
  recurringDepositStartDate: '2026-01-15',
  interestDestination: { type: 'personal' },
}
const selfDestinedPot: SavingsPot = { ...recurringPot, id: 'pot-proj-self', interestDestination: undefined }
const projData: AppDataV2 = {
  people: [projPerson],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [recurringPot, selfDestinedPot],
  transactions: [],
  payCycles: [projPayCycle],
  scenarios: [],
  primaryPersonId: 'p1',
}
const projection = computeProjection(projData, 'p1', projPayCycle, 'three_cycles', new Date('2026-01-01'))
check('A recurring monthly deposit shows up in the Home page ledger (computeProjection), not just in savingsPotLedger.ts\'s own helpers', projection.transactions.some((t) => t.type === 'savings_deposit' && t.savingsPotId === 'pot-proj'), true)
// Attributed via `sourceId` (which pot GENERATED it), not `savingsPotId`
// (which pot it's destined FOR) — a personal-destined row correctly has
// no savingsPotId at all (see resolveInterestDestinationFields).
check(
  'Interest destined for personal (interestDestination: personal) shows up in the same ledger',
  projection.transactions.some((t) => t.type === 'savings_interest' && t.sourceId === 'pot-proj' && t.location === 'personal'),
  true,
)
check(
  "REGRESSION GUARD (2026-09-14, savings interest destination) — interest with NO destination set (self, the default) does NOT show up in the personal ledger — it lands in the pot only, or it's counted twice",
  projection.transactions.some((t) => t.type === 'savings_interest' && t.sourceId === 'pot-proj-self'),
  false,
)
check('The generated deposit reduces the projected personal balance (direction out), same as any other pending outgoing', projection.projectedBalance < 1000, true)

// ---- 13. REGRESSION (Adam-reported, 2026-09-02): "saving is changing my monthly deposit rate to a number I did not select" — root cause was that autoClearDuePayments never materialized savings-pot deposits into real, permanent transactions, so every already-due deposit kept being recomputed fresh off the pot's CURRENT standing amount on every render/settle pass. Confirms a due £100 deposit gets locked in as a real £100 transaction BEFORE the rate is later changed to £200 — and that the real one stays £100 afterward, not silently repainted. ----
const rateChangePot: SavingsPot = { ...basePot, id: 'pot-rate', personId: 'p1', recurringDepositAmount: 100, recurringDepositDayOfMonth: 15, recurringDepositStartDate: '2026-01-15' }
const rateChangeData: AppDataV2 = { ...projData, savingsPots: [rateChangePot] }

// Settle as of 20 Jan — the 15 Jan £100 deposit is now due and should be materialized as a real, cleared transaction.
const afterFirstSettle = autoClearDuePayments(rateChangeData, new Date('2026-01-20'))
const materialized = afterFirstSettle.transactions.filter((t) => t.type === 'savings_deposit' && t.savingsPotId === 'pot-rate')
check('The due deposit is materialized into a real, cleared transaction (not left as a forever-generated preview)', materialized.length, 1)
check('...for exactly the amount that was standing at the time it came due', materialized[0]?.amount, 100)
check('...and it is cleared, not pending', materialized[0]?.status, 'cleared')

// Now the standing rate changes to £200 — the ALREADY-MATERIALIZED January deposit must NOT retroactively change.
const afterRateChange: AppDataV2 = { ...afterFirstSettle, savingsPots: [{ ...rateChangePot, recurringDepositAmount: 200 }] }
const resettled = autoClearDuePayments(afterRateChange, new Date('2026-01-20'))
const stillMaterialized = resettled.transactions.filter((t) => t.type === 'savings_deposit' && t.savingsPotId === 'pot-rate')
check('Changing the standing rate afterward does NOT repaint the already-materialized January deposit', stillMaterialized[0]?.amount, 100)
check('Re-settling with nothing new due is a no-op (idempotent, same as every other generator here)', resettled === afterRateChange, true)

// ---- 14. REDESIGN (Adam-specified, 2026-09-02, second pass): no separate pause/resume flow — a flat multi-select of individual paused dates, reusing the ordinary deleted-override mechanism. ----
const pauseWindowPot: SavingsPot = { ...basePot, id: 'pot-pause', recurringDepositAmount: 100, recurringDepositDayOfMonth: 1, recurringDepositStartDate: '2026-01-01' }
const window14 = scheduledDepositDates(pauseWindowPot, new Date('2026-01-01'), new Date('2026-06-01'))
check('scheduledDepositDates lists every calendar date regardless of pause state', window14, ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'])

// Check March and April as paused.
const marApr = { ...pauseWindowPot, ...setPausedDeposits(pauseWindowPot, window14, ['2026-03-01', '2026-04-01']) }
check('Checking March+April pauses exactly those two, nothing else', generateSavingsDepositTransactions(marApr, new Date('2026-01-01'), new Date('2026-06-01')).map((t) => t.date), [
  '2026-01-01',
  '2026-02-01',
  '2026-05-01',
  '2026-06-01',
])
check('Exactly two override entries recorded for two paused dates', marApr.recurringDepositOverrides?.length, 2)

// Unchecking March (re-selecting only April) un-pauses March — "resume" is just not being in the new checked set, no separate concept.
const aprOnly = { ...marApr, ...setPausedDeposits(marApr, window14, ['2026-04-01']) }
check('Unchecking March resumes it — March generates again, April stays paused', generateSavingsDepositTransactions(aprOnly, new Date('2026-01-01'), new Date('2026-06-01')).map((t) => t.date), [
  '2026-01-01',
  '2026-02-01',
  '2026-03-01',
  '2026-05-01',
  '2026-06-01',
])
check('Unchecking a date actually REMOVES its override rather than leaving a stale one behind', aprOnly.recurringDepositOverrides, [{ originalDate: '2026-04-01', deleted: true }])

// Checking a THIRD date on top of an existing pause doesn't disturb the existing one.
const plusMay = { ...aprOnly, ...setPausedDeposits(aprOnly, window14, ['2026-04-01', '2026-05-01']) }
check(
  'Adding a further paused date keeps the existing one and adds the new one, order-independent',
  (plusMay.recurringDepositOverrides?.map((o) => o.originalDate) ?? []).slice().sort(),
  ['2026-04-01', '2026-05-01'],
)

// ---- 15. REGRESSION (Adam-reported, 2026-09-03): projectedBalanceAt used to ONLY sum freshly-generated recurring deposits + interest, completely ignoring real stored transactions — so a real, future-dated manual deposit or withdrawal was invisible to every projection. Reproduces Adam's exact figures: a £250 recurring deposit, a £100 manual top-up, and a £70 withdrawal, all within the projection window. Opening balance/interest zeroed out here so the £280 expectation isn't muddied by basePot's own £1000 opening balance and interest accrual — real callers always derive currentBalance from the SAME pot via savingsPotBalanceAsOf, so there's no equivalent inconsistency in production use. ----
const projBugPot: SavingsPot = {
  ...basePot,
  id: 'pot-projbug',
  personId: 'p1',
  openingBalance: 0,
  openingDate: '2026-09-01',
  interestMethod: { type: 'aer_credited', aer: 0, creditingFrequency: 'monthly' },
  recurringDepositAmount: 250,
  recurringDepositDayOfMonth: 14,
  recurringDepositStartDate: '2026-09-14',
}
const manualTopUp: Transaction = {
  id: 'manual-1',
  date: '2026-09-15',
  amount: 100,
  direction: 'out',
  categoryId: 'category-savings',
  paymentMethod: 'bank_transfer',
  status: 'pending',
  type: 'savings_deposit',
  location: 'personal',
  ownerId: 'p1',
  savingsPotId: 'pot-projbug',
}
const manualWithdrawal: Transaction = {
  id: 'manual-2',
  date: '2026-09-17',
  amount: 70,
  direction: 'in',
  categoryId: 'category-savings',
  paymentMethod: 'bank_transfer',
  status: 'pending',
  type: 'savings_withdrawal',
  location: 'personal',
  ownerId: 'p1',
  savingsPotId: 'pot-projbug',
}
const projBugActivity = [manualTopUp, manualWithdrawal]
const projected30 = projectedBalanceAt(projBugPot, 0, projBugActivity, new Date('2026-09-01'), new Date('2026-09-30'))
check('Projected balance includes the recurring £250 deposit AND the real manual £100 top-up AND the real £70 withdrawal — 250 + 100 - 70 = 280, not just 250', projected30, 280)

// And confirm the hero card's own horizon-aware figure (the OTHER half of this bug — it was always showing the THIS-CYCLE figure mislabelled as "Next 3 cycles") genuinely differs between a near and a far target date.
const nearProjection = projectedBalanceAt(projBugPot, 0, projBugActivity, new Date('2026-09-01'), new Date('2026-09-10'))
const farProjection = projectedBalanceAt(projBugPot, 0, projBugActivity, new Date('2026-09-01'), new Date('2026-09-30'))
check('A later target date genuinely produces a larger projected balance than an earlier one (the horizon toggle actually does something now)', farProjection > nearProjection, true)

console.log(failures === 0 ? '\nAll savings-pot checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

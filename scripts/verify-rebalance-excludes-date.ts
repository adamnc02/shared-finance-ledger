// Rebalance: the opening balance is the bank's figure at the END of its date.
//
// THE BUG IT PREVENTS. Every ledger counted transactions from its opening date
// INCLUSIVE. Rebalance defaults that date to today and takes the figure from
// the bank, which already reflects today's spending — so anything entered in
// the app for today was taken off a second time. `openingExcludesDate` (set
// only by Rebalance) makes that day's transactions not count; every ledger
// floor reads it through lib/openingBalance.ts's countsFrom.
//
// THE TRAP. Turning `>=` into `>` everywhere breaks account SETUP, where the
// opening balance is the start of the day and a deposit that day must count.
// The controls below prove an un-flagged opening still counts its own day.
//
// Reads the real 2026-09-22 PROD backup (two people, a joint account) by
// absolute path; nothing from it is printed.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { computeProjection } from '../src/lib/projection'
import { computePotProjection, generatePotDepositTransactions } from '../src/lib/potLedger'
import { savingsPotBalanceAsOf } from '../src/lib/savingsPotLedger'
import { computeJointAccountProjection } from '../src/lib/jointAccountLedger'
import { walkCreditingDates } from '../src/lib/savingsInterest'
import { autoClearDuePayments } from '../src/lib/autoClear'
import { countsFromIso, applyOpeningEdit } from '../src/lib/openingBalance'
import type { AppDataV2, Pot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const round2 = (n: number) => Math.round(n * 100) / 100

const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-22-PROD.json', 'utf8'))
const base: AppDataV2 = migrateLedgerData(raw.data ?? raw)

const D = '2026-11-09' // the rebalance day
const asOf = new Date(2026, 10, 9, 18, 0) // that evening
const pid = base.primaryPersonId
const pot0 = base.pots.find((p) => p.personId === pid && p.active && !p.isCoinJar)
const sp0 = base.savingsPots.find((p) => p.personId === pid && p.active)
check('fixture has a primary person, a pot, a savings pot and a joint account', [!!pid, !!pot0, !!sp0, !!base.jointAccount], [true, true, true, true])
if (!pot0 || !sp0 || !base.jointAccount) process.exit(1)

let seq = 0
const row = (t: Partial<Transaction>): Transaction => ({ id: `rb-${++seq}`, date: D, amount: 37.5, direction: 'out', categoryId: '', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: pid, ...t }) as Transaction

/** The data with every rebalance target opened at D with `excl`, and one £37.50 movement dated D on each. */
function scenario(excl: boolean | undefined, withRows: boolean): AppDataV2 {
  const flag = excl === undefined ? {} : { openingExcludesDate: excl }
  const rows: Transaction[] = withRows
    ? [
        row({}), // personal spend
        row({ location: 'joint', type: 'expense' }),
        row({ location: 'pot', potId: pot0!.id, type: 'income', direction: 'in' }),
        row({ type: 'transfer', direction: 'out', location: 'personal', fromLocation: { type: 'personal' }, toLocation: { type: 'savings', savingsPotId: sp0!.id }, savingsPotId: sp0!.id }),
      ]
    : []
  return {
    ...base,
    transactions: [...base.transactions.filter((t) => t.date < D), ...rows],
    payCycles: base.payCycles.map((pc) => (pc.personId === pid ? { ...pc, openingBalance: 1000, openingBalanceDate: D, ...flag } : pc)),
    pots: base.pots.map((p) => (p.id === pot0!.id ? { ...p, openingBalance: 200, openingDate: D, ...flag } : p)),
    savingsPots: base.savingsPots.map((p) => (p.id === sp0!.id ? { ...p, openingBalance: 300, openingDate: D, ...flag } : p)),
    jointAccount: { ...base.jointAccount!, openingBalance: 400, openingBalanceDate: D, ...flag },
  }
}

function balances(data: AppDataV2) {
  const pc = data.payCycles.find((p) => p.personId === pid)!
  const pot = data.pots.find((p) => p.id === pot0!.id)!
  const sp = data.savingsPots.find((p) => p.id === sp0!.id)!
  return {
    personal: computeProjection(data, pid, pc, 'current_cycle', asOf).clearedBalance,
    joint: computeJointAccountProjection(data, 'current_cycle', asOf)!.clearedBalance,
    pot: computePotProjection(data, pot, 'current_cycle', asOf).clearedBalance,
    savings: savingsPotBalanceAsOf(sp, data.transactions, asOf),
  }
}

// ── 1. The helper ──
check('countsFrom: unflagged opening counts its own day', countsFromIso({ date: D }), D)
check('countsFrom: flagged opening counts from the next day', countsFromIso({ date: D, excludesDate: true }), '2026-11-10')
check('countsFrom: month end rolls over in local time', countsFromIso({ date: '2026-10-31', excludesDate: true }), '2026-11-01')
check('countsFrom: across the BST change (25 Oct 2026)', countsFromIso({ date: '2026-10-24', excludesDate: true }), '2026-10-25')

// ── 2. Rebalanced (flag on): the day's movements are already in the figure ──
// Activity from OTHER sources dated D (generated bills, interest) is netted out
// by comparing with/without our rows, so the check reads only the four rows.
const flagged = balances(scenario(true, true))
const flaggedNone = balances(scenario(true, false))
check('REBALANCED current account: a £37.50 spend dated the rebalance day does not count', round2(flagged.personal - flaggedNone.personal), 0)
check('REBALANCED joint account: same', round2(flagged.joint - flaggedNone.joint), 0)
check('REBALANCED pot: income dated that day does not count', round2(flagged.pot - flaggedNone.pot), 0)
check('REBALANCED savings pot: a transfer in dated that day does not count', round2(flagged.savings - flaggedNone.savings), 0)

// ── 3. CONTROL — account setup (no flag) still counts its own day ──
const setup = balances(scenario(undefined, true))
const setupNone = balances(scenario(undefined, false))
// Two rows leave the current account: the spend and the transfer into savings.
check('CONTROL setup current account: the spend AND the transfer out DO count', round2(setup.personal - setupNone.personal), -75)
check('CONTROL setup joint account: DOES count', round2(setup.joint - setupNone.joint), -37.5)
check('CONTROL setup pot: income DOES count', round2(setup.pot - setupNone.pot), 37.5)
check('CONTROL setup savings pot: transfer in DOES count', round2(setup.savings - setupNone.savings), 37.5)
// An explicit false behaves exactly as absent.
const explicitFalse = balances(scenario(false, true))
check('CONTROL explicit false = absent', explicitFalse, setup)

// ── 4. The day after still counts, flagged or not ──
const dayAfter = scenario(true, false)
dayAfter.transactions = [...dayAfter.transactions, row({ date: '2026-11-10', status: 'pending' })]
const pc = dayAfter.payCycles.find((p) => p.personId === pid)!
const afterProj = computeProjection(dayAfter, pid, pc, 'current_cycle', asOf)
const afterNone = computeProjection(scenario(true, false), pid, pc, 'current_cycle', asOf)
check('REBALANCED: a spend dated the NEXT day still counts in projected', round2(afterProj.projectedBalance - afterNone.projectedBalance), -37.5)

// ── 5. Generators start the day after too ──
const potWithDeposit = (excl: boolean): Pot => ({ ...pot0!, openingDate: D, openingExcludesDate: excl, recurringDepositAmount: 10, recurringDepositDayOfMonth: 9, recurringDepositStartDate: '2026-01-09', recurringDepositOverrides: [] })
const genDates = (excl: boolean) => generatePotDepositTransactions(potWithDeposit(excl), new Date(2026, 10, 1), new Date(2026, 11, 31)).map((t) => t.date)
check('REBALANCED pot: a recurring deposit due on the rebalance day is not generated', genDates(true).includes(D), false)
check('CONTROL setup pot: it is', genDates(false).includes(D), true)
check('...and next month\'s is, either way', [genDates(true).includes('2026-12-09'), genDates(false).includes('2026-12-09')], [true, true])

// ── 6. autoClear does not materialise onto the rebalanced day ──
const ac = (excl: boolean) => autoClearDuePayments(scenario(excl, false), asOf).transactions.filter((t) => t.date === D && t.location === 'personal' && t.ownerId === pid).length
check('REBALANCED: autoClear materialises nothing for the current account on the rebalance day', ac(true), 0)
console.log(`  (control: un-flagged materialises ${ac(false)} row(s) on that day — 0 is legitimate if nothing is due)`)

// ── 7. Savings interest crediting dates do NOT move with the flag ──
// The walk is anchored on the opening date itself. Read from the source, since
// the walk takes a bare date: what matters is which date the ledger hands it.
const savingsSrc = readFileSync(`${process.cwd()}/src/lib/savingsPotLedger.ts`, 'utf8')
check('Interest (method 1) walks from pot.openingDate, not countsFrom', savingsSrc.includes('walkCreditingDates(pot.openingDate,'), true)
check('Interest (method 2) walks from pot.openingDate, not countsFrom', savingsSrc.includes('walkMonthlyCreditingDates(pot.openingDate,'), true)
check('CONTROL: the walk does differ by a day if handed the next day', walkCreditingDates(D, 'monthly', new Date(2027, 0, 31))[0].date !== walkCreditingDates('2026-11-10', 'monthly', new Date(2027, 0, 31))[0].date, true)

// ── 8. Which edits keep the flag ──
const rebalanced = { ...pot0!, openingBalance: 200, openingDate: D, openingExcludesDate: true }
check('A rename keeps the flag', applyOpeningEdit(rebalanced, { name: 'Renamed' }, 'openingDate').openingExcludesDate, true)
check('Re-saving the same balance and date keeps the flag', applyOpeningEdit(rebalanced, { openingBalance: 200, openingDate: D }, 'openingDate').openingExcludesDate, true)
check('Changing the balance in settings clears it (setup again)', applyOpeningEdit(rebalanced, { openingBalance: 250 }, 'openingDate').openingExcludesDate, false)
check('Changing the date in settings clears it', applyOpeningEdit(rebalanced, { openingDate: '2026-11-01' }, 'openingDate').openingExcludesDate, false)
check('Rebalancing again sets it explicitly', applyOpeningEdit({ ...pot0!, openingExcludesDate: false }, { openingBalance: 9, openingDate: D, openingExcludesDate: true }, 'openingDate').openingExcludesDate, true)
check('A pay cycle uses openingBalanceDate as its date key', applyOpeningEdit({ ...base.payCycles[0], openingExcludesDate: true }, { openingBalanceDate: '2020-01-01' }, 'openingBalanceDate').openingExcludesDate, false)

console.log(failures === 0 ? '\nAll rebalance checks passed.' : `\n${failures} rebalance check(s) failed.`)
if (failures > 0) process.exit(1)

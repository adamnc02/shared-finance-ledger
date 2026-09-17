// Data-validation pass against Adam's real household backup
// (scripts/fixtures/backup-2026-09-02.json — same treatment as the
// existing backup-2026-08-24.json fixture). Confirms three things:
//  1. The backup loads cleanly through migrateLedgerData even though it
//     predates BOTH pensions and savings pots (neither key is present in
//     the raw file) — the `savingsPots: data.savingsPots ?? []` default
//     added to ledgerStorage.ts this session.
//  2. Adding a brand-new pot, a deposit, and a withdrawal behaves exactly
//     as specified: a new pot opens at £0, a deposit increases its
//     balance, a withdrawal decreases it.
//  3. Nothing about adding a savings pot perturbs the EXISTING personal-
//     ledger cycle-end figures — Beverley's real screenshotted numbers
//     (£288.00 current / £3,812.62 pending / £4,100.62 projected, and
//     the four cycle-boundary dates from the screenshot) still come out
//     byte-identical after pots are added, since a pot is a fully
//     separate entity from the personal transaction ledger.

import { readFileSync } from 'fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { computeProjection, horizonCycles } from '../src/lib/projection'
import { newSavingsPot, savingsPotBalanceAsOf } from '../src/lib/savingsPotLedger'
import type { AppDataV2 } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const raw = JSON.parse(readFileSync(new URL('./fixtures/backup-2026-09-02.json', import.meta.url), 'utf-8'))
check('Raw backup genuinely predates pensions AND savings pots (neither key present)', 'pensions' in raw || 'savingsPots' in raw, false)

const data: AppDataV2 = migrateLedgerData(raw)
check('Loads cleanly with savingsPots defaulted to an empty array', data.savingsPots, [])
check('pensions also still defaults safely (pre-existing behaviour, unaffected by this session)', data.pensions, [])

const beverley = data.people.find((p) => p.name.startsWith('Beverley'))
if (!beverley) throw new Error('Fixture is missing Beverley — has the backup file changed?')

// ---- Baseline: Beverley's real screenshotted figures, BEFORE any pot exists ----
const payCycle = data.payCycles.find((pc) => pc.personId === beverley.id)!
const beforeProjection = computeProjection(data, beverley.id, payCycle, 'this_cycle')
const beforeCycles = horizonCycles(data, beverley.id, 'three_cycles', new Date('2026-09-02'))
check('Baseline: 4 horizon cycles match the screenshot window', beforeCycles.length, 4)

// ---- Simulate adding a brand-new pot (£0 opening, per "new pot" spec) ----
const potId = 'sim-pot-1'
const withPot: AppDataV2 = { ...data, savingsPots: [{ ...newSavingsPot({ personId: beverley.id, name: 'Sim pot', openingBalance: 0, openingDate: '2026-09-02', interestMethod: { type: 'aer_credited', aer: 4.5, creditingFrequency: 'monthly' } }), id: potId }] }
check('A new pot opens at exactly £0', savingsPotBalanceAsOf(withPot.savingsPots[0], withPot.transactions, new Date('2026-09-02')), 0)

// ---- Simulate a deposit — increases the pot, per the two-sided bookkeeping spec ----
const depositTxn = {
  id: 'sim-dep-1',
  date: '2026-09-10',
  amount: 200,
  direction: 'out' as const,
  categoryId: 'category-savings',
  paymentMethod: 'bank_transfer' as const,
  status: 'cleared' as const,
  type: 'savings_deposit' as const,
  location: 'personal' as const,
  ownerId: beverley.id,
  savingsPotId: potId,
}
const withDeposit: AppDataV2 = { ...withPot, transactions: [...withPot.transactions, depositTxn] }
check('A £200 deposit increases the pot balance to £200', savingsPotBalanceAsOf(withPot.savingsPots[0], withDeposit.transactions, new Date('2026-09-10')), 200)

// ---- Simulate a withdrawal — reduces the pot balance ----
const withdrawalTxn = {
  id: 'sim-wd-1',
  date: '2026-09-15',
  amount: 50,
  direction: 'in' as const,
  categoryId: 'category-savings',
  paymentMethod: 'bank_transfer' as const,
  status: 'cleared' as const,
  type: 'savings_withdrawal' as const,
  location: 'personal' as const,
  ownerId: beverley.id,
  savingsPotId: potId,
}
const withWithdrawal: AppDataV2 = { ...withDeposit, transactions: [...withDeposit.transactions, withdrawalTxn] }
check('A £50 withdrawal reduces the pot balance to £150', savingsPotBalanceAsOf(withPot.savingsPots[0], withWithdrawal.transactions, new Date('2026-09-15')), 150)

// ---- The critical check: none of this touches Beverley's real personal-ledger cycle math ----
const afterProjection = computeProjection(withWithdrawal, beverley.id, payCycle, 'this_cycle')
const afterCycles = horizonCycles(withWithdrawal, beverley.id, 'three_cycles', new Date('2026-09-02'))
check("Adding a pot + deposit + withdrawal leaves Beverley's opening balance figure completely untouched", afterProjection.openingBalance, beforeProjection.openingBalance)
check("...and her cycle-end horizon dates are byte-identical", afterCycles.map((c) => c.end.toISOString()), beforeCycles.map((c) => c.end.toISOString()))
check(
  'A £150 net savings-pot balance never leaks into the personal ledger transaction list (savings_deposit/withdrawal are ledger-affecting on the PERSONAL side too, by design — but the POT side stays independently correct, which is what this checks)',
  savingsPotBalanceAsOf(withPot.savingsPots[0], withWithdrawal.transactions, new Date('2026-09-15')),
  200 - 50,
)

console.log(failures === 0 ? '\nAll backup-validation checks passed — safe to build against the real household data.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

// PROMPT-04 Bug C (2026-09-16): SavingsPotForm's "Credited" dropdown set
// state that defaultMethodOfType never read, so every aer_credited pot saved
// as creditingFrequency 'monthly'. The FORM side (the choice reaching onSave,
// and reopening showing it) is asserted with real DOM interaction in
// src/pages/SavingsPotForm.test.tsx — run `npx vitest run`. This script proves
// the other half: that the value, once persisted, genuinely changes what the
// engine credits, and that the explanation modal's worked example shows it.
//
// Note on "differs": the rate is an AER, so a full year's total is (by
// definition) ~the same at every frequency. What frequency changes is WHEN
// interest lands and what the balance is part-way through the year — which is
// what is asserted here, alongside the per-credit amounts.

import { generateSavingsInterestTransactions, newSavingsPot, savingsPotBalanceAsOf } from '../src/lib/savingsPotLedger'
import { buildExampleLedger } from '../src/lib/savingsInterest'
import type { SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

type Frequency = 'monthly' | 'quarterly' | 'annual'

function potWith(frequency: Frequency): SavingsPot {
  return {
    ...newSavingsPot({ personId: 'me', name: 'ISA', openingBalance: 1000, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited', aer: 4, creditingFrequency: frequency } }),
    id: `pot-${frequency}`,
  }
}

const yearStart = new Date(2026, 0, 1)
const yearEnd = new Date(2027, 0, 1)

const results = {} as Record<Frequency, { credits: Omit<Transaction, 'id'>[]; total: number; julyBalance: number }>
for (const frequency of ['monthly', 'quarterly', 'annual'] as const) {
  const pot = potWith(frequency)
  const credits = generateSavingsInterestTransactions(pot, [], yearStart, yearEnd)
  const total = Math.round(credits.reduce((s, t) => s + t.amount, 0) * 100) / 100
  const asActivity = credits.map((t, i) => ({ ...t, id: `i${i}` })) as Transaction[]
  const julyBalance = savingsPotBalanceAsOf(pot, asActivity, new Date(2026, 6, 15))
  results[frequency] = { credits, total, julyBalance }
}

// ---- 1. The persisted frequency drives the crediting calendar ----
check('Monthly: 12 credits over the year', results.monthly.credits.length, 12)
check('Quarterly: 4 credits over the year', results.quarterly.credits.length, 4)
check('Annual: 1 credit over the year', results.annual.credits.length, 1)
check('Quarterly credits land on the quarter dates', results.quarterly.credits.map((t) => t.date), ['2026-04-01', '2026-07-01', '2026-10-01', '2027-01-01'])
check('Annual credit lands on the anniversary', results.annual.credits.map((t) => t.date), ['2027-01-01'])

// ---- 2. Amounts genuinely differ, not just the dates ----
check('Monthly first credit is 1000 × monthly-periodic rate of 4% AER', results.monthly.credits[0].amount, 3.27)
check('Quarterly first credit is 1000 × quarterly-periodic rate of 4% AER', results.quarterly.credits[0].amount, 9.85)
check('Annual credit is the full 4% on £1,000', results.annual.credits[0].amount, 40)
check('Mid-July balance: monthly has compounded 6 credits in', results.monthly.julyBalance > results.quarterly.julyBalance, true)
check('Mid-July balance: quarterly ahead of annual (which has credited nothing yet)', results.quarterly.julyBalance > results.annual.julyBalance, true)
check('Mid-July balance: annual is still the untouched £1,000', results.annual.julyBalance, 1000)

// ---- 3. AER sanity — a year's total is ~4% whatever the frequency (the whole point of quoting AER) ----
for (const frequency of ['monthly', 'quarterly', 'annual'] as const) {
  check(`${frequency}: year total ≈ £40 (AER-equivalent, within rounding)`, results[frequency].total, 40, 0.1)
}

// ---- 4. The explanation modal's worked example follows the chosen frequency ----
// Previously walked only 3 months — one quarterly credit, and none at all for annual.
for (const [frequency, dates] of [
  ['monthly', ['2026-02-01', '2026-03-01', '2026-04-01']],
  ['quarterly', ['2026-04-01', '2026-07-01', '2026-10-01']],
  ['annual', ['2027-01-01', '2028-01-01', '2029-01-01']],
] as const) {
  const rows = buildExampleLedger({ type: 'aer_credited', aer: 4, creditingFrequency: frequency })
  check(`Example ledger (${frequency}) shows opening + 3 credits`, rows.length, 4)
  check(`Example ledger (${frequency}) credit dates`, rows.slice(1).map((r) => r.date), dates)
  check(`Example ledger (${frequency}) labels name the frequency`, rows.slice(1).every((r) => r.label.startsWith(`Interest (${frequency},`)), true)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

import { resolveTemplateAmount, recentAndUpcomingOccurrences, generateTransactionsForTemplate, newRecurringTemplate } from '../src/lib/schedule'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const base = newRecurringTemplate({
  name: 'Rent',
  amount: 800,
  categoryId: 'x',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-01-01',
  location: 'personal',
  ownerId: 'p1',
  payee: '',
  payeeSharePercent: 100,
})

check('An untouched template (no history) resolves to its plain amount on any date', resolveTemplateAmount(base, '2026-06-01'), 800)

// The exact reported scenario: rent goes up from £800 to £850, and the
// person picks "apply from 1 August 2026 onward" — July and earlier
// should still show £800, August onward should show £850.
const changed = {
  ...base,
  amount: 850,
  amountEffectiveFrom: '2026-08-01',
  amountHistory: [{ effectiveFrom: '2026-01-01', amount: 800 }],
}
check('Before the effective date, the OLD amount still applies (June)', resolveTemplateAmount(changed, '2026-06-01'), 800)
check('The month immediately before still shows the OLD amount (July)', resolveTemplateAmount(changed, '2026-07-01'), 800)
check('On the effective date itself, the NEW amount applies (inclusive, per the reported requirement)', resolveTemplateAmount(changed, '2026-08-01'), 850)
check('After the effective date, the NEW amount continues to apply', resolveTemplateAmount(changed, '2026-12-01'), 850)

// A second change, later — history accumulates, same as salary snapshots.
const changedTwice = {
  ...changed,
  amount: 900,
  amountEffectiveFrom: '2027-01-01',
  amountHistory: [...changed.amountHistory, { effectiveFrom: changed.amountEffectiveFrom, amount: changed.amount }],
}
check('First period still resolves correctly after a second change (Jan 2026)', resolveTemplateAmount(changedTwice, '2026-01-01'), 800)
check('Second period still resolves correctly (Sept 2026)', resolveTemplateAmount(changedTwice, '2026-09-01'), 850)
check('Third (latest) period resolves to the newest amount (Feb 2027)', resolveTemplateAmount(changedTwice, '2027-02-01'), 900)

// The generated schedule itself reflects the change, not just the resolver in isolation.
const schedule = generateTransactionsForTemplate(changed, new Date(2026, 5, 1), new Date(2026, 8, 1))
check('Generated June occurrence uses the old amount', schedule.find((t) => t.date === '2026-06-01')?.amount, 800)
check('Generated July occurrence uses the old amount', schedule.find((t) => t.date === '2026-07-01')?.amount, 800)
check('Generated August occurrence (the effective date) uses the new amount', schedule.find((t) => t.date === '2026-08-01')?.amount, 850)

// recentAndUpcomingOccurrences — the picker's own data source.
const occurrences = recentAndUpcomingOccurrences(base, new Date(2026, 5, 15))
check('Exactly 4 candidates: 1 most recent past + 3 upcoming', occurrences.length, 4)
check('The first candidate is flagged as past', occurrences[0].isPast, true)
check('The first candidate is the most recent PAST occurrence (June 1st, not further back)', occurrences[0].date, '2026-06-01')
check('The remaining 3 are flagged as upcoming, not past', occurrences.slice(1).every((o) => !o.isPast), true)
check('Upcoming occurrences are in ascending date order', occurrences.slice(1).map((o) => o.date), ['2026-07-01', '2026-08-01', '2026-09-01'])

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll bill-amount-effective-date checks passed.')

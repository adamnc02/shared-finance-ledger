// UAT 2026-09-09 (retest2-bills-single-before-allfuture-untouched) —
// Adam's exact reported repro, replayed step by step through
// applyTemplateAmountChange/applyTemplateSingleOccurrenceAmountChange:
// editing a bill's amount out of chronological order (setting an
// effective date EARLIER than a change already recorded further in the
// future) used to leave that later, now-stale entry sitting in
// amountHistory, where it kept wrongly outranking the new edit for any
// date on/after its own effectiveFrom — silently resurrecting a value
// the person had just tried to overwrite. Fixed by having a PERMANENT
// change drop every candidate (history entries, and the current
// amount/amountEffectiveFrom pair) whose own effectiveFrom is on/after
// the new one, since that whole range is now fully superseded.

import { resolveTemplateAmount, applyTemplateAmountChange, applyTemplateSingleOccurrenceAmountChange, resolveOccurrenceAmount } from '../src/lib/schedule'
import type { RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

let bill: RecurringTemplate = {
  id: 't1',
  name: 'Gym',
  amount: 37,
  categoryId: 'cat-1',
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-09-01',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

// Step 2: £37 -> £39, all future, effective 1 Sept.
bill = { ...bill, ...applyTemplateAmountChange(bill, 39, '2026-09-01') }
check('After step 2, Sept resolves to £39', resolveTemplateAmount(bill, '2026-09-01'), 39)

// Step 3: just a single payment, 1 Oct -> £40.
bill = { ...bill, ...applyTemplateSingleOccurrenceAmountChange(bill, 40, '2026-10-01') }
check('After step 3, Oct (overridden) resolves to £40', resolveOccurrenceAmount(bill, '2026-10-01'), 40)

// Step 5: back to £37, all future, effective 1 Sept (this also
// supersedes/clears the Oct single-occurrence override, per the earlier
// "all future must mean all of them" fix).
bill = { ...bill, ...applyTemplateAmountChange(bill, 37, '2026-09-01') }
check('After step 5, Sept resolves to £37', resolveTemplateAmount(bill, '2026-09-01'), 37)
check('After step 5, the Oct single-occurrence override is cleared (superseded)', resolveOccurrenceAmount(bill, '2026-10-01'), 37)

// Step 6: just a single payment, 1 Oct -> £39.
bill = { ...bill, ...applyTemplateSingleOccurrenceAmountChange(bill, 39, '2026-10-01') }
check('After step 6, Oct (overridden again) resolves to £39', resolveOccurrenceAmount(bill, '2026-10-01'), 39)

// Step 7: all future from 1 Nov -> £40.
bill = { ...bill, ...applyTemplateAmountChange(bill, 40, '2026-11-01') }
check('After step 7, Nov resolves to £40', resolveTemplateAmount(bill, '2026-11-01'), 40)
check('After step 7, the Oct single-occurrence override survives (dated before Nov 1)', resolveOccurrenceAmount(bill, '2026-10-01'), 39)
check('After step 7, Sept still resolves to £37 (unaffected, dated before Nov 1)', resolveTemplateAmount(bill, '2026-09-01'), 37)

// Step 8: THE REPORTED BUG — all future from 1 Sept -> £37 (an
// effective date EARLIER than the £40-from-Nov change just made).
bill = { ...bill, ...applyTemplateAmountChange(bill, 37, '2026-09-01') }
check('After step 8, Sept resolves to £37', resolveTemplateAmount(bill, '2026-09-01'), 37)
check('After step 8, Oct resolves to £37 (the single-occurrence override was superseded by this all-future change)', resolveOccurrenceAmount(bill, '2026-10-01'), 37)
check('After step 8, Nov ALSO resolves to £37 — THE ACTUAL BUG: this used to still show £40, the stale Nov-effective entry silently outranking the new Sept-effective one', resolveTemplateAmount(bill, '2026-11-01'), 37)
check('After step 8, a date far in the future also resolves to £37', resolveTemplateAmount(bill, '2027-03-01'), 37)

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll out-of-order-amount-edits checks passed.')

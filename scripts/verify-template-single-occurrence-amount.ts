// Unified effective-dating work (2026-09-09 follow-up) — Bills, recurring
// Transfers, and recurring Transactions gained the "just a single payment
// / all future" scope step ahead of their existing picker-first amount
// change flow (previously only Salary and LoanRecurringOverpayment had
// it). "Just a single payment" reuses the existing occurrenceOverrides
// mechanism (already used for pausing/moving one occurrence) rather than
// a new field. Verifies: a single-occurrence override affects exactly
// that one occurrence, the standing amount/amountHistory stay completely
// untouched, and it merges onto (rather than clobbers) an existing
// date-move override for the same slot.

import { generateTransactionsForTemplate, applyTemplateSingleOccurrenceAmountChange, applyTemplateAmountChange } from '../src/lib/schedule'
import type { RecurringTemplate } from '../src/types/ledger'
import { addMonths } from 'date-fns'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const template: RecurringTemplate = {
  id: 't1',
  kind: 'bill',
  name: 'Test Bill',
  amount: 50,
  frequency: 'monthly',
  anchorDate: '2026-06-01',
  categoryId: 'cat-1',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  paymentMethod: 'direct_debit',
  active: true,
}

const rangeStart = new Date('2026-06-01')
const rangeEnd = addMonths(rangeStart, 6)

// ─────────────────────────────────────────────────────────────────────
// A single-occurrence override affects exactly one date
// ─────────────────────────────────────────────────────────────────────
const overrideDate = '2026-08-01'
const patch = applyTemplateSingleOccurrenceAmountChange(template, 999, overrideDate)
const overridden: RecurringTemplate = { ...template, ...patch }
const occurrences = generateTransactionsForTemplate(overridden, rangeStart, rangeEnd)

check('The overridden date uses the new one-off amount', occurrences.find((o) => o.date === overrideDate)?.amount, 999)
check('The month before is completely unaffected', occurrences.find((o) => o.date === '2026-07-01')?.amount, 50)
check('The month after reverts to the standing amount — the override does not leak forward', occurrences.find((o) => o.date === '2026-09-01')?.amount, 50)
check('The standing amount is completely untouched', overridden.amount, 50)
check('No amountHistory/amountEffectiveFrom was touched', { history: overridden.amountHistory, effectiveFrom: overridden.amountEffectiveFrom }, { history: undefined, effectiveFrom: undefined })

// ─────────────────────────────────────────────────────────────────────
// Merges onto an existing date-move override for the same slot, rather
// than clobbering it
// ─────────────────────────────────────────────────────────────────────
const movedTemplate: RecurringTemplate = { ...template, occurrenceOverrides: [{ originalDate: overrideDate, date: '2026-08-15' }] }
const mergedPatch = applyTemplateSingleOccurrenceAmountChange(movedTemplate, 777, overrideDate)
check('Merging an amount override onto an existing date-move override keeps the moved date', mergedPatch.occurrenceOverrides, [{ originalDate: overrideDate, date: '2026-08-15', amount: 777 }])

// ─────────────────────────────────────────────────────────────────────
// A single-occurrence override and a permanent (all-future) amount
// change are independent mechanisms — one doesn't corrupt the other's
// state when both exist on the same template.
// ─────────────────────────────────────────────────────────────────────
const permanentEffectiveFrom = '2026-10-01'
const withSingleOverride: RecurringTemplate = { ...template, ...applyTemplateSingleOccurrenceAmountChange(template, 999, overrideDate) }
// Chained onto withSingleOverride (not the bare template) — applyTemplateAmountChange
// itself now filters occurrenceOverrides, so it must see the override to filter it
// correctly (it's dated BEFORE permanentEffectiveFrom here, so it should survive).
const combined: RecurringTemplate = { ...withSingleOverride, ...applyTemplateAmountChange(withSingleOverride, 80, permanentEffectiveFrom) }
const combinedOccurrences = generateTransactionsForTemplate(combined, rangeStart, rangeEnd)
check('The single-occurrence override still applies at its own date', combinedOccurrences.find((o) => o.date === overrideDate)?.amount, 999)
check('Periods before the permanent change (and not overridden) still use the OLD standing amount', combinedOccurrences.find((o) => o.date === '2026-09-01')?.amount, 50)
check('Periods on/after the permanent change use the NEW standing amount', combinedOccurrences.find((o) => o.date === permanentEffectiveFrom)?.amount, 80)

// ─────────────────────────────────────────────────────────────────────
// UAT 2026-09-09 (retest-bills-just-single/all-future-samedate) — the
// ACTUAL reported bug: a single-occurrence override "froze" that date
// forever, surviving even a LATER permanent ("all future") change
// effective on/before that same date. A permanent change now clears the
// amount off any occurrenceOverrides entry it reaches, since "ALL future
// payments" has to mean all of them, not all-except-ones-with-a-prior-
// one-off-tweak.
// ─────────────────────────────────────────────────────────────────────
const laterPermanentEffectiveFrom = overrideDate // effective ON the same date the override was set
const supersedingChange: RecurringTemplate = { ...withSingleOverride, ...applyTemplateAmountChange(withSingleOverride, 100, laterPermanentEffectiveFrom) }
const supersedingOccurrences = generateTransactionsForTemplate(supersedingChange, rangeStart, rangeEnd)
check('A permanent change effective ON the overridden date supersedes it — no longer frozen at the old one-off value', supersedingOccurrences.find((o) => o.date === overrideDate)?.amount, 100)
check('...and every later occurrence also uses the new standing amount', supersedingOccurrences.find((o) => o.date === '2026-09-01')?.amount, 100)
check('The now-empty override entry (amount cleared, nothing else set) is dropped entirely rather than left as a dangling empty record', supersedingChange.occurrenceOverrides, [])

const movedOnly: RecurringTemplate = { ...template, occurrenceOverrides: [{ originalDate: overrideDate, date: '2026-08-15' }] }
const movedPlusPermanent: RecurringTemplate = { ...movedOnly, ...applyTemplateAmountChange(movedOnly, 100, laterPermanentEffectiveFrom) }
check('A pure date-move override (no amount set) survives a permanent amount change untouched', movedPlusPermanent.occurrenceOverrides, [{ originalDate: overrideDate, date: '2026-08-15' }])

// A single-occurrence override dated BEFORE the permanent change's
// effective date must NOT be touched — it's already covered by "before
// this date, keep the old value," which the override already satisfies.
const earlierOverrideTemplate: RecurringTemplate = { ...template, ...applyTemplateSingleOccurrenceAmountChange(template, 999, '2026-06-01') }
const laterPermanent: RecurringTemplate = { ...earlierOverrideTemplate, ...applyTemplateAmountChange(earlierOverrideTemplate, 100, '2026-09-01') }
check('An override dated BEFORE the permanent change\'s effective date is left untouched', laterPermanent.occurrenceOverrides, [{ originalDate: '2026-06-01', amount: 999 }])

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`)
  process.exit(1)
}
console.log('\nAll template-single-occurrence-amount checks passed.')

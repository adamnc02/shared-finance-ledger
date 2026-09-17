// A real, reproduced bug (not just a theoretical edge case): the single
// MOST common bill-amount edit — drop the amount, apply it "from the very
// next payment" — silently never took effect anywhere in the app.
//
// Root cause: applyTemplateAmountChange's own "what applied before this
// edit" entry falls back to `template.anchorDate` the first time a bill
// is ever edited (there's no earlier effectiveFrom to use). A bill's
// anchor date is very often exactly the date recentAndUpcomingOccurrences
// offers as the FIRST, most natural button in the "apply this change
// from…" picker — so the newly-chosen effectiveFrom and the fallback
// "prior value" entry routinely land on the exact same date. Before this
// fix, resolveTemplateAmount broke that tie by array order alone, and
// since the stale (old) value is always inserted before the new one,
// the STALE value silently won, forever, for that date and every date
// after it — the edit the person just made never appeared anywhere,
// with no error and no visible sign anything had gone wrong.
//
// Confirmed against the exact backup file this was reported with: the
// same collision, hit twice in a row (a second edit landing back on the
// first edit's own effectiveFrom), corrupted amountHistory with two
// entries sharing one date — and the fix self-heals that data with no
// migration needed, purely by resolving history correctly going forward.

import { resolveTemplateAmount, applyTemplateAmountChange } from '../src/lib/schedule'
import type { RecurringTemplate } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const baseTemplate: RecurringTemplate = {
  id: 't1',
  name: 'Cash withdrawal',
  amount: 150,
  categoryId: 'category-seed-cash',
  paymentMethod: 'cash',
  frequency: 'weekly',
  anchorDate: '2026-08-29',
  location: 'personal',
  ownerId: 'p1',
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

// ── The single-edit case: picking the very first, most natural option ──
// (the bill's own next/anchor occurrence) as the effective date.
{
  const patch = applyTemplateAmountChange(baseTemplate, 40, '2026-08-29')
  const edited: RecurringTemplate = { ...baseTemplate, ...patch }
  check('A same-date collision on the very first edit still resolves to the NEW amount on that date', resolveTemplateAmount(edited, '2026-08-29'), 40)
  check('...and for every date after it, until superseded', resolveTemplateAmount(edited, '2026-09-05'), 40)
  check('...and a date genuinely before the edit still resolves to the old amount', resolveTemplateAmount({ ...baseTemplate, anchorDate: '2025-01-01' }, '2024-06-01'), 150)
}

// ── The exact reported real-world sequence: two edits, the second one's
// chosen date colliding with the first edit's own recorded effectiveFrom
// (the corrupted shape found in the actual uploaded backup file). ──────
{
  const afterEdit1: RecurringTemplate = { ...baseTemplate, ...applyTemplateAmountChange(baseTemplate, 40, '2026-08-29') }
  const afterEdit2: RecurringTemplate = { ...afterEdit1, ...applyTemplateAmountChange(afterEdit1, 150, '2026-09-05') }

  // UAT 2026-09-09 (retest2-bills-single-before-allfuture-untouched) —
  // applyTemplateAmountChange now DROPS any candidate whose own
  // effectiveFrom is on/after the NEW effectiveFrom being set (a separate
  // fix for a separate real bug: an out-of-order edit, effective earlier
  // than an already-recorded later change, used to leave that later
  // change sitting in history to wrongly outrank the new one). One
  // consequence: the very first edit's anchorDate-same-day fallback entry
  // (effectiveFrom === anchorDate === the chosen effectiveFrom here) no
  // longer gets recorded at all — there's nothing before the anchor date
  // for it to ever have described anyway. So this sequence now produces
  // a single, clean entry rather than two duplicate-dated ones; the
  // still-messier literal shape below ("Pre-existing corrupted data
  // self-heals") is tested separately and remains fully self-healing.
  check('amountHistory records a single clean entry for the £40 week (no more duplicate-dated entries need to be produced going forward)', afterEdit2.amountHistory, [{ effectiveFrom: '2026-08-29', amount: 40 }])
  check('The one genuine week at £40 is visible on its own date', resolveTemplateAmount(afterEdit2, '2026-08-29'), 40)
  check('A date between the two changes still resolves to £40', resolveTemplateAmount(afterEdit2, '2026-09-01'), 40)
  check('From the second effective date onward, back to £150', resolveTemplateAmount(afterEdit2, '2026-09-05'), 150)
  check('...and further out', resolveTemplateAmount(afterEdit2, '2026-09-19'), 150)
}

// ── Self-healing check against the literal corrupted data as it existed
// in the uploaded backup — same shape, reproduced directly rather than
// re-derived, in case the two above ever drift from the real repro. ────
{
  const corrupted: RecurringTemplate = {
    ...baseTemplate,
    amount: 150,
    amountEffectiveFrom: '2026-09-05',
    amountHistory: [
      { effectiveFrom: '2026-08-29', amount: 150 },
      { effectiveFrom: '2026-08-29', amount: 40 },
    ],
  }
  check('Pre-existing corrupted data self-heals: 08-29 resolves to £40', resolveTemplateAmount(corrupted, '2026-08-29'), 40)
  check('Pre-existing corrupted data self-heals: 09-05 resolves to £150', resolveTemplateAmount(corrupted, '2026-09-05'), 150)
}

// ── A tie between two candidates where the amountHistory array itself
// (not history-vs-current) has duplicate dates, unrelated to the specific
// bug above — same fix, same behaviour: last-recorded wins. ────────────
{
  const t: RecurringTemplate = {
    ...baseTemplate,
    amount: 999, // deliberately not involved in the tie, to isolate the history-only case
    amountEffectiveFrom: '2027-01-01',
    amountHistory: [
      { effectiveFrom: '2026-05-01', amount: 10 },
      { effectiveFrom: '2026-05-01', amount: 20 },
      { effectiveFrom: '2026-05-01', amount: 30 },
    ],
  }
  check('Three-way tie in history alone: the last-recorded entry wins', resolveTemplateAmount(t, '2026-06-01'), 30)
}

// ── No history at all — completely unaffected by the fix. ──────────────
check('A template with no history at all is unaffected', resolveTemplateAmount(baseTemplate, '2026-08-29'), 150)

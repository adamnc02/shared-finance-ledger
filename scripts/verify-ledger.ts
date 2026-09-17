import { ukBankHolidays, isUkBankHoliday, isWorkingDay, resolvePayday, cycleBoundsForDate, cycleOffset } from '../src/lib/payCycle'
import { pickIconForName, pickColorForIndex, createCategory, defaultCategories, removeCategorySafely, visibleCategoriesFor } from '../src/lib/categories'
import { toLocalIsoDate } from '../src/lib/date'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { computeRunningBalanceSummary, computeClearedRunningBalanceList, signedAmount } from '../src/lib/runningBalance'
import { CREDIT_CARD_CATEGORY_ID, SAVINGS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2 } from '../src/types/ledger'
import type { Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok =
    typeof actual === 'number' && typeof expected === 'number'
      ? Math.abs(actual - expected) <= tolerance
      : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ---- 1. UK bank holidays 2026, cross-checked against gov.uk published dates ----
const holidays2026 = ukBankHolidays(2026).map(fmt).sort()
check('2026 bank holidays (England & Wales)', holidays2026, [
  '2026-01-01', // New Year's Day (Thu) — no substitution needed
  '2026-04-03', // Good Friday
  '2026-04-06', // Easter Monday
  '2026-05-04', // Early May bank holiday
  '2026-05-25', // Spring bank holiday
  '2026-08-31', // Summer bank holiday
  '2026-12-25', // Christmas Day (Fri) — no substitution needed
  '2026-12-28', // Boxing Day substitute (26th is a Saturday)
].sort())

// ---- 2. Weekend/holiday substitution edge cases ----
check('2027 Jan 1 is a Friday, not a bank-holiday-observed weekend', isUkBankHoliday(new Date(2027, 0, 1)), true) // Fri, real holiday
check('A random Tuesday is not a bank holiday', isUkBankHoliday(new Date(2026, 5, 9)), false)
check('Saturday is not a working day', isWorkingDay(new Date(2026, 5, 6)), false) // 6 Jun 2026 = Saturday
check('Bank holiday Monday is not a working day', isWorkingDay(new Date(2026, 3, 6)), false) // Easter Monday

// ---- 3. Payday resolution ----
// Nov 2026: the 28th is a Saturday. With adjustment on, payday should
// walk back to Friday 27th (a normal working day).
const nov2026Payday = resolvePayday(2026, 10, 28, true)
check('Nov 2026 payday (28th, adjusted) lands on Fri 27th', fmt(nov2026Payday), '2026-11-27')

const nov2026PaydayUnadjusted = resolvePayday(2026, 10, 28, false)
check('Nov 2026 payday (28th, unadjusted) stays on the nominal Saturday', fmt(nov2026PaydayUnadjusted), '2026-11-28')

// Aug 2026: the 31st is a bank holiday (Summer bank holiday, itself a
// Monday) — should walk back past both the holiday AND the weekend
// before it, landing on the preceding Friday.
const aug2026Payday = resolvePayday(2026, 7, 31, true)
check('Aug 2026 payday (31st, a bank holiday Monday) lands on Fri 28th', fmt(aug2026Payday), '2026-08-28')

// A weekday payday should never move.
const mar2026Payday = resolvePayday(2026, 2, 15, true) // 15 Mar 2026 = Sunday
check('Mar 2026 payday (15th, a Sunday) lands on Fri 13th', fmt(mar2026Payday), '2026-03-13')

// ---- 4. Cycle boundaries (14th–13th, per the doc's example) ----
const boundsInMiddle = cycleBoundsForDate(new Date(2026, 7, 20), 14) // 20 Aug 2026
check('Cycle containing 20 Aug 2026 (14th boundary) starts 14 Aug', fmt(boundsInMiddle.start), '2026-08-14')
check('Cycle containing 20 Aug 2026 (14th boundary) ends 13 Sep', fmt(boundsInMiddle.end), '2026-09-13')

const boundsBeforeBoundary = cycleBoundsForDate(new Date(2026, 7, 5), 14) // 5 Aug 2026, before the 14th
check('Cycle containing 5 Aug 2026 (14th boundary) starts 14 Jul (previous cycle)', fmt(boundsBeforeBoundary.start), '2026-07-14')

const boundsOnBoundary = cycleBoundsForDate(new Date(2026, 7, 14), 14) // exactly on the boundary
check('Cycle containing 14 Aug 2026 itself starts that same day', fmt(boundsOnBoundary.start), '2026-08-14')

check(
  'cycleOffset finds the cycle two ahead of the reference cycle',
  cycleOffset(new Date(2026, 9, 20), new Date(2026, 7, 20), 14), // 20 Oct vs. 20 Aug reference, both mid-cycle
  2,
)

// ---- 5. Category auto-assignment ----
check('"Netflix" maps to the streaming icon', pickIconForName('Netflix'), 'streaming')
check('"Council Tax" maps to council_tax, not the broader "home"', pickIconForName('Council Tax'), 'council_tax')
check('"Something entirely novel" falls back to the default icon', pickIconForName('Something entirely novel'), 'receipt')
check('First category gets the first palette colour', pickColorForIndex(0), '#ff5b4c')
check('Second category gets the second palette colour (round-robin, not repeated)', pickColorForIndex(1), '#ff8a3d')

const cat1 = createCategory('Electricity', [])
const cat2 = createCategory('Spotify', [cat1])
check('createCategory: Electricity picks the electricity icon', cat1.icon, 'electricity')
check('createCategory: two categories in a row get different colours', cat1.iconColor === cat2.iconColor, false)

const seeded = defaultCategories()
check('defaultCategories seeds the reserved Credit Card category', seeded.some((c) => c.id === CREDIT_CARD_CATEGORY_ID), true)
check('the seeded Credit Card category is marked built-in', seeded.find((c) => c.id === CREDIT_CARD_CATEGORY_ID)?.isBuiltIn, true)
check('defaultCategories seeds one category per remaining icon (35 icons - 3 reserved/fallback = 32) plus the 3 built-ins', seeded.length, 35)
check('The full icon library is represented (e.g. "Council Tax" from council_tax) — the old icon list, not a curated subset', seeded.some((c) => c.name === 'Council Tax'), true)
check('"TV" gets its name-override, not a raw title-case "Tv"', seeded.find((c) => c.icon === 'tv')?.name, 'TV')
check('Seeded (non-built-in) categories ARE deletable, unlike the 3 locked defaults', seeded.find((c) => c.name === 'Council Tax')?.isBuiltIn, undefined)

check('removeCategorySafely refuses to delete a built-in category', removeCategorySafely(seeded, CREDIT_CARD_CATEGORY_ID).length, seeded.length)
const withUserCategory = [...seeded, cat1]
check('removeCategorySafely deletes an ordinary (non-built-in) category', removeCategorySafely(withUserCategory, cat1.id).length, seeded.length)
check('removeCategorySafely is a no-op for an id that does not exist', removeCategorySafely(seeded, 'nonexistent-id').length, seeded.length)

// ---- 6. Running balance ----
const groceries: Transaction = {
  id: 'a',
  date: '2026-08-15',
  amount: 40,
  direction: 'out',
  categoryId: 'food',
  paymentMethod: 'card',
  status: 'cleared',
  type: 'expense',
  location: 'personal',
  ownerId: 'me',
}
const salary: Transaction = {
  id: 'b',
  date: '2026-08-14',
  amount: 2000,
  direction: 'in',
  categoryId: 'income',
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'salary',
  location: 'personal',
  ownerId: 'me',
  personId: 'me',
}
const upcomingBill: Transaction = {
  id: 'c',
  date: '2026-08-25',
  amount: 60,
  direction: 'out',
  categoryId: 'internet',
  paymentMethod: 'direct_debit',
  status: 'pending',
  type: 'bill_payment',
  location: 'personal',
  ownerId: 'me',
}
const cardSpend: Transaction = {
  id: 'd',
  date: '2026-08-16',
  amount: 25,
  direction: 'out',
  categoryId: CREDIT_CARD_CATEGORY_ID,
  paymentMethod: 'card',
  status: 'cleared',
  type: 'credit_card_spend',
  location: 'personal',
  ownerId: 'me',
  creditCardId: 'card-1',
}

const summary = computeRunningBalanceSummary(500, [groceries, salary, upcomingBill, cardSpend])
check('clearedBalance = opening + salary - groceries (card spend excluded)', summary.clearedBalance, 500 + 2000 - 40)
check('pendingTotal reflects the one pending bill', summary.pendingTotal, -60)

const list = computeClearedRunningBalanceList(500, [groceries, salary, upcomingBill, cardSpend])
check('cleared running-balance list excludes the pending bill and the card spend', list.length, 2)
check('cleared list is chronological: salary (14th) before groceries (15th)', list[0].transaction.id, 'b')
check('running balance after salary', list[0].runningBalance, 2500)
check('running balance after groceries', list[1].runningBalance, 2460)

check('signedAmount: "out" is negative', signedAmount({ amount: 10, direction: 'out' }), -10)
check('signedAmount: "in" is positive', signedAmount({ amount: 10, direction: 'in' }), 10)

// ---- 7. Category picker filtering (Credit Card / Joint hidden when not applicable) ----
const withCard = { categories: seeded, creditCards: [{}], people: [{}] }
const withoutCard = { categories: seeded, creditCards: [], people: [{}] }
const withTwoPeople = { categories: seeded, creditCards: [], people: [{}, {}] }
const withOnePerson = { categories: seeded, creditCards: [], people: [{}] }

check('Credit Card category is hidden from the picker when no credit card exists', visibleCategoriesFor(withoutCard).some((c) => c.id === CREDIT_CARD_CATEGORY_ID), false)
check('Credit Card category IS shown once a credit card exists', visibleCategoriesFor(withCard).some((c) => c.id === CREDIT_CARD_CATEGORY_ID), true)
check('Joint category is hidden from the picker with only one person', visibleCategoriesFor(withOnePerson).some((c) => c.icon === 'joint'), false)
check('Joint category IS shown once a second person exists', visibleCategoriesFor(withTwoPeople).some((c) => c.icon === 'joint'), true)
check(
  'A currently-assigned category is never hidden, even if it would otherwise be filtered (no card exists, but this item already uses Credit Card)',
  visibleCategoriesFor(withoutCard, CREDIT_CARD_CATEGORY_ID).some((c) => c.id === CREDIT_CARD_CATEGORY_ID),
  true,
)

// ---- 8. Timezone-safe date formatting (BST off-by-one-day fix) ----
// A local-midnight Date during British Summer Time (UTC+1) — the buggy
// `.toISOString().slice(0, 10)` pattern would roll this back to the 27th.
const augustDate = new Date(2026, 7, 28) // 28 Aug 2026, local midnight, whatever timezone this runs in
check('toLocalIsoDate formats using local Y/M/D components, immune to UTC-conversion day-shift', toLocalIsoDate(augustDate), '2026-08-28')

// ---- 9. Cycle boundary drift through a short month (the missing-3rd-payday bug) ----
const fmtBounds = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// cycleStartDayOfMonth 31: August (31 days, no clamp) -> September (30
// days, clamps to 30) -> October (31 days again). Before the fix, the
// September clamp silently carried forward into October's END too,
// landing on Oct 29 instead of Oct 30 — one day short of the real
// weekend-adjusted October payday, which is exactly what made the 3rd
// upcoming payment vanish from the "next 3 cycles" view.
const augCycle = cycleBoundsForDate(new Date(2026, 7, 16), 31)
check('August cycle (31-day month, no clamp needed): start', fmtBounds(augCycle.start), '2026-07-31')
check('August cycle: end', fmtBounds(augCycle.end), '2026-08-30')

const sepCycle = cycleBoundsForDate(new Date(2026, 8, 15), 31)
check('September cycle (30-day month, clamps start to the 30th): start', fmtBounds(sepCycle.start), '2026-08-31')
check('September cycle: end (day before October\'s clamped start)', fmtBounds(sepCycle.end), '2026-09-29')

const octCycle = cycleBoundsForDate(new Date(2026, 9, 15), 31)
check("October cycle: start correctly clamped to Sep 30 (September's real length)", fmtBounds(octCycle.start), '2026-09-30')
check(
  "October cycle: end correctly returns to the 31st — NOT dragged down to the 30th by September's earlier clamp (this is the exact regression this test guards against)",
  fmtBounds(octCycle.end),
  '2026-10-30',
)

// ---- 10. Migration backfills missing built-in categories (the "Uncategorised" savings bug) ----
// Simulates data persisted BEFORE the Savings built-in category existed —
// exactly the real-world scenario that produced generated
// savings transactions with a categoryId matching nothing
// in the person's own category list, showing as "Uncategorised".
const staleData = {
  people: [],
  categories: [
    { id: CREDIT_CARD_CATEGORY_ID, name: 'Credit Card', icon: 'credit_card', iconColor: '#ff5b4c', isBuiltIn: true },
    { id: 'my-custom-category', name: 'My Custom One', icon: 'coffee', iconColor: '#4cd08a' },
  ],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  transactions: [],
  payCycles: [],
  pensions: [],
  scenarios: [],
  primaryPersonId: '',
} as unknown as AppDataV2
const migrated = migrateLedgerData(staleData)
check('Migration adds the missing Savings built-in category', migrated.categories.some((c) => c.id === SAVINGS_CATEGORY_ID), true)
check('Migration leaves the already-present Credit Card category untouched (not duplicated)', migrated.categories.filter((c) => c.id === CREDIT_CARD_CATEGORY_ID).length, 1)
check("Migration never touches the person's own custom category", migrated.categories.some((c) => c.id === 'my-custom-category' && c.name === 'My Custom One'), true)

// ---- 11. Cycle boundary through February — both non-leap and leap years ----
// The same drift bug that hid the October payday (test group 9) could
// equally have manifested around February — a 28-or-29-day month is
// exactly the kind of short month that clamping needs to handle
// correctly, and get right again the moment a longer month follows.
// daysInMonth here is computed via native Date arithmetic (`new
// Date(year, month+1, 0).getDate()`), which already knows the leap-year
// rule correctly — this test exists to prove that, not to reimplement it.

// 2026 is NOT a leap year — February has 28 days.
const febCycle2026 = cycleBoundsForDate(new Date(2026, 1, 15), 31)
check('Feb 2026 (28 days) cycle start clamps day 31 down to the 28th', fmtBounds(febCycle2026.start), '2026-01-31')
check('Feb 2026 cycle end (day before March\'s clamped start)', fmtBounds(febCycle2026.end), '2026-02-27')

const marCycle2026 = cycleBoundsForDate(new Date(2026, 2, 15), 31)
check("Mar 2026 cycle start correctly clamped to Feb 28 (February's real length)", fmtBounds(marCycle2026.start), '2026-02-28')
check(
  "Mar 2026 cycle end correctly returns to the 31st — NOT dragged down by February's earlier clamp (same regression class as test group 9, now for February specifically)",
  fmtBounds(marCycle2026.end),
  '2026-03-30',
)

// 2028 IS a leap year — February has 29 days. The clamp should land one day later than 2026's.
const febCycle2028 = cycleBoundsForDate(new Date(2028, 1, 15), 31)
check('Feb 2028 (a leap year, 29 days) cycle start clamps day 31 down to the 29th, not the 28th', fmtBounds(febCycle2028.start), '2028-01-31')
check('Feb 2028 cycle end (day before March\'s clamped start) lands on the 28th, one day later than the 2026 case', fmtBounds(febCycle2028.end), '2028-02-28')

const marCycle2028 = cycleBoundsForDate(new Date(2028, 2, 15), 31)
check("Mar 2028 cycle start correctly clamped to Feb 29 (leap year's real length)", fmtBounds(marCycle2028.start), '2028-02-29')
check("Mar 2028 cycle end correctly returns to the 31st, unaffected by the leap-year clamp", fmtBounds(marCycle2028.end), '2028-03-30')


process.exit(failures === 0 ? 0 : 1)

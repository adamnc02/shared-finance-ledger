// Scrolling lists inside a swipe-to-delete row must not start the swipe.
//
// Adam, 2026-09-19: "blocking the swipe left to delete from inside the
// scrollable manage upcoming payments area … wasn't the case on any of these
// scrollable lists anymore." SwipeToDelete skips any touch inside a
// [data-no-swipe] region (2026-09-16, pot checklist). The "Manage upcoming
// payments" card never had it, so on all 7 lists a drag meant to scroll
// could reveal the row's delete button instead.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: the PausedOccurrencesControl check.

import { readFileSync } from 'node:fs'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}
const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')

const swipe = read('components/SwipeToDelete.tsx')
check('SwipeToDelete skips [data-no-swipe] regions', /closest\([^)]*\[data-no-swipe\]/.test(swipe), true)

const control = read('components/PausedOccurrencesControl.tsx')
check('Manage upcoming payments card is a no-swipe region', /<div data-no-swipe[^>]*>\s*<button onClick=\{toggleExpanded\}/.test(control), true)
check('…and its scrolling list does not drag the page', /max-h-72 overflow-y-auto overscroll-contain/.test(control), true)

check("pot's \"What this pot pays\" checklist is still a no-swipe region", /data-no-swipe\s+className="flex flex-col divide-y overflow-y-auto/.test(read('pages/Salary.tsx')), true)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')

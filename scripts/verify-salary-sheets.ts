// The Salary page's cards open a sheet (components/RowSheet.tsx) rather
// than expanding in place: pay periods, pensions, savings pots, pots and the
// joint account. A card that expands in place pushes the rest of the page
// down and buries the cards below it.
//
// 🚨 THE ONE EXCEPTION IS THE SALARY CARD ITSELF. It still expands in place,
// open on the primary person on arrival, so their pay periods are in view the
// moment Wallet is tapped — each pay period then opens a sheet. Making the
// salary card a sheet hides the pay periods behind a tap, and (opening on
// arrival) covers the page.
//
//  1. every OTHER `{isOpen && (` on the page opens a RowSheet;
//  2. the opens-a-sheet mark is OpensSheetIcon, on the five kinds of card
//     that open one; the salary card is the only chevron toggle;
//  3. the salary card starts expanded on the primary person, on arrival and
//     after an import, and renders inline, not in a sheet;
//  4. 🚨 the sheet sits BELOW the modal layer (z-[500]) and above the nav
//     (z-[100]). The forms inside a sheet open their own modals — a
//     deduction, "from which payment?", a category picker — and a sheet at
//     or above their level hides them behind itself.
//
// Fails on the old page: checks 1 and 2 (four of these cards expanded in
// place, with ChevronUp/ChevronDown). Fails on a page where the salary card
// is a sheet: check 3.

import { readFileSync } from 'node:fs'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 800))
  }
}

const page = readFileSync(new URL('../src/pages/Salary.tsx', import.meta.url), 'utf8')
const sheet = readFileSync(new URL('../src/components/RowSheet.tsx', import.meta.url), 'utf8')

const opens = [...page.matchAll(/\{isOpen && \(\s*\n\s*<(\w+)/g)].map((m) => m[1])
check(`the four other expandable cards open a RowSheet; the salary card renders inline (${JSON.stringify(opens)})`, JSON.stringify([...opens].sort()) === JSON.stringify(['RowSheet', 'RowSheet', 'RowSheet', 'RowSheet', 'div'].sort()), opens)

const chevronToggles = page.match(/isOpen \? <ChevronUp/g) ?? []
check('the salary card is the only chevron toggle', chevronToggles.length === 1 && /SalaryRowSummary[^\n]*\n\s*<span[^\n]*isOpen \? <ChevronUp/.test(page), chevronToggles.length)
const marks = page.match(/<OpensSheetIcon \/>/g) ?? []
check(`the opens-a-sheet mark is on the five kinds of card that open one (${marks.length})`, marks.length === 5, marks.length)

const personState = page.slice(page.indexOf('const [expandedPersonId'), page.indexOf('const [expandedPersonId') + 120)
check('the salary card starts expanded on the primary person', personState.includes('useState<string | null>(data.primaryPersonId ?? null)'), personState)
check('…and an import puts it back there', page.includes('setExpandedPersonId(data.primaryPersonId ?? null)'))
check('the salary card is never a sheet', !page.includes('· Salary`'))

const joint = readFileSync(new URL('../src/components/JointAccountSetupModal.tsx', import.meta.url), 'utf8')
check('the joint account sheet has the same X close, on its closeable edit path only', /\{dismissable && \(\s*<button onClick=\{onCancel\}[^>]*aria-label="Close"/.test(joint))

const z = Number(sheet.match(/fixed inset-0 z-\[(\d+)\]/)?.[1])
check(`the sheet is below the modals and above the nav (z-[${z}])`, z > 100 && z < 500, z)
check('the sheet is portalled to document.body (APP-KNOWLEDGE §1.9)', sheet.includes('createPortal(') && sheet.includes('document.body'))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
if (failures > 0) process.exit(1)

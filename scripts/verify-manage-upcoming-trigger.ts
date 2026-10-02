// The "Manage upcoming payments" trigger is ONE control, on every form that
// has one, in both of its states.
//
// It is a full-width pill with its text and chevron centred together, carrying
// CancelButton's surface colour and border but white text, and one step
// shorter than Cancel so a form's Cancel/Save pair still reads as the primary
// pair on the card. The chevron points down to expand and up to collapse.
//
// THE TRAP: the collapsed and expanded triggers used to be two separate
// `<button>` literals a few lines apart in the same file, with different
// classes (the expanded one carried `mb-2 text-left`). Restyling one and not
// the other is invisible until a form is opened AND closed, which no check
// and no quick look at a screen does. They are now one component, and the
// checks below fail if a second bare `toggleExpanded` button reappears.
//
// The height relation is asserted against CancelButton's OWN classes rather
// than a hardcoded `py-2`, so restyling Cancel cannot silently make this
// button the taller of the two.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: every check except the call-site count.

import { readFileSync } from 'node:fs'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}
const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')

const control = read('components/PausedOccurrencesControl.tsx')
const buttons = read('components/FormButtons.tsx')

console.log('\n── One control, not two ──')

const trigger = control.match(/function ManageUpcomingTrigger\([\s\S]*?\n}/)?.[0] ?? ''
check('a single shared ManageUpcomingTrigger exists', trigger.length > 0, true)
check('…and it is the only one', (control.match(/function ManageUpcomingTrigger\(/g) ?? []).length, 1)
// The pre-fix shape: two bare <button onClick={toggleExpanded}> literals.
check('no bare toggleExpanded button is left behind', /<button onClick=\{toggleExpanded\}/.test(control), false)
// ONE element, rendered unconditionally. Two elements — one per branch of a
// ternary — is what let the expanded copy sit inside the panel and jump 12px
// down the moment the section opened.
check('the trigger is rendered exactly once', (control.match(/<ManageUpcomingTrigger/g) ?? []).length, 1)
check('…unconditionally, so expanding cannot move it', /<ManageUpcomingTrigger\n[\s\S]{0,260}?\/>\s*\{expanded && \(/.test(control), true)
check('…and it is OUTSIDE the collapsible panel', /<ManageUpcomingTrigger[\s\S]*?<div data-no-swipe/.test(control), true)
check('the panel carries its own top margin instead', /<div data-no-swipe className="mt-2 rounded-xl p-3"/.test(control), true)

console.log('\n── The pill ──')

check('full width', /\bw-full\b/.test(trigger), true)
check('text and chevron centred as one group', /\bjustify-center\b/.test(trigger), true)
check('pill, not a rounded rectangle', /\brounded-full\b/.test(trigger), true)
check('white text', /\btext-white\b/.test(trigger), true)

console.log('\n── Cancel\'s border and a lighter fill ──')

const cancel = buttons.match(/export function CancelButton\([\s\S]*?\n}/)?.[0] ?? ''
check('CancelButton was found to compare against', cancel.length > 0, true)
check('same 1px track border', /border: '1px solid var\(--color-track\)'/.test(trigger), true)
// The fill is a translucent white, not a palette colour: the control appears
// on an ordinary --color-surface card AND on the --color-bg-elevated panel, and
// an overlay lands slightly lighter than whichever is behind it. A fixed
// --color-surface fill was invisible on a surface card — only the border showed.
check('a translucent white fill, not a fixed palette colour', /background: 'rgba\(255,255,255,0\.08\)'/.test(trigger), true)
check('…and no fixed surface fill is left behind', /background: 'var\(--color-surface\)'/.test(trigger), false)

const py = (s: string) => Number(s.match(/\bpy-([\d.]+)\b/)?.[1] ?? NaN)
const textPx = (s: string) => ({ xs: 12, sm: 14, base: 16 })[s.match(/\btext-(xs|sm|base)\b/)?.[1] ?? ''] ?? NaN
check('shorter vertical padding than Cancel', py(trigger) < py(cancel), true)
check('…and smaller text than Cancel', textPx(trigger) < textPx(cancel), true)

console.log('\n── The chevron direction ──')

check('up when expanded, down when collapsed', /const Chevron = expanded \? ChevronUp : ChevronDown/.test(trigger), true)

console.log('\n── Every form that has one ──')

// Adam's scope: "all forms where this button is visible". One component means
// one restyle, but only if every form really does route through it.
const callSites = (f: string) => (read(f).match(/<PausedOccurrencesControl/g) ?? []).length
const sites = { 'pages/Bills.tsx': callSites('pages/Bills.tsx'), 'pages/Salary.tsx': callSites('pages/Salary.tsx'), 'pages/Expenses.tsx': callSites('pages/Expenses.tsx') }
console.log(`  (call sites: ${JSON.stringify(sites)})`)
check('all 7 call sites share the one component', Object.values(sites).reduce((a, b) => a + b, 0), 7)
// Every page mentions the phrase in its comments (the feature is named in
// half the engine's provenance notes), so the comments have to come off
// before this means anything. Block comments, then whole-line `//` and `*`
// lines — never an inline `//`, which would eat a URL inside a string.
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
// The control: `code` must strip a commented mention and keep a rendered one.
check('(control) comment stripping keeps real markup and drops comments', [/Manage upcoming payments/.test('  // Manage upcoming payments\nconst a = 1'.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')), /Manage upcoming payments/.test('<button>Manage upcoming payments</button>'.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n'))], [false, true])
check('no form hand-rolls its own trigger', /Manage upcoming payments/.test(code('pages/Bills.tsx') + code('pages/Salary.tsx') + code('pages/Expenses.tsx')), false)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')

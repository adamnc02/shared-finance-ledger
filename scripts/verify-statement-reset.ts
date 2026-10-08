// The statement's "Reset to default" puts every VIEW setting back as the file
// opened — and nothing else.
//
// THE TRAPS this guards:
// 1. Capturing the defaults late. `state` is mutated during start-up
//    (rebuildCategoryFilter, the first render). A snapshot taken after any of
//    that is "how it looked after start-up", not the file's own default.
// 2. A hand-written list of what to reset. The next setting added to `state`
//    would be silently left out. The reset copies EVERY key of the snapshot.
// 3. Resetting what is not a view setting. The account being looked at and the
//    theme survive a reset.
// 4. Controls render() never sets from state. "Show cleared" and the Direction
//    filter are only ever read from the DOM, so a reset that only touches
//    `state` leaves them showing the old choice while the table shows the new.
//
// Driven in headless Chromium on a statement built from the real 2026-10-05
// file: opens disabled, any change enables it, ten changes across View, Range,
// Show cleared, account, theme, Analysis preset/layout/value and Direction all
// reset except account and theme, and it disables itself again.

import { readFileSync } from 'node:fs'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const t = readFileSync(new URL('../src/statement/statement-template.html', import.meta.url), 'utf8')
const script = t.slice(t.indexOf('var state = {'))

console.log('\n── The snapshot ──')
const stateEnd = script.indexOf('\n  };\n') + 5
const snapshotAt = script.indexOf('var DEFAULTS = JSON.stringify(state)')
check('taken immediately after the state literal', snapshotAt > stateEnd && script.slice(stateEnd, snapshotAt).trim().startsWith('/*'), true)
check('…before anything writes to state', /state\.\w+(\.\w+)?\s*=[^=]/.test(script.slice(0, snapshotAt)), false)

console.log('\n── The view it opens in, which is what a reset returns to ──')
// The literal itself, evaluated — not a regex over it, so a comment or a
// reordering cannot fool the check.
const literal = script.slice(script.indexOf('{'), stateEnd - 1)
const openState = (src: string) => new Function('CARDS', `return ${src}`)([{ id: 'c' }]) as { mode: string; group: string; range: string }
check('opens in Statement', openState(literal).mode, 'statement')
check('opens Flat, not Per day', openState(literal).group, 'flat')
check('opens on Full cycles', openState(literal).range, 'full')
// Control: the same reader on a Per-day literal reports 'day', so the check above can fail.
check('control: a Per-day literal reads as day', openState(literal.replace("group: 'flat'", "group: 'day'")).group, 'day')

console.log('\n── What a reset covers ──')
const handler = script.slice(script.indexOf("getElementById('resetView').addEventListener"), script.indexOf("var drawerBtn"))
check('every key of the snapshot is restored', handler.includes('Object.keys(fresh).forEach(function (k) { state[k] = fresh[k]; })'), true)
check('kept: exactly the account and the theme', /var KEPT_ON_RESET = \['card', 'theme'\];/.test(script), true)
check('"Show cleared" checkbox is set back', handler.includes("getElementById('showCleared').checked = state.showCleared"), true)
check('the Direction filter is set back', handler.includes("getElementById('pvDir').value = state.pivot.dir"), true)
check('the Category filter is rebuilt (it resets itself to All)', handler.includes('rebuildCategoryFilter()'), true)
check('the field panel and the table are redrawn', handler.includes('renderPanel()') && handler.includes('render()'), true)

console.log('\n── Disabled when there is nothing to reset ──')
check('syncSegs, which every render ends with, sets disabled', /resetView'\)\.disabled = viewSettings\(state\) === viewSettings\(JSON\.parse\(DEFAULTS\)\)/.test(script), true)

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)

// The laptop view's per-device state (src/lib/laptop.ts) and its breakpoint.
//
// The trap this guards: Listly's first laptop rail stored its collapsed
// flag on every first load, so a stored value recorded the default rather
// than a choice. Here the rail is EXPANDED unless the person collapsed it,
// and only the collapse button writes. Section 1's control shows the old
// shape failing: a store that writes on read leaves a value behind with
// no click at all.
//
// 1. An empty or unreadable store means expanded, and reading writes nothing.
// 2. Collapse → reload reads collapsed; expand → reload reads expanded; the
//    write keeps any other key in the state object.
// 3. A store that throws (private mode) reads expanded and the write is a no-op.
// 4. The breakpoint: a sideways phone stays on the phone layout.
// 5. Source checks: only Rail's toggle writes; App hides the pill when wide;
//    SwipeToDelete never captures the pointer before a drag (a mouse click
//    on a row would otherwise land on the swipe wrapper, not the row);
//    the laptop panel docks beside the page, whose pay-period tiles never
//    wrap when it narrows; the laptop Home ledger never collapses.

import { readFileSync } from 'node:fs'
import { LAPTOP_STATE_KEY, WIDE_QUERY, readRailExpanded, writeRailExpanded } from '../src/lib/laptop'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

function memoryStore(initial?: string) {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(LAPTOP_STATE_KEY, initial)
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

console.log('\n── 1. Absent means expanded, and reading writes nothing ──')
{
  const s = memoryStore()
  check('empty store reads expanded', readRailExpanded(s), true)
  check('reading left the store empty', s.map.size, 0)
  check('unparseable value reads expanded', readRailExpanded(memoryStore('{not json')), true)
  check('a non-object value reads expanded', readRailExpanded(memoryStore('7')), true)
  // Control: the shape Listly shipped first — a read that stores the default.
  const bad = memoryStore()
  const readAndStoreDefault = () => { const v = readRailExpanded(bad); writeRailExpanded(v, bad); return v }
  readAndStoreDefault()
  check('CONTROL: a write-on-read store has a value with no click', bad.map.has(LAPTOP_STATE_KEY), true)
}

console.log('\n── 2. Only a choice is remembered ──')
{
  const s = memoryStore(JSON.stringify({ other: 'kept' }))
  writeRailExpanded(false, s)
  check('after Collapse, a reload reads collapsed', readRailExpanded(s), false)
  writeRailExpanded(true, s)
  check('after Expand, a reload reads expanded', readRailExpanded(s), true)
  check('other keys survive the write', JSON.parse(s.map.get(LAPTOP_STATE_KEY)!).other, 'kept')
}

console.log('\n── 3. A store that throws ──')
{
  const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  check('reads expanded', readRailExpanded(throwing), true)
  let threw = false
  try { writeRailExpanded(false, throwing) } catch { threw = true }
  check('write does not throw', threw, false)
  check('no storage at all reads expanded', readRailExpanded(undefined), true)
}

console.log('\n── 4. The breakpoint ──')
{
  const min = (dim: string) => Number(new RegExp(`min-${dim}: (\\d+)px`).exec(WIDE_QUERY)?.[1])
  const isWide = (w: number, h: number) => w >= min('width') && h >= min('height')
  check('laptop 1440×900 is wide', isWide(1440, 900), true)
  check('small laptop window 1024×600 is wide', isWide(1024, 600), true)
  check('iPhone on its side 932×430 is NOT wide', isWide(932, 430), false)
  check('iPhone upright 430×932 is NOT wide', isWide(430, 932), false)
  check('iPad landscape 1180×820 is wide', isWide(1180, 820), true)
}

console.log('\n── 5. Source checks ──')
{
  const rail = readFileSync(new URL('../src/components/Rail.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  check('Rail writes the state in exactly one place', (rail.match(/writeRailExpanded\(/g) ?? []).length, 1)
  check('that place is the toggle', /function toggle\(\)[\s\S]{0,120}writeRailExpanded\(/.test(rail), true)
  check('Rail never imports an icon file (each app shows its own)', /import [^\n]*\.(png|svg)['"]/.test(rail), false)
  check('App hides the pill when wide', app.includes('{!wide && <BottomNav />}'), true)
  check('App shows the rail when wide', app.includes('{wide && <Rail />}'), true)
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  check('index.css laptop block uses WIDE_QUERY word for word', css.includes(`@media ${WIDE_QUERY} {`), true)
  const sheet = readFileSync(new URL('../src/components/RowSheet.tsx', import.meta.url), 'utf8')
  const swipe = readFileSync(new URL('../src/components/SwipeToDelete.tsx', import.meta.url), 'utf8')
  const down = swipe.slice(swipe.indexOf('function handlePointerDown'), swipe.indexOf('function handlePointerMove'))
  check('SwipeToDelete takes no pointer capture on pointerdown (a mouse click would never reach the row)', down.includes('setPointerCapture'), false)
  check('…and takes it once the drag passes the threshold', /Math\.abs\(delta\) > DRAG_THRESHOLD[\s\S]{0,900}setPointerCapture/.test(swipe), true)
  // The laptop panel docks in a right-hand column of the page (LaptopPanelLayout), as the laptop design draws it: opening a row narrows the page beside it.
  check('RowSheet renders into the page panel column when there is one', /dock \?\? document\.body/.test(sheet), true)
  check('every page with panels lays out a panel column', ['Salary', 'Loans', 'Bills', 'Expenses'].every((pg) => readFileSync(new URL(`../src/pages/${pg}.tsx`, import.meta.url), 'utf8').includes('<LaptopPanelLayout>')), true)
  // 🚨 …and a page with a docked panel must not wrap when it narrows: the pay-period tiles share one row.
  const salary = readFileSync(new URL('../src/pages/Salary.tsx', import.meta.url), 'utf8')
  check('the pay-period tiles are one row that never wraps (grid-flow-col)', /const row = 'grid grid-flow-col auto-cols-\[minmax\(0,1fr\)\]/.test(salary) && !/repeat\(auto-fill,minmax\(150px,1fr\)\)/.test(salary), true)
  const home = readFileSync(new URL('../src/pages/Home.tsx', import.meta.url), 'utf8')
  const marker = '// Laptop (lib/laptop.ts): one flat table, never collapsible.'
  // The laptop branch runs from the marker to the phone's own `return (` at function level (two-space indent).
  const laptopLedger = home.slice(home.indexOf(marker), home.indexOf('\n  return (\n', home.indexOf(marker)))
  check('the slice is the whole laptop branch, not a stub (a check that reads nothing passes vacuously)', laptopLedger.split('\n').length > 25, true)
  check('the laptop ledger exists and is one flat table', home.includes(marker) && laptopLedger.includes('<LedgerHeader />'), true)
  check('…with nothing in it that collapses (no toggle, no chevron)', /toggle\(|Chevron/.test(laptopLedger), false)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n✗ ${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

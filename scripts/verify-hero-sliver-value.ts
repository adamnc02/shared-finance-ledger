// Home's card stack: each card behind the front one shows its current figure in
// its header strip while the stack is fanned out — and nowhere else.
//
// THE TRAPS this guards (each one was a plausible "tidy-up"):
// 1. A symmetric fade. The strips shrink over 0.5s on collapse, so a figure that
//    fades out is seen sliding under the card in front. Hiding must be instant;
//    only showing is animated, after the fan-out.
// 2. Clipping the figure. With a long pot or loan name, a truncated amount reads
//    as a different amount ("£10,643." for £10,643.36). The figure sits on the
//    card-type row, left of the type, and is never truncated; the name is kept
//    to one line while it shows, so that row stays inside the visible strip.
// 3. The front card. Its full rows are already on show; the strip figure belongs
//    to the back cards only, so the context is provided to them alone.
// 4. A hero face added later without a figure. Every BankCard in DeckHero passes
//    `sliverValue`.
//
// Behaviour was driven in headless Chromium against the real 2026-10-05 file
// (collapsed: all hidden; fanning out: still hidden; expanded: every back card
// shown, front hidden; 30 ms into a collapse: all hidden). This script pins the
// source shapes that behaviour depends on.

import { readFileSync } from 'node:fs'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const bankCard = read('src/components/BankCard.tsx')
const stack = read('src/components/WalletStack.tsx')
const home = read('src/pages/Home.tsx')

console.log('\n── Showing and hiding ──')
check('hiding has no transition; showing is delayed past the fan-out', /transition: showSliver \? 'opacity [^']*ease 0\.\d+s' : 'none'/.test(bankCard), true)
check('the figure is never truncated', /data-sliver-value[\s\S]{0,200}whitespace-nowrap/.test(bankCard) && !/data-sliver-value[\s\S]{0,200}truncate/.test(bankCard), true)
check('the figure sits on the card-type row, left of the type', /data-sliver-value[\s\S]{0,600}\{accountLabel && <span/.test(bankCard) && bankCard.indexOf('data-sliver-value') > bankCard.indexOf('{bankLabel}'), true)
check('…the name truncates instead, only while the figure shows', /showSliver && sliverValue !== undefined \? 'truncate' : ''/.test(bankCard), true)

console.log('\n── Which cards ──')
const providers = stack.match(/<StackSliverContext\.Provider value=\{expanded\}>/g) ?? []
check('exactly one provider, on the back-card branch', providers.length, 1)
const frontBranch = stack.slice(stack.indexOf('if (isFront) {'), stack.indexOf('if (isFront) {') + 900)
check('the front card is rendered without it', frontBranch.includes('StackSliverContext'), false)
check('the single-card case is rendered without it', stack.slice(stack.indexOf('if (n === 1)'), stack.indexOf('if (n === 1)') + 400).includes('StackSliverContext'), false)

console.log('\n── Every hero face has a figure ──')
const deckHero = home.slice(home.indexOf('function DeckHero('), home.indexOf('function DeckDetail('))
const cards = deckHero.match(/<BankCard [^\n]*/g) ?? [] // one line per opening tag; an icon prop holds its own `>`
const withoutFigure = cards.filter((c) => !c.includes('sliverValue=') && !c.includes('accountLabel="Personal">')).length
check('BankCards in DeckHero', cards.length, 8)
check('all but the no-pay-cycle placeholder pass sliverValue', withoutFigure, 0)
check('…and the placeholder is the only one without', cards.filter((c) => !c.includes('sliverValue=')).length, 1)

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)

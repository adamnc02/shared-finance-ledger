// A transfer that is not yours says whose it is.
//
// Page-level household visibility hides the other person's rows, but JOINT
// rows stay visible to both people on purpose (householdView.ts, and the
// Bills rule "show all joint bills regardless of owner"). So on the
// Transactions → Transfers page, a transfer in or out of the joint account may
// be the other person's with nothing on the row to say so. The OwnerBadge
// answers that, on both row types on that page: one-off transfers and
// recurring ones.
//
// THE RULES, and each is a thing a later change could quietly get wrong:
//
//  1. The badge marks the EXCEPTION, never every row. Badging all of them puts
//     the viewer's own name on nearly every line, which is noise — the same
//     rule the Bills page's "Joint" and pot pills already follow.
//  2. With ONE person in the app no badge can ever render, because nothing is
//     someone else's. This is the control below, and it is the half most
//     likely to regress: `ownerId !== primaryPersonId` looks like the obvious
//     test and is true for an unowned row in a single-person household.
//  3. Unowned (`ownerId: ''`) is nobody's, so it gets no badge either. Every
//     joint bill in the real production file carries an empty ownerId.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: every check under "Both row types".

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { isSomeoneElses } from '../src/lib/householdView'
import type { AppDataV2 } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}
const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
const load = (file: string): AppDataV2 => {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}
const prod = load('finance-ledger-backup-2026-09-22-PROD.json')
const solo = load('finance-ledger-backup-2026-09-20-mum.json')

// The page's own rule, as the page computes it.
const badgeFor = (data: AppDataV2, ownerId: string | undefined) =>
  isSomeoneElses(data, ownerId) ? data.people.find((p) => p.id === ownerId)?.name : undefined

console.log('\n── Who gets a badge ──')

const me = prod.primaryPersonId
const them = prod.people.find((p) => p.id !== me)!
check('the other person\'s transfer is badged with their name', badgeFor(prod, them.id), 'Ella')
check('my own transfer is not badged', badgeFor(prod, me), undefined)
check('an unowned transfer is not badged', badgeFor(prod, ''), undefined)
check('a transfer owned by a person who no longer exists is not badged', badgeFor(prod, 'GONE'), undefined)

console.log('\n── The control: one person, never a badge ──')

check('the single-person file really has one person', solo.people.length, 1)
check('their own row is not badged', badgeFor(solo, solo.primaryPersonId), undefined)
check('an unowned row is not badged', badgeFor(solo, ''), undefined)
// The obvious-but-wrong rule, as the control. `ownerId !== primaryPersonId` is
// true here, so a page written that way would badge a lone user's own data.
const naive = (data: AppDataV2, ownerId: string | undefined) => ownerId !== data.primaryPersonId
check('(control) the naive ownerId !== primaryPersonId rule WOULD badge it', naive(solo, ''), true)
check('…and the real rule does not', badgeFor(solo, ''), undefined)

console.log('\n── Both row types on the Transfers page ──')

const expenses = read('pages/Expenses.tsx')
check('the page computes an owner only for someone else\'s row', /isSomeoneElses\(data, ownerId\) \? data\.people\.find/.test(expenses), true)
check('a one-off transfer row is given it', /<TransferRowItem[\s\S]{0,120}owner=\{ownerBadgeFor\(t\.ownerId\)\}/.test(expenses), true)
check('a recurring transfer row is given it too', /<TransferRecurringRow[\s\S]{0,160}owner=\{ownerBadgeFor\(template\.ownerId\)\}/.test(expenses), true)
check('both rows render the badge', (expenses.match(/<OwnerBadge name=\{owner\.name\} \/>/g) ?? []).length, 2)
check('…and only when there is an owner to show', (expenses.match(/\{owner && <OwnerBadge/g) ?? []).length, 2)

const badge = read('components/OwnerBadge.tsx')
check('the badge is the same neutral outlined pill the bill badges use', /background: 'var\(--color-surface-raised\)', border: '1px solid var\(--color-track\)', color: 'var\(--color-ink-muted\)'/.test(badge), true)
// Person.color is not an identity colour anywhere in this app; filling with it
// would be an untested contrast gamble. The file's own header explains that,
// so the comments have to come off before the assertion means anything.
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
check('(control) stripping drops a commented mention, keeps real code', [
  /person\.color/i.test(stripComments('/** not Person.color */\nconst a = 1')),
  /person\.color/i.test(stripComments('background: person.color')),
], [false, true])
check('it does not fill with Person.color', /person\.color|owner\.color/i.test(stripComments(badge)), false)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')

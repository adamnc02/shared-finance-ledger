// Page-level visibility in a shared household — and the proof it is ONLY
// page-level.
//
// With two or more people, Wallet, Bills, Transactions and Borrowing list
// only what belongs to the person this device is. The hidden rows are still
// real: they still clear, still get paid and still count in every balance.
//
// THE TRAP this guards: implementing the filter by narrowing `data` once,
// high up, and passing the smaller object down. It reads as tidier and it
// silently rewrites the household's money — the other person's bills stop
// being deducted, their pots stop being funded, and every household figure
// quietly becomes a single-person figure with nothing on screen to show it.
// The "nothing under src/lib or src/context imports householdView" check
// below is what makes that impossible to do by accident.
//
// WHAT FAILS AGAINST THE PRE-FIX CODE: every check under "Two people" and
// "The pages use it". The single-person control passes either way, which is
// the point of a control.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { isSharedHousehold, isSomeoneElses, visibleToMe, touchesJointAccount } from '../src/lib/householdView'
import { computeHouseholdProjections } from '../src/lib/householdLedger'
import type { AppDataV2, RecurringTemplate, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) failures++
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
function load(file: string): AppDataV2 {
  const raw = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))
  return migrateLedgerData(raw.data ?? raw)
}

const solo = load('finance-ledger-backup-2026-09-20-mum.json')
const prod = load('finance-ledger-backup-2026-09-22-PROD.json')

console.log('\n── The control: one person hides nothing ──')

check('the single-person file really has one person', solo.people.length, 1)
check('…so the household is not shared', isSharedHousehold(solo), false)
check('every pot is listed', visibleToMe(solo, solo.pots, (p) => p.personId).length, solo.pots.length)
check('every savings pot is listed', visibleToMe(solo, solo.savingsPots, (p) => p.personId).length, solo.savingsPots.length)
check('every loan is listed', visibleToMe(solo, solo.loans, (l) => l.ownerId).length, solo.loans.length)
check('every credit card is listed', visibleToMe(solo, solo.creditCards, (c) => c.ownerId).length, solo.creditCards.length)
check('every bill is listed', visibleToMe(solo, solo.recurringTemplates, (t) => t.ownerId).length, solo.recurringTemplates.length)
check('every transaction is listed', visibleToMe(solo, solo.transactions, (t) => t.ownerId).length, solo.transactions.length)
// Even a row owned by a person who is not the primary one — impossible to
// hide, because with one person there is nothing to hide it from.
check('an owner who is not the primary person is still shown when alone', isSomeoneElses(solo, 'SOMEONE-ELSE'), false)

console.log('\n── Two people: the real file ──')

const me = prod.people.find((p) => p.id === prod.primaryPersonId)!
const them = prod.people.find((p) => p.id !== prod.primaryPersonId)!
check('the household is shared', isSharedHousehold(prod), true)
check('this device is the first person', me.name, 'Adam')
check('the other person is the second', them.name, 'Ella')
check('my own rows are not hidden', isSomeoneElses(prod, me.id), false)
check('theirs are', isSomeoneElses(prod, them.id), true)

// The real file's own transactions: 7 Adam, 3 Ella, 1 unowned.
const theirTx = prod.transactions.filter((t) => t.ownerId === them.id)
check('the file really contains some of their transactions', theirTx.length, 3)
const visibleTx = visibleToMe(prod, prod.transactions, (t) => t.ownerId, touchesJointAccount)
check('none of their non-joint transactions is listed', visibleTx.filter((t) => t.ownerId === them.id && !touchesJointAccount(t)).length, 0)
check('…and every one of mine still is', visibleTx.filter((t) => t.ownerId === me.id).length, prod.transactions.filter((t) => t.ownerId === me.id).length)

console.log('\n── Unowned is not someone else\'s ──')

check("an empty ownerId is shown", isSomeoneElses(prod, ''), false)
check('an absent ownerId is shown', isSomeoneElses(prod, undefined), false)
check('a null ownerId is shown', isSomeoneElses(prod, null), false)
// A row pointing at a deleted person must not vanish from every page at once.
check('an owner who no longer exists is shown', isSomeoneElses(prod, 'DELETED-PERSON-ID'), false)
const unownedBills = prod.recurringTemplates.filter((t) => !t.ownerId)
check('the real file has unowned bills (this is why the rule exists)', unownedBills.length, 9)
check('…and all of them are listed', visibleToMe(prod, unownedBills, (t) => t.ownerId).length, 9)

console.log('\n── Joint is shared, whoever owns it ──')

const jointBill: RecurringTemplate = { ...prod.recurringTemplates.find((t) => t.location === 'joint')!, id: 'THEIR-JOINT-BILL', ownerId: them.id }
const personalBill: RecurringTemplate = { ...prod.recurringTemplates.find((t) => t.location === 'pot')!, id: 'THEIR-PERSONAL-BILL', ownerId: them.id, location: 'personal', potId: undefined }
const billsAsBillsPageSeesThem = (list: RecurringTemplate[]) => visibleToMe(prod, list, (t) => t.ownerId, (t) => t.location === 'joint')
check('their JOINT bill is listed', billsAsBillsPageSeesThem([jointBill]).length, 1)
check('their PERSONAL bill is not', billsAsBillsPageSeesThem([personalBill]).length, 0)

const theirJointTx: Transaction = { ...prod.transactions[0], id: 'THEIR-JOINT-TX', ownerId: them.id, location: 'joint' }
const theirPersonalTx: Transaction = { ...prod.transactions[0], id: 'THEIR-PERSONAL-TX', ownerId: them.id, location: 'personal', fromLocation: undefined, toLocation: undefined }
const theirJointTransfer: Transaction = { ...prod.transactions[0], id: 'THEIR-JOINT-TRANSFER', ownerId: them.id, type: 'transfer', location: 'personal', fromLocation: { type: 'personal' }, toLocation: { type: 'joint' } }
const txAsPageSeesThem = (list: Transaction[]) => visibleToMe(prod, list, (t) => t.ownerId, touchesJointAccount)
check('their joint-account transaction is listed', txAsPageSeesThem([theirJointTx]).length, 1)
check('their personal transaction is not', txAsPageSeesThem([theirPersonalTx]).length, 0)
check('their transfer INTO the joint account is listed', txAsPageSeesThem([theirJointTransfer]).length, 1)
check('…because a transfer is judged on its endpoints, not its location field', touchesJointAccount(theirJointTransfer), true)

console.log('\n── 🚨 The ledger is untouched ──')

// The decisive one: a bill of theirs that no page of mine lists is still
// deducted by the engine that computes the household's figures.
const withTheirBill: AppDataV2 = { ...prod, recurringTemplates: [...prod.recurringTemplates, personalBill] }
const ASOF = new Date(2026, 8, 22) // the file's own export date
const generatedFor = (data: AppDataV2) =>
  computeHouseholdProjections(data, 'three_cycles', ASOF)
    .flatMap((pp) => pp.transactions)
    .filter((t) => t.sourceId === personalBill.id).length

check('the Bills page does not list their bill', billsAsBillsPageSeesThem(withTheirBill.recurringTemplates).some((t) => t.id === personalBill.id), false)
check('…but the household engine still generates its payments', generatedFor(withTheirBill) > 0, true)
// The control: without the bill in the data, those rows do not exist — so the
// check above is reading the bill, not just any row.
check('(control) with the bill removed, the engine generates none', generatedFor(prod), 0)

console.log('\n── The filter cannot corrupt what it filters ──')

const before = prod.pots.map((p) => p.id)
const filtered = visibleToMe(prod, prod.pots, (p) => p.personId)
check('the input array is not mutated', prod.pots.map((p) => p.id), before)
check('a new array is always returned, so a caller\'s .sort() cannot reorder stored state', filtered === (prod.pots as unknown as typeof filtered), false)

console.log('\n── The pages use it, and only the pages ──')

const srcFile = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
for (const page of ['pages/Bills.tsx', 'pages/Salary.tsx', 'pages/Expenses.tsx', 'pages/Loans.tsx']) {
  check(`${page} imports the filter`, /from '\.\.\/lib\/householdView'/.test(srcFile(page)), true)
}

// Nothing below the pages may import it. An engine that filtered its own
// input would be the bug this whole file exists to prevent.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}
const root = new URL('../src/', import.meta.url).pathname
const offenders = [...walk(`${root}lib`), ...walk(`${root}context`)]
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('householdView.ts'))
  .filter((f) => /householdView/.test(readFileSync(f, 'utf8')))
  .map((f) => f.slice(root.length))
check('no engine or context file imports it', offenders, [])

console.log('\n── Every list in scope goes through the filter ──')

// A new list added to one of these pages is the likeliest way this feature
// regresses: it renders straight off `data` and shows the other person's
// rows again. Each raw render below is one that USED to exist here.
const rawRenders: [string, string][] = [
  ['pages/Salary.tsx', 'data.pots.map(('],
  ['pages/Salary.tsx', 'data.savingsPots.map(('],
  ['pages/Salary.tsx', 'data.pensions.map(('],
  ['pages/Loans.tsx', 'data.loans.map(('],
  ['pages/Loans.tsx', 'data.creditCards.map((storedCard'],
  ['pages/Expenses.tsx', 'data.loans.filter((l) => l.active)'],
  ['pages/Expenses.tsx', 'data.creditCards.filter((c) => c.active)'],
  ['pages/Expenses.tsx', 'data.loans.filter((l) => l.overpayments.length > 0)'],
  ['pages/Expenses.tsx', 'data.creditCards.filter((c) => c.lumpPayments.length > 0)'],
]
for (const [page, raw] of rawRenders) {
  check(`${page} no longer renders \`${raw}\``, srcFile(page).includes(raw), false)
}

// …and the filtered lists they were replaced by are really there.
const filteredLists: [string, string][] = [
  ['pages/Bills.tsx', 'const myBills = visibleToMe(data, billTemplates'],
  ['pages/Salary.tsx', 'const myPots = visibleToMe(data, data.pots'],
  ['pages/Salary.tsx', 'const mySavingsPots = visibleToMe(data, data.savingsPots'],
  ['pages/Salary.tsx', 'const myPensions = visibleToMe(data, data.pensions'],
  ['pages/Loans.tsx', 'const myLoans = visibleToMe(data, data.loans'],
  ['pages/Loans.tsx', 'const myCreditCards = visibleToMe(data, data.creditCards'],
  ['pages/Expenses.tsx', 'const myLoans = visibleToMe(data, data.loans'],
  ['pages/Expenses.tsx', 'const myCreditCards = visibleToMe(data, data.creditCards'],
]
for (const [page, decl] of filteredLists) {
  check(`${page} builds \`${decl.split(' ')[1]}\``, srcFile(page).includes(decl), true)
}

// The transfer wizard is a deliberate exception, pinned by
// verify-coin-jar-restrictions.ts as well: a transfer may go to ANY pot, so
// its picker is not owner-filtered. Asserted here so the two checks cannot
// drift into contradicting each other.
check('the transfer wizard still offers every pot, by design', srcFile('pages/Expenses.tsx').includes('buildTransferLocationOptions(data.savingsPots, data.pots,'), true)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')

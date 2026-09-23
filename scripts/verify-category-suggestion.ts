// 2026-09-17 (Adam): logging a transaction pre-selects the category of the
// most recent past transaction with a similar name, instead of always
// starting on the seeded default. lib/categorySuggestion.ts.
//
// 1. Normalising and similarity.
// 2. Which candidate wins (exact > contained > fuzzy, newest first).
// 3. Both real backups: a real name finds its own category, a typo still
//    finds it, and nonsense finds nothing.
// 4. Source checks: the wizard applies it on leaving the name step and
//    never overrides a hand-picked category.

import { readFileSync } from 'node:fs'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { normaliseTransactionName, nameSimilarity, suggestCategoryForName, NAME_SIMILARITY_THRESHOLD } from '../src/lib/categorySuggestion'
import type { AppDataV2, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkTrue(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`)
  if (!ok) failures++
}

const txn = (note: string, categoryId: string, date: string): Transaction => ({
  id: `${note}-${date}`,
  date,
  amount: 10,
  direction: 'out',
  categoryId,
  paymentMethod: 'card',
  status: 'cleared',
  type: 'expense',
  location: 'personal',
  ownerId: 'me',
  note,
})

console.log('1. Normalising and similarity')
check('Case, punctuation and double spaces are ignored', normaliseTransactionName('  TESCO   Express! '), 'tesco express')
check('A name of only punctuation normalises to nothing', normaliseTransactionName('!!!'), '')
checkTrue('Identical names score 1', nameSimilarity('tesco', 'tesco') === 1)
checkTrue('A transposed-letter typo scores at least the threshold', nameSimilarity('tecso', 'tesco') >= NAME_SIMILARITY_THRESHOLD, nameSimilarity('tecso', 'tesco'))
checkTrue('A missing trailing letter scores at least the threshold', nameSimilarity('sainsbury', 'sainsburys') >= NAME_SIMILARITY_THRESHOLD, nameSimilarity('sainsbury', 'sainsburys'))
checkTrue('Unrelated names score below the threshold', nameSimilarity('tesco', 'mortgage') < NAME_SIMILARITY_THRESHOLD, nameSimilarity('tesco', 'mortgage'))

console.log('\n2. Which candidate wins')
{
  const history = [txn('Tesco', 'cat-food', '2026-01-10'), txn('Tesco', 'cat-treats', '2026-05-01'), txn('Tesco Express', 'cat-fuel', '2026-06-01'), txn('Fuel', 'cat-fuel', '2026-04-01')]
  check('Exact match takes the most recent of that name', suggestCategoryForName('tesco', history)?.categoryId, 'cat-treats')
  check('...and reports which entry it came from', [suggestCategoryForName('tesco', history)?.matchedName, suggestCategoryForName('tesco', history)?.matchedDate], ['Tesco', '2026-05-01'])
  check('An exact match beats a more recent containing name', suggestCategoryForName('Tesco', history)?.categoryId, 'cat-treats')
  check('Containment matches when nothing is exact', suggestCategoryForName('tesco express metro', history)?.categoryId, 'cat-fuel')
  check('A typo still finds it', suggestCategoryForName('tecso', history)?.categoryId, 'cat-treats')
  check('Nonsense finds nothing', suggestCategoryForName('zzzzqqq', history), null)
  check('An empty name finds nothing', suggestCategoryForName('   ', history), null)
  check('A one-letter name does not match everything by containment', suggestCategoryForName('a', history), null)
  check('No history at all: nothing', suggestCategoryForName('tesco', []), null)
  check('Rows with no name or no category are ignored', suggestCategoryForName('tesco', [{ ...txn('Tesco', 'cat-food', '2026-07-01'), note: undefined }]), null)
  check('Hidden or deleted categories are never suggested', suggestCategoryForName('tesco', history, new Set(['cat-food'])), {
    categoryId: 'cat-food',
    matchedName: 'Tesco',
    matchedDate: '2026-01-10',
  })
  check('...and if none of the matches are allowed, nothing', suggestCategoryForName('tesco', history, new Set(['cat-other'])), null)
}

console.log('\n3. Real backups')
for (const file of ['finance-ledger-backup-2026-09-15.json', 'finance-ledger-backup-2026-09-15-mum.json']) {
  const data: AppDataV2 = migrateLedgerData(JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/' + file, 'utf8')))
  const named = data.transactions.filter((t) => t.note && t.categoryId && normaliseTransactionName(t.note).length > 3)
  const who = file.includes('mum') ? 'mum' : 'Adam'
  checkTrue(`${who}: has named transactions to learn from`, named.length > 0, named.length)
  if (named.length === 0) continue

  // The most recent entry of whichever name appears most often: typing that
  // name again must land on its own category.
  const counts = new Map<string, number>()
  for (const t of named) counts.set(normaliseTransactionName(t.note!), (counts.get(normaliseTransactionName(t.note!)) ?? 0) + 1)
  const commonest = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  const newest = named.filter((t) => normaliseTransactionName(t.note!) === commonest).sort((a, b) => b.date.localeCompare(a.date))[0]
  const suggestion = suggestCategoryForName(newest.note!, data.transactions)
  check(`${who}: typing "${newest.note}" suggests its own latest category`, suggestion?.categoryId, newest.categoryId)
  check(`${who}: the same name typed in lower case with a stray space matches too`, suggestCategoryForName(` ${newest.note!.toLowerCase()} `, data.transactions)?.categoryId, newest.categoryId)

  const typo = newest.note!.length > 4 ? newest.note!.slice(0, -1) : newest.note!
  check(`${who}: "${typo}" (a letter dropped) still matches`, suggestCategoryForName(typo, data.transactions)?.categoryId, newest.categoryId)
  check(`${who}: an unrelated name suggests nothing`, suggestCategoryForName('qqzzxx wibble', data.transactions), null)
  checkTrue(`${who}: every suggestion points at a category that exists`, data.transactions.every((t) => {
    const s = t.note ? suggestCategoryForName(t.note, data.transactions) : null
    return !s || data.categories.some((c) => c.id === s.categoryId)
  }))
}

console.log('\n4. The wizard applies it')
{
  const src = readFileSync(new URL('../src/pages/Expenses.tsx', import.meta.url), 'utf8')
  check('Leaving the name step applies the suggestion', /onSave=\{\(\) => \{\s*applyCategorySuggestion\(\)\s*setStep\('category'\)/.test(src), true)
  check('The suggestion is limited to the categories the picker offers', /suggestCategoryForName\(name, data\.transactions, allowed\)/.test(src), true)
  check('A hand-picked category is never overridden', /if \(categoryPickedByHand\) return/.test(src), true)
  check('Picking a category by hand is recorded', /setCategoryPickedByHand\(true\)/.test(src), true)
  check('The hint names the matched entry and its date', /From your last "\{suggestion\.matchedName\}" on \{formatFullDate\(suggestion\.matchedDate\)\}/.test(src), true)
}

console.log(failures === 0 ? '\nAll category suggestion checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

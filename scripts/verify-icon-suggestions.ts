import { BILL_ICONS } from '../src/lib/billIcons'
import { EXTENDED_ICONS } from '../src/lib/extendedIcons'
import { availableExtendedIcons, scoreIconMatch, suggestTopIcons, isWeakMatch, filterAvailableIcons, WEAK_MATCH_THRESHOLD } from '../src/lib/iconSuggestions'
import { parseDatamuseWords } from '../src/lib/datamuse'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkTrue(label: string, actual: boolean) {
  console.log(`${actual ? '✓' : '✗ FAIL'} ${label}`)
  if (!actual) failures++
}

// ── Library integrity ──

const collisions = Object.keys(EXTENDED_ICONS).filter((key) => key in BILL_ICONS)
check('No extended-library icon key collides with a permanent BILL_ICONS key', collisions, [])

const thinlyTagged = Object.entries(EXTENDED_ICONS).filter(([, entry]) => entry.keywords.length < 2)
check('Every extended-library icon has at least 2 keywords', thinlyTagged.map(([k]) => k), [])

checkTrue('Extended library has a meaningfully large pool (100+ icons)', Object.keys(EXTENDED_ICONS).length >= 100)

// ── Pool availability — recomputed live from categories, no separate stored "used" state ──

const noCategories: { icon: string }[] = []
const poolWithNoUsage = availableExtendedIcons(noCategories)
check('With no categories at all, the full extended library is available', poolWithNoUsage.length, Object.keys(EXTENDED_ICONS).length)

const categoriesUsingWine = [{ icon: 'wine' }, { icon: 'home' }] // 'home' is a BILL_ICONS key, irrelevant to the extended pool either way
const poolAfterWineUsed = availableExtendedIcons(categoriesUsingWine)
checkTrue('Once a category uses "wine", it drops out of the available pool', !poolAfterWineUsed.some((e) => e.key === 'wine'))
check('Pool size shrinks by exactly 1 when one extended icon is in use', poolAfterWineUsed.length, Object.keys(EXTENDED_ICONS).length - 1)

const poolAfterWineFreedUp = availableExtendedIcons([{ icon: 'home' }]) // the category using 'wine' no longer exists — e.g. deleted
checkTrue('Deleting the category that used it makes the icon available again', poolAfterWineFreedUp.some((e) => e.key === 'wine'))

// ── Local fuzzy scoring ──

const wineKeywords = EXTENDED_ICONS.wine.keywords
checkTrue('An exact keyword match ("wine") scores well above the weak-match threshold', scoreIconMatch('Wine club', wineKeywords) >= WEAK_MATCH_THRESHOLD)
checkTrue('An unrelated name scores low against wine\'s keywords', scoreIconMatch('Car insurance', wineKeywords) < 0.2)
checkTrue('A near-typo of a keyword still scores meaningfully (typo tolerance)', scoreIconMatch('Wne night', wineKeywords) > 0)

// ── Top-N suggestions & the weak-match trigger ──

const wineSuggestions = suggestTopIcons('Wine subscription', [])
check('Top suggestion for "Wine subscription" is the wine icon', wineSuggestions[0]?.key, 'wine')
checkTrue('A strong local match is NOT flagged as weak', !isWeakMatch(wineSuggestions))

const bingoSuggestions = suggestTopIcons('Bingo night', [])
checkTrue('A name with no keyword overlap anywhere IS flagged as weak (should trigger the Datamuse fallback)', isWeakMatch(bingoSuggestions))

// Simulates what happens once Datamuse-supplied related words are folded in
// as extraKeywords — proves the augmented-query path actually changes the
// ranking, using manually-supplied "related words" so this stays a fully
// offline, deterministic test (no live network call).
const boostedSuggestions = suggestTopIcons('Completely unrecognisable made up term', [], ['wine', 'drinks'])
check('Extra keywords (simulating a Datamuse response) can pull in a correct match the name alone could not find', boostedSuggestions[0]?.key, 'wine')

check('suggestTopIcons respects topN', suggestTopIcons('Wine subscription', [], [], 1).length, 1)

// ── Browse-all text filter ──

const fullPool = availableExtendedIcons([])
const coinMatches = filterAvailableIcons(fullPool, 'coin')
checkTrue('Filtering by "coin" matches the coins icon', coinMatches.some((e) => e.key === 'coins'))
checkTrue('Filtering by "coin" matches hand_coins via its keyword, not just its key', coinMatches.some((e) => e.key === 'hand_coins'))
checkTrue('Filtering by "coin" excludes clearly unrelated icons', !coinMatches.some((e) => e.key === 'wine'))
check('An empty filter query returns the full pool unfiltered', filterAvailableIcons(fullPool, '').length, fullPool.length)

// ── Datamuse response parsing — pure logic, no live network call ──

check('A well-formed Datamuse response extracts just the words', parseDatamuseWords([{ word: 'game', score: 100 }, { word: 'gambling', score: 80 }]), ['game', 'gambling'])
check('A non-array response (e.g. an error body) degrades to an empty list', parseDatamuseWords({ error: 'rate limited' }), [])
check('null degrades to an empty list', parseDatamuseWords(null), [])
check('Malformed entries (missing/wrong-typed "word") are dropped, not thrown on', parseDatamuseWords([{ word: 'ok' }, { notWord: 'bad' }, { word: 42 }, 'plain string']), ['ok'])

console.log(failures === 0 ? '\nAll icon-suggestion checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

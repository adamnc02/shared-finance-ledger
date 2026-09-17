// 2026-09-17 (Adam): when logging a transaction, the category step used to
// always start on the same seeded default. It now starts on the category of
// the most recent past transaction with a similar name — "tesco" finds the
// last Tesco shop — falling back to that default when nothing matches.
//
// Deliberately no dependency and no index: the match runs once, on leaving
// the name step, over transactions already in memory.

import type { Transaction } from '../types/ledger'

/** Lower case, punctuation and repeated spaces removed, so "TESCO EXPRESS!" and "tesco  express" are the same name. */
export function normaliseTransactionName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 1 minus the edit distance as a fraction of the longer name: 1 is
 * identical, 0 shares nothing.
 *
 * Optimal string alignment (Damerau-Levenshtein), so a swapped pair of
 * letters counts as ONE mistake — the commonest typo by far. Plain
 * Levenshtein charges two for it, and bigram overlap (tried first) scores
 * "tecso"/"tesco" at 0.25, well under any usable threshold, because a swap
 * destroys three of the four bigrams.
 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  const rows = a.length + 1
  const cols = b.length + 1
  // distance[i][j] = edits to turn a's first i characters into b's first j
  const distance: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      distance[i][j] = Math.min(distance[i - 1][j] + 1, distance[i][j - 1] + 1, distance[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        distance[i][j] = Math.min(distance[i][j], distance[i - 2][j - 2] + 1)
      }
    }
  }
  return 1 - distance[a.length][b.length] / Math.max(a.length, b.length)
}

/** Below this, two names are treated as unrelated and the picker keeps its default. */
export const NAME_SIMILARITY_THRESHOLD = 0.7
/** Containment ("tesco" inside "tesco express") only counts from this length, so "a" doesn't match everything. */
const MIN_CONTAINMENT_LENGTH = 3

export interface CategorySuggestion {
  categoryId: string
  /** The past transaction's own name and date, for the "from your last …" line. */
  matchedName: string
  matchedDate: string
}

/**
 * The category of the most recent past transaction whose name matches
 * `name`, or null.
 *
 * Three passes, strongest first, so a real "Tesco" always beats a fuzzy
 * near-miss however recent that near-miss is:
 *  1. the same name;
 *  2. one name contains the other;
 *  3. similarity at or above the threshold — best score wins, most recent
 *     breaking a tie.
 *
 * `allowedCategoryIds`, when given, limits matches to categories the picker
 * is actually offering, so a suggestion can never select a hidden or
 * deleted one.
 */
export function suggestCategoryForName(name: string, transactions: Transaction[], allowedCategoryIds?: Set<string>): CategorySuggestion | null {
  const target = normaliseTransactionName(name)
  if (!target) return null

  const candidates = transactions
    .filter((t) => t.note && t.categoryId && (!allowedCategoryIds || allowedCategoryIds.has(t.categoryId)))
    .map((t) => ({ name: t.note!, normalised: normaliseTransactionName(t.note!), categoryId: t.categoryId, date: t.date }))
    .filter((c) => c.normalised.length > 0)
    // Newest first, so every pass below can take the first hit it finds.
    .sort((a, b) => b.date.localeCompare(a.date))

  const asSuggestion = (c: (typeof candidates)[number]): CategorySuggestion => ({ categoryId: c.categoryId, matchedName: c.name, matchedDate: c.date })

  const exact = candidates.find((c) => c.normalised === target)
  if (exact) return asSuggestion(exact)

  const contained = candidates.find(
    (c) =>
      Math.min(c.normalised.length, target.length) >= MIN_CONTAINMENT_LENGTH && (c.normalised.includes(target) || target.includes(c.normalised)),
  )
  if (contained) return asSuggestion(contained)

  let best: { candidate: (typeof candidates)[number]; score: number } | null = null
  for (const candidate of candidates) {
    const score = nameSimilarity(target, candidate.normalised)
    // Strictly greater, and candidates are newest first, so the most recent
    // of equally-close names wins.
    if (score >= NAME_SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { candidate, score }
  }
  return best ? asSuggestion(best.candidate) : null
}

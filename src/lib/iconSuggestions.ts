// ─────────────────────────────────────────────────────────────────────────
// Icon suggestion engine for new-category creation. Pure functions, no
// React and no network — the Datamuse fallback (datamuse.ts) supplies
// EXTRA keywords into suggestTopIcons() rather than living in here, so this
// file stays synchronous and independently testable.
//
// "Available" is computed live from the current category list rather than
// tracked as separate persisted state (see extendedIcons.ts's header) — an
// icon is available if no category is using it right now.
// ─────────────────────────────────────────────────────────────────────────

import type { LucideIcon } from 'lucide-react'
import { EXTENDED_ICONS } from './extendedIcons'

export interface IconSuggestion {
  key: string
  icon: LucideIcon
  keywords: string[]
  score: number
}

function usedIconKeys(categories: { icon: string }[]): Set<string> {
  return new Set(categories.map((c) => c.icon))
}

/** Every extended-library icon not currently assigned to any category — the pool a new category can draw from. Recomputed live, so deleting a category frees its icon back up automatically. */
export function availableExtendedIcons(categories: { icon: string }[]): { key: string; icon: LucideIcon; keywords: string[] }[] {
  const used = usedIconKeys(categories)
  return Object.entries(EXTENDED_ICONS)
    .filter(([key]) => !used.has(key))
    .map(([key, entry]) => ({ key, icon: entry.icon, keywords: entry.keywords }))
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)])
  for (let j = 0; j < cols; j++) d[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    }
  }
  return d[rows - 1][cols - 1]
}

/** 0..1 similarity between two single words — exact match, substring containment (for compound/plural forms), then a narrow typo-tolerance band via edit distance. Deliberately strict (single-edit only, and only for words of 4+ characters) — an earlier version allowed edit-distance-2 on short words and it falsely matched unrelated pairs like "wine"/"time" (2 substitutions on a 4-letter word), which is loose enough to actively mislead the ranking rather than help it. */
function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 3 || b.length < 3) return 0
  if (a.includes(b) || b.includes(a)) return 0.85
  const maxLen = Math.max(a.length, b.length)
  if (maxLen < 4) return 0
  const dist = levenshtein(a, b)
  if (dist <= 1) return (1 - dist / maxLen) * 0.7
  return 0
}

/** Average, per query word, of that word's best similarity against any word in the icon's keyword list — 0 (no relation) to 1 (every query word matched exactly). Query words that match nothing pull the average down, so a category name that's mostly unrelated to an icon still scores low even if one word happens to match. */
export function scoreIconMatch(query: string, keywords: string[]): number {
  const queryWords = normalizeWords(query)
  if (queryWords.length === 0) return 0
  const keywordWords = keywords.flatMap((k) => normalizeWords(k))
  if (keywordWords.length === 0) return 0

  let total = 0
  for (const qw of queryWords) {
    let best = 0
    for (const kw of keywordWords) {
      const sim = wordSimilarity(qw, kw)
      if (sim > best) best = sim
    }
    total += best
  }
  return total / queryWords.length
}

/** Below this, the top local match is treated as too weak to be useful on its own — the caller should try the Datamuse fallback for extra keywords before showing suggestions. Chosen empirically: a single exact keyword word-match against a two-word category name scores 0.5, which should NOT be treated as weak (that's a good match) — the threshold sits just under that. */
export const WEAK_MATCH_THRESHOLD = 0.45

export function isWeakMatch(suggestions: { score: number }[]): boolean {
  return suggestions.length === 0 || suggestions[0].score < WEAK_MATCH_THRESHOLD
}

/** Top N available icons ranked by match quality against the category name, optionally boosted with extra related words (from the Datamuse fallback). Ties and zero-score entries are still returned — the caller decides what's worth showing; this just ranks. */
export function suggestTopIcons(
  name: string,
  categories: { icon: string }[],
  extraKeywords: string[] = [],
  topN = 3,
): IconSuggestion[] {
  const pool = availableExtendedIcons(categories)
  const query = [name, ...extraKeywords].join(' ')
  return pool
    .map((entry) => ({ ...entry, score: scoreIconMatch(query, entry.keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}

/** Text-filter for the "browse all available icons" list — matches against the icon's own key (e.g. "ice_cream") and its keywords, not just the top-N suggestions. */
export function filterAvailableIcons(
  pool: { key: string; icon: LucideIcon; keywords: string[] }[],
  query: string,
): { key: string; icon: LucideIcon; keywords: string[] }[] {
  const q = query.trim().toLowerCase()
  if (!q) return pool
  return pool.filter((entry) => entry.key.replace(/_/g, ' ').includes(q) || entry.keywords.some((k) => k.includes(q)))
}

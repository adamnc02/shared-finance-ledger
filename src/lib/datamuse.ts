// ─────────────────────────────────────────────────────────────────────────
// Optional network fallback for icon suggestion — the ONLY place in this
// app that makes a network call of its own (everything else is local-only,
// see HANDOFF's "no backend, no sync, no auth" simplification). Kept
// strictly optional and best-effort: called ONLY when the local keyword
// match against a category name comes back weak (see iconSuggestions.ts's
// isWeakMatch), and any failure — no connection, timeout, non-2xx
// response, malformed JSON — silently resolves to an empty list rather
// than surfacing an error, so category creation always works offline; it
// just falls back to whatever the local matcher already found.
//
// Datamuse (https://www.datamuse.com/api/) is a free, no-API-key word-
// association API — no account, no stored secret, no backend needed to
// call it safely from the browser.
// ─────────────────────────────────────────────────────────────────────────

const DATAMUSE_TIMEOUT_MS = 3000

interface DatamuseWord {
  word: string
}

function isDatamuseWord(entry: unknown): entry is DatamuseWord {
  return typeof entry === 'object' && entry !== null && typeof (entry as DatamuseWord).word === 'string'
}

/** Pulled out as its own pure function so the response-shape handling is testable without a live network call — see scripts/verify-icon-suggestions.ts. Anything that isn't a JSON array of {word: string, ...} objects (malformed response, unexpected shape) degrades to []. */
export function parseDatamuseWords(data: unknown): string[] {
  if (!Array.isArray(data)) return []
  return data.filter(isDatamuseWord).map((entry) => entry.word)
}

/** Related/similar-meaning words for a term. Returns [] on any failure — network error, timeout, non-2xx, bad JSON — never throws, so callers never need a try/catch of their own. */
export async function fetchRelatedWords(term: string): Promise<string[]> {
  const trimmed = term.trim()
  if (!trimmed) return []

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DATAMUSE_TIMEOUT_MS)

  try {
    const response = await fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(trimmed)}&max=10`, {
      signal: controller.signal,
    })
    if (!response.ok) return []
    const data: unknown = await response.json()
    return parseDatamuseWords(data)
  } catch {
    return []
  } finally {
    clearTimeout(timeoutId)
  }
}

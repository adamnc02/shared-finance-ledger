// SYNC APP ONLY. The two decisions connector.ts makes about an upload, kept
// free of the Supabase client so scripts/verify-upload-auth.ts can run them.
//
// 🚨 An upload must never go out without the signed-in user's JWT.
// supabase-js sends the PUBLISHABLE key as the bearer whenever getSession()
// has no session — an access token that expired while the phone had no
// signal, and whose refresh then failed. PostgREST runs that request as
// `anon`, which has no grant on any table in this schema, so every write
// comes back `42501 permission denied for table …`. Treated as permanent,
// those writes were discarded: the change stayed on the device until the
// next sync replaced the local copy, and never reached the server.
//
// So: no session → throw, and PowerSync keeps the queue and retries. A
// sign-out does not clear the local database (SyncRoot only disconnects),
// so the queued writes upload once the user is signed in again.

/** The Authorization header for this upload, or a throw that leaves the queue intact. */
export async function uploadAuthorization(
  getSession: () => Promise<{ data: { session: { access_token?: string } | null }; error: { message: string } | null }>,
): Promise<string> {
  const {
    data: { session },
    error,
  } = await getSession()
  if (error || !session?.access_token) {
    throw new Error(`Upload held until signed in: ${error?.message ?? 'no session'}`)
  }
  return `Bearer ${session.access_token}`
}

// Not retried: bad data (22xxx), a constraint (23xxx: FK, CHECK, unique),
// or an RLS refusal (42501 "new row violates row-level security policy") —
// each would block every later write behind it forever. Everything else
// (network, 5xx, PGRST002, an expired JWT's 401) is retried.
export const FATAL_RESPONSE_CODES = [/^22...$/, /^23...$/, /^42501$/]

/**
 * Whether the server's refusal is permanent, so the write is discarded.
 *
 * 42501 covers two different refusals. RLS ("new row violates row-level
 * security policy") is about the row and is permanent. A privilege refusal
 * ("permission denied for table …") is about the ROLE the request ran as —
 * `anon`, or a grant missing on the server — and succeeds on retry once that
 * is put right, so it is retried rather than lost.
 */
export function isPermanentRejection(error: { code?: string; message?: string }): boolean {
  const code = error.code ?? ''
  if (!FATAL_RESPONSE_CODES.some((pattern) => pattern.test(code))) return false
  if (code === '42501' && /permission denied/i.test(error.message ?? '')) return false
  return true
}

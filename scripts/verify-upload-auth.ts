// A lapsed sign-in must never cost a queued write (MIGRATION-LESSONS §77).
//
// The real bug this prevents: a phone's access token expired while it had no
// signal and the refresh failed. supabase-js then sent the PUBLISHABLE key as
// the bearer, PostgREST ran each upload as `anon`, and every write came back
// `42501 permission denied for table transactions`. 42501 was in the fatal
// list, so the connector discarded all seven writes — two expenses that the
// phone kept showing until the next sync quietly removed them. The server was
// fine throughout; nothing anywhere said the money had gone missing.
//
// What it asserts:
//  1. uploadAuthorization() throws with no session, a session without a
//     token, or a getSession() error — so PowerSync keeps the queue — and
//     returns `Bearer <jwt>` for a real session;
//  2. isPermanentRejection(): the exact error from that day is RETRIED; an
//     RLS refusal, 22xxx and 23xxx are discarded; network/401/5xx are retried;
//  3. control: the old rule (code only) classified that error as permanent;
//  4. connector.ts asks for the Authorization BEFORE its first request, sets
//     it on every request, and decides discards only via isPermanentRejection.

import { readFileSync } from 'fs'
import { isPermanentRejection, uploadAuthorization, FATAL_RESPONSE_CODES } from '../src/lib/powersync/uploadAuth'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${ok || detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

async function throws(p: Promise<unknown>): Promise<boolean> {
  try {
    await p
    return false
  } catch {
    return true
  }
}

const session = (s: { access_token?: string } | null, error: { message: string } | null = null) => async () => ({ data: { session: s }, error })

// ---- 1. No session, no upload ----
check('no session → throws (queue kept)', await throws(uploadAuthorization(session(null))))
check('session without an access token → throws', await throws(uploadAuthorization(session({}))))
check('getSession() error (failed refresh) → throws', await throws(uploadAuthorization(session(null, { message: 'Failed to fetch' }))))
check('a real session → its own JWT as the bearer', (await uploadAuthorization(session({ access_token: 'eyJ.user.jwt' }))) === 'Bearer eyJ.user.jwt')

// ---- 2. Which refusals are permanent ----
const ANON_REFUSAL = { code: '42501', message: 'permission denied for table transactions' } // the 13:06 error, verbatim
const cases: [string, { code?: string; message?: string }, boolean][] = [
  ['42501 permission denied (ran as anon) → retried', ANON_REFUSAL, false],
  ['42501 permission denied for schema → retried', { code: '42501', message: 'permission denied for schema shared_finance_ledger' }, false],
  ['42501 RLS refusal → discarded', { code: '42501', message: 'new row violates row-level security policy for table "transactions"' }, true],
  ['23503 foreign key → discarded', { code: '23503', message: 'insert or update violates foreign key constraint' }, true],
  ['23505 unique → discarded', { code: '23505', message: 'duplicate key value' }, true],
  ['22P02 bad input → discarded', { code: '22P02', message: 'invalid input syntax' }, true],
  ['PGRST303 expired JWT → retried', { code: 'PGRST303', message: 'JWT expired' }, false],
  ['PGRST301 → retried', { code: 'PGRST301', message: 'JWSError' }, false],
  ['no code (network) → retried', { message: 'Failed to fetch' }, false],
  ['P0001 trigger raise → retried (§29)', { code: 'P0001', message: 'raise' }, false],
]
for (const [label, err, permanent] of cases) check(label, isPermanentRejection(err) === permanent)

// ---- 3. Control: the old rule loses that write ----
const oldRule = (e: { code?: string }) => FATAL_RESPONSE_CODES.some((p) => p.test(e.code ?? ''))
check('control: the code-only rule DISCARDS the 13:06 error (the bug)', oldRule(ANON_REFUSAL) === true)

// ---- 4. The connector uses both, in the right order ----
const src = readFileSync(new URL('../src/lib/powersync/connector.ts', import.meta.url), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const upload = code.slice(code.indexOf('async uploadData'))
const authAt = upload.indexOf('uploadAuthorization(')
const firstRequest = upload.indexOf('supabase.from(')
check('uploadData asks for the Authorization before its first request', authAt !== -1 && firstRequest !== -1 && authAt < firstRequest, { authAt, firstRequest })
const requests = upload.match(/table\.(upsert|update|delete)\(/g) ?? []
const headed = upload.match(/\.setHeader\('Authorization', authorization\)/g) ?? []
check('every request (PUT, PATCH, DELETE) sets the Authorization header', requests.length === 3 && headed.length === requests.length, { requests: requests.length, headed: headed.length })
check('the discard decision is isPermanentRejection, not a bare code match', /isPermanentRejection\(result\.error\)/.test(upload) && !/FATAL_RESPONSE_CODES/.test(upload))

console.log(failures === 0 ? '\nAll upload-auth checks passed.' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

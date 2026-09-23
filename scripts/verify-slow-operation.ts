// PROMPT-16 Part E (2026-09-22) — a boot step that has not finished after a
// while says so, and names the likely cause (lib/powersync/slowOperation.ts).
//
// The bug it prevents: "Preparing this device…" hung for ever because
// another tab on the same origin (Listly) held the OPFS lock that
// disconnectAndClear() needed, and OPFSCoopSyncVFS waits silently
// (MIGRATION-LESSONS §64). Everything server-side was checked first and was
// healthy. The expensive part was the silence.
//
// What it asserts:
//  1. work still pending after the deadline → onSlow fires, ONCE, and the
//     work still completes with its own value (the operation is never
//     aborted — a half-cleared database is worse than a slow one);
//  2. work that finishes before the deadline → onSlow never fires;
//  3. a rejection is passed through unchanged, and still cancels the timer;
//  4. CONTROL: with no deadline (Infinity), the line never changes however
//     long the work takes — which is today's behaviour, and the bug.

import { warnIfSlow, SLOW_CLEAR_AFTER_MS, SLOW_CLEAR_LINE } from '../src/lib/powersync/slowOperation'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const after = <T,>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms))

console.log('\n1. Slow work: the line changes while it is still pending, and the work still completes')
{
  let slowAt: number | null = null
  let fires = 0
  const t0 = Date.now()
  const result = await warnIfSlow(after(60, 'cleared'), 20, () => {
    fires++
    slowAt = Date.now() - t0
  })
  check('onSlow fired while the work was still pending', slowAt !== null && slowAt! < 60, slowAt)
  check('exactly once', fires === 1, fires)
  check('the work resolved with its own value, not aborted', result === 'cleared', result)
}

console.log('\n2. Fast work: no warning')
{
  let fires = 0
  const result = await warnIfSlow(after(5, 42), 50, () => fires++)
  await sleep(70) // past the deadline: the timer must have been cleared
  check('onSlow never fired', fires === 0, fires)
  check('the value came through', result === 42)
}

console.log('\n3. A failure passes through unchanged')
{
  let fires = 0
  const failing = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('boom')), 5))
  const err = await warnIfSlow(failing, 50, () => fires++).catch((e: Error) => e)
  await sleep(70)
  check('the rejection is the original error', err instanceof Error && err.message === 'boom', String(err))
  check('and the timer was cancelled', fires === 0)
}

console.log('\n4. CONTROL — no deadline: the line never changes (today\'s behaviour)')
{
  let fires = 0
  await warnIfSlow(after(40, null), Infinity, () => fires++)
  check('nothing ever fires without a deadline', fires === 0, fires)
}

console.log('\n5. The real deadline and line')
{
  check('the clear is given 10 seconds before it is called slow', SLOW_CLEAR_AFTER_MS === 10_000, SLOW_CLEAR_AFTER_MS)
  check('the line names another tab on this site as the likely cause', /another tab|installed app/i.test(SLOW_CLEAR_LINE) && /Listly/.test(SLOW_CLEAR_LINE), SLOW_CLEAR_LINE)
  check('…and says it will continue by itself (the operation is not aborted)', /continue/i.test(SLOW_CLEAR_LINE))
}

console.log(failures === 0 ? '\nAll slow-operation checks passed.' : `\nFAIL: ${failures} slow-operation check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

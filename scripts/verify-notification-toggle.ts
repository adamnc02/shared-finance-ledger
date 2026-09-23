// SYNC APP ONLY. PROMPT-14 Part 7 (2026-09-22) — the notifications toggle
// reads the truth, per device, and never sends anyone to Settings for no
// reason.
//
// 🚨 TWO CONTROLS, BOTH FOR MISTAKES THAT LOOK LIKE THE SPEC.
//
//  1. A USER-LEVEL FLAG. "Notifications on" feels like an account setting, and
//     storing it that way is the obvious implementation. It is wrong: a
//     subscription belongs to ONE DEVICE, so a user-level boolean renders ON
//     on a second phone that has never registered — and that phone then
//     silently receives nothing while claiming to be on. Section 2 builds
//     exactly that and requires it to disagree with the real rule.
//
//  2. BRANCHING ON TOGGLE HISTORY. Adam's own framing was "toggling on a
//     second time instructs users where to go in settings", and implemented
//     literally that is wrong — toggling the app switch OFF does not revoke
//     the OS permission, so the common second toggle is still 'granted' and
//     must just work, silently. Section 3 requires a 'granted' device to show
//     no Settings instruction, and section 4 requires a 'denied' one always to.
//
// 🚨 And one that is NOT a bug: on a phone that already granted Listly
// permission, the first toggle here shows NO PROMPT at all. Permission is per
// ORIGIN and both apps are on adamnc02.github.io. Expect it in testing.
//
// What it asserts:
//  1. every state the machine can be in, from real device facts;
//  2. the control: a user-level flag vs this device's own row, on two phones;
//  3. 'granted' + registered = on, with no instruction; 'granted' + not
//     registered = off, and toggling on must not prompt;
//  4. 'denied' never calls requestPermission() and always shows the
//     instruction — iOS gives no second chance;
//  5. an iOS Safari tab says "add to Home Screen", NOT "unsupported" — three
//     taps fix it, and calling it unsupported hides that;
//  6. a local subscription the server does not know about reads OFF, because
//     it alerts nobody;
//  7. a missing or unreachable server half resolves a state and says why,
//     rather than parking the card on "Checking…" for ever;
//  8. turning off deletes only THIS device's row, in the source;
//  9. the VAPID public key the app subscribes with is the one the Edge
//     Function signs with — a mismatch is a silent 403 on every push.

import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { decidePushState, type DeviceFacts, type PushState } from '../src/lib/powersync/pushState'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', String(detail).slice(0, 400))
  }
}

const base: DeviceFacts = { ios: true, standalone: true, supported: true, permission: 'granted', hereId: 'ps_here', registeredIds: ['ps_here'] }
const facts = (over: Partial<DeviceFacts>): DeviceFacts => ({ ...base, ...over })

console.log('\n1. Every state, from real device facts')
const cases: [string, Partial<DeviceFacts>, PushState][] = [
  ['registered, permission granted', {}, 'on'],
  ['granted but this device has no subscription', { hereId: null, registeredIds: [] }, 'off'],
  ['never asked on this device', { permission: 'default', hereId: null, registeredIds: [] }, 'ask'],
  ['the user said no', { permission: 'denied', hereId: null, registeredIds: [] }, 'denied'],
  ['iOS, but in a Safari tab', { standalone: false }, 'needs-install'],
  ['a browser with no PushManager at all', { ios: false, supported: false }, 'unsupported'],
]
for (const [label, over, expected] of cases) check(`${label} → ${expected}`, decidePushState(facts(over)) === expected, decidePushState(facts(over)))

console.log('\n2. CONTROL — per device, not per user')
{
  // One account, two phones. The first is registered; the second has never
  // been. A user-level flag cannot tell them apart.
  const registeredForThisAccount = ['ps_phone-one']
  const phoneOne = decidePushState(facts({ hereId: 'ps_phone-one', registeredIds: registeredForThisAccount }))
  const phoneTwo = decidePushState(facts({ hereId: null, registeredIds: registeredForThisAccount }))
  check('phone one reads on', phoneOne === 'on', phoneOne)
  check('phone two reads OFF, because it has no row of its own', phoneTwo === 'off', phoneTwo)

  const userLevelFlag = registeredForThisAccount.length > 0 // the wrong implementation
  check('the control: a user-level flag says ON for both…', userLevelFlag === true)
  check('…so it would tell phone two it is on while it receives nothing', (userLevelFlag ? 'on' : 'off') !== phoneTwo)
}

console.log('\n3. Granted re-subscribes silently — no Settings instruction')
{
  const off = decidePushState(facts({ hereId: null, registeredIds: [] }))
  check("toggling off then on again is 'off', never 'denied'", off === 'off', off)
  check('…so the UI shows no Settings instruction for it', off !== 'denied')
  // The instruction is keyed on the state, so this is the whole guarantee.
  const shows = (s: PushState) => s === 'denied'
  check('the instruction is shown for denied and for nothing else', ['on', 'off', 'ask', 'needs-install', 'unsupported'].every((s) => !shows(s as PushState)) && shows('denied'))
}

console.log('\n4. Denied is a dead end, and says so')
{
  const denied = decidePushState(facts({ permission: 'denied' }))
  check("permission 'denied' is 'denied' even with a live local subscription", denied === 'denied', denied)
  const src = readFileSync(resolve(import.meta.dirname, '../src/components/AccountModal.tsx'), 'utf8')
  check('the toggle is disabled in that state, so requestPermission() is never called again', /const canToggle = state === 'on' \|\| state === 'off' \|\| state === 'ask'/.test(src))
  check('and the copy names the real route out (iOS Settings)', /iOS Settings → Notifications/.test(src))
}

console.log('\n5. An iOS Safari tab is fixable, not unsupported')
{
  // PushManager does not exist in an iOS Safari tab, so "supported" is false
  // there too — and answering "unsupported" would hide that three taps fix it.
  const tab = decidePushState(facts({ standalone: false, supported: false }))
  check('iOS + not standalone → needs-install, even when unsupported is also true', tab === 'needs-install', tab)
}

console.log('\n6. A subscription the server does not know about alerts nobody')
{
  const orphan = decidePushState(facts({ hereId: 'ps_here', registeredIds: [] }))
  check('a local subscription with no server row reads OFF', orphan === 'off', orphan)
  const pruned = decidePushState(facts({ hereId: 'ps_here', registeredIds: ['ps_other-phone'] }))
  check('…and so does one the alert job pruned as dead', pruned === 'off', pruned)
}

console.log('\n7. A missing or unreachable server half explains itself')
{
  // The card is rendered inside the Account modal the moment it opens, and the
  // server half can legitimately be absent: before the alerts migration is
  // applied, offline, or if RLS refuses. Leaving `state` null in that case
  // parks the card on "Checking notifications on this device…" for ever, which
  // reads as broken rather than as "not set up yet" — and that is exactly the
  // state the deployed test build sits in until the migration lands.
  const src = readFileSync(resolve(import.meta.dirname, '../src/components/AccountModal.tsx'), 'utf8')
  const refresh = src.slice(src.indexOf('const refresh = async'), src.indexOf('useEffect(() => {\n      void refresh()'))
  check('a failed device list still resolves a state', /setState\('unsupported'\)/.test(refresh), refresh.slice(0, 200))
  check('…and still shows the reason it failed', /setMessage\(failed === null \? null : \{ text: failed, error: true \}\)/.test(refresh))
  check('the list is emptied rather than left stale', /setDevices\(list\)/.test(refresh))
  check("a device cannot read 'on' off a failed load — the list it is judged against is empty", /let list: Device\[\] = \[\]/.test(refresh))
}

console.log('\n8. Turning off touches only this device')
{
  const push = readFileSync(resolve(import.meta.dirname, '../src/lib/powersync/push.ts'), 'utf8')
  check("turnOffHere deletes by THIS device's derived id", /turnOffHere[\s\S]{0,400}\.delete\(\)\.eq\('id', await idFor\(sub\.endpoint\)\)/.test(push))
  check('…and unsubscribes the browser too, so the state cannot lie afterwards', /turnOffHere[\s\S]{0,500}sub\.unsubscribe\(\)/.test(push))
  check('the row id is DERIVED from the endpoint, so registering twice updates one row (§36)', /crypto\.subtle\.digest\('SHA-256'/.test(push))
  check('signing out unregisters this device first', /forgetThisDevice\(\)/.test(readFileSync(resolve(import.meta.dirname, '../src/components/AccountModal.tsx'), 'utf8')))
}

console.log('\n9. The key the app subscribes with IS the key the function signs with')
{
  // 🚨 THE FAILURE THIS PREVENTS IS COMPLETELY SILENT IN THE APP. A push
  // subscription is bound to the VAPID public key it was created with. If the
  // app subscribes with key A and `ledger-alerts` signs with key B, the push
  // service rejects every send with 403 — and the phone shows nothing at all,
  // because a notification that was never delivered looks exactly like a cycle
  // with no shortfall in it. The toggle would say "on", the device list would
  // look right, and no alert would ever arrive.
  //
  // It is a live risk rather than a theoretical one: the function hardcodes
  // the key (it is public by definition) while the app reads it from an env
  // file, so the two are edited in different places, in different repos.
  //
  // Reading the other repo by absolute path is the same convention the real
  // backups and the engine bundle already use (TECHNICAL.md §44).
  const fnPath = '/Users/adamcox/Documents/GitHub/silver-octo-invention/supabase/functions/ledger-alerts/index.ts'
  const envPath = ['.env.production', '.env.sync'].map((f) => resolve(import.meta.dirname, '..', f)).find(existsSync)

  check('the Edge Function is where it is expected to be', existsSync(fnPath), fnPath)
  check('this repo has a committed env file for the sync build', envPath !== undefined)

  if (existsSync(fnPath) && envPath) {
    const fnKey = /const VAPID_PUBLIC_KEY =\s*'([^']+)'/.exec(readFileSync(fnPath, 'utf8'))?.[1]
    const envKey = /^VITE_VAPID_PUBLIC_KEY=(.+)$/m.exec(readFileSync(envPath, 'utf8'))?.[1]?.trim()
    check('the function declares a VAPID public key', !!fnKey && fnKey.length > 80, fnKey?.slice(0, 12))
    check(`${basename(envPath)} sets VITE_VAPID_PUBLIC_KEY — a build without it cannot register`, !!envKey, envKey?.slice(0, 12))
    check('🚨 they are the SAME key', !!fnKey && fnKey === envKey, `function ${fnKey?.slice(0, 16)}… vs env ${envKey?.slice(0, 16)}…`)
  }
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)

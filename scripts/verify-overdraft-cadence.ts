// SYNC APP ONLY. PROMPT-15 §0 Q7/Q8 (2026-09-22) — the two alerts fire at
// different rates, and the weekly one goes quiet while nothing has changed.
//
// Adam's design, and it is better than anything I proposed:
//
//   "overdraft needs to be a bit smarter. First off, it should fire on Sundays
//    if possible, but there needs to be a second check. If a user was in
//    overdraft at the last notification, and they haven't come out of it since
//    last week, then the notification should not fire the second week."
//
// 🚨 WHY IT BEATS A TOGGLE: it is SELF-CLEARING. Someone who lives in their
// overdraft stops hearing about it without having to turn anything off, and
// starts hearing about it again the moment their situation actually changes.
// A toggle would have put that work on the person, and a person who turns an
// alert off never turns it back on.
//
// 🚨 AND WHY THE OUT-OF-MONEY ALERT IS NOT TREATED THE SAME: running out of
// money is worth repeating every night. Only the heads-up gets the weekly
// cadence. Giving both the Sunday rule would mean someone heading for a real
// shortfall on a Wednesday hears nothing until the following Sunday.
//
// The controls, both of which are the obvious simplification:
//   - dropping the weekday test, which must make a Wednesday fire;
//   - suppressing on "still in overdraft today" rather than "has not been out
//     since the last alert", which never lets the alert back in.
//
// What it asserts:
//  1. the heads-up fires on a Sunday and on no other day, in BST and GMT;
//  2. the out-of-money alert fires every day, Sunday or not;
//  3. never told before → sends;
//  4. told, and the cleared balance has not reached £0 since → SILENT;
//  5. told, and it did reach £0 since → sends again;
//  6. the withheld reason is reported, so the suppression is distinguishable
//     from the dedupe (both produce silence, and Adam's 30-minute cron test
//     depends on telling them apart);
//  7. the dedupe key carries the severity, which is what lets (4) find the
//     last OVERDRAFT alert rather than the last alert of any kind.

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { toRows } from '../src/lib/powersync/mapping'
import { alertsFor } from '../src/lib/powersync/alertEngine'
import { cameOutOfOverdraftSince, isSunday, watchedAccounts } from '../src/lib/shortfall'
import type { AppDataV2, Pot } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 400))
  }
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures'
const HH = '11111111-2222-3333-4444-555555555555'
const base = parseLedgerBackupJson(readFileSync(`${DIR}/finance-ledger-backup-2026-09-15.json`, 'utf8'))
const OWNER = base.people[0].id

// 2026-09-13 is a Sunday; 2026-09-16 a Wednesday. Both BST.
// 2026-12-13 is a Sunday; 2026-12-16 a Wednesday. Both GMT.
const SUN_BST = '2026-09-13'
const WED_BST = '2026-09-16'
const SUN_GMT = '2026-12-13'
const WED_GMT = '2026-12-16'

console.log('\n0. The fixture dates really are what this file claims')
for (const [d, want] of [[SUN_BST, true], [SUN_GMT, true], [WED_BST, false], [WED_GMT, false]] as const) {
  check(`${d} → ${want ? 'Sunday' : 'not Sunday'}`, isSunday(d) === want)
}

/** A household with one pot, in or past its overdraft, and everyone linked to a user. */
function household(overdraftAmount: number, openingBalance: number) {
  const pot: Pot = { id: 'od-pot', personId: OWNER, name: 'Test', openingBalance, openingDate: '2026-01-01', active: true, color: '#888', overdraftAmount }
  const data: AppDataV2 = { ...base, pots: [pot] }
  const rows = toRows(data, { householdId: HH })
  rows.people = rows.people.map((r, i) => ({ ...r, linked_user_id: `user-${i}` }))
  return { data, rows, pot, userId: `user-${base.people.findIndex((p) => p.id === OWNER)}` }
}

const asOf = (iso: string) => new Date(`${iso}T12:00:00Z`)

console.log('\n1. The heads-up is Sundays only — and the CONTROL that would fire midweek')
{
  const { rows } = household(500, -100) // inside the limit → 'overdraft'
  const sunday = alertsFor(rows, asOf(SUN_BST), SUN_BST)
  const wednesday = alertsFor(rows, asOf(WED_BST), WED_BST)
  check('Sunday (BST): it sends', sunday.send.some((a) => a.severity === 'overdraft'), sunday.send.map((a) => a.severity))
  check('Wednesday (BST): nothing sent', !wednesday.send.some((a) => a.severity === 'overdraft'), wednesday.send.map((a) => a.severity))
  check("…withheld, and it says WHY: 'not-sunday'", wednesday.withheld.some((w) => w.reason === 'not-sunday'), wednesday.withheld)

  const sundayGmt = alertsFor(rows, asOf(SUN_GMT), SUN_GMT)
  const wedGmt = alertsFor(rows, asOf(WED_GMT), WED_GMT)
  check('Sunday (GMT): it sends', sundayGmt.send.some((a) => a.severity === 'overdraft'))
  check('Wednesday (GMT): nothing sent', !wedGmt.send.some((a) => a.severity === 'overdraft'))

  // 🚨 THE CONTROL. The withheld entry proves there WAS an alert to send on
  // Wednesday and the weekday test is the only thing that stopped it — which
  // is exactly what a version without the test would have delivered.
  check(
    'the control: Wednesday had a real alert, withheld ONLY for the weekday',
    wednesday.withheld.filter((w) => w.severity === 'overdraft' && w.reason === 'not-sunday').length === sunday.send.filter((a) => a.severity === 'overdraft').length,
    [wednesday.withheld, sunday.send.map((a) => a.severity)],
  )
}

console.log('\n2. The out-of-money alert is NIGHTLY, Sunday or not')
{
  const { rows } = household(500, -600) // past the limit → 'shortfall'
  for (const d of [SUN_BST, WED_BST, SUN_GMT, WED_GMT]) {
    const r = alertsFor(rows, asOf(d), d)
    check(`${d}: it sends`, r.send.some((a) => a.severity === 'shortfall'), r.send.map((a) => a.severity))
  }
  check('…and it is never withheld for the weekday', alertsFor(rows, asOf(WED_BST), WED_BST).withheld.every((w) => w.severity !== 'shortfall'))
}

console.log('\n3. The suppression: never told before → sends')
{
  const { rows } = household(500, -100)
  const r = alertsFor(rows, asOf(SUN_BST), SUN_BST, {})
  check('with an empty history it sends', r.send.some((a) => a.severity === 'overdraft'))
  check('…and nothing is withheld', r.withheld.length === 0, r.withheld)
}

console.log('\n4. Told, and still in it since → SILENT')
{
  const { data, rows, pot, userId } = household(500, -100)
  // Nothing clears in this fixture's pot, so the cleared balance never
  // recovers from its negative opening balance.
  const account = watchedAccounts(data).find((a) => a.id === 'od-pot')!
  check('the cleared balance never reached £0 since last Sunday', cameOutOfOverdraftSince(data, account, '2026-09-06', asOf(SUN_BST)) === false)

  const r = alertsFor(rows, asOf(SUN_BST), SUN_BST, { [`pot:od-pot:${userId}`]: '2026-09-06' })
  check('🚨 it is NOT sent', !r.send.some((a) => a.severity === 'overdraft'), r.send.map((a) => a.severity))
  check("…and the reason is reported: 'still-in-overdraft'", r.withheld.some((w) => w.reason === 'still-in-overdraft'), r.withheld)
}

console.log('\n5. Told, but it came out since → sends again')
{
  const { data, rows, pot, userId } = household(500, -100)
  // A cleared deposit that takes it back above zero, after the last alert —
  // and then a payment that puts it back under AFTER today.
  //
  // 🚨 BOTH LEGS ARE REQUIRED, and the second one only since 2026-09-22, when
  // the search window moved to start tomorrow ("ignore today, look from
  // tomorrow and report the first dip"). Recovery alone now means there is
  // nothing to alert about at all — correctly — so a fixture with only the
  // deposit tests nothing about the cadence. It is the account that came out
  // and went back in that the "sends again" rule is about.
  const recovered: AppDataV2 = {
    ...data,
    transactions: [
      ...data.transactions,
      { id: 'rec', type: 'transfer', direction: 'in', amount: 400, date: '2026-09-09', status: 'cleared', location: 'personal',
        fromLocation: { type: 'personal', ownerId: OWNER }, toLocation: { type: 'pot', potId: 'od-pot' } } as AppDataV2['transactions'][number],
      { id: 'back-under', type: 'transfer', direction: 'out', amount: 400, date: '2026-09-15', status: 'pending', location: 'personal',
        fromLocation: { type: 'pot', potId: 'od-pot' }, toLocation: { type: 'personal', ownerId: OWNER } } as AppDataV2['transactions'][number],
    ],
  }
  const account = watchedAccounts(recovered).find((a) => a.id === 'od-pot')!
  check('the cleared balance DID reach £0 since last Sunday', cameOutOfOverdraftSince(recovered, account, '2026-09-06', asOf(SUN_BST)) === true)

  const rows2 = toRows(recovered, { householdId: HH })
  rows2.people = rows2.people.map((r, i) => ({ ...r, linked_user_id: `user-${i}` }))
  const r = alertsFor(rows2, asOf(SUN_BST), SUN_BST, { [`pot:od-pot:${userId}`]: '2026-09-06' })
  check('🚨 the silence is broken — it sends again', r.send.some((a) => a.severity === 'overdraft'), r.send.map((a) => a.severity))

  // 🚨 THE CONTROL, properly. The tempting rule is "suppress while the account
  // is in its overdraft TODAY". Here it IS — that is why there is an alert to
  // send at all — so that rule would stay silent, and having never let the
  // alert back in, would stay silent for ever.
  const inOverdraftToday = alertsFor(rows2, asOf(SUN_BST), SUN_BST, {}).send.some((a) => a.severity === 'overdraft')
  // The naive rule, written out: suppress iff in overdraft today.
  const naiveSuppresses = inOverdraftToday
  const realSends = r.send.some((a) => a.severity === 'overdraft')
  check('the control: it IS in its overdraft today, so the naive rule suppresses…', naiveSuppresses === true)
  check('🚨 …whereas the real rule, keyed on RECOVERY since the last alert, sends', realSends === true)
  // The naive rule sends iff it does not suppress. The two rules disagree here,
  // which is the whole point of preferring the real one.
  const naiveSends = !naiveSuppresses
  check('…and the two rules therefore disagree, which is the whole point', naiveSends !== realSends, { naiveSends, realSends })
}

console.log('\n6. Told TODAY → silent (nothing has had time to change)')
{
  const { rows, userId } = household(500, -100)
  const r = alertsFor(rows, asOf(SUN_BST), SUN_BST, { [`pot:od-pot:${userId}`]: SUN_BST })
  check('same-day repeat is withheld', !r.send.some((a) => a.severity === 'overdraft'), r.send.map((a) => a.severity))
  check("…as 'still-in-overdraft', reported separately from the dedupe", r.withheld.some((w) => w.reason === 'still-in-overdraft'))
}

console.log('\n7. The dedupe key carries the severity, which is what makes (4) possible')
{
  const heads = alertsFor(household(500, -100).rows, asOf(SUN_BST), SUN_BST).send.find((a) => a.severity === 'overdraft')!
  const out = alertsFor(household(500, -600).rows, asOf(SUN_BST), SUN_BST).send.find((a) => a.severity === 'shortfall')!
  check('the heads-up key names its severity', heads.dedupeKey.startsWith('shortfall:overdraft:'), heads.dedupeKey)
  check('the out-of-money key names its own', out.dedupeKey.startsWith('shortfall:shortfall:'), out.dedupeKey)
  check('🚨 they differ, so the last OVERDRAFT alert is findable', heads.dedupeKey !== out.dedupeKey)
  check('the tags differ too, so an escalation never replaces the heads-up on the phone', heads.tag !== out.tag, [heads.tag, out.tag])
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)

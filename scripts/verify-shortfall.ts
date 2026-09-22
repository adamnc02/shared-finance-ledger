// PROMPT-14 Part 7 (2026-09-22) — the shortfall rule itself.
//
// 🚨 THE CONTROL IS THE POINT OF THIS FILE. Section 2 runs the cheap version
// of the rule — compare the projected END-of-cycle balance with zero — over a
// household built to end the cycle healthy after dipping below zero mid-cycle,
// and requires it to MISS what the real rule catches. That one line shorter
// version is what someone will "simplify" this into, it looks equivalent, and
// it loses the entire feature: money that is £200 short on the 12th and £400
// up by the 28th still bounces a direct debit on the 12th.
//
// The other thing it pins is WHAT IS WATCHED, because two of the exclusions
// are counter-intuitive and all three are one-word changes away:
//   - `SavingsPot` is not watched at all. There are two pot types and only
//     `Pot` is in scope;
//   - a Coin Jar (`Pot` with isCoinJar: true) is not watched. It emptying is
//     it working;
//   - a credit card is not watched. A balance owed is not a balance held.
//
// What it asserts:
//  1. the three real backups produce a sane watch list — every person, every
//     non-Coin-Jar pot, joint when it exists, and nothing else;
//  2. the CONTROL: a mid-cycle dip that recovers is caught by the dip rule and
//     missed by an end-of-cycle comparison;
//  3. a day-zero balance of exactly £0.00 is NOT a shortfall (below zero means
//     below zero);
//  4. recipients: personal and pot claim their owner only; joint claims
//     everyone; nobody else is ever named;
//  5. the dedupe key carries the London DATE, and two consecutive evenings
//     produce two different keys — the thing that makes "every evening until
//     it clears" work at all;
//  6. the engine used is the app's own: the series this walks is identical to
//     the one the Trends chart builds for the same account and cycle.

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { buildPersonalTrendSeries } from '../src/lib/projection'
import { cycleBalanceSeries, findShortfalls, shortfallDedupeKey, watchedAccounts } from '../src/lib/shortfall'
import type { AppDataV2, Pot } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 500))
  }
}

const DIR = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger'
const BACKUPS = ['finance-ledger-backup-2026-09-15.json', 'finance-ledger-backup-2026-09-15-mum.json', 'finance-ledger-backup-2026-09-17-mum.json']
const load = (name: string) => parseLedgerBackupJson(readFileSync(`${DIR}/${name}`, 'utf8'))
const AS_OF = new Date(2026, 8, 15) // 2026-09-15, the date the first backup was exported

console.log('\n1. What is watched, over the three real backups')
for (const name of BACKUPS) {
  const data = load(name)
  const accounts = watchedAccounts(data)
  const personal = accounts.filter((a) => a.kind === 'personal')
  const pots = accounts.filter((a) => a.kind === 'pot')
  const joint = accounts.filter((a) => a.kind === 'joint')

  check(`${name}: one personal account per person`, personal.length === data.people.length, [personal.length, data.people.length])
  const expectedPots = (data.pots ?? []).filter((p) => p.active && p.isCoinJar !== true)
  check(`${name}: every active non-Coin-Jar pot, and no other`, pots.length === expectedPots.length && pots.every((a) => expectedPots.some((p) => p.id === a.id)), [pots.length, expectedPots.length])
  check(`${name}: joint watched iff the account exists`, joint.length === (data.jointAccount ? 1 : 0))
  check(`${name}: no savings pot is watched`, !accounts.some((a) => (data.savingsPots ?? []).some((s) => s.id === a.id)), (data.savingsPots ?? []).length)
  check(`${name}: no credit card is watched`, !accounts.some((a) => data.creditCards.some((c) => c.id === a.id)), data.creditCards.length)
}

console.log('\n2. CONTROL — the dip, not the end-of-cycle balance')
{
  // A pot that starts the cycle with £100, pays out £300 early, and is topped
  // up by £400 later: £200 SHORT mid-cycle, £200 UP by the end.
  const data = load(BACKUPS[0])
  const owner = data.people[0].id
  const pot: Pot = { id: 'dip-pot', personId: owner, name: 'Dip', openingBalance: 100, openingDate: '2026-01-01', active: true, color: '#888' }
  const cycle = cycleBalanceSeries({ ...data, pots: [pot] }, watchedAccounts({ ...data, pots: [pot] }).find((a) => a.id === 'dip-pot')!, AS_OF)
  check('the cycle really does have days to walk', cycle.length > 3, cycle.length)

  const early = cycle[1].date
  const late = cycle[cycle.length - 1].date
  const withDip: AppDataV2 = {
    ...data,
    pots: [pot],
    transactions: [
      ...data.transactions,
      { id: 'dip-out', type: 'transfer', direction: 'out', amount: 300, date: early, status: 'pending', location: 'personal', fromLocation: { type: 'pot', potId: pot.id }, toLocation: { type: 'personal', ownerId: owner } } as AppDataV2['transactions'][number],
      { id: 'dip-in', type: 'transfer', direction: 'in', amount: 400, date: late, status: 'pending', location: 'personal', fromLocation: { type: 'personal', ownerId: owner }, toLocation: { type: 'pot', potId: pot.id } } as AppDataV2['transactions'][number],
    ],
  }

  const series = cycleBalanceSeries(withDip, watchedAccounts(withDip).find((a) => a.id === 'dip-pot')!, AS_OF)
  const endOfCycle = series[series.length - 1].balance
  const lowest = Math.min(...series.map((p) => p.balance))
  check('the account ends the cycle healthy', endOfCycle > 0, endOfCycle)
  check('…having been below zero during it', lowest < 0, lowest)

  const found = findShortfalls(withDip, AS_OF).filter((s) => s.account.id === 'dip-pot')
  check('the dip rule catches it', found.length === 1, found.map((f) => [f.date, f.amount]))
  check('…and names the FIRST day it goes under, not the worst or the last', found[0]?.date === series.find((p) => p.balance < 0)!.date, [found[0]?.date, series.find((p) => p.balance < 0)?.date])
  check('…and how far under it goes, to the penny', found[0]?.amount === Math.round(-series.find((p) => p.balance < 0)!.balance * 100) / 100, [found[0]?.amount, series.find((p) => p.balance < 0)?.balance])

  // THE CONTROL. This is the "simplification" that must not pass.
  const endOfCycleRule = endOfCycle < 0
  check('an end-of-cycle comparison MISSES it — which is why this rule is not that one', endOfCycleRule === false)
}

console.log('\n3. Exactly zero is not a shortfall')
{
  const data = load(BACKUPS[0])
  const owner = data.people[0].id
  const pot: Pot = { id: 'zero-pot', personId: owner, name: 'Zero', openingBalance: 0, openingDate: '2026-01-01', active: true, color: '#888' }
  const withPot = { ...data, pots: [pot] }
  const found = findShortfalls(withPot, AS_OF).filter((s) => s.account.id === 'zero-pot')
  const series = cycleBalanceSeries(withPot, watchedAccounts(withPot).find((a) => a.id === 'zero-pot')!, AS_OF)
  check('a pot sitting at exactly £0.00 all cycle', series.every((p) => p.balance === 0), series.slice(0, 3))
  check('…raises nothing: below zero means below zero', found.length === 0, found)
}

console.log('\n4. Recipients')
{
  const data = load(BACKUPS[0]) // Adam and Ella
  const accounts = watchedAccounts(data)
  const personal = accounts.filter((a) => a.kind === 'personal')
  check('a personal account names its owner and nobody else', personal.every((a) => a.personIds.length === 1 && a.personIds[0] === a.id), personal.map((a) => a.personIds))
  const pots = accounts.filter((a) => a.kind === 'pot')
  check('a pot names exactly one person — a Pot is never joint', pots.every((a) => a.personIds.length === 1), pots.map((a) => a.personIds))
  check('…specifically the pot’s own owner', pots.every((a) => a.personIds[0] === (data.pots ?? []).find((p) => p.id === a.id)!.personId))
  const joint = accounts.find((a) => a.kind === 'joint')
  check('joint names everyone in the household', !joint || (joint.personIds.length === data.people.length && data.people.every((p) => joint.personIds.includes(p.id))), joint?.personIds)
  check('no account names a person who is not in the household', accounts.every((a) => a.personIds.every((id) => data.people.some((p) => p.id === id))))
}

console.log('\n5. The dedupe key carries the London date')
{
  const data = load(BACKUPS[0])
  const account = watchedAccounts(data)[0]
  const shortfall = { account, date: '2026-09-20', amount: 12.34, cycleStart: '2026-09-01', cycleEnd: '2026-09-30' }
  const monday = shortfallDedupeKey(shortfall, account.personIds[0], '2026-09-21')
  const tuesday = shortfallDedupeKey(shortfall, account.personIds[0], '2026-09-22')
  check('the key contains the date', monday.endsWith(':2026-09-21'), monday)
  check('two consecutive evenings claim two different keys ("every evening until it clears")', monday !== tuesday)
  check('two people on one joint account claim separately', shortfallDedupeKey(shortfall, 'person-a', '2026-09-21') !== shortfallDedupeKey(shortfall, 'person-b', '2026-09-21'))
  check('the same account, person and day claims once', shortfallDedupeKey(shortfall, 'person-a', '2026-09-21') === shortfallDedupeKey({ ...shortfall, amount: 99 }, 'person-a', '2026-09-21'))
  // CONTROL: the key Listly's event-shaped ones would have suggested.
  const dateless = monday.replace(':2026-09-21', '')
  check('a key with no date would make both evenings identical (the trap)', dateless === tuesday.replace(':2026-09-22', ''))
}

console.log("\n6. It is the app's own engine, not a second one")
{
  const data = load(BACKUPS[0])
  const person = data.people[0]
  const account = watchedAccounts(data).find((a) => a.kind === 'personal' && a.id === person.id)!
  const mine = cycleBalanceSeries(data, account, AS_OF)
  // What the Trends modal draws for the same account and the same cycle.
  const payCycle = data.payCycles.find((c) => c.personId === person.id)!
  const trend = buildPersonalTrendSeries(data, person.id, payCycle, 'this_cycle', AS_OF)
  check('same number of days as the Trends chart', mine.length === trend.balance.length, [mine.length, trend.balance.length])
  check('same projected balance on every single day, to the penny', mine.every((p, i) => p.balance === trend.balance[i].projectedBalance && p.date === trend.balance[i].date), mine.slice(0, 2))
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)

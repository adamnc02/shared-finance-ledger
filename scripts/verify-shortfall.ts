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
import { formatDayMonth } from '../src/lib/format'
import { buildPersonalTrendSeries } from '../src/lib/projection'
import { cycleBalanceSeries, findShortfalls, shortfallDedupeKey, shortfallMessage, watchedAccounts } from '../src/lib/shortfall'
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
const AS_OF_ISO = '2026-09-15'

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
  // 🚨 The dip here starts EARLY in the cycle, before today. The search window
  // begins tomorrow (Adam, 2026-09-22: "ignore today, look from tomorrow and
  // report the first dip"), so what is reported is the first day FROM TOMORROW
  // that is still under — not the day it originally went under, and not the
  // worst or the last.
  const firstFromTomorrow = series.find((p) => p.date > AS_OF_ISO && p.balance < 0)!.date
  check('…and names the first day FROM TOMORROW that it is under', found[0]?.date === firstFromTomorrow, [found[0]?.date, firstFromTomorrow])
  check('…which is NOT the day it originally went under', found[0]?.date !== series.find((p) => p.balance < 0)!.date, [found[0]?.date, series.find((p) => p.balance < 0)?.date])
  check('…nor the day it recovers', found[0]?.date !== late, [found[0]?.date, late])
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

console.log('\n4b. The message: two severities, two tenses, four cause shapes')
{
  const data = load(BACKUPS[0])
  const owner = data.people[0].id
  const messages: { title: string; body: string }[] = []
  const pot = (over: Partial<Pot> = {}): Pot => ({
    id: 'msg-pot', personId: owner, name: 'Car Fund', openingBalance: 100, openingDate: '2026-01-01',
    active: true, color: '#888', overdraftAmount: 0, ...over,
  })
  const base = { ...data, pots: [pot()] }
  const series = cycleBalanceSeries(base, watchedAccounts(base).find((a) => a.id === 'msg-pot')!, AS_OF)
  const ASOF_ISO = '2026-09-15'
  const future = series.find((p) => p.date > ASOF_ISO)!.date
  const past = series.find((p) => p.date < ASOF_ISO)!.date
  check('the fixture has days on both sides of "today"', past < ASOF_ISO && future > ASOF_ISO, [past, ASOF_ISO, future])

  const out = (id: string, amount: number, date: string, note: string) =>
    ({ id, type: 'transfer', direction: 'out', amount, date, status: 'pending', location: 'personal', note,
       fromLocation: { type: 'pot', potId: 'msg-pot' }, toLocation: { type: 'personal', ownerId: owner } }) as AppDataV2['transactions'][number]

  const incomeOn = (id: string, amount: number, date: string, note: string) =>
    ({ id, type: 'transfer', direction: 'in', amount, date, status: 'pending', location: 'personal', note,
       fromLocation: { type: 'personal', ownerId: owner }, toLocation: { type: 'pot', potId: 'msg-pot' } }) as AppDataV2['transactions'][number]

  const dataFor = (p: Pot, txs: AppDataV2['transactions']): AppDataV2 => ({ ...data, pots: [p], transactions: [...data.transactions, ...txs] })
  /** May legitimately find nothing — used where "no alert" is the assertion. */
  const buildMaybe = (p: Pot, txs: AppDataV2['transactions']) => findShortfalls(dataFor(p, txs), AS_OF).find((x) => x.account.id === 'msg-pot')
  const build = (p: Pot, txs: AppDataV2['transactions']) => buildMaybe(p, txs)!

  console.log('\n   A. Into your overdraft — £500 limit, dips to −£212.40')
  {
    const s1 = build(pot({ overdraftAmount: 500 }), [out('c1', 312.4, future, 'Rent')])
    check("severity is 'overdraft' — inside the limit", s1.severity === 'overdraft', s1.severity)
    check('the amount is measured from ZERO, not the limit', s1.amount === 212.4, s1.amount)
    const m = shortfallMessage(s1)
    check('title says "runs short"', m.title === 'Car Fund runs short', m.title)
    check('body says "into your £500 overdraft"', m.body.includes('takes you £212.40 into your £500 overdraft'), m.body)
    messages.push(m)
  }

  console.log('\n   B. Not enough money — £500 limit, £212.40 short')
  {
    const s2 = build(pot({ overdraftAmount: 500 }), [out('c1', 812.4, future, 'Rent')])
    check("severity is 'shortfall' — past the limit", s2.severity === 'shortfall', s2.severity)
    check('🚨 the amount is how much you are SHORT BY, not the balance', s2.amount === 212.4, s2.amount)
    const m = shortfallMessage(s2)
    check('title states the problem outright', m.title === 'Car Fund: not enough money', m.title)
    check('body says "short, even with your £500 overdraft"', m.body.includes('leaves you £212.40 short, even with your £500 overdraft'), m.body)
    check('🚨 it never describes an impossible balance', !m.body.includes('into your £500 overdraft'), m.body)
    messages.push(m)
  }

  console.log('\n   C. Not enough money — no overdraft')
  {
    const s3 = build(pot(), [out('c1', 312.4, future, 'Rent')])
    check("🚨 severity is 'shortfall', NOT 'overdraft' — there is no buffer to go into", s3.severity === 'shortfall', s3.severity)
    check('the amount is how much you are short by', s3.amount === 212.4, s3.amount)
    const m = shortfallMessage(s3)
    check('title states the problem outright', m.title === 'Car Fund: not enough money', m.title)
    check('body says simply "short"', m.body.includes('leaves you £212.40 short.'), m.body)
    check('…and never mentions an overdraft', !m.body.includes('overdraft'), m.body)
    messages.push(m)

    // THE CONTROL. The tempting rule — "below zero means you're in your
    // overdraft" — classifies this as a heads-up, downgrading a real
    // out-of-money alert on an account with no buffer at all.
    const naiveSeverity = (limit: number, balance: number) => (balance < 0 ? 'overdraft' : 'ok')
    check('the control: "below zero = overdraft" calls this a heads-up…', naiveSeverity(0, -212.4) === 'overdraft')
    check("…which is NOT what the real rule says", s3.severity === 'shortfall' && naiveSeverity(0, -212.4) !== s3.severity)
  }

  console.log('\n   D. Cause shapes')
  {
    const many = build(pot({ overdraftAmount: 500 }), [out('c1', 312.4, future, 'Rent'), out('c2', 120, future, 'Council Tax'), out('c3', 45, future, 'Broadband')])
    check('several payments are totalled and counted', shortfallMessage(many).body.startsWith('3 payments totalling £477.40 on '), shortfallMessage(many).body)
    check('…with the plural verb', shortfallMessage(many).body.includes('take you '), shortfallMessage(many).body)
    messages.push(shortfallMessage(many))

    const none = build(pot({ openingBalance: -50 }), [])
    check('an account already under on day one blames no payment', none.causes.length === 0, none.causes)

    // 🚨 THE WINDOW STARTS TOMORROW. Adam, 2026-09-22: "ignore today, look from
    // tomorrow and report the first dip". An alert sent at 20:00 is a heads-up
    // about what is coming; today has already happened.
    const pastDip = build(pot({ overdraftAmount: 500 }), [out('c1', 312.4, past, 'Rent')])
    check('a dip in the past is reported on TOMORROW, never on the day it happened', pastDip.date > ASOF_ISO, [pastDip.date, ASOF_ISO])
    check('…and the balance still carries it, so the figure is unchanged', pastDip.amount === 212.4, pastDip.amount)
    const mp = shortfallMessage(pastDip)
    check('…and it reads in the future tense, because that is when you can still act', mp.body.startsWith("You'll be £212.40 into your £500 overdraft on "), mp.body)
    messages.push(mp)

    // 🚨 CONTROL for the narrowed search: the WHOLE series — what it searched
    // before — still goes under on the past day. So the difference really is
    // the window, not the data. If this stops differing, it has been widened.
    const pd = dataFor(pot({ overdraftAmount: 500 }), [out('c1', 312.4, past, 'Rent')])
    const whole = cycleBalanceSeries(pd, watchedAccounts(pd).find((a) => a.id === 'msg-pot')!, AS_OF)
    // severity here is 'overdraft' (inside the £500 limit), so the old search
    // was `projectedBalance < 0` over the whole series.
    check('CONTROL: the whole series DOES dip on the past day, which the old search reported',
      whole.find((p) => p.balance < 0)?.date === past, whole.find((p) => p.balance < 0)?.date)

    // 🚨 And a dip that has already RECOVERED is no longer an alert at all.
    // Under the old rule this fired every evening about a day that was over.
    const recovered = buildMaybe(pot({ overdraftAmount: 0, openingBalance: 100 }), [out('c1', 150, past, 'Blip'), incomeOn('r1', 200, past, 'Top-up')])
    check('a past dip that has since recovered produces NO alert', recovered === undefined, recovered?.date)
  }

  console.log('\n   D2. 🚨 Money arriving BEFORE the dip is named, not hidden')
  {
    // Adam, 2026-09-22, on a real alert: the joint account had £100 in the day
    // before the dip, and the message still ended "Nothing more due in before
    // 29 September" — which read as "nothing is coming".
    const later = series.find((p) => p.date > future)!.date
    const s = build(pot({ overdraftAmount: 0 }), [incomeOn('i1', 100, future, 'Transfer in'), out('c1', 400, later, 'Rent')])
    check('moneyInBefore is populated', s.moneyInBefore?.amount === 100, s.moneyInBefore)
    check('…and names the day it lands', s.moneyInBefore?.date === future, s.moneyInBefore)
    const m = shortfallMessage(s)
    check('🚨 the body says "despite £100.00 due in on …"', m.body.includes(`despite £100.00 due in on ${formatDayMonth(future)}`), m.body)
    check('🚨 …and says "Nothing ELSE", which "Nothing more" would contradict', m.body.includes('Nothing else due in before '), m.body)
    messages.push(m)

    // CONTROL: with no money in beforehand, neither phrase appears.
    const plain = build(pot({ overdraftAmount: 0 }), [out('c1', 400, later, 'Rent')])
    const mp2 = shortfallMessage(plain)
    check('CONTROL: without it, no "despite" clause', !mp2.body.includes('despite'), mp2.body)
    check('CONTROL: …and it goes back to "Nothing more due in"', mp2.body.includes('Nothing more due in before '), mp2.body)

    // Several days of money in: no single date to name, so it says "before then".
    const spread = build(pot({ overdraftAmount: 0 }), [incomeOn('i1', 60, future, 'One'), incomeOn('i2', 40, series.find((p) => p.date > future)!.date, 'Two'), out('c1', 400, later, 'Rent')])
    if (spread.moneyInBefore && spread.moneyInBefore.date === null) {
      check('several days in: it says "before then" rather than naming one', shortfallMessage(spread).body.includes('due in before then'), shortfallMessage(spread).body)
    }
  }

  console.log('\n   E. Relief shapes')
  {
    const inDay = series.find((p) => p.date > future)!.date
    const income = (amount: number) =>
      ({ id: 'in1', type: 'transfer', direction: 'in', amount, date: inDay, status: 'pending', location: 'personal', note: 'Payday',
         fromLocation: { type: 'personal', ownerId: owner }, toLocation: { type: 'pot', potId: 'msg-pot' } }) as AppDataV2['transactions'][number]

    const recovers = build(pot({ overdraftAmount: 500 }), [out('c1', 312.4, future, 'Rent'), income(500)])
    check('enough money in: it recovers', recovers.recoversOn === inDay, [recovers.recoversOn, inDay])
    check('…and the body names the day', shortfallMessage(recovers).body.endsWith(`Next scheduled money in on ${formatDayMonth(inDay)}.`), shortfallMessage(recovers).body)

    const notEnough = build(pot({ overdraftAmount: 500 }), [out('c1', 812.4, future, 'Rent'), income(50)])
    check('🚨 money in but not enough: it does NOT claim recovery', notEnough.recoversOn === null, notEnough.recoversOn)
    check('…and says so explicitly', shortfallMessage(notEnough).body.endsWith("but you'll still be short after that."), shortfallMessage(notEnough).body)
    messages.push(shortfallMessage(notEnough))

    const nothing = build(pot({ overdraftAmount: 500 }), [out('c1', 312.4, future, 'Rent')])
    check('nothing due in: it says so', shortfallMessage(nothing).body.includes('Nothing more due in before '), shortfallMessage(nothing).body)
  }

  console.log('\n   F. recoversOn uses the SEVERITY\'s floor, not always zero')
  {
    const inDay = series.find((p) => p.date > future)!.date
    const income = (amount: number) =>
      ({ id: 'in1', type: 'transfer', direction: 'in', amount, date: inDay, status: 'pending', location: 'personal', note: 'Top-up',
         fromLocation: { type: 'personal', ownerId: owner }, toLocation: { type: 'pot', potId: 'msg-pot' } }) as AppDataV2['transactions'][number]
    // Past the £500 limit, then £400 in: back WITHIN the limit but still below zero.
    const s6 = build(pot({ overdraftAmount: 500 }), [out('c1', 812.4, future, 'Rent'), income(400)])
    check("'shortfall' recovers when back within the LIMIT, not above zero", s6.recoversOn === inDay, s6.recoversOn)
    check('…which is the earlier, correct date', s6.severity === 'shortfall')
  }

  console.log('\n   G. The joint account title')
  {
    const joint = watchedAccounts(data).find((a) => a.kind === 'joint')
    if (joint) {
      const base2 = { account: joint, date: '2026-09-20', amount: 10, cycleStart: '2026-09-01', cycleEnd: '2026-09-30', causes: [], nextMoneyIn: null, moneyInBefore: null, recoversOn: null }
      check('overdraft title', shortfallMessage({ ...base2, severity: 'overdraft' }).title === 'Your joint account runs short')
      check('not-enough title', shortfallMessage({ ...base2, severity: 'shortfall' }).title === 'Your joint account: not enough money')
    }
  }

  console.log('\n   — what the phone actually shows —')
  for (const m of messages) console.log(`     ${m.title}\n     ${m.body}`)
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

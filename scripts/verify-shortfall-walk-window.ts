// 2026-09-23 — the shortfall alert's TWO horizons, and the owner's payday.
//
// 🚨 THE REAL BUG THIS PREVENTS. On the evening of 2026-09-23 the live app sent Adam:
//
//     "Your joint account: not enough money
//      Disney+ (£14.99) on 28 September leaves you £13.57 short.
//      Nothing more due in before 7 October."
//
// Three things were wrong with four words of that, and every one of them was silent:
//
//  1. His £800 monthly deposit into the joint account WAS due in — on 28 September, the same day
//     as the Disney+ payment, which means there was no shortfall at all and the alert should
//     never have been sent.
//  2. "7 October" is not a payment date. It was the END OF ELLA'S FOUR-WEEKLY PAY CYCLE. The
//     joint account has no cycle of its own, so the engine borrowed the "primary" person's — and
//     on the server there is no primary (it is per-device and never syncs), so the Edge Function
//     guessed "the first `people` row with a linked user" off an unordered `select('*')`. Which
//     of them it picked was effectively random and could change from one night to the next.
//  3. The £800 did not go MISSING, which would have been obvious. It MOVED. A `followsPayday`
//     transfer was resolved against the primary person's payday instead of its OWNER's, so
//     Adam's deposit was generated on Ella's payday — 8 October, one day past the horizon the
//     same wrong cycle had set. Out of sight, and reported as "nothing more due in".
//
// Adam's rule, in his own words (2026-09-23): *"these notifications aren't tied to a cycle,
// they're simply a day-by-day walkthrough, stops when the day-end dips below target … 7 day walk
// ahead, but don't use the same limit for checking next incoming money, this is unbounded …
// next incoming is quite literally the next incoming cash"*.
//
// So: ONE walk, TWO horizons. Every section below is a control that reproduces one of the three
// defects when the horizons are collapsed back into one, or when the owner is ignored.

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { findShortfalls, shortfallMessage, watchedAccounts, cycleBalanceSeries, SHORTFALL_WALK_DAYS } from '../src/lib/shortfall'
import { computeJointAccountProjection } from '../src/lib/jointAccountLedger'
import { generateTransactionsForTemplate, payCycleForTemplate } from '../src/lib/schedule'
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
const load = (name: string) => parseLedgerBackupJson(readFileSync(`${DIR}/${name}`, 'utf8'))

// ───────────────────────────────────────────────────────────────────────────
console.log('\n1. The DIP search stops at SHORTFALL_WALK_DAYS days')
{
  const data = load('finance-ledger-backup-2026-09-15.json')
  const AS_OF = new Date(2026, 8, 15)
  const owner = data.people[0].id
  const iso = (offset: number) => {
    const d = new Date(2026, 8, 15 + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const pot = (): Pot => ({ id: 'w-pot', personId: owner, name: 'Window', openingBalance: 100, openingDate: '2026-01-01', active: true, color: '#888', overdraftAmount: 0 })
  const spend = (date: string) => ([{ id: 'x1', type: 'transfer', direction: 'out', amount: 400, date, status: 'pending', location: 'personal', note: 'Rent',
    fromLocation: { type: 'pot', potId: 'w-pot' }, toLocation: { type: 'personal', ownerId: owner } }] as AppDataV2['transactions'])
  const find = (date: string) => findShortfalls({ ...data, pots: [pot()], transactions: [...data.transactions, ...spend(date)] }, AS_OF).find((s) => s.account.id === 'w-pot')

  check(`SHORTFALL_WALK_DAYS is 7, as Adam specified`, SHORTFALL_WALK_DAYS === 7, SHORTFALL_WALK_DAYS)
  check('a dip TOMORROW is found', find(iso(1))?.date === iso(1), find(iso(1))?.date)
  check(`a dip on the LAST day of the window (day ${SHORTFALL_WALK_DAYS}) is found`, find(iso(SHORTFALL_WALK_DAYS))?.date === iso(SHORTFALL_WALK_DAYS), find(iso(SHORTFALL_WALK_DAYS))?.date)
  // 🚨 CONTROL. The walk still SEES this day — the balance really does go under — it is only the
  // SEARCH that stops. If this ever starts returning a shortfall, the window has been widened;
  // if the series check below starts failing, the WALK has been narrowed instead, which is the
  // mistake that truncates "next money in".
  check(`a dip one day PAST the window (day ${SHORTFALL_WALK_DAYS + 1}) raises nothing`, find(iso(SHORTFALL_WALK_DAYS + 1)) === undefined, find(iso(SHORTFALL_WALK_DAYS + 1))?.date)
  {
    const d = { ...data, pots: [pot()], transactions: [...data.transactions, ...spend(iso(SHORTFALL_WALK_DAYS + 1))] }
    const series = cycleBalanceSeries(d, watchedAccounts(d).find((a) => a.id === 'w-pot')!, AS_OF)
    const under = series.find((p) => p.balance < 0)
    check('CONTROL: …but the WALK still goes under on that very day — the window narrowed, not the walk',
      under?.date === iso(SHORTFALL_WALK_DAYS + 1), under)
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n2. "Next money in" is UNBOUNDED — it is not the same window')
{
  const data = load('finance-ledger-backup-2026-09-15.json')
  const AS_OF = new Date(2026, 8, 15)
  const owner = data.people[0].id
  const pot = (): Pot => ({ id: 'u-pot', personId: owner, name: 'Unbounded', openingBalance: 100, openingDate: '2026-01-01', active: true, color: '#888', overdraftAmount: 0 })
  const tx = (id: string, dir: 'in' | 'out', amount: number, date: string, note: string) =>
    ({ id, type: 'transfer', direction: dir, amount, date, status: 'pending', location: 'personal', note,
       fromLocation: dir === 'out' ? { type: 'pot', potId: 'u-pot' } : { type: 'personal', ownerId: owner },
       toLocation: dir === 'out' ? { type: 'personal', ownerId: owner } : { type: 'pot', potId: 'u-pot' } }) as AppDataV2['transactions'][number]

  // Dip in 3 days; the money that fixes it lands 40 days out — far outside the 7-day dip window
  // AND outside any pay cycle the old engine would have used.
  const d = { ...data, pots: [pot()], transactions: [...data.transactions, tx('o1', 'out', 400, '2026-09-18', 'Rent'), tx('i1', 'in', 900, '2026-10-25', 'Bonus')] }
  const s = findShortfalls(d, AS_OF).find((x) => x.account.id === 'u-pot')!
  check('the dip is still found, 3 days out', s.date === '2026-09-18', s.date)
  check('🚨 money 40 days away is NAMED, not swallowed', s.recoversOn === '2026-10-25', { recoversOn: s.recoversOn, nextMoneyIn: s.nextMoneyIn })
  const body = shortfallMessage(s).body
  check('🚨 …and the message says when, instead of "nothing more due in"', body.includes('Next scheduled money in on 25 October.'), body)
  check('CONTROL: it does NOT claim nothing is coming', !body.includes('Nothing more due in'), body)

  // The other half: when there genuinely IS nothing, the line carries NO DATE.
  const barren = { ...data, pots: [pot()], transactions: [...data.transactions, tx('o1', 'out', 400, '2026-09-18', 'Rent')] }
  const s2 = findShortfalls(barren, AS_OF).find((x) => x.account.id === 'u-pot')!
  const b2 = shortfallMessage(s2).body
  check('nothing coming at all: it says so', b2.includes('Nothing more due in.'), b2)
  // 🚨 THE "7 OCTOBER" DEFECT ITSELF. A date here names a day on which, by definition, nothing
  // happens — the search found nothing as far ahead as the ledger goes. Adam read the old one as
  // a payment date and went looking for what was due that day: an outgoing bill, nothing in.
  check('🚨 …with NO date after it, ever', !/Nothing (more|else) due in before/.test(b2), b2)
  check('…and the window is on the result for a check to read, not in the prose', s2.windowEnd === '2026-09-22' && s2.windowStart === '2026-09-16', [s2.windowStart, s2.windowEnd])
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n3. A followsPayday transfer uses its OWNER's payday — real data, both directions")
{
  const prod = load('finance-ledger-backup-2026-09-22-PROD.json')
  const AS_OF = new Date(2026, 8, 23, 20, 0, 0)
  const deposit = prod.recurringTemplates.find((t) => t.id === 'YGTD2W4m')!
  const adam = prod.people.find((p) => p.name === 'Adam')!
  const ella = prod.people.find((p) => p.name === 'Ella')!
  check('the fixture still holds Adam’s £800 followsPayday deposit into the joint account',
    deposit.amount === 800 && deposit.followsPayday === true && deposit.ownerId === adam.id, [deposit.amount, deposit.followsPayday])
  check('…and the two people really do have different paydays, or this proves nothing',
    prod.payCycles.find((c) => c.personId === ella.id)?.paySchedule?.kind === 'four_weekly_fiscal', prod.payCycles.find((c) => c.personId === ella.id)?.paySchedule)

  const datesFor = (primaryPersonId: string) =>
    (computeJointAccountProjection({ ...prod, primaryPersonId }, 'three_cycles', AS_OF)?.transactions ?? [])
      .filter((t) => t.amount === 800).map((t) => t.date)

  check('with Adam as primary, the £800 lands on his payday, 28 September', datesFor(adam.id)[0] === '2026-09-28', datesFor(adam.id))
  check('🚨 with ELLA as primary, it lands on 28 September too — it follows its OWNER', datesFor(ella.id)[0] === '2026-09-28', datesFor(ella.id))
  // They agree occurrence for occurrence as far as both are generated. The LENGTHS differ, and
  // legitimately so: `cyclePersonId` still decides how far ahead the ledger is GENERATED, and
  // Ella's four-weekly cycles reach further than Adam's monthly ones. That is a horizon, not a
  // boundary — no date below is ever compared against it.
  check('…and they agree occurrence for occurrence as far as both reach', (() => {
    const a = datesFor(adam.id), e = datesFor(ella.id)
    const n = Math.min(a.length, e.length)
    return n > 0 && a.slice(0, n).join() === e.slice(0, n).join()
  })(), [datesFor(adam.id), datesFor(ella.id)])
  check('🚨 and NEITHER puts it on 8 October, whoever is primary',
    !datesFor(adam.id).includes('2026-10-08') && !datesFor(ella.id).includes('2026-10-08'), [datesFor(adam.id), datesFor(ella.id)])

  // 🚨 CONTROL: the exact line that was there before. Resolving the same template against the
  // NON-owner's pay cycle moves it to 8 October — a day later than the window it then fell out
  // of, which is why it read as "nothing is coming" rather than as a wrong date.
  const wrong = generateTransactionsForTemplate(deposit, new Date(2026, 7, 1), new Date(2026, 11, 31), prod.payCycles.find((c) => c.personId === ella.id))
  check('CONTROL: against the NON-owner’s payday it moves to 8 October — the old behaviour', wrong[0]?.date === '2026-10-08', wrong.map((w) => w.date).slice(0, 2))
  check('CONTROL: …so the fix is the owner lookup, not a coincidence of the fixture',
    payCycleForTemplate(deposit, prod.payCycles, ella.id)?.personId === adam.id, payCycleForTemplate(deposit, prod.payCycles, ella.id)?.personId)
  check('a template with NO owner still falls back, so joint-location bills are unaffected',
    payCycleForTemplate({ ownerId: '' }, prod.payCycles, ella.id)?.personId === ella.id)
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n4. The whole defect, end to end, against the real export')
{
  const prod = load('finance-ledger-backup-2026-09-22-PROD.json')
  const AS_OF = new Date(2026, 8, 23, 20, 0, 0)
  const adam = prod.people.find((p) => p.name === 'Adam')!
  const ella = prod.people.find((p) => p.name === 'Ella')!

  for (const who of [adam, ella]) {
    const d = { ...prod, primaryPersonId: who.id }
    const joint = findShortfalls(d, AS_OF).filter((s) => s.account.kind === 'joint')
    // 🚨 THE ALERT ADAM ACTUALLY GOT. Before the fix this produced, with Ella as primary,
    // "Disney+ (£14.99) on 28 September leaves you £13.57 short. Nothing more due in before
    // 7 October." — and nothing at all with Adam as primary. The £800 covers the £14.99 on the
    // very same day, so the right answer is silence, whoever is primary.
    check(`no joint alert with ${who.name} as primary — the £800 covers it on the day`, joint.length === 0,
      joint.map((s) => shortfallMessage(s).body))
  }

  // CONTROL: the alert is not simply switched off. Take the £800 deposit away and the shortfall
  // comes back — same day, same penny — but now with an honest ending.
  const without = { ...prod, primaryPersonId: ella.id, recurringTemplates: prod.recurringTemplates.filter((t) => t.id !== 'YGTD2W4m') }
  const back = findShortfalls(without, AS_OF).filter((s) => s.account.kind === 'joint')
  check('CONTROL: remove the £800 and the alert returns', back.length === 1, back.length)
  check('CONTROL: …on 28 September, £13.57 short — the real figures', back[0]?.date === '2026-09-28' && back[0]?.amount === 13.57, [back[0]?.date, back[0]?.amount])
  const body = back[0] ? shortfallMessage(back[0]).body : ''
  check('CONTROL: …and it no longer names 7 October, or any other date, as "due in"', !body.includes('before 7 October') && !/due in before/.test(body), body)
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)

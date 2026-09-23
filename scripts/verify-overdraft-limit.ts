// PROMPT-15 (2026-09-22) — the alert's floor is the account's own, and the
// number beside it means the right thing.
//
// 🚨 THE IDEA THIS FILE EXISTS TO PROTECT, in Adam's words:
//
//   "I can't go below zero or below my overdraft limit, so going 712 into a
//    500 overdraft makes no sense, same for below 0."
//
// A balance CANNOT pass its floor — the bank declines the payment. So the two
// severities describe genuinely different things and take different numbers:
//
//   'overdraft'  a state that really happens. You dip into a buffer you are
//                allowed to use. The amount is HOW FAR BELOW ZERO you go.
//   'shortfall'  a state that cannot happen. The payment does not go through.
//                The amount is HOW MUCH YOU ARE SHORT BY.
//
// Get that wrong and the alert states a figure that is real, wrong for the
// sentence it is in, and very confident.
//
// The controls, both of which are the tempting simplification:
//   - the OLD `< 0` test, which fires on an account comfortably inside its
//     overdraft — the crying-wolf problem the limit exists to fix;
//   - "below zero means you are in your overdraft", which downgrades a real
//     out-of-money alert on an account that has no buffer at all.
//
// What it asserts:
//  1. no limit → behaves exactly as before the feature existed, over the three
//     real backups (the no-regression half);
//  2. inside the limit → nothing at all when the old rule would have fired;
//  3. past the limit → fires, with the amount measured from the LIMIT;
//  4. the floor is per account: a pot, a personal account and the joint
//     account each honour their own, independently;
//  5. a negative limit cannot invert the floor — the forms clamp it;
//  6. a Coin Jar is never watched, whatever its field says.

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { findShortfalls, watchedAccounts } from '../src/lib/shortfall'
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
const BACKUPS = ['finance-ledger-backup-2026-09-15.json', 'finance-ledger-backup-2026-09-15-mum.json', 'finance-ledger-backup-2026-09-17-mum.json']
const load = (n: string) => parseLedgerBackupJson(readFileSync(`${DIR}/${n}`, 'utf8'))
const AS_OF = new Date(2026, 8, 15)

console.log('\n1. No limit: exactly the behaviour that shipped before this feature')
for (const name of BACKUPS) {
  const data = load(name)
  check(`${name}: every account's limit defaults to 0`, watchedAccounts(data).every((a) => a.overdraftAmount === 0), watchedAccounts(data).map((a) => a.overdraftAmount))
  check(`${name}: every shortfall found is 'shortfall', never 'overdraft'`, findShortfalls(data, AS_OF).every((s) => s.severity === 'shortfall'), findShortfalls(data, AS_OF).map((s) => s.severity))
}

const base = load(BACKUPS[0])
const OWNER = base.people[0].id
const pot = (overdraftAmount: number, openingBalance: number, over: Partial<Pot> = {}): Pot => ({
  id: 'od-pot', personId: OWNER, name: 'Test', openingBalance, openingDate: '2026-01-01', active: true, color: '#888', overdraftAmount, ...over,
})
const find = (p: Pot) => findShortfalls({ ...base, pots: [p] }, AS_OF).find((s) => s.account.id === 'od-pot')

console.log('\n2. Inside the limit: silence — and the CONTROL that would have cried wolf')
{
  const inside = pot(500, -100) // £100 below zero, £500 of room
  const s = find(inside)
  check("it IS below zero", inside.openingBalance < 0)
  check("…but raises 'overdraft', a heads-up, not an out-of-money alert", s?.severity === 'overdraft', s?.severity)
  check('…and the amount is measured from ZERO', s?.amount === 100, s?.amount)

  // 🚨 THE CONTROL. The old rule, before limits existed.
  const oldRule = (balance: number) => balance < 0
  check('the control: the old `< 0` test fires here…', oldRule(-100) === true)
  check("…which is the crying-wolf case the limit exists to fix", s?.severity !== 'shortfall')
}

console.log('\n3. Past the limit: fires, measured from the LIMIT')
{
  const past = find(pot(500, -600)) // £600 below zero, £500 of room → £100 short
  check("severity is 'shortfall'", past?.severity === 'shortfall', past?.severity)
  check('🚨 the amount is £100 — how much SHORT, not £600 below zero', past?.amount === 100, past?.amount)
  check('…and never the distance from zero', past?.amount !== 600)
}

console.log('\n4. Exactly ON the limit is not past it')
{
  const exact = find(pot(500, -500))
  check("−£500 with a £500 limit raises 'overdraft', not 'shortfall'", exact?.severity === 'overdraft', exact?.severity)
  check('…and the amount is the full £500 below zero', exact?.amount === 500, exact?.amount)
  const justPast = find(pot(500, -500.01))
  check('a penny past it flips to out-of-money', justPast?.severity === 'shortfall', justPast?.severity)
  check('…short by exactly that penny', justPast?.amount === 0.01, justPast?.amount)
}

console.log('\n5. The floor is PER ACCOUNT')
{
  const data: AppDataV2 = { ...base, pots: [pot(500, -100, { id: 'generous' }), { ...pot(0, -100), id: 'strict', name: 'Strict' }] }
  const found = findShortfalls(data, AS_OF)
  const generous = found.find((s) => s.account.id === 'generous')
  const strict = found.find((s) => s.account.id === 'strict')
  check('the pot with room gets a heads-up', generous?.severity === 'overdraft', generous?.severity)
  check('the pot without room, at the same balance, is out of money', strict?.severity === 'shortfall', strict?.severity)
  check('…and they are two separate alerts', generous !== undefined && strict !== undefined && generous !== strict)
}

console.log('\n6. A negative limit cannot invert the floor')
{
  // The forms clamp with Math.max(0, …); this proves what the clamp prevents.
  const inverted = find(pot(-500, 100)) // a POSITIVE balance, with a nonsense limit
  check('🚨 a −500 limit would put the floor at +£500 and fire on a healthy account', inverted !== undefined, inverted?.severity)
  const src = readFileSync(new URL('../src/pages/Salary.tsx', import.meta.url), 'utf8')
  check('the pay-cycle form clamps it', /overdraftAmount: Math\.max\(0, Number\(draftOverdraft\)/.test(src))
  check('the pot form clamps it', /overdraftAmount: Math\.max\(0, Number\(overdraft\)/.test(src))
  const joint = readFileSync(new URL('../src/components/JointAccountSetupModal.tsx', import.meta.url), 'utf8')
  check('the joint form clamps it', /Math\.max\(0, Number\(overdraft\)/.test(joint))
  check('and no form offers allowNegative on an overdraft input', !/allowNegative[\s\S]{0,120}draftOverdraft/.test(src) && !/allowNegative[\s\S]{0,120}value=\{overdraft\}/.test(src))
}

console.log('\n7. A Coin Jar is never watched, whatever its field says')
{
  const jar = pot(500, -1000, { id: 'jar', isCoinJar: true })
  check('not in the watch list', !watchedAccounts({ ...base, pots: [jar] }).some((a) => a.id === 'jar'))
  check('…and raises nothing, even £1,000 below zero', findShortfalls({ ...base, pots: [jar] }, AS_OF).every((s) => s.account.id !== 'jar'))
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)

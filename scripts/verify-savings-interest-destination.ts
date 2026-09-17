// Verifies the 2026-09-14 "savings interest destination" feature/fix (see
// PROMPT-average-spend-forecast-current-cycle-2026-09-14.md's "Savings
// interest" item): a savings pot's generated interest now lands in
// EXACTLY ONE place — the same pot (self, the default), a different
// savings pot, a Pot, the Joint account, or the pot owner's Current
// account — never both the pot's own balance AND the owner's personal
// cash balance at once, which was the reported bug (real double-counted
// money, not just a duplicated row).

import { newSavingsPot, generateSavingsInterestTransactions, savingsPotBalanceAsOf } from '../src/lib/savingsPotLedger'
import { potSignedAmount } from '../src/lib/potLedger'
import { jointAccountSignedAmount } from '../src/lib/jointAccountLedger'
import { signedAmount } from '../src/lib/runningBalance'
import type { SavingsPot } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function assert(label: string, condition: boolean) {
  check(label, condition, true)
}

const basePot: SavingsPot = {
  ...newSavingsPot({ personId: 'me', name: 'Rainy day', openingBalance: 1000, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited', aer: 4.8, creditingFrequency: 'monthly' } }),
  id: 'pot-1',
}

// ── 1. Default (interestDestination unset) — credits the SAME pot (self) ──
{
  const rows = generateSavingsInterestTransactions(basePot, [], new Date('2026-01-01'), new Date('2026-02-15'))
  assert('at least one interest row generated', rows.length > 0)
  const r = rows[0]
  check('default destination: location is savings (not personal — would double-count)', r.location, 'savings')
  check('default destination: savingsPotId is the SAME pot', r.savingsPotId, 'pot-1')
  assert('default destination: no potId set', r.potId === undefined)
}

// ── 2. Destination: Current account (personal) ──
{
  const pot: SavingsPot = { ...basePot, interestDestination: { type: 'personal' } }
  const rows = generateSavingsInterestTransactions(pot, [], new Date('2026-01-01'), new Date('2026-02-15'))
  const r = rows[0]
  check('personal destination: location is personal', r.location, 'personal')
  check('personal destination: ownerId is the pot owner', r.ownerId, 'me')
  assert('personal destination: no savingsPotId set (does NOT also touch the pot\'s own balance)', r.savingsPotId === undefined)
  check('personal destination: counts as positive personal cash (generic direction-based sign)', signedAmount(r), r.amount)
}

// ── 3. Destination: Joint account ──
{
  const pot: SavingsPot = { ...basePot, interestDestination: { type: 'joint' } }
  const rows = generateSavingsInterestTransactions(pot, [], new Date('2026-01-01'), new Date('2026-02-15'))
  const r = rows[0]
  check('joint destination: location is joint', r.location, 'joint')
  assert('joint destination: no savingsPotId set', r.savingsPotId === undefined)
  check('joint destination: jointAccountSignedAmount is POSITIVE (incoming), not the -amount fallback', jointAccountSignedAmount(r), r.amount)
}

// ── 4. Destination: a Pot ──
{
  const pot: SavingsPot = { ...basePot, interestDestination: { type: 'pot', potId: 'pot-abc' } }
  const rows = generateSavingsInterestTransactions(pot, [], new Date('2026-01-01'), new Date('2026-02-15'))
  const r = rows[0]
  check('pot destination: location is pot', r.location, 'pot')
  check('pot destination: potId is the destination pot', r.potId, 'pot-abc')
  assert('pot destination: no savingsPotId set', r.savingsPotId === undefined)
  check('pot destination: potSignedAmount is POSITIVE (incoming), not the -amount fallback that any other unrecognised type gets', potSignedAmount(r, 'pot-abc'), r.amount)
}

// ── 5. Destination: a DIFFERENT savings pot — the generating pot's own balance excludes it, the destination pot's balance includes it ──
{
  const pot: SavingsPot = { ...basePot, interestDestination: { type: 'savings', savingsPotId: 'pot-2' } }
  const destinationPot: SavingsPot = { ...basePot, id: 'pot-2', name: 'Other pot' }
  const rows = generateSavingsInterestTransactions(pot, [], new Date('2026-01-01'), new Date('2026-02-15'))
  const r = rows[0]
  check('cross-pot destination: location is savings', r.location, 'savings')
  check('cross-pot destination: savingsPotId is the OTHER (destination) pot, not the generating one', r.savingsPotId, 'pot-2')

  const generatingPotBalance = savingsPotBalanceAsOf(pot, [{ ...r, id: 'generated-1' }], new Date('2026-02-15'))
  check('REGRESSION GUARD — the generating pot\'s own balance does NOT include interest it paid OUT elsewhere', generatingPotBalance, pot.openingBalance)

  const destinationPotBalance = savingsPotBalanceAsOf(destinationPot, [{ ...r, id: 'generated-1' }], new Date('2026-02-15'))
  assert('the destination pot\'s own balance DOES include interest paid into it', destinationPotBalance > destinationPot.openingBalance)
}

// ── 6. No double-count for the default (self) case — the SAME interest row must not ALSO look like it touches personal/joint/a-pot ──
{
  const rows = generateSavingsInterestTransactions(basePot, [], new Date('2026-01-01'), new Date('2026-02-15'))
  const r = rows[0]
  assert('REGRESSION GUARD — self-destined interest is not location: personal (the original bug)', r.location !== 'personal')
  assert('REGRESSION GUARD — self-destined interest is not location: joint', r.location !== 'joint')
  assert('REGRESSION GUARD — self-destined interest is not location: pot', r.location !== 'pot')
}

console.log(`\n${failures === 0 ? 'All savings-interest-destination checks passed.' : `${failures} check(s) FAILED.`}`)
if (failures > 0) process.exit(1)

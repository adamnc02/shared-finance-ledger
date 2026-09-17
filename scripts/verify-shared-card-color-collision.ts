// Regression test for the 2026-09-16 bugfix — Adam-reported: a brand-new
// credit card landed on the exact same colour as an existing, untouched
// Bills Pot. Root cause: pickNextSharedCardColor used to key off the
// current LIVE count of creditCards+pots+savingsPots combined, not a
// stable counter — deleting any one of them permanently decremented that
// count, so a later-created entity could be re-assigned an index a
// still-existing entity already held.
import { pickNextSharedCardColor } from '../src/lib/creditCards'
import { SHARED_CARD_COLORS } from '../src/types/ledger'
import type { AppDataV2, CreditCard, Pot, SavingsPot } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function assert(label: string, condition: boolean) {
  check(label, condition, true)
}

function pot(id: string, color: string): Pot {
  return { id, personId: 'me', name: id, openingBalance: 0, openingDate: '2026-01-01', active: true, color }
}
function savingsPot(id: string, color: string): SavingsPot {
  return { id, personId: 'me', name: id, openingBalance: 0, openingDate: '2026-01-01', active: true, color, interestMethod: { type: 'none' } }
}
function creditCard(id: string, color: string): CreditCard {
  return {
    id,
    name: id,
    categoryId: 'category-credit-card',
    color,
    interestRatePercent: 0,
    currentBalance: 0,
    balanceAsOfDate: '2026-01-01',
    minimumPayment: { type: 'fixed', amount: 25 },
    paymentDayOfMonth: 1,
    ownerId: 'me',
    lumpPayments: [],
    active: true,
  }
}

const empty: Pick<AppDataV2, 'creditCards' | 'pots' | 'savingsPots'> = { creditCards: [], pots: [], savingsPots: [] }

// ── 1. Adam's exact repro shape: Bills Pot created first (index 0), a credit card created
// second (index 1, since count was 1 at that point), Bills Pot is later DELETED — the count-based
// algorithm would then see count=1 again for the next new entity and reassign index 1, landing
// it on the SURVIVING card's colour, even though the deleted pot (not the card) was the one removed. ──
{
  const survivingCard = creditCard('cc1', SHARED_CARD_COLORS[1]) // created when count was 1 (Bills Pot existed)
  // Bills Pot has since been deleted — only the surviving card remains.
  const dataAfterDeletion: Pick<AppDataV2, 'creditCards' | 'pots' | 'savingsPots'> = { creditCards: [survivingCard], pots: [], savingsPots: [] }
  const nextColor = pickNextSharedCardColor(dataAfterDeletion)
  assert("the new pot's colour does NOT match the surviving card's — the exact reported collision shape", nextColor !== survivingCard.color)
  check('instead it gets the first genuinely unused palette colour (index 0, freed by the deletion)', nextColor, SHARED_CARD_COLORS[0])
}

// ── 2. No existing entities at all: first colour in the palette ──
{
  check('an empty ledger gets the first palette colour', pickNextSharedCardColor(empty), SHARED_CARD_COLORS[0])
}

// ── 3. Colours already in use, in any order/kind, are all skipped regardless of which of the three arrays holds them ──
{
  const data: Pick<AppDataV2, 'creditCards' | 'pots' | 'savingsPots'> = {
    creditCards: [creditCard('cc1', SHARED_CARD_COLORS[0])],
    pots: [pot('p1', SHARED_CARD_COLORS[2])],
    savingsPots: [savingsPot('sp1', SHARED_CARD_COLORS[1])],
  }
  check('the first colour not used by ANY of the three kinds is picked (0,1,2 taken -> 3)', pickNextSharedCardColor(data), SHARED_CARD_COLORS[3])
}

// ── 4. Every palette colour genuinely taken: falls back to round-robin-by-count (unavoidable collision, not a bug) ──
{
  const data: Pick<AppDataV2, 'creditCards' | 'pots' | 'savingsPots'> = {
    creditCards: SHARED_CARD_COLORS.map((c, i) => creditCard(`cc${i}`, c)),
    pots: [],
    savingsPots: [],
  }
  const result = pickNextSharedCardColor(data)
  assert('once every colour is taken, still returns SOME valid palette colour rather than throwing/undefined', SHARED_CARD_COLORS.includes(result as (typeof SHARED_CARD_COLORS)[number]))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll checks passed.')
}

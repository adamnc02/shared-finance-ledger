import { computeProjection } from '../src/lib/projection'
import { defaultLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2, PayCycleConfig, Transaction } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const base = defaultLedgerData()
const personId = base.primaryPersonId

const payCycle: PayCycleConfig = {
  personId,
  openingBalance: 0,
  openingBalanceDate: '2026-08-19',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}

// This script previously asserted the OPPOSITE of what it asserts now.
// An earlier revision exempted overpayments and credit card lump
// payments from the opening-balance floor outright, so that a
// retroactively-logged overpayment wouldn't "vanish". That exemption was
// unbounded, and produced a worse bug: a £40 overpayment dated
// 2025-02-22 against a balance reconciled at 2026-08-22 moved
// clearedBalance by £40 — cash counted as leaving the account eighteen
// months after it actually did, and already inside the reconciled
// opening figure. Reproduced against the real backup.
//
// The floor now applies to everything, uniformly. The original concern
// was real but belongs elsewhere: an overpayment still has to affect the
// LOAN, and it does, entirely independently of this file —
// buildLoanSchedule reads loan.overpayments directly and cardBalanceAsOf
// replays against the card's own anchor. Neither consults
// payCycle.openingBalanceDate. See
// scripts/verify-overpayment-independence.ts, which proves the same
// pre-floor overpayment still reduces loan capital by its full amount.
const overpaymentBeforeFloor: Transaction = {
  id: 't1',
  date: '2026-08-18',
  amount: 200,
  direction: 'out',
  categoryId: 'x',
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'loan_payment',
  location: 'personal',
  ownerId: personId,
  payee: '',
  payeeSharePercent: 100,
  sourceType: 'loan_overpayment',
  sourceId: 'op1',
}

const data: AppDataV2 = { ...base, payCycles: [payCycle], transactions: [overpaymentBeforeFloor] }
const projection = computeProjection(data, personId, payCycle, 'current_cycle', new Date('2026-08-19'))

check('An overpayment dated before openingBalanceDate is NOT in the projection\'s transaction list', projection.transactions.some((t) => t.id === 't1'), false)
check('...and does not move the cleared balance (already inside the opening figure)', projection.clearedBalance, 0)
check('...nor the projected balance', projection.projectedBalance, 0)

// The ordinary case, and the one that matters most: log a loan today,
// overpay it in a fortnight, and it must clear normally. This is the
// guard against over-correcting the fix into the original bug.
const overpaymentAfterFloor: Transaction = { ...overpaymentBeforeFloor, id: 't1b', date: '2026-08-21' }
const projectionAfter = computeProjection({ ...base, payCycles: [payCycle], transactions: [overpaymentAfterFloor] }, personId, payCycle, 'current_cycle', new Date('2026-08-21'))
check('An overpayment dated AFTER openingBalanceDate does appear', projectionAfter.transactions.some((t) => t.id === 't1b'), true)
check('...and is counted in the cleared balance (0 - 200 = -200)', projectionAfter.clearedBalance, -200)

// Boundary is inclusive — `t.date >= openingBalanceDate`.
const overpaymentOnFloor: Transaction = { ...overpaymentBeforeFloor, id: 't1c', date: '2026-08-19' }
const projectionOn = computeProjection({ ...base, payCycles: [payCycle], transactions: [overpaymentOnFloor] }, personId, payCycle, 'current_cycle', new Date('2026-08-19'))
check('An overpayment dated exactly ON openingBalanceDate is counted', projectionOn.clearedBalance, -200)

// A routine, ORDINARY historical transaction dated before the floor is
// hidden — unchanged behaviour, and now the SAME rule overpayments get
// rather than a special case they're exempt from.
const ordinaryPastExpense: Transaction = {
  id: 't2',
  date: '2026-08-18',
  amount: 50,
  direction: 'out',
  categoryId: 'x',
  paymentMethod: 'card',
  status: 'cleared',
  type: 'expense',
  location: 'personal',
  ownerId: personId,
  payee: '',
  payeeSharePercent: 100,
}
const dataWithOrdinary: AppDataV2 = { ...base, payCycles: [payCycle], transactions: [ordinaryPastExpense] }
const projectionOrdinary = computeProjection(dataWithOrdinary, personId, payCycle, 'current_cycle', new Date('2026-08-19'))
check('An ORDINARY transaction dated before the floor is hidden, as designed', projectionOrdinary.transactions.length, 0)
check('...and does not affect the balance either', projectionOrdinary.clearedBalance, 0)

// A credit card lump payment follows the same rule — symmetric with loan
// overpayments, since a card's balance is likewise anchored on its own
// balanceAsOfDate and never on the pay cycle's opening balance date.
const cardLumpPayment: Transaction = { ...overpaymentBeforeFloor, id: 't3', type: 'credit_card_payment', sourceType: 'credit_card_lump_payment', sourceId: 'lp1' }
const dataWithLump: AppDataV2 = { ...base, payCycles: [payCycle], transactions: [cardLumpPayment] }
const projectionLump = computeProjection(dataWithLump, personId, payCycle, 'current_cycle', new Date('2026-08-19'))
check('A pre-floor credit card lump payment is hidden, same as a loan overpayment', projectionLump.transactions.some((t) => t.id === 't3'), false)
check('...and does not move the cleared balance', projectionLump.clearedBalance, 0)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll overpayment-visibility-floor checks passed.')

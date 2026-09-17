// D2 verification — Loan type additions (amortisation-engine scope §2,
// handoff §2) and the migrateLedgerData backfill that keeps a loan
// persisted before `active` existed usable once it becomes a real field.

import { migrateLedgerData, defaultLedgerData } from '../src/lib/ledgerStorage'
import { defaultCategories } from '../src/lib/categories'
import type { AppDataV2, Loan } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

// ---- 1. A loan persisted before `active` existed backfills to true ----
// Deliberately built as a raw object (not typed `Loan`) with `active`
// omitted entirely, to simulate real pre-existing localStorage JSON — the
// exact shape migrateLedgerData has to defend against.
const preExistingLoan = {
  id: 'legacy-loan',
  name: 'Kitchen finance',
  monthlyPayment: 150,
  termMonths: 18,
  startDate: '2025-09-01',
  categoryId: 'cat-loans',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  // no `active` field at all — this is the pre-migration shape
}

const rawData = {
  primaryPersonId: 'me',
  people: [{ id: 'me', name: 'Me', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] }],
  categories: defaultCategories(),
  recurringTemplates: [],
  loans: [preExistingLoan],
  creditCards: [],
  transactions: [],
  payCycles: [],
  pensions: [],
  scenarios: [],
} as unknown as AppDataV2

const migrated = migrateLedgerData(rawData)
check('Pre-existing loan with no `active` field backfills to active: true', migrated.loans[0].active, true)
check('Pre-existing loan with no `principal` field backfills to monthlyPayment × termMonths (0%-equivalent, information-preserving default)', migrated.loans[0].principal, 2700)
check('Backfill does not touch any of the loan\'s other real fields', migrated.loans[0].name, 'Kitchen finance')
check('Backfill leaves the new optional amortisation fields genuinely absent, not defaulted to something', migrated.loans[0].lender, undefined)
check('Backfill leaves calibratedMonthlyRate absent (baseline, scope §5.2, is computed at read time — not stored until calibrated)', migrated.loans[0].calibratedMonthlyRate, undefined)

// ---- 2. A loan that's already explicitly inactive is left alone, not reset to true ----
const alreadyClosedLoan = { ...preExistingLoan, id: 'closed-loan', active: false }
const rawDataWithClosedLoan: AppDataV2 = { ...rawData, loans: [alreadyClosedLoan as unknown as Loan] }
const migratedWithClosedLoan = migrateLedgerData(rawDataWithClosedLoan)
check('An explicitly inactive loan (active: false) is NOT overwritten by the backfill', migratedWithClosedLoan.loans[0].active, false)

// ---- 3. A loan that already carries calibration data round-trips untouched ----
const calibratedLoan: Loan = {
  ...(preExistingLoan as unknown as Loan),
  id: 'calibrated-loan',
  active: true,
  principal: 8400,
  lender: 'Santander',
  advanceDate: '2026-05-11',
  interestConventionId: 'flat_monthly',
  calibratedMonthlyRate: 0.01312604,
  settlementMultiplier: 3,
  statementCalibrationLines: [
    { date: '2026-07-02', capital: 300.03, interest: 110.26 },
    { date: '2026-08-02', capital: 303.97, interest: 106.32 },
  ],
}
const rawDataWithCalibratedLoan: AppDataV2 = { ...rawData, loans: [calibratedLoan] }
const migratedCalibrated = migrateLedgerData(rawDataWithCalibratedLoan)
check('A fully-calibrated loan round-trips through migration with all fields intact', migratedCalibrated.loans[0], calibratedLoan)

// ---- 4. A brand-new loan from defaultLedgerData() has no loans at all (nothing to backfill) ----
const fresh = defaultLedgerData()
check('defaultLedgerData starts with an empty loans array', fresh.loans, [])

console.log(failures === 0 ? '\nAll loan-migration checks passed.' : `\n${failures} loan-migration check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)

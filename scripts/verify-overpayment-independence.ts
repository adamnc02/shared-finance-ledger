// Proves the loan capital + card balance figures do NOT depend on
// projection.ts's opening-balance floor, so removing the floor exemption
// cannot alter them.
import { readFileSync } from 'node:fs'
import { summarizeLoanProgress } from '../src/lib/ledgerLoans'
import { cardBalanceAsOf } from '../src/lib/creditCards'
import type { AppDataV2, Loan } from '../src/types/ledger'

// Reads a real backup so the fixtures are authoritative app state rather
// than a hand-built approximation. Defaults to mum's real 15 Sep 2026 export
// (the original scripts/fixtures/backup-2026-08-24.json was never committed,
// so this crashed on every machine from 2026-09-05 until 2026-09-17). Point
// LEDGER_BACKUP at a fresher export to re-run these checks against current data.
const BACKUP = process.env.LEDGER_BACKUP ?? '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/finance-ledger-backup-2026-09-15-mum.json'
const data = JSON.parse(readFileSync(BACKUP, 'utf8')) as AppDataV2
const today = new Date(2026, 8, 15) // the backup's export date, see verify-cycle-end-totals.ts
const hi = data.loans.find(l => l.name === 'Home Improvements')!

// Against the loan with NO overpayments: mum's real data already holds this £40 (22 Feb 2025).
const before = summarizeLoanProgress({ ...hi, overpayments: [] }, today)
const withOp: Loan = { ...hi, overpayments: [{ id:'op1', date:'2025-02-22', amount:40, recastMode:'reduce_term' }] }
const after = summarizeLoanProgress(withOp, today)

console.log('Home Improvements capitalRemaining without overpayment:', before.capitalRemaining)
console.log('Home Improvements capitalRemaining WITH  overpayment  :', after.capitalRemaining)
console.log('=> loan capital reacts to loan.overpayments directly  :', before.capitalRemaining !== after.capitalRemaining)
if (before.capitalRemaining === after.capitalRemaining) { console.log('✗ loan capital did not react to loan.overpayments'); process.exitCode = 1 }
else console.log('✓ loan capital reacts to loan.overpayments directly')

const card = data.creditCards.find(c => c.name === 'Santander')!
console.log('\nSantander balance (anchored on card.balanceAsOfDate)  :', cardBalanceAsOf(card, data.transactions, today))
const shifted = { ...data, payCycles: data.payCycles.map((p) => ({ ...p, openingBalanceDate: '2020-01-01' })) }
const sameCard = shifted.creditCards.find(c => c.name === 'Santander')!
if (cardBalanceAsOf(sameCard, shifted.transactions, today) !== cardBalanceAsOf(card, data.transactions, today)) { console.log('✗ card balance moved when payCycle.openingBalanceDate changed'); process.exitCode = 1 }
else console.log('✓ card balance never consults payCycle.openingBalanceDate')

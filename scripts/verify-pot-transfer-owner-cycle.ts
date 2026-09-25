// 2026-09-25 — a Pot's payday-following transfer follows its OWNER's payday (APP-KNOWLEDGE §1.31c).
//
// 🚨 THE REAL BUG THIS PREVENTS. On 24 and 25 September 2026 the live app sent Adam, at 20:00:
//
//     "Bills: not enough money
//      2 payments totalling £232.00 on 1 October leave you £225.00 short.
//      Next scheduled money in on 8 October."
//
// His Bills pot was never short. A recurring transfer, current account → Bills, `followsPayday`,
// owner Adam, lands on HIS payday — 30 September, the day before those two payments. But
// `computePotProjectionToDate` handed every template the PRIMARY person's pay cycle, and on the
// server the primary can be Ella. Measured against her four-weekly cycle the deposit was generated
// on 8 October — her payday. Not missing, which would have been obvious: MOVED, a week past the
// payments it exists to cover. "8 October" in the alert is that moved deposit.
//
// It is the exact defect §1.31c fixed for the joint account and auto-clear on 2026-09-23, left
// behind in the pot generators. So the resolution now lives INSIDE `generatePotDepositTransactions`
// / `generatePotWithdrawalTransferTransactions`, per template, and they take every person's cycle
// rather than one — no caller can hand in the wrong person's cycle again.
//
// Synthetic household, same shape as the real one (the repo is public; no real data here).
// Every section is run with BOTH people as primary: the answer must not depend on whose phone it is.

import { parseLedgerBackupJson } from '../src/lib/ledgerStorage'
import { findShortfalls, shortfallMessage } from '../src/lib/shortfall'
import { computePotProjection, buildPotScheduleRows, generatePotDepositTransactions, generatePotWithdrawalTransferTransactions } from '../src/lib/potLedger'
import { generateTransactionsForTemplate } from '../src/lib/schedule'
import type { AppDataV2 } from '../src/types/ledger'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', JSON.stringify(detail).slice(0, 400))
  }
}

const OWNER = 'person-owner'
const OTHER = 'person-other'
const POT = 'pot-bills'
const DEPOSIT = 'tpl-deposit'
const SWEEP = 'tpl-sweep'

// Owner: payday the 31st, adjusted for weekends → 30 September 2026 (a Wednesday).
// Other: four-weekly, next pay 8 October — the date the deposit wrongly moved to.
function household(primaryPersonId: string): AppDataV2 {
  return parseLedgerBackupJson(
    JSON.stringify({
      people: [
        { id: OWNER, name: 'Owner' },
        { id: OTHER, name: 'Other' },
      ],
      categories: [],
      recurringTemplates: [
        { id: 'tpl-a', name: 'Payment A', amount: 40, categoryId: 'c', paymentMethod: 'standing_order', frequency: 'monthly', anchorDate: '2026-10-01', location: 'pot', ownerId: OWNER, payee: '', payeeSharePercent: 100, potId: POT, active: true },
        { id: 'tpl-b', name: 'Payment B', amount: 200, categoryId: 'c', paymentMethod: 'standing_order', frequency: 'monthly', anchorDate: '2026-10-01', location: 'pot', ownerId: OWNER, payee: '', payeeSharePercent: 100, potId: POT, active: true },
        { id: DEPOSIT, name: 'Bills Deposit', amount: 250, categoryId: 'category-savings', paymentMethod: 'bank_transfer', frequency: 'monthly', anchorDate: '2026-09-20', location: 'personal', ownerId: OWNER, payee: '', payeeSharePercent: 100, active: true, kind: 'transfer', transferFrom: { type: 'personal' }, transferTo: { type: 'pot', potId: POT }, followsPayday: true, followsCycleStart: false },
        // The withdrawal side has the same shape and the same defect.
        { id: SWEEP, name: 'Bills Sweep', amount: 5, categoryId: 'category-savings', paymentMethod: 'bank_transfer', frequency: 'monthly', anchorDate: '2026-09-20', location: 'personal', ownerId: OWNER, payee: '', payeeSharePercent: 100, active: true, kind: 'transfer', transferFrom: { type: 'pot', potId: POT }, transferTo: { type: 'personal' }, followsPayday: true, followsCycleStart: false },
      ],
      loans: [],
      creditCards: [],
      pensions: [],
      savingsPots: [],
      pots: [{ id: POT, personId: OWNER, name: 'Bills', openingBalance: 10, openingDate: '2026-09-20', active: true, color: '#8b5cf6', overdraftAmount: 0 }],
      transactions: [],
      payCycles: [
        { personId: OWNER, openingBalance: 1000, openingBalanceDate: '2026-09-20', paydayDayOfMonth: 31, paydayAdjustForNonWorkingDay: true, cycleStartDayOfMonth: 1, cycleStartFollowsPayday: true, overdraftAmount: 0 },
        { personId: OTHER, openingBalance: 1000, openingBalanceDate: '2026-09-20', paydayDayOfMonth: 28, paydayAdjustForNonWorkingDay: true, cycleStartDayOfMonth: 1, cycleStartFollowsPayday: true, overdraftAmount: 0, paySchedule: { kind: 'four_weekly_fiscal', anchorPayDate: '2026-10-08' } },
      ],
      salarySorts: [],
      scenarios: [],
      primaryPersonId,
    }),
  )
}

const AS_OF = new Date(2026, 8, 24, 20) // the first alert: 24 September, 20:00
const RANGE = [new Date(2026, 8, 20), new Date(2026, 9, 20)] as const
const OWNER_PAYDAY = '2026-09-30'
const OTHER_PAYDAY = '2026-10-08'

// ───────────────────────────────────────────────────────────────────────────
console.log('\n0. CONTROL — the fixture reproduces the bug when the primary\'s cycle is used')
{
  const data = household(OTHER)
  const deposit = data.recurringTemplates.find((t) => t.id === DEPOSIT)!
  const otherCycle = data.payCycles.find((c) => c.personId === OTHER)
  const ownerCycle = data.payCycles.find((c) => c.personId === OWNER)
  const oldWay = generateTransactionsForTemplate(deposit, RANGE[0], RANGE[1], otherCycle).map((t) => t.date)
  const rightWay = generateTransactionsForTemplate(deposit, RANGE[0], RANGE[1], ownerCycle).map((t) => t.date)
  check(`the OTHER person's cycle puts the deposit on ${OTHER_PAYDAY} (the old defect)`, oldWay.includes(OTHER_PAYDAY) && !oldWay.includes(OWNER_PAYDAY), oldWay)
  check(`the OWNER's cycle puts it on ${OWNER_PAYDAY}`, rightWay.includes(OWNER_PAYDAY) && !rightWay.includes(OTHER_PAYDAY), rightWay)
}

for (const [who, primary] of [['owner', OWNER], ['other person', OTHER]] as const) {
  const data = household(primary)
  const pot = data.pots!.find((p) => p.id === POT)!

  console.log(`\n1. Generators, primary = ${who}`)
  const deps = generatePotDepositTransactions(pot, RANGE[0], RANGE[1], data.recurringTemplates, data.payCycles).map((t) => t.date)
  check(`deposit generated on the owner's payday, ${OWNER_PAYDAY}`, deps.includes(OWNER_PAYDAY) && !deps.includes(OTHER_PAYDAY), deps)
  const outs = generatePotWithdrawalTransferTransactions(pot, RANGE[0], RANGE[1], data.recurringTemplates, data.payCycles).map((t) => t.date)
  check(`withdrawal generated on the owner's payday, ${OWNER_PAYDAY}`, outs.includes(OWNER_PAYDAY) && !outs.includes(OTHER_PAYDAY), outs)

  console.log(`\n2. The pot's projection and its ledger rows, primary = ${who}`)
  const proj = computePotProjection(data, pot, 'three_cycles', AS_OF).transactions.filter((t) => t.sourceId === DEPOSIT || (t as { recurringTemplateId?: string }).recurringTemplateId === DEPOSIT || t.note === 'Bills Deposit')
  check(`computePotProjection has the deposit on ${OWNER_PAYDAY}`, proj.some((t) => t.date === OWNER_PAYDAY) && !proj.some((t) => t.date === OTHER_PAYDAY), proj.map((t) => t.date))
  const rows = buildPotScheduleRows(data, pot, AS_OF).filter((r) => r.type === 'pot_deposit').map((r) => r.date)
  check(`buildPotScheduleRows shows the deposit on ${OWNER_PAYDAY}`, rows.includes(OWNER_PAYDAY) && !rows.includes(OTHER_PAYDAY), rows)

  console.log(`\n3. The alert, primary = ${who} — the real notification must not fire`)
  // Opening £10, +£250 on 30 Sep, −£5 sweep on 30 Sep, −£240 on 1 Oct → £15. Never below zero.
  const potAlerts = findShortfalls(data, AS_OF).filter((s) => s.account.kind === 'pot')
  check('no shortfall on the Bills pot', potAlerts.length === 0, potAlerts.map((s) => shortfallMessage(s)))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

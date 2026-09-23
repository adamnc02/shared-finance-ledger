// PROMPT-12 Part 4 (2026-09-23) — the synthetic fixture: every shape no real backup has ever
// carried, built on Adam's real 2026-09-15 backup. One fixture, shared by verify-mapping-nulls.ts
// (the mapping and server round trip) and verify-import-regenerates-ids.ts (an import into two
// households). Counted across every real backup on 2026-09-20 (PROMPT-12's table): NO real file
// has a pension occurrence override, a savings-pot interest override, a savings-pot
// recurring-deposit override, or a salary sort — and, until PROMPT-13 shipped, none had the
// round-up columns either. Every generic check over those tables passes vacuously without this.
//
// Keep it in ONE place. It was two fixtures for a day (PROMPT-13's round-up one and this); one
// file that covers every under-exercised shape is easier to keep honest than two that each
// cover half. Each consumer asserts the counts it relies on (§53, §63).

import { readFileSync } from 'node:fs'
import { parseLedgerBackupJson } from '../../src/lib/ledgerStorage'
import { salarySortId, salarySortTargetId, salarySortTransactionId } from '../../src/lib/salarySortLedger'
import type { AppDataV2 } from '../../src/types/ledger'

export const SYNTHETIC_BASE = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json'
export const JAR_ID = 'jar00001'

export function buildSyntheticFixture(): { data: AppDataV2; personId: string } {
  const jarId = JAR_ID
  const roundUpFixture: AppDataV2 = {
    ...(parseLedgerBackupJson(readFileSync(SYNTHETIC_BASE, 'utf8')) as AppDataV2),
  }
  const rupPerson = roundUpFixture.people[0].id
  roundUpFixture.pots = [
    {
      id: jarId, personId: rupPerson, name: 'Coin Jar', openingBalance: -5.25, openingDate: '2026-09-01',
      active: true, color: '#f5a524', isCoinJar: true, overdraftAmount: 0,
    },
    // A control: an ordinary pot alongside it, so `is_coin_jar` is proven to
    // discriminate rather than simply always come back true.
    { id: 'pot00001', personId: rupPerson, name: 'Bills Pot', openingBalance: 100, openingDate: '2026-09-01', active: true, color: '#4cd08a', overdraftAmount: 0 },
  ]
  roundUpFixture.payCycles = roundUpFixture.payCycles.map((pc, i) =>
    i === 0
      ? {
          ...pc,
          roundUpEnabled: true,
          roundUpEffectiveFrom: '2026-09-01',
          roundUpHistory: [
            { enabled: true, from: '2026-03-01', until: '2026-06-01', nextRuleFrom: '2026-06-01' },
            { enabled: false, from: '2026-06-01', until: '2026-09-01', nextRuleFrom: '2026-09-01' },
          ],
        }
      : pc,
  )
  // A pension with an occurrence override — a real backup has never carried one
  // (Adam's has no pension; mum's has none with an override).
  roundUpFixture.pensions = [
    {
      id: 'pen00001', personId: rupPerson, name: 'Private Pension', amount: 412.5, frequency: 'monthly', anchorDate: '2026-01-15',
      active: true, adjustForNonWorkingDay: true, cycleStartFollowsPayday: false,
      amountEffectiveFrom: '2026-07-15', amountHistory: [{ effectiveFrom: '2026-01-15', amount: 400 }],
      occurrenceOverrides: [
        { originalDate: '2026-08-15', date: '2026-08-14', amount: 420 }, // moved AND re-amounted
        { originalDate: '2026-10-15', deleted: true }, // skipped outright
      ],
    },
  ]
  // A savings pot with BOTH override lists. `recurringDepositOverrides` on a
  // SavingsPot is the legacy read path (savingsPotLedger.ts's fallback for a
  // pre-2026-09-04 backup), so it is exactly the shape that only an OLD file
  // would carry — which is why no recent real backup does, and why it must be
  // proven here rather than assumed to still map.
  roundUpFixture.savingsPots = [
    ...roundUpFixture.savingsPots,
    {
      id: 'sav00001', personId: rupPerson, name: 'Rainy Day', openingBalance: 1500, openingDate: '2026-01-01', active: true, color: '#7c5cff',
      interestMethod: { type: 'aer_credited', aer: 4.1, creditingFrequency: 'monthly' },
      interestEffectiveFrom: '2026-06-01',
      interestHistory: [{ effectiveFrom: '2026-01-01', method: { type: 'aer_credited', aer: 3.5, creditingFrequency: 'monthly' } }],
      interestOverrides: [{ date: '2026-07-31', amount: 5.12 }, { date: '2026-08-31', amount: 0 }],
      recurringDepositOverrides: [{ originalDate: '2026-08-01', deleted: true }, { originalDate: '2026-09-01', amount: 75 }],
    },
  ]
  // A salary sort with two targets. The server keeps NO person column on
  // `salary_sorts` (PROMPT-11): the person is derived from the owner of the
  // sort's transfers, so the fixture has to carry those transfers too, owned
  // by the sorting person, or the derivation has nothing to read.
  // Ids as the app writes them since PROMPT-11: derived from the person, the payday and the
  // destination, so two devices sorting the same payday converge on one record.
  const sortId = salarySortId(rupPerson, '2026-09-25')
  const toSavings = { type: 'savings' as const, savingsPotId: 'sav00001' }
  const toPot = { type: 'pot' as const, potId: 'pot00001' }
  const savingsTarget = salarySortTargetId(sortId, toSavings)
  const potTarget = salarySortTargetId(sortId, toPot)
  roundUpFixture.salarySorts = [
    {
      id: sortId, payDate: '2026-09-25', personId: rupPerson,
      targets: [
        { id: savingsTarget, to: toSavings, amount: 250, transactionId: salarySortTransactionId(savingsTarget) },
        { id: potTarget, to: toPot, amount: 120, transactionId: salarySortTransactionId(potTarget) },
      ],
    },
  ]
  const sortTransfer = (id: string, to: { type: 'savings'; savingsPotId: string } | { type: 'pot'; potId: string }, amount: number) => ({
    ...roundUpFixture.transactions[0], id, type: 'transfer' as const, paymentMethod: 'bank_transfer' as const, location: 'personal' as const,
    direction: 'out' as const, amount, ownerId: rupPerson, payee: '', date: '2026-09-25', categoryId: 'category-savings',
    fromLocation: { type: 'personal' as const }, toLocation: to, sourceType: 'salary_sort' as const, sourceId: sortId, note: 'Salary sort',
    potId: to.type === 'pot' ? to.potId : undefined, savingsPotId: to.type === 'savings' ? to.savingsPotId : undefined,
  })
  roundUpFixture.transactions = [
    // A rounded expense, and a control that was not rounded.
    { ...roundUpFixture.transactions[0], id: 'rup00001', type: 'expense', paymentMethod: 'card', location: 'personal', amount: 8, roundedFrom: 7.5, roundingPotId: jarId },
    { ...roundUpFixture.transactions[0], id: 'rup00002', type: 'expense', paymentMethod: 'cash', location: 'personal', amount: 7.5 },
    // PROMPT-13 B1a — a row that deliberately opted out. Indistinguishable
    // from rup00002 on the server WITHOUT this column, which is the point.
    { ...roundUpFixture.transactions[0], id: 'rup00003', type: 'expense', paymentMethod: 'card', location: 'personal', amount: 7.5, roundUpSkipped: true },
    sortTransfer(salarySortTransactionId(savingsTarget), toSavings, 250),
    sortTransfer(salarySortTransactionId(potTarget), toPot, 120),
  ]
  // A moved occurrence that was auto-cleared BEFORE the move (mum's real 2026-09-20 backup has two):
  // the id names the slot (the 20th), the row is dated the 21st. An import must keep the slot.
  const movedTemplate = roundUpFixture.recurringTemplates[0]
  roundUpFixture.transactions.push({
    ...roundUpFixture.transactions[0], id: `auto:recurring_template:${movedTemplate.id}:2026-09-20`, date: '2026-09-21', status: 'cleared',
    type: 'bill_payment', sourceType: 'recurring_template', sourceId: movedTemplate.id, occurrenceOriginalDate: '2026-09-20', ownerId: rupPerson, payee: '',
  })
  // Strip the undefined keys the helper leaves behind, so deep-equal compares shapes, not `undefined`s.
  roundUpFixture.transactions = roundUpFixture.transactions.map((t) => JSON.parse(JSON.stringify(t)))
  
  
  return { data: roundUpFixture, personId: rupPerson }
}

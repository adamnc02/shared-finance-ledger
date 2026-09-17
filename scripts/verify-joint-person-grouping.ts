// Verifies Joint's new "Group by Person" (2026-09-13, Adam-specified):
// each person's SHARE of joint bills/loans/transfers, plus an
// unattributed "Spend" bucket for everything else. Adam's own worked
// rules, verbatim:
//  - "each person and their share of the bills and transfers"
//  - "a third row for spend only, which is not person specific, only
//    bills and transfers are grouped by person"
//  - "Withdrawals and deposits into joint should always have an owner,
//    they're both transfers, so they leave someone's account. Transfers
//    are always 100% assigned to the owner, no split."

import { buildJointPersonGroups, resolveNonJointTransferOwner, personShareOfJointAmount } from '../src/lib/jointLedger'
import type { AppDataV2, Transaction } from '../src/types/ledger'

let passed = 0
let failed = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}
function assert(label: string, condition: boolean) {
  check(label, condition, true)
}

function dataWith(overrides: Partial<AppDataV2>): AppDataV2 {
  return {
    primaryPersonId: 'adam',
    people: [
      { id: 'adam', name: 'Adam', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [] },
      { id: 'ella', name: 'Ella', color: '#4cd08a', salaryHistory: [], salaryOverrides: [] },
    ],
    categories: [],
    recurringTemplates: [],
    loans: [],
    creditCards: [],
    transactions: [],
    payCycles: [],
    pensions: [],
    savingsPots: [],
    pots: [],
    scenarios: [],
    ...overrides,
  } as unknown as AppDataV2
}

function billTxn(id: string, amount: number, payee: string, payeeSharePercent: number): Transaction {
  return {
    id,
    date: '2026-09-15',
    amount,
    direction: 'out',
    categoryId: 'cat-bills',
    paymentMethod: 'direct_debit',
    status: 'cleared',
    type: 'bill_payment',
    location: 'joint',
    ownerId: 'adam',
    payee,
    payeeSharePercent,
  } as Transaction
}

function transferTxn(id: string, amount: number, from: Transaction['fromLocation'], to: Transaction['toLocation']): Transaction {
  return {
    id,
    date: '2026-09-15',
    amount,
    direction: from?.type === 'joint' ? 'in' : 'out',
    categoryId: 'cat-transfer',
    paymentMethod: 'bank_transfer',
    status: 'cleared',
    type: 'transfer',
    location: 'joint',
    ownerId: 'adam',
    fromLocation: from,
    toLocation: to,
  } as Transaction
}

function spendTxn(id: string, amount: number, type: 'expense' | 'income' = 'expense'): Transaction {
  return {
    id,
    date: '2026-09-15',
    amount,
    direction: type === 'expense' ? 'out' : 'in',
    categoryId: 'cat-spend',
    paymentMethod: 'card',
    status: 'cleared',
    type,
    location: 'joint',
    ownerId: 'adam',
  } as Transaction
}

// ── 1. personShareOfJointAmount — the split math itself ──
check("50/50 split — payee's own share", personShareOfJointAmount(100, 'adam', 50, 'adam'), 50)
check("50/50 split — the OTHER person's share", personShareOfJointAmount(100, 'adam', 50, 'ella'), 50)
check('100/0 split — payee gets it all', personShareOfJointAmount(100, 'adam', 100, 'adam'), 100)
check("100/0 split — the other person's share is 0", personShareOfJointAmount(100, 'adam', 100, 'ella'), 0)

// ── 2. resolveNonJointTransferOwner ──
{
  const data = dataWith({ pots: [{ id: 'pot-ella', personId: 'ella', name: "Ella's pot" }] as never })
  check("'personal' (Current Account) always resolves to the primary person — no per-person Current Account concept", resolveNonJointTransferOwner(data, { type: 'personal' }, 'adam'), 'adam')
  check("a Pot resolves to WHOEVER owns that pot, not the primary person", resolveNonJointTransferOwner(data, { type: 'pot', potId: 'pot-ella' }, 'adam'), 'ella')
}
{
  const data = dataWith({ savingsPots: [{ id: 'sp-adam', personId: 'adam', name: "Adam's savings" }] as never })
  check('a Savings Pot resolves to whoever owns it', resolveNonJointTransferOwner(data, { type: 'savings', savingsPotId: 'sp-adam' }, 'adam'), 'adam')
}

// ── 3. buildJointPersonGroups — bills/loans split by payee share, both people can get a nonzero copy ──
{
  const data = dataWith({})
  const bill = billTxn('b1', 100, 'adam', 60) // Adam 60%, Ella 40%
  const groups = buildJointPersonGroups(data, [bill])
  const adamGroup = groups.find((g) => g.id === 'adam')!
  const ellaGroup = groups.find((g) => g.id === 'ella')!
  const spendGroup = groups.find((g) => g.id === 'spend')!
  check('Adam (the payee) gets his 60% share as the transaction amount', adamGroup.transactions[0]?.amount, 60)
  check("Ella gets her 40% share as the transaction amount — the SAME underlying bill appears in BOTH people's lists", ellaGroup.transactions[0]?.amount, 40)
  check('a bill/loan never lands in Spend', spendGroup.transactions.length, 0)
}

// ── 4. A 100/0 bill only appears in the payee's own list, not the other person's (0% share omitted, not shown as £0) ──
{
  const data = dataWith({})
  const bill = billTxn('b2', 50, 'ella', 100) // Ella 100%, Adam 0%
  const groups = buildJointPersonGroups(data, [bill])
  check("the non-payee's 0% share is OMITTED entirely, not included as a £0 row", groups.find((g) => g.id === 'adam')!.transactions.length, 0)
  check("the payee's 100% share is the full amount", groups.find((g) => g.id === 'ella')!.transactions[0]?.amount, 50)
}

// ── 5. A transfer touching joint is 100% assigned to ONE owner, never split by payeeSharePercent ──
{
  const data = dataWith({})
  // Money moving FROM personal (the primary person's Current Account) INTO joint — a "deposit."
  const deposit = transferTxn('t1', 200, { type: 'personal' }, { type: 'joint' })
  const groups = buildJointPersonGroups(data, [deposit])
  check('a personal->joint transfer is 100% Adam\'s (Current Account is always the primary person\'s)', groups.find((g) => g.id === 'adam')!.transactions[0]?.amount, 200)
  check("the transfer does NOT also appear (split) in Ella's list", groups.find((g) => g.id === 'ella')!.transactions.length, 0)
  check('a transfer never lands in Spend either', groups.find((g) => g.id === 'spend')!.transactions.length, 0)
}

// ── 6. A withdrawal FROM joint into a Pot belonging to Ella is 100% Ella's ──
{
  const data = dataWith({ pots: [{ id: 'pot-ella', personId: 'ella', name: "Ella's pot" }] as never })
  const withdrawal = transferTxn('t2', 75, { type: 'joint' }, { type: 'pot', potId: 'pot-ella' })
  const groups = buildJointPersonGroups(data, [withdrawal])
  check("a joint->Ella's-pot withdrawal is 100% Ella's, not Adam's (the primary person)", groups.find((g) => g.id === 'ella')!.transactions[0]?.amount, 75)
  check("Adam's list is untouched by it", groups.find((g) => g.id === 'adam')!.transactions.length, 0)
}

// ── 7. Ad-hoc joint expense/income (no payee) goes to Spend, unattributed regardless of who logged it ──
{
  const data = dataWith({})
  const expense = spendTxn('s1', 40, 'expense')
  const income = spendTxn('s2', 15, 'income')
  const groups = buildJointPersonGroups(data, [expense, income])
  check('ad-hoc joint spend/income lands in Spend, unmodified', groups.find((g) => g.id === 'spend')!.transactions.map((t) => t.id).sort(), ['s1', 's2'])
  check("Spend is NOT attributed to either person, even though ownerId is set on the underlying row", groups.find((g) => g.id === 'adam')!.transactions.length, 0)
}

// ── 8. Everything together — a realistic mixed cycle reconciles into the right 3 buckets ──
{
  const data = dataWith({ pots: [{ id: 'pot-ella', personId: 'ella', name: "Ella's pot" }] as never })
  const items = [
    billTxn('b1', 100, 'adam', 50), // 50/50
    transferTxn('t1', 200, { type: 'personal' }, { type: 'joint' }), // Adam's deposit
    transferTxn('t2', 30, { type: 'joint' }, { type: 'pot', potId: 'pot-ella' }), // Ella's withdrawal
    spendTxn('s1', 25, 'expense'),
  ]
  const groups = buildJointPersonGroups(data, items)
  check('Adam: his 50% of the bill + his full deposit', groups.find((g) => g.id === 'adam')!.transactions.map((t) => t.id).sort(), ['b1', 't1'])
  check('Ella: her 50% of the bill + her full withdrawal', groups.find((g) => g.id === 'ella')!.transactions.map((t) => t.id).sort(), ['b1', 't2'])
  check('Spend: just the ad-hoc expense', groups.find((g) => g.id === 'spend')!.transactions.map((t) => t.id), ['s1'])
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

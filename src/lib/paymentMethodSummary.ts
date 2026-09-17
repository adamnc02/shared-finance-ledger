// "A summary view that can split totals by [payment method], the same
// way the app already splits by category" (doc Section 3.1). Mirrors the
// category-grouping pattern the Bills page already uses, just keyed by
// PaymentMethod instead.

import type { PaymentMethod, Transaction } from '../types/ledger'

export interface PaymentMethodTotal {
  paymentMethod: PaymentMethod
  count: number
  total: number // signed sum (direction-aware) — positive if that method's transactions net incoming, negative if net outgoing
}

const ALL_PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'direct_debit', 'standing_order']

export function summarizeByPaymentMethod(transactions: Transaction[]): PaymentMethodTotal[] {
  const totals = new Map<PaymentMethod, { count: number; total: number }>()
  for (const method of ALL_PAYMENT_METHODS) totals.set(method, { count: 0, total: 0 })

  for (const t of transactions) {
    const entry = totals.get(t.paymentMethod)
    if (!entry) continue // defensive — every PaymentMethod is pre-seeded above, so this shouldn't happen
    entry.count += 1
    entry.total += t.direction === 'in' ? t.amount : -t.amount
  }

  return ALL_PAYMENT_METHODS.map((paymentMethod) => ({ paymentMethod, ...totals.get(paymentMethod)! })).filter(
    (row) => row.count > 0,
  )
}

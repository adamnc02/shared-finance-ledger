// Person-to-person transfers in a joint household: from one person's current
// account to the other's, one-off or recurring.
//
// ONE ROW, not a mirrored pair. The row is owned by the sender (`ownerId`); its
// FROM end is `{ type: 'personal' }` (the owner's own current account, as for
// every transfer) and its TO end is `{ type: 'personal', personId }` (the other
// person's). The sender's projection already books it as money out — it is an
// ordinary 'personal'-located transfer with direction 'out'. The recipient's
// projection books the SAME row (stored or generated) as money in, through
// the helpers below. A pair of rows could drift: a delete on one device, an
// auto-clear of one side, an edit to one amount. One row cannot.
//
// 🚨 Anything that decides "this row is on person X's current account" by
// `location === 'personal' && ownerId === X` sees only the SENDER. The
// recipient side must be added explicitly (projection.ts), and a page filter
// must show the row to both people (the Transfers page does, at its list).
import type { RecurringTemplate, Transaction, TransferLocation } from '../types/ledger'
import type { TransferLocationOption } from './transferLedger'

function recipientOf(to: TransferLocation | undefined, ownerId: string): string | null {
  return to?.type === 'personal' && to.personId && to.personId !== ownerId ? to.personId : null
}

/** The person a one-off/materialised transfer pays into, when it is person-to-person. */
export function transferRecipientId(t: Pick<Transaction, 'type' | 'toLocation' | 'ownerId'>): string | null {
  return t.type === 'transfer' ? recipientOf(t.toLocation, t.ownerId) : null
}

/** The same for a recurring transfer template. */
export function templateRecipientId(t: Pick<RecurringTemplate, 'kind' | 'transferTo' | 'ownerId' | 'active'>): string | null {
  return t.kind === 'transfer' && t.active ? recipientOf(t.transferTo, t.ownerId) : null
}

/** The recipient's view of a row: the same money, arriving. Same id, so editing or deleting it from either person's list reaches the one stored row. */
export function asIncoming<T extends { direction: Transaction['direction'] }>(t: T): T {
  return { ...t, direction: 'in' }
}

/** The other people's current accounts, as TO options for a transfer owned by `ownerId`. Empty in a one-person household. */
export function personTransferOptions(people: { id: string; name: string }[], ownerId: string): TransferLocationOption[] {
  if (people.length < 2) return []
  return people
    .filter((p) => p.id !== ownerId)
    .map((p) => ({ key: `personal:${p.id}`, label: `${p.name}'s Current Account`, location: { type: 'personal' as const, personId: p.id } }))
}

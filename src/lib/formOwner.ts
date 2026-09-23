// PROMPT-16 Part D1 (2026-09-22) — the owner a bill/loan form STARTS with.
//
// A joint item stores `ownerId: ''`, and here '' is a MEANING ("joint, owned
// by nobody"), not "unset". The forms used to write
// `useState(initial?.ownerId || defaultOwnerId)`, which cannot tell the two
// apart: `||` swallows the '' and substitutes whoever "me" is. That value was
// never displayed for a joint item (LocationEditor hides the Owner field) and
// never saved (the save forces '' back for 'joint'), so on its own it did no
// harm — but two places disagreeing about what '' means is exactly how the
// 2026-09-22 joint-bill damage started, and the next reader of `||` would
// not know which of the two is the accident. So the rule is written once:
//
//  - joint      → the form holds the primary person as a STANDBY owner, used
//                 only if the user switches the location to Personal/Pot. It
//                 is not the item's owner and the save must never write it.
//  - personal /
//    pot        → the item's own owner, or the primary person for a new one.
//
// BillOwner.test.tsx asserts the form shows no owner for a joint item and
// saves '' with the share unchanged, while a personal one still defaults to
// the primary person.

import type { BillLocation } from '../types/models'

export function formOwnerId(initial: { location?: BillLocation; ownerId?: string } | undefined, primaryPersonId: string): string {
  if (!initial) return primaryPersonId
  if (initial.location === 'joint') return primaryPersonId // a standby, see above
  return initial.ownerId ? initial.ownerId : primaryPersonId
}

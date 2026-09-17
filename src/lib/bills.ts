import type { Bill } from '../types/models'

/** Total of every joint-account bill, regardless of who it's nominally tagged to. */
export function jointAccountTotal(bills: Bill[]): number {
  return round2(bills.filter((b) => b.location === 'joint').reduce((sum, b) => sum + b.cost, 0))
}

/** This person's personal-account bills only (location = 'personal', owned by them). */
export function personalBillsTotal(bills: Bill[], personId: string): number {
  return round2(
    bills.filter((b) => b.location === 'personal' && b.ownerId === personId).reduce((sum, b) => sum + b.cost, 0)
  )
}

/**
 * What a single joint bill costs a given person, honouring its split:
 *  - If they're the assigned payee, they get `payeeSharePercent`% of the cost
 *  - Otherwise they get an equal share of the remainder, split across everyone
 *    else in the household (in the normal two-person case, that's just the
 *    other 100 - percent%)
 */
export function costForPerson(bill: Bill, personId: string, allPeople: { id: string }[]): number {
  if (bill.location === 'personal') return bill.ownerId === personId ? bill.cost : 0

  const percent = clampPercent(bill.payeeSharePercent)
  if (bill.payee === personId) return round2((bill.cost * percent) / 100)

  const others = allPeople.filter((p) => p.id !== bill.payee)
  if (others.length === 0) return 0
  if (!others.some((p) => p.id === personId)) return 0

  const remainderShare = ((100 - percent) / 100) * bill.cost
  return round2(remainderShare / others.length)
}

/**
 * This person's contribution toward joint-account bills, summed across every
 * joint bill using its individual split.
 */
export function jointContributionForPerson(bills: Bill[], personId: string, allPeople: { id: string }[]): number {
  const total = bills
    .filter((b) => b.location === 'joint')
    .reduce((sum, b) => sum + costForPerson(b, personId, allPeople), 0)
  return round2(total)
}

/** Everything this person is on the hook for: their personal bills + their joint share. */
export function totalOutgoingsForPerson(bills: Bill[], personId: string, allPeople: { id: string }[]): number {
  return round2(personalBillsTotal(bills, personId) + jointContributionForPerson(bills, personId, allPeople))
}

/** Standing-orders-only total — personal-account bills only, no joint contribution. */
export function standingOrderTotalForPerson(bills: Bill[], personId: string): number {
  const personal = bills
    .filter((b) => b.location === 'personal' && b.ownerId === personId && b.isStandingOrder)
    .reduce((sum, b) => sum + b.cost, 0)
  return round2(personal)
}

export function billsByLocation(bills: Bill[], location: 'personal' | 'joint', ownerId?: string): Bill[] {
  return bills
    .filter((b) => b.location === location && (location === 'joint' || b.ownerId === ownerId))
    .sort((a, b) => a.dueDay - b.dueDay)
}

/** Human-readable description of a joint bill's split, e.g. "Adam 60% · Ella 40%". */
export function jointSplitLabel(bill: Bill, people: { id: string; name: string }[]): string {
  const percent = clampPercent(bill.payeeSharePercent)
  const payeeName = people.find((p) => p.id === bill.payee)?.name ?? 'Unassigned'

  if (percent >= 100) return `${payeeName} (full cost)`

  const others = people.filter((p) => p.id !== bill.payee)
  if (others.length === 0) return `${payeeName} ${percent}%`
  if (others.length === 1) return `${payeeName} ${percent}% · ${others[0].name} ${100 - percent}%`

  const otherShare = round2((100 - percent) / others.length)
  return `${payeeName} ${percent}% · ${others.map((p) => p.name).join('/')} ${otherShare}% each`
}

function clampPercent(p: number): number {
  if (Number.isNaN(p)) return 50
  return Math.max(0, Math.min(100, p))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

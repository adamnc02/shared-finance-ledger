// The swipe deck — which cards exist, in which order, and what each one
// is called. Lifted out of pages/Home.tsx (2026-09-24) so the downloadable
// cycle statement builds its sections from the SAME list the Home page
// swipes through, rather than a second hand-written list of card kinds.
//
// 🚨 That is the whole reason this file exists. A statement whose sections
// came from their own list would silently stop matching the app the first
// time a card type was added — the sections and the deck would disagree,
// and nothing would fail. See TECHNICAL.md §"The cycle statement".

import type { AppDataV2 } from '../types/ledger'
import { visibleLoanCards } from './loanLedger'

// ── Deck construction — doc addendum on Summary card visibility ────────
// 'personal' is always present (it's the primary viewer's own account).
// 'joint'/'household' only make sense once a second person and a joint
// cost both exist. Credit cards are scoped to the primary person's own
// cards only — this app has no "switch active viewer" concept.

export type DeckEntry =
  | { kind: 'personal' }
  | { kind: 'joint' }
  | { kind: 'household' }
  | { kind: 'credit_card'; cardId: string }
  | { kind: 'loan'; loanId: string }
  | { kind: 'savings_pot'; potId: string }
  | { kind: 'pot'; potId: string }

// Deck order (Adam-specified, 2026-09-10): Personal, Joint*, Pots*,
// Credit Card(s)*, Savings Pots*, Household*. Each conditional entry
// keeps its own pre-existing visibility rule below — only the ORDER
// changed, not which cards appear or when.
export function buildDeck(data: AppDataV2): DeckEntry[] {
  const deck: DeckEntry[] = [{ kind: 'personal' }]

  const hasJointItem = data.recurringTemplates.some((t) => t.location === 'joint') || data.loans.some((l) => l.location === 'joint' && l.active)
  if (data.people.length >= 2 && hasJointItem) deck.push({ kind: 'joint' })

  // Pots backlog item, Phase 7 (2026-09 session) — Adam's own spec: "it
  // get's its own swipe card in the Summary page. It's ledger should
  // match the same style as the Personal swipe card... There should be
  // no pie chart." A Pot is architecturally its own thing (see Pot's own
  // header comment in types/ledger.ts), so it gets its own deck kind
  // rather than being folded into 'savings_pot'.
  const myBillsPots = (data.pots ?? []).filter((p) => p.personId === data.primaryPersonId && p.active)
  for (const p of myBillsPots) deck.push({ kind: 'pot', potId: p.id })

  // A combined "All Cards" entry used to be appended here once the
  // person had more than one active card — removed (Adam-specified,
  // 2026-09-12): each credit card already gets its own deck entry, and
  // the extra combined one wasn't wanted alongside them.
  const myCards = data.creditCards.filter((c) => c.ownerId === data.primaryPersonId && c.active)
  for (const c of myCards) deck.push({ kind: 'credit_card', cardId: c.id })

  // PROMPT-08a Part C — one card per loan this person owns, placed with
  // the other debt rather than among the savings cards. Visibility
  // (ownership, and hidden once settled OR fully repaid) is
  // `isLoanCardVisible`'s call, not re-derived here — see lib/loanLedger.ts.
  for (const l of visibleLoanCards(data)) deck.push({ kind: 'loan', loanId: l.id })

  // REDESIGN (Adam-specified, 2026-09-02 — "it needs its own hero card,
  // like credit cards/joint account in the swipe deck, and not to be in
  // any way part of the personal card's screen render"): each pot is now
  // a genuine swipeable deck entry, same as a credit card, NOT content
  // bolted onto 'personal'. Nothing about Personal's own DeckHero/
  // ProgressRingsSection touches savings pots any more — see this
  // section's own removal note there.
  const myPots = data.savingsPots.filter((p) => p.personId === data.primaryPersonId && p.active)
  for (const p of myPots) deck.push({ kind: 'savings_pot', potId: p.id })

  if (data.people.length >= 2) deck.push({ kind: 'household' })

  return deck
}

/**
 * Stable string key for a `DeckEntry` — needed for the wallet-stack's MRU
 * reorder state, which tracks *which entries* have been tapped-to-front
 * across renders, not their (unstable, buildDeck-order-dependent) index.
 */
export function deckEntryKey(e: DeckEntry): string {
  switch (e.kind) {
    case 'credit_card':
      return `credit_card:${e.cardId}`
    case 'loan':
      return `loan:${e.loanId}`
    case 'savings_pot':
      return `savings_pot:${e.potId}`
    case 'pot':
      return `pot:${e.potId}`
    default:
      return e.kind
  }
}

export function heroLabel(entry: DeckEntry, data: AppDataV2): string {
  const primaryPerson = data.people.find((p) => p.id === data.primaryPersonId)
  switch (entry.kind) {
    case 'personal':
      return `${primaryPerson?.name ?? 'Me'} Personal`
    case 'joint':
      return `${primaryPerson?.name ?? 'Me'} Joint`
    case 'household':
      return 'Household Combined'
    case 'credit_card': {
      const card = data.creditCards.find((c) => c.id === entry.cardId)
      return `${card?.name ?? 'Credit Card'} Credit Card`
    }
    case 'loan': {
      const loan = data.loans.find((l) => l.id === entry.loanId)
      return `${loan?.name ?? 'Loan'} Loan`
    }
    case 'savings_pot': {
      const pot = data.savingsPots.find((p) => p.id === entry.potId)
      return `${pot?.name ?? 'Savings'} Savings`
    }
    case 'pot': {
      const pot = (data.pots ?? []).find((p) => p.id === entry.potId)
      return `${pot?.name ?? 'Pot'} Pot`
    }
  }
}

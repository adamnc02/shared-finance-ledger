import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency, formatFullDate, formatMonthYear } from '../lib/format'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, ChevronDown, ChevronUp, CreditCard as CreditCardIcon, X, Info, AlertTriangle } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import {
  summarizeLoan,
  summarizeLoanProgress,
  estimateSettlementFigure,
  findLenderCalibrationProfile,
  previewOverpaymentRecast,
  buildLoanLedgerRows,
  loanFinishInfo,
  isLoanConfidentlyCalibrated,
  MAX_CALIBRATION_LINES,
  recentAndUpcomingLoanPaymentDates,
  applyLoanMonthlyPaymentChange,
  type CalibrationResult,
  type LoanLedgerRowType,
} from '../lib/ledgerLoans'
import { nextMinimumChargeAmount, pickNextSharedCardColor, buildCreditCardMinimumChargeRows, buildCreditCardDueOverviewRows, cardBalanceAsOf, withLiveBalance, creditCardMinimumClearsFullBalance, defaultStatementWindowForPaymentDay, recentAndUpcomingCardPaymentDates } from '../lib/creditCards'
import { CREDIT_CARD_CATEGORY_ID, type CreditCard, type CreditCardMinimumPayment, type Loan, type Pot, type StatementCalibrationLine, type Transaction } from '../types/ledger'
import type { BillLocation } from '../types/models'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { visibleCategoriesFor, seededCategoryIdForIcon } from '../lib/categories'
import { aprToMonthlyRate, standardPayment } from '../lib/interestConventions'
import { LocationEditor } from '../components/LocationEditor'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { ConfirmModal } from '../components/ConfirmModal'
import { FormButtonRow, CancelButton, SaveButton } from '../components/FormButtons'
import { EffectiveDatedChangeFlow, type RecurringChangeField } from '../components/EffectiveDatedChangeFlow'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { useSavedFlash, SavedFlashOverlay } from '../components/SavedFlash'
import { peopleWithIncomeCount } from '../lib/household'
import { shouldOfferLocationPicker } from '../lib/pickerFirst'

import { parseLocalDate, todayIso } from '../lib/date'

// The pre-seeded "Loan" category (see categories.ts) — LoanForm defaults
// new loans onto this rather than falling through to whatever happens to
// be first in the visible list (which, with no credit cards yet, used to
// resolve to "Income" — clearly wrong for a loan).
const DEFAULT_LOAN_CATEGORY_ID = seededCategoryIdForIcon('loan')

type LoanPrefill = Partial<Omit<Loan, 'id' | 'overpayments'>>

// Handed off from the What-if page's "Log as real payment" / "Make this a
// real recurring overpayment" buttons (see Scenarios.tsx's makeImpactReal)
// — rather than auto-saving there, the user is transported here with the
// target row already open and the relevant fields pre-populated, and
// saves it themselves.
export type OverpaymentPrefill = {
  targetKind: 'loan' | 'credit_card'
  targetId: string
  mode: 'payoff' | 'recurring' // 'recurring' only ever applies to loans — see below
  amount: number
  date?: string // 'payoff' only
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'var(--color-coral)' }}>
      <Plus size={14} className="text-white" />
    </button>
  )
}

/** Same "who's this for?" picker as Salary.tsx's — own local copy per this codebase's per-page-file convention for small shared UI. */
function PersonPickerCard({ people, onPick, onCancel }: { people: { id: string; name: string }[]; onPick: (personId: string) => void; onCancel: () => void }) {
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Who's this for?</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {people.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick(p.id)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * "Where does this get paid from?" — Picker-First Flows (2026-09
 * session). Own local copy per this codebase's per-page-file convention
 * — see Bills.tsx's identical component for the full reasoning (single
 * flat list, picking a pot sets both location and potId in one tap, not
 * shown at all when Current Account is the only possible answer).
 */
function LocationPickerCard({
  canBeJoint,
  ownerPots,
  onPick,
  onCancel,
}: {
  canBeJoint: boolean
  ownerPots: Pot[]
  onPick: (pick: { location: BillLocation; potId?: string }) => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Where does this get paid from?</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <button onClick={() => onPick({ location: 'personal' })} className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]" style={{ background: 'var(--color-surface)' }}>
          Current Account
        </button>
        {canBeJoint && (
          <button onClick={() => onPick({ location: 'joint' })} className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]" style={{ background: 'var(--color-surface)' }}>
            Joint Account
          </button>
        )}
        {ownerPots.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick({ location: 'pot', potId: p.id })}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Loans() {
  const {
    data,
    importGeneration,
    addLoan,
    updateLoan,
    removeLoan,
    logLoanOverpayment,
    settleLoanAction,
    calibrateLoanAction,
    addCreditCard,
    updateCreditCard,
    updateCreditCardMinimumCharge,
    assignCreditCardLocation,
    removeCreditCard,
    logCreditCardLumpPayment,
    addCategory,
    assignLoanLocation,
  } = useLedgerData()
  const [addingLoan, setAddingLoan] = useState(false)
  // Same "if multiple people, person-selector first; otherwise straight
  // to the form" flow now applied consistently across Salary/Pension/
  // Savings/Loans/Credit Cards — see PersonPickerCard's own comment in
  // Salary.tsx for the full reasoning. defaultOwnerId feeds LoanForm's
  // existing ownerId field unchanged; this only decides what it starts
  // pre-filled to.
  const [pickingLoanOwner, setPickingLoanOwner] = useState(false)
  const [pickingLoanLocation, setPickingLoanLocation] = useState(false)
  const [loanDefaultOwnerId, setLoanDefaultOwnerId] = useState(data.primaryPersonId)
  const [loanDefaultLocation, setLoanDefaultLocation] = useState<{ location: BillLocation; potId?: string }>({ location: 'personal' })
  const [addingCard, setAddingCard] = useState(false)
  const [pickingCardOwner, setPickingCardOwner] = useState(false)
  const [cardDefaultOwnerId, setCardDefaultOwnerId] = useState(data.primaryPersonId)
  const [expandedLoan, setExpandedLoan] = useState<string | null>(null)
  const [expandedCard, setExpandedCard] = useState<string | null>(null)
  // Batch 7 (2026-09-07, bug 7) — resync these picker-first defaults (and
  // drop any stale expanded row) after a backup import, which replaces
  // `data` wholesale — see LedgerContext's own comment on
  // `importGeneration` for why an ordinary `data` dependency can't tell
  // an import apart from any other mutation.
  useEffect(() => {
    setLoanDefaultOwnerId(data.primaryPersonId)
    setCardDefaultOwnerId(data.primaryPersonId)
    setExpandedLoan(null)
    setExpandedCard(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importGeneration])
  const [overpaymentPrefill, setOverpaymentPrefill] = useState<OverpaymentPrefill | null>(null)
  // Batch 9 (2026-09-07, Bug 11) — a brand-new loan/card has no card to
  // flash at the moment its own Save fires (the row only mounts on the
  // NEXT render, once data.loans/data.creditCards includes it) — same
  // "flash on mount instead" handoff Bills.tsx uses for a new bill.
  const [justCreatedLoanId, setJustCreatedLoanId] = useState<string | null>(null)
  const [justCreatedCardId, setJustCreatedCardId] = useState<string | null>(null)
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const loanPrefill = (routerLocation.state as { loanPrefill?: LoanPrefill } | null)?.loanPrefill

  // Loans only offer a Personal/Joint choice once there's actually a joint
  // bill to make that split meaningful — see LoanEditPanel/LoanForm's
  // "hasJointBills" prop for the full reasoning.
  const hasJointBills = data.recurringTemplates.some((t) => t.location === 'joint')
  // ...and, separately, only once 2+ people actually have real income
  // (salary or an active pension) to split — see lib/household.ts's
  // hasIncomeConfigured.
  const canBeJoint = peopleWithIncomeCount(data.people, data.pensions) >= 2

  // Shared by both the single-person-owner shortcut and PersonPickerCard's
  // onPick (Picker-First Flows, 2026-09 session) — same skip logic as
  // Bills.tsx's proceedPastOwner: only shows the Location step when
  // there's a real choice besides Current Account for this owner.
  function proceedPastLoanOwner(ownerId: string) {
    setLoanDefaultOwnerId(ownerId)
    const ownerHasPots = data.pots.some((p) => p.personId === ownerId && p.active)
    if (shouldOfferLocationPicker(canBeJoint, ownerHasPots)) {
      setPickingLoanLocation(true)
    } else {
      setLoanDefaultLocation({ location: 'personal' })
      setAddingLoan(true)
    }
  }

  useEffect(() => {
    if (loanPrefill) setAddingLoan(true)

    const prefill = (routerLocation.state as { overpaymentPrefill?: OverpaymentPrefill } | null)?.overpaymentPrefill
    if (prefill) {
      setOverpaymentPrefill(prefill)
      if (prefill.targetKind === 'loan') setExpandedLoan(prefill.targetId)
      else setExpandedCard(prefill.targetId)
      // Consumed into local state above — clear the router state so a
      // manual close/reopen of this same row later doesn't re-trigger it.
      navigate('.', { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLocation.state])

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Borrowing</h1>
      </header>

      <CollapsibleSection
        title="Loans"
        className="mb-8"
        headerExtra={
          <AddButton
            onClick={() => {
              if (data.people.length === 1) {
                proceedPastLoanOwner(data.people[0].id)
              } else {
                setPickingLoanOwner(true)
              }
            }}
          />
        }
      >
        <p className="text-xs text-[var(--color-ink-faint)] mb-3 leading-relaxed">
          Monthly amount + term are the inputs now — the total payable is worked out from those, rather than the
          other way round. Log a real overpayment on any loan below and its remaining schedule shrinks for good.
        </p>

        {pickingLoanOwner && (
          <PersonPickerCard
            people={data.people}
            onPick={(id) => {
              setPickingLoanOwner(false)
              proceedPastLoanOwner(id)
            }}
            onCancel={() => setPickingLoanOwner(false)}
          />
        )}

        {pickingLoanLocation && (
          <LocationPickerCard
            canBeJoint={canBeJoint}
            ownerPots={data.pots.filter((p) => p.personId === loanDefaultOwnerId && p.active)}
            onPick={(pick) => {
              setLoanDefaultLocation(pick)
              setPickingLoanLocation(false)
              setAddingLoan(true)
            }}
            onCancel={() => setPickingLoanLocation(false)}
          />
        )}

        {addingLoan && (
          <LoanForm
            people={data.people}
            pots={data.pots}
            categories={visibleCategoriesFor(data)}
            defaultOwnerId={loanDefaultOwnerId}
            defaultLocation={loanDefaultLocation.location}
            defaultPotId={loanDefaultLocation.potId}
            initial={loanPrefill}
            hasJointBills={hasJointBills}
            canBeJoint={canBeJoint}
            existingLoans={data.loans}
            onAddCategory={addCategory}
            onCancel={() => {
              setAddingLoan(false)
              if (loanPrefill) navigate('.', { replace: true, state: null })
            }}
            onSave={(loan) => {
              // The loan's own hero-card colour, picked here rather than in
              // the form (same convention as the credit card / pot / savings
              // pot creation paths) because it needs the whole AppDataV2 to
              // scan what's already taken. PROMPT-08a Part C.
              const id = addLoan({ ...loan, color: pickNextSharedCardColor(data) })
              setJustCreatedLoanId(id)
              setAddingLoan(false)
              if (loanPrefill) navigate('.', { replace: true, state: null })
            }}
          />
        )}

        <div className="flex flex-col gap-3">
          {data.loans.map((loan) => {
            const summary = summarizeLoan(loan)
            const progress = summarizeLoanProgress(loan)
            const category = data.categories.find((c) => c.id === loan.categoryId)
            const isOpen = expandedLoan === loan.id
            return (
              <LoanRow
                key={loan.id}
                loan={loan}
                category={category}
                summary={summary}
                progress={progress}
                isOpen={isOpen}
                onToggle={() => setExpandedLoan(isOpen ? null : loan.id)}
                onRemove={() => removeLoan(loan.id)}
                categories={visibleCategoriesFor(data, loan.categoryId)}
                people={data.people}
                pots={data.pots}
                canBeJoint={canBeJoint}
                onAddCategory={addCategory}
                onSave={(u) => updateLoan(loan.id, u)}
                onAssignLocation={(location, effectiveFrom, potId) => assignLoanLocation(loan.id, location, effectiveFrom, { potId })}
                onLogOverpayment={(amount, date, note, recastMode) => logLoanOverpayment(loan.id, amount, date, note, recastMode)}
                onSettle={(amount, date, note) => settleLoanAction(loan.id, amount, date, note)}
                onCalibrate={(lines) => calibrateLoanAction(loan.id, lines)}
                overpaymentPrefill={overpaymentPrefill?.targetKind === 'loan' && overpaymentPrefill.targetId === loan.id ? overpaymentPrefill : null}
                onPrefillConsumed={() => setOverpaymentPrefill(null)}
                shouldFlashOnMount={justCreatedLoanId === loan.id}
                onFlashedOnMount={() => setJustCreatedLoanId(null)}
              />
            )
          })}
          {data.loans.length === 0 && !addingLoan && <p className="text-sm text-[var(--color-ink-muted)] text-center py-8">No loans yet.</p>}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Credit Cards"
        headerExtra={
          <AddButton
            onClick={() => {
              if (data.people.length === 1) {
                setCardDefaultOwnerId(data.people[0].id)
                setAddingCard(true)
              } else {
                setPickingCardOwner(true)
              }
            }}
          />
        }
      >
        <p className="text-xs text-[var(--color-ink-faint)] mb-3 leading-relaxed">
          A card's minimum/monthly payment is treated like a bill. Spend charged to a card (logged from the Expenses
          page) never touches your cash balance — only actual payments toward the card do.
        </p>

        {pickingCardOwner && (
          <PersonPickerCard
            people={data.people}
            onPick={(id) => {
              setCardDefaultOwnerId(id)
              setPickingCardOwner(false)
              setAddingCard(true)
            }}
            onCancel={() => setPickingCardOwner(false)}
          />
        )}

        {addingCard && (
          <CreditCardForm
            people={data.people}
            categories={visibleCategoriesFor(data, CREDIT_CARD_CATEGORY_ID)}
            defaultOwnerId={cardDefaultOwnerId}
            nextColor={pickNextSharedCardColor(data)}
            onAddCategory={addCategory}
            onCancel={() => setAddingCard(false)}
            onSave={(card) => {
              const id = addCreditCard(card)
              setJustCreatedCardId(id)
              setAddingCard(false)
            }}
          />
        )}

        <div className="flex flex-col gap-3">
          {data.creditCards.map((storedCard) => {
            // The row shows what's actually owed right now — the stored
            // anchor with every payment and spend since replayed onto it.
            // The card handed down to CreditCardRow is the LIVE one, but
            // the edit panel deliberately reads the anchor back off
            // `storedCard` for its editable balance field; see
            // CreditCardEditPanel for why those must not be confused.
            const card = withLiveBalance(storedCard, data.transactions)
            // Routed through the shared generator so this row honours
            // per-date minimumPaymentOverrides exactly as the Summary
            // page and the ledger modal do; computeMinimumPaymentAmount
            // is date-blind and silently ignored them. See
            // nextMinimumChargeAmount.
            const minPayment = nextMinimumChargeAmount(storedCard, data.transactions) ?? 0
            const isOpen = expandedCard === card.id
            return (
              <CreditCardRow
                key={card.id}
                card={card}
                storedCard={storedCard}
                minPayment={minPayment}
                isOpen={isOpen}
                onToggle={() => setExpandedCard(isOpen ? null : card.id)}
                onRemove={() => removeCreditCard(card.id)}
                people={data.people}
                pots={data.pots}
                onAssignLocation={(location, effectiveFrom, potId) => assignCreditCardLocation(card.id, location, effectiveFrom, potId)}
                categories={visibleCategoriesFor(data, card.categoryId)}
                transactions={data.transactions}
                onAddCategory={addCategory}
                onSave={(u) => updateCreditCard(card.id, u)}
                onLogLumpPayment={(amount, date, note) => logCreditCardLumpPayment(card.id, amount, date, note)}
                onUpdateMinimumCharge={(date, amount) => updateCreditCardMinimumCharge(card.id, date, amount)}
                overpaymentPrefill={overpaymentPrefill?.targetKind === 'credit_card' && overpaymentPrefill.targetId === card.id ? overpaymentPrefill : null}
                onPrefillConsumed={() => setOverpaymentPrefill(null)}
                shouldFlashOnMount={justCreatedCardId === card.id}
                onFlashedOnMount={() => setJustCreatedCardId(null)}
              />
            )
          })}
          {data.creditCards.length === 0 && !addingCard && <p className="text-sm text-[var(--color-ink-muted)] text-center py-8">No credit cards yet.</p>}
        </div>
      </CollapsibleSection>
    </div>
  )
}

/** The full ordinal for a day, e.g. 14 -> "14th". `ordinalSuffix` below
 * returns only the SUFFIX ("th"), which reads correctly when the number is
 * already being printed next to it ({day}{ordinalSuffix(day)}) but renders
 * as a bare "th" on its own — a mistake the statement-window caption was
 * already making before PROMPT-01 (2026-09-16). */
function ordinalDay(day: number): string {
  return `${day}${ordinalSuffix(day)}`
}

function ordinalSuffix(day: number): string {
  if (day % 10 === 1 && day !== 11) return 'st'
  if (day % 10 === 2 && day !== 12) return 'nd'
  if (day % 10 === 3 && day !== 13) return 'rd'
  return 'th'
}

// ── Loan / Credit Card row wrappers — own the collapse-on-save + green
// flash feedback (see SavedFlash.tsx), matching the same pattern used on
// the Bills and Salary pages. The row collapses and its "open" edit
// panel unmounts (via the isOpen && guard), then the whole row briefly
// flashes green with a check mark and "Saved". ──

function LoanRow({
  loan,
  category,
  summary,
  progress,
  isOpen,
  onToggle,
  onRemove,
  categories,
  people,
  pots,
  canBeJoint,
  onAddCategory,
  onSave,
  onAssignLocation,
  onLogOverpayment,
  onSettle,
  onCalibrate,
  overpaymentPrefill,
  onPrefillConsumed,
  shouldFlashOnMount,
  onFlashedOnMount,
}: {
  loan: Loan
  category: { id: string; name: string; icon: string; iconColor: string } | undefined
  summary: ReturnType<typeof summarizeLoan>
  progress: ReturnType<typeof summarizeLoanProgress>
  isOpen: boolean
  onToggle: () => void
  onRemove: () => void
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  people: { id: string; name: string }[]
  pots: Pot[]
  canBeJoint: boolean
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<Loan, 'id' | 'overpayments'>>) => void
  onAssignLocation: (location: BillLocation, effectiveFrom: string, potId?: string) => void
  onLogOverpayment: (amount: number, date: string, note?: string, recastMode?: 'reduce_term' | 'reduce_payment') => void
  onSettle: (amount: number, date: string, note?: string) => void
  onCalibrate: (lines: StatementCalibrationLine[]) => CalibrationResult | null
  overpaymentPrefill: OverpaymentPrefill | null
  onPrefillConsumed: () => void
  /** Batch 9 (2026-09-07, Bug 11) — true for exactly one render right
   * after this loan was newly created, so it can flash "Loan saved." on
   * mount (no card exists yet at the moment a brand-new loan's own save
   * button is clicked). */
  shouldFlashOnMount?: boolean
  onFlashedOnMount?: () => void
}) {
  const { active: flashActive, message: flashMessage, trigger: triggerFlash } = useSavedFlash()
  const [ledgerOpen, setLedgerOpen] = useState(false)
  useEffect(() => {
    if (shouldFlashOnMount) {
      triggerFlash('Loan saved')
      onFlashedOnMount?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={loan.name}>
      <div className="relative rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center gap-2">
          <button onClick={onToggle} className="flex-1 min-w-0 flex items-center justify-between text-left">
            <div className="flex items-center gap-2 min-w-0">
              <CategoryIcon category={category} />
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-[var(--color-ink)] truncate">{loan.name}</h3>
                {/* Headline is the nominal remaining figure — "how much more
                    cash will I hand over if I keep paying as scheduled,"
                    including interest not yet accrued — matching the same
                    figure now headlined on the Home page's pie chart. True
                    capital/principal still owed (what a bank app's own
                    balance figure shows) stays visible on the line below,
                    clearly separate rather than silently swapped for it. */}
                <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                  £{formatCurrency(progress.amortisedRemaining)} remaining · {summary.monthsRemaining} payment
                  {summary.monthsRemaining === 1 ? '' : 's'} left
                </p>
                <p className="text-[11px] text-[var(--color-ink-faint)]">£{formatCurrency(progress.capitalRemaining)} capital owed</p>
              </div>
            </div>
            <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
          </button>
          {/* Loan ledger modal entry point (D8, scope §10) — deliberately on THIS card, on the Loans/Borrowing page, not on the Home page's pie card as the scope doc originally described. */}
          <button onClick={() => setLedgerOpen(true)} className="shrink-0 text-[var(--color-ink-faint)]" aria-label={`View ${loan.name}'s ledger`}>
            <Info size={16} />
          </button>
        </div>

        {ledgerOpen && <LoanLedgerModal loan={loan} onClose={() => setLedgerOpen(false)} />}

        <div className="h-1.5 rounded-full mt-3 overflow-hidden" style={{ background: 'var(--color-track)' }}>
          <div className="h-full rounded-full" style={{ width: `${progress.percentPaid}%`, background: 'var(--color-coral)' }} />
        </div>

        {/* UAT 2026-09-08 (6-bug4-loans): this panel now always mounts —
            its own `isOpen` prop gates just the Name/Amount/etc. fields
            grid, so the log/recurring-overpayment and Settle actions stay
            visible on the collapsed card too, matching Joint Account. */}
        <LoanEditPanel
            loan={loan}
            isOpen={isOpen}
            categories={categories}
            people={people}
            pots={pots}
            canBeJoint={canBeJoint}
            onAddCategory={onAddCategory}
            onSave={(u) => {
              onSave(u)
              onToggle()
              triggerFlash()
            }}
            onAssignLocation={(location, effectiveFrom, potId) => {
              onAssignLocation(location, effectiveFrom, potId)
              onToggle()
              triggerFlash()
            }}
            onLogOverpayment={(amount, date, note, recastMode) => {
              // UAT 2026-09-08 (followup-loan-overpayment-ui): this was
              // the one action here that flashed but left the whole loan
              // card expanded, unlike Save/Settle above. Guarded on isOpen
              // now that this action is reachable from a collapsed card
              // too — must never OPEN the card, only collapse it if it
              // was already open.
              onLogOverpayment(amount, date, note, recastMode)
              if (isOpen) onToggle()
              triggerFlash()
            }}
            onSettle={(amount, date, note) => {
              onSettle(amount, date, note)
              if (isOpen) onToggle()
              triggerFlash('Loan settled')
            }}
            onCalibrate={onCalibrate}
            onCalibrated={() => triggerFlash('Calibration saved')}
            overpaymentPrefill={overpaymentPrefill}
            onPrefillConsumed={onPrefillConsumed}
            onCancel={() => isOpen && onToggle()}
          />

        <SavedFlashOverlay active={flashActive} message={flashMessage} />
      </div>
    </SwipeToDelete>
  )
}

function CreditCardRow({
  card,
  storedCard,
  minPayment,
  isOpen,
  onToggle,
  onRemove,
  people,
  pots,
  onAssignLocation,
  categories,
  transactions,
  onAddCategory,
  onSave,
  onLogLumpPayment,
  onUpdateMinimumCharge,
  overpaymentPrefill,
  onPrefillConsumed,
  shouldFlashOnMount,
  onFlashedOnMount,
}: {
  card: CreditCard // live: currentBalance is the DERIVED figure, for display
  storedCard: CreditCard // as persisted: currentBalance is the stated anchor, for editing
  minPayment: number
  isOpen: boolean
  onToggle: () => void
  onRemove: () => void
  people: { id: string; name: string }[]
  pots: Pot[]
  onAssignLocation: (location: 'personal' | 'pot', effectiveFrom: string, potId?: string) => void
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  transactions: Transaction[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>>) => void
  onLogLumpPayment: (amount: number, date: string, note?: string) => void
  onUpdateMinimumCharge: (date: string, amount: number) => void
  overpaymentPrefill: OverpaymentPrefill | null
  onPrefillConsumed: () => void
  /** Batch 9 (2026-09-07, Bug 11) — see LoanRow's own comment. */
  shouldFlashOnMount?: boolean
  onFlashedOnMount?: () => void
}) {
  const { active: flashActive, message: flashMessage, trigger: triggerFlash } = useSavedFlash()
  const [ledgerOpen, setLedgerOpen] = useState(false)
  useEffect(() => {
    if (shouldFlashOnMount) {
      triggerFlash('Credit Card saved')
      onFlashedOnMount?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={card.name}>
      <div className="relative rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center gap-2">
          <button onClick={onToggle} className="flex-1 min-w-0 flex items-center justify-between text-left">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center shrink-0 rounded-full" style={{ width: 32, height: 32, background: `${card.color}22` }}>
              <CreditCardIcon size={16} strokeWidth={1.75} style={{ color: card.color }} />
            </span>
            <div>
              <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{card.name}</h3>
              <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                £{formatCurrency(card.currentBalance)} owed · £{formatCurrency(minPayment)} due on the {card.paymentDayOfMonth}
                {ordinalSuffix(card.paymentDayOfMonth)}
              </p>
            </div>
          </div>
          <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
          </button>
          <button onClick={() => setLedgerOpen(true)} className="shrink-0 text-[var(--color-ink-faint)]" aria-label={`View ${card.name}'s minimum charges`}>
            <Info size={16} />
          </button>
        </div>

        {ledgerOpen && (
          // BUGFIX (2026-09-16, Adam-reported — "Clear" on an EXISTING
          // card with real transaction history logged double the true
          // balance due). `card` here is the LIVE variant (see this
          // component's own prop comment: "currentBalance is the DERIVED
          // figure, for display") — its `currentBalance` is already the
          // result of replaying every real transaction onto the stored
          // anchor, but `balanceAsOfDate` stays at the ORIGINAL anchor
          // date. Feeding that back into buildCreditCardMinimumChargeRows
          // (which itself calls cardBalanceAsOf/generateMinimumPaymentTransactions,
          // both of which start from `card.currentBalance` and then
          // REPLAY the same real activity from `card.balanceAsOfDate`
          // onward on top of it) double-counts every transaction between
          // the anchor and today. `storedCard` is exactly what these
          // functions expect: currentBalance genuinely AS OF
          // balanceAsOfDate, nothing replayed into it yet.
          <CreditCardLedgerModal card={storedCard} transactions={transactions} onUpdateMinimumCharge={onUpdateMinimumCharge} onClose={() => setLedgerOpen(false)} />
        )}

        {/* UAT 2026-09-08 (6-bug4-cards): always mounted now — see
            LoanEditPanel's own comment on the same pattern. */}
        <CreditCardEditPanel
            storedCard={storedCard}
            card={card}
            isOpen={isOpen}
            transactions={transactions}
            people={people}
            pots={pots}
            onAssignLocation={onAssignLocation}
            categories={categories}
            onAddCategory={onAddCategory}
            onSave={(u) => {
              onSave(u)
              onToggle()
              triggerFlash()
            }}
            onLogLumpPayment={(amount, date, note) => {
              // UAT 2026-09-08 (followup-loan-overpayment-ui, same root
              // cause on the credit card's analogous action). Guarded on
              // isOpen now that this is reachable from a collapsed card.
              onLogLumpPayment(amount, date, note)
              if (isOpen) onToggle()
              triggerFlash()
            }}
            onClearBalance={(date, amount) => {
              // 2026-09-09 followup (Adam-requested) — Save on the new
              // confirm modal collapses the card too, same as every other
              // action here (Save, Log a payment) once it commits.
              onLogLumpPayment(amount, date, 'Statement cleared')
              if (isOpen) onToggle()
              triggerFlash()
            }}
            overpaymentPrefill={overpaymentPrefill}
            onPrefillConsumed={onPrefillConsumed}
            onCancel={() => isOpen && onToggle()}
          />

        <SavedFlashOverlay active={flashActive} message={flashMessage} />
      </div>
    </SwipeToDelete>
  )
}
// immediate, same as before. ──

type LoanDraft = Omit<Loan, 'id' | 'overpayments'>

function draftFromLoan(loan: Loan): LoanDraft {
  const { id: _id, overpayments: _overpayments, ...rest } = loan
  return rest
}

/** Shared display label for a BillLocation, matching Bills.tsx's
 * billLocationLabel (Batch 7, Bug 8's confirmation modal) — kept as a
 * separate small copy here rather than a cross-file import, same
 * proportionate-duplication call as this file's own pattern elsewhere
 * (e.g. LoggedPaymentList/LumpPaymentList). */
function loanLocationLabel(location: BillLocation, potId: string | undefined, pots: Pot[]): string {
  if (location === 'pot') return pots.find((p) => p.id === potId)?.name ?? 'a pot'
  if (location === 'joint') return 'Joint Account'
  return 'Current Account'
}

function LoanEditPanel({
  loan,
  isOpen,
  categories,
  people,
  pots,
  canBeJoint,
  onAddCategory,
  onSave,
  onAssignLocation,
  onLogOverpayment,
  onSettle,
  onCalibrate,
  onCalibrated,
  overpaymentPrefill,
  onPrefillConsumed,
  onCancel,
}: {
  loan: Loan
  /** UAT 2026-09-08 (6-bug4-loans) — gates only the Name/Amount/etc.
   * fields grid + its own Save button; the action buttons/lists above it
   * (log/recurring overpayment, Settle) render regardless, matching Joint
   * Account's always-visible action buttons. This panel is now always
   * mounted once expandable at all — see LoanRow's own call site. */
  isOpen: boolean
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  people: { id: string; name: string }[]
  pots: Pot[]
  canBeJoint: boolean
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<Loan, 'id' | 'overpayments'>>) => void
  onAssignLocation: (location: BillLocation, effectiveFrom: string, potId?: string) => void
  onLogOverpayment: (amount: number, date: string, note?: string, recastMode?: 'reduce_term' | 'reduce_payment') => void
  onSettle: (amount: number, date: string, note?: string) => void
  onCalibrate: (lines: StatementCalibrationLine[]) => CalibrationResult | null
  /** Batch 9 (2026-09-07, Bug 11) — see CalibrationModal's own comment. */
  onCalibrated?: () => void
  overpaymentPrefill: OverpaymentPrefill | null
  onPrefillConsumed: () => void
  /** UAT 2026-09-08 (7-bug8.2-confirm-loans note) — this fields form had
   * no Cancel at all; collapses the card without saving. */
  onCancel: () => void
}) {
  // 2026-09-09 followup — a 'recurring' prefill from the What-if page's
  // "Make this a real recurring overpayment" button now goes straight to
  // the Transactions page's Overpayments pill instead of here (recurring
  // overpayments are no longer created/edited on the Borrowing page at
  // all — see Scenarios.tsx's makeImpactReal), so overpaymentPrefill
  // reaching this panel is always a 'payoff' (one-off) prefill now.
  const [draft, setDraft] = useState<LoanDraft>(() => draftFromLoan(loan))
  const [loggingOverpayment, setLoggingOverpayment] = useState(overpaymentPrefill?.mode === 'payoff')
  const [settlingLoan, setSettlingLoan] = useState(false)
  const [calibratingLoan, setCalibratingLoan] = useState(false)
  const navigate = useNavigate()
  // UAT follow-up (2026-09-04, Adam-requested app-wide sweep): dims Save
  // when nothing's changed — this panel's Save was a plain always-on
  // button with no dirty/validity gating at all before this.
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromLoan(loan))
  // Pots backlog item (2026-09 session) — a location change needs its own
  // effective date, same reasoning as Bills.tsx's BillEditPanel (see
  // that component's own comment for the full picture; this mirrors it
  // with a plain date field rather than a "pick a specific upcoming
  // payment" list — Loans.tsx has no existing per-occurrence picker
  // infrastructure the way Bills does, and Adam's own spec for the
  // closely analogous pot-creation flow was itself just "date picker,
  // default to today," so this stays proportionate rather than building
  // a parallel picker UI for one field.
  // UAT 2026-09-08 (7-bug8.2-confirm-loans note): replaced by a picker-
  // first flow, matching Bills/Pots — this bare date field with no
  // occurrence list to anchor to was the specific thing Adam asked to
  // remove. Generalised 2026-09-09 into the shared EffectiveDatedChangeFlow
  // (same changeKind convention as BillEditPanel) to also cover a
  // monthlyPayment change, now that Loan has a real monthlyPaymentHistory
  // mechanism (ledgerLoans.ts's resolveMonthlyPayment/
  // applyLoanMonthlyPaymentChange) — no scope ("just this/all future")
  // step for monthlyPayment, per Adam's own call: a loan's own payment
  // has no single-occurrence concept, only a permanent change.
  const [changeKind, setChangeKind] = useState<'monthlyPayment' | 'location' | 'startDate' | null>(null)
  // 2026-09-16 — the first payment date goes through the same "which
  // payment" step. Saving it straight onto the loan re-created every past
  // payment on the new day; changeLoanStartDate re-dates them instead.
  const { changeLoanStartDate } = useLedgerData()
  const startDateChanged = draft.startDate !== loan.startDate

  // Prefill only needs to seed the initial draft/form state above — once
  // this panel has mounted with it, tell the parent to forget it so a
  // later manual close/reopen of this same row starts fresh.
  useEffect(() => {
    if (overpaymentPrefill) onPrefillConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // UAT 2026-09-08 (6-bug4-loans): this panel now stays mounted while the
  // card is collapsed (see `isOpen`'s own comment) rather than unmounting
  // and losing its draft the way it used to — so an abandoned field edit
  // (Cancel, or just tapping the header to collapse without saving) needs
  // an explicit reset instead of relying on a fresh mount to provide one.
  useEffect(() => {
    if (!isOpen) {
      setDraft(draftFromLoan(loan))
      setChangeKind(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  function update(patch: Partial<LoanDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
  }

  // UAT 2026-09-08 (7-bug8.2-confirm-loans note, same fix as Bills.tsx's
  // own cancelEverything) — Cancel on the location date picker or the
  // confirm modal must fully discard the edit and collapse the card, not
  // just step back to the previous screen.
  function cancelEverything() {
    setDraft(draftFromLoan(loan))
    setChangeKind(null)
    onCancel()
  }

  // Live preview of the schedule impact of unsaved edits — merges the draft
  // onto the persisted loan (id/overpayments aren't part of the draft) so
  // "Total payable" reflects what Save would produce, not just what's
  // already stored.
  const previewSummary = summarizeLoan({ ...loan, ...draft })

  return (
    <div className="mt-4 flex flex-col gap-3">
      {/* Batch 6 (2026-09-07 UAT): action buttons (log/recurring overpayment,
          Settle this loan) moved above the edit-form fields to match Joint
          Account's card ordering — visible immediately on expand, not
          pushed below the fields grid. */}
      {/* 2026-09-09 session (Adam-specified) — the past-overpayments list
          used to sit here, inline in the expanded card; it now lives on
          the Transactions page's Transfers tab instead, mirroring how a
          pot/savings pot/joint account deposit doesn't show its own
          inline history on the Wallet page either — only on Transactions.
          The one-off log button/form and the recurring editor below stay
          right here, unchanged. */}
      {!loggingOverpayment ? (
        <button onClick={() => setLoggingOverpayment(true)} className="text-xs font-medium self-start" style={{ color: 'var(--color-coral)' }}>
          + Log an overpayment
        </button>
      ) : (
        <LoanOverpaymentForm
          loan={{ ...loan, ...draft }}
          initialAmount={overpaymentPrefill?.mode === 'payoff' ? overpaymentPrefill.amount : undefined}
          initialDate={overpaymentPrefill?.mode === 'payoff' ? overpaymentPrefill.date : undefined}
          onLog={(amount, date, note, recastMode) => {
            onLogOverpayment(amount, date, note, recastMode)
            setLoggingOverpayment(false)
          }}
          onCancel={() => setLoggingOverpayment(false)}
        />
      )}

      {/* 2026-09-09 followup (Adam-reported) — a real trigger to start a
          NEW recurring overpayment for this loan needs to stay reachable
          from here, same as the one-off log button above; it just no
          longer opens its own inline editor (that's still gone — see the
          comment on the deleted RecurringOverpaymentEditor). Instead it
          hands off to the exact same Overpayments-pill wizard the What-if
          page's "Make this a real recurring overpayment" button already
          uses, pre-selecting this loan (target only, no amount) so the
          person still picks amount/from/recast/date themselves. */}
      <button
        onClick={() =>
          navigate('/expenses', {
            state: { overpaymentPrefill: { targetKind: 'loan', targetId: loan.id, mode: 'recurring', amount: 0 } },
          })
        }
        className="text-xs font-medium self-start"
        style={{ color: 'var(--color-coral)' }}
      >
        + Log a recurring overpayment
      </button>

      {loan.active ? (
        <>
          <button onClick={() => setSettlingLoan(true)} className="text-xs font-medium self-start" style={{ color: 'var(--color-coral)' }}>
            Settle this loan
          </button>
          {settlingLoan && (
            <SettleLoanModal
              loanName={loan.name}
              estimatedSettlement={estimateSettlementFigure({ ...loan, ...draft })}
              trueOutstandingBalance={previewSummary.remainingBalance}
              onSettle={(amount, date, note) => {
                onSettle(amount, date, note)
                setSettlingLoan(false)
              }}
              onClose={() => setSettlingLoan(false)}
            />
          )}
        </>
      ) : (
        <p className="text-xs text-[var(--color-ink-faint)]">
          Settled for £{formatCurrency(loan.settledAmount ?? 0)}
          {loan.closedDate ? ` on ${loan.closedDate}` : ''}
        </p>
      )}

      {isOpen && (
        <>
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Name" value={draft.name} onChange={(v) => update({ name: v })} />
        <EditField label="Lender (optional)" value={draft.lender ?? ''} onChange={(v) => update({ lender: v || undefined })} />
        <EditField label="Amount borrowed (£)" type="number" value={draft.principal} onChange={(v) => update({ principal: Number(v) })} />
        <EditField label="Interest rate (% APR, optional)" type="number" value={draft.apr ?? ''} onChange={(v) => update({ apr: v ? Number(v) : undefined })} />
        <EditField label="Monthly payment (£)" type="number" value={draft.monthlyPayment} onChange={(v) => update({ monthlyPayment: Number(v) })} />
        <EditField label="Term (months)" type="number" value={draft.termMonths} onChange={(v) => update({ termMonths: Number(v) })} />
        <EditField label="First payment date" type="date" value={draft.startDate} onChange={(v) => update({ startDate: v })} />
        <EditField label="Advance date (optional)" type="date" value={draft.advanceDate ?? ''} onChange={(v) => update({ advanceDate: v || undefined })} />
        {/* Deliberately no mention of WHICH interest convention matched
            anywhere in the app — that's internal plumbing (loan-amortisation
            scope §5.1/§5.5), not something to surface. This is purely a
            status indicator: red + warning icon means the loan is still on
            an uncalibrated estimate and would benefit from real statement
            lines; green means a confident fit already exists. Always
            visible (not hidden once confident) so the affordance to add
            more lines for extra precision never disappears. */}
        <button
          onClick={() => setCalibratingLoan(true)}
          className="flex items-center gap-1.5 text-xs font-medium self-end justify-self-start pb-1"
          style={{ color: isLoanConfidentlyCalibrated(loan) ? 'var(--color-positive)' : 'var(--color-negative)' }}
        >
          {!isLoanConfidentlyCalibrated(loan) && <AlertTriangle size={12} />}
          Calibrate
        </button>
      </div>
      <p className="text-xs text-[var(--color-ink-faint)]">Total payable (nominal): £{formatCurrency(previewSummary.totalPayable)}</p>

      <CategoryPicker categories={categories} value={draft.categoryId} onChange={(categoryId) => update({ categoryId })} onAddCategory={onAddCategory} />

      {/* UAT follow-up (2026-09-05, Adam-reported): used to be gated on
          `hasJointBills || pots.some(p => p.personId === draft.ownerId) ||
          already joint/pot` — for a loan owned by someone with NO pot of
          their own (and no joint bill anywhere yet to unlock Joint),
          that condition was false and this never rendered at all, with
          no way to even reach the Owner field to reassign ownership to
          someone who DOES have a pot. LocationEditor already self-gates
          correctly (renders nothing when truly nothing applies, same as
          Bills.tsx's own unconditional render) — the outer wrapper here
          was redundant AND wrong, since it couldn't see a pot change
          becoming possible after an owner reassignment. */}
      <LocationEditor
        people={people}
        pots={pots}
        canBeJoint={canBeJoint}
        location={draft.location}
        ownerId={draft.ownerId}
        potId={draft.potId}
        payee={draft.payee}
        payeeSharePercent={draft.payeeSharePercent}
        onChange={update}
      />
      {calibratingLoan && (
        <CalibrationModal
          loanName={loan.name}
          existingLinesCount={loan.statementCalibrationLines?.length ?? 0}
          onCalibrate={onCalibrate}
          onCalibrated={onCalibrated}
          onClose={() => setCalibratingLoan(false)}
        />
      )}

      {/* UAT 2026-09-08 (7-bug8.2-confirm-loans note) — picker-first list
          of real upcoming payment dates, replacing the plain "changes
          take effect from" calendar field, matching Bills/Pots.
          Generalised 2026-09-09 to also cover a monthlyPayment change
          (same shared component, same combined-in-one-flow convention
          BillEditPanel uses when amount+location change together). */}
      {changeKind && (
        <EffectiveDatedChangeFlow
          occurrences={recentAndUpcomingLoanPaymentDates(loan, new Date())}
          dateStepDescription={
            changeKind === 'monthlyPayment'
              ? `${loan.name}'s payment is changing from £${formatCurrency(loan.monthlyPayment)} to £${formatCurrency(draft.monthlyPayment)}. Which payment should the new amount start from? Everything before it keeps the old amount.`
              : changeKind === 'startDate'
              ? `${loan.name}'s payment date is changing from the ${ordinalDay(parseLocalDate(loan.startDate).getDate())} to the ${ordinalDay(parseLocalDate(draft.startDate).getDate())}. Which payment should this start from? Everything before it stays as it was.`
              : `${loan.name} is moving to ${loanLocationLabel(draft.location, draft.potId, pots)}. Which payment should this start from? Everything before it — including already-cleared payments — stays where it was.`
          }
          buildChanges={() => {
            const changes: RecurringChangeField[] = []
            if (changeKind === 'monthlyPayment') changes.push({ label: 'Monthly payment', from: `£${formatCurrency(loan.monthlyPayment)}`, to: `£${formatCurrency(draft.monthlyPayment)}` })
            const locationChanged = draft.location !== loan.location || (draft.location === 'pot' && draft.potId !== loan.potId)
            if (locationChanged) changes.push({ label: 'Location', from: loanLocationLabel(loan.location, loan.potId, pots), to: loanLocationLabel(draft.location, draft.potId, pots) })
            if (startDateChanged) changes.push({ label: 'First payment date', from: formatFullDate(loan.startDate), to: formatFullDate(draft.startDate) })
            return changes
          }}
          affectsClearedBalance={(effectiveFrom) => effectiveFrom <= todayIso()}
          onCancelAll={cancelEverything}
          onCommit={(pickedDate) => {
            // A start-date change re-dates stored payments from the picked
            // one AFTER everything else saves, so the plain save keeps the
            // current start date. Its effective-from dates (a monthly payment
            // or location change made in the same save) are recorded against
            // the picked payment and move with it.
            const effectiveFrom = pickedDate
            const toSave = startDateChanged ? { ...draft, startDate: loan.startDate } : draft
            const locationChanged = toSave.location !== loan.location || (toSave.location === 'pot' && toSave.potId !== loan.potId)
            if (changeKind === 'startDate') {
              if (locationChanged) {
                onAssignLocation(toSave.location, effectiveFrom, toSave.location === 'pot' ? toSave.potId : undefined)
                const { location: _l, potId: _p, ...rest } = toSave
                onSave(rest)
              } else {
                onSave(toSave)
              }
            } else if (changeKind === 'monthlyPayment') {
              const paymentPatch = applyLoanMonthlyPaymentChange(loan, toSave.monthlyPayment, effectiveFrom)
              if (locationChanged) {
                const { location: _l, potId: _p, ...rest } = toSave
                onSave({ ...rest, ...paymentPatch })
                onAssignLocation(toSave.location, effectiveFrom, toSave.location === 'pot' ? toSave.potId : undefined)
              } else {
                onSave({ ...toSave, ...paymentPatch })
              }
            } else {
              onAssignLocation(toSave.location, effectiveFrom, toSave.location === 'pot' ? toSave.potId : undefined)
              const { location: _l, potId: _p, ...rest } = toSave
              onSave(rest)
            }
            if (startDateChanged) changeLoanStartDate(loan.id, draft.startDate, pickedDate)
            setChangeKind(null)
          }}
        />
      )}

      <FormButtonRow
        onCancel={onCancel}
        saveDisabled={!dirty}
        onSave={() => {
          const monthlyPaymentChanged = draft.monthlyPayment !== loan.monthlyPayment
          const locationChanged = draft.location !== loan.location || (draft.location === 'pot' && draft.potId !== loan.potId)
          const hasOccurrences = recentAndUpcomingLoanPaymentDates(loan, new Date()).length > 0
          if (monthlyPaymentChanged && hasOccurrences) {
            setChangeKind('monthlyPayment')
            return
          }
          if (startDateChanged && hasOccurrences) {
            setChangeKind('startDate')
            return
          }
          if (locationChanged && hasOccurrences) {
            setChangeKind('location')
            return
          }
          // No occurrences to anchor a date to yet — apply immediately,
          // dated today, same "nothing to pick from" guard Bills.tsx uses.
          if (locationChanged) {
            onAssignLocation(draft.location, todayIso(), draft.location === 'pot' ? draft.potId : undefined)
            const { location: _l, potId: _p, ...rest } = draft
            onSave(rest)
            return
          }
          onSave(draft)
        }}
      />
        </>
      )}
    </div>
  )
}

type CreditCardDraft = Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>

function draftFromCard(card: CreditCard): CreditCardDraft {
  const { id: _id, lumpPayments: _lumpPayments, active: _active, ...rest } = card
  return rest
}

function CreditCardEditPanel({
  card,
  storedCard,
  transactions,
  people,
  pots,
  onAssignLocation,
  categories,
  onAddCategory,
  onSave,
  onLogLumpPayment,
  onClearBalance,
  overpaymentPrefill,
  onPrefillConsumed,
  isOpen,
  onCancel,
}: {
  card: CreditCard // live — used for the derived-balance caption only
  storedCard: CreditCard // as persisted — what the draft is seeded from and saved back to
  transactions: Transaction[]
  people: { id: string; name: string }[]
  pots: Pot[]
  /** 2026-09-16 — where the minimum payment is paid from, from a chosen payment (see CreditCard.location). */
  onAssignLocation: (location: 'personal' | 'pot', effectiveFrom: string, potId?: string) => void
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>>) => void
  onLogLumpPayment: (amount: number, date: string, note?: string) => void
  /** 2026-09-09 session — logs an overpayment for the FULL balance due on
   * that date (not just that date's minimum), dated on it. Moved here
   * from the (now minimum-charges-only) info modal, per Adam's spec. */
  onClearBalance: (date: string, amount: number) => void
  overpaymentPrefill: OverpaymentPrefill | null
  onPrefillConsumed: () => void
  /** UAT 2026-09-08 (6-bug4-cards) — see LoanEditPanel's own comment on
   * the identical prop. */
  isOpen: boolean
  /** UAT 2026-09-08 (7-bug8.2-confirm-loans note) — this fields form had
   * no Cancel at all; collapses the card without saving, matching every
   * other card's edit form. */
  onCancel: () => void
}) {
  // Seeded from the STORED card, never the live one. This distinction is
  // the whole point of the fix: the editable field is the stated anchor,
  // so re-saving it is idempotent. Seeding from the live balance instead
  // would re-anchor the card to a figure that already includes logged
  // payments, and the replay would then subtract them a second time.
  const [draft, setDraft] = useState<CreditCardDraft>(() => draftFromCard(storedCard))
  // UAT follow-up (2026-09-04, Adam-requested app-wide sweep): same dirty
  // gate as LoanEditPanel's own Save button, just below.
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromCard(storedCard))
  // Matches LoanEditPanel's pattern (loggingOverpayment) — collapsed
  // behind a link by default, same as the loan's own "+ Log an
  // overpayment," confirmed as a real inconsistency otherwise: this form
  // was permanently expanded here while the loan equivalent was
  // collapsed, for no functional reason. Still pre-opens when a
  // prefill exists (e.g. from a What-if payoff scenario), same as loans.
  const [loggingPayment, setLoggingPayment] = useState(!!overpaymentPrefill)
  // 2026-09-16 — a payment-day change waits for "which payment should this
  // start from". Saving it straight onto the card re-created every past
  // minimum payment on the new day; changeCardPaymentDay re-dates them.
  const { changeCardPaymentDay } = useLedgerData()
  const [choosingPaymentDayFrom, setChoosingPaymentDayFrom] = useState(false)
  const paymentDayOccurrences = recentAndUpcomingCardPaymentDates(storedCard, new Date())
  // 2026-09-16 (Adam-reported) — moving the minimum payment to a pot uses the
  // same "which payment → confirm → save" steps as a loan's location change,
  // and shares the picker with a payment-day change made in the same save.
  const draftLocation = draft.location ?? 'personal'
  const storedLocation = storedCard.location ?? 'personal'
  const locationChanged = draftLocation !== storedLocation || (draftLocation === 'pot' && draft.potId !== storedCard.potId)
  const paymentDayChanged = draft.paymentDayOfMonth !== storedCard.paymentDayOfMonth
  const cardLocationLabel = (location: 'personal' | 'pot', potId: string | undefined) => (location === 'pot' ? pots.find((p) => p.id === potId)?.name ?? 'a pot' : 'Personal')

  /** Everything except the location (and, unless told otherwise, the payment day), which the chosen payment applies. One onSave call: the row collapses on each one. */
  function saveFieldsKeepingSchedule(paymentDayOfMonth = storedCard.paymentDayOfMonth) {
    const { location: _l, potId: _p, locationEffectiveFrom: _e, locationHistory: _h, ...rest } = draft
    onSave({ ...rest, paymentDayOfMonth })
  }

  useEffect(() => {
    if (overpaymentPrefill) onPrefillConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // UAT 2026-09-08 (6-bug4-cards) — see LoanEditPanel's identical comment.
  useEffect(() => {
    if (!isOpen) setDraft(draftFromCard(storedCard))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  function update(patch: Partial<CreditCardDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      {/* Batch 6 (2026-09-07 UAT): "+ Log a payment" moved above the
          edit-form fields to match Joint Account's card ordering —
          visible immediately on expand, not pushed below the fields grid.
          2026-09-09 session — the past-payments list that used to sit
          here moved to the Transactions page's Transfers tab, same
          reasoning as LoanEditPanel's identical change just above. */}
      {!loggingPayment ? (
        <button onClick={() => setLoggingPayment(true)} className="text-xs font-medium self-start" style={{ color: 'var(--color-coral)' }}>
          + Log a payment
        </button>
      ) : (
        <OverpaymentForm
          label="Log a payment"
          initialAmount={overpaymentPrefill?.amount}
          initialDate={overpaymentPrefill?.date}
          onLog={(amount, date, note) => {
            onLogLumpPayment(amount, date, note)
            setLoggingPayment(false)
          }}
          onCancel={() => setLoggingPayment(false)}
        />
      )}

      {isOpen && (
        <>
      {/* BUGFIX (2026-09-16, Adam-reported): same live-vs-stored confusion as
          CreditCardLedgerModal above — `card` here is the LIVE variant (see this
          component's own prop comment: "used for the derived-balance caption
          only"), and buildCreditCardDueOverviewRows internally re-derives the
          balance from real activity the same way buildCreditCardMinimumChargeRows
          does, so it needs `storedCard` too or it double-counts every
          transaction between the anchor and today — exactly what made "Clear"
          log double the true balance due on an existing card with real
          history. */}
      <CreditCardDueSection card={storedCard} transactions={transactions} onClearBalance={onClearBalance} />

      <div className="grid grid-cols-2 gap-3">
        <EditField label="Name" value={draft.name} onChange={(v) => update({ name: v })} />
        <EditField label="Interest rate (% APR)" type="number" value={draft.interestRatePercent} onChange={(v) => update({ interestRatePercent: Number(v) })} />
        <EditField label="Balance (£)" type="number" value={draft.currentBalance} onChange={(v) => update({ currentBalance: Number(v) })} />
        <EditField label="...as of" type="date" value={draft.balanceAsOfDate} onChange={(v) => update({ balanceAsOfDate: v })} />
        <EditField
          label="Payment day of month"
          type="number"
          value={draft.paymentDayOfMonth}
          onChange={(v) => update({ paymentDayOfMonth: Math.max(1, Math.min(31, Number(v))) })}
        />
        <EditField
          label="Statement opens (day, optional)"
          type="number"
          value={draft.statementStartDay ?? ''}
          onChange={(v) => update({ statementStartDay: v === '' ? undefined : Math.max(1, Math.min(31, Number(v))) })}
        />
        <EditField
          label="Statement closes (day, optional)"
          type="number"
          value={draft.statementEndDay ?? ''}
          onChange={(v) => update({ statementEndDay: v === '' ? undefined : Math.max(1, Math.min(31, Number(v))) })}
        />
      </div>

      {/* PROMPT-01 A1 (2026-09-16, Adam-specified: "Prompt the user, but
          default to paymentDayOfMonth") — a card with no statement window
          has spend counting toward its VERY NEXT payment date, with no lag:
          buy something on the 10th and it is due on the 14th. Most real
          cards do not work that way, and neither of Adam's mum's cards has
          a window because both predate the feature.

          OFFERED, NEVER APPLIED SILENTLY. Setting a window on an existing
          card retroactively moves still-pending spend between cycles, so it
          has to be the user's own deliberate action — hence a button she
          presses, pre-filled with the default, and not a migration. Already
          cleared rows never move (APP-KNOWLEDGE.md §1.1), which is what the
          note below tells her.

          This is a convenience, not a correctness fix: since the Part A
          root fix, a card with no window reconciles perfectly well without
          one. */}
      {draft.statementEndDay == null && draft.statementStartDay == null && (
        <div className="rounded-xl p-3 -mt-1" style={{ background: 'var(--color-bg-elevated)' }}>
          <p className="text-xs text-[var(--color-ink-muted)] mb-2">
            No statement window set, so spend counts toward your very next payment date — something bought on the{' '}
            {ordinalDay(Math.max(1, Number(draft.paymentDayOfMonth) - 4))} is due on the {ordinalDay(Number(draft.paymentDayOfMonth))}. Most cards give you a
            statement period instead.
          </p>
          <button
            type="button"
            onClick={() => update(defaultStatementWindowForPaymentDay(Number(draft.paymentDayOfMonth)))}
            className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg text-white"
            style={{ background: 'var(--color-coral)' }}
          >
            Use the {ordinalDay(defaultStatementWindowForPaymentDay(Number(draft.paymentDayOfMonth)).statementStartDay)}–
            {ordinalDay(defaultStatementWindowForPaymentDay(Number(draft.paymentDayOfMonth)).statementEndDay)}
          </button>
          <p className="text-[11px] text-[var(--color-ink-faint)] mt-2">
            This moves upcoming spend into the cycle its statement belongs to. Payments you have already made stay exactly where they are.
          </p>
        </div>
      )}

      {/* item e — a spend after this window's close doesn't count toward
          the minimum due for the window that already closed; it rolls
          into the NEXT one instead. Only shown once statementEndDay is
          actually set, since the feature is otherwise entirely inert. */}
      {draft.statementEndDay != null && (
        <p className="text-xs text-[var(--color-ink-faint)] -mt-1">
          Statement window{draft.statementStartDay != null ? ` ${ordinalDay(draft.statementStartDay)}–` : ' closing '}
          {ordinalDay(draft.statementEndDay)} — spend after the {ordinalDay(draft.statementEndDay)} counts toward the
          following window's minimum payment, not this one's, even though it still shows in the balance above straight away.
        </p>
      )}

      {/* Same statement-date idea as the Salary page's opening balance:
          the figure above is what the card owed on that date, and
          anything logged since is applied on top. Spelling out the
          derived total here is what makes the two numbers legible as
          "statement" vs "now" rather than looking like a contradiction. */}
      <p className="text-xs text-[var(--color-ink-faint)] -mt-1">
        {card.currentBalance === draft.currentBalance && draft.balanceAsOfDate === storedCard.balanceAsOfDate
          ? 'Nothing logged against this card since that date.'
          : `£${formatCurrency(cardBalanceAsOf({ ...storedCard, ...draft }, transactions))} owed today, after activity logged since that date.`}
      </p>

      <MinimumPaymentEditor value={draft.minimumPayment} onChange={(minimumPayment) => update({ minimumPayment })} />

      {/* Freely reassignable, same as a loan's — this only changes the
          card's own icon/colour identity everywhere it's shown (its row
          here, the pie-chart centre on Home). Every credit-card
          transaction still always folds into the fixed "Credit Card"
          bucket in the Home page's "group by category" view regardless
          of what's picked here — see groupingCategoryId in Home.tsx. */}
      <CategoryPicker categories={categories} value={draft.categoryId} onChange={(categoryId) => update({ categoryId })} onAddCategory={onAddCategory} />

      {/* 2026-09-16 (Adam-reported) — "Location" (Personal or one of the
          owner's pots) for the minimum payment, the same flat list a loan
          uses. No Joint for a card. LocationEditor also renders the Owner
          field this form used to draw itself, and hides itself when there's
          nothing to choose. */}
      <LocationEditor
        people={people}
        pots={pots}
        canBeJoint={false}
        location={draftLocation}
        ownerId={draft.ownerId}
        potId={draft.potId}
        payee=""
        payeeSharePercent={100}
        onChange={(patch) =>
          update({
            location: patch.location === 'pot' ? 'pot' : 'personal',
            potId: patch.location === 'pot' ? patch.potId : undefined,
            ...(patch.ownerId ? { ownerId: patch.ownerId } : {}),
          })
        }
      />

      {choosingPaymentDayFrom && (
        <EffectiveDatedChangeFlow
          occurrences={paymentDayOccurrences}
          dateStepDescription={
            paymentDayChanged
              ? `${storedCard.name}'s payment day is changing from the ${ordinalDay(storedCard.paymentDayOfMonth)} to the ${ordinalDay(draft.paymentDayOfMonth)}. Which payment should this start from? Everything before it stays as it was.`
              : `${storedCard.name}'s minimum payment is moving to ${cardLocationLabel(draftLocation, draft.potId)}. Which payment should this start from? Everything before it — including already-cleared payments — stays where it was.`
          }
          buildChanges={() => [
            ...(paymentDayChanged ? [{ label: 'Payment day', from: `The ${ordinalDay(storedCard.paymentDayOfMonth)}`, to: `The ${ordinalDay(draft.paymentDayOfMonth)}` }] : []),
            ...(locationChanged ? [{ label: 'Minimum payment paid from', from: cardLocationLabel(storedLocation, storedCard.potId), to: cardLocationLabel(draftLocation, draft.potId) }] : []),
          ]}
          affectsClearedBalance={(effectiveFrom) => effectiveFrom <= todayIso()}
          onCancelAll={() => {
            setChoosingPaymentDayFrom(false)
            onCancel()
          }}
          onCommit={(pickedDate) => {
            // Everything else first, keeping the current payment day and
            // location. The location rewrite runs before the re-date, so
            // payments it moves are re-dated with everything else.
            saveFieldsKeepingSchedule()
            if (locationChanged) onAssignLocation(draftLocation, pickedDate, draftLocation === 'pot' ? draft.potId : undefined)
            if (paymentDayChanged) changeCardPaymentDay(storedCard.id, draft.paymentDayOfMonth, pickedDate)
            setChoosingPaymentDayFrom(false)
          }}
        />
      )}
      <FormButtonRow
        onCancel={onCancel}
        onSave={() => {
          if ((paymentDayChanged || locationChanged) && paymentDayOccurrences.length > 0) {
            setChoosingPaymentDayFrom(true)
            return
          }
          if (locationChanged) {
            // Nothing to anchor to yet: apply from today, as a loan does.
            saveFieldsKeepingSchedule(draft.paymentDayOfMonth)
            onAssignLocation(draftLocation, todayIso(), draftLocation === 'pot' ? draft.potId : undefined)
            return
          }
          onSave(draft)
        }}
        saveDisabled={!dirty}
      />
        </>
      )}
    </div>
  )
}

/**
 * "Payment due" (2026-09-09 session, Adam-specified) — the most recent
 * plus next 3 upcoming (or next 4 if there's no recent one) payment due
 * dates and their balance due, styled after the Salary page's
 * PayPeriodsSection ("Most recent pay" / "Upcoming pay"). No tap-to-
 * expand — this is a plain read-only overview — the one interactive bit
 * carried over is the same Clear button the (now minimum-charges-only)
 * info modal used to show on a balance-due row.
 */
function CreditCardDueSection({
  card,
  transactions,
  onClearBalance,
}: {
  card: CreditCard
  transactions: Transaction[]
  onClearBalance: (date: string, amount: number) => void
}) {
  const rows = buildCreditCardDueOverviewRows(card, transactions)
  // PROMPT-01 Part C — a 100%-minimum card clears itself, so it gets a
  // read-only indication instead of a Clear button (see
  // creditCardMinimumClearsFullBalance).
  const autoClears = creditCardMinimumClearsFullBalance(card)
  const past = rows.filter((r) => r.isPast)
  const mostRecent = past.length > 0 ? past[past.length - 1] : null
  const upcoming = rows.filter((r) => !r.isPast).slice(0, mostRecent ? 3 : 4)
  // 2026-09-09 followup (Adam-requested) — Clear used to fire straight
  // off the tap; now it stages the row here first so the confirm modal
  // below can show what it's about to do, matching every other
  // consequential action in the app (Settle, Delete, etc.) rather than
  // being the one silent exception.
  const [confirming, setConfirming] = useState<{ date: string; balanceDue: number } | null>(null)

  if (!mostRecent && upcoming.length === 0) return null

  return (
    <div className="mb-1">
      {mostRecent && (
        <>
          <h4 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-2">Most recent due</h4>
          <div className="flex flex-col gap-2 mb-3">
            <CreditCardDueRow row={mostRecent} autoClears={autoClears} onRequestClear={setConfirming} />
          </div>
        </>
      )}
      {upcoming.length > 0 && (
        <>
          <h4 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-2">Upcoming due</h4>
          <div className="flex flex-col gap-2 mb-3">
            {upcoming.map((row) => (
              <CreditCardDueRow key={row.date} row={row} autoClears={autoClears} onRequestClear={setConfirming} />
            ))}
          </div>
        </>
      )}
      {confirming && (
        <ConfirmModal
          title="Clear this balance?"
          description={`Pays off the full £${formatCurrency(confirming.balanceDue)} owed as of ${confirming.date} in one go, dated on it — this zeroes off every minimum charge up to and including that date, and stops any further ones compounding against it.`}
          confirmLabel="Save"
          cancelLabel="Cancel"
          onConfirm={() => {
            onClearBalance(confirming.date, confirming.balanceDue)
            setConfirming(null)
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}

function CreditCardDueRow({
  row,
  autoClears,
  onRequestClear,
}: {
  row: { date: string; balanceDue: number; isPast: boolean }
  /** PROMPT-01 Part C — this card's minimum is 100% of the balance, so the
   * charge on this date clears it in full on its own. Adam, 2026-09-15:
   * "Row is untappable, wording is 'Set to Clear'." Rendered as static
   * text, NOT a disabled button: a disabled button still reads as a
   * control that is unavailable, when the truth is that nothing needs
   * doing. A fixed minimum that merely happens to cover this month's
   * balance is deliberately NOT included — see the predicate's comment. */
  autoClears: boolean
  onRequestClear: (row: { date: string; balanceDue: number }) => void
}) {
  return (
    <div className="rounded-xl p-3 flex items-center justify-between gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="min-w-0">
        <p className="text-sm text-[var(--color-ink)]">{row.date}</p>
        {/* 2026-09-16 (Adam-reported from UAT) — every row now reports what was
            owed GOING INTO its due date, so a past and an upcoming row can
            legitimately show the same figure when nothing moved between them.
            Saying "balance due" on a date that has already been paid reads as
            a stale duplicate, so a past row says explicitly which side of the
            payment its figure sits on. */}
        <p className="text-xs text-[var(--color-ink-muted)]">
          £{formatCurrency(row.balanceDue)} {row.isPast ? 'was due before payment' : 'balance due'}
        </p>
      </div>
      {!row.isPast &&
        (autoClears ? (
          <span className="text-[10px] font-semibold px-2 py-1 rounded-lg shrink-0" style={{ background: 'var(--color-track)', color: 'var(--color-ink-muted)' }}>
            Set to Clear
          </span>
        ) : (
          <button
            onClick={() => onRequestClear({ date: row.date, balanceDue: row.balanceDue })}
            className="text-[10px] font-semibold px-2 py-1 rounded-lg text-white shrink-0"
            style={{ background: 'var(--color-coral)' }}
          >
            Clear
          </button>
        ))}
    </div>
  )
}

// ── Overpayment / lump-payment logging — shared shape for both loans and credit cards ──

/**
 * Read-only, scrollable, date-ascending record of every dated event on
 * this loan (scope §10) — reached from the info icon on the loan's own
 * card on THIS page (deliberately, not the Home page's pie card, which
 * is where the scope doc originally placed it). A finish-date banner up
 * top is computed live from the real schedule (loanFinishInfo), and each
 * row is one dated event, not one period — a period with both a regular
 * payment and an overpayment is two rows, keeping the three payment
 * types visually distinguishable per scope's explicit requirement.
 */
function LoanLedgerModal({ loan, onClose }: { loan: Loan; onClose: () => void }) {
  const rows = buildLoanLedgerRows(loan)
  const finish = loanFinishInfo(loan)

  const finishLabel = finish.settledEarly
    ? `Settled${finish.finishDate ? ` ${finish.finishDate}` : ''}`
    : finish.finishDate
      ? `Finishes: ${formatMonthYear(finish.finishDate)}${finish.monthsEarly > 0 ? ` (${finish.monthsEarly} month${finish.monthsEarly === 1 ? '' : 's'} early due to overpayments)` : ''}`
      : 'No schedule yet'

  const typeStyles: Record<LoanLedgerRowType, { label: string; color: string }> = {
    'Monthly Repayment': { label: 'Monthly', color: 'var(--color-ink-muted)' },
    'Ad-hoc Overpayment': { label: 'Ad-hoc overpayment', color: 'var(--color-coral)' },
    'Recurring Overpayment': { label: 'Recurring overpayment', color: 'var(--color-coral)' },
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] flex flex-col"
        style={{
          background: 'var(--color-surface)',
          paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{loan.name}</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>

        <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--color-bg-elevated)' }}>
          <p className="text-sm font-medium text-[var(--color-ink)]">{finishLabel}</p>
        </div>

        <div className="overflow-y-auto flex-1 -mx-5 px-5">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-ink-faint)]" style={{ borderBottom: '1px solid var(--color-track)' }}>
                <th className="py-1.5 font-medium">Date</th>
                <th className="py-1.5 font-medium text-right">Amount</th>
                <th className="py-1.5 font-medium text-right">Capital</th>
                <th className="py-1.5 font-medium text-right">Interest</th>
                <th className="py-1.5 font-medium text-right">Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--color-track)' }}>
                  <td className="py-1.5 text-[var(--color-ink)] whitespace-nowrap">{row.date}</td>
                  <td className="py-1.5 text-right text-[var(--color-ink)]">£{formatCurrency(row.amount)}</td>
                  <td className="py-1.5 text-right text-[var(--color-ink-muted)]">£{formatCurrency(row.capital)}</td>
                  <td className="py-1.5 text-right text-[var(--color-ink-muted)]">£{formatCurrency(row.interest)}</td>
                  <td className="py-1.5 text-right whitespace-nowrap" style={{ color: typeStyles[row.type].color }}>
                    {typeStyles[row.type].label}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-[var(--color-ink-faint)]">
                    No schedule yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Credit card equivalent of LoanLedgerModal (bug report: "replicate the
 * same modal used for loan ledgers for credit cards") — but deliberately
 * narrower in scope and different in one key way, per the explicit
 * request: ONLY minimum-charge rows (spend and lump payments already
 * have a full ledger on the card's own Home page detail view, so
 * duplicating them here would just be clutter), and rows are tappable —
 * tapping one turns it into an inline amount editor rather than being
 * purely read-only like the loan version. Works for both past
 * (materialized) and future (still-projected) rows transparently — see
 * updateCreditCardMinimumCharge's own comment for how the two cases
 * resolve differently under the hood.
 */
function CreditCardLedgerModal({
  card,
  transactions,
  onUpdateMinimumCharge,
  onClose,
}: {
  card: CreditCard
  transactions: Transaction[]
  onUpdateMinimumCharge: (date: string, amount: number) => void
  onClose: () => void
}) {
  // 2026-09-09 session (Adam-specified) — this modal is now minimum
  // charges ONLY. The balance-due-per-date row + Clear button that used
  // to live here moved to the expanded credit card section on the
  // Borrowing page (see CreditCardEditPanel's "Payment due" block below),
  // styled like the Salary page's most-recent/upcoming list instead of a
  // scrollable modal row.
  const rows = buildCreditCardMinimumChargeRows(card, transactions)
  const autoClears = creditCardMinimumClearsFullBalance(card)
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  function startEditing(row: { date: string; amount: number }) {
    setEditingDate(row.date)
    setEditValue(String(row.amount))
  }

  function commitEdit() {
    if (editingDate && Number(editValue) >= 0) onUpdateMinimumCharge(editingDate, Number(editValue))
    setEditingDate(null)
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] flex flex-col"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{card.name} — minimum charges</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>
        {/* PROMPT-01 Part C — a 100%-minimum card has no adjustable rows
            (an override would be immediately superseded by the 100% rule),
            so it must not invite a tap that does nothing. */}
        <p className="text-xs text-[var(--color-ink-muted)] mb-3">
          {autoClears
            ? "Clears automatically — your minimum payment is 100% of the balance. Spend and other card activity are on the card's own page."
            : "Tap a minimum charge to adjust it — past or future. Spend and other card activity are on the card's own page."}
        </p>

        <div className="overflow-y-auto flex-1 -mx-5 px-5 flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
          {rows.map((row) => {
            // PROMPT-01 Part C — the row's content is identical either way;
            // only whether it is a tap target differs.
            const rowBody = (
              <>
                <span className="text-xs text-[var(--color-ink)]">
                  {row.date} · Minimum charge
                  {row.status === 'pending' && <span className="text-[var(--color-ink-faint)]"> · Upcoming</span>}
                  {autoClears && row.status === 'pending' && <span className="text-[var(--color-ink-faint)]"> · Set to Clear</span>}
                </span>
                <span className="text-xs font-mono text-[var(--color-ink)]">£{formatCurrency(row.amount)}</span>
              </>
            )
            return (
              <div key={row.date} className="flex flex-col">
                {editingDate === row.date ? (
                  <div className="py-2 flex items-center gap-2">
                    <span className="text-xs text-[var(--color-ink-muted)] flex-1">{row.date} · Minimum charge</span>
                    <input
                      type="number"
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="w-24 bg-transparent border-b border-[var(--color-track)] py-1 text-right text-[var(--color-ink)] outline-none font-mono"
                    />
                    <button onClick={commitEdit} className="text-xs font-semibold px-2 py-1 rounded-lg text-white" style={{ background: 'var(--color-coral)' }}>
                      Save
                    </button>
                    <button onClick={() => setEditingDate(null)} className="text-xs text-[var(--color-ink-muted)]">
                      Cancel
                    </button>
                  </div>
                ) : (
                  // Part C — untappable by construction for a 100% card: a
                  // plain div, so there is no tap target and no override
                  // entry point on the row at all.
                  autoClears ? (
                    <div className="py-2 flex items-center justify-between text-left">{rowBody}</div>
                  ) : (
                    <button onClick={() => startEditing(row)} className="py-2 flex items-center justify-between text-left">
                      {rowBody}
                    </button>
                  )
                )}
              </div>
            )
          })}
          {rows.length === 0 && <p className="py-4 text-center text-xs text-[var(--color-ink-faint)]">No minimum charges yet.</p>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function SettleLoanModal({
  loanName,
  estimatedSettlement,
  trueOutstandingBalance,
  onSettle,
  onClose,
}: {
  loanName: string
  estimatedSettlement: number
  trueOutstandingBalance: number
  onSettle: (amount: number, date: string, note?: string) => void
  onClose: () => void
}) {
  const [amount, setAmount] = useState(estimatedSettlement > 0 ? String(estimatedSettlement) : '')
  const [date, setDate] = useState(todayIso())
  const [note, setNote] = useState('')
  const amountNumber = Number(amount)
  const canSave = amountNumber > 0 && date

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{
          background: 'var(--color-surface)',
          paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Settle this loan</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>

        <p className="text-xs text-[var(--color-ink-muted)] mb-4 leading-relaxed">
          Log the real amount actually paid to close {loanName} early — this may differ from the estimate below.
          Saving zeroes off the loan's balance and marks it settled, regardless of what its schedule predicted.
        </p>

        <div className="rounded-xl p-3 mb-4 flex flex-col gap-1" style={{ background: 'var(--color-bg-elevated)' }}>
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--color-ink-muted)]">True outstanding balance</span>
            <span className="text-[var(--color-ink)] font-medium">£{formatCurrency(trueOutstandingBalance)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--color-ink-muted)]">Estimated settlement figure</span>
            <span className="text-[var(--color-ink)] font-medium">£{formatCurrency(estimatedSettlement)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <EditField label="Amount actually paid (£)" type="number" value={amount} onChange={setAmount} />
          <EditField label="Date" type="date" value={date} onChange={setDate} />
          <EditField label="Note (optional)" value={note} onChange={setNote} />
        </div>

        <button
          disabled={!canSave}
          onClick={() => onSettle(amountNumber, date, note || undefined)}
          className="w-full mt-5 py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Save
        </button>
      </div>
    </div>,
    document.body,
  )
}

function CalibrationModal({
  loanName,
  existingLinesCount,
  onCalibrate,
  onClose,
  onCalibrated,
}: {
  loanName: string
  existingLinesCount: number
  onCalibrate: (lines: StatementCalibrationLine[]) => CalibrationResult | null
  onClose: () => void
  /** Batch 9 (2026-09-07, Bug 11) — fired when the modal closes AFTER a
   * real calibration attempt (confident match or not — the statement
   * lines themselves are saved either way), so the caller can flash
   * "Calibration saved" on the loan card. NOT fired by the X button
   * closing the modal before ever submitting anything. */
  onCalibrated?: () => void
}) {
  const [rows, setRows] = useState<{ date: string; capital: string; interest: string }[]>([{ date: todayIso(), capital: '', interest: '' }])
  const [result, setResult] = useState<CalibrationResult | null>(null)

  const canAddRow = existingLinesCount + rows.length < MAX_CALIBRATION_LINES
  const validRows = rows.filter((r) => r.date && Number(r.capital) > 0 && Number(r.interest) >= 0)
  const canSubmit = rows.length > 0 && validRows.length === rows.length

  function submit() {
    const lines: StatementCalibrationLine[] = rows.map((r) => ({ date: r.date, capital: Number(r.capital), interest: Number(r.interest) }))
    setResult(onCalibrate(lines))
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{
          background: 'var(--color-surface)',
          paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Calibrate interest</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>

        {!result ? (
          <>
            <p className="text-xs text-[var(--color-ink-muted)] mb-4 leading-relaxed">
              Enter real statement lines for {loanName} — the date, capital, and interest shown on each real payment. 2-3 is usually enough; up to{' '}
              {MAX_CALIBRATION_LINES} in total including any already saved against this loan.
            </p>
            <div className="flex flex-col gap-3">
              {rows.map((row, i) => (
                <div key={i} className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
                  <div className="grid grid-cols-3 gap-2 items-start">
                    <EditField label="Date" type="date" value={row.date} onChange={(v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, date: v } : r)))} />
                    <EditField label="Capital (£)" type="number" value={row.capital} onChange={(v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, capital: v } : r)))} />
                    <EditField label="Interest (£)" type="number" value={row.interest} onChange={(v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, interest: v } : r)))} />
                  </div>
                  {rows.length > 1 && (
                    <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-xs self-start" style={{ color: 'var(--color-negative)' }}>
                      Remove line
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canAddRow && (
              <button
                onClick={() => setRows((rs) => [...rs, { date: todayIso(), capital: '', interest: '' }])}
                className="text-xs font-medium self-start mt-3"
                style={{ color: 'var(--color-coral)' }}
              >
                + Add another line
              </button>
            )}
            <button
              disabled={!canSubmit}
              onClick={submit}
              className="w-full mt-5 py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: 'var(--color-coral)' }}
            >
              Calibrate
            </button>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            {result.confidence === 'confident' ? (
              <p className="text-sm text-[var(--color-ink)] leading-relaxed">This loan's real statements matched a known interest pattern — its schedule now uses it.</p>
            ) : (
              <p className="text-sm leading-relaxed" style={{ color: 'var(--color-coral)' }}>
                {result.message}
              </p>
            )}
            {/* No convention name surfaced here or anywhere else in the app —
                which of the growable library's candidates matched is
                internal plumbing, not something to show. Just whether
                calibration succeeded (via the message above) and, on the
                loan card itself, a colour-coded status (see LoanEditPanel). */}
            {result.confidence !== 'confident' && existingLinesCount + rows.length < MAX_CALIBRATION_LINES && (
              <button
                onClick={() => {
                  setResult(null)
                  setRows([{ date: todayIso(), capital: '', interest: '' }])
                }}
                className="text-xs font-medium self-start"
                style={{ color: 'var(--color-coral)' }}
              >
                + Add more lines
              </button>
            )}
            <button
              onClick={() => {
                onCalibrated?.()
                onClose()
              }}
              className="w-full mt-2 py-2.5 rounded-full text-sm font-semibold text-white"
              style={{ background: 'var(--color-coral)' }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * The loan-specific one-off overpayment flow (D7's follow-up step,
 * loan-amortisation-engine scope §9/§11.3) — a genuinely separate
 * component from the shared OverpaymentForm below rather than an
 * optional prop on it, since OverpaymentForm is also used for credit
 * card lump payments, which have no recast concept at all. After
 * amount/date/note are entered, this shows a follow-up step (not an
 * inline choice) with both recast options as buttons, each carrying its
 * own real preview computed via previewOverpaymentRecast — "keep the
 * same length" shows the new monthly payment that choice would produce,
 * "keep monthly payment the same" shows the new finish date and
 * estimated final repayment.
 */
function LoanOverpaymentForm({
  loan,
  initialAmount,
  initialDate,
  onLog,
  onCancel,
}: {
  loan: Loan
  initialAmount?: number
  initialDate?: string
  onLog: (amount: number, date: string, note: string | undefined, recastMode: 'reduce_term' | 'reduce_payment') => void
  // UAT follow-up (2026-09-08) — same Batch 8/Bug 9.3 fix already applied
  // to the credit card's OverpaymentForm, extended to this loan
  // equivalent: no way to cancel out of logging an overpayment, and a
  // bespoke small right-aligned "Continue" button instead of the shared
  // Save/Cancel pair used everywhere else in the app.
  onCancel: () => void
}) {
  const [amount, setAmount] = useState(initialAmount != null ? String(initialAmount) : '')
  const [date, setDate] = useState(initialDate ?? todayIso())
  const [note, setNote] = useState('')
  const [step, setStep] = useState<'entry' | 'choose'>('entry')
  const amountNumber = Number(amount)
  const canContinue = amountNumber > 0 && date

  function commit(recastMode: 'reduce_term' | 'reduce_payment') {
    onLog(amountNumber, date, note || undefined, recastMode)
    setAmount('')
    setNote('')
    setStep('entry')
  }

  if (step === 'choose') {
    const preview = previewOverpaymentRecast(loan, amountNumber, date)
    return (
      <div className="rounded-xl p-3 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <span className="text-xs font-medium text-[var(--color-ink)]">How should this overpayment be applied?</span>
        <button onClick={() => commit('reduce_payment')} className="rounded-lg p-3 text-left" style={{ background: 'var(--color-surface)' }}>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Keep the same length</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            New monthly payment: £{preview.reducePayment.newMonthlyPayment != null ? formatCurrency(preview.reducePayment.newMonthlyPayment) : '—'}
          </p>
        </button>
        <button onClick={() => commit('reduce_term')} className="rounded-lg p-3 text-left" style={{ background: 'var(--color-surface)' }}>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Keep monthly payment the same</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            Ends {preview.reduceTerm.payoffDate ? formatMonthYear(preview.reduceTerm.payoffDate) : '—'} · estimated final repayment £
            {preview.reduceTerm.finalPayment != null ? formatCurrency(preview.reduceTerm.finalPayment) : '—'}
          </p>
        </button>
        <button onClick={() => setStep('entry')} className="text-xs self-start" style={{ color: 'var(--color-ink-muted)' }}>
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <span className="text-xs font-medium text-[var(--color-ink)]">Log an overpayment</span>
      <div className="grid grid-cols-2 gap-2">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" value={note} onChange={setNote} />
      <FormButtonRow onCancel={onCancel} onSave={() => setStep('choose')} saveDisabled={!canContinue} saveLabel="Continue" />
    </div>
  )
}

function OverpaymentForm({
  label = 'Log an overpayment',
  initialAmount,
  initialDate,
  onLog,
  onCancel,
}: {
  label?: string
  initialAmount?: number
  initialDate?: string
  onLog: (amount: number, date: string, note?: string) => void
  // Batch 8 (2026-09-07, Bug 9.3, Adam-reported) — this form used to have
  // no way to cancel out of it at all, and its own small right-aligned
  // "Log" button didn't match the Save/Cancel pair used everywhere else
  // in the app. Optional only because a caller mid-migration could omit
  // it, but every current call site supplies one.
  onCancel?: () => void
}) {
  const [amount, setAmount] = useState(initialAmount != null ? String(initialAmount) : '')
  const [date, setDate] = useState(initialDate ?? todayIso())
  const [note, setNote] = useState('')
  const amountNumber = Number(amount)

  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <span className="text-xs font-medium text-[var(--color-ink)]">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" value={note} onChange={setNote} />
      <FormButtonRow
        onCancel={onCancel ?? (() => {})}
        onSave={() => {
          onLog(amountNumber, date, note || undefined)
          setAmount('')
          setNote('')
        }}
        saveDisabled={!(amountNumber > 0 && date)}
        saveLabel="Log"
      />
    </div>
  )
}

// ── Logged payments — a one-off overpayment/lump payment listed
// individually with edit/delete, not just a rolled-up summary total.
// Shared between credit card lump payments and loan overpayments — both
// are the same {id, date, amount, note?} shape. Credit card editing is
// reverse-then-relog under the hood (see LedgerContext) so it correctly
// reverses an already-cleared payment's balance effect before reapplying
// the new values; loan overpayments don't need that step since a loan's
// balance is always derived fresh from its schedule, never stored. ──

// 2026-09-09 followup (Adam-reported) — the list/edit UI that used to
// live here (LoggedPaymentList/LoggedPaymentEditForm) moved to
// Expenses.tsx as OverpaymentRowItem/OverpaymentEditForm, styled to match
// the rest of the Transactions page (swipe-to-delete) instead of this
// page's own grouped-card-with-inline-Delete pattern. The shape stays
// here since both loan overpayments and credit-card lump payments are
// this exact {id, date, amount, note?} shape.
export type LoggedPayment = { id: string; date: string; amount: number; note?: string }

function MinimumPaymentEditor({ value, onChange }: { value: CreditCardMinimumPayment; onChange: (v: CreditCardMinimumPayment) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-[var(--color-ink-muted)]">Minimum payment</span>
      <div className="flex gap-2">
        <button
          onClick={() => onChange({ type: 'fixed', amount: value.type === 'fixed' ? value.amount : 25 })}
          className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{ background: value.type === 'fixed' ? 'var(--color-coral)' : 'var(--color-surface)', color: value.type === 'fixed' ? '#fff' : 'var(--color-ink-muted)' }}
        >
          Fixed amount
        </button>
        <button
          onClick={() => onChange({ type: 'percent_of_balance', percent: value.type === 'percent_of_balance' ? value.percent : 5 })}
          className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{
            background: value.type === 'percent_of_balance' ? 'var(--color-coral)' : 'var(--color-surface)',
            color: value.type === 'percent_of_balance' ? '#fff' : 'var(--color-ink-muted)',
          }}
        >
          % of balance
        </button>
      </div>
      {value.type === 'fixed' ? (
        <EditField label="Amount (£)" type="number" value={value.amount} onChange={(v) => onChange({ type: 'fixed', amount: Number(v) })} />
      ) : (
        <EditField label="Percent (%)" type="number" value={value.percent} onChange={(v) => onChange({ type: 'percent_of_balance', percent: Number(v) })} />
      )}
    </div>
  )
}

// ── New loan form ──

function LoanForm({
  people,
  pots,
  categories,
  defaultOwnerId,
  defaultLocation,
  defaultPotId,
  initial,
  hasJointBills,
  canBeJoint,
  existingLoans,
  onAddCategory,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  pots: Pot[]
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultOwnerId: string
  defaultLocation: BillLocation
  defaultPotId?: string
  initial?: LoanPrefill
  hasJointBills: boolean
  canBeJoint: boolean
  existingLoans: Loan[]
  onAddCategory: (name: string) => { id: string }
  // `color` is excluded deliberately: the hero-card colour is picked by the
  // CALLER, which has the whole AppDataV2 needed to scan what's already in
  // use (pickNextSharedCardColor). Same split as the credit card / pot /
  // savings pot creation paths.
  onSave: (loan: Omit<Loan, 'id' | 'overpayments' | 'color'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [principal, setPrincipal] = useState(initial?.principal ? String(initial.principal) : '')
  const [monthlyPayment, setMonthlyPayment] = useState(initial?.monthlyPayment ? String(initial.monthlyPayment) : '')
  // Tracks whether monthlyPayment holds a value the PERSON typed, as
  // distinct from one the auto-suggest effect below wrote on their
  // behalf — confirmed as a real, serious bug without this distinction:
  // `monthlyPayment.trim() !== ''` alone can't tell "the person typed
  // this" apart from "the effect itself already wrote something here a
  // moment ago," so the very first keystroke of a multi-digit APR (e.g.
  // typing "8" of "8.7") would trigger one correct suggestion, then every
  // subsequent keystroke ("8.", "8.7") would see monthlyPayment already
  // non-empty and silently stop updating — leaving a stale, WRONG figure
  // sitting in the field looking exactly as filled-in as a correct one,
  // with nothing suggesting it hadn't kept up with the rest of what was
  // typed. Confirmed live: typing "8.7" character-by-character left the
  // suggestion frozen at the value for "8" alone, £3+ short of correct.
  const [monthlyPaymentTouched, setMonthlyPaymentTouched] = useState(!!initial?.monthlyPayment)
  const [termMonths, setTermMonths] = useState(initial?.termMonths ? String(initial.termMonths) : '')
  const [apr, setApr] = useState('')
  const [startDate, setStartDate] = useState(initial?.startDate ?? todayIso())
  const [advanceDate, setAdvanceDate] = useState(initial?.advanceDate ?? '')
  const [lender, setLender] = useState('')
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? (categories.some((c) => c.id === DEFAULT_LOAN_CATEGORY_ID) ? DEFAULT_LOAN_CATEGORY_ID : categories[0]?.id ?? ''))
  const [location, setLocation] = useState<BillLocation>(initial?.location ?? defaultLocation)
  const [ownerId, setOwnerId] = useState(initial?.ownerId || defaultOwnerId)
  const [potId, setPotId] = useState<string | undefined>(initial?.potId ?? defaultPotId)
  const [payee, setPayee] = useState(initial?.payee || (people[0]?.id ?? ''))
  const [payeeSharePercent, setPayeeSharePercent] = useState(initial?.payeeSharePercent ?? 50)

  // APR is purely a suggestion source here (Loan.apr's own doc comment
  // explains why the engine itself never reads it back) — as soon as
  // principal/term/APR are all present, suggest a starting monthly
  // payment via the standard formula, but ONLY while the person hasn't
  // typed their own real figure in yet. Once they have, their number
  // wins outright and this stops touching the field at all — nudging a
  // value they've already deliberately overridden would be the wrong
  // kind of "helpful."
  useEffect(() => {
    if (monthlyPaymentTouched) return
    const p = Number(principal)
    const n = Number(termMonths)
    const a = Number(apr)
    if (!(p > 0) || !(n > 0) || !(a > 0)) return
    setMonthlyPayment(standardPayment(p, aprToMonthlyRate(a / 100), n).toFixed(2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal, termMonths, apr, monthlyPaymentTouched])

  // Scope §5.3 step 5: a new loan from a lender that's already been
  // calibrated (or confidently back-solved) on a previous loan offers to
  // reuse that same profile straight away, instead of starting from
  // scratch — applied automatically on save when a match is found, no
  // extra confirmation step needed beyond the note below being visible.
  const matchedProfile = lender.trim() ? findLenderCalibrationProfile(existingLoans, lender) : null

  const canSave = name.trim() && Number(principal) > 0 && Number(monthlyPayment) > 0 && Number(termMonths) > 0 && startDate && categoryId

  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
      <EditField label="Name" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Amount borrowed (£)" type="number" value={principal} onChange={setPrincipal} />
        <EditField label="Interest rate (% APR, optional)" type="number" value={apr} onChange={setApr} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Term (months)" type="number" value={termMonths} onChange={setTermMonths} />
        <EditField
          label="Monthly payment (£)"
          type="number"
          value={monthlyPayment}
          onChange={(v) => {
            setMonthlyPayment(v)
            setMonthlyPaymentTouched(true)
          }}
        />
      </div>
      <p className="text-xs text-[var(--color-ink-faint)] -mt-1">
        {apr && Number(apr) > 0
          ? "Monthly payment is suggested from the APR above — type your real contractual figure over it if it's different."
          : 'Monthly payment is the one figure everything else is built from — your real contractual amount, from the loan agreement.'}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <EditField label="First payment date" type="date" value={startDate} onChange={setStartDate} />
        {/* Optional — falls back to First payment date if never set (ledgerLoans.ts's resolveLoanRateAndConvention). Routinely 3-8 weeks earlier than the first payment; only matters once a day-weighted interest convention is calibrated against this loan, but worth capturing up front since it's rarely known later. */}
        <EditField label="Advance date (optional)" type="date" value={advanceDate} onChange={setAdvanceDate} />
      </div>
      <EditField label="Lender (optional)" value={lender} onChange={setLender} />
      {matchedProfile && (
        <p className="text-xs" style={{ color: 'var(--color-coral)' }}>
          Using the interest calibration already saved for {lender.trim()}.
        </p>
      )}
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />
      {(hasJointBills || location === 'joint' || pots.some((p) => p.personId === ownerId) || location === 'pot') && (
        <LocationEditor
          people={people}
          pots={pots}
          canBeJoint={canBeJoint}
          location={location}
          ownerId={ownerId}
          potId={potId}
          payee={payee}
          payeeSharePercent={payeeSharePercent}
          onChange={(patch) => {
            setLocation(patch.location)
            if (patch.ownerId) setOwnerId(patch.ownerId)
            setPotId(patch.potId)
            if (patch.payee) setPayee(patch.payee)
            if (patch.payeeSharePercent !== undefined) setPayeeSharePercent(patch.payeeSharePercent)
          }}
        />
      )}
      <div className="flex gap-2">
        <CancelButton onClick={onCancel} />
        <SaveButton
          disabled={!canSave}
          onClick={() =>
            onSave({
              name: name.trim(),
              principal: Number(principal),
              monthlyPayment: Number(monthlyPayment),
              termMonths: Number(termMonths),
              apr: apr.trim() ? Number(apr) : undefined,
              startDate,
              advanceDate: advanceDate || undefined,
              lender: lender.trim() || undefined,
              categoryId,
              location,
              ownerId: location === 'personal' || location === 'pot' ? ownerId : '',
              potId: location === 'pot' ? potId : undefined,
              payee: location === 'joint' ? payee : '',
              payeeSharePercent: location === 'joint' ? payeeSharePercent : 100,
              active: true,
              ...(matchedProfile ?? {}),
            })
          }
          label="Add loan"
        />
      </div>
    </div>
  )
}

// ── New credit card form ──
// categoryId defaults to the built-in Credit Card category but is freely
// user-chosen from here, same as a loan's — only changes the card's own
// icon/colour identity, never which bucket its transactions fold into on
// the Home page's "group by category" view (see groupingCategoryId in
// Home.tsx, and the long comment on CREDIT_CARD_CATEGORY_ID in
// types/ledger.ts). Colour is auto-assigned round-robin, same idea as
// Category auto-colour, from the separate SHARED_CARD_COLORS palette
// (shared with pots/savings pots too — see that constant's own comment).

function CreditCardForm({
  people,
  categories,
  defaultOwnerId,
  nextColor,
  onAddCategory,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultOwnerId: string
  nextColor: string
  onAddCategory: (name: string) => { id: string }
  onSave: (card: Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [interestRatePercent, setInterestRatePercent] = useState('')
  const [currentBalance, setCurrentBalance] = useState('')
  const [balanceAsOfDate, setBalanceAsOfDate] = useState(todayIso())
  const [paymentDayOfMonth, setPaymentDayOfMonth] = useState('1')
  // item e — optional; a card left blank behaves exactly as before (no
  // window gating on its minimum-payment generation).
  const [statementStartDay, setStatementStartDay] = useState('')
  const [statementEndDay, setStatementEndDay] = useState('')
  const [minimumPayment, setMinimumPayment] = useState<CreditCardMinimumPayment>({ type: 'percent_of_balance', percent: 5 })
  const [ownerId, setOwnerId] = useState(defaultOwnerId)
  const [categoryId, setCategoryId] = useState(CREDIT_CARD_CATEGORY_ID)

  const canSave = name.trim() && Number(currentBalance) >= 0 && Number(paymentDayOfMonth) >= 1 && Number(paymentDayOfMonth) <= 31

  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
      <EditField label="Name" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Interest rate (% APR)" type="number" value={interestRatePercent} onChange={setInterestRatePercent} />
        <EditField label="Balance (£)" type="number" value={currentBalance} onChange={setCurrentBalance} />
        {/* Defaults to today, which is right for the overwhelmingly
            common case of typing in the figure off the app you're
            looking at. Backdating it to a statement date is supported
            and correct — anything already logged on or after that date
            gets applied on top rather than being assumed included. */}
        <EditField label="...as of" type="date" value={balanceAsOfDate} onChange={setBalanceAsOfDate} />
      </div>
      <EditField label="Payment day of month" type="number" value={paymentDayOfMonth} onChange={setPaymentDayOfMonth} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Statement opens (day, optional)" type="number" value={statementStartDay} onChange={setStatementStartDay} />
        <EditField label="Statement closes (day, optional)" type="number" value={statementEndDay} onChange={setStatementEndDay} />
      </div>
      <MinimumPaymentEditor value={minimumPayment} onChange={setMinimumPayment} />
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />
      {people.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Owner</span>
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id} style={{ color: '#000' }}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex gap-2">
        <CancelButton onClick={onCancel} />
        <SaveButton
          disabled={!canSave}
          onClick={() =>
            onSave({
              name: name.trim(),
              categoryId,
              color: nextColor,
              interestRatePercent: Number(interestRatePercent) || 0,
              currentBalance: Number(currentBalance) || 0,
              balanceAsOfDate,
              minimumPayment,
              paymentDayOfMonth: Number(paymentDayOfMonth),
              statementStartDay: statementStartDay === '' ? undefined : Math.max(1, Math.min(31, Number(statementStartDay))),
              statementEndDay: statementEndDay === '' ? undefined : Math.max(1, Math.min(31, Number(statementEndDay))),
              ownerId,
            })
          }
          label="Add card"
        />
      </div>
    </div>
  )
}

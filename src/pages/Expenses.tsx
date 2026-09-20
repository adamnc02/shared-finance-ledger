import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { formatCurrency, formatFullDate, formatMonthYear } from '../lib/format'
import { Plus, X, ChevronDown, ChevronUp, ArrowRight, ArrowLeftRight } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { PausedOccurrencesControl } from '../components/PausedOccurrencesControl'
import { scheduledDepositDates, depositOccurrencePreviews, setPausedDeposits, resolveSavingsPotDepositOccurrenceAmount, applySavingsPotSingleDepositAmountChange, savingsPotDepositOccurrenceAdjusted } from '../lib/savingsPotLedger'
import { scheduledPotDepositDates, potDepositOccurrencePreviews, setPausedPotDeposits, resolvePotDepositOccurrenceAmount, applyPotSingleDepositAmountChange, potDepositOccurrenceAdjusted } from '../lib/potLedger'
import { FormButtonRow } from '../components/FormButtons'
import { useSavedFlash, SavedFlashOverlay } from '../components/SavedFlash'
import { visibleCategoriesFor, seededCategoryIdForIcon } from '../lib/categories'
import { suggestCategoryForName, type CategorySuggestion } from '../lib/categorySuggestion'
import {
  recentAndUpcomingOccurrences,
  applyTemplateAmountChange,
  applyTemplateSingleOccurrenceAmountChange,
  applyTemplateSingleOccurrenceDateChange,
  resolveOccurrenceAmount,
  templateOccurrencePreviews,
  setPausedTemplateOccurrences,
  scheduledTemplateDates,
  generateTransactionsForTemplate,
  describeSchedule,
  scheduleDiffers,
  type TemplateSchedule,
  occurrenceSlotForDate,
  templateOccurrenceAdjusted,
} from '../lib/schedule'
import { transferLocationLabel, buildTransferLocationOptions, transferLocationKey, locationsEqual, type TransferLocationOption } from '../lib/transferLedger'
import { LocationStep, FrequencyStep, DateStep, TransferFrequencySelect, TRANSFER_FREQUENCY_LABELS, type TransferFrequencyChoice, resolveTransferFrequencyChoice, transferFrequencyChoiceFor } from '../components/TransferSteps'
import { findSalarySortConflicts } from '../lib/salarySortLedger'
import { ConfirmModal } from '../components/ConfirmModal'
import { RecurringChangeConfirmModal } from '../components/RecurringChangeConfirmModal'
import { EffectiveDatedChangeFlow, type RecurringChangeField, type ChangeScope } from '../components/EffectiveDatedChangeFlow'
import { addYears, addDays } from 'date-fns'
import { manageUpcomingRange, trimToManageUpcoming } from '../lib/occurrenceOverrides'
import { CREDIT_CARD_CATEGORY_ID } from '../types/ledger'
import type { PaymentMethod, RecurrenceFrequency, RecurringTemplate, SavingsPot, Pot, Transaction, TransferLocation, AppDataV2, Loan, CreditCard, LoanRecurringOverpayment, Category, PayCycleConfig } from '../types/ledger'
import type { BillLocation } from '../types/models'
import type { LoggedPayment } from './Loans'
import {
  previewOverpaymentRecast,
  previewRecurringOverpaymentRecast,
  scheduledLoanRecurringOverpaymentRealDates,
  setPausedLoanRecurringOverpaymentDates,
  recentAndUpcomingLoanRecurringOverpaymentDates,
  applyRecurringOverpaymentAmountChange,
  applyRecurringOverpaymentSingleAmountOverride,
  resolveRecurringOverpaymentAmount,
  recurringOverpaymentOccurrenceAdjusted,
} from '../lib/ledgerLoans'

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  direct_debit: 'Direct Debit',
  standing_order: 'Standing Order',
}

// Direct Debit and Standing Order are for RECURRING things (bills, loans)
// — they don't make sense as a one-off ad-hoc payment method, so they're
// deliberately not offered here even though they're valid PaymentMethod
// values elsewhere in the app.
const EXPENSE_PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer']

const ENTRY_TYPES = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
] as const
type EntryType = (typeof ENTRY_TYPES)[number]['value']

// Recurring transactions offer the same frequency options as Bills,
// EXCEPT annual — only weekly/every-N-weeks/monthly/quarterly were asked
// for here; Bills.tsx's own FREQUENCY_LABELS is the full set including
// annual, kept separate rather than reused so a recurring transaction's
// picker can never silently offer annual.
const RECURRING_FREQUENCY_LABELS: Record<'weekly' | 'every_n_weeks' | 'monthly' | 'quarterly', string> = {
  weekly: 'Weekly',
  every_n_weeks: 'Every N weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
}
type RecurringFrequency = keyof typeof RECURRING_FREQUENCY_LABELS

import { todayIso, toLocalIsoDate } from '../lib/date'
import { fundablePots, unroundedAmount, roundUpAvailable, roundUpTarget, roundUpUplift, coinJarForOwner } from '../lib/roundUp'

type PageMode = 'transactions' | 'recurring' | 'transfer' | 'overpayments'

// ── Cleared-month grouping (Adam-specified, 2026-09-03) ────────────────
// Applies to every transaction-list pill (Transactions/Savings/Joint —
// NOT Recurring, which shows RecurringTemplate rows with no cleared/
// pending status at all): pending stays exactly as it already was, a
// flat list; cleared collapses into one card per calendar month,
// collapsed by default, so a long history doesn't dominate the page.
// Generic over the row's own item type so all three pills — three
// genuinely different row shapes — share one grouping/collapse
// implementation rather than three near-identical copies of it.
function MonthCollapsedTransactionList<T>({
  items,
  getDate,
  isCleared,
  renderRow,
  keyOf,
  emptyMessage,
}: {
  items: T[]
  getDate: (item: T) => string
  isCleared: (item: T) => boolean
  renderRow: (item: T) => React.ReactNode
  keyOf: (item: T) => string
  emptyMessage: string
}) {
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set())
  const toggleMonth = (key: string) =>
    setExpandedMonths((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // UAT 2026-09-08 (9-transactions-sweep note) — a JUST-cleared item used
  // to disappear into its month's collapsed group immediately, burying it
  // right when it's most likely to need a quick edit. Only a cleared item
  // more than 3 days old now groups; anything cleared today or within the
  // last 2 days stays in the flat, ungrouped list alongside pending items
  // ("for emergency editing," per Adam's own spec).
  const recentCutoffIso = toLocalIsoDate(addDays(new Date(), -3))
  const pending = items.filter((i) => !isCleared(i) || getDate(i) > recentCutoffIso)
  const cleared = items.filter((i) => isCleared(i) && getDate(i) <= recentCutoffIso)

  // Grouped by calendar month (YYYY-MM) — items arrive already sorted by
  // the caller (each pill's own list is sorted before this component ever
  // sees it), so a month's own row order is preserved, only partitioned.
  const monthGroups = new Map<string, T[]>()
  for (const item of cleared) {
    const key = getDate(item).slice(0, 7)
    const list = monthGroups.get(key) ?? []
    list.push(item)
    monthGroups.set(key, list)
  }
  // Most recent month first — matches every pill's own existing
  // most-recent-first sort.
  const monthKeys = Array.from(monthGroups.keys()).sort((a, b) => b.localeCompare(a))

  return (
    <div className="flex flex-col gap-2">
      {pending.map((item) => (
        <div key={keyOf(item)}>{renderRow(item)}</div>
      ))}

      {monthKeys.map((monthKey) => {
        const monthItems = monthGroups.get(monthKey)!
        const expanded = expandedMonths.has(monthKey)
        return (
          <div key={monthKey} className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
            <button onClick={() => toggleMonth(monthKey)} className="w-full flex items-center justify-between px-3 py-2.5">
              <span className="flex items-center gap-1.5">
                {expanded ? <ChevronUp size={14} className="text-[var(--color-ink-muted)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-muted)]" />}
                <span className="text-xs font-semibold text-[var(--color-ink)]">{formatMonthYear(`${monthKey}-01`)}</span>
                <span className="text-xs text-[var(--color-ink-faint)]">· {monthItems.length}</span>
              </span>
            </button>
            {expanded && (
              <div className="px-2 pb-2 flex flex-col gap-2">
                {monthItems.map((item) => (
                  <div key={keyOf(item)}>{renderRow(item)}</div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {pending.length === 0 && cleared.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">{emptyMessage}</p>}
    </div>
  )
}

/**
 * Shared amount/date/note editor for Savings and Joint entries — neither
 * has a category picker or a real payment-method choice (both are always
 * forced onto a fixed category, and always bank_transfer — see
 * logSavingsDeposit/logJointDeposit's own comments in LedgerContext.tsx),
 * so this is deliberately lighter than EditEntryForm below, which handles
 * the full ad-hoc expense/income shape.
 */
function EditSimpleTransactionForm({
  transaction,
  extraFields,
  locations,
  onSave,
  onCancel,
}: {
  transaction: Transaction
  // Rendered above amount/date — e.g. the pot/person picker
  // SavingsTransactionRowItem/JointTransactionRowItem pass in below.
  // That picker's own selected value lives in the CALLER's state (not
  // here), and gets folded into `onSave`'s closure there — this form
  // stays scoped to amount/date/note either way.
  extraFields?: React.ReactNode
  // UAT 2026-09-07 (bug 2.2): a Transfer-page transfer's from/to locations
  // are editable too — a plain amount/date/note pot/savings picker doesn't
  // apply here (either side can be any location), so this is its own
  // opt-in prop rather than folding into `extraFields`.
  locations?: { options: TransferLocationOption[]; savingsPots: SavingsPot[]; pots: Pot[] }
  onSave: (updates: Partial<Pick<Transaction, 'amount' | 'date' | 'note' | 'fromLocation' | 'toLocation'>>) => void
  onCancel: () => void
}) {
  // PROMPT-13 B3 — the field shows the REAL PRICE, not the stored rounded
  // figure: a £7.50 shop stored as £8.00 opens at 7.50. The person is
  // correcting what they actually spent ("it's because I got the price
  // wrong"), and LedgerContext re-rounds on save. Seeding this from
  // `amount` would ratchet the row up a pound every time it was saved.
  const [amount, setAmount] = useState(String(unroundedAmount(transaction)))
  const [date, setDate] = useState(transaction.date)
  const [note, setNote] = useState(transaction.note ?? '')
  const [fromLocation, setFromLocation] = useState(transaction.fromLocation)
  const [toLocation, setToLocation] = useState(transaction.toLocation)
  const [pickingSide, setPickingSide] = useState<'from' | 'to' | null>(null)

  const amountNumber = Number(amount)
  const canSave = amountNumber > 0 && !!date && (!locations || (!!fromLocation && !!toLocation))
  // UAT follow-up (2026-09-05, Adam-reported): dims Save when nothing's
  // actually changed — this form is shared by the Transfer pill's own
  // edit row as well as any other simple amount/date/note entity, so
  // this one fix covers both "transaction" and "transfer" edit rows.
  const dirty =
    amountNumber !== unroundedAmount(transaction) ||
    date !== transaction.date ||
    note.trim() !== (transaction.note ?? '') ||
    (!!locations && (!locationsEqual(fromLocation, transaction.fromLocation) || !locationsEqual(toLocation, transaction.toLocation)))

  if (locations && pickingSide) {
    const otherKey = pickingSide === 'from' ? (toLocation ? transferLocationKey(toLocation) : undefined) : fromLocation ? transferLocationKey(fromLocation) : undefined
    return (
      <div className="p-3 pt-0 border-t" style={{ borderColor: 'var(--color-track)' }}>
        <LocationStep
          title={pickingSide === 'from' ? 'From' : 'To'}
          options={locations.options}
          excludeKey={otherKey}
          onPick={(o) => {
            if (pickingSide === 'from') setFromLocation(o.location)
            else setToLocation(o.location)
            setPickingSide(null)
          }}
          onCancel={() => setPickingSide(null)}
        />
      </div>
    )
  }

  return (
    <div className="p-3 pt-0 flex flex-col gap-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      {locations && fromLocation && toLocation && (
        <div className="flex items-center gap-2">
          <button onClick={() => setPickingSide('from')} className="flex-1 min-w-0 text-left px-3 py-2 rounded-xl text-sm truncate" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}>
            {transferLocationLabel(fromLocation, locations.savingsPots, locations.pots)}
          </button>
          <button
            onClick={() => {
              setFromLocation(toLocation)
              setToLocation(fromLocation)
            }}
            className="shrink-0 p-2 rounded-full"
            style={{ background: 'var(--color-bg-elevated)' }}
            aria-label="Swap From and To"
          >
            <ArrowLeftRight size={16} className="text-[var(--color-ink-muted)]" />
          </button>
          <button onClick={() => setPickingSide('to')} className="flex-1 min-w-0 text-left px-3 py-2 rounded-xl text-sm truncate" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}>
            {transferLocationLabel(toLocation, locations.savingsPots, locations.pots)}
          </button>
        </div>
      )}
      {extraFields}
      {transaction.sourceType === 'salary_sort' && (
        <p className="text-xs text-[var(--color-ink-faint)] mt-3">Changing the amount updates the salary sort too. Changing the date detaches this from the sort.</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" type="text" value={note} onChange={setNote} />
      <FormButtonRow
        onCancel={onCancel}
        onSave={() => onSave({ amount: amountNumber, date, note: note.trim() || undefined, ...(locations ? { fromLocation, toLocation } : {}) })}
        saveDisabled={!canSave || !dirty}
      />
    </div>
  )
}

export function Expenses() {
  const {
    data,
    addAdHocTransaction,
    updateTransaction,
    logCreditCardSpend,
    removeTransaction,
    addCategory,
    addRecurringTemplate,
    updateRecurringTemplate,
    removeRecurringTemplate,
    updateSavingsPot,
    updatePot,
    logTransfer,
    addRecurringTransfer,
    updateLoanOverpayment,
    removeLoanOverpayment,
    updateCreditCardLumpPayment,
    removeCreditCardLumpPayment,
    logLoanOverpayment,
    logCreditCardLumpPayment,
    updateLoan,
    assignLoanRecurringOverpaymentLocation,
  } = useLedgerData()
  const [mode, setMode] = useState<PageMode>('transactions')
  const [adding, setAdding] = useState(false)
  // 2026-09-09 followup — the What-if page's "Make this a real recurring
  // overpayment" button lands here now (see Scenarios.tsx's
  // makeImpactReal), same router-state handoff pattern Loans.tsx already
  // uses for its own overpaymentPrefill.
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const [recurringOverpaymentPrefill, setRecurringOverpaymentPrefill] = useState<{ loanId: string; amount: number; date?: string } | null>(null)
  useEffect(() => {
    const prefill = (
      routerLocation.state as { overpaymentPrefill?: { targetKind: 'loan' | 'credit_card'; targetId: string; mode: 'payoff' | 'recurring'; amount: number; date?: string } } | null
    )?.overpaymentPrefill
    if (prefill && prefill.mode === 'recurring' && prefill.targetKind === 'loan') {
      setMode('overpayments')
      setRecurringOverpaymentPrefill({ loanId: prefill.targetId, amount: prefill.amount, date: prefill.date })
      setAdding(true)
      // Consumed into local state above — clear the router state so a
      // manual close/reopen later doesn't re-trigger it.
      navigate('.', { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Batch 9 (2026-09-07, Bug 11) — a brand-new ad-hoc transaction/
  // recurring transaction/transfer has no row to flash at the moment its
  // own Save fires (the row only mounts on the NEXT render) — same
  // "flash on mount instead" handoff used elsewhere in this sweep
  // (Bills.tsx's new bill, Loans.tsx's new loan/card, Salary.tsx's new
  // pension).
  const [justCreatedTransactionId, setJustCreatedTransactionId] = useState<string | null>(null)
  const [justCreatedRecurringId, setJustCreatedRecurringId] = useState<string | null>(null)
  const [justCreatedTransferId, setJustCreatedTransferId] = useState<string | null>(null)

  // Entries this page owns: things logged directly here, as opposed to
  // generated bill/loan/credit-card-payment/recurring-transaction
  // instances (doc Section 4.1 — recurring templates/loans/cards are
  // generators, not logged by hand). A materialized recurring-transaction
  // occurrence carries type 'expense'/'income' same as a hand-logged one,
  // so `sourceType` is what tells the two apart here — same test
  // credit_card_spend already used for its own generated/logged split.
  const adHocTransactions = data.transactions
    .filter((t) => ((t.type === 'expense' || t.type === 'income') && !t.sourceType) || t.type === 'bonus' || (t.type === 'credit_card_spend' && !t.sourceType))
    .slice()
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))

  const recurringTransactions = data.recurringTemplates
    .filter((t) => t.kind === 'transaction')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  // ── Transfer (2026-09-04 session) — replaces the Savings/Joint/Pots
  // pills entirely (Adam-specified: "remove Savings/Joint/Pots pills
  // entirely"). One-off hand-logged transfers, same !sourceType
  // convention as adHocTransactions above (a generated recurring
  // occurrence carries sourceType: 'recurring_template') — PLUS
  // sourceType: 'salary_sort' rows (UAT Batch 4, 2026-09-04 fix): those
  // are real, independently-editable transfers too (per spec, "I can
  // edit them here and they will update in the salary sort, and vice
  // versa" — LedgerContext.tsx's updateTransaction/removeTransaction
  // already handle the sync), just created by the Salary Sort modal
  // instead of typed in here. Excluding them left TransferRowItem's own
  // sourceType === 'salary_sort' coral-arrow special-casing below
  // permanently unreachable.
  const transferTransactions = data.transactions
    .filter((t) => t.type === 'transfer' && (!t.sourceType || t.sourceType === 'salary_sort'))
    .slice()
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))

  // Recurring transfers — shown INSIDE the Transfer pill (not the generic
  // Recurring pill), regardless of whether they were created here or
  // from an entity's own Wallet-page card ("single clean consistent
  // method to create them throughout", Adam-specified 2026-09-04) —
  // both write the exact same RecurringTemplate.
  const recurringTransfers = data.recurringTemplates
    .filter((t) => t.kind === 'transfer')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  // UAT 2026-09-07 (bug 2.2): shared options list for editing an
  // already-saved transfer's From/To — same scheme TransferForm's
  // creation wizard already uses.
  const transferLocationOptions = buildTransferLocationOptions(data.savingsPots, data.pots, !!data.jointAccount, data.primaryPersonId)

  // 2026-09-09 session (Adam-specified), followup same day — loan/
  // credit-card overpayments got their own dedicated "Overpayments" pill
  // (mirroring the Transfer pill's own shape: a picker-first creation
  // flow plus the resulting log, rather than sharing the Transfers pill).
  // `loansWithOverpayments`/`cardsWithLumpPayments` are only the ones
  // with something to actually SHOW in the past-payments list;
  // `activeLoans`/`activeCards` (below) are the full set offered as a
  // destination when creating a NEW overpayment, since a loan/card with
  // nothing logged yet is still a valid target.
  const loansWithOverpayments = data.loans.filter((l) => l.overpayments.length > 0)
  const cardsWithLumpPayments = data.creditCards.filter((c) => c.lumpPayments.length > 0)
  const activeLoans = data.loans.filter((l) => l.active)
  const activeCards = data.creditCards.filter((c) => c.active)

  // The Transfer pill appears once there's somewhere to transfer TO — a
  // savings pot, the joint account, or a pot; the Overpayments pill
  // appears once there's a loan or credit card to log one against — same
  // "invisible until it would do something" rule the old Savings/Joint/
  // Pots pills used individually.
  const pageModes: PageMode[] = [
    'transactions',
    'recurring',
    ...(data.savingsPots.length > 0 || data.jointAccount || data.pots.length > 0 ? (['transfer'] as const) : []),
    ...(activeLoans.length > 0 || activeCards.length > 0 ? (['overpayments'] as const) : []),
  ]
  const modeLabel: Record<PageMode, string> = { transactions: 'Transactions', recurring: 'Recurring', transfer: 'Transfers', overpayments: 'Overpayments' }

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Transactions</h1>
        <button
          onClick={() => setAdding(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-coral)' }}
        >
          <Plus size={18} className="text-white" />
        </button>
      </header>

      <div className="flex gap-2 mb-4">
        {pageModes.map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m)
              setAdding(false)
            }}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{ background: mode === m ? 'var(--color-coral)' : 'var(--color-surface)', color: mode === m ? '#fff' : 'var(--color-ink-muted)' }}
          >
            {modeLabel[m]}
          </button>
        ))}
      </div>

      {mode === 'transactions' ? (
        <>
          {adding && (
            <ExpenseForm
              onCancel={() => setAdding(false)}
              onSave={(entry) => {
                const id =
                  entry.type === 'expense' && entry.paymentMethod === 'card' && entry.creditCardId
                    ? logCreditCardSpend(entry.creditCardId, entry.amount, entry.date, entry.note || undefined)
                    : addAdHocTransaction({
                        type: entry.type,
                        amount: entry.amount,
                        date: entry.date,
                        categoryId: entry.categoryId,
                        paymentMethod: entry.paymentMethod,
                        personId: entry.personId,
                        note: entry.note || undefined,
                        location: entry.location,
                        potId: entry.potId,
                        roundUpSkipped: entry.roundUpSkipped,
                      })
                setJustCreatedTransactionId(id)
                setAdding(false)
              }}
              onAddCategory={addCategory}
              data={data}
            />
          )}

          <MonthCollapsedTransactionList
            items={adHocTransactions}
            getDate={(t) => t.date}
            isCleared={(t) => t.status === 'cleared'}
            keyOf={(t) => t.id}
            emptyMessage="No ad-hoc entries yet. Log an expense or some income to get started."
            renderRow={(t) => (
              <AdHocTransactionRow
                t={t}
                data={data}
                onAddCategory={addCategory}
                onUpdate={(updates) => updateTransaction(t.id, updates)}
                onRemove={() => removeTransaction(t.id)}
                shouldFlashOnMount={justCreatedTransactionId === t.id}
                onFlashedOnMount={() => setJustCreatedTransactionId(null)}
              />
            )}
          />
        </>
      ) : mode === 'recurring' ? (
        <>
          {adding && (
            <RecurringTransactionForm
              data={data}
              categories={visibleCategoriesFor(data)}
              defaultPersonId={data.primaryPersonId}
              onAddCategory={addCategory}
              onCancel={() => setAdding(false)}
              onSave={(template) => {
                const id = addRecurringTemplate(template)
                setJustCreatedRecurringId(id)
                setAdding(false)
              }}
            />
          )}

          <div className="flex flex-col gap-2">
            {recurringTransactions.map((template) => (
              <RecurringTransactionRow
                key={template.id}
                template={template}
                categories={visibleCategoriesFor(data, template.categoryId)}
                onAddCategory={addCategory}
                onUpdate={(u) => updateRecurringTemplate(template.id, u)}
                onRemove={() => removeRecurringTemplate(template.id)}
                shouldFlashOnMount={justCreatedRecurringId === template.id}
                onFlashedOnMount={() => setJustCreatedRecurringId(null)}
              />
            ))}
            {/* Phase 5 (2026-09 session) — a pot with a recurring deposit
                configured shows here too, whether it was set up from THIS
                pill or from the Wallet page's own "+ Add a recurring
                deposit" button (same underlying SavingsPot fields either
                way — see RecurringTransactionForm's onSaveSavingsRecurring
                comment). */}
            {data.savingsPots
              .filter((p) => p.recurringDepositAmount)
              .map((pot) => (
                <SavingsRecurringDepositRow
                  key={pot.id}
                  pot={pot}
                  onSave={(updates) => updateSavingsPot(pot.id, updates)}
                />
              ))}
            {/* Pots backlog item (2026-09 session) — same treatment as
                SavingsPot immediately above: a pot's recurring deposit
                shows here regardless of whether it was set up from THIS
                pill or the Wallet page's own "+ Add a recurring deposit"
                button (same underlying Pot fields either way). */}
            {data.pots
              .filter((p) => p.recurringDepositAmount)
              .map((pot) => (
                <PotRecurringDepositRow key={pot.id} pot={pot} onSave={(updates) => updatePot(pot.id, updates)} />
              ))}
            {recurringTransactions.length === 0 && !data.savingsPots.some((p) => p.recurringDepositAmount) && !data.pots.some((p) => p.recurringDepositAmount) && !adding && (
              <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">
                No recurring transactions yet. Add a recurring income or expense to have it show up automatically in the Summary ledger.
              </p>
            )}
          </div>
        </>
      ) : mode === 'transfer' ? (
        <>
          {adding && (
            <TransferForm
              data={data}
              onCancel={() => setAdding(false)}
              onSaveOneOff={(from, to, amount, date, note) => {
                const id = logTransfer(from, to, amount, date, note)
                setJustCreatedTransferId(id)
                setAdding(false)
              }}
              onSaveRecurring={(template) => {
                const id = addRecurringTransfer(template)
                setJustCreatedTransferId(id)
                setAdding(false)
              }}
            />
          )}

          <div className="flex flex-col gap-2">
            {recurringTransfers.map((template) => (
              <TransferRecurringRow
                key={template.id}
                template={template}
                savingsPots={data.savingsPots}
                pots={data.pots}
                locationOptions={transferLocationOptions}
                payCycle={data.payCycles.find((pc) => pc.personId === data.primaryPersonId)}
                onUpdate={(u) => updateRecurringTemplate(template.id, u)}
                onRemove={() => removeRecurringTemplate(template.id)}
                shouldFlashOnMount={justCreatedTransferId === template.id}
                onFlashedOnMount={() => setJustCreatedTransferId(null)}
              />
            ))}

            <MonthCollapsedTransactionList
              items={transferTransactions}
              getDate={(t) => t.date}
              isCleared={(t) => t.status === 'cleared'}
              keyOf={(t) => t.id}
              emptyMessage={recurringTransfers.length === 0 ? 'No transfers logged yet.' : ''}
              renderRow={(t) => (
                <TransferRowItem
                  t={t}
                  savingsPots={data.savingsPots}
                  pots={data.pots}
                  locationOptions={transferLocationOptions}
                  onUpdate={(u) => updateTransaction(t.id, u)}
                  onRemove={() => removeTransaction(t.id)}
                  shouldFlashOnMount={justCreatedTransferId === t.id}
                  onFlashedOnMount={() => setJustCreatedTransferId(null)}
                />
              )}
            />
          </div>
        </>
      ) : (
        <>
          {/* mode === 'overpayments' — 2026-09-09 session (Adam-specified),
              followup same day: its own dedicated pill rather than sharing
              Transfers, since a loan/credit-card overpayment isn't a
              transfer between two account balances (see OverpaymentCreateForm's
              own comment on why there's no "From" step for a one-off).
              2026-09-09 second followup (Adam-reported) — creation
              (one-off AND recurring) only ever happens via "+", same as
              every other pill; there is deliberately no always-expanded
              per-loan editor sitting at the top of the page any more. */}
          {adding && (
            <OverpaymentCreateForm
              loans={activeLoans}
              cards={activeCards}
              pots={data.pots}
              prefill={recurringOverpaymentPrefill}
              onCancel={() => {
                setAdding(false)
                setRecurringOverpaymentPrefill(null)
              }}
              onSaveLoan={(loanId, amount, date, note, recastMode) => {
                logLoanOverpayment(loanId, amount, date, note, recastMode)
                setAdding(false)
                setRecurringOverpaymentPrefill(null)
              }}
              onSaveCard={(cardId, amount, date, note) => {
                logCreditCardLumpPayment(cardId, amount, date, note)
                setAdding(false)
                setRecurringOverpaymentPrefill(null)
              }}
              onSaveRecurring={(loanId, recurringOverpayment) => {
                updateLoan(loanId, { recurringOverpayment })
                setAdding(false)
                setRecurringOverpaymentPrefill(null)
              }}
            />
          )}

          {activeLoans.some((l) => l.recurringOverpayment) && (
            <div className="flex flex-col gap-2 mb-3">
              {activeLoans
                .filter((l) => l.recurringOverpayment)
                .map((loan) => (
                  <LoanRecurringOverpaymentRow
                    key={loan.id}
                    loan={loan}
                    pots={data.pots}
                    category={data.categories.find((c) => c.id === loan.categoryId)}
                    value={loan.recurringOverpayment!}
                    onUpdate={(v) => updateLoan(loan.id, { recurringOverpayment: v })}
                    onAssignLocation={(effectiveFrom, location, potId) => assignLoanRecurringOverpaymentLocation(loan.id, location, effectiveFrom, potId)}
                    onRemove={() => updateLoan(loan.id, { recurringOverpayment: undefined })}
                  />
                ))}
            </div>
          )}

          {/* 2026-09-09 third followup (Adam-reported) — one flat list,
              loans and cards mixed together sorted by date, same as the
              Transfers pill's own single MonthCollapsedTransactionList —
              no per-loan/per-card section dividers. */}
          <div className="flex flex-col gap-2">
            {[
              ...loansWithOverpayments.flatMap((loan) =>
                loan.overpayments.map((p) => ({ kind: 'loan' as const, entity: loan, payment: p })),
              ),
              ...cardsWithLumpPayments.flatMap((card) =>
                card.lumpPayments.map((p) => ({ kind: 'card' as const, entity: card, payment: p })),
              ),
            ]
              .sort((a, b) => b.payment.date.localeCompare(a.payment.date))
              .map(({ kind, entity, payment }) => (
                <OverpaymentRowItem
                  key={payment.id}
                  payment={payment}
                  label={kind === 'loan' ? `${entity.name} overpayment` : `${entity.name} payment`}
                  category={data.categories.find((c) => c.id === entity.categoryId)}
                  onUpdate={(amount, date, note) =>
                    kind === 'loan' ? updateLoanOverpayment(entity.id, payment.id, amount, date, note) : updateCreditCardLumpPayment(entity.id, payment.id, amount, date, note)
                  }
                  onRemove={() => (kind === 'loan' ? removeLoanOverpayment(entity.id, payment.id) : removeCreditCardLumpPayment(entity.id, payment.id))}
                />
              ))}
            {loansWithOverpayments.length === 0 && cardsWithLumpPayments.length === 0 && !adding && (
              <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">No overpayments logged yet.</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Ad-hoc transaction row — swipe to delete, tap to expand/edit (same
// interaction pattern RecurringTransactionRow already uses below, and now
// Savings/Joint too — see SavingsTransactionRowItem/JointTransactionRowItem). ──
function AdHocTransactionRow({
  t,
  data,
  onAddCategory,
  onUpdate,
  onRemove,
  shouldFlashOnMount,
  onFlashedOnMount,
}: {
  t: Transaction
  data: ReturnType<typeof useLedgerData>['data']
  onAddCategory: (name: string) => { id: string }
  onUpdate: (updates: Partial<Omit<Transaction, 'id'>>) => void
  onRemove: () => void
  /** Batch 9 (2026-09-07, Bug 11) — true for exactly one render right
   * after this transaction was newly created, so it can flash "Transaction
   * saved." on mount (no row exists yet at the moment a brand-new ad-hoc
   * transaction's own save button is clicked). */
  shouldFlashOnMount?: boolean
  onFlashedOnMount?: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const category = data.categories.find((c) => c.id === t.categoryId)
  const card = t.creditCardId ? data.creditCards.find((c) => c.id === t.creditCardId) : undefined
  const isPositive = t.direction === 'in'
  const { active: flashActive, message: flashMessage, trigger: triggerFlash } = useSavedFlash('Transaction updated.')
  useEffect(() => {
    if (shouldFlashOnMount) {
      triggerFlash('Transaction saved.')
      onFlashedOnMount?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={t.note || category?.name || 'this entry'}>
      <div className="relative rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
        <button onClick={() => setIsEditing((e) => !e)} className="w-full flex items-center gap-3 p-3 text-left">
          <CategoryIcon category={category} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--color-ink)] truncate">
              {t.note || category?.name || (t.type === 'bonus' ? 'Bonus' : t.type === 'income' ? 'Income' : 'Expense')}
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {t.date} · {PAYMENT_METHOD_LABELS[t.paymentMethod]}
              {card ? ` · ${card.name}` : ''}
              {t.status === 'pending' ? ' · Pending' : ''}
            </p>
          </div>
          <p className="text-sm font-mono font-semibold shrink-0" style={{ color: isPositive ? 'var(--color-positive)' : 'var(--color-negative)' }}>
            {isPositive ? '+' : '-'}£{formatCurrency(t.amount)}
          </p>
        </button>
        {isEditing && (
          <EditEntryForm
            transaction={t}
            data={data}
            onAddCategory={onAddCategory}
            onCancel={() => setIsEditing(false)}
            onSave={(updates) => {
              onUpdate(updates)
              setIsEditing(false)
              triggerFlash()
            }}
          />
        )}
        <SavedFlashOverlay active={flashActive} message={flashMessage} />
      </div>
    </SwipeToDelete>
  )
}

// ── Editing an existing entry — amount/date/category/payment method/note. Works for any ad-hoc type, including bonus and card spend entries created elsewhere, since a rename/correction shouldn't require re-deriving where the entry came from. ──

function EditEntryForm({
  transaction,
  data,
  onAddCategory,
  onSave,
  onCancel,
}: {
  transaction: Transaction
  data: ReturnType<typeof useLedgerData>['data']
  onAddCategory: (name: string) => { id: string }
  onSave: (updates: Partial<Omit<Transaction, 'id'>>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(transaction.note ?? '')
  // PROMPT-13 B3 — the field shows the REAL PRICE, not the stored rounded
  // figure: a £7.50 shop stored as £8.00 opens at 7.50. The person is
  // correcting what they actually spent ("it's because I got the price
  // wrong"), and LedgerContext re-rounds on save. Seeding this from
  // `amount` would ratchet the row up a pound every time it was saved.
  const [amount, setAmount] = useState(String(unroundedAmount(transaction)))
  const [date, setDate] = useState(transaction.date)
  const [categoryId, setCategoryId] = useState(transaction.categoryId)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(transaction.paymentMethod)

  // 2026-09-13 (dev.md item 5) — editable only for the same ad-hoc
  // expense/income types the field is offered at creation time for (see
  // ExpenseForm's own comment); bonus/salary/card-spend/etc. keep their
  // own existing location semantics untouched.
  const canEditLocation = transaction.type === 'expense' || transaction.type === 'income'
  const PERSONAL_LOCATION_OPTION: TransferLocationOption = { key: 'personal', label: 'Current Account', location: { type: 'personal' } }
  // PROMPT-13 B5, restriction 4 — nothing is spent out of a Coin Jar ad
  // hoc, so it is not an option for "where did this money come from".
  // The TRANSFER wizard's own options (transferLocationOptions, above)
  // are deliberately NOT filtered: transfers in and out are the
  // sanctioned way to move money to and from a jar.
  const pickableLocationOptions = buildTransferLocationOptions(data.savingsPots, fundablePots(data.pots), !!data.jointAccount, data.primaryPersonId).filter(
    (o) => o.location.type !== 'savings',
  )
  const nonPersonalLocationOptions = pickableLocationOptions.filter((o) => o.location.type !== 'personal')
  const initialLocationOption =
    pickableLocationOptions.find((o) => transferLocationKey(o.location) === transferLocationKey(transaction.location === 'pot' ? { type: 'pot', potId: transaction.potId } : { type: transaction.location as 'personal' | 'joint' })) ??
    PERSONAL_LOCATION_OPTION
  const [locationOption, setLocationOption] = useState<TransferLocationOption>(initialLocationOption)

  // 2026-09-16 (Adam-reported — same fix as ExpenseForm's own Location
  // step, see that component's comment on why Credit Card is kept local
  // rather than added to TransferLocationOption/buildTransferLocationOptions).
  // "Editing just loads the form, no flow" — Adam's own words — so this is
  // a second dropdown that appears once Credit Card is chosen as the
  // Location, not a second wizard step.
  // PROMPT-13 B1a (Adam, 2026-09-20) — the per-transaction override, as an
  // editable field rather than a wizard step: "Editing just loads the form,
  // no flow" (Adam's own words, quoted above).
  const [roundUpSkipped, setRoundUpSkipped] = useState(transaction.roundUpSkipped ?? false)
  const initialIsCreditCardLocation = transaction.paymentMethod === 'card' && !!transaction.creditCardId
  const [isCreditCardLocation, setIsCreditCardLocation] = useState(initialIsCreditCardLocation)
  const [creditCardId, setCreditCardId] = useState<string | undefined>(transaction.creditCardId)
  const creditCardLocationOffered = canEditLocation && transaction.type === 'expense' && data.creditCards.length > 0

  const amountNumber = Number(amount)
  const canSave = name.trim() && amountNumber > 0 && date && categoryId && (!isCreditCardLocation || !!creditCardId)
  // credit_card_spend is always paid by card, by definition — don't offer
  // to change that here (changing the linked card itself isn't supported
  // from this form; delete and re-log against the right card instead).
  // Same reasoning applies once Credit Card is picked as the Location
  // here — the Payment method pills would just be asking the same thing
  // a second time, and possibly contradicting it.
  const paymentMethodEditable = transaction.type !== 'credit_card_spend' && !isCreditCardLocation
  // UAT follow-up (2026-09-05, Adam-reported): dims Save when nothing's
  // actually changed, same rule every other edit panel in the app now
  // follows.
  const dirty =
    name.trim() !== (transaction.note ?? '') ||
    amountNumber !== unroundedAmount(transaction) ||
    date !== transaction.date ||
    categoryId !== transaction.categoryId ||
    (paymentMethodEditable && paymentMethod !== transaction.paymentMethod) ||
    isCreditCardLocation !== initialIsCreditCardLocation ||
    (isCreditCardLocation && creditCardId !== transaction.creditCardId) ||
    (canEditLocation && locationOption.key !== initialLocationOption.key) ||
    roundUpSkipped !== (transaction.roundUpSkipped ?? false)

  // Offered only on the rows that would otherwise round, and only once a
  // Coin Jar exists — the field is computed from the CURRENT form state,
  // not the stored row, so switching the payment method to Cash or the
  // location to Joint makes it disappear as you edit.
  const editedPaymentMethod = isCreditCardLocation ? 'card' : paymentMethodEditable ? paymentMethod : transaction.paymentMethod
  const editedLocation = canEditLocation
    ? !isCreditCardLocation && (locationOption.location.type === 'joint' || locationOption.location.type === 'pot')
      ? locationOption.location.type
      : 'personal'
    : transaction.location
  const ownerCoinJar = coinJarForOwner(data.pots, transaction.ownerId)
  const roundUpOffered = roundUpAvailable(
    {
      type: transaction.type,
      paymentMethod: editedPaymentMethod,
      location: editedLocation,
      date,
      creditCardId: isCreditCardLocation ? creditCardId : undefined,
    },
    data.payCycles.find((c) => c.personId === transaction.ownerId),
    ownerCoinJar?.id,
  )

  return (
    <div className="p-3 pt-0 flex flex-col gap-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <EditField label="Name" type="text" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <CategoryPicker categories={visibleCategoriesFor(data, transaction.categoryId)} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />
      {/* 2026-09-13 (Adam-specified follow-up) — editing an existing entry
          "just loads the form, no flow": Location is a normal inline
          dropdown here, same as every other field on this form, not the
          picker-first LocationStep overlay ExpenseForm's creation wizard
          uses. Ordered above Payment method per Adam's own follow-up. */}
      {canEditLocation && (nonPersonalLocationOptions.length > 0 || creditCardLocationOffered) && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Location</span>
          <select
            value={isCreditCardLocation ? 'credit_card' : locationOption.key}
            onChange={(e) => {
              if (e.target.value === 'credit_card') {
                setIsCreditCardLocation(true)
                return
              }
              setIsCreditCardLocation(false)
              const next = [PERSONAL_LOCATION_OPTION, ...nonPersonalLocationOptions].find((o) => o.key === e.target.value)
              if (next) setLocationOption(next)
            }}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {[PERSONAL_LOCATION_OPTION, ...nonPersonalLocationOptions].map((o) => (
              <option key={o.key} value={o.key} style={{ color: '#000' }}>
                {o.label}
              </option>
            ))}
            {creditCardLocationOffered && (
              <option value="credit_card" style={{ color: '#000' }}>
                Credit Card
              </option>
            )}
          </select>
        </label>
      )}
      {isCreditCardLocation && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Which card</span>
          <select
            value={creditCardId ?? ''}
            onChange={(e) => setCreditCardId(e.target.value)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            <option value="" disabled style={{ color: '#000' }}>
              Choose a card
            </option>
            {data.creditCards.map((c) => (
              <option key={c.id} value={c.id} style={{ color: '#000' }}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {paymentMethodEditable && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Payment method</span>
          <div className="flex flex-wrap gap-1.5">
            {EXPENSE_PAYMENT_METHODS.map((pm) => (
              <button
                key={pm}
                onClick={() => setPaymentMethod(pm)}
                className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                style={{
                  background: paymentMethod === pm ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
                  color: paymentMethod === pm ? '#fff' : 'var(--color-ink-muted)',
                }}
              >
                {PAYMENT_METHOD_LABELS[pm]}
              </button>
            ))}
          </div>
        </label>
      )}
      {roundUpOffered && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={!roundUpSkipped} onChange={(e) => setRoundUpSkipped(!e.target.checked)} />
          <span className="text-xs text-[var(--color-ink-muted)]">
            Round up to the next pound, into {ownerCoinJar?.name ?? 'the Coin Jar'}
            {roundUpUplift(amountNumber) > 0 ? (
              <span className="block text-[var(--color-ink-faint)]">
                £{formatCurrency(amountNumber)} would be logged as £{formatCurrency(roundUpTarget(amountNumber))}, with £
                {formatCurrency(roundUpUplift(amountNumber))} going in.
              </span>
            ) : (
              // Shown rather than hidden: the control's visibility follows
              // the row's SHAPE, not its amount, so it does not blink in and
              // out as the figure is typed.
              <span className="block text-[var(--color-ink-faint)]">Nothing to round on an exact pound.</span>
            )}
          </span>
        </label>
      )}
      <FormButtonRow
        onCancel={onCancel}
        onSave={() =>
          onSave({
            roundUpSkipped: roundUpSkipped || undefined,
            amount: amountNumber,
            date,
            categoryId,
            paymentMethod: isCreditCardLocation ? 'card' : paymentMethodEditable ? paymentMethod : transaction.paymentMethod,
            creditCardId: isCreditCardLocation ? creditCardId : undefined,
            note: name.trim(),
            ...(canEditLocation
              ? {
                  location: (!isCreditCardLocation && (locationOption.location.type === 'joint' || locationOption.location.type === 'pot') ? locationOption.location.type : 'personal') as BillLocation,
                  potId: !isCreditCardLocation && locationOption.location.type === 'pot' ? locationOption.location.potId : undefined,
                }
              : {}),
          })
        }
        saveDisabled={!canSave || !dirty}
      />
    </div>
  )
}

interface ExpenseFormEntry {
  type: EntryType
  amount: number
  date: string
  categoryId: string
  paymentMethod: PaymentMethod
  creditCardId?: string
  personId: string
  note: string
  /** 2026-09-13 (dev.md item 5) — Personal (omit), Joint, or a regular Pot — never a Savings Pot. See ExpenseForm's own Location block comment. */
  location?: 'joint' | 'pot'
  potId?: string
  /** PROMPT-13 B1a — this one entry opts out of rounding. */
  roundUpSkipped?: boolean
}

// PROMPT-13 B1a (Adam, 2026-09-20) — `round_up` is the LAST step, reached
// only when the answers so far add up to a card, personal, ad-hoc expense
// with a real uplift and a Coin Jar to put it in. Every other combination
// commits straight from `payment_method` as before.
type ExpenseFormStep = 'direction' | 'amount' | 'location' | 'date' | 'name' | 'category' | 'payment_method' | 'card' | 'round_up'

/**
 * 2026-09-13 (Adam-specified follow-up) — rebuilt from one flat card
 * (every field visible at once) into the full picker-wizard shape: every
 * editable field is its own step — Direction → Amount → Location
 * (skipped entirely when there's no non-Personal option — see the
 * `nonPersonalLocationOptions` comment below) → Date → Name → Category →
 * Payment method → Which card (only when "Credit Card" was picked).
 * Saving happens the instant the last applicable step is answered — there
 * is no separate trailing "review and Save" screen, unlike the Transfer/
 * Overpayment wizards' own final step. Adam's own spec, verbatim:
 * "Every editable part of the new transaction becomes part of the flow,
 * each it's own step." Editing an existing entry (EditEntryForm) is
 * deliberately NOT touched by this — Adam's own words: "For editing a
 * transaction, it just loads the form, no flow" — Location there stays a
 * normal inline dropdown alongside every other field.
 */
function ExpenseForm({
  onCancel,
  onSave,
  onAddCategory,
  data,
}: {
  onCancel: () => void
  onSave: (entry: ExpenseFormEntry) => void
  onAddCategory: (name: string) => { id: string }
  data: ReturnType<typeof useLedgerData>['data']
}) {
  const [step, setStep] = useState<ExpenseFormStep>('direction')
  const [type, setType] = useState<EntryType>('expense')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayIso())
  const defaultCategoryId = seededCategoryIdForIcon('food')
  const [categoryId, setCategoryId] = useState(
    visibleCategoriesFor(data).some((c) => c.id === defaultCategoryId) ? defaultCategoryId : (visibleCategoriesFor(data)[0]?.id ?? ''),
  )
  // 2026-09-17 (Adam) — the category step starts on the category of the most
  // recent past transaction with a similar name (lib/categorySuggestion.ts),
  // recomputed each time the name step is left. Once the person picks a
  // category themselves, their choice stands even if they go back and edit
  // the name.
  const [suggestion, setSuggestion] = useState<CategorySuggestion | null>(null)
  const [categoryPickedByHand, setCategoryPickedByHand] = useState(false)
  function applyCategorySuggestion() {
    if (categoryPickedByHand) return
    const allowed = new Set(visibleCategoriesFor(data).map((c) => c.id))
    const match = suggestCategoryForName(name, data.transactions, allowed)
    setSuggestion(match)
    if (match) setCategoryId(match.categoryId)
  }

  // 2026-09-13 (dev.md item 5, Adam-specified) — "location" here reuses
  // the exact same flat option list recurring transfers pick from
  // (buildTransferLocationOptions), minus Savings Pots (excluded by
  // design — this is about which ACCOUNT a transaction sits against, not
  // a savings destination) and minus Personal itself from the picker's
  // own list (Personal is the implicit default, not something to "pick
  // into"). The step is skipped entirely (amount → date direct) once
  // there's no genuine non-Personal choice to make — no Joint account and
  // no Pots.
  const PERSONAL_LOCATION_OPTION: TransferLocationOption = { key: 'personal', label: 'Current Account', location: { type: 'personal' } }
  // PROMPT-13 B5, restriction 4 — nothing is spent out of a Coin Jar ad
  // hoc, so it is not an option for "where did this money come from".
  // The TRANSFER wizard's own options (transferLocationOptions, above)
  // are deliberately NOT filtered: transfers in and out are the
  // sanctioned way to move money to and from a jar.
  const pickableLocationOptions = buildTransferLocationOptions(data.savingsPots, fundablePots(data.pots), !!data.jointAccount, data.primaryPersonId).filter(
    (o) => o.location.type !== 'savings',
  )
  const nonPersonalLocationOptions = pickableLocationOptions.filter((o) => o.location.type !== 'personal')
  const [locationOption, setLocationOption] = useState<TransferLocationOption>(PERSONAL_LOCATION_OPTION)

  // 2026-09-16 (Adam-reported — "location" bug): Credit Card is a genuine
  // fourth location choice ("where did this money come from") alongside
  // Personal/Joint/Pot, but it isn't a TransferLocationType (transfers
  // don't have a card as an endpoint — see transferLedger.ts) so it can't
  // just be added to buildTransferLocationOptions/TransferLocationOption
  // without touching the shared Transfer wizard too, which this bug
  // explicitly does NOT concern ("This ONLY affects transactions"). Kept
  // entirely local to this component instead: picking "Credit Card" here
  // reuses the exact same underlying representation the payment_method
  // step's own "Credit Card" → "Which card" path already produces
  // (paymentMethod: 'card', creditCardId set, location left as personal)
  // — just reachable earlier, from Location, with the later Payment
  // method step skipped once a card's already been picked this way (it'd
  // otherwise ask the same question twice).
  const [creditCardId, setCreditCardId] = useState<string | undefined>(undefined)
  const [skipPaymentMethodStep, setSkipPaymentMethodStep] = useState(false)
  const creditCardLocationOffered = type === 'expense' && data.creditCards.length > 0

  const amountNumber = Number(amount)

  // PROMPT-13 B1a — the round-up step's own state. `pendingCommit` holds
  // the payment-method answers while the question is asked, for the same
  // reason commitSave takes them as arguments rather than reading state:
  // they are set in the same click that navigates here.
  const [pendingCommit, setPendingCommit] = useState<{ type: EntryType; paymentMethod: PaymentMethod; creditCardId?: string } | null>(null)
  // The logging person's own jar and cycle — this wizard always logs for
  // the primary person (`personId: data.primaryPersonId` below).
  const primaryPayCycle = data.payCycles.find((c) => c.personId === data.primaryPersonId)
  const coinJar = coinJarForOwner(data.pots, data.primaryPersonId)

  // The payment-method step's own tap targets each commit and save
  // directly (there's no further step after them, except "Credit Card" →
  // "Which card") — passing the chosen values straight through as
  // arguments rather than reading paymentMethod/creditCardId state avoids
  // acting on a stale value from before the same click's setState apply.
  function commitSave(finalType: EntryType, finalPaymentMethod: PaymentMethod, finalCreditCardId?: string, roundUpSkipped?: boolean) {
    const location = locationOption.location.type === 'joint' || locationOption.location.type === 'pot' ? locationOption.location.type : undefined

    // PROMPT-13 B1a — one more question, but only when there is genuinely
    // one to ask: the entry would otherwise round, and there is a real
    // uplift to decline. `roundUpSkipped === undefined` means we have not
    // asked yet; once the step answers, it comes back through here with a
    // boolean and falls past this guard.
    //
    // The uplift check is what keeps an exact £8.00 from stopping the flow
    // to ask about 0p. The amount is already fixed by this point in the
    // wizard, so it cannot change under the question.
    if (
      roundUpSkipped === undefined &&
      roundUpAvailable(
        { type: finalType, paymentMethod: finalPaymentMethod, location: location ?? 'personal', date, creditCardId: finalCreditCardId },
        primaryPayCycle,
        coinJar?.id,
      ) &&
      roundUpUplift(amountNumber) > 0
    ) {
      setPendingCommit({ type: finalType, paymentMethod: finalPaymentMethod, creditCardId: finalCreditCardId })
      setStep('round_up')
      return
    }

    onSave({
      type: finalType,
      amount: amountNumber,
      date,
      categoryId,
      paymentMethod: finalPaymentMethod,
      creditCardId: finalCreditCardId,
      personId: data.primaryPersonId,
      note: name.trim(),
      location,
      potId: locationOption.location.type === 'pot' ? locationOption.location.potId : undefined,
      roundUpSkipped,
    })
  }

  // 2026-09-13 (Adam-specified follow-up, "mirror transfers") — Direction
  // and Amount now share ONE first screen, same shape as TransferForm's
  // own first step (mode toggle + amount together, one Continue). Every
  // step after this one is unchanged.
  if (step === 'direction' || step === 'amount') {
    return (
      <div className="mb-6 p-4 rounded-2xl flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">New entry</h2>
          <button onClick={onCancel} className="text-[var(--color-ink-muted)]">
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-2">
          {ENTRY_TYPES.map((et) => (
            <button
              key={et.value}
              onClick={() => setType(et.value)}
              className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
              style={{
                background: type === et.value ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
                color: type === et.value ? '#fff' : 'var(--color-ink-muted)',
              }}
            >
              {et.label}
            </button>
          ))}
        </div>
        <EditField key="expense-amount" label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <FormButtonRow
          onCancel={onCancel}
          onSave={() => setStep(nonPersonalLocationOptions.length > 0 || creditCardLocationOffered ? 'location' : 'date')}
          saveLabel="Continue"
          saveDisabled={!(amountNumber > 0)}
        />
      </div>
    )
  }

  if (step === 'location') {
    // Not the shared LocationStep component here — Credit Card needs to
    // sit in this exact same pill list (not a separate group below it),
    // and it isn't a TransferLocationOption (see this component's own
    // comment on why), so this renders LocationStep's own markup locally
    // with one extra row appended.
    return (
      <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Location</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {[PERSONAL_LOCATION_OPTION, ...nonPersonalLocationOptions].map((o) => (
            <button
              key={o.key}
              onClick={() => {
                setLocationOption(o)
                setStep('date')
              }}
              className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
              style={{ background: 'var(--color-surface)' }}
            >
              {o.label}
            </button>
          ))}
          {creditCardLocationOffered && (
            <button
              onClick={() => setStep('card')}
              className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
              style={{ background: 'var(--color-surface)' }}
            >
              Credit Card
            </button>
          )}
        </div>
      </div>
    )
  }

  if (step === 'date') {
    return <DateStep value={date} onChange={setDate} onCancel={onCancel} onContinue={() => setStep('name')} />
  }

  if (step === 'name') {
    return (
      <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Name</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <EditField label="Name" type="text" value={name} onChange={setName} />
        <FormButtonRow
          onCancel={onCancel}
          onSave={() => {
            applyCategorySuggestion()
            setStep('category')
          }}
          saveLabel="Continue"
          saveDisabled={!name.trim()}
        />
      </div>
    )
  }

  if (step === 'category') {
    return (
      <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Category</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <CategoryPicker
          // 2026-09-18 (Adam-reported) — the built-in Credit Card category is
          // reserved for a genuine credit-card-entity transaction (Location:
          // Credit Card, above); offering it here too, for an ordinary
          // Personal/Joint/Pot entry, is exactly the confusion that produced
          // PROMPT-08a Part B's bug in the first place. `skipPaymentMethodStep`
          // is only ever true once a card's already been picked via Location.
          categories={visibleCategoriesFor(data).filter((c) => skipPaymentMethodStep || c.id !== CREDIT_CARD_CATEGORY_ID)}
          value={categoryId}
          onChange={(id) => {
            setCategoryPickedByHand(true)
            setCategoryId(id)
          }}
          onAddCategory={onAddCategory}
        />
        {suggestion && !categoryPickedByHand && categoryId === suggestion.categoryId && (
          <p className="text-[11px] text-[var(--color-ink-faint)] -mt-1">
            From your last "{suggestion.matchedName}" on {formatFullDate(suggestion.matchedDate)}
          </p>
        )}
        <FormButtonRow
          onCancel={onCancel}
          onSave={() => (skipPaymentMethodStep ? commitSave(type, 'card', creditCardId) : setStep('payment_method'))}
          saveLabel="Continue"
          saveDisabled={!categoryId}
        />
      </div>
    )
  }

  if (step === 'card') {
    return (
      <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Which card</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {data.creditCards.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                // Reached only from Location now (2026-09-18 — the payment_method
                // step's own duplicate "Credit Card" entry point is removed, see
                // its comment below): Date/Name/Category are still to come, so
                // stash the card and continue, skipping the later Payment method
                // step since it'd otherwise just ask the same thing again.
                setCreditCardId(c.id)
                setSkipPaymentMethodStep(true)
                setStep('date')
              }}
              className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
              style={{ background: 'var(--color-surface)' }}
            >
              {c.name}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-ink-faint)] mt-3">
          This adds to the card's balance — it won't reduce your cash balance until you pay the card down.
        </p>
      </div>
    )
  }

  if (step === 'round_up' && pendingCommit) {
    // PROMPT-13 B1a (Adam, 2026-09-20) — "By default, the value should be
    // set to round up if the toggle is on. But I can turn it off per
    // transaction."
    //
    // So rounding is the highlighted, pre-picked option, in the same
    // coral-default treatment the Payment method step gives "Card". One
    // tap either way, no Continue.
    const target = roundUpTarget(amountNumber)
    const uplift = roundUpUplift(amountNumber)
    return (
      <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Round up?</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => commitSave(pendingCommit.type, pendingCommit.paymentMethod, pendingCommit.creditCardId, false)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm font-medium"
            style={{ background: 'var(--color-coral)', color: '#fff' }}
          >
            Round up to £{formatCurrency(target)}
            <span className="block text-xs font-normal opacity-90">£{formatCurrency(uplift)} into {coinJar?.name ?? 'the Coin Jar'}</span>
          </button>
          <button
            onClick={() => commitSave(pendingCommit.type, pendingCommit.paymentMethod, pendingCommit.creditCardId, true)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm font-medium text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            Not this one
            <span className="block text-xs font-normal text-[var(--color-ink-muted)]">Log it as £{formatCurrency(amountNumber)}</span>
          </button>
        </div>
      </div>
    )
  }

  // payment_method — the last step, reached only once a genuine credit-card
  // transaction has already been ruled out (Location wasn't Credit Card, so
  // skipPaymentMethodStep is false). Only cash/bank_transfer/plain-card are
  // offered here — no "Credit Card" option. 2026-09-18 (Adam-reported): a
  // second, duplicate "Credit Card" entry point used to sit here alongside
  // Location's, so a Personal/Joint/Pot-located entry could still end up
  // with a creditCardId attached, the exact conflation PROMPT-08a Part B's
  // bug came from. Location, above, is now the only way to attach one.
  // "Card" is highlighted as the default (Adam-specified) — still a single
  // tap to commit, same as every other option here, just visually
  // pre-picked rather than requiring an extra Continue step for the common
  // case.
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Payment method</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {EXPENSE_PAYMENT_METHODS.map((pm) => (
          <button
            key={pm}
            onClick={() => commitSave(type, pm, undefined)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm font-medium"
            style={{
              background: pm === 'card' ? 'var(--color-coral)' : 'var(--color-surface)',
              color: pm === 'card' ? '#fff' : 'var(--color-ink)',
            }}
          >
            {PAYMENT_METHOD_LABELS[pm]}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Transfer (2026-09-04 session, "Salary Sorter & Transfer Pill") ──────
// Replaces the old Savings/Joint/Pots pills entirely (Adam-specified:
// "remove Savings/Joint/Pots pills entirely"). One form covers every
// combination of Current Account / Savings pot / Joint account / Pot on
// EITHER side (2026-09 UAT session: "Transfer form 'From' location made
// editable" — Current Account is no longer pinned to one fixed side; a
// direct Pot ↔ Pot / Pot ↔ Savings / Savings ↔ Joint transfer with no
// personal leg at all is now reachable too — see locationTypeForTransfer
// in transferLedger.ts and autoClear.ts's own dedicated materialization
// pass for how that's kept correct end-to-end).

const TRANSFER_MODES = [
  { value: 'one_off', label: 'One-Off' },
  { value: 'recurring', label: 'Recurring' },
] as const
type TransferMode = (typeof TRANSFER_MODES)[number]['value']

type TransferFormStep = 'amount' | 'from' | 'to' | 'frequency' | 'date' | 'final'

/**
 * UAT Batch 4 (2026-09-04, items 2/7): rebuilt from one flat card (mode
 * toggle + From/To dropdowns + inline fields all at once) into Adam's
 * picker-wizard spec — Amount → From → To (the "insert a to location
 * after step 2" Adam specifically called out, since neither side is
 * fixed here the way a Wallet-page pot/savings-pot/joint card's own
 * wizard has one side implied) → for Recurring, Frequency (→ weeks, if
 * every-N-weeks) → Date (skipped if the frequency choice was "follow
 * payday"/"follow my budgeting cycle") → a final Name(recurring)/Note/
 * Save screen. All the existing business logic (reverse Salary Sort
 * conflict guard, draft-template occurrence scanning) is unchanged,
 * just re-triggered from the final step instead of one flat form.
 */
function TransferForm({
  data,
  onCancel,
  onSaveOneOff,
  onSaveRecurring,
}: {
  data: AppDataV2
  onCancel: () => void
  onSaveOneOff: (from: TransferLocation, to: TransferLocation, amount: number, date: string, note?: string) => void
  onSaveRecurring: (
    template: Omit<RecurringTemplate, 'id' | 'active' | 'kind' | 'categoryId' | 'paymentMethod' | 'location' | 'ownerId' | 'payee' | 'payeeSharePercent'>,
  ) => void
}) {
  const { savingsPots, pots, jointAccount, primaryPersonId } = data
  const options = buildTransferLocationOptions(savingsPots, pots, !!jointAccount, primaryPersonId)
  const payCycle = data.payCycles.find((pc) => pc.personId === primaryPersonId)

  const [step, setStep] = useState<TransferFormStep>('amount')
  const [mode, setMode] = useState<TransferMode>('one_off')
  const [amount, setAmount] = useState('')
  const [fromOption, setFromOption] = useState<TransferLocationOption | null>(null)
  const [toOption, setToOption] = useState<TransferLocationOption | null>(null)
  const [freqChoice, setFreqChoice] = useState<TransferFrequencyChoice | null>(null)
  const [intervalWeeks, setIntervalWeeks] = useState(4)
  const [date, setDate] = useState(todayIso())
  const [note, setNote] = useState('')
  const [name, setName] = useState('')
  // Reverse Salary Sort guard (2026-09 session) — set when Save finds this
  // new transfer would land on the same destination as one or more
  // already-saved salary sorts. Deferred here rather than acted on
  // immediately so the actual save only happens once the person picks
  // Go ahead / Skip (one-off) or Go ahead / Cancel (recurring, per
  // Adam's "rename to cancel — no recurring transfer gets created at
  // all" call).
  const [pendingConflicts, setPendingConflicts] = useState<{ conflicts: { payDate: string; amount: number }[]; isRecurring: boolean } | null>(null)

  const amountNumber = Number(amount)

  // Current Account + exactly one other destination is the floor — with
  // nothing to transfer to/from beyond personal, there's nowhere to go.
  if (options.length < 2) {
    return (
      <div className="mb-6 p-4 rounded-2xl flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">New transfer</h2>
          <button onClick={onCancel} className="text-[var(--color-ink-muted)]">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-faint)]">Add a savings pot, a pot, or a joint account first — there's nowhere to transfer to yet.</p>
      </div>
    )
  }

  function reset() {
    setStep('amount')
    setMode('one_off')
    setAmount('')
    setFromOption(null)
    setToOption(null)
    setFreqChoice(null)
    setIntervalWeeks(4)
    setDate(todayIso())
    setNote('')
    setName('')
    setPendingConflicts(null)
    onCancel()
  }

  function commitSave() {
    if (!fromOption || !toOption) return
    const from = fromOption.location
    const to = toOption.location
    if (mode === 'one_off') {
      onSaveOneOff(from, to, amountNumber, date, note.trim() || undefined)
    } else {
      if (!freqChoice) return
      const resolved = resolveTransferFrequencyChoice(freqChoice)
      onSaveRecurring({
        name: name.trim(),
        amount: amountNumber,
        frequency: resolved.frequency,
        intervalWeeks: resolved.frequency === 'every_n_weeks' ? intervalWeeks : undefined,
        anchorDate: date,
        transferFrom: from,
        transferTo: to,
        followsPayday: resolved.followsPayday,
        followsCycleStart: resolved.followsCycleStart,
      })
    }
    reset()
  }

  function handleSave() {
    if (!fromOption || !toOption) return
    // The reverse Salary Sort guard only makes sense when Current
    // Account is the SOURCE (a deposit out of it) — a sort only ever
    // moves money that same direction, never the reverse, and never
    // touches a transfer with no personal leg at all. Same
    // exact-location-match rule as the sort's own guard (locationsEqual,
    // no amount check).
    if (fromOption.location.type !== 'personal') {
      commitSave()
      return
    }
    if (mode === 'one_off') {
      const conflicts = findSalarySortConflicts(data, toOption.location, [date])
      if (conflicts.length > 0) {
        setPendingConflicts({ conflicts, isRecurring: false })
        return
      }
    } else {
      if (!freqChoice) return
      const resolved = resolveTransferFrequencyChoice(freqChoice)
      // Scan this payday-like date plus the next 3 resolved occurrences
      // (Adam's explicit 2026-09 call) — resolved via the exact same
      // generation path the recurring template will actually use once
      // saved, so followsPayday/followsCycleStart/frequency are all
      // honoured rather than guessed at.
      const draftTemplate: RecurringTemplate = {
        id: 'draft',
        name: name.trim() || 'Transfer',
        amount: amountNumber,
        categoryId: '',
        paymentMethod: 'bank_transfer',
        frequency: resolved.frequency,
        intervalWeeks: resolved.frequency === 'every_n_weeks' ? intervalWeeks : undefined,
        anchorDate: date,
        location: 'personal',
        ownerId: primaryPersonId,
        payee: '',
        payeeSharePercent: 100,
        active: true,
        kind: 'transfer',
        transferFrom: fromOption.location,
        transferTo: toOption.location,
        followsPayday: resolved.followsPayday,
        followsCycleStart: resolved.followsCycleStart,
      }
      const occurrenceDates = generateTransactionsForTemplate(draftTemplate, new Date(), addYears(new Date(), 2), payCycle)
        .map((o) => o.date)
        .slice(0, 4)
      const conflicts = findSalarySortConflicts(data, toOption.location, occurrenceDates)
      if (conflicts.length > 0) {
        setPendingConflicts({ conflicts, isRecurring: true })
        return
      }
    }
    commitSave()
  }

  if (step === 'amount') {
    return (
      <div className="mb-6 p-4 rounded-2xl flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">New transfer</h2>
          <button onClick={reset} className="text-[var(--color-ink-muted)]">
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-2">
          {TRANSFER_MODES.map((tm) => (
            <button
              key={tm.value}
              onClick={() => setMode(tm.value)}
              className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
              style={{ background: mode === tm.value ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: mode === tm.value ? '#fff' : 'var(--color-ink-muted)' }}
            >
              {tm.label}
            </button>
          ))}
        </div>
        <EditField key="transfer-amount" label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <FormButtonRow onCancel={reset} onSave={() => setStep('from')} saveLabel="Continue" saveDisabled={!(amountNumber > 0)} />
      </div>
    )
  }

  if (step === 'from') {
    return (
      <LocationStep
        title="From"
        options={options}
        excludeKey={toOption?.key}
        onPick={(o) => {
          setFromOption(o)
          setStep('to')
        }}
        onCancel={reset}
      />
    )
  }

  if (step === 'to') {
    return (
      <LocationStep
        title="To"
        options={options}
        excludeKey={fromOption?.key}
        onPick={(o) => {
          setToOption(o)
          setStep(mode === 'recurring' ? 'frequency' : 'date')
        }}
        onCancel={reset}
      />
    )
  }

  if (step === 'frequency') {
    return (
      <FrequencyStep
        choice={freqChoice}
        intervalWeeks={intervalWeeks}
        onChoiceChange={setFreqChoice}
        onIntervalWeeksChange={setIntervalWeeks}
        onCancel={reset}
        onContinue={() => setStep(freqChoice === 'follows_payday' || freqChoice === 'follows_cycle_start' ? 'final' : 'date')}
      />
    )
  }

  if (step === 'date') {
    return <DateStep value={date} onChange={setDate} onCancel={reset} onContinue={() => setStep('final')} />
  }

  // final — Name (recurring only) + Note + Save, same trailing fields/
  // helper text/conflict-guard the old flat form always had.
  return (
    <div className="mb-6 p-4 rounded-2xl flex flex-col gap-4" style={{ background: 'var(--color-surface)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">New transfer</h2>
        <button onClick={reset} className="text-[var(--color-ink-muted)]">
          <X size={18} />
        </button>
      </div>

      {mode === 'recurring' && <EditField key="transfer-name" label="Name" type="text" value={name} onChange={setName} />}
      <EditField key="transfer-note" label="Note (optional)" type="text" value={note} onChange={setNote} />

      <p className="text-xs text-[var(--color-ink-faint)]">
        Moves money OUT of {fromOption?.label ?? 'the source'} and INTO {toOption?.label ?? 'the destination'}
        {toOption?.location.type === 'personal' ? ', shown as income' : ''}.
      </p>

      <FormButtonRow onCancel={reset} onSave={handleSave} saveDisabled={mode === 'recurring' && !name.trim()} />

      {pendingConflicts && (
        <ConfirmModal
          title="Already sorted"
          description={
            `${toOption?.label ?? 'This destination'} already has a salary sort covering ` +
            pendingConflicts.conflicts.map((c) => `${c.payDate} (£${c.amount.toFixed(2)})`).join(', ') +
            (pendingConflicts.isRecurring
              ? '. Go ahead and create this recurring transfer alongside it, or cancel — no transfer will be created.'
              : '. Go ahead and create this transfer alongside it, or skip — nothing will be created.')
          }
          confirmLabel="Go ahead"
          cancelLabel={pendingConflicts.isRecurring ? 'Cancel' : 'Skip'}
          onConfirm={() => {
            setPendingConflicts(null)
            commitSave()
          }}
          onCancel={reset}
        />
      )}
    </div>
  )
}

type OverpaymentTarget = { kind: 'loan'; id: string; label: string } | { kind: 'card'; id: string; label: string }
type OverpaymentFormStep = 'amount' | 'to' | 'from' | 'recast' | 'date' | 'final'
type OverpaymentMode = 'one_off' | 'recurring'
const OVERPAYMENT_MODES: { value: OverpaymentMode; label: string }[] = [
  { value: 'one_off', label: 'One-off' },
  { value: 'recurring', label: 'Recurring' },
]

/**
 * 2026-09-09 followup (Adam-specified) — the Overpayments pill's own
 * picker-first creation wizard, mirroring TransferForm's shape (mode
 * toggle → amount → location(s) → date → final) as closely as the data
 * actually supports.
 *
 * One-off overpayments deliberately have NO "From" step, unlike a
 * transfer: a one-off loan overpayment has never had a funding-location
 * field at all — it's hardcoded to personal (or joint, for a joint loan)
 * cash out, per Adam's own 2026-09-03 call captured in
 * applyLoanOverpayment's comment ("a lump payment structurally can't
 * come from a pot"), and a credit-card lump payment has never had a
 * location field either.
 *
 * Recurring mode is loan-only (credit cards have no recurring-lump-
 * payment concept in the data model) and DOES have a real From
 * (Personal/Pot) step, since LoanRecurringOverpayment.location is a real
 * field — see that type's own comment in types/ledger.ts for why it's
 * deliberately Personal/Pot only, never Joint (same reasoning as the
 * one-off case: "never joint... risking the per-person joint split math
 * being applied to a pot-sourced, unsplit amount").
 */
function OverpaymentCreateForm({
  loans,
  cards,
  pots,
  prefill,
  onCancel,
  onSaveLoan,
  onSaveCard,
  onSaveRecurring,
}: {
  loans: Loan[]
  cards: CreditCard[]
  pots: Pot[]
  /** 2026-09-09 followup — the What-if page's "Make this a real recurring
   * overpayment" button lands here pre-filled, same wizard as every other
   * entry point rather than a separate UI (see Scenarios.tsx's
   * makeImpactReal). Amount/mode/target are seeded straight in; the
   * person still steps through From (unless the loan's joint)/recast/
   * date/Save themselves. */
  prefill?: { loanId: string; amount: number; date?: string } | null
  onCancel: () => void
  onSaveLoan: (loanId: string, amount: number, date: string, note: string | undefined, recastMode: 'reduce_term' | 'reduce_payment') => void
  onSaveCard: (cardId: string, amount: number, date: string, note?: string) => void
  onSaveRecurring: (loanId: string, recurringOverpayment: LoanRecurringOverpayment) => void
}) {
  const prefillLoan = prefill ? loans.find((l) => l.id === prefill.loanId) : undefined
  // 2026-09-09 followup (Adam-reported) — two different prefill shapes
  // land here now: the What-if page's "Make this a real recurring
  // overpayment" hands over a real amount too (so it's safe to skip
  // straight past Amount/To), while the Borrowing page's own "+ Log a
  // recurring overpayment" trigger only knows WHICH loan — amount is
  // still 0/unset, so the person needs the normal Amount step, just with
  // To already answered for them.
  const hasPrefillAmount = !!prefillLoan && (prefill?.amount ?? 0) > 0
  const [mode, setMode] = useState<OverpaymentMode>(prefillLoan ? 'recurring' : 'one_off')
  // Recurring is loan-only — a credit card target is never offered once
  // Recurring is picked.
  const targets: OverpaymentTarget[] =
    mode === 'recurring'
      ? loans.map((l) => ({ kind: 'loan' as const, id: l.id, label: `Loan: ${l.name}` }))
      : [...loans.map((l) => ({ kind: 'loan' as const, id: l.id, label: `Loan: ${l.name}` })), ...cards.map((c) => ({ kind: 'card' as const, id: c.id, label: `Credit Card: ${c.name}` }))]

  const [step, setStep] = useState<OverpaymentFormStep>(
    prefillLoan ? (hasPrefillAmount ? (prefillLoan.location === 'joint' ? 'recast' : 'from') : 'amount') : 'amount',
  )
  const [amount, setAmount] = useState(hasPrefillAmount ? String(prefill!.amount) : '')
  const [recurringAmountType, setRecurringAmountType] = useState<'fixed' | 'percent_of_balance'>('fixed')
  const [recurringPercent, setRecurringPercent] = useState('5')
  const [target, setTarget] = useState<OverpaymentTarget | null>(prefillLoan ? { kind: 'loan', id: prefillLoan.id, label: `Loan: ${prefillLoan.name}` } : null)
  const [fromLocation, setFromLocation] = useState<'personal' | 'pot' | undefined>(undefined)
  const [fromPotId, setFromPotId] = useState<string | undefined>(undefined)
  const [recastMode, setRecastMode] = useState<'reduce_term' | 'reduce_payment'>('reduce_term')
  const [date, setDate] = useState(prefill?.date ?? todayIso())
  const [note, setNote] = useState('')

  const amountNumber = mode === 'recurring' && recurringAmountType === 'percent_of_balance' ? Number(recurringPercent) : Number(amount)
  const targetLoan = target?.kind === 'loan' ? loans.find((l) => l.id === target.id) : undefined
  const ownerPots = targetLoan ? fundablePots(pots).filter((p) => p.personId === targetLoan.ownerId) : []

  function reset() {
    setMode('one_off')
    setStep('amount')
    setAmount('')
    setRecurringAmountType('fixed')
    setRecurringPercent('5')
    setTarget(null)
    setFromLocation(undefined)
    setFromPotId(undefined)
    setRecastMode('reduce_term')
    setDate(todayIso())
    setNote('')
    onCancel()
  }

  // Advancing past "amount" auto-skips "to" entirely when there's only
  // one eligible target (Adam-requested) — no point making a single-
  // option list something you have to tap through.
  function afterAmount() {
    // Target already answered (Borrowing page's own "+ Log a recurring
    // overpayment" trigger pre-selects its loan) — re-run the same
    // routing pickTarget always does (joint loans skip From) rather than
    // asking the person to pick the loan they just came from again.
    if (target) {
      pickTarget(target)
      return
    }
    if (targets.length === 1) {
      pickTarget(targets[0])
      return
    }
    setStep('to')
  }

  function pickTarget(t: OverpaymentTarget) {
    setTarget(t)
    // A joint loan's recurring overpayment always follows the loan —
    // it's ALWAYS jointly funded, never redirectable to Personal/a pot
    // (see resolveRecurringOverpaymentSource's own comment in
    // ledgerLoans.ts: "deliberately ignores this field entirely...
    // rather than risking the per-person joint split math being applied
    // to a pot-sourced, unsplit amount"). So there's nothing to actually
    // pick — skip straight past the From step, same "don't make a
    // single-option list something to tap through" rule as the To step.
    // UAT 2026-09-09 (ed-overpay-just-single) — a RECURRING overpayment
    // never offers the recast choice at all now (Adam's own call, see
    // ledgerLoans.ts's buildLoanSchedule doc comment on why reduce_payment
    // is no longer honoured for one) — always reduce_term, straight to
    // the date step. A ONE-OFF overpayment keeps its own choice, below.
    const loan = t.kind === 'loan' ? loans.find((l) => l.id === t.id) : undefined
    if (mode === 'recurring' && loan?.location === 'joint') {
      setFromLocation(undefined)
      setFromPotId(undefined)
      setRecastMode('reduce_term')
      setStep('date')
    } else if (mode === 'recurring') {
      setStep('from')
    } else {
      setStep(t.kind === 'loan' ? 'recast' : 'date')
    }
  }

  function recurringOverpaymentAmount(): LoanRecurringOverpayment['amount'] {
    return recurringAmountType === 'fixed' ? { type: 'fixed', amount: Number(amount) } : { type: 'percent_of_balance', percent: Number(recurringPercent) }
  }

  function commit() {
    if (!target) return
    if (mode === 'recurring' && target.kind === 'loan') {
      onSaveRecurring(target.id, {
        startDate: date,
        amount: recurringOverpaymentAmount(),
        location: fromLocation,
        potId: fromLocation === 'pot' ? fromPotId : undefined,
        recastMode,
      })
    } else if (target.kind === 'loan') {
      onSaveLoan(target.id, amountNumber, date, note.trim() || undefined, recastMode)
    } else {
      onSaveCard(target.id, amountNumber, date, note.trim() || undefined)
    }
    reset()
  }

  if (targets.length === 0) {
    return (
      <div className="mb-6 p-4 rounded-2xl flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">New overpayment</h2>
          <button onClick={onCancel} className="text-[var(--color-ink-muted)]">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-faint)]">
          {mode === 'recurring' ? 'Add a loan first — there\'s nothing to set a recurring overpayment against yet.' : "Add a loan or credit card first — there's nothing to log an overpayment against yet."}
        </p>
      </div>
    )
  }

  if (step === 'amount') {
    const amountValid = mode === 'recurring' ? (recurringAmountType === 'fixed' ? Number(amount) > 0 : Number(recurringPercent) > 0) : amountNumber > 0
    return (
      <div className="mb-6 p-4 rounded-2xl flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">New overpayment</h2>
          <button onClick={reset} className="text-[var(--color-ink-muted)]">
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-2">
          {OVERPAYMENT_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
              style={{ background: mode === m.value ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: mode === m.value ? '#fff' : 'var(--color-ink-muted)' }}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'recurring' && (
          <div className="flex gap-2">
            <button
              onClick={() => setRecurringAmountType('fixed')}
              className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
              style={{ background: recurringAmountType === 'fixed' ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: recurringAmountType === 'fixed' ? '#fff' : 'var(--color-ink-muted)' }}
            >
              Fixed amount
            </button>
            <button
              onClick={() => setRecurringAmountType('percent_of_balance')}
              className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
              style={{
                background: recurringAmountType === 'percent_of_balance' ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
                color: recurringAmountType === 'percent_of_balance' ? '#fff' : 'var(--color-ink-muted)',
              }}
            >
              % of balance
            </button>
          </div>
        )}
        {mode === 'recurring' && recurringAmountType === 'percent_of_balance' ? (
          <EditField key="overpayment-percent" label="Percent (%)" type="number" value={recurringPercent} onChange={setRecurringPercent} />
        ) : (
          <EditField key="overpayment-amount" label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        )}
        <FormButtonRow onCancel={reset} onSave={afterAmount} saveLabel="Continue" saveDisabled={!amountValid} />
      </div>
    )
  }

  if (step === 'to') {
    return (
      <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">To</span>
          <button onClick={reset} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {targets.map((t) => (
            <button
              key={`${t.kind}:${t.id}`}
              onClick={() => pickTarget(t)}
              className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
              style={{ background: 'var(--color-surface)' }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (step === 'from' && targetLoan) {
    return (
      <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">From</span>
          <button onClick={reset} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => {
              setFromLocation('personal')
              setFromPotId(undefined)
              setRecastMode('reduce_term')
              setStep('date')
            }}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            Personal
          </button>
          {ownerPots.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setFromLocation('pot')
                setFromPotId(p.id)
                setRecastMode('reduce_term')
                setStep('date')
              }}
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

  if (step === 'recast' && target?.kind === 'loan' && targetLoan) {
    const preview =
      mode === 'recurring'
        ? previewRecurringOverpaymentRecast(targetLoan, { startDate: date, amount: recurringOverpaymentAmount(), location: fromLocation, potId: fromPotId })
        : previewOverpaymentRecast(targetLoan, amountNumber, date)
    return (
      <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">How should this overpayment be applied?</span>
          <button onClick={reset} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <button
          onClick={() => {
            setRecastMode('reduce_payment')
            setStep('date')
          }}
          className="rounded-xl p-3 text-left"
          style={{ background: 'var(--color-surface)' }}
        >
          <p className="text-sm font-semibold text-[var(--color-ink)]">Keep the same length</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            New monthly payment: £{preview.reducePayment.newMonthlyPayment != null ? formatCurrency(preview.reducePayment.newMonthlyPayment) : '—'}
          </p>
        </button>
        <button
          onClick={() => {
            setRecastMode('reduce_term')
            setStep('date')
          }}
          className="rounded-xl p-3 text-left"
          style={{ background: 'var(--color-surface)' }}
        >
          <p className="text-sm font-semibold text-[var(--color-ink)]">Keep monthly payment the same</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            Ends {preview.reduceTerm.payoffDate ? formatMonthYear(preview.reduceTerm.payoffDate) : '—'} · estimated final repayment £
            {preview.reduceTerm.finalPayment != null ? formatCurrency(preview.reduceTerm.finalPayment) : '—'}
          </p>
        </button>
        <button
          onClick={() => setStep(mode === 'recurring' && targetLoan.location !== 'joint' ? 'from' : 'to')}
          className="text-xs self-start text-[var(--color-ink-muted)]"
        >
          Back
        </button>
      </div>
    )
  }

  if (step === 'date') {
    return <DateStep value={date} onChange={setDate} onCancel={reset} onContinue={() => setStep('final')} continueLabel={mode === 'recurring' ? 'Continue' : 'Continue'} />
  }

  // final — recurring has no note field (LoanRecurringOverpayment has
  // none); a one-off does.
  return (
    <div className="mb-6 p-4 rounded-2xl flex flex-col gap-4" style={{ background: 'var(--color-surface)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">New overpayment</h2>
        <button onClick={reset} className="text-[var(--color-ink-muted)]">
          <X size={18} />
        </button>
      </div>
      {mode === 'one_off' && <EditField key="overpayment-note" label="Note (optional)" type="text" value={note} onChange={setNote} />}
      <p className="text-xs text-[var(--color-ink-faint)]">
        {target?.label}
        {mode === 'recurring'
          ? ` — ${recurringAmountType === 'fixed' ? `£${formatCurrency(amountNumber)}` : `${amountNumber}% of balance`} every month from ${date}.`
          : ` — £${formatCurrency(amountNumber)} on ${date}.`}
      </p>
      <FormButtonRow onCancel={reset} onSave={commit} />
    </div>
  )
}

/** Transfer row — swipe to delete, tap to expand/edit. Mirrors the old SavingsTransactionRowItem/JointTransactionRowItem/PotTransactionRowItem shape, generalised across all three "other side" kinds. */
function TransferRowItem({
  t,
  savingsPots,
  pots,
  locationOptions,
  onUpdate,
  onRemove,
  shouldFlashOnMount,
  onFlashedOnMount,
}: {
  t: Transaction
  savingsPots: SavingsPot[]
  pots: Pot[]
  locationOptions: TransferLocationOption[]
  onUpdate: (updates: Partial<Pick<Transaction, 'amount' | 'date' | 'note' | 'fromLocation' | 'toLocation'>>) => void
  onRemove: () => void
  /** Batch 9 (2026-09-07, Bug 11) — true for exactly one render right
   * after this transfer was newly created, so it can flash "Transfer
   * saved." on mount (no row exists yet at the moment a brand-new
   * transfer's own save button is clicked). */
  shouldFlashOnMount?: boolean
  onFlashedOnMount?: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const { active: flashActive, message: flashMessage, trigger: triggerFlash } = useSavedFlash('Transfer updated.')
  useEffect(() => {
    if (shouldFlashOnMount) {
      triggerFlash('Transfer saved.')
      onFlashedOnMount?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const touchesPersonal = t.fromLocation?.type === 'personal' || t.toLocation?.type === 'personal'
  const isWithdrawal = t.toLocation?.type === 'personal'
  // A direct transfer with no personal leg at all (Pot ↔ Pot, etc., 2026-09
  // UAT session) doesn't fit "Deposit"/"Withdrawal" — neither side is MY
  // personal balance — so it shows both endpoints instead, and its amount
  // is shown plain (not +/- green/red) since it doesn't affect personal
  // cash either way.
  const fromLabel = transferLocationLabel(t.fromLocation, savingsPots, pots)
  const toLabel = transferLocationLabel(t.toLocation, savingsPots, pots)
  const isSalarySort = t.sourceType === 'salary_sort'

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={`${fromLabel} → ${toLabel}`}>
      <div className="relative rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
        <button onClick={() => setIsEditing((e) => !e)} className="w-full flex items-center justify-between p-3 text-left">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--color-ink)] truncate flex items-center gap-1.5">
              {isSalarySort ? (
                <>
                  <ArrowRight size={13} className="text-[var(--color-coral)] shrink-0" />
                  Salary Sort · {isWithdrawal ? fromLabel : toLabel}
                </>
              ) : (
                <>
                  {fromLabel} → {toLabel}
                  {touchesPersonal && (
                    <span
                      className="px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0"
                      style={{
                        background: 'var(--color-surface-raised)',
                        border: '1px solid var(--color-track)',
                        color: isWithdrawal ? 'var(--color-positive)' : 'var(--color-negative)',
                      }}
                    >
                      {isWithdrawal ? 'Withdrawal' : 'Deposit'}
                    </span>
                  )}
                </>
              )}
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {t.date}
              {t.status === 'pending' ? ' · Pending' : ''}
            </p>
          </div>
          <p className="text-sm font-mono font-semibold shrink-0" style={{ color: touchesPersonal ? (isWithdrawal ? 'var(--color-positive)' : 'var(--color-ink)') : 'var(--color-ink)' }}>
            {touchesPersonal ? (isWithdrawal ? '+' : '-') : ''}£{formatCurrency(t.amount)}
          </p>
        </button>
        {isEditing && (
          <EditSimpleTransactionForm
            transaction={t}
            locations={isSalarySort ? undefined : { options: locationOptions, savingsPots, pots }}
            onCancel={() => setIsEditing(false)}
            onSave={(updates) => {
              onUpdate(updates)
              setIsEditing(false)
              triggerFlash()
            }}
          />
        )}
        <SavedFlashOverlay active={flashActive} message={flashMessage} />
      </div>
    </SwipeToDelete>
  )
}

/**
 * 2026-09-09 followup (Adam-reported) — a logged loan overpayment/credit-
 * card payment's own row here, styled to match TransferRowItem exactly
 * (tap to expand an inline edit form, swipe left for the same
 * SwipeToDelete confirm every other row on this page uses) rather than
 * Loans.tsx's own LoggedPaymentList, which groups everything into one
 * card with a running total and an inline Delete button — a different UI
 * paradigm from the rest of the Transactions page.
 */
function OverpaymentRowItem({
  payment,
  label,
  category,
  onUpdate,
  onRemove,
}: {
  payment: LoggedPayment
  label: string
  category: Category | undefined
  onUpdate: (amount: number, date: string, note?: string) => void
  onRemove: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const { active: flashActive, message: flashMessage, trigger: triggerFlash } = useSavedFlash('Payment updated.')

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={label}>
      <div className="relative rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
        <button onClick={() => setIsEditing((e) => !e)} className="w-full flex items-center gap-3 p-3 text-left">
          <CategoryIcon category={category} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--color-ink)] truncate">{payment.note || label}</p>
            <p className="text-xs text-[var(--color-ink-muted)]">{payment.date}</p>
          </div>
          <p className="text-sm font-mono font-semibold shrink-0 text-[var(--color-ink)]">£{formatCurrency(payment.amount)}</p>
        </button>
        {isEditing && (
          <OverpaymentEditForm
            payment={payment}
            onCancel={() => setIsEditing(false)}
            onSave={(amount, date, note) => {
              onUpdate(amount, date, note)
              setIsEditing(false)
              triggerFlash()
            }}
          />
        )}
        <SavedFlashOverlay active={flashActive} message={flashMessage} />
      </div>
    </SwipeToDelete>
  )
}

function OverpaymentEditForm({
  payment,
  onSave,
  onCancel,
}: {
  payment: LoggedPayment
  onSave: (amount: number, date: string, note?: string) => void
  onCancel: () => void
}) {
  const [amount, setAmount] = useState(String(payment.amount))
  const [date, setDate] = useState(payment.date)
  const [note, setNote] = useState(payment.note ?? '')
  const amountNumber = Number(amount)
  const dirty = amountNumber !== payment.amount || date !== payment.date || note.trim() !== (payment.note ?? '')

  return (
    <div className="px-3 pb-3 flex flex-col gap-2 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <div className="grid grid-cols-2 gap-2 pt-2">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" value={note} onChange={setNote} />
      <FormButtonRow onCancel={onCancel} onSave={() => onSave(amountNumber, date, note || undefined)} saveDisabled={!(amountNumber > 0 && date) || !dirty} />
    </div>
  )
}

/** A joint loan's recurring overpayment ALWAYS follows the loan (see
 * resolveRecurringOverpaymentSource's own comment) — the stored
 * location/potId field is entirely ignored in that case, so the label
 * must check the loan's own jointness first rather than trust what's
 * stored. */
function overpaymentFromLabel(loan: Loan, pots: Pot[], location: 'personal' | 'pot' | undefined, potId: string | undefined): string {
  if (loan.location === 'joint') return 'Joint account'
  if (location === 'pot') return pots.find((p) => p.id === potId)?.name ?? 'a pot'
  return 'Personal'
}

/**
 * 2026-09-09 second followup (Adam-reported) — a loan's recurring
 * overpayment, once created, shown as one row here: tap to expand,
 * swipe to delete (SwipeToDelete's own built-in confirm), matching
 * TransferRecurringRow exactly rather than Loans.tsx's own
 * RecurringOverpaymentEditor (which stays as-is, unchanged, inline on
 * the Borrowing page — that's a deliberately different surface with its
 * own established UI, not rebuilt here). No separate Remove/Change
 * buttons: deleting is the swipe gesture, and recast is just one more
 * field in the same expanded editable form. The only button above the
 * editable fields is "Manage paused overpayments" (Adam's own spec).
 */
function LoanRecurringOverpaymentRow({
  loan,
  pots,
  category,
  value,
  onUpdate,
  onAssignLocation,
  onRemove,
}: {
  loan: Loan
  pots: Pot[]
  category: Category | undefined
  value: LoanRecurringOverpayment
  onUpdate: (v: LoanRecurringOverpayment) => void
  onAssignLocation: (effectiveFrom: string, location: 'personal' | 'pot', potId?: string) => void
  onRemove: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const { active: flashActive, message: flashMessage, trigger: triggerFlash } = useSavedFlash('Recurring overpayment updated.')
  const ownerPots = fundablePots(pots).filter((p) => p.personId === loan.ownerId)

  const summary =
    value.amount.type === 'fixed' ? `£${formatCurrency(value.amount.amount)}` : `${value.amount.percent}% of balance`

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={`${loan.name} recurring overpayment`}>
      <div className="relative rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
        <button onClick={() => setIsEditing((e) => !e)} className="w-full flex items-center gap-3 p-3 text-left">
          <CategoryIcon category={category} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--color-ink)] truncate">{loan.name} — recurring overpayment</p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {overpaymentFromLabel(loan, ownerPots, value.location, value.potId)} · from {value.startDate}
              {value.endDate ? ` to ${value.endDate}` : ''}
            </p>
          </div>
          <p className="text-sm font-mono font-semibold shrink-0 text-[var(--color-ink)]">{summary}</p>
        </button>
        {isEditing && (
          <LoanRecurringOverpaymentEditForm
            loan={loan}
            pots={ownerPots}
            value={value}
            onCancel={() => setIsEditing(false)}
            onSave={(v) => {
              onUpdate(v)
              setIsEditing(false)
              triggerFlash()
            }}
            onAssignLocation={onAssignLocation}
          />
        )}
        <SavedFlashOverlay active={flashActive} message={flashMessage} />
      </div>
    </SwipeToDelete>
  )
}

function LoanRecurringOverpaymentEditForm({
  loan,
  pots,
  value,
  onSave,
  onAssignLocation,
  onCancel,
}: {
  loan: Loan
  pots: Pot[]
  value: LoanRecurringOverpayment
  onSave: (v: LoanRecurringOverpayment) => void
  onAssignLocation: (effectiveFrom: string, location: 'personal' | 'pot', potId?: string) => void
  onCancel: () => void
}) {
  const [amountType, setAmountType] = useState<'fixed' | 'percent_of_balance'>(value.amount.type)
  const [fixedAmount, setFixedAmount] = useState(value.amount.type === 'fixed' ? String(value.amount.amount) : '')
  const [percent, setPercent] = useState(value.amount.type === 'percent_of_balance' ? String(value.amount.percent) : '')
  const [location, setLocation] = useState(value.location)
  const [potId, setPotId] = useState(value.potId)
  const [startDate, setStartDate] = useState(value.startDate)
  const [showEndDate, setShowEndDate] = useState(!!value.endDate)
  const [endDate, setEndDate] = useState(value.endDate ?? '')
  const [pendingConfirm, setPendingConfirm] = useState<{ changes: RecurringChangeField[]; commit: () => void } | null>(null)
  // 2026-09-09 — an amount change now goes through the full shared
  // scope->date->confirm flow (real amountHistory/amountOverrides exist
  // now, unlike before), replacing the hardcoded todayIso() this used to
  // commit against. Every other field keeps the existing flat "confirm
  // today, apply immediately" path below (unaffected, not effective-dated).
  const [changingAmount, setChangingAmount] = useState(false)

  const amount: LoanRecurringOverpayment['amount'] = amountType === 'fixed' ? { type: 'fixed', amount: Number(fixedAmount) || 0 } : { type: 'percent_of_balance', percent: Number(percent) || 0 }
  // UAT 2026-09-09 (ed-overpay-just-single) — recastMode is no longer
  // user-editable for a RECURRING overpayment: Adam's own call, after
  // seeing 'reduce_payment' re-amortise every future contractual payment
  // the moment a single-occurrence amount override landed. A ONE-OFF
  // overpayment (LoanOverpaymentForm, this file's own separate form)
  // keeps its recast choice — that one genuinely is a single, deliberate
  // event. A recurring one recomputing the payment every period it fires
  // is exactly the runaway-complexity case ledgerLoans.ts's own
  // buildLoanSchedule comment already warns about; always reduce_term.
  // Built on top of the stored value (2026-09-16): listing only the form's
  // fields here silently dropped amountEffectiveFrom/amountHistory/
  // amountOverrides/scheduleFrom on every save, e.g. editing just the end
  // date wiped a scheduled amount change.
  const draft: LoanRecurringOverpayment = { ...value, startDate, endDate: endDate || undefined, amount, location, potId: location === 'pot' ? potId : undefined, recastMode: 'reduce_term' }
  // 2026-09-16 — a start-date change goes through "which payment" too;
  // saving it straight on re-created past overpayments on the new day.
  const { changeRecurringOverpaymentStartDate } = useLedgerData()
  const startDateChanged = draft.startDate !== value.startDate
  const dirty =
    JSON.stringify(draft.amount) !== JSON.stringify(value.amount) ||
    draft.startDate !== value.startDate ||
    draft.endDate !== value.endDate ||
    draft.location !== value.location ||
    draft.potId !== value.potId
  const amountValid = amountType === 'fixed' ? Number(fixedAmount) > 0 : Number(percent) > 0

  function amountLabel(a: LoanRecurringOverpayment['amount']): string {
    return a.type === 'fixed' ? `£${formatCurrency(a.amount)}` : `${a.percent}% of balance`
  }

  const amountChanged = JSON.stringify(draft.amount) !== JSON.stringify(value.amount)
  // UAT 2026-09-09 (ed-overpay-scope-step) — "Location should be treated
  // the same as amount for recurring overpayments": now goes through the
  // same picker-first date choice + real, retroactive transaction rewrite
  // (reassignLoanRecurringOverpaymentTransactions via onAssignLocation)
  // that Bills'/Loans' own location changes already use — previously a
  // flat, non-effective-dated setting. Still no scope ("just a single
  // payment") step of its own, matching every other location field in
  // the app — see EffectiveDatedChangeFlow's scopeStep prop below.
  const locationChanged = draft.location !== value.location || (draft.location === 'pot' && draft.potId !== value.potId)

  // Every OTHER field's diff — just dates now (recast is no longer user-
  // editable, location has its own dedicated builder below) — shown
  // alongside the amount/location diff whichever path handles the save,
  // so one shared confirm step still covers everything changed together
  // (same convention BillEditPanel/LoanEditPanel use for amount+location).
  // `scope` is only ever passed from the picker flow below — dates have
  // no single-occurrence write of their own, so whenever "just a single
  // payment" was chosen for the amount, they need the same explicit
  // "this still applies permanently" note (ed-overpay-just-single
  // wording follow-up).
  function dateChanges(scope?: ChangeScope | null): RecurringChangeField[] {
    const note = scope === 'single' ? 'This applies permanently from this date, not just to the single payment above.' : undefined
    const changes: RecurringChangeField[] = []
    if (draft.startDate !== value.startDate) changes.push({ label: 'Start date', from: value.startDate, to: draft.startDate, note })
    if (draft.endDate !== value.endDate) changes.push({ label: 'End date', from: value.endDate ?? 'None', to: draft.endDate ?? 'None', note })
    return changes
  }

  function locationChangeField(scope?: ChangeScope | null): RecurringChangeField {
    return {
      label: 'Paid from',
      from: overpaymentFromLabel(loan, pots, value.location, value.potId),
      to: overpaymentFromLabel(loan, pots, draft.location, draft.potId),
      note: scope === 'single' ? 'This applies permanently from this date, not just to the single payment above.' : undefined,
    }
  }

  // UAT 2026-09-09 (retest-overpay-single-no-reamortise) — this used to
  // reuse recentAndUpcomingLoanPaymentDates directly, which returns the
  // LOAN's own schedule dates (e.g. always the 2nd of the month), not the
  // recurring overpayment's own real dates — confirmed as a real bug,
  // since the two cadences can genuinely differ. The new
  // recentAndUpcomingLoanRecurringOverpaymentDates resolves the real date
  // the same way generateLoanPaymentTransactions/the ledger itself does.
  const pickerOccurrences = recentAndUpcomingLoanRecurringOverpaymentDates(loan, new Date()).filter((o) => o.date >= value.startDate && (!value.endDate || o.date <= value.endDate))

  function handleSave() {
    // 2026-09-09 followup (Adam-reported) — "used for anything RECURRING
    // in the app that changed" applies to EVERY field here, not just
    // location: same confirm-diff modal Bills/recurring transfers show,
    // one line per changed field.
    if ((amountChanged || locationChanged || startDateChanged) && pickerOccurrences.length > 0) {
      setChangingAmount(true)
      return
    }
    const changes = dateChanges()
    if (locationChanged) changes.unshift(locationChangeField())
    if (amountChanged) changes.unshift({ label: 'Amount', from: amountLabel(value.amount), to: amountLabel(draft.amount) })

    const commit = () => {
      // No occurrences to anchor a date to yet — apply immediately, dated
      // today, same "nothing to pick from" guard Bills.tsx/LoanEditPanel use.
      if (locationChanged) onAssignLocation(todayIso(), draft.location as 'personal' | 'pot', draft.potId)
      onSave(draft)
    }
    if (changes.length > 0) {
      setPendingConfirm({ changes, commit })
    } else {
      commit()
    }
  }

  // UAT 2026-09-09 (retest2-overpay-single-no-reamortise note) — same
  // real-vs-period-date duality as pickerOccurrences above: windowEntries
  // carries both so the "manage paused payments" checklist can DISPLAY
  // the overpayment's own real dates while still comparing/writing
  // pausedDates using the period-date basis recurringOverpaymentForDate
  // actually checks against internally.
  // The last payment on or before today and the next 12, same as every
  // other "Manage upcoming payments" list (occurrenceOverrides.ts).
  const manageWindow = manageUpcomingRange(new Date())
  const windowEntries = trimToManageUpcoming(scheduledLoanRecurringOverpaymentRealDates(loan, manageWindow.start, manageWindow.end), (e) => e.date, new Date())
  const windowDates = windowEntries.map((e) => e.date)
  const periodDateFor = (realDate: string) => windowEntries.find((e) => e.date === realDate)?.periodDate ?? realDate
  const realDateFor = (periodDate: string) => windowEntries.find((e) => e.periodDate === periodDate)?.date ?? periodDate

  return (
    // No border-t here, deliberately (2026-09-09 followup, Adam-reported
    // duplicate divider) — PausedOccurrencesControl (now at the bottom,
    // see 2026-09-10 placement fix below) already owns its own top
    // border/spacing for every one of its call sites app-wide, so adding
    // a second one on this wrapper doubled up the line right above it.
    <div className="px-3 pb-3 flex flex-col gap-3">
      {changingAmount && (
        <EffectiveDatedChangeFlow
          scopeStep={
            amountChanged
              ? {
                  description: `${loan.name}'s recurring overpayment is changing from ${amountLabel(value.amount)} to ${amountLabel(draft.amount)}. Just a single payment, or every payment from then on?`,
                  singleLabel: 'Just a single payment',
                }
              : undefined
          }
          occurrences={pickerOccurrences.map((o) => ({ date: o.date, isPast: o.isPast }))}
          dateStepDescription={(scope) =>
            amountChanged
              ? scope === 'single'
                ? `${loan.name}'s recurring overpayment is changing from ${amountLabel(value.amount)} to ${amountLabel(draft.amount)} for one payment only. Which payment is this?`
                : `${loan.name}'s recurring overpayment is changing from ${amountLabel(value.amount)} to ${amountLabel(draft.amount)}. Which payment should this apply from?`
              : locationChanged
                ? `${loan.name}'s recurring overpayment is moving to ${overpaymentFromLabel(loan, pots, draft.location, draft.potId)}. Which payment should this start from? Everything before it — including already-cleared payments — stays where it was.`
                : `${loan.name}'s recurring overpayment date is changing from ${formatFullDate(value.startDate)} to ${formatFullDate(draft.startDate)}. Which payment should this start from? Everything before it stays as it was.`
          }
          buildChanges={(_effectiveFrom, scope) => {
            const changes = dateChanges(scope)
            if (locationChanged) changes.unshift(locationChangeField(scope))
            if (amountChanged) changes.unshift({ label: 'Amount', from: amountLabel(value.amount), to: amountLabel(draft.amount) })
            return changes
          }}
          onCancelAll={() => {
            setChangingAmount(false)
            onCancel()
          }}
          onCommit={(effectiveFrom, scope) => {
            // A start-date change re-dates stored overpayments from the
            // picked one after this save, so the save keeps the current date.
            let patch: LoanRecurringOverpayment = startDateChanged ? { ...draft, startDate: value.startDate } : draft
            if (amountChanged) {
              // The picker shows the overpayment's own REAL date, but
              // amountHistory/amountOverrides must be keyed by the
              // underlying loan schedule entry's date instead — the same
              // basis recurringOverpaymentForDate compares against
              // internally (see recentAndUpcomingLoanRecurringOverpaymentDates's
              // own comment). Falls back to effectiveFrom itself only if
              // the lookup somehow misses, which shouldn't happen since
              // this list is exactly where effectiveFrom came from.
              const periodDate = pickerOccurrences.find((o) => o.date === effectiveFrom)?.periodDate ?? effectiveFrom
              patch =
                scope === 'single'
                  ? { ...patch, amount: value.amount, ...applyRecurringOverpaymentSingleAmountOverride(value, draft.amount, periodDate) }
                  : { ...patch, ...applyRecurringOverpaymentAmountChange(value, draft.amount, periodDate) }
            }
            onSave(patch)
            // Location reassignment matches against the Transaction's own
            // stored `.date`, which IS the real display date — no
            // translation needed here, unlike the amount case above.
            if (locationChanged) onAssignLocation(effectiveFrom, draft.location as 'personal' | 'pot', draft.potId)
            if (startDateChanged) changeRecurringOverpaymentStartDate(loan.id, draft.startDate, effectiveFrom)
            setChangingAmount(false)
          }}
        />
      )}
      {pendingConfirm && (
        <RecurringChangeConfirmModal
          effectiveFrom={todayIso()}
          changes={pendingConfirm.changes}
          affectsClearedBalance={false}
          // 2026-09-09 followup (Adam-reported) — Cancel here used to only
          // dismiss the confirm modal, leaving the edit form open with the
          // unsaved draft still showing the changed values. Matches every
          // other cancel-out-of-a-recurring-change flow in the app now:
          // discards the draft entirely and collapses the row.
          onCancel={() => {
            setPendingConfirm(null)
            onCancel()
          }}
          onConfirm={() => {
            pendingConfirm.commit()
            setPendingConfirm(null)
          }}
        />
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setAmountType('fixed')}
          className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{ background: amountType === 'fixed' ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: amountType === 'fixed' ? '#fff' : 'var(--color-ink-muted)' }}
        >
          Fixed amount
        </button>
        <button
          onClick={() => setAmountType('percent_of_balance')}
          className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{
            background: amountType === 'percent_of_balance' ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
            color: amountType === 'percent_of_balance' ? '#fff' : 'var(--color-ink-muted)',
          }}
        >
          % of balance
        </button>
      </div>
      {amountType === 'fixed' ? (
        <EditField label="Amount (£)" type="number" value={fixedAmount} onChange={setFixedAmount} />
      ) : (
        <EditField label="Percent (%)" type="number" value={percent} onChange={setPercent} />
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Paid from</span>
        {loan.location === 'joint' ? (
          // A joint loan's recurring overpayment is always jointly
          // funded — the location field is entirely ignored in that
          // case (see resolveRecurringOverpaymentSource), so there's
          // nothing to actually pick.
          <p className="text-sm text-[var(--color-ink)] py-1">Joint account</p>
        ) : (
          <select
            value={location === 'pot' ? `pot:${potId ?? ''}` : 'personal'}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === 'personal') {
                setLocation('personal')
                setPotId(undefined)
              } else {
                setLocation('pot')
                setPotId(raw.slice(4))
              }
            }}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            <option value="personal" style={{ color: '#000' }}>
              Personal
            </option>
            {fundablePots(pots).map((p) => (
              <option key={p.id} value={`pot:${p.id}`} style={{ color: '#000' }}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </label>

      <div className="grid grid-cols-2 gap-2">
        <EditField label="Start date" type="date" value={startDate} onChange={setStartDate} />
        {showEndDate ? (
          <EditField label="End date" type="date" value={endDate} onChange={setEndDate} />
        ) : (
          <button onClick={() => setShowEndDate(true)} className="self-end text-xs font-medium pb-1" style={{ color: 'var(--color-coral)' }}>
            + Set an end date
          </button>
        )}
      </div>

      <FormButtonRow onCancel={onCancel} onSave={handleSave} saveDisabled={!dirty || !amountValid} />

      {/* Moved to the bottom (2026-09-10 UAT follow-up) to match every
          other "Manage upcoming payments" call site and the redesign's
          own placement spec — previously sat above the editable fields,
          the one call site out of 7 that didn't match. */}
      <PausedOccurrencesControl
        // windowEntries' own .date is already both the display AND
        // identity key this component's onSave/onSaveAmount/currentlyPaused
        // use (periodDateFor/realDateFor handle the underlying-schedule
        // translation internally, below) — trivial pairs, no resolution
        // concept here (UAT 2026-09-11, manage-upcoming-payments-override-
        // key-bug — matches PausedOccurrencesControl's shared prop shape).
        windowDates={windowDates.map((d) => ({ originalDate: d, date: d }))}
        currentlyPaused={new Set((value.pausedDates ?? []).map(realDateFor))}
        amountForDate={(date) => {
          const resolved = resolveRecurringOverpaymentAmount(value, periodDateFor(date))
          return resolved.type === 'fixed' ? resolved.amount : Math.round(((loan.principal * resolved.percent) / 100) * 100) / 100
        }}
        itemLabel="overpayments"
        nextPaymentPreview={(tentative) => {
          const periodWindow = windowEntries.map((e) => e.periodDate)
          const merged = setPausedLoanRecurringOverpaymentDates({ ...loan, recurringOverpayment: value }, periodWindow, tentative.map(periodDateFor))
          const nextPeriod = periodWindow.find((pd) => !merged?.pausedDates?.includes(pd))
          return nextPeriod ? realDateFor(nextPeriod) : null
        }}
        onSave={(pausedDates) => {
          const merged = setPausedLoanRecurringOverpaymentDates(
            { ...loan, recurringOverpayment: value },
            windowEntries.map((e) => e.periodDate),
            pausedDates.map(periodDateFor),
          )
          if (merged) onSave(merged)
        }}
        // The picker/pill list shows the overpayment's own REAL date
        // (windowEntries), but amountOverrides must be keyed by the
        // underlying loan schedule entry's periodDate instead — the same
        // real-vs-period-date translation the full edit flow above uses
        // (see this file's own "do not lose this" history — two separate
        // regressions came from skipping this translation). A single
        // occurrence edit here always writes a FIXED £ override for that
        // one date, even when the standing recurring amount is
        // percent-of-balance — "just this one payment" is inherently a
        // concrete number, not a re-statement of the percentage rule.
        onSaveAmount={(realDate, newAmount) => {
          const periodDate = periodDateFor(realDate)
          onSave({ ...value, ...applyRecurringOverpaymentSingleAmountOverride(value, { type: 'fixed', amount: newAmount }, periodDate) })
        }}
        isAdjusted={(realDate) => recurringOverpaymentOccurrenceAdjusted(value, periodDateFor(realDate))}
      />
    </div>
  )
}

/**
 * A recurring transfer's row in the Transfer pill — same tap-to-expand/
 * pause pattern as SavingsRecurringDepositRow below, simplified since a
 * transfer has no category/payee/split fields to edit, just amount,
 * frequency, follows-payday, and the pause checklist (reusing schedule.ts's
 * setPausedTemplateOccurrences/scheduledTemplateDates/templateOccurrencePreviews
 * — the exact same mechanism a bill/recurring-transaction template
 * already uses, via the shared PausedOccurrencesControl widget).
 */
function TransferRecurringRow({
  template,
  savingsPots,
  pots,
  locationOptions,
  payCycle,
  onUpdate,
  onRemove,
  shouldFlashOnMount,
  onFlashedOnMount,
}: {
  template: RecurringTemplate
  savingsPots: SavingsPot[]
  pots: Pot[]
  locationOptions: TransferLocationOption[]
  /** UAT 2026-09-10 (recurring-payday-date-editing, Bug A) — needed so
   * this row's own preview surfaces (next-occurrence label, "Manage
   * upcoming payments" window/pause picker) resolve a follows-payday/
   * follows-cycle-start transfer's dates the same way the real generated
   * transaction already does, instead of showing the raw, unresolved,
   * naturally-walked date. */
  payCycle?: PayCycleConfig
  onUpdate: (updates: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemove: () => void
  /** Batch 9 (2026-09-07, Bug 11) — true for exactly one render right
   * after this recurring transfer was newly created, so it can flash
   * "Transfer saved." on mount (no row exists yet at save time). */
  shouldFlashOnMount?: boolean
  onFlashedOnMount?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(template.name)
  // Batch 9 (2026-09-07, Bug 11) — the "Save changes"/"Save amount" button
  // below always edits an EXISTING recurring transfer, so "updated" is
  // always the right wording for it; a brand-new one flashes "Transfer
  // saved." on mount instead.
  const { active: flashActive, message: flashMessage, trigger: triggerFlash } = useSavedFlash('Transfer updated.')
  useEffect(() => {
    if (shouldFlashOnMount) {
      triggerFlash('Transfer saved.')
      onFlashedOnMount?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [amount, setAmount] = useState(String(template.amount))
  const [transferFrom, setTransferFrom] = useState(template.transferFrom)
  const [transferTo, setTransferTo] = useState(template.transferTo)
  // UAT 2026-09-11 — the frequency dropdown/date field used to write
  // straight through onUpdate on every change (same immediate-apply
  // behavior as the two checkboxes it replaced), which meant it never
  // participated in this row's dirty-tracking/Save-button-dimming at
  // all. Staged the same way amount/name/location already are: local
  // draft state here, only committed when Save is pressed below.
  const [freqChoice, setFreqChoice] = useState<TransferFrequencyChoice>(transferFrequencyChoiceFor(template))
  const [intervalWeeks, setIntervalWeeks] = useState(template.intervalWeeks ?? 1)
  const [anchorDate, setAnchorDate] = useState(template.anchorDate)
  const [pickingSide, setPickingSide] = useState<'from' | 'to' | null>(null)
  const [choosingEffectiveDate, setChoosingEffectiveDate] = useState(false)
  // A location-only change has no amountHistory-style mechanism to anchor
  // a date picker to (see the comment below), so it just shows the confirm
  // step directly, applying immediately today.
  const [locationOnlyConfirm, setLocationOnlyConfirm] = useState(false)
  // UAT follow-up (2026-09-08) — same "are you sure, here's what's
  // changing" confirmation Bills.tsx/Loans.tsx/RecurringTransactionEditPanel
  // already show before a recurring change commits (Adam's own spec:
  // "used for anything RECURRING in the app that changed, relating to
  // bills / transactions / loans / transfers" — transfers were the one
  // gap left). A recurring transfer's amount now goes through the same
  // amountEffectiveFrom/amountHistory engine bills/transactions already
  // use (applyTemplateAmountChange works for any RecurringTemplate,
  // transfers included — it just wasn't being called here before). The
  // From/To location fields have no such history mechanism on
  // RecurringTemplate (no transferFromHistory/transferToHistory field
  // exists), so a location-only change applies immediately once
  // confirmed, same as a loan's recurring-overpayment "Paid from" field —
  // a standing arrangement's setting, not a historized fact about a past
  // payment.
  // UAT 2026-09-08 (followup-confirm-recurring-transfer, same fix as
  // Bills.tsx's own cancelEverything) — Cancel on the effective-date
  // picker or the confirm modal must fully discard the edit and collapse
  // the row, not just step back to the previous screen.
  function cancelEverything() {
    setAmount(String(template.amount))
    setTransferFrom(template.transferFrom)
    setTransferTo(template.transferTo)
    setName(template.name)
    setFreqChoice(transferFrequencyChoiceFor(template))
    setIntervalWeeks(template.intervalWeeks ?? 1)
    setAnchorDate(template.anchorDate)
    setChoosingEffectiveDate(false)
    setLocationOnlyConfirm(false)
    setOpen(false)
  }

  const touchesPersonal = template.transferFrom?.type === 'personal' || template.transferTo?.type === 'personal'
  const isWithdrawal = template.transferTo?.type === 'personal'
  const fromLabel = transferLocationLabel(template.transferFrom, savingsPots, pots)
  const toLabel = transferLocationLabel(template.transferTo, savingsPots, pots)
  const locationsDirty = !locationsEqual(transferFrom, template.transferFrom) || !locationsEqual(transferTo, template.transferTo)
  const amountDirty = Number(amount) > 0 && Number(amount) !== template.amount
  // Bug C (UAT 2026-09-10) — a recurring transfer's own Name, same
  // pattern Bills'/recurring-Transactions' edit panels already use,
  // wired straight to onUpdate({ name }); has no historization needs
  // (unlike amount), so it rides along with whichever immediate-apply
  // path below actually fires.
  const nameDirty = name.trim().length > 0 && name.trim() !== template.name
  const resolvedFreq = resolveTransferFrequencyChoice(freqChoice)
  const freqDirty =
    resolvedFreq.frequency !== template.frequency ||
    resolvedFreq.followsPayday !== !!template.followsPayday ||
    resolvedFreq.followsCycleStart !== !!template.followsCycleStart ||
    (resolvedFreq.frequency === 'every_n_weeks' && intervalWeeks !== (template.intervalWeeks ?? 1)) ||
    (!resolvedFreq.followsPayday && !resolvedFreq.followsCycleStart && anchorDate !== template.anchorDate)
  // Frequency/anchorDate has no amountHistory-style mechanism either
  // (same reasoning as From/To above) — a standing arrangement setting,
  // applied immediately once Saved, not historized per-occurrence.
  // 2026-09-16 (Adam-reported) — a change that moves the schedule's slots
  // (date, frequency, interval) goes through the "from which payment" flow
  // and changeRecurringTemplateSchedule. Saving it straight onto the
  // template re-created every past occurrence on the new schedule. A
  // follows-payday/cycle-start toggle alone moves no slot and still saves
  // immediately.
  const { changeRecurringTemplateSchedule } = useLedgerData()
  const nextSchedule: TemplateSchedule = {
    frequency: resolvedFreq.frequency,
    intervalWeeks: resolvedFreq.frequency === 'every_n_weeks' ? intervalWeeks : template.intervalWeeks,
    anchorDate: !resolvedFreq.followsPayday && !resolvedFreq.followsCycleStart ? anchorDate : template.anchorDate,
    followsPayday: resolvedFreq.followsPayday,
    followsCycleStart: resolvedFreq.followsCycleStart,
  }
  const slotDiff = scheduleDiffers(template, nextSchedule)
  const slotChanged = slotDiff.date || slotDiff.frequency
  // Following payday / the budgeting cycle moves when payments land too, so
  // it gets the same "which payment" step: earlier transfers keep the dates
  // they actually went out on.
  const followsChanged = resolvedFreq.followsPayday !== !!template.followsPayday || resolvedFreq.followsCycleStart !== !!template.followsCycleStart
  const scheduleMoves = slotChanged || followsChanged
  const dateOnlyChange = slotDiff.date && !slotDiff.frequency && !followsChanged
  const transferScheduleLabel = (t: TemplateSchedule) =>
    t.followsPayday ? `${TRANSFER_FREQUENCY_LABELS.follows_payday}` : t.followsCycleStart ? `${TRANSFER_FREQUENCY_LABELS.follows_cycle_start}` : describeSchedule(t)
  function freqPatch(): Partial<Omit<RecurringTemplate, 'id'>> {
    if (!freqDirty) return {}
    // Slot-moving fields are never written here once there are payments
    // to anchor to — see slotChanged above.
    return { followsPayday: resolvedFreq.followsPayday, followsCycleStart: resolvedFreq.followsCycleStart }
  }

  // UAT 2026-09-10 (mup-samedate-transfer) — this used to start the window
  // at `new Date()` (today, WITH the current time-of-day), matching
  // neither Bills' own -2-months-back/+12-months-forward window nor even
  // "today" itself: a cursor date is constructed at midnight, so it's
  // always `< new Date()` (today's real wall-clock time) and gets skipped
  // straight to the NEXT occurrence — meaning a recurring transfer's
  // "Manage upcoming payments" could never show today's own occurrence,
  // let alone any past one, breaking parity with Bills/Pension/Loan-
  // overpayment/Pot/SavingsPot (all of which already use this same
  // -2/+12 window) and making it impossible to review or single-
  // occurrence-edit a transfer payment dated on or before today at all.
  // UAT 2026-09-11 (manage-upcoming-payments-override-key-bug) —
  // scheduledTemplateDates now returns { originalDate, date } pairs:
  // `date` is the payday/cycle-start-RESOLVED date for display, but
  // `originalDate` (the natural, unresolved anchor-walked date) is what
  // occurrenceOverrides/walkOccurrences actually key on. Previously this
  // returned only the resolved date as a flat string[], which was then
  // wrongly used as the override key below AND passed straight into
  // setPausedTemplateOccurrences/amountForDate/onSaveAmount as if it were
  // the natural date — for a follows-payday/follows-cycle-start transfer
  // (the only real-world case where resolved date != natural date),
  // pausing or single-occurrence-amount-editing the next occurrence via
  // "Manage upcoming payments" silently never matched a real occurrence,
  // so it appeared to save but had no effect on the real schedule.
  // The last payment on or before today and the next 12, same as every
  // other "Manage upcoming payments" list (occurrenceOverrides.ts).
  const manageWindow = manageUpcomingRange(new Date())
  const windowDates = trimToManageUpcoming(scheduledTemplateDates(template, manageWindow.start, manageWindow.end, payCycle), (d) => d.date, new Date())
  const windowOriginalDates = new Set(windowDates.map((w) => w.originalDate))
  const currentlyPaused = new Set((template.occurrenceOverrides ?? []).filter((o) => o.deleted && windowOriginalDates.has(o.originalDate)).map((o) => o.originalDate))
  const nextOccurrence = templateOccurrencePreviews(template, new Date(), 1, payCycle)[0]

  function locationChangeFields(): RecurringChangeField[] {
    const fields: RecurringChangeField[] = []
    if (!locationsEqual(transferFrom, template.transferFrom)) fields.push({ label: 'From', from: fromLabel, to: transferFrom ? transferLocationLabel(transferFrom, savingsPots, pots) : '—' })
    if (!locationsEqual(transferTo, template.transferTo)) fields.push({ label: 'To', from: toLabel, to: transferTo ? transferLocationLabel(transferTo, savingsPots, pots) : '—' })
    if (nameDirty) fields.push({ label: 'Name', from: template.name, to: name.trim() })
    if (freqDirty && !scheduleMoves) fields.push({ label: 'Frequency', from: TRANSFER_FREQUENCY_LABELS[transferFrequencyChoiceFor(template)], to: TRANSFER_FREQUENCY_LABELS[freqChoice] })
    return fields
  }

  function handleSaveClick() {
    const amountNumber = Number(amount)
    if (!amountDirty && !locationsDirty && !nameDirty && !freqDirty) return
    // A genuine standing amount change is routed through "which payment
    // should this apply from," same gate as Bills.tsx/
    // RecurringTransactionEditPanel — everything else (frequency, name,
    // followsPayday, etc.) still saves immediately via their own inline
    // handlers below, unaffected by this button.
    const hasOccurrences = recentAndUpcomingOccurrences(template, new Date(), payCycle).length > 0
    if ((amountDirty || scheduleMoves) && hasOccurrences) {
      setChoosingEffectiveDate(true)
      return
    }
    // No occurrences to anchor a date to yet (a brand-new template): nothing
    // stored can duplicate, so the schedule is written straight on.
    const scheduleFields: Partial<Omit<RecurringTemplate, 'id'>> = slotChanged ? { ...nextSchedule } : {}
    if (amountDirty) {
      // No occurrences to anchor a date to yet (a brand-new template) —
      // applies immediately, same as Bills.tsx's equivalent fallback.
      const updates: Partial<Omit<RecurringTemplate, 'id'>> = { amount: amountNumber, ...freqPatch(), ...scheduleFields }
      if (locationsDirty && transferFrom && transferTo) {
        updates.transferFrom = transferFrom
        updates.transferTo = transferTo
      }
      if (nameDirty) updates.name = name.trim()
      onUpdate(updates)
      triggerFlash()
      setOpen(false)
      return
    }
    // A pure name/frequency-only change (no amount/location dirty) has
    // nothing to confirm — same as Bills'/recurring-Transactions' Name
    // field, it just saves straight through.
    if ((nameDirty || freqDirty) && !locationsDirty) {
      const updates: Partial<Omit<RecurringTemplate, 'id'>> = { ...freqPatch(), ...scheduleFields }
      if (nameDirty) updates.name = name.trim()
      onUpdate(updates)
      triggerFlash()
      setOpen(false)
      return
    }
    // Location-only change (name may also be dirty alongside it) — no
    // amountHistory-style mechanism exists for From/To (see the state
    // comment above), so this just confirms then applies immediately
    // (today), rather than asking for a date that has nothing to anchor
    // to.
    if (transferFrom && transferTo) {
      setLocationOnlyConfirm(true)
    }
  }

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={template.name}>
      <div className="relative rounded-2xl px-4 py-3" style={{ background: 'var(--color-surface)' }}>
        {choosingEffectiveDate && (
          <EffectiveDatedChangeFlow
            scopeStep={
              amountDirty
                ? {
                    description: `${template.name} is changing from £${formatCurrency(template.amount)} to £${formatCurrency(Number(amount))}. Just a single payment, or every payment from then on?`,
                    singleLabel: 'Just a single payment',
                  }
                : dateOnlyChange
                  ? {
                      description: `${template.name}'s date is changing from ${formatFullDate(template.anchorDate)} to ${formatFullDate(nextSchedule.anchorDate)}. Just a single payment, or every payment from then on?`,
                      singleLabel: 'Just a single payment',
                    }
                  : undefined
            }
            occurrences={recentAndUpcomingOccurrences(template, new Date(), payCycle)}
            dateStepDescription={(scope) =>
              scope === 'single'
                ? `${template.name} is changing for one payment only. Which payment is this?`
                : amountDirty
                  ? `${template.name} is changing from £${formatCurrency(template.amount)} to £${formatCurrency(Number(amount))}. Which payment should the change start from? Everything before it stays as it was.`
                  : `${template.name} is changing from ${transferScheduleLabel(template)} to ${transferScheduleLabel(nextSchedule)}. Which payment should this start from? Everything before it stays as it was.`
            }
            buildChanges={(_effectiveFrom, scope) => {
              const changes: RecurringChangeField[] = amountDirty ? [{ label: 'Amount', from: `£${formatCurrency(template.amount)}`, to: `£${formatCurrency(Number(amount))}` }] : []
              if (slotDiff.frequency || followsChanged) {
                changes.push({ label: 'Schedule', from: transferScheduleLabel(template), to: transferScheduleLabel(nextSchedule), note: scope === 'single' ? 'This applies to every payment from this one on, not just the single payment above.' : undefined })
              } else if (slotDiff.date) {
                changes.push({ label: 'Date', from: formatFullDate(template.anchorDate), to: formatFullDate(nextSchedule.anchorDate) })
              }
              if (locationsDirty || freqDirty) {
                // Location/frequency have no single-occurrence write of
                // their own — make that explicit alongside the amount's
                // scope choice (UAT 2026-09-09, ed-transfers-unchanged).
                changes.push(...locationChangeFields().map((f) => ({ ...f, note: scope === 'single' ? 'This applies permanently from this date, not just to the single payment above.' : undefined })))
              }
              return changes
            }}
            affectsClearedBalance={(effectiveFrom) => effectiveFrom <= todayIso()}
            onCancelAll={cancelEverything}
            onCommit={(effectiveFrom, scope) => {
              // A location/frequency change (if any) always applies from
              // this date forward regardless of the amount's single/all-
              // future choice — neither has a single-occurrence mechanism
              // of its own.
              const amountPatch = !amountDirty
                ? {}
                : scope === 'single'
                  ? applyTemplateSingleOccurrenceAmountChange(template, Number(amount), occurrenceSlotForDate(template, effectiveFrom, payCycle))
                  : applyTemplateAmountChange(template, Number(amount), occurrenceSlotForDate(template, effectiveFrom, payCycle))
              // Same split as Bills.tsx: a single-payment date move is an
              // override; any other slot change re-slots via
              // changeRecurringTemplateSchedule, after this update.
              const singleDateMove = dateOnlyChange && scope === 'single'
              const datePatch = singleDateMove ? applyTemplateSingleOccurrenceDateChange({ ...template, ...amountPatch }, nextSchedule.anchorDate, occurrenceSlotForDate(template, effectiveFrom, payCycle)) : {}
              // A schedule move carries its own frequency/follows settings.
              const updates: Partial<Omit<RecurringTemplate, 'id'>> = { ...amountPatch, ...datePatch, ...(scheduleMoves ? {} : freqPatch()) }
              if (locationsDirty && transferFrom && transferTo) {
                updates.transferFrom = transferFrom
                updates.transferTo = transferTo
              }
              if (nameDirty) updates.name = name.trim()
              onUpdate(updates)
              if (scheduleMoves && !singleDateMove) changeRecurringTemplateSchedule(template.id, nextSchedule, effectiveFrom)
              // A single-occurrence change leaves the STANDING amount
              // untouched — reset the local draft back to it so the field
              // doesn't keep showing the one-off value as if it were now
              // the template's own amount.
              if (scope === 'single' && amountDirty) setAmount(String(template.amount))
              triggerFlash()
              setOpen(false)
              setChoosingEffectiveDate(false)
            }}
          />
        )}
        {locationOnlyConfirm && (
          <RecurringChangeConfirmModal
            effectiveFrom={todayIso()}
            changes={locationChangeFields()}
            onCancel={cancelEverything}
            onConfirm={() => {
              const updates: Partial<Omit<RecurringTemplate, 'id'>> = { ...freqPatch(), ...(slotChanged ? nextSchedule : {}) }
              if (transferFrom && transferTo) {
                updates.transferFrom = transferFrom
                updates.transferTo = transferTo
              }
              if (nameDirty) updates.name = name.trim()
              onUpdate(updates)
              triggerFlash()
              setOpen(false)
              setLocationOnlyConfirm(false)
            }}
          />
        )}
        <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
          <div className="min-w-0">
            <p className="font-body text-sm text-[var(--color-ink)] truncate flex items-center gap-1.5">
              {fromLabel} → {toLabel}
              {touchesPersonal && (
                <span
                  className="px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0"
                  style={{
                    background: 'var(--color-surface-raised)',
                    border: '1px solid var(--color-track)',
                    color: isWithdrawal ? 'var(--color-positive)' : 'var(--color-negative)',
                  }}
                >
                  {isWithdrawal ? 'Withdrawal' : 'Deposit'}
                </span>
              )}
            </p>
            <p className="text-xs text-[var(--color-ink-faint)]">
              {RECURRING_FREQUENCY_LABELS[template.frequency as RecurringFrequency] ?? template.frequency}
              {template.followsPayday ? ' · Follows payday' : ''}
              {template.followsCycleStart ? ' · Follows cycle start' : ''}
              {nextOccurrence ? ` · Next ${nextOccurrence.date}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <span className="font-mono text-sm text-[var(--color-ink)]">{touchesPersonal ? (isWithdrawal ? '+' : '-') : ''}£{formatCurrency(template.amount)}</span>
            {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
          </div>
        </button>
        {open && pickingSide && (
          <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
            <LocationStep
              title={pickingSide === 'from' ? 'From' : 'To'}
              options={locationOptions}
              excludeKey={pickingSide === 'from' ? (transferTo ? transferLocationKey(transferTo) : undefined) : transferFrom ? transferLocationKey(transferFrom) : undefined}
              onPick={(o) => {
                if (pickingSide === 'from') setTransferFrom(o.location)
                else setTransferTo(o.location)
                setPickingSide(null)
              }}
              onCancel={() => setPickingSide(null)}
            />
          </div>
        )}
        {open && !pickingSide && (
          <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: 'var(--color-track)' }}>
            {transferFrom && transferTo && (
              <div className="flex items-center gap-2">
                <button onClick={() => setPickingSide('from')} className="flex-1 min-w-0 text-left px-3 py-2 rounded-xl text-sm truncate" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}>
                  {transferLocationLabel(transferFrom, savingsPots, pots)}
                </button>
                <button
                  onClick={() => {
                    setTransferFrom(transferTo)
                    setTransferTo(transferFrom)
                  }}
                  className="shrink-0 p-2 rounded-full"
                  style={{ background: 'var(--color-bg-elevated)' }}
                  aria-label="Swap From and To"
                >
                  <ArrowLeftRight size={16} className="text-[var(--color-ink-muted)]" />
                </button>
                <button onClick={() => setPickingSide('to')} className="flex-1 min-w-0 text-left px-3 py-2 rounded-xl text-sm truncate" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}>
                  {transferLocationLabel(transferTo, savingsPots, pots)}
                </button>
              </div>
            )}
            <EditField label="Name" type="text" value={name} onChange={setName} />
            <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
            {/* Bug B (UAT 2026-09-10) — replaces the two raw followsPayday/
                followsCycleStart checkboxes with the exact dropdown
                built for the creation wizard (Adam's own spec: "remove
                the two checkboxes, and instead use the same options we
                get in the picker first frequency modal in a single
                dropdown"). Placed ABOVE the Cancel/Save row (UAT
                2026-09-11 fix) so that row stays the last visible thing
                before "Manage upcoming payments", matching every other
                edit form in the app. UAT 2026-09-11 followup — staged
                via local draft state (freqDirty) same as amount/name,
                rather than writing straight through onUpdate on every
                change; only commits when Save below is pressed. */}
            <TransferFrequencySelect
              choice={freqChoice}
              intervalWeeks={intervalWeeks}
              anchorDate={anchorDate}
              onChoiceChange={setFreqChoice}
              onIntervalWeeksChange={setIntervalWeeks}
              onAnchorDateChange={setAnchorDate}
            />
            {/* UAT 2026-09-08 (followup-confirm-recurring-transfer note) —
                was a bespoke inline text button whose label flip-flopped
                between "Save amount"/"Save changes"; now the same
                full-width Save/Cancel pair every other edit form in the
                app uses, dimmed the same way via the same dirty check. */}
            <FormButtonRow
              onCancel={() => {
                setAmount(String(template.amount))
                setTransferFrom(template.transferFrom)
                setTransferTo(template.transferTo)
                setName(template.name)
                setFreqChoice(transferFrequencyChoiceFor(template))
                setIntervalWeeks(template.intervalWeeks ?? 1)
                setAnchorDate(template.anchorDate)
                setOpen(false)
              }}
              onSave={handleSaveClick}
              saveDisabled={!amountDirty && !locationsDirty && !nameDirty && !freqDirty}
            />
            <PausedOccurrencesControl
              windowDates={windowDates}
              currentlyPaused={currentlyPaused}
              amountForDate={(date) => resolveOccurrenceAmount(template, date)}
              itemLabel="transfers"
              nextPaymentPreview={(tentative) => {
                const previewTemplate: RecurringTemplate = { ...template, ...setPausedTemplateOccurrences(template, [...windowOriginalDates], tentative) }
                return templateOccurrencePreviews(previewTemplate, new Date(), 1, payCycle)[0]?.date ?? null
              }}
              onSave={(pausedDates) => onUpdate(setPausedTemplateOccurrences(template, [...windowOriginalDates], pausedDates))}
              onSaveAmount={(originalDate, newAmount) => onUpdate(applyTemplateSingleOccurrenceAmountChange(template, newAmount, originalDate))}
              onSaveDate={(originalDate, newDate) => onUpdate(applyTemplateSingleOccurrenceDateChange(template, newDate, originalDate))}
              isAdjusted={(originalDate) => templateOccurrenceAdjusted(template, originalDate, payCycle)}
            />
          </div>
        )}
        <SavedFlashOverlay active={flashActive} message={flashMessage} />
      </div>
    </SwipeToDelete>
  )
}

// ── Recurring transactions — same schedule engine as Bills (RecurringTemplate with kind: 'transaction'), but generating plain expense/income occurrences, personal-only, with per-occurrence edit/delete on top of the standing "apply from" amount-change flow Bills already has. ──

function RecurringPaymentMethodEditor({ value, onChange }: { value: PaymentMethod; onChange: (v: PaymentMethod) => void }) {
  return (
    <label className="flex flex-col gap-1 col-span-2">
      <span className="text-xs text-[var(--color-ink-muted)]">Payment method</span>
      <div className="flex flex-wrap gap-1.5">
        {EXPENSE_PAYMENT_METHODS.map((pm) => (
          <button
            key={pm}
            onClick={() => onChange(pm)}
            className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
            style={{ background: value === pm ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: value === pm ? '#fff' : 'var(--color-ink-muted)' }}
          >
            {PAYMENT_METHOD_LABELS[pm]}
          </button>
        ))}
      </div>
    </label>
  )
}

function RecurringFrequencyEditor({
  frequency,
  intervalWeeks,
  anchorDate,
  onChange,
}: {
  frequency: RecurringFrequency
  intervalWeeks: number | undefined
  anchorDate: string
  onChange: (patch: { frequency?: RecurrenceFrequency; intervalWeeks?: number; anchorDate?: string }) => void
}) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Frequency</span>
        <select
          value={frequency}
          onChange={(e) => onChange({ frequency: e.target.value as RecurrenceFrequency })}
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
        >
          {(Object.keys(RECURRING_FREQUENCY_LABELS) as RecurringFrequency[]).map((f) => (
            <option key={f} value={f} style={{ color: '#000' }}>
              {RECURRING_FREQUENCY_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      {frequency === 'every_n_weeks' ? (
        <EditField label="Every N weeks" type="number" value={intervalWeeks ?? 2} onChange={(v) => onChange({ intervalWeeks: Math.max(1, Number(v)) })} />
      ) : (
        <EditField
          label={frequency === 'weekly' ? 'First date' : 'Due date (sets the day/month)'}
          type="date"
          value={anchorDate}
          onChange={(v) => onChange({ anchorDate: v })}
        />
      )}
      {frequency === 'every_n_weeks' && <EditField label="First date" type="date" value={anchorDate} onChange={(v) => onChange({ anchorDate: v })} />}
    </>
  )
}

type RecurringTransactionFormStep = 'direction' | 'amount' | 'location' | 'frequency' | 'date' | 'name' | 'category' | 'payment_method'

/**
 * 2026-09-13 (Adam-specified follow-up, "recurring transactions get the
 * same treatment") — same full picker-wizard shape as ExpenseForm above,
 * every editable field its own step: Direction → Amount → Location
 * (skipped when there's no non-Personal option) → Frequency → Date →
 * Name → Category → Payment method (the last step; recurring
 * transactions have no "charge to credit card" sub-flow, so this is
 * always final). `data` is now needed (for Location's option-building),
 * where previously this form only needed `categories`.
 */
function RecurringTransactionForm({
  data,
  categories,
  defaultPersonId,
  onAddCategory,
  onSave,
  onCancel,
}: {
  data: AppDataV2
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultPersonId: string
  onAddCategory: (name: string) => { id: string }
  onSave: (template: Omit<RecurringTemplate, 'id' | 'active'>) => void
  onCancel: () => void
}) {
  const [step, setStep] = useState<RecurringTransactionFormStep>('direction')
  const [type, setType] = useState<EntryType>('expense')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState<RecurringFrequency>('monthly')
  const [intervalWeeks, setIntervalWeeks] = useState(2)
  const [anchorDate, setAnchorDate] = useState(todayIso())
  const defaultCategoryId = seededCategoryIdForIcon('food')
  const [categoryId, setCategoryId] = useState(categories.some((c) => c.id === defaultCategoryId) ? defaultCategoryId : (categories[0]?.id ?? ''))

  // Same Location concept ExpenseForm's own wizard offers — see its
  // comment for the full reasoning (personal/joint/pot, never savings,
  // skipped when there's no non-Personal choice to make).
  const PERSONAL_LOCATION_OPTION: TransferLocationOption = { key: 'personal', label: 'Current Account', location: { type: 'personal' } }
  // PROMPT-13 B5, restriction 4 — nothing is spent out of a Coin Jar ad
  // hoc, so it is not an option for "where did this money come from".
  // The TRANSFER wizard's own options (transferLocationOptions, above)
  // are deliberately NOT filtered: transfers in and out are the
  // sanctioned way to move money to and from a jar.
  const pickableLocationOptions = buildTransferLocationOptions(data.savingsPots, fundablePots(data.pots), !!data.jointAccount, data.primaryPersonId).filter(
    (o) => o.location.type !== 'savings',
  )
  const nonPersonalLocationOptions = pickableLocationOptions.filter((o) => o.location.type !== 'personal')
  const [locationOption, setLocationOption] = useState<TransferLocationOption>(PERSONAL_LOCATION_OPTION)

  function commitSave(finalPaymentMethod: PaymentMethod) {
    onSave({
      name: name.trim(),
      amount: Number(amount),
      categoryId,
      paymentMethod: finalPaymentMethod,
      frequency,
      intervalWeeks: frequency === 'every_n_weeks' ? intervalWeeks : undefined,
      anchorDate,
      location: locationOption.location.type === 'joint' || locationOption.location.type === 'pot' ? locationOption.location.type : 'personal',
      potId: locationOption.location.type === 'pot' ? locationOption.location.potId : undefined,
      payee: '',
      payeeSharePercent: 100,
      ownerId: defaultPersonId,
      kind: 'transaction',
      recurringTransactionType: type,
      personId: type === 'income' ? defaultPersonId : undefined,
    })
  }

  // 2026-09-13 (Adam-specified follow-up, "mirror transfers") — Direction
  // and Amount now share ONE first screen, same shape as TransferForm's
  // own first step (mode toggle + amount together, one Continue).
  if (step === 'direction' || step === 'amount') {
    return (
      <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">New recurring transaction</h2>
          <button onClick={onCancel} className="text-[var(--color-ink-muted)]">
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-2">
          {ENTRY_TYPES.map((et) => (
            <button
              key={et.value}
              onClick={() => setType(et.value)}
              className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
              style={{ background: type === et.value ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: type === et.value ? '#fff' : 'var(--color-ink-muted)' }}
            >
              {et.label}
            </button>
          ))}
        </div>
        <EditField key="recurring-amount" label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <FormButtonRow
          onCancel={onCancel}
          onSave={() => setStep(nonPersonalLocationOptions.length > 0 ? 'location' : 'frequency')}
          saveLabel="Continue"
          saveDisabled={!(Number(amount) > 0)}
        />
      </div>
    )
  }

  if (step === 'location') {
    return (
      <LocationStep
        title="Location"
        options={[PERSONAL_LOCATION_OPTION, ...nonPersonalLocationOptions]}
        onPick={(o) => {
          setLocationOption(o)
          setStep('frequency')
        }}
        onCancel={onCancel}
      />
    )
  }

  if (step === 'frequency') {
    return (
      <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Frequency</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <label className="flex flex-col gap-1">
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {(Object.keys(RECURRING_FREQUENCY_LABELS) as RecurringFrequency[]).map((f) => (
              <option key={f} value={f} style={{ color: '#000' }}>
                {RECURRING_FREQUENCY_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        {frequency === 'every_n_weeks' && (
          <EditField label="Every N weeks" type="number" value={intervalWeeks} onChange={(v) => setIntervalWeeks(Math.max(1, Number(v)))} />
        )}
        <FormButtonRow onCancel={onCancel} onSave={() => setStep('date')} saveLabel="Continue" />
      </div>
    )
  }

  if (step === 'date') {
    return (
      <DateStep
        value={anchorDate}
        onChange={setAnchorDate}
        onCancel={onCancel}
        onContinue={() => setStep('name')}
        label={frequency === 'weekly' || frequency === 'every_n_weeks' ? 'First date' : 'Due date'}
      />
    )
  }

  if (step === 'name') {
    return (
      <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Name</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <EditField label="Name" type="text" value={name} onChange={setName} />
        <FormButtonRow onCancel={onCancel} onSave={() => setStep('category')} saveLabel="Continue" saveDisabled={!name.trim()} />
      </div>
    )
  }

  if (step === 'category') {
    return (
      <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Category</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />
        <FormButtonRow onCancel={onCancel} onSave={() => setStep('payment_method')} saveLabel="Continue" saveDisabled={!categoryId} />
      </div>
    )
  }

  // payment_method — always the last step for a recurring transaction
  // (no "charge to credit card" sub-flow the way a one-off expense has).
  // "Card" is highlighted as the default (Adam-specified) — still a
  // single tap to commit, just visually pre-picked for the common case.
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Payment method</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {EXPENSE_PAYMENT_METHODS.map((pm) => (
          <button
            key={pm}
            onClick={() => commitSave(pm)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm font-medium"
            style={{
              background: pm === 'card' ? 'var(--color-coral)' : 'var(--color-surface)',
              color: pm === 'card' ? '#fff' : 'var(--color-ink)',
            }}
          >
            {PAYMENT_METHOD_LABELS[pm]}
          </button>
        ))}
      </div>
    </div>
  )
}

type RecurringTxDraft = Omit<RecurringTemplate, 'id'>

function draftFromRecurringTemplate(template: RecurringTemplate): RecurringTxDraft {
  const { id: _id, ...rest } = template
  return rest
}

function RecurringTransactionEditPanel({
  template,
  categories,
  onAddCategory,
  onSave,
  onCancel,
}: {
  template: RecurringTemplate
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  /** UAT 2026-09-08 (followup-confirm-recurring-tx-amount note) — this
   * form had a Save button but no way to back out; collapses the row
   * without saving, matching every other edit form in the app. */
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<RecurringTxDraft>(() => draftFromRecurringTemplate(template))
  // UAT follow-up (2026-09-08), generalised 2026-09-09 into
  // EffectiveDatedChangeFlow — true while a genuine STANDING amount
  // change is being routed through "which payment does this apply from."
  const [changingAmount, setChangingAmount] = useState(false)
  const { changeRecurringTemplateSchedule } = useLedgerData()
  // 2026-09-16 (Adam-reported) — a date or frequency change now goes through
  // the same "from which payment" flow as Bills. It used to save straight
  // away, which re-created every past occurrence on the new schedule.
  const amountChanged = draft.amount !== template.amount
  const scheduleDiff = scheduleDiffers(template, draft)
  const scheduleChanged = scheduleDiff.date || scheduleDiff.frequency
  const dateOnlyChange = scheduleDiff.date && !scheduleDiff.frequency
  // UAT follow-up (2026-09-04, Adam-requested app-wide sweep): dims Save
  // when nothing's changed, same as BillEditPanel's own dirty check.
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromRecurringTemplate(template))

  function update(patch: Partial<RecurringTxDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
  }

  // UAT 2026-09-08 (followup-confirm-recurring-tx-amount, same fix as
  // Bills.tsx's own cancelEverything) — Cancel on the effective-date
  // picker or the confirm modal must fully discard the edit and collapse
  // the row, not just step back to the previous screen.
  function cancelEverything() {
    setDraft(draftFromRecurringTemplate(template))
    setChangingAmount(false)
    onCancel()
  }

  function handleSaveClick() {
    // Same gate as Bills.tsx: a genuine STANDING amount change is routed
    // through "which payment should this apply from" — every other field
    // (name, category, frequency, active, etc.) saves immediately.
    if ((amountChanged || scheduleChanged) && recentAndUpcomingOccurrences(template, new Date()).length > 0) {
      setChangingAmount(true)
      return
    }
    onSave(draft)
  }

  if (changingAmount) {
    const amountText = `£${formatCurrency(template.amount)} to £${formatCurrency(draft.amount)}`
    return (
      <EffectiveDatedChangeFlow
        scopeStep={
          amountChanged
            ? { description: `${template.name} is changing from ${amountText}. Just a single payment, or every payment from then on?`, singleLabel: 'Just a single payment' }
            : dateOnlyChange
              ? {
                  description: `${template.name}'s date is changing from ${formatFullDate(template.anchorDate)} to ${formatFullDate(draft.anchorDate)}. Just a single payment, or every payment from then on?`,
                  singleLabel: 'Just a single payment',
                }
              : undefined
        }
        occurrences={recentAndUpcomingOccurrences(template, new Date())}
        dateStepDescription={(scope) =>
          scope === 'single'
            ? `${template.name} is changing for one payment only. Which payment is this?`
            : amountChanged
              ? `${template.name} is changing from ${amountText}. Which payment should the change start from? Everything before it stays as it was.`
              : `${template.name} is changing from ${describeSchedule(template)} to ${describeSchedule(draft)}. Which payment should this start from? Everything before it stays as it was.`
        }
        buildChanges={(_effectiveFrom, scope) => {
          const changes: RecurringChangeField[] = []
          if (amountChanged) changes.push({ label: 'Amount', from: `£${formatCurrency(template.amount)}`, to: `£${formatCurrency(draft.amount)}` })
          if (scheduleDiff.frequency) {
            changes.push({
              label: 'Schedule',
              from: describeSchedule(template),
              to: describeSchedule(draft),
              note: scope === 'single' ? 'This applies to every payment from this one on, not just the single payment above.' : undefined,
            })
          } else if (scheduleDiff.date) {
            changes.push({ label: 'Date', from: formatFullDate(template.anchorDate), to: formatFullDate(draft.anchorDate) })
          }
          return changes
        }}
        affectsClearedBalance={(effectiveFrom) => effectiveFrom <= todayIso()}
        onCancelAll={cancelEverything}
        onCommit={(effectiveFrom, scope) => {
          let working = template
          let patch: Partial<Omit<RecurringTemplate, 'id'>> = {}
          if (amountChanged) {
            const amountPatch = scope === 'single' ? applyTemplateSingleOccurrenceAmountChange(working, draft.amount, occurrenceSlotForDate(template, effectiveFrom)) : applyTemplateAmountChange(working, draft.amount, occurrenceSlotForDate(template, effectiveFrom))
            working = { ...working, ...amountPatch }
            patch = { ...patch, amount: scope === 'single' ? template.amount : draft.amount, ...amountPatch }
          }
          // Same split as Bills.tsx: a single-payment date move is an
          // override; anything else re-slots via changeRecurringTemplateSchedule.
          const singleDateMove = dateOnlyChange && scope === 'single'
          if (singleDateMove) patch = { ...patch, ...applyTemplateSingleOccurrenceDateChange(working, draft.anchorDate, occurrenceSlotForDate(template, effectiveFrom)) }
          if (scheduleChanged) patch = { ...patch, anchorDate: template.anchorDate, frequency: template.frequency, intervalWeeks: template.intervalWeeks }
          onSave({ ...draft, ...patch })
          if (scheduleChanged && !singleDateMove) {
            changeRecurringTemplateSchedule(template.id, { frequency: draft.frequency, intervalWeeks: draft.intervalWeeks, anchorDate: draft.anchorDate }, effectiveFrom)
          }
          setChangingAmount(false)
        }}
      />
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <div className="col-span-2 flex gap-2">
        {(['expense', 'income'] as const).map((rt) => (
          <button
            key={rt}
            onClick={() => update({ recurringTransactionType: rt })}
            className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{
              background: draft.recurringTransactionType === rt ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
              color: draft.recurringTransactionType === rt ? '#fff' : 'var(--color-ink-muted)',
            }}
          >
            {rt === 'expense' ? 'Expense' : 'Income'}
          </button>
        ))}
      </div>

      <EditField label="Name" type="text" value={draft.name} onChange={(v) => update({ name: v })} />
      <EditField label="Amount (£)" type="number" value={draft.amount} onChange={(v) => update({ amount: Number(v) })} />
      <RecurringFrequencyEditor frequency={draft.frequency as RecurringFrequency} intervalWeeks={draft.intervalWeeks} anchorDate={draft.anchorDate} onChange={update} />
      <div className="col-span-2">
        <CategoryPicker categories={categories} value={draft.categoryId} onChange={(categoryId) => update({ categoryId })} onAddCategory={onAddCategory} />
      </div>
      <RecurringPaymentMethodEditor value={draft.paymentMethod} onChange={(paymentMethod) => update({ paymentMethod })} />

      {/* Picker-First Flows (2026-09 session) — "Whose income" removed entirely; personId/ownerId stay whatever draftFromRecurringTemplate already carried (always your primary person, set once at creation and never re-chosen here). */}

      <label className="flex items-center gap-2 col-span-2 mt-1">
        <input type="checkbox" checked={draft.active} onChange={(e) => update({ active: e.target.checked })} />
        <span className="text-xs text-[var(--color-ink-muted)]">Active (paused recurring transactions stop generating new entries)</span>
      </label>

      <div className="col-span-2 mt-1">
        <FormButtonRow onCancel={onCancel} onSave={handleSaveClick} saveDisabled={!dirty} />
      </div>
    </div>
  )
}

function RecurringTransactionRow({
  template,
  categories,
  onAddCategory,
  onUpdate,
  onRemove,
  shouldFlashOnMount,
  onFlashedOnMount,
}: {
  template: RecurringTemplate
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onUpdate: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemove: () => void
  shouldFlashOnMount?: boolean
  onFlashedOnMount?: () => void
}) {
  const [open, setOpen] = useState(false)
  const category = categories.find((c) => c.id === template.categoryId)
  // Batch 9 (2026-09-07, Bug 11) — this row is always an EXISTING
  // recurring transaction (a brand-new one flashes "Transaction saved."
  // on mount instead — see the parent list's own justCreatedId comment).
  const { active: flashActive, message: flashMessage, trigger: triggerFlash } = useSavedFlash('Transaction updated.')
  useEffect(() => {
    if (shouldFlashOnMount) {
      triggerFlash('Transaction saved.')
      onFlashedOnMount?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const isIncome = template.recurringTransactionType === 'income'

  // 2026-09-19 (PROMPT-08c Part A, Adam-specified) — "Manage upcoming
  // payments" here is now the same shared PausedOccurrencesControl, with
  // the same window (last payment on or before today + the next 12), as
  // recurring transfers. It used to be a
  // separate "Next 12 upcoming" list whose rows opened an Amount + Date
  // form and had a trash icon. The trash wrote the same `deleted` override
  // that Pause writes, so nothing is lost, and a pause can now be undone.
  // A recurring transaction has no payday resolution, so no payCycle.
  const manageWindow = manageUpcomingRange(new Date())
  const windowDates = open ? trimToManageUpcoming(scheduledTemplateDates(template, manageWindow.start, manageWindow.end), (d) => d.date, new Date()) : []
  const windowOriginalDates = new Set(windowDates.map((w) => w.originalDate))
  const currentlyPaused = new Set((template.occurrenceOverrides ?? []).filter((o) => o.deleted && windowOriginalDates.has(o.originalDate)).map((o) => o.originalDate))

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={template.name}>
      <div className="relative rounded-xl px-4 py-3" style={{ background: template.active ? 'var(--color-surface)' : 'var(--color-bg-elevated)' }}>
        <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <CategoryIcon category={category} />
            <div className="min-w-0">
              <p className="font-body text-sm" style={{ color: template.active ? 'var(--color-ink)' : 'var(--color-ink-muted)', textDecoration: template.active ? 'none' : 'line-through' }}>
                {template.name}
                {!template.active && <span className="text-[10px] font-normal no-underline"> · Paused</span>}
              </p>
              <p className="text-xs text-[var(--color-ink-faint)]">
                {isIncome ? 'Income' : 'Expense'} · {RECURRING_FREQUENCY_LABELS[(template.frequency as RecurringFrequency) ?? 'monthly']} · {PAYMENT_METHOD_LABELS[template.paymentMethod]}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <span
              className="font-mono text-sm whitespace-nowrap"
              style={{ color: !template.active ? 'var(--color-ink-muted)' : isIncome ? 'var(--color-positive)' : 'var(--color-ink)', textDecoration: template.active ? 'none' : 'line-through' }}
            >
              {isIncome ? '+' : '-'}£{formatCurrency(template.amount)}
            </span>
            {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
          </div>
        </button>

        {open && (
          <>
            <RecurringTransactionEditPanel
              template={template}
              categories={categories}
              onAddCategory={onAddCategory}
              onSave={(patch) => {
                onUpdate(patch)
                triggerFlash()
                setOpen(false)
              }}
              onCancel={() => setOpen(false)}
            />

            <PausedOccurrencesControl
              windowDates={windowDates}
              currentlyPaused={currentlyPaused}
              amountForDate={(date) => resolveOccurrenceAmount(template, date)}
              itemLabel="payments"
              nextPaymentPreview={(tentative) => {
                const previewTemplate: RecurringTemplate = { ...template, ...setPausedTemplateOccurrences(template, [...windowOriginalDates], tentative) }
                return templateOccurrencePreviews(previewTemplate, new Date(), 1)[0]?.date ?? null
              }}
              onSave={(pausedDates) => onUpdate(setPausedTemplateOccurrences(template, [...windowOriginalDates], pausedDates))}
              onSaveAmount={(originalDate, newAmount) => onUpdate(applyTemplateSingleOccurrenceAmountChange(template, newAmount, originalDate))}
              onSaveDate={(originalDate, newDate) => onUpdate(applyTemplateSingleOccurrenceDateChange(template, newDate, originalDate))}
              isAdjusted={(originalDate) => templateOccurrenceAdjusted(template, originalDate)}
            />
          </>
        )}

        <SavedFlashOverlay active={flashActive} message={flashMessage} />
      </div>
    </SwipeToDelete>
  )
}

/**
 * Phase 5 (2026-09 session) — the SavingsPot counterpart to
 * RecurringTransactionRow above, shown in the same Recurring pill list.
 * Edits/removes/pauses write straight to SavingsPot.recurringDepositAmount/
 * DayOfMonth/recurringDepositOverrides — the same fields the Wallet
 * page's own RecurringDepositEditor/PausedDepositsControl write to, so a
 * pot set up from either page is fully editable from the other. This row
 * only ever REMOVES the recurring deposit config, never the pot itself —
 * deleting the whole pot stays a Wallet-page-only action, matching how a
 * loan itself can't be deleted from Transactions either.
 */
function SavingsRecurringDepositRow({ pot, onSave }: { pot: SavingsPot; onSave: (updates: Partial<Omit<SavingsPot, 'id' | 'personId'>>) => void }) {
  const [open, setOpen] = useState(false)
  // The last deposit on or before today and the next 12, same as every
  // other "Manage upcoming payments" list (occurrenceOverrides.ts).
  // scheduledDepositDates already drops dates before the pot opened.
  const { start, end } = manageUpcomingRange(new Date())
  const windowDates = trimToManageUpcoming(scheduledDepositDates(pot, start, end), (d) => d, new Date())
  const currentlyPaused = new Set((pot.recurringDepositOverrides ?? []).filter((o) => o.deleted && windowDates.includes(o.originalDate)).map((o) => o.originalDate))
  const nextDeposit = depositOccurrencePreviews(pot, new Date(), 1)[0]

  return (
    <div className="relative rounded-xl px-4 py-3" style={{ background: 'var(--color-surface)' }}>
      <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
        <div className="min-w-0">
          <p className="font-body text-sm text-[var(--color-ink)]">{pot.name}</p>
          <p className="text-xs text-[var(--color-ink-faint)]">Savings deposit · monthly, on the {pot.recurringDepositDayOfMonth}{ordinalSuffixLocal(pot.recurringDepositDayOfMonth ?? 1)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <span className="font-mono text-sm text-[var(--color-ink)]">-£{formatCurrency(pot.recurringDepositAmount ?? 0)}</span>
          {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
        </div>
      </button>
      {open && (
        <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: 'var(--color-track)' }}>
          <p className="text-xs text-[var(--color-ink-muted)]">{nextDeposit ? `Next deposit ${nextDeposit.date}` : 'No upcoming deposit'}</p>
          <div className="grid grid-cols-2 gap-2">
            <EditField label="Amount (£)" type="number" value={pot.recurringDepositAmount ?? 0} onChange={(v) => onSave({ recurringDepositAmount: Number(v) || 0 })} />
            <EditField
              label="On day of month"
              type="number"
              value={pot.recurringDepositDayOfMonth ?? 28}
              onChange={(v) => onSave({ recurringDepositDayOfMonth: Math.min(31, Math.max(1, Number(v) || 1)) })}
            />
          </div>
          <button
            onClick={() => onSave({ recurringDepositAmount: undefined, recurringDepositDayOfMonth: undefined, recurringDepositStartDate: undefined })}
            className="text-xs self-start"
            style={{ color: 'var(--color-negative)' }}
          >
            Remove recurring deposit
          </button>
          <PausedOccurrencesControl
            // scheduledDepositDates has no payday/cycle-start resolution
            // concept — trivial pairs (UAT 2026-09-11, manage-upcoming-
            // payments-override-key-bug — matches PausedOccurrencesControl's
            // shared prop shape).
            windowDates={windowDates.map((d) => ({ originalDate: d, date: d }))}
            currentlyPaused={currentlyPaused}
            amountForDate={(date) => resolveSavingsPotDepositOccurrenceAmount(pot, date)}
            itemLabel="deposits"
            nextPaymentPreview={(tentative) => {
              const previewPot: SavingsPot = { ...pot, ...setPausedDeposits(pot, windowDates, tentative) }
              return depositOccurrencePreviews(previewPot, new Date(), 1)[0]?.date ?? null
            }}
            onSave={(pausedDates) => onSave(setPausedDeposits(pot, windowDates, pausedDates))}
            onSaveAmount={(originalDate, newAmount) => onSave(applySavingsPotSingleDepositAmountChange(pot, newAmount, originalDate))}
            isAdjusted={(originalDate) => savingsPotDepositOccurrenceAdjusted(pot, originalDate)}
          />
        </div>
      )}
    </div>
  )
}

function ordinalSuffixLocal(day: number): string {
  if (day % 10 === 1 && day !== 11) return 'st'
  if (day % 10 === 2 && day !== 12) return 'nd'
  if (day % 10 === 3 && day !== 13) return 'rd'
  return 'th'
}

/** Pots backlog item (2026-09 session) — identical shape to SavingsRecurringDepositRow above, against potLedger.ts's equivalents. */
function PotRecurringDepositRow({ pot, onSave }: { pot: Pot; onSave: (updates: Partial<Omit<Pot, 'id' | 'personId'>>) => void }) {
  const [open, setOpen] = useState(false)
  // Same window as SavingsRecurringDepositRow above.
  const { start, end } = manageUpcomingRange(new Date())
  const windowDates = trimToManageUpcoming(scheduledPotDepositDates(pot, start, end), (d) => d, new Date())
  const currentlyPaused = new Set((pot.recurringDepositOverrides ?? []).filter((o) => o.deleted && windowDates.includes(o.originalDate)).map((o) => o.originalDate))
  const nextDeposit = potDepositOccurrencePreviews(pot, new Date(), 1)[0]

  return (
    <div className="relative rounded-xl px-4 py-3" style={{ background: 'var(--color-surface)' }}>
      <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
        <div className="min-w-0">
          <p className="font-body text-sm text-[var(--color-ink)]">{pot.name}</p>
          <p className="text-xs text-[var(--color-ink-faint)]">Pot deposit · monthly, on the {pot.recurringDepositDayOfMonth}{ordinalSuffixLocal(pot.recurringDepositDayOfMonth ?? 1)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <span className="font-mono text-sm text-[var(--color-ink)]">-£{formatCurrency(pot.recurringDepositAmount ?? 0)}</span>
          {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
        </div>
      </button>
      {open && (
        <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: 'var(--color-track)' }}>
          <p className="text-xs text-[var(--color-ink-muted)]">{nextDeposit ? `Next deposit ${nextDeposit.date}` : 'No upcoming deposit'}</p>
          <div className="grid grid-cols-2 gap-2">
            <EditField label="Amount (£)" type="number" value={pot.recurringDepositAmount ?? 0} onChange={(v) => onSave({ recurringDepositAmount: Number(v) || 0 })} />
            <EditField
              label="On day of month"
              type="number"
              value={pot.recurringDepositDayOfMonth ?? 28}
              onChange={(v) => onSave({ recurringDepositDayOfMonth: Math.min(31, Math.max(1, Number(v) || 1)) })}
            />
          </div>
          <button
            onClick={() => onSave({ recurringDepositAmount: undefined, recurringDepositDayOfMonth: undefined, recurringDepositStartDate: undefined })}
            className="text-xs self-start"
            style={{ color: 'var(--color-negative)' }}
          >
            Remove recurring deposit
          </button>
          <PausedOccurrencesControl
            // scheduledPotDepositDates has no payday/cycle-start resolution
            // concept — trivial pairs (UAT 2026-09-11, manage-upcoming-
            // payments-override-key-bug — matches PausedOccurrencesControl's
            // shared prop shape).
            windowDates={windowDates.map((d) => ({ originalDate: d, date: d }))}
            currentlyPaused={currentlyPaused}
            amountForDate={(date) => resolvePotDepositOccurrenceAmount(pot, date)}
            itemLabel="deposits"
            nextPaymentPreview={(tentative) => {
              const previewPot: Pot = { ...pot, ...setPausedPotDeposits(pot, windowDates, tentative) }
              return potDepositOccurrencePreviews(previewPot, new Date(), 1)[0]?.date ?? null
            }}
            onSave={(pausedDates) => onSave(setPausedPotDeposits(pot, windowDates, pausedDates))}
            onSaveAmount={(originalDate, newAmount) => onSave(applyPotSingleDepositAmountChange(pot, newAmount, originalDate))}
            isAdjusted={(originalDate) => potDepositOccurrenceAdjusted(pot, originalDate)}
          />
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { formatCurrency } from '../lib/format'
import { PauseToggleButton } from './FormButtons'
import { NumberInput } from './NumberInput'
import { ConfirmModal } from './ConfirmModal'
import { useSavedFlash, SavedFlashOverlay } from './SavedFlash'

/**
 * "Manage upcoming payments" (2026-09-10 interaction redesign, Adam-
 * specified — PROMPT-manage-upcoming-payments-interaction-redesign-
 * 2026-09-10.md) — evolved in place again from the same-day earlier
 * redesign (PROMPT-manage-paused-payments-redesign-2026-09-10.md) rather
 * than forked, so all 7 call sites (Bills/recurring Transfers/recurring
 * overpayments/Pot+SavingsPot recurring deposits/Pension/the Salary-page
 * recurring transfer) stay in sync on one shared component.
 *
 * Every action on a row is now atomic, self-contained and immediately
 * persisted — there is no more section-level staging at all:
 *
 *  1. Pause ON — tapping an unpaused row's "Pause" badge opens a
 *     `ConfirmModal` naming the date being paused. Confirm calls
 *     `onSave` immediately with that one date added to the real
 *     `currentlyPaused` set. Cancel just closes the modal.
 *  2. Pause OFF — tapping an already-paused row's "Paused" badge
 *     un-pauses it straight away, no modal, `onSave` fires immediately.
 *  3. Amount edit — tapping the row swaps its own amount display into an
 *     editable input directly in place (no separate field below any
 *     more), and the row's Pause/Paused badge morphs into a "Save"
 *     button for as long as that row is being edited. Tapping Save opens
 *     the same `ConfirmModal` pattern, naming the date and old→new
 *     amount; Confirm calls `onSaveAmount` and the row reverts to
 *     display mode, with its badge reverting to whatever pause state it
 *     already had (pause state and amount-edit state are orthogonal —
 *     they just now share one button slot instead of two separate
 *     controls). Tapping the same row again while already editing exits
 *     edit mode without saving, same toggle-off `editingDate` already
 *     had before this redesign.
 *
 * There's no more local `checked` staging set and no section-level
 * Cancel/Save pair — `currentlyPaused` (the real prop) is the only
 * source of truth every pause badge reads from, so `nextPaymentPreview`
 * is always called with `[...currentlyPaused]` too (showing the current,
 * already-persisted "N paused · Next payment" line, not a pending one).
 *
 * The collapsed "Manage upcoming payments" trigger now toggles the
 * section open AND closed (there's no other way to close it any more,
 * since Cancel is gone).
 */
export function PausedOccurrencesControl({
  windowDates,
  currentlyPaused,
  amountForDate,
  nextPaymentPreview,
  onSave,
  itemLabel = 'payments',
  onSaveAmount,
  onSaveDate,
  isAdjusted,
}: {
  /**
   * UAT 2026-09-11 (manage-upcoming-payments-override-key-bug) —
   * `scheduledTemplateDates` now returns the natural `originalDate`
   * (occurrenceOverrides' own key) alongside the resolved/displayed
   * `date`, instead of just the resolved date. Every identity/override
   * operation below (pause toggle, amount edit, onSave/onSaveAmount,
   * React key) MUST use `.originalDate` — only rendering/sorting uses
   * `.date`. Passing the resolved date as the override key silently
   * broke pause/amount-edit for follows-payday/follows-cycle-start
   * transfers, since occurrenceOverrides and walkOccurrences both key
   * off the natural date.
   */
  windowDates: { originalDate: string; date: string }[]
  currentlyPaused: Set<string>
  amountForDate: (date: string) => number
  /** Given the full set of currently-paused dates, returns the next date that would actually go ahead — or null if nothing's scheduled. */
  nextPaymentPreview: (pausedDates: string[]) => string | null
  onSave: (pausedDates: string[]) => void
  itemLabel?: string
  /**
   * When provided, each row also gets a tap-to-edit inline amount editor
   * for that ONE occurrence — see this component's own header comment
   * for the full interaction model. `originalDate` is always the
   * occurrence's un-overridden scheduled date (the same key
   * `windowDates`/`currentlyPaused` already use), matching every
   * existing occurrenceOverrides-keyed write in the app. Omit for an
   * entity with no single-occurrence amount write at all.
   */
  onSaveAmount?: (originalDate: string, newAmount: number) => void
  /**
   * 2026-09-13 (single-occurrence date editing, Adam-specified: recurring
   * Transactions and Transfers only — not Bills, Loans, Pension, or
   * Credit Card, so left as an opt-in prop like `onSaveAmount`). Tapping
   * the date itself (a second, independent tap target from the amount)
   * swaps it into a `type="date"` input; Save opens the same confirm-
   * modal pattern, then calls this with the natural `originalDate` key
   * and the newly chosen date (also expressed as a natural date — the
   * caller/`walkOccurrences` still resolves it through payday/cycle-start
   * logic same as any other date, see `applyTemplateSingleOccurrenceDateChange`'s
   * own comment in schedule.ts).
   */
  onSaveDate?: (originalDate: string, newDate: string) => void
  /**
   * 2026-09-19 (PROMPT-08c Part A, Adam-specified) — whether a row's date
   * or amount differs from what its schedule alone would produce. Shows
   * the coral "· Adjusted" badge after the date, which used to exist only
   * on recurring transactions' own (now retired) list. Every call site
   * passes its schedule's own lib helper (templateOccurrenceAdjusted,
   * pensionOccurrenceAdjusted, …); the rule itself is isOccurrenceAdjusted.
   */
  isAdjusted?: (originalDate: string) => boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [editingKind, setEditingKind] = useState<'amount' | 'date' | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirming, setConfirming] = useState<
    | { kind: 'pause'; originalDate: string; displayDate: string }
    | { kind: 'amount'; originalDate: string; displayDate: string; oldAmount: number; newAmount: number }
    | { kind: 'date'; originalDate: string; displayDate: string; oldDate: string; newDate: string }
    | null
  >(null)
  // UAT 2026-09-11 — every save on a row (pause on/off, amount edit) now
  // flashes that ONE row green, same "collapse + flash" feedback every
  // other Save button in the app already gives (SavedFlash.tsx). Tracks
  // WHICH row via `flashDate` since `useSavedFlash`'s own `active` is a
  // single shared boolean — only the row matching `flashDate` renders the
  // overlay while it's active.
  const { active: flashActive, trigger: triggerFlash } = useSavedFlash()
  const [flashDate, setFlashDate] = useState<string | null>(null)

  function toggleExpanded() {
    setExpanded((prev) => {
      if (prev) {
        // Collapsing — nothing left mid-flight should linger for next time it opens.
        setEditingDate(null)
        setEditingKind(null)
        setConfirming(null)
      }
      return !prev
    })
  }
  function handlePauseBadgeClick(originalDate: string, displayDate: string) {
    if (currentlyPaused.has(originalDate)) {
      // Pause OFF — no confirmation, auto-save immediately.
      onSave([...currentlyPaused].filter((d) => d !== originalDate))
      setFlashDate(originalDate)
      triggerFlash()
    } else {
      // Pause ON — confirm first.
      setConfirming({ kind: 'pause', originalDate, displayDate })
    }
  }
  function startEditingAmount(originalDate: string) {
    const isSameEdit = editingDate === originalDate && editingKind === 'amount'
    setEditingDate(isSameEdit ? null : originalDate)
    setEditingKind(isSameEdit ? null : 'amount')
    setEditValue(String(amountForDate(originalDate)))
  }
  function requestSaveAmount(originalDate: string, displayDate: string) {
    const newAmount = Number(editValue)
    if (!Number.isFinite(newAmount)) return
    setConfirming({ kind: 'amount', originalDate, displayDate, oldAmount: amountForDate(originalDate), newAmount })
  }
  function startEditingDate(originalDate: string, currentDisplayDate: string) {
    const isSameEdit = editingDate === originalDate && editingKind === 'date'
    setEditingDate(isSameEdit ? null : originalDate)
    setEditingKind(isSameEdit ? null : 'date')
    setEditValue(currentDisplayDate)
  }
  function requestSaveDate(originalDate: string, displayDate: string) {
    if (!editValue) return
    setConfirming({ kind: 'date', originalDate, displayDate, oldDate: displayDate, newDate: editValue })
  }

  const nextPayment = expanded ? nextPaymentPreview([...currentlyPaused]) : null
  const sortedDates = [...windowDates].sort((a, b) => a.date.localeCompare(b.date))

  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      {!expanded ? (
        <button onClick={toggleExpanded} className="flex items-center gap-1 text-xs font-semibold text-white">
          Manage upcoming payments{currentlyPaused.size > 0 ? ` (${currentlyPaused.size} paused)` : ''}
          <ChevronDown size={14} />
        </button>
      ) : (
        // data-no-swipe (2026-09-19, Adam-reported): every call site sits
        // inside a SwipeToDelete row, and a touch in this scrolling card was
        // ambiguous between scrolling it and swiping the row to delete. Same
        // guard as the pot's "What this pot pays" checklist.
        <div data-no-swipe className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
          <button onClick={toggleExpanded} className="flex items-center gap-1 text-xs font-semibold text-white mb-2 text-left">
            Manage upcoming payments
            <ChevronUp size={14} />
          </button>
          <div className="flex flex-col gap-2 max-h-72 overflow-y-auto overscroll-contain mb-2">
            {sortedDates.map(({ originalDate, date }) => {
              const isPaused = currentlyPaused.has(originalDate)
              const isEditingAmount = editingDate === originalDate && editingKind === 'amount'
              const isEditingDate = editingDate === originalDate && editingKind === 'date'
              return (
                <div key={originalDate} className="relative shrink-0 overflow-hidden rounded-xl px-3 py-2" style={{ background: 'var(--color-surface)' }}>
                  <SavedFlashOverlay active={flashActive && flashDate === originalDate} />
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left">
                      {isEditingDate ? (
                        <input
                          type="date"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="bg-transparent border-b text-sm text-[var(--color-ink)] outline-none"
                          style={{ borderColor: 'var(--color-track)', boxSizing: 'border-box', WebkitAppearance: 'none' }}
                          autoFocus
                        />
                      ) : (
                        <span className="min-w-0">
                          <span
                            role={onSaveDate ? 'button' : undefined}
                            tabIndex={onSaveDate ? 0 : undefined}
                            className={`text-sm text-[var(--color-ink)] ${onSaveDate ? 'cursor-pointer underline decoration-dotted underline-offset-2' : ''}`}
                            onClick={(e) => {
                              if (!onSaveDate) return
                              e.stopPropagation()
                              startEditingDate(originalDate, date)
                            }}
                          >
                            {date}
                          </span>
                          {/* Outside the date's own span: its dotted underline would otherwise run under the badge too. */}
                          {isAdjusted?.(originalDate) && <span className="text-xs text-[var(--color-coral)]"> · Adjusted</span>}
                        </span>
                      )}
                      {isEditingAmount ? (
                        <span className="flex items-center gap-1 font-mono text-sm text-[var(--color-ink)]">
                          £
                          <NumberInput
                            value={editValue}
                            onChange={setEditValue}
                            className="w-20 bg-transparent border-b text-right outline-none font-mono text-sm text-[var(--color-ink)]"
                            style={{ borderColor: 'var(--color-track)' }}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                          />
                        </span>
                      ) : (
                        <span
                          role={onSaveAmount ? 'button' : undefined}
                          tabIndex={onSaveAmount ? 0 : undefined}
                          className={`font-mono text-sm text-[var(--color-ink)] ${onSaveAmount ? 'cursor-pointer' : ''}`}
                          onClick={(e) => {
                            if (!onSaveAmount) return
                            e.stopPropagation()
                            startEditingAmount(originalDate)
                          }}
                        >
                          £{formatCurrency(amountForDate(originalDate))}
                        </span>
                      )}
                    </div>
                    {isEditingAmount ? (
                      <button
                        onClick={() => requestSaveAmount(originalDate, date)}
                        className="shrink-0 px-3 py-1 rounded-full text-xs font-semibold text-white"
                        style={{ background: 'var(--color-coral)' }}
                      >
                        Save
                      </button>
                    ) : isEditingDate ? (
                      <button
                        onClick={() => requestSaveDate(originalDate, date)}
                        className="shrink-0 px-3 py-1 rounded-full text-xs font-semibold text-white"
                        style={{ background: 'var(--color-coral)' }}
                      >
                        Save
                      </button>
                    ) : (
                      <PauseToggleButton paused={isPaused} onClick={() => handlePauseBadgeClick(originalDate, date)} />
                    )}
                  </div>
                </div>
              )
            })}
            {sortedDates.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] px-1">Nothing scheduled to pick from — no upcoming or recent {itemLabel}.</p>}
          </div>
          <p className="text-xs text-[var(--color-ink-muted)]">
            {currentlyPaused.size} paused · Next payment: {nextPayment ?? 'none scheduled'}
          </p>
        </div>
      )}
      {confirming?.kind === 'pause' && (
        <ConfirmModal
          title="Pause this payment?"
          description={`The payment on ${confirming.displayDate} for £${formatCurrency(amountForDate(confirming.originalDate))} won't go ahead until you resume it.`}
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          onConfirm={() => {
            onSave([...currentlyPaused, confirming.originalDate])
            setFlashDate(confirming.originalDate)
            triggerFlash()
            setConfirming(null)
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming?.kind === 'amount' && (
        <ConfirmModal
          title="Update this payment?"
          description={`Changes the payment on ${confirming.displayDate} from £${formatCurrency(confirming.oldAmount)} to £${formatCurrency(confirming.newAmount)}. Every other payment — before and after — is unaffected.`}
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          onConfirm={() => {
            onSaveAmount?.(confirming.originalDate, confirming.newAmount)
            setFlashDate(confirming.originalDate)
            triggerFlash()
            setConfirming(null)
            setEditingDate(null)
            setEditingKind(null)
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming?.kind === 'date' && (
        <ConfirmModal
          title="Move this payment?"
          description={`Moves the payment on ${confirming.oldDate} to ${confirming.newDate}. Every other payment — before and after — is unaffected.`}
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          onConfirm={() => {
            onSaveDate?.(confirming.originalDate, confirming.newDate)
            setFlashDate(confirming.originalDate)
            triggerFlash()
            setConfirming(null)
            setEditingDate(null)
            setEditingKind(null)
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}

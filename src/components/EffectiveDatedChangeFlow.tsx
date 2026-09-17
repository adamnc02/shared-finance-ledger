import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { formatFullDate } from '../lib/format'
import { CancelButton, SaveButton } from './FormButtons'

// 2026-09-09 — generalises the picker-first flow Bills.tsx/TransferRecurringRow
// already share (occurrence picker → diff confirm) into one orchestrating
// component, reused everywhere a change to something recurring needs to say
// "which payment does this apply from." Adam's spec: an optional "just a
// single payment / all future payments" question up front (skipped by
// Pots/Savings Pots, and by anything — like a loan's own monthlyPayment —
// with no real single-occurrence write to make), then the existing
// occurrence-date picker, then the existing diff-confirm screen. Every step
// gets a top-right ✕ that fully cancels (calls the caller's own
// cancelEverything-style reset), and Back/Continue everywhere except the
// final step, which becomes Cancel/Save.
export type ChangeScope = 'single' | 'all_future'

export interface RecurringChangeField {
  /** Short sub-header, e.g. "Amount", "Location" — rendered upper-case. */
  label: string
  from: string
  to: string
  /**
   * UAT 2026-09-09 (ed-bills-amount-and-location) — for a field with no
   * single-occurrence write of its own (e.g. Location, which always
   * applies from the chosen date forward), shown under that field's row
   * to make explicit that it's NOT scoped by the "just a single payment"
   * choice above it, even though other fields in the same list are.
   * Callers should set this whenever `scope === 'single'` but the field
   * itself is being committed permanently anyway.
   */
  note?: string
}

interface ScopeStepConfig {
  description: string
  /** "Just this payment" (Salary — date's already fixed) vs "Just a single payment" (everything else — still has to pick one). */
  singleLabel: string
}

export function EffectiveDatedChangeFlow({
  scopeStep,
  /** Salary's shortcut: the date is already fixed by which pay-period row is open, so there's no visible date step — choosing a scope goes straight to confirm using this date. */
  fixedEffectiveFrom,
  occurrences,
  dateStepDescription,
  buildChanges,
  affectsClearedBalance,
  onCancelAll,
  onCommit,
}: {
  scopeStep?: ScopeStepConfig
  fixedEffectiveFrom?: string
  occurrences: { date: string; isPast: boolean }[]
  /**
   * UAT 2026-09-09 (retest-bills-amount-and-location-wording) — a plain
   * string always read as forward-looking ("which payment should the new
   * amount START FROM"), which is wrong once "just a single payment" was
   * chosen on the step before this one. Callers with a scopeStep should
   * word this differently per scope; callers with no scopeStep at all
   * (nothing to disambiguate) can keep passing a plain string.
   */
  dateStepDescription: string | ((scope: ChangeScope | null) => string)
  buildChanges: (effectiveFrom: string, scope: ChangeScope | null) => RecurringChangeField[]
  affectsClearedBalance?: (effectiveFrom: string) => boolean
  onCancelAll: () => void
  onCommit: (effectiveFrom: string, scope: ChangeScope | null) => void
}) {
  const [step, setStep] = useState<'scope' | 'date' | 'confirm'>(scopeStep ? 'scope' : fixedEffectiveFrom ? 'confirm' : 'date')
  const [scope, setScope] = useState<ChangeScope | null>(null)
  const [effectiveFrom, setEffectiveFrom] = useState<string | null>(fixedEffectiveFrom ?? null)

  const hasDateStep = !fixedEffectiveFrom
  const isFirstStep = step === 'scope' || (step === 'date' && !scopeStep)

  function chooseScope(chosen: ChangeScope) {
    setScope(chosen)
    if (fixedEffectiveFrom) setStep('confirm')
    else setStep('date')
  }

  function chooseDate(date: string) {
    setEffectiveFrom(date)
    setStep('confirm')
  }

  function goBack() {
    if (step === 'confirm') setStep(hasDateStep ? 'date' : 'scope')
    else if (step === 'date') setStep('scope')
  }

  if (step === 'scope' && scopeStep) {
    return (
      <FlowSheet title="Apply this change to…" onCancelAll={onCancelAll}>
        <p className="text-sm text-[var(--color-ink-muted)] mb-4">{scopeStep.description}</p>
        <div className="flex flex-col gap-2">
          <button onClick={() => chooseScope('single')} className="w-full py-2.5 rounded-full text-sm font-semibold" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}>
            {scopeStep.singleLabel}
          </button>
          <button onClick={() => chooseScope('all_future')} className="w-full py-2.5 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-coral)' }}>
            This and all future payments
          </button>
        </div>
      </FlowSheet>
    )
  }

  if (step === 'date') {
    const description = typeof dateStepDescription === 'function' ? dateStepDescription(scope) : dateStepDescription
    return (
      <FlowSheet title={scope === 'single' ? 'Which payment does this affect?' : 'Apply this change from…'} onCancelAll={onCancelAll} onBack={!isFirstStep ? goBack : undefined}>
        <p className="text-sm text-[var(--color-ink-muted)] mb-4">{description}</p>
        <div className="flex flex-col gap-2">
          {occurrences.map((o) => (
            <button
              key={o.date}
              onClick={() => chooseDate(o.date)}
              className="w-full py-2.5 rounded-full text-sm font-semibold flex items-center justify-center gap-2"
              style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}
            >
              {formatFullDate(o.date)}
              {o.isPast && <span className="text-xs font-normal text-[var(--color-ink-muted)]">(most recent)</span>}
            </button>
          ))}
        </div>
      </FlowSheet>
    )
  }

  // step === 'confirm'
  const resolvedEffectiveFrom = effectiveFrom!
  const changes = buildChanges(resolvedEffectiveFrom, scope)
  return (
    <FlowSheet title="Are you sure?" onCancelAll={onCancelAll} onBack={!isFirstStep ? goBack : undefined} final>
      <p className="text-sm text-[var(--color-ink-muted)] mb-1">
        {
          // UAT 2026-09-09 (ed-bills-amount-and-location) — "all payments
          // from and including..." was shown even when "just a single
          // payment" was chosen, which is simply wrong for that scope —
          // exactly one payment is changing, not every one from that date
          // on. Per-field notes (below) still cover the case where a
          // field WITHOUT a single-occurrence write (e.g. Location) rides
          // along in the same edit and applies permanently regardless.
          scope === 'single'
            ? `Only the payment on ${formatFullDate(resolvedEffectiveFrom)} will see the following change${changes.length === 1 ? '' : 's'}:`
            : `All payments from and including ${formatFullDate(resolvedEffectiveFrom)} will see the following change${changes.length === 1 ? '' : 's'}:`
        }
      </p>
      {affectsClearedBalance?.(resolvedEffectiveFrom) && (
        <p className="text-xs italic mb-3" style={{ color: 'var(--color-negative)' }}>
          This will adjust your current balance if cleared payments are included.
        </p>
      )}
      <div className="flex flex-col gap-3 mt-2 mb-2">
        {changes.map((change) => (
          <div key={change.label} className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
            <p className="text-[10px] font-semibold tracking-wide uppercase text-[var(--color-ink-faint)] mb-1">{change.label}</p>
            <p className="text-sm text-[var(--color-ink)] flex items-center gap-2 flex-wrap">
              <span>{change.from}</span>
              <span className="text-[var(--color-ink-muted)]">→</span>
              <span className="font-semibold">{change.to}</span>
            </p>
            {change.note && <p className="text-xs italic text-[var(--color-ink-faint)] mt-1">{change.note}</p>}
          </div>
        ))}
      </div>
      <FlowButtonRow onBack={!isFirstStep ? goBack : undefined} onCommit={() => onCommit(resolvedEffectiveFrom, scope)} final />
    </FlowSheet>
  )
}

function FlowSheet({
  title,
  onCancelAll,
  onBack,
  final,
  children,
}: {
  title: string
  onCancelAll: () => void
  onBack?: () => void
  final?: boolean
  children: React.ReactNode
}) {
  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancelAll}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 mb-1">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{title}</h3>
          <button onClick={onCancelAll} aria-label="Cancel" className="shrink-0 p-1 -m-1 text-[var(--color-ink-faint)]">
            <X size={18} />
          </button>
        </div>
        {children}
        {!final && <FlowButtonRow onBack={onBack} />}
      </div>
    </div>,
    document.body,
  )
}

/**
 * Back/Continue on every non-final step; Cancel/Save on the final one
 * (per Adam's spec) — "Continue" has nothing to advance on its own (the
 * option buttons above it already advance the flow), so it's only ever
 * rendered here as the final step's Save, with Back alongside it.
 */
function FlowButtonRow({ onBack, onCommit, final }: { onBack?: () => void; onCommit?: () => void; final?: boolean }) {
  if (!final) {
    if (!onBack) return null
    return (
      <div className="flex gap-2 mt-4">
        <CancelButton onClick={onBack} label="Back" />
      </div>
    )
  }
  return (
    <div className="flex gap-2 mt-4">
      {onBack && <CancelButton onClick={onBack} label="Back" />}
      <SaveButton onClick={onCommit!} label="Save" />
    </div>
  )
}

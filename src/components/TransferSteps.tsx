// UAT Batch 4 (2026-09-04) — shared picker-modal steps for the
// deposit/withdrawal/recurring-transfer wizards Adam specified: amount →
// location(s) → frequency (→ weeks, if every-N-weeks) → date (skipped if
// follows payday/cycle). Used by BOTH Salary.tsx's Wallet-page pot/
// savings-pot/joint deposit/withdrawal/recurring flows AND Expenses.tsx's
// Transactions-page Transfer pill, so the two never drift apart on step
// order or wording. Visual shape lifted from the app's existing
// picker-first cards (PersonPickerCard etc.) — a rounded-2xl bg-elevated
// card, header row with a label + X to cancel, full-width tappable rows.

import { X } from 'lucide-react'
import { EditField } from './EditField'
import { FormButtonRow } from './FormButtons'
import { NumberInput } from './NumberInput'
import type { RecurrenceFrequency } from '../types/ledger'
import type { TransferLocationOption } from '../lib/transferLedger'

/** A frequency choice as shown in the picker — the two "follows" options aren't real RecurrenceFrequency values, they're a monthly-cadence transfer whose DATE additionally resolves against payday/cycle-start (see schedule.ts's generateTransactionsForTemplate). Grouped into one flat list here since that's the choice Adam actually wants presented, even though the data underneath is a frequency PLUS a follows-flag. */
export type TransferFrequencyChoice = RecurrenceFrequency | 'follows_payday' | 'follows_cycle_start'

export const TRANSFER_FREQUENCY_LABELS: Record<TransferFrequencyChoice, string> = {
  weekly: 'Weekly',
  every_n_weeks: 'Every N weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annually',
  follows_payday: 'Follow payday',
  follows_cycle_start: 'Follow my budgeting cycle',
}

export const TRANSFER_FREQUENCY_ORDER: TransferFrequencyChoice[] = [
  'weekly',
  'every_n_weeks',
  'monthly',
  'quarterly',
  'annual',
  'follows_payday',
  'follows_cycle_start',
]

/** Resolves a picked choice into the real RecurringTemplate fields it implies. */
export function resolveTransferFrequencyChoice(choice: TransferFrequencyChoice): {
  frequency: RecurrenceFrequency
  followsPayday: boolean
  followsCycleStart: boolean
} {
  if (choice === 'follows_payday') return { frequency: 'monthly', followsPayday: true, followsCycleStart: false }
  if (choice === 'follows_cycle_start') return { frequency: 'monthly', followsPayday: false, followsCycleStart: true }
  return { frequency: choice, followsPayday: false, followsCycleStart: false }
}

/** The inverse of resolveTransferFrequencyChoice — for prefilling the picker when editing an already-configured template. */
export function transferFrequencyChoiceFor(template: { frequency: RecurrenceFrequency; followsPayday?: boolean; followsCycleStart?: boolean }): TransferFrequencyChoice {
  if (template.followsPayday) return 'follows_payday'
  if (template.followsCycleStart) return 'follows_cycle_start'
  return template.frequency
}

/** Step: amount only. */
export function AmountStep({
  value,
  onChange,
  onCancel,
  onContinue,
}: {
  value: string
  onChange: (v: string) => void
  onCancel: () => void
  onContinue: () => void
}) {
  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Amount</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <EditField label="Amount (£)" type="number" value={value} onChange={onChange} />
      <FormButtonRow onCancel={onCancel} onSave={onContinue} saveLabel="Continue" saveDisabled={!(Number(value) > 0)} />
    </div>
  )
}

/** Step: pick one location from a list, optionally excluding one key (e.g. the other side already picked, or the entity this wizard is running from). */
export function LocationStep({
  title,
  options,
  excludeKey,
  onPick,
  onCancel,
}: {
  title: string
  options: TransferLocationOption[]
  excludeKey?: string
  onPick: (option: TransferLocationOption) => void
  onCancel: () => void
}) {
  const pickable = options.filter((o) => o.key !== excludeKey)
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">{title}</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {pickable.map((o) => (
          <button
            key={o.key}
            onClick={() => onPick(o)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Step: pick a frequency (the flat 7-option list) — "Every N weeks" reveals its own weeks-count field inline before Continue, matching Adam's "step 3a" spec without a genuinely separate step. */
export function FrequencyStep({
  choice,
  intervalWeeks,
  onChoiceChange,
  onIntervalWeeksChange,
  onCancel,
  onContinue,
}: {
  choice: TransferFrequencyChoice | null
  intervalWeeks: number
  onChoiceChange: (c: TransferFrequencyChoice) => void
  onIntervalWeeksChange: (n: number) => void
  onCancel: () => void
  onContinue: () => void
}) {
  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">How often?</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {TRANSFER_FREQUENCY_ORDER.map((c) => (
          <button
            key={c}
            onClick={() => onChoiceChange(c)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm"
            style={{ background: choice === c ? 'var(--color-coral)' : 'var(--color-surface)', color: choice === c ? '#fff' : 'var(--color-ink)' }}
          >
            {TRANSFER_FREQUENCY_LABELS[c]}
          </button>
        ))}
      </div>
      {choice === 'every_n_weeks' && (
        <NumberInput
          value={intervalWeeks}
          onChange={(v) => onIntervalWeeksChange(Math.max(1, Number(v) || 1))}
          inputMode="decimal"
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
        />
      )}
      <FormButtonRow onCancel={onCancel} onSave={onContinue} saveLabel="Continue" saveDisabled={!choice} />
    </div>
  )
}

/**
 * Drop-in select variant of FrequencyStep, for an already-expanded EDIT
 * form (Expenses.tsx's TransferRecurringRow) rather than the creation
 * wizard's own full-screen step — no Cancel/Continue chrome, just the
 * dropdown itself plus whatever conditional fields the choice implies,
 * exactly Adam's own spec: "remove the two checkboxes, and instead use
 * the same options we get in the picker first frequency modal in a
 * single dropdown, and only show the date/calendar picker in the form if
 * the selected dropdown value is not follow payday or follow budgeting
 * cycle." (UAT 2026-09-10, recurring-payday-date-editing.) Reveals the
 * interval-weeks field for `every_n_weeks` and the date field for every
 * other real frequency, matching FrequencyStep+DateStep's combined
 * behaviour in the creation wizard.
 */
export function TransferFrequencySelect({
  choice,
  intervalWeeks,
  anchorDate,
  onChoiceChange,
  onIntervalWeeksChange,
  onAnchorDateChange,
}: {
  choice: TransferFrequencyChoice
  intervalWeeks: number
  anchorDate: string
  onChoiceChange: (c: TransferFrequencyChoice) => void
  onIntervalWeeksChange: (n: number) => void
  onAnchorDateChange: (v: string) => void
}) {
  const isFollowChoice = choice === 'follows_payday' || choice === 'follows_cycle_start'
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Frequency</span>
        <select
          value={choice}
          onChange={(e) => onChoiceChange(e.target.value as TransferFrequencyChoice)}
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
        >
          {TRANSFER_FREQUENCY_ORDER.map((c) => (
            <option key={c} value={c} style={{ color: '#000' }}>
              {TRANSFER_FREQUENCY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      {choice === 'every_n_weeks' && (
        <EditField label="Every N weeks" type="number" value={String(intervalWeeks)} onChange={(v) => onIntervalWeeksChange(Math.max(1, Number(v) || 1))} />
      )}
      {!isFollowChoice && <EditField label="Date" type="date" value={anchorDate} onChange={onAnchorDateChange} />}
    </div>
  )
}

/** Step: a plain date picker — skipped by the caller entirely when the frequency choice was "follows payday"/"follows cycle start". */
export function DateStep({
  value,
  onChange,
  onCancel,
  onContinue,
  continueLabel = 'Continue',
  label = 'Date',
}: {
  value: string
  onChange: (v: string) => void
  onCancel: () => void
  onContinue: () => void
  continueLabel?: string
  /** Header/field label — defaults to "Date"; a caller with a more specific meaning (e.g. "First date"/"Due date" for a recurring schedule) can override both at once. */
  label?: string
}) {
  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">{label}</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <EditField label={label} type="date" value={value} onChange={onChange} />
      <FormButtonRow onCancel={onCancel} onSave={onContinue} saveLabel={continueLabel} />
    </div>
  )
}

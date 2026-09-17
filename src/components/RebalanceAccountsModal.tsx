import { useState } from 'react'
import { createPortal } from 'react-dom'
import { EditField } from './EditField'
import { FormButtonRow, CancelButton, SaveButton } from './FormButtons'
import { todayIso } from '../lib/date'

/**
 * "Rebalance all accounts" (2026-09-09 session, Adam-specified) — a wide
 * button at the bottom of the Wallet page that lets Adam pick any mix of
 * Pots/Savings Pots/Joint Account/Current Accounts and, one at a time,
 * give each a fresh opening balance + opening date. This deliberately
 * doesn't need any new "hide history" mechanism: every one of these
 * entities already folds its balance from `openingBalance` forward and
 * ignores anything dated before its own `openingDate`/`openingBalanceDate`
 * (see potLedger.ts/savingsPotLedger.ts/jointAccountLedger.ts/
 * projection.ts) — so setting a new opening balance/date here is already,
 * per-account, the "wipe prior history out of the running balance" reset
 * Adam asked for. Nothing here computes a balance; it only writes the two
 * anchor fields the rest of the app already respects.
 */
export interface RebalanceTarget {
  key: string
  label: string
  sublabel?: string
}

export function RebalanceAccountsModal({
  targets,
  onCancel,
  onSave,
}: {
  targets: RebalanceTarget[]
  onCancel: () => void
  /** One entry per selected target, in the order they were stepped through. */
  onSave: (results: { key: string; amount: number; date: string }[]) => void
}) {
  const [step, setStep] = useState<'select' | number>('select')
  const [selected, setSelected] = useState<string[]>([])
  const [values, setValues] = useState<Record<string, { amount: string; date: string }>>({})

  const toggle = (key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  if (step === 'select') {
    return createPortal(
      <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
        <div
          className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
          style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">Rebalance accounts</h2>
          <p className="text-xs text-[var(--color-ink-muted)] mb-4">
            Select which accounts to rebalance. You'll give each one a new opening balance and date next — anything
            recorded before that date stops counting toward that account's balance.
          </p>

          <div className="flex flex-col gap-2 mb-2">
            {targets.map((t) => (
              <label
                key={t.key}
                className="flex items-center gap-3 rounded-xl p-3 cursor-pointer"
                style={{ background: 'var(--color-bg-elevated)' }}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(t.key)}
                  onChange={() => toggle(t.key)}
                  className="w-4 h-4 shrink-0"
                />
                <div>
                  <p className="text-sm font-medium text-[var(--color-ink)]">{t.label}</p>
                  {t.sublabel && <p className="text-xs text-[var(--color-ink-muted)]">{t.sublabel}</p>}
                </div>
              </label>
            ))}
          </div>

          <FormButtonRow
            cancelLabel="Cancel"
            saveLabel="Next"
            onCancel={onCancel}
            onSave={() => setStep(0)}
            saveDisabled={selected.length === 0}
          />
        </div>
      </div>,
      document.body,
    )
  }

  // 2026-09-09 followup (Adam-reported) — step through selected accounts
  // in the same fixed order they're listed in on the checklist, not
  // click order. Click order made the walkthrough depend on which
  // order the boxes happened to get ticked in, which is where "Joint
  // Account never appeared in the flow" came from — it hadn't actually
  // vanished, it was just wherever the click order put it, easy to lose
  // track of. This makes the sequence predictable and matches what's on
  // screen in the checklist.
  const orderedSelected = targets.filter((t) => selected.includes(t.key)).map((t) => t.key)
  const key = orderedSelected[step]
  const target = targets.find((t) => t.key === key)!
  const current = values[key] ?? { amount: '', date: todayIso() }
  const isLast = step === orderedSelected.length - 1
  const amountNumber = Number(current.amount)
  const canProceed = current.amount.trim() !== '' && !Number.isNaN(amountNumber) && !!current.date

  const setCurrent = (patch: Partial<{ amount: string; date: string }>) => {
    setValues((prev) => ({ ...prev, [key]: { ...current, ...patch } }))
  }

  const advance = () => {
    if (isLast) {
      onSave(
        orderedSelected.map((k) => ({
          key: k,
          amount: Number(values[k]?.amount ?? 0),
          date: values[k]?.date ?? todayIso(),
        })),
      )
      return
    }
    setStep(step + 1)
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[10px] font-semibold tracking-wide uppercase text-[var(--color-ink-faint)] mb-1">
          {step + 1} of {orderedSelected.length}
        </p>
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-4">{target.label}</h2>

        <div className="flex flex-col gap-3">
          <EditField label="New opening balance (£)" type="number" value={current.amount} onChange={(v) => setCurrent({ amount: v })} />
          <EditField label="New opening date" type="date" value={current.date} onChange={(v) => setCurrent({ date: v })} />
        </div>

        <div className="flex gap-2 mt-4">
          <CancelButton label="Back" onClick={() => (step === 0 ? setStep('select') : setStep(step - 1))} />
          <SaveButton label={isLast ? 'Save' : 'Next'} onClick={advance} disabled={!canProceed} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

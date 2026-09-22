import { useState } from 'react'
import { createPortal } from 'react-dom'
import { EditField } from './EditField'
import { FormButtonRow, SaveButton } from './FormButtons'
import { todayIso } from '../lib/date'

/**
 * Non-dismissable by design (Adam-specified, 2026-09-03: "it should be
 * non optional") — no X, no backdrop-click-to-close, rendered whenever
 * needsJointAccountSetup(data) is true (see AppGuards.tsx). Once a joint-
 * location bill/loan exists, the app can't compute the joint account's
 * own balance without a real opening figure to anchor from — same reason
 * CreditCard.currentBalance/balanceAsOfDate is a required pairing, not
 * an optional one.
 *
 * Reused for the Wallet page's own "edit" affordance too (see Salary.tsx)
 * — same form, but that call site passes `dismissable` and an `initial`
 * value, and IS closeable, since at that point the account already
 * exists and this is just a correction.
 */
export function JointAccountSetupModal({
  initial,
  dismissable,
  onSave,
  onCancel,
}: {
  initial?: { openingBalance: number; openingBalanceDate: string; overdraftAmount?: number }
  dismissable?: boolean
  onSave: (openingBalance: number, openingBalanceDate: string, overdraftAmount: number) => void
  onCancel?: () => void
}) {
  const [openingBalance, setOpeningBalance] = useState(initial ? String(initial.openingBalance) : '')
  const [openingBalanceDate, setOpeningBalanceDate] = useState(initial?.openingBalanceDate ?? todayIso())
  // PROMPT-15 — how far below zero the joint account may go; 0 = none. Only
  // the 8pm low-balance alert reads it.
  const [overdraft, setOverdraft] = useState(initial?.overdraftAmount ? String(initial.overdraftAmount) : '')

  const amount = Number(openingBalance)
  // Never negative: a negative overdraft would invert the alert's floor to
  // +£500 and fire on a healthy account (PROMPT-15 §0 Q2).
  const overdraftAmount = Math.max(0, Number(overdraft) || 0)
  const canSave = openingBalance.trim() !== '' && !Number.isNaN(amount) && !!openingBalanceDate

  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={dismissable ? onCancel : undefined}
    >
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">
          {initial ? 'Edit joint account balance' : 'Set up your joint account'}
        </h2>
        <p className="text-xs text-[var(--color-ink-muted)] mb-4">
          {initial
            ? 'Corrects the reconciled starting point everything else is calculated from.'
            : "You've added a joint bill or loan — before it can be tracked properly, we need a real starting balance and the date it was true as of, same as a credit card's own anchor balance."}
        </p>

        <div className="flex flex-col gap-3">
          <EditField label="Opening balance (£)" type="number" value={openingBalance} onChange={setOpeningBalance} />
          <EditField label="As of date" type="date" value={openingBalanceDate} onChange={setOpeningBalanceDate} />
          <EditField label="Overdraft (£)" type="number" value={overdraft} onChange={setOverdraft} />
        </div>
        <p className="text-[11px] text-[var(--color-ink-faint)] mt-1.5">
          How far below zero this account may go. Leave at 0 if it cannot. Only the 8pm low-balance alert reads it.
        </p>

        {/* BUGFIX (Adam-reported, 2026-09 session) — Save/Cancel used to be
            two separate stacked full-width buttons; every other staged
            edit form in the app uses the canonical side-by-side
            FormButtonRow instead. The mandatory (non-dismissable, no
            onCancel) first-time setup has no Cancel to offer at all, so it
            keeps a single full-width Save — only the dismissable "edit"
            call site (which always passes onCancel) gets the pair. */}
        {dismissable && onCancel ? (
          <FormButtonRow onCancel={onCancel} onSave={() => onSave(amount, openingBalanceDate, overdraftAmount)} saveDisabled={!canSave} />
        ) : (
          <div className="flex mt-4">
            <SaveButton onClick={() => onSave(amount, openingBalanceDate, overdraftAmount)} disabled={!canSave} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

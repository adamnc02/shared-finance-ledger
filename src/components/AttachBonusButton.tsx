import { useState } from 'react'
import { formatCurrency } from '../lib/format'
import { Pencil, Plus, X } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { EditField } from './EditField'
import type { SalaryOverride } from '../types/ledger'
import { computeNetBonusAmount, computeSnapshotNetPayForPeriod } from '../lib/salaryLedger'

/**
 * A bonus is folded straight into that pay period's SalaryOverride — the
 * gross figure inflates the period's gross before tax/NI/deductions are
 * applied, and the resulting net pay is what shows as that period's salary
 * everywhere (Salary page, Home summary, projections). There is no separate
 * transaction and nothing shows on the Transactions page: the whole thing lives
 * on the Salary page, same as any other salary adjustment.
 *
 * personId is a real ledger Person id — the Salary page now runs on the
 * ledger model directly, so there's no longer a need to bridge between
 * two different Person id spaces by matching names.
 */
export function AttachBonusButton({
  personId,
  fixedDate,
  existingOverride,
  onSaved,
}: {
  personId: string
  fixedDate: string
  existingOverride?: SalaryOverride
  /** Batch 9 (2026-09-07, Bug 11) — fired after Attach/Save changes
   * actually commits (not Remove, and not a plain Cancel/close). */
  onSaved?: () => void
}) {
  const [open, setOpen] = useState(false)
  const hasBonus = !!existingOverride?.bonusGrossAmount

  return (
    <>
      <button onClick={() => setOpen(true)} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--color-coral)' }}>
        {hasBonus ? (
          <>
            <Pencil size={12} /> Bonus: £{formatCurrency(existingOverride!.bonusGrossAmount!)} gross
          </>
        ) : (
          <>
            <Plus size={12} /> Bonus
          </>
        )}
      </button>
      {open && (
        <AttachBonusForm
          personId={personId}
          fixedDate={fixedDate}
          existingOverride={hasBonus ? existingOverride : undefined}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
        />
      )}
    </>
  )
}

function AttachBonusForm({
  personId,
  fixedDate,
  existingOverride,
  onClose,
  onSaved,
}: {
  personId: string
  fixedDate: string
  existingOverride?: SalaryOverride
  onClose: () => void
  onSaved?: () => void
}) {
  const { data, addSalaryOverride, updateSalaryOverride, removeSalaryOverride } = useLedgerData()
  const [grossAmount, setGrossAmount] = useState(existingOverride?.bonusGrossAmount ? String(existingOverride.bonusGrossAmount) : '')
  const grossNumber = Number(grossAmount)

  const person = data.people.find((p) => p.id === personId)
  const baseNetPay = person ? computeSnapshotNetPayForPeriod(person, fixedDate) : null
  const netBonusAmount = person && grossNumber > 0 ? computeNetBonusAmount(person, fixedDate, grossNumber) : null

  function save() {
    if (netBonusAmount === null || baseNetPay === null) return
    const netPayOverride = baseNetPay + netBonusAmount
    const reason = `Bonus (£${formatCurrency(grossNumber)} gross)`
    if (existingOverride) {
      updateSalaryOverride(personId, existingOverride.id, { netPayOverride, reason, bonusGrossAmount: grossNumber })
    } else {
      addSalaryOverride(personId, { payPeriodDate: fixedDate, netPayOverride, reason, bonusGrossAmount: grossNumber })
    }
    onClose()
    onSaved?.()
  }

  function remove() {
    if (existingOverride) removeSalaryOverride(personId, existingOverride.id)
    onClose()
  }

  return (
    <div className="mt-3 rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-ink)]">{existingOverride ? 'Edit bonus' : 'Attach a bonus to a pay'}</span>
        <button onClick={onClose} className="text-[var(--color-ink-muted)]">
          <X size={14} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <EditField label="Gross bonus (£)" type="number" value={grossAmount} onChange={setGrossAmount} />
        <div>
          <span className="text-xs text-[var(--color-ink-muted)] block mb-1">Pay date</span>
          <span className="text-sm text-[var(--color-ink)]">{fixedDate}</span>
        </div>
      </div>
      {grossNumber > 0 && (
        <p className="text-xs text-[var(--color-ink)]">
          {netBonusAmount === null || baseNetPay === null ? (
            <span className="text-[var(--color-ink-faint)]">No salary set up for this date yet — can't estimate tax.</span>
          ) : (
            <>
              This period's net pay becomes <span className="font-semibold">£{formatCurrency(baseNetPay + netBonusAmount)}</span> (base £
              {formatCurrency(baseNetPay)} + £{formatCurrency(netBonusAmount)} net bonus)
            </>
          )}
        </p>
      )}
      <div className="flex items-center justify-between mt-1">
        {existingOverride ? (
          <button onClick={remove} className="text-xs font-medium" style={{ color: 'var(--color-negative)' }}>
            Remove bonus
          </button>
        ) : (
          <span />
        )}
        <button
          disabled={!(grossNumber > 0 && netBonusAmount !== null && baseNetPay !== null)}
          onClick={save}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          {existingOverride ? 'Save changes' : 'Attach'}
        </button>
      </div>
    </div>
  )
}

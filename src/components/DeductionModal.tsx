import { createPortal } from 'react-dom'
import { X, ChevronUp, ChevronDown, Trash2 } from 'lucide-react'
import type { SalaryDeduction, DeductionType, PercentBasis } from '../lib/tax'

const DEDUCTION_TYPE_LABELS: Record<DeductionType, string> = {
  salary_sacrifice: 'Salary sacrifice (before tax & NI)',
  net_pay: 'Net pay arrangement (before tax only)',
  relief_at_source: 'Relief at source pension (from net pay)',
  post_tax: 'Other deduction (from net pay)',
}

interface DeductionModalProps {
  deduction: SalaryDeduction
  canMoveUp: boolean
  canMoveDown: boolean
  onChange: (patch: Partial<SalaryDeduction>) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
  onClose: () => void
}

/**
 * Full deduction editor (name, type, amount type, amount, reorder), reached
 * by tapping a deduction's compact row on the Salary page. Keeps the main
 * page down to just name + amount + a delete button — everything else
 * (which is most of the fields, and the part that actually needs
 * explaining) lives here instead.
 */
export function DeductionModal({ deduction, canMoveUp, canMoveDown, onChange, onMove, onDelete, onClose }: DeductionModalProps) {
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
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Edit deduction</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-ink-muted)]">Name</span>
            <input
              autoFocus
              value={deduction.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="e.g. Pension"
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1.5 text-[var(--color-ink)] outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-ink-muted)]">Type</span>
            <select
              value={deduction.type}
              onChange={(e) => onChange({ type: e.target.value as DeductionType })}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1.5 text-sm text-[var(--color-ink)] outline-none"
            >
              {Object.entries(DEDUCTION_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--color-ink-muted)]">Amount type</span>
              <select
                value={deduction.amountType}
                onChange={(e) => onChange({ amountType: e.target.value as SalaryDeduction['amountType'] })}
                className="w-full bg-transparent border-b border-[var(--color-track)] py-1.5 text-sm text-[var(--color-ink)] outline-none"
              >
                <option value="percent">% of gross</option>
                <option value="fixed">£ fixed</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--color-ink-muted)]">Amount</span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                value={deduction.amount || ''}
                onChange={(e) => onChange({ amount: Number(e.target.value) })}
                placeholder={deduction.amountType === 'percent' ? '%' : '£'}
                className="w-full bg-transparent border-b border-[var(--color-track)] py-1.5 text-[var(--color-ink)] outline-none font-mono"
              />
            </label>
          </div>

          {deduction.amountType === 'percent' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--color-ink-muted)]">Percentage of</span>
              <select
                value={deduction.percentBasis ?? 'gross'}
                onChange={(e) => onChange({ percentBasis: e.target.value as PercentBasis })}
                className="w-full bg-transparent border-b border-[var(--color-track)] py-1.5 text-sm text-[var(--color-ink)] outline-none"
              >
                <option value="gross">Full gross pay</option>
                <option value="qualifying_earnings">Qualifying earnings</option>
              </select>
              <span className="text-[11px] leading-snug text-[var(--color-ink-faint)]">
                {deduction.percentBasis === 'qualifying_earnings'
                  ? 'Only the slice of pay between £520 and £4,189 a month (£480–£3,867 if paid 4-weekly). This is what most workplace pensions actually use.'
                  : 'The whole gross for the period. Check a payslip before assuming this — most workplace pensions are a percentage of qualifying earnings instead, which is a smaller number.'}
              </span>
            </label>
          )}

          <div className="flex items-center justify-between mt-2 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
            <div className="flex items-center gap-1">
              <span className="text-xs text-[var(--color-ink-muted)] mr-1">Payroll order</span>
              <button
                onClick={() => onMove(-1)}
                disabled={!canMoveUp}
                className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-20"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink-muted)' }}
              >
                <ChevronUp size={16} />
              </button>
              <button
                onClick={() => onMove(1)}
                disabled={!canMoveDown}
                className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-20"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink-muted)' }}
              >
                <ChevronDown size={16} />
              </button>
            </div>
            <button onClick={onDelete} className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--color-negative)' }}>
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full mt-5 py-2.5 rounded-xl text-sm font-medium"
          style={{ background: 'var(--color-coral)', color: '#fff' }}
        >
          Done
        </button>
      </div>
    </div>,
    document.body
  )
}

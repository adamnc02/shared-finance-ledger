import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Trash2, X } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { ConfirmModal } from './ConfirmModal'
import {
  BLOCKER_GROUPS,
  blockerTargetOptions,
  canDeleteBlocker,
  findDeleteBlockers,
  targetOptionKey,
  type BlockerAction,
  type BlockerTarget,
  type DeleteBlocker,
  type DeleteSubject,
} from '../lib/deleteReassign'

// PROMPT-05 (2026-09-16) — the delete confirmation for a Person, Pot or
// Savings Pot. RESTRICT semantics (DECISIONS-2026-09-15.md Q5): while
// anything still points at the thing being deleted, this lists it, grouped
// by type, and every item needs a decision — move it somewhere, or delete
// it — before Delete becomes available.
//
// Decisions are a DRAFT (Adam, 2026-09-16): nothing changes until Delete is
// pressed, which applies every decision and the delete in one go
// (deleteWithResolutions). Cancel leaves everything exactly as it was. Each
// row shows plainly whether it has been handled, and how.
//
// When nothing is linked at the moment it opens, this is just the app's
// usual ConfirmModal — so there is still one delete-confirmation idiom.
export function DeleteGuardModal({
  subject,
  name,
  description,
  onConfirm,
  onCancel,
}: {
  subject: DeleteSubject
  name: string
  /** Body text for the plain confirmation when nothing is linked. */
  description?: string
  /** The plain (nothing linked) delete. */
  onConfirm: () => void
  onCancel: () => void
}) {
  const { data } = useLedgerData()
  const [blockers] = useState(() => findDeleteBlockers(data, subject))

  if (blockers.length === 0) {
    return <ConfirmModal title={`Delete ${name}?`} description={description ?? "This can't be undone."} tone="danger" onConfirm={onConfirm} onCancel={onCancel} />
  }
  return <BlockedSheet subject={subject} name={name} blockers={blockers} onDone={onCancel} />
}

function BlockedSheet({ subject, name, blockers, onDone }: { subject: DeleteSubject; name: string; blockers: DeleteBlocker[]; onDone: () => void }) {
  const { data, deleteWithResolutions } = useLedgerData()
  // Staged decisions, keyed by blocker. Insertion order is the order they apply in.
  const [decisions, setDecisions] = useState<Map<string, BlockerAction>>(new Map())
  const handled = blockers.filter((b) => decisions.has(b.key)).length
  const allHandled = handled === blockers.length

  function decide(key: string, action: BlockerAction | null) {
    setDecisions((prev) => {
      const next = new Map(prev)
      next.delete(key)
      if (action) next.set(key, action)
      return next
    })
  }

  // One tap for the common case. People: exactly one other person — a
  // two-person household. Pots: Personal, when it suits at least two items.
  // Stages a move for every item that accepts it and isn't decided yet;
  // anything it doesn't suit (e.g. a Personal→Pot transfer) stays to do.
  const others = data.people.filter((p) => p.id !== subject.id)
  const bulkTarget: { label: string; target: BlockerTarget } | null =
    subject.type === 'person'
      ? others.length === 1
        ? { label: `Move everything to ${others[0].name}`, target: { type: 'person', personId: others[0].id } }
        : null
      : blockers.filter((b) => blockerTargetOptions(data, subject, b).some((o) => o.key === 'personal')).length >= 2
        ? { label: 'Move everything possible to Personal', target: { type: 'location', location: { type: 'personal' } } }
        : null
  const bulkApplies = (b: DeleteBlocker) => !!bulkTarget && !decisions.has(b.key) && blockerTargetOptions(data, subject, b).some((o) => o.key === targetOptionKey(bulkTarget.target))
  const bulkCount = blockers.filter(bulkApplies).length

  return createPortal(
    <div className="fixed inset-0 z-[550] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onDone}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Before deleting {name}</h3>
          <button onClick={onDone} className="text-[var(--color-ink-muted)]" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <p className="text-sm text-[var(--color-ink-muted)] mb-3 leading-relaxed">
          {blockers.length} {blockers.length === 1 ? 'item is' : 'items are'} still linked to {name}.{' '}
          {subject.type === 'person' ? 'Choose to move each one to someone else, or delete it.' : 'Choose to move each one somewhere else, or delete it.'} Nothing changes until you
          press Delete. Already-cleared transactions stay exactly as they are.
        </p>

        <div
          className="flex items-center justify-between rounded-xl px-3 py-2 mb-4 text-xs font-semibold"
          style={{ background: 'var(--color-bg-elevated)', color: allHandled ? 'var(--color-positive)' : 'var(--color-ink-muted)' }}
          data-testid="handled-count"
        >
          <span>
            {handled} of {blockers.length} handled
          </span>
          {allHandled && (
            <span className="flex items-center gap-1">
              <Check size={14} /> Ready to delete
            </span>
          )}
        </div>

        {bulkTarget && bulkCount > 0 && (
          <button
            onClick={() => {
              const target = bulkTarget.target
              setDecisions((prev) => {
                const next = new Map(prev)
                for (const b of blockers) if (bulkApplies(b)) next.set(b.key, { type: 'reassign', target })
                return next
              })
            }}
            className="w-full py-2 mb-4 rounded-full text-sm font-semibold text-white"
            style={{ background: 'var(--color-coral)' }}
          >
            {bulkTarget.label}
          </button>
        )}

        <div className="flex flex-col gap-4">
          {BLOCKER_GROUPS.map(({ group, label }) => {
            const items = blockers.filter((b) => b.group === group)
            if (items.length === 0) return null
            return (
              <div key={group}>
                <p className="text-[10px] font-semibold tracking-wide uppercase text-[var(--color-ink-faint)] mb-2">{label}</p>
                <div className="flex flex-col gap-2">
                  {items.map((b) => (
                    <BlockerRow
                      key={b.key}
                      subject={subject}
                      blocker={b}
                      decision={decisions.get(b.key) ?? null}
                      canDelete={canDeleteBlocker(data, b)}
                      onDecide={(action) => decide(b.key, action)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onDone} className="flex-1 py-2 rounded-full text-sm font-medium text-[var(--color-ink-muted)]" style={{ background: 'var(--color-bg-elevated)' }}>
            Cancel
          </button>
          <button
            onClick={() => {
              deleteWithResolutions(subject, [...decisions.entries()])
              onDone()
            }}
            disabled={!allHandled}
            className="flex-1 py-2 rounded-full text-sm font-semibold text-white disabled:opacity-40"
            style={{ background: 'var(--color-negative)' }}
          >
            Delete {name}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function BlockerRow({
  subject,
  blocker,
  decision,
  canDelete,
  onDecide,
}: {
  subject: DeleteSubject
  blocker: DeleteBlocker
  decision: BlockerAction | null
  canDelete: boolean
  onDecide: (action: BlockerAction | null) => void
}) {
  const { data } = useLedgerData()
  const options = blockerTargetOptions(data, subject, blocker)
  const [targetKey, setTargetKey] = useState(options[0]?.key ?? '')
  const selected = options.some((o) => o.key === targetKey) ? targetKey : (options[0]?.key ?? '')

  const heading = (
    <div className="min-w-0">
      <p className="text-sm font-medium text-[var(--color-ink)] truncate" style={decision?.type === 'delete' ? { textDecoration: 'line-through', color: 'var(--color-ink-muted)' } : undefined}>
        {blocker.name}
      </p>
      {blocker.detail && <p className="text-xs text-[var(--color-ink-muted)] truncate">{blocker.detail}</p>}
    </div>
  )

  if (decision) {
    const outcome =
      decision.type === 'delete' ? 'Will be deleted' : `Will move to ${options.find((o) => o.key === targetOptionKey(decision.target))?.label ?? 'the chosen place'}`
    return (
      <div
        className="rounded-xl p-3"
        style={{ background: 'var(--color-bg-elevated)', border: `1px solid ${decision.type === 'delete' ? 'var(--color-negative)' : 'var(--color-positive)'}` }}
        data-blocker={blocker.key}
        data-decision={decision.type}
      >
        <div className="flex items-start justify-between gap-2">
          {heading}
          <button onClick={() => onDecide(null)} className="shrink-0 text-xs font-medium text-[var(--color-ink-muted)] underline" aria-label={`Undo ${blocker.name}`}>
            Undo
          </button>
        </div>
        <p className="flex items-center gap-1 mt-2 text-xs font-semibold" style={{ color: decision.type === 'delete' ? 'var(--color-negative)' : 'var(--color-positive)' }}>
          {decision.type === 'delete' ? <Trash2 size={12} /> : <Check size={12} />} {outcome}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)', border: '1px dashed var(--color-track)' }} data-blocker={blocker.key} data-decision="none">
      <div className="flex items-start justify-between gap-2">
        {heading}
        {canDelete && (
          <button onClick={() => onDecide({ type: 'delete' })} className="shrink-0 p-1 text-[var(--color-ink-faint)]" aria-label={`Delete ${blocker.name}`}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
      {options.length > 0 && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-[var(--color-ink-muted)] shrink-0">Move to</span>
          <select
            value={selected}
            onChange={(e) => setTargetKey(e.target.value)}
            className="flex-1 min-w-0 bg-transparent border-b border-[var(--color-track)] py-1 text-sm text-[var(--color-ink)] outline-none"
            aria-label={`Move ${blocker.name} to`}
          >
            {options.map((o) => (
              <option key={o.key} value={o.key} style={{ color: '#000' }}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              const option = options.find((o) => o.key === selected)
              if (option) onDecide({ type: 'reassign', target: option.target })
            }}
            className="shrink-0 px-3 py-1 rounded-full text-xs font-semibold text-white"
            style={{ background: 'var(--color-coral)' }}
          >
            Move
          </button>
        </div>
      )}
    </div>
  )
}

import { createPortal } from 'react-dom'

// Page-centred, NOT bottom-locked — Adam's explicit call (UI consistency
// review §2/§10 Phase 1-2): every existing modal in the app is a bottom
// sheet (`items-end`, `rounded-t-3xl`), but a destructive confirmation
// reads as a distinct, deliberate interruption rather than "just another
// panel sliding up," which is why this one is the one exception to that
// pattern — centred (`items-center`), fully rounded corners, no
// safe-bottom padding since it isn't docked to the bottom of the screen.
export interface ConfirmModalProps {
  title: string
  /** What will actually happen — for anything beyond a simple row (e.g. Person deletion's cascade), spell out the real consequence here rather than a generic "this can't be undone." */
  description: string
  confirmLabel?: string
  cancelLabel?: string
  /** Coral (default) for a normal confirmation; red for something destructive enough to warrant it (Person deletion). */
  tone?: 'default' | 'danger'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({ title, description, confirmLabel = 'Delete', cancelLabel = 'Cancel', tone = 'default', onConfirm, onCancel }: ConfirmModalProps) {
  return createPortal(
    <div className="fixed inset-0 z-[600] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
      <div className="w-full max-w-sm rounded-3xl p-5" style={{ background: 'var(--color-surface)' }} onClick={(e) => e.stopPropagation()}>
        <h3 className="font-display text-base font-semibold text-[var(--color-ink)] mb-2">{title}</h3>
        <p className="text-sm text-[var(--color-ink-muted)] mb-5 leading-relaxed">{description}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2 rounded-full text-sm font-medium text-[var(--color-ink-muted)]" style={{ background: 'var(--color-bg-elevated)' }}>
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 rounded-full text-sm font-semibold text-white"
            style={{ background: tone === 'danger' ? 'var(--color-negative)' : 'var(--color-coral)' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

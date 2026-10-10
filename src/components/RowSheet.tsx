import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PanelBottomOpen, X } from 'lucide-react'

// A card's edit surface, as a bottom sheet rather than an in-place
// expansion. On the Salary page: pay periods, pensions, savings pots, pots
// and the joint account (its own JointAccountSetupModal, same shape). The
// salary card itself still expands in place, so the pay periods are in view.
//
// Portalled to document.body (APP-KNOWLEDGE §1.9): the page renders inside
// the scrolling #app-content, which would clip a fixed overlay. A sheet
// opened from inside another sheet is
// portalled later, so it stacks on top at the same z-index.
//
// 🚨 z-[450], deliberately BELOW the modals (z-[500] and up). The forms in a
// sheet open their own modals — a deduction, "from which payment?", a
// category picker — and a sheet at the modals' level or above hides them
// behind itself. Above the bottom nav (z-[100]).
//
// The backdrop and the X both close it, discarding an unsaved edit, as
// collapsing the card always did.
export function RowSheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-[450] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] min-w-0 truncate">{title}</h2>
          <button onClick={onClose} className="shrink-0 text-[var(--color-ink-muted)]" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/** The mark on a card that opens a RowSheet. A panel rising from the bottom, not a chevron: a chevron says "expands here". */
export function OpensSheetIcon() {
  return <PanelBottomOpen size={16} className="text-[var(--color-ink-muted)] shrink-0" aria-hidden />
}

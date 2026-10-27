import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PanelBottomOpen, PanelRightOpen, X } from 'lucide-react'
import { useWide } from '../lib/useWide'

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
//
// On a laptop (lib/laptop.ts) it is a panel sliding in from the right, full
// height, with the page still visible beside it. Same z-index, same portal,
// same close rules.
export function RowSheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const wide = useWide()
  if (wide) {
    return createPortal(
      <div className="fixed inset-0 z-[450] flex justify-end" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={onClose}>
        <div
          role="dialog"
          aria-label={typeof title === 'string' ? title : undefined}
          className="h-full w-[440px] max-w-full rounded-l-3xl p-6 overflow-y-auto border-l"
          style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-track)', paddingTop: 'calc(var(--safe-top) + 24px)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 mb-5">
            <h2 className="font-display text-xl font-semibold text-[var(--color-ink)] min-w-0 truncate">{title}</h2>
            <button onClick={onClose} className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[var(--color-ink)]" style={{ background: 'var(--color-surface-raised)' }} aria-label="Close">
              <X size={16} />
            </button>
          </div>
          {children}
        </div>
      </div>,
      document.body,
    )
  }
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

/** The mark on a card that opens a RowSheet. A panel rising from the bottom (from the right on a laptop), not a chevron: a chevron says "expands here". */
export function OpensSheetIcon() {
  const Icon = useWide() ? PanelRightOpen : PanelBottomOpen
  return <Icon size={16} className="text-[var(--color-ink-muted)] shrink-0" aria-hidden />
}

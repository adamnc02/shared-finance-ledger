import { useEffect, useState, type ReactNode } from 'react'
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
// On a laptop (lib/laptop.ts) it is a panel floating ON TOP of the page at
// the right — the page keeps its own size and layout underneath, and stays
// usable: there is no backdrop, so opening another row replaces the panel
// (useOneOpenRow), and the X or Escape closes it.
//
// 🚨 Never a column of the page's own layout. A docked column narrows the
// page the moment a row is opened, and the whole page reflows.
export function RowSheet({ title, subtitle, onClose, children }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  const wide = useWide()
  // Escape closes the topmost panel only, and never while a dialog the panel opened is on top of it.
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!wide || !el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const panels = document.querySelectorAll('[data-row-sheet]')
      if (panels[panels.length - 1] !== el || document.querySelector('.fixed.inset-0')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide, el, onClose])
  if (wide) {
    return createPortal(
      <div
        ref={setEl}
        data-row-sheet
        role="dialog"
        aria-label={typeof title === 'string' ? title : undefined}
        className="fixed z-[450] right-6 w-[420px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-[20px] p-[22px] border"
        style={{
          top: 'calc(var(--safe-top) + 24px)',
          maxHeight: 'calc(var(--app-height, 100dvh) - var(--safe-top) - 48px)',
          background: 'var(--color-bg-elevated)',
          borderColor: 'var(--color-track)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.55), 0 4px 16px rgba(0,0,0,0.3)',
        }}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-1 min-w-0">
            {subtitle && <div className="text-xs text-[var(--color-ink-muted)]">{subtitle}</div>}
            <h2 className="font-display text-[22px] font-semibold text-[var(--color-ink)] truncate mt-0.5">{title}</h2>
          </div>
          <button onClick={onClose} className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-[var(--color-ink)]" style={{ background: 'var(--color-surface-raised)' }} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
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

/**
 * On a laptop (lib/laptop.ts), its children in the right-hand RowSheet;
 * on a phone, its children exactly where they are. For a surface that
 * opens in place on the phone — an add form at the top of a list, a row's
 * edit form under the row — so the phone layout stays as it was.
 */
export function SheetOnLaptop({ title, subtitle, onClose, children }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  const wide = useWide()
  if (!wide) return <>{children}</>
  return (
    <RowSheet title={title} subtitle={subtitle} onClose={onClose}>
      {children}
    </RowSheet>
  )
}


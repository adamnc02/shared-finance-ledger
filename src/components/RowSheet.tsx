import { createContext, useContext, useState, type ReactNode } from 'react'
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
// On a laptop (lib/laptop.ts) it is a panel DOCKED in the page's right-hand
// column (LaptopPanelLayout), with the page still usable beside it: no
// backdrop, so another row can be opened straight away and replaces it
// (useOneOpenRow), and the X closes it. Outside a LaptopPanelLayout it falls
// back to sliding in over the page from the right.
export function RowSheet({ title, subtitle, onClose, children }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  const wide = useWide()
  const dock = useContext(LaptopPanelContext)
  if (wide) {
    const panel = (
      <div
        role="dialog"
        aria-label={typeof title === 'string' ? title : undefined}
        className="rounded-[20px] p-[22px] border"
        style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-track)' }}
        onClick={(e) => e.stopPropagation()}
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
      </div>
    )
    if (dock) return createPortal(panel, dock)
    return createPortal(
      <div className="fixed inset-0 z-[450] flex justify-end" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={onClose}>
        <div className="h-full w-[420px] max-w-full overflow-y-auto p-4" style={{ paddingTop: 'calc(var(--safe-top) + 16px)' }}>
          {panel}
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

/** The element a page's laptop panel column renders into; null outside a LaptopPanelLayout. */
const LaptopPanelContext = createContext<HTMLElement | null>(null)

/**
 * A laptop page with a docked right-hand panel column (lib/laptop.ts): the
 * page on the left, and on the right whatever RowSheet is open inside it.
 * The column takes no room while nothing is open (`empty:hidden`), so the
 * page uses the full width until a row is opened. On a phone it renders its
 * children and nothing else.
 *
 * The column is sticky inside #app-content (the app's only scroll
 * container), so a long page scrolls under an open panel and the panel stays
 * in view; it scrolls on its own when it is taller than the window.
 */
export function LaptopPanelLayout({ children }: { children: ReactNode }) {
  const wide = useWide()
  const [dock, setDock] = useState<HTMLElement | null>(null)
  if (!wide) return <>{children}</>
  return (
    <div className="flex gap-6 items-start">
      <div className="flex-1 min-w-0">
        <LaptopPanelContext.Provider value={dock}>{children}</LaptopPanelContext.Provider>
      </div>
      <aside
        ref={setDock}
        aria-label="Details"
        className="w-[400px] shrink-0 sticky top-8 flex flex-col gap-4 overflow-y-auto empty:hidden"
        style={{ maxHeight: 'calc(var(--app-height, 100dvh) - 64px)' }}
      />
    </div>
  )
}

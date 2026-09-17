import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface CollapsibleSectionProps {
  title: string
  defaultOpen?: boolean
  children: ReactNode
  className?: string
  headerExtra?: ReactNode
  /** Controlled mode (UAT Batch 5, 2026-09-07 — bug 2, "expand on +") — pass
   * both `open`/`onOpenChange` together so a parent can force this section
   * open (e.g. from its own "+" button) or re-collapse it (e.g. cancelling
   * out of adding the first item to an empty section). `defaultOpen` still
   * seeds the initial value either way; omit both to keep the section
   * fully self-managed, as every other caller does. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function CollapsibleSection({ title, defaultOpen = true, children, className = '', headerExtra, open: openProp, onOpenChange }: CollapsibleSectionProps) {
  const [openState, setOpenState] = useState(defaultOpen)
  const isControlled = openProp !== undefined && !!onOpenChange
  const open = isControlled ? openProp : openState
  const setOpen = isControlled ? onOpenChange : setOpenState

  return (
    <section className={className}>
      <div className="w-full flex items-center justify-between py-1 mb-3">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2" aria-expanded={open}>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-[var(--color-ink-muted)]">{title}</h2>
          {open ? (
            <ChevronUp size={16} className="text-[var(--color-ink-muted)]" />
          ) : (
            <ChevronDown size={16} className="text-[var(--color-ink-muted)]" />
          )}
        </button>
        {headerExtra}
      </div>
      {open && children}
    </section>
  )
}

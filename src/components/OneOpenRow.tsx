import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

// One expanded row at a time.
//
// On the Transactions and Bills pages, opening a row closes whichever row
// was open, in the same tap — across every list on the page, so an open
// recurring transfer closes when a one-off is opened. Each page wraps its
// lists in a OneOpenRowProvider; each expandable row asks useOneOpenRow
// whether it is the open one instead of keeping a flag of its own.
//
// A row outside any provider keeps its own independent flag, exactly as
// before, so a row component can be reused elsewhere without change.
//
// Closing a row discards an unsaved edit in it, exactly as tapping its own
// chevron always has: the edit form lives inside the expanded part.

type OpenSetter = (open: boolean | ((wasOpen: boolean) => boolean)) => void

const OneOpenRowContext = createContext<{ openKey: string | null; setOpenKey: (update: (prev: string | null) => string | null) => void } | null>(null)

export function OneOpenRowProvider({ children }: { children: ReactNode }) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  return <OneOpenRowContext.Provider value={{ openKey, setOpenKey }}>{children}</OneOpenRowContext.Provider>
}

/**
 * `[isOpen, setOpen]`, shaped like useState so a row swaps it in for its own
 * flag. `key` must be unique on the page — prefix it with the row's kind,
 * because a transaction and a template can share an id.
 */
export function useOneOpenRow(key: string): [boolean, OpenSetter] {
  const ctx = useContext(OneOpenRowContext)
  const [localOpen, setLocalOpen] = useState(false)
  const isOpen = ctx ? ctx.openKey === key : localOpen
  const setOpen = useCallback<OpenSetter>(
    (open) => {
      if (!ctx) {
        setLocalOpen(open)
        return
      }
      ctx.setOpenKey((prev) => {
        const next = typeof open === 'function' ? open(prev === key) : open
        // Opening takes the slot. Closing frees it only if this row holds it,
        // so a late close from a row that already lost the slot cannot shut
        // the row that took it.
        return next ? key : prev === key ? null : prev
      })
    },
    [ctx, key],
  )
  return [isOpen, setOpen]
}

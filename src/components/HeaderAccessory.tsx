import { createContext, useContext, type ReactNode } from 'react'

// PROMPT-10 (Adam, 2026-09-19) — a slot in the Wallet header, beside the
// People button, for an app to put a button of its own. It renders nothing
// unless the app provides something, and the offline app never does. The
// sync app (shared-finance-ledger) puts its Account button here, so it sits
// in the header and scrolls with the page like People.
//
// Shared and identical in every app, so Salary.tsx stays identical too
// (DIVERGENCE.md: src/pages/** never diverges).
export const HeaderAccessoryContext = createContext<ReactNode>(null)

export function HeaderAccessory() {
  return <>{useContext(HeaderAccessoryContext)}</>
}

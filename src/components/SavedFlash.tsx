import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'

// ── Shared "collapse + flash green" save feedback ──────────────────────────
// Used anywhere a row/card has a Save button: on save, the row collapses and
// briefly flashes a solid green fill (--color-positive) with a check mark
// and "Saved" in white, instead of a static inline "Saved." text. Keeps the
// feedback consistent across Bills, pay periods, Borrowing, and Savings.

// Batch 9 (2026-09-07, Bug 11 — app-wide SavedFlash sweep): `trigger()`
// now optionally takes a one-off message override for the flash it's
// about to start — most call sites still just want the default "Saved",
// but a few (e.g. a Loan card's Save vs. its own "Settle this loan"
// action) share ONE overlay instance across more than one kind of
// action, each wanting its own wording ("Saved" vs "Loan settled"). The
// override is remembered only until the flash's own active state clears,
// so the NEXT trigger() with no argument correctly falls back to
// `defaultMessage` again rather than sticking to whatever was last shown.
export function useSavedFlash(defaultMessage = 'Saved', duration = 1300) {
  const [active, setActive] = useState(false)
  const [message, setMessage] = useState(defaultMessage)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  function trigger(messageOverride?: string) {
    setMessage(messageOverride ?? defaultMessage)
    setActive(true)
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setActive(false), duration)
  }

  return { active, message, trigger }
}

// Absolutely-positioned overlay — place inside a `relative` (and ideally
// `overflow-hidden`) container that already has the corner radius you want
// the flash to respect. `message` defaults to "Saved" so every pre-existing
// call site (which only ever passed `active`) is unaffected.
export function SavedFlashOverlay({ active, message = 'Saved' }: { active: boolean; message?: string }) {
  return (
    <div
      aria-hidden={!active}
      className="absolute inset-0 rounded-[inherit] flex items-center justify-center gap-1.5 pointer-events-none transition-opacity duration-300 ease-out"
      style={{
        opacity: active ? 1 : 0,
        background: 'var(--color-positive)',
        zIndex: 5,
      }}
    >
      <Check size={15} strokeWidth={3} className="text-white" />
      <span className="text-sm font-semibold text-white">{message}</span>
    </div>
  )
}

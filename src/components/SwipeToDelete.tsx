import { useRef, useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { ConfirmModal } from './ConfirmModal'
import { DeleteGuardModal } from './DeleteGuardModal'
import type { DeleteSubject } from '../lib/deleteReassign'

interface SwipeToDeleteProps {
  children: ReactNode
  onDelete: () => void
  /** Shown in the centred confirmation modal before actually deleting — pass a short description, e.g. "Car loan". */
  confirmLabel?: string
  /** Overrides the modal's body text — defaults to "This can't be undone." Use this for anything with a real cascading effect (e.g. Person deletion) so the confirmation actually names the consequence. */
  confirmDescription?: string
  /** A Person/Pot/Savings Pot: the confirmation blocks while anything still points at it (PROMPT-05). Requires confirmLabel. */
  deleteGuard?: DeleteSubject
}

const REVEAL_WIDTH = 84

// Tapping a native form control (a <select> especially) inside a swipeable
// row must NOT start the swipe-capture gesture — a <select> hands control
// to the OS's own dropdown/picker UI, and pointer capture doesn't cleanly
// resolve once that happens, leaving every subsequent tap anywhere on the
// page misrouted back through this row's pointer handlers (symptom: every
// click re-opens/closes whatever dropdown was last touched). Skip capture
// entirely for taps that land on or inside a native control.
//
// UAT 2026-09-07 (bug 4.1b): this used to also exclude `button`/`a`/
// `label`/`[role="button"]` — but a row's own big tap-to-expand disclosure
// button (Bills/Loans/Transfers headers, `<button className="w-full ...">`)
// covers the ENTIRE swipeable area, so that blanket exclusion meant a
// horizontal drag starting anywhere on the header could never begin
// tracking at all — it always resolved as a plain tap, expanding the card
// instead of revealing the trash button. Native controls (which hand
// control to the OS, per the original comment above) still need excluding
// outright; a plain button/link doesn't — the drag-vs-tap threshold below
// (DRAG_THRESHOLD + the click-suppression on pointerup) does the actual
// disambiguating instead, so a real tap on a button still fires its
// onClick normally and a real horizontal drag still reveals the trash
// button, wherever on the row it started.
//
// `target instanceof Element`, NOT `HTMLElement` — an icon-only button's
// actual pointerdown target is near-always the icon's own <svg>/<path>,
// which is an SVGElement, NOT an HTMLElement (a real, separate branch of
// the DOM class hierarchy). `Element.closest` exists identically on both
// HTML and SVG elements.
//
// 2026-09-16 (Adam, UAT): `[data-no-swipe]` opts a region out too. A scrollable
// list inside a swipeable row (the pot's "What this pot pays" checklist) made
// the first touch ambiguous between scrolling the list and swiping to delete.
function isNativeControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('select, input, textarea, [data-no-swipe]')
}

// Anything less than this many px of horizontal movement is still treated
// as a tap (so a plain click on the header/an inline button still fires
// normally) — beyond it, it's a real swipe, and the pending click on
// whatever's under the finger gets suppressed on release.
const DRAG_THRESHOLD = 6

export function SwipeToDelete({ children, onDelete, confirmLabel, confirmDescription, deleteGuard }: SwipeToDeleteProps) {
  const startX = useRef<number | null>(null)
  const startOffset = useRef(0)
  const draggedPastThreshold = useRef(false)
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [confirming, setConfirming] = useState(false)

  function handlePointerDown(e: React.PointerEvent) {
    if (isNativeControlTarget(e.target)) return
    startX.current = e.clientX
    startOffset.current = offset
    draggedPastThreshold.current = false
    setDragging(true)
    // Capture on currentTarget (this wrapper div), not e.target — target
    // could be any nested descendant, and capturing there is both less
    // correct and part of what made the select-interaction bug above
    // possible in the first place.
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (startX.current === null) return
    const delta = e.clientX - startX.current
    if (Math.abs(delta) > DRAG_THRESHOLD) draggedPastThreshold.current = true
    const next = Math.min(0, Math.max(-REVEAL_WIDTH, startOffset.current + delta))
    setOffset(next)
  }

  function handlePointerUp() {
    if (startX.current === null) return
    setDragging(false)
    startX.current = null
    // Snap open if dragged more than halfway, otherwise snap closed
    setOffset(offset < -REVEAL_WIDTH / 2 ? -REVEAL_WIDTH : 0)
  }

  function handleClickCapture(e: React.MouseEvent) {
    // A real drag just ended on this same pointer sequence — swallow the
    // synthetic click it would otherwise produce (e.g. on the header's
    // own disclosure button) so a swipe never also toggles the card open.
    if (draggedPastThreshold.current) {
      e.preventDefault()
      e.stopPropagation()
      draggedPastThreshold.current = false
      return
    }
    // UAT 2026-09-08 (bug 5-bug5-single-delete): the trash button is
    // revealed but the row itself is still a full-width, unchanged
    // disclosure button underneath — a plain tap on it (no drag) used to
    // fall straight through to that button's own onClick, expanding the
    // row while leaving the trash button revealed. The first tap while
    // revealed should just re-hide the trash button instead, matching the
    // "tap elsewhere to dismiss" pattern this affordance implies.
    if (offset !== 0) {
      e.preventDefault()
      e.stopPropagation()
      setOffset(0)
    }
  }

  function handleDeleteTap() {
    if (confirmLabel) {
      setConfirming(true)
      return
    }
    onDelete()
  }

  return (
    // UAT 2026-09-07 (bug 10): `isolation: isolate` forces its own
    // compositing layer — without it, Chrome/Safari's anti-aliasing on
    // this rounded+overflow-hidden container leaves a faint sliver of the
    // trash button's red background visible right at the rounded corners
    // even while offset is 0 (a well-known rounded-corner-over-overflow-
    // hidden rendering seam, not a layout bug). The trash button itself
    // also gained its own `rounded-2xl` — previously unrounded, so only
    // its two edges that happened to coincide with this container's own
    // rounded corners ever looked rounded; the other two were square.
    <div className="relative overflow-hidden rounded-2xl" style={{ isolation: 'isolate' }}>
      <button
        onClick={handleDeleteTap}
        className="absolute top-0 right-0 h-full flex items-center justify-center rounded-2xl"
        style={{ width: REVEAL_WIDTH, background: 'var(--color-negative)' }}
      >
        <Trash2 size={18} color="#fff" />
      </button>
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClickCapture={handleClickCapture}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
          touchAction: 'pan-y',
        }}
      >
        {children}
      </div>
      {confirming && deleteGuard && (
        <DeleteGuardModal
          subject={deleteGuard}
          name={confirmLabel ?? ''}
          description={confirmDescription}
          onConfirm={() => {
            setConfirming(false)
            onDelete()
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
      {confirming && !deleteGuard && (
        <ConfirmModal
          title={`Delete ${confirmLabel}?`}
          description={confirmDescription ?? "This can't be undone."}
          tone="danger"
          onConfirm={() => {
            setConfirming(false)
            onDelete()
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

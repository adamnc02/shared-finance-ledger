import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppDataV2 } from '../types/ledger'
import { cyclesInRange, horizonCycles, THREE_CYCLES_AHEAD } from '../lib/projection'
import { cycleLabel } from '../lib/statement'
import { toLocalIsoDate as iso, parseLocalDate } from '../lib/date'
import { formatFullDate } from '../lib/format'

// The cycle statement's date picker (the statement round, 2026-09-24).
//
// 🚨 YOU CANNOT HIGHLIGHT DATES IN A NATIVE PICKER. Adam asked for cycle
// starts to be marked in the calendar; `<input type="date">` renders its
// calendar inside an OS-controlled shadow root, and on iOS it is the
// system picker — no CSS or JS can mark, colour or disable a date in it.
// The app has met this boundary before (EditField.tsx's note about iOS
// silently rendering native date inputs as `content-box`).
//
// So the answer is not a better calendar, it is a different control: the
// window is chosen from A LIST OF REAL CYCLES, where a cycle boundary
// stops being a hint to spot and becomes the thing you tap. The same
// house idiom the recurring-overpayment editor already uses
// (verify-overpayment-picker-real-dates.ts).
//
// "Exact dates" keeps the native inputs for anyone who wants them, with
// the cycle boundaries as chips beneath — and the chips SET the input
// (Adam: "can these actually set the value on the picker as a
// shortcut?"), rather than captioning it. That is where the original
// request survives: the native picker cannot show where a cycle begins,
// so the control next to it does, and it also does the work.

export interface StatementRangeSheetProps {
  data: AppDataV2
  onCancel: () => void
  /**
   * `preview` opens the statement in the app; `save` hands the file
   * straight to the Share Sheet without showing it.
   *
   * 🚨 The choice lives HERE, on the picker, rather than in a modal after
   * the fact (Adam, 2026-09-24 UAT). The two destinations are genuinely
   * different things — one is read now, the other is kept, printed and
   * emailed — and an extra confirmation between "Create" and the result
   * is a step that answers a question the person already knew the answer
   * to when they opened the sheet.
   */
  onConfirm: (range: { selectedStart: string; selectedEnd: string }, destination: 'preview' | 'save') => void
  /** Overridable for tests; the app always passes today. */
  asOfDate?: Date
}

/** How far either side of "now" the list of offerable cycles reaches. Twelve back is a year of history; twelve forward is further than any schedule is meaningful. */
const CYCLES_BACK = 12
const CYCLES_FORWARD = 12

export interface OfferableCycle {
  start: string
  end: string
  label: string
  /** True for the one cycle that STRADDLES `payCycle.openingBalanceDate` — it holds rows, but only from the floor onward. Tagged, because silently offering a half-empty cycle is the same class of problem as silently omitting one. */
  partial: boolean
  current: boolean
  future: boolean
}

/**
 * The cycles the picker offers, with their real bounds.
 *
 * 🚨 Walked with `cyclesInRange`, which walks `resolveCycleBounds` — the
 * same helper `horizonCycles` and the statement's own cycle bands use. A
 * second cycle-walker would drift from the bands the statement draws, and
 * two answers about where a cycle starts cannot be told apart from the
 * screen (one cycle walker, never two).
 *
 * 🚨 Cycles with NO data are not offered at all.
 *
 * This REVERSES the statement round, 2026-09-24 E3.5, which had them listed-but-disabled on the
 * reasoning that "a list that simply starts later looks like a bug".
 * Adam, 2026-09-24, first UAT round, having seen it: a row of greyed
 * "no data" cycles is clutter, not an explanation. **Do not restore
 * them** — this is the later decision, made against the real screen.
 *
 * The one cycle that STRADDLES the floor is kept, because it genuinely
 * holds rows, and flagged `partial` so a half-empty first cycle is not
 * passed off as a whole one.
 */
export function offerableCycles(data: AppDataV2, personId: string, asOfDate: Date, earliestAvailable: string): OfferableCycle[] {
  const todayIso = iso(asOfDate)
  const current = horizonCycles(data, personId, 'current_cycle', asOfDate)[0]
  // Walk out from the current cycle in both directions using the same
  // helper, rather than doing calendar arithmetic on the labels.
  const back = cyclesInRange(data, personId, new Date(current.start.getFullYear(), current.start.getMonth() - CYCLES_BACK, current.start.getDate()), current.end)
  const forward = cyclesInRange(data, personId, current.start, new Date(current.end.getFullYear(), current.end.getMonth() + CYCLES_FORWARD, current.end.getDate()))
  const seen = new Set<string>()
  return [...back, ...forward]
    .filter((c) => {
      const key = iso(c.start)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => iso(a.start).localeCompare(iso(b.start)))
    // A cycle that ends before the reconciliation point holds nothing at
    // all, and is not offered.
    .filter((c) => iso(c.end) >= earliestAvailable)
    .map((c) => ({
      start: iso(c.start),
      end: iso(c.end),
      label: cycleLabel(c.start, c.end),
      partial: iso(c.start) < earliestAvailable,
      current: iso(c.start) <= todayIso && todayIso <= iso(c.end),
      future: iso(c.start) > todayIso,
    }))
}

function tagFor(c: OfferableCycle): string {
  if (c.current) return 'this cycle'
  if (c.partial) return 'partial'
  if (c.future) return 'ahead'
  return ''
}

export function StatementRangeSheet({ data, onCancel, onConfirm, asOfDate }: StatementRangeSheetProps) {
  // 🚨 Pinned once, on mount. A `new Date()` default PARAMETER is a fresh
  // object on every render, so every `useMemo` keyed on it was
  // invalidated on every render and rebuilt the whole cycle list —
  // including the one the scroll effect below measures. Found alongside
  // the scroll bug on 2026-09-24; the two were not unrelated.
  const [asOf] = useState(() => asOfDate ?? new Date())
  const personId = data.primaryPersonId
  // 🚨 The SIGNED-IN person's cycles, always (the signed-in person's cycles, always) — `resolveCycleBounds`
  // is per-person and a statement spans Personal, Joint, pots and cards,
  // so the picker does not follow the selected card.
  const payCycle = data.payCycles.find((pc) => pc.personId === personId)
  const earliestAvailable = payCycle?.openingBalanceDate ?? iso(asOfDate ?? new Date())

  const cycles = useMemo(() => offerableCycles(data, personId, asOf, earliestAvailable), [data, personId, asOf, earliestAvailable])
  const currentIndex = Math.max(
    0,
    cycles.findIndex((c) => c.current),
  )

  // 🚨 The default window is the span the Home page's "Next 3 cycles"
  // already means, so the statement opens on something the person
  // recognises. Read from THREE_CYCLES_AHEAD; never hardcode 4 (the default window is the Home page's own horizon).
  const [mode, setMode] = useState<'cycles' | 'exact'>('cycles')
  const [fromIndex, setFromIndex] = useState(currentIndex)
  const [toIndex, setToIndex] = useState(Math.min(currentIndex + THREE_CYCLES_AHEAD, cycles.length - 1))
  const [exactStart, setExactStart] = useState(cycles[currentIndex]?.start ?? iso(asOf))
  const [exactEnd, setExactEnd] = useState(cycles[Math.min(currentIndex + THREE_CYCLES_AHEAD, cycles.length - 1)]?.end ?? iso(asOf))

  const fromListRef = useRef<HTMLDivElement>(null)
  const toListRef = useRef<HTMLDivElement>(null)
  const painted = useRef(false)

  // 🚨 FIRST PAINT ONLY (first paint only). Both lists open scrolled so THIS cycle
  // sits at the top — the past is above, reachable by scrolling up. A
  // redraw must preserve the scroll position, or every tap throws the
  // list back to the top.
  //
  // 🚨 MEASURED WITH getBoundingClientRect, NOT offsetTop. `offsetTop` is
  // measured from the nearest POSITIONED ancestor, and a plain
  // `overflow-y-auto` div is not positioned — so it resolved against the
  // sheet instead of the list, produced a number larger than the list's
  // own scroll height, and the browser clamped it to the maximum. Both
  // lists opened hard at the BOTTOM, eleven months into the future
  // (Adam, 2026-09-24, first UAT step). The rect difference is relative
  // to whatever the container actually is, so it cannot resolve against
  // the wrong element.
  useEffect(() => {
    if (painted.current) return
    painted.current = true
    for (const ref of [fromListRef, toListRef]) {
      const list = ref.current
      const row = list?.querySelector<HTMLElement>(`[data-index="${currentIndex}"]`)
      if (!list || !row) continue
      list.scrollTop = list.scrollTop + (row.getBoundingClientRect().top - list.getBoundingClientRect().top)
    }
  }, [currentIndex])

  const selected =
    mode === 'cycles'
      ? { selectedStart: cycles[fromIndex]?.start ?? iso(asOf), selectedEnd: cycles[toIndex]?.end ?? iso(asOf) }
      : { selectedStart: exactStart, selectedEnd: exactEnd }

  // What the file will actually hold: the whole cycles containing both
  // chosen dates. Computed with the same walker the statement uses, so
  // the summary can never promise a window the payload does not carry.
  const containing = useMemo(() => {
    const start = selected.selectedStart < earliestAvailable ? earliestAvailable : selected.selectedStart
    const end = selected.selectedEnd < start ? start : selected.selectedEnd
    return cyclesInRange(data, personId, parseLocalDate(start), parseLocalDate(end))
  }, [data, personId, selected.selectedStart, selected.selectedEnd, earliestAvailable])

  const clamped = selected.selectedStart < earliestAvailable
  const trimmed = mode === 'exact' && (iso(containing[0]?.start ?? parseLocalDate(selected.selectedStart)) < selected.selectedStart || iso(containing[containing.length - 1]?.end ?? parseLocalDate(selected.selectedEnd)) > selected.selectedEnd)

  function cycleRow(c: OfferableCycle, index: number, which: 'from' | 'to') {
    const isSelected = which === 'from' ? fromIndex === index : toIndex === index
    // 🚨 An impossible window is never OFFERED (an impossible window is never offered) — the invalid rows
    // are disabled as the other end moves, rather than being accepted and
    // then complained about.
    const blocked = (which === 'to' && index < fromIndex) || (which === 'from' && index > toIndex)
    const tag = tagFor(c) || (blocked && which === 'to' ? 'before start' : '')
    return (
      <button
        key={c.start}
        data-index={index}
        disabled={blocked}
        aria-pressed={isSelected}
        onClick={() => {
          // 🚨 Commit the cycle's OWN bounds from the walker, never a date
          // re-parsed from the label (display what you key) — the exact defect
          // verify-overpayment-picker-real-dates.ts exists to prevent.
          if (which === 'from') setFromIndex(index)
          else setToIndex(index)
        }}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm"
        style={{ color: blocked ? 'var(--color-ink-faint)' : 'var(--color-ink)', opacity: blocked ? 0.55 : 1 }}
      >
        <span className="w-4 shrink-0 text-[var(--color-coral)]">{isSelected ? '✓' : ''}</span>
        <span className="flex-1 truncate">{c.label}</span>
        {tag && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full border" style={{ borderColor: 'var(--color-track)', color: 'var(--color-ink-muted)' }}>
            {tag}
          </span>
        )}
      </button>
    )
  }

  function chips(which: 'start' | 'end') {
    // 🚨 The chips SET the input (the chips SET the input). They are a shortcut INTO the
    // native control, not a caption beside it.
    return (
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {cycles.map((c) => {
            const value = which === 'start' ? c.start : c.end
            const lit = which === 'start' ? exactStart === value : exactEnd === value
            return (
              <button
                key={value}
                onClick={() => (which === 'start' ? setExactStart(value) : setExactEnd(value))}
                aria-pressed={lit}
                className="shrink-0 text-[11px] px-2 py-1 rounded-full border"
                style={{
                  borderColor: lit ? 'var(--color-coral)' : 'var(--color-track)',
                  color: lit ? 'var(--color-coral)' : 'var(--color-ink-muted)',
                }}
              >
                {value.slice(8)}/{value.slice(5, 7)}
              </button>
            )
          })}
      </div>
    )
  }

  const cycleCount = containing.length

  return createPortal(
    <div className="fixed inset-0 z-[600] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] max-h-[88vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-base font-semibold text-[var(--color-ink)] mb-1">Download statement</h3>
        <p className="text-xs text-[var(--color-ink-muted)] mb-4 leading-relaxed">
          The file always holds whole cycles. You can trim it to the exact dates once it is open.
        </p>

        <div className="flex gap-1 p-1 rounded-full mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
          {(['cycles', 'exact'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className="flex-1 py-1.5 rounded-full text-xs font-medium"
              style={{ background: mode === m ? 'var(--color-surface)' : 'transparent', color: mode === m ? 'var(--color-ink)' : 'var(--color-ink-muted)' }}
            >
              {m === 'cycles' ? 'Whole cycles' : 'Exact dates'}
            </button>
          ))}
        </div>

        {mode === 'cycles' ? (
          <>
            <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)] mb-1">From</p>
            <div ref={fromListRef} className="max-h-40 overflow-y-auto rounded-xl mb-3 relative" style={{ background: 'var(--color-bg)' }}>
              {cycles.map((c, i) => cycleRow(c, i, 'from'))}
            </div>
            <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)] mb-1">To</p>
            <div ref={toListRef} className="max-h-40 overflow-y-auto rounded-xl mb-3 relative" style={{ background: 'var(--color-bg)' }}>
              {cycles.map((c, i) => cycleRow(c, i, 'to'))}
            </div>
          </>
        ) : (
          <>
            <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)] mb-1">Start</p>
            <input
              type="date"
              value={exactStart}
              onChange={(e) => setExactStart(e.target.value)}
              className="w-full mb-1 px-3 py-2 rounded-xl text-sm"
              style={{ background: 'var(--color-bg)', color: 'var(--color-ink)', boxSizing: 'border-box' }}
            />
            <p className="text-[10px] text-[var(--color-ink-faint)] mb-1">Cycle starts — tap to set</p>
            {chips('start')}
            <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)] mt-3 mb-1">End</p>
            <input
              type="date"
              value={exactEnd}
              onChange={(e) => setExactEnd(e.target.value)}
              className="w-full mb-1 px-3 py-2 rounded-xl text-sm"
              style={{ background: 'var(--color-bg)', color: 'var(--color-ink)', boxSizing: 'border-box' }}
            />
            <p className="text-[10px] text-[var(--color-ink-faint)] mb-1">Cycle ends — tap to set</p>
            {chips('end')}
          </>
        )}

        {/* 🚨 A clamped window explains itself BEFORE anything is generated
            (a clamped window explains itself), as well as inside the file. A statement shorter than
            it was asked to be, with nothing to say why, is one nobody can
            trust — and a silent clamp is indistinguishable from missing
            data. */}
        {clamped && (
          <div className="mt-4 p-3 rounded-xl text-xs leading-relaxed" style={{ background: 'rgba(245,165,36,0.12)', borderLeft: '3px solid var(--color-warning, #f5a524)', color: 'var(--color-ink)' }}>
            <strong>This is as far back as the data goes.</strong> The opening balance was reconciled on {formatFullDate(earliestAvailable)}, so earlier cycles hold nothing. The statement will start there.
          </div>
        )}

        <div className="mt-4 p-3 rounded-r-xl" style={{ background: 'var(--color-bg)', borderLeft: '3px solid var(--color-coral)' }}>
          <p className="font-display text-sm font-semibold text-[var(--color-ink)]">
            {containing.length > 0 ? `${cycleLabel(containing[0].start, containing[containing.length - 1].end)}` : '—'}
          </p>
          <p className="text-[11px] text-[var(--color-ink-muted)] mt-1 leading-relaxed">
            {cycleCount} whole cycle{cycleCount === 1 ? '' : 's'}, with a table break at each one.
            {trimmed ? ' The file opens trimmed to the dates you chose, and can show the full cycles instead.' : ''}
          </p>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-full text-sm font-medium text-[var(--color-ink-muted)]" style={{ background: 'var(--color-bg-elevated)' }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm(selected, 'preview')}
            className="flex-1 py-2.5 rounded-full text-sm font-semibold text-[var(--color-ink)]"
            style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-coral)' }}
          >
            Preview
          </button>
          <button onClick={() => onConfirm(selected, 'save')} className="flex-1 py-2.5 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-coral)' }}>
            Save
          </button>
        </div>
        {/* 🚨 Said here, at the point of choosing, not discovered later on
            the way to a laptop: a saved .html opens in the Files app's
            Quick Look, which renders the markup but does not run scripts,
            and iOS no longer offers "open in Safari" for a local file. A
            page with buttons and no table is indistinguishable from a
            broken statement (Adam, 2026-09-24 UAT). */}
        <p className="text-[10.5px] text-center mt-2.5 leading-relaxed text-[var(--color-ink-faint)]">
          <strong className="text-[var(--color-ink-muted)]">Preview</strong> opens it here.{' '}
          <strong className="text-[var(--color-ink-muted)]">Save</strong> gives you the file — iPhones can't open it, so email or AirDrop it to
          your laptop.
        </p>
      </div>
    </div>,
    document.body,
  )
}

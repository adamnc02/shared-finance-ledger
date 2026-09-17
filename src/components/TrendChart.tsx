// Trends feature (2026-09-15 build) — the two interactive chart styles:
// BalanceSpendChart (line/area, Personal/Joint/Household/Credit Card/Pot)
// and SavingsPotPillChart (vertical columns, Savings Pot only). Both hand-
// roll their own scale/path math and pointer-event gesture handling rather
// than reaching for a charting library's own tooltip/trigger system — see
// the Trends prompt doc's own "Library recommendation" section for why:
// the tap-and-hold-then-drag-between-points gesture with all-other-points-
// blur is bespoke, and no mainstream library (Recharts/visx/Chart.js/Nivo)
// ships it as a built-in trigger mode.
//
// DEVIATION FLAGGED (prompt doc explicitly allows this as the documented
// fallback, "call this out explicitly... but don't block on asking
// first"): this build uses NO new dependency at all (not even
// @visx/scale/@visx/shape or d3-scale/d3-shape) — every bit of scale and
// path math below is plain arithmetic against an SVG viewBox. The doc's
// stated default was to add the small visx/d3 primitives; this fallback
// (explicitly pre-approved, zero new deps) was chosen instead to keep the
// build self-contained without an extra install/lockfile step.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BalanceSpendTrendSeries } from '../lib/runningBalance'
import type { SavingsPotPillPoint, SavingsPotTrendSeries } from '../lib/savingsPotLedger'

// ── Shared formatting ───────────────────────────────────────────────────

/** Axis-label money formatting matching the reference screenshots exactly: plain whole pounds under £1,000 ("£527", "-£115"), abbreviated to one decimal place in thousands at/above it ("£1.3K") — NOT the 2-decimal-pence formatting formatCurrency uses for headline figures. */
export function formatAxisMoney(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1000) return `${sign}£${(abs / 1000).toFixed(1)}K`
  return `${sign}£${Math.round(abs)}`
}

export function shortDayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${MONTHS[m - 1]}`
}

// ── Balance/Spend line-area chart ──────────────────────────────────────

export type BalanceSpendView = 'balance' | 'spend'

export interface BalanceSpendChartProps {
  series: BalanceSpendTrendSeries
  view: BalanceSpendView
  color: string
  /** Non-interactive small preview (Trends section, inline per card) vs the full interactive chart (TrendsModal) — no tap-and-hold/tooltip/axis labels in preview mode, per the prompt doc's own "small... non-interactive, no tap-and-hold/tooltip behaviour here" spec for the inline section. */
  interactive?: boolean
  height?: number
  /** Reports the active tap-and-hold point so the caller can render its own tooltip (with category-icon content, via its own dayIcons lookup) in the modal's callout area above the chart, instead of overlaying it on the chart itself — mirrors SavingsPotPillChart's onActivePointChange. */
  onActivePointChange?: (point: { date: string; value: number } | null) => void
}

const WIDTH = 320

function scaleX(i: number, count: number): number {
  return count <= 1 ? 0 : (i / (count - 1)) * WIDTH
}

function makeYScale(values: number[], height: number, padTop: number, padBottom: number) {
  const min = Math.min(0, ...values)
  const max = Math.max(...values, min + 1)
  const span = max - min || 1
  return (v: number) => padTop + (1 - (v - min) / span) * (height - padTop - padBottom)
}

/**
 * Client x → viewBox x, via the SVG's own screen transform.
 *
 * BUGFIX (2026-09-16, PROMPT-04 Bug A — measured, not assumed): both charts
 * are `width="100%"` with a fixed viewBox and no preserveAspectRatio, so the
 * default `xMidYMid meet` scales the drawing UNIFORMLY and centres it. In the
 * 350px-wide Trends modal on a 390px phone the pill chart's 320×160 viewBox
 * draws at scale 1.0 with 15px of dead margin each side, and the line chart's
 * 364-wide viewBox draws at 0.962. The old hit-tests scaled by
 * `(clientX - rect.left) / rect.width * WIDTH`, i.e. assumed the drawing filled
 * the element edge to edge (and, for the line chart, that the viewBox was 320
 * wide rather than 320 + padRight) — so the pill chart highlighted the column
 * to the right at the left edge and to the left at the right edge, and the line
 * chart's crosshair trailed the finger by up to 38px. getScreenCTM() is the
 * transform the browser actually rendered with, letterboxing included, so this
 * is correct by construction at any element size or aspect ratio.
 */
function clientToViewBoxX(svg: SVGSVGElement, clientX: number): number | null {
  const ctm = svg.getScreenCTM()
  if (!ctm || ctm.a === 0) return null
  return (clientX - ctm.e) / ctm.a
}

function linePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

function areaPath(points: { x: number; y: number }[], baselineY: number): string {
  if (points.length === 0) return ''
  const top = linePath(points)
  const last = points[points.length - 1]
  const first = points[0]
  return `${top} L${last.x.toFixed(1)},${baselineY.toFixed(1)} L${first.x.toFixed(1)},${baselineY.toFixed(1)} Z`
}

export function BalanceSpendChart({ series, view, color, interactive = false, height = 200, onActivePointChange }: BalanceSpendChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)

  const days = series.days
  const todayIdx = days.indexOf(series.todayIso)
  const splitIdx = todayIdx === -1 ? days.length - 1 : todayIdx

  const padTop = interactive ? 24 : 6
  const padBottom = interactive ? 22 : 4
  const padRight = interactive ? 44 : 2

  let solidPoints: { x: number; y: number; date: string; value: number }[] = []
  let dottedPoints: { x: number; y: number; date: string; value: number }[] = []
  let comparePoints: { x: number; y: number }[] = []
  let allValues: number[] = []
  let yScale: (v: number) => number

  if (view === 'balance') {
    allValues = series.balance.flatMap((b) => [b.clearedBalance, b.projectedBalance])
    yScale = makeYScale(allValues, height, padTop, padBottom)
    solidPoints = series.balance.slice(0, splitIdx + 1).map((b, i) => ({ x: scaleX(i, days.length), y: yScale(b.clearedBalance), date: b.date, value: b.clearedBalance }))
    // The dotted continuation starts exactly where the solid line ends (today's real
    // clearedBalance), then tracks the SAME shape/deltas the projected series takes from
    // there on — rather than jumping straight to today's own projectedBalance, which can
    // already differ from clearedBalance (e.g. a bill pending today) and made the two
    // segments visibly disconnect at the join.
    const baseCleared = series.balance[splitIdx].clearedBalance
    const baseProjected = series.balance[splitIdx].projectedBalance
    dottedPoints = series.balance.slice(splitIdx).map((b, i) => {
      const value = baseCleared + (b.projectedBalance - baseProjected)
      return { x: scaleX(i + splitIdx, days.length), y: yScale(value), date: b.date, value }
    })
  } else {
    allValues = [...series.spend.map((s) => s.spendToDate), ...series.previousPeriodSpend.map((s) => s.spendToDate)]
    yScale = makeYScale(allValues, height, padTop, padBottom)
    solidPoints = series.spend.slice(0, splitIdx + 1).map((s, i) => ({ x: scaleX(i, days.length), y: yScale(s.spendToDate), date: s.date, value: s.spendToDate }))
    dottedPoints = series.spend.slice(splitIdx).map((s, i) => ({ x: scaleX(i + splitIdx, days.length), y: yScale(s.spendToDate), date: s.date, value: s.spendToDate }))
    comparePoints = series.previousPeriodSpend.map((s, i) => ({ x: scaleX(i, days.length), y: yScale(s.spendToDate) }))
  }

  const zeroY = yScale(0)
  // Area fill baseline sits at zero, not the axis minimum — so shading always reads as
  // "distance above/below zero" and doesn't bleed into the below-zero band the balance
  // view shades separately (see the zero-line rect below).
  const baselineY = zeroY

  function valueAt(i: number): number {
    if (view !== 'balance') return series.spend[i]?.spendToDate ?? 0
    if (i <= splitIdx) return series.balance[i].clearedBalance
    return series.balance[splitIdx].clearedBalance + (series.balance[i].projectedBalance - series.balance[splitIdx].projectedBalance)
  }

  function hitTest(clientX: number) {
    const svg = svgRef.current
    if (!svg) return
    const relX = clientToViewBoxX(svg, clientX)
    if (relX === null) return
    let closest = 0
    let closestDist = Infinity
    for (let i = 0; i < days.length; i++) {
      const x = scaleX(i, days.length)
      const dist = Math.abs(x - relX)
      if (dist < closestDist) {
        closestDist = dist
        closest = i
      }
    }
    setActiveIndex(closest)
    onActivePointChange?.({ date: days[closest], value: valueAt(closest) })
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive) return
    e.preventDefault()
    dragging.current = true
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    hitTest(e.clientX)
  }
  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive || !dragging.current) return
    hitTest(e.clientX)
  }
  function endGesture() {
    dragging.current = false
    setActiveIndex(null)
    onActivePointChange?.(null)
  }

  const minValue = Math.min(0, ...allValues)

  return (
    <div style={{ position: 'relative', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH + padRight} ${height}`}
        width="100%"
        height={height}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerLeave={endGesture}
        onContextMenu={(e) => interactive && e.preventDefault()}
        style={{ touchAction: interactive ? 'none' : undefined, display: 'block', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
      >
        {interactive && (
          <>
            <line x1={0} y1={padTop} x2={WIDTH} y2={padTop} stroke="var(--color-track)" strokeWidth={1} />
            <line x1={0} y1={height - padBottom} x2={WIDTH} y2={height - padBottom} stroke="var(--color-track)" strokeWidth={1} />
          </>
        )}

        {view === 'balance' && (
          <rect x={0} y={zeroY} width={WIDTH} height={Math.max(0, height - padBottom - zeroY)} fill="rgba(255,255,255,0.035)" />
        )}
        {view === 'balance' && (
          <line x1={0} y1={zeroY} x2={WIDTH} y2={zeroY} stroke="var(--color-track)" strokeWidth={1} />
        )}

        {(view === 'spend' || view === 'balance') && (
          <path d={areaPath(solidPoints, baselineY)} fill={color} opacity={activeIndex !== null ? 0.08 : 0.16} />
        )}
        {view === 'spend' && comparePoints.length > 1 && (
          <path d={linePath(comparePoints)} fill="none" stroke="var(--color-ink-faint)" strokeWidth={1.5} strokeDasharray="3,3" opacity={0.7} />
        )}

        <path
          d={linePath(solidPoints)}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          opacity={activeIndex !== null && activeIndex > splitIdx ? 0.3 : 1}
        />
        {dottedPoints.length > 1 && (
          <path d={linePath(dottedPoints)} fill="none" stroke="var(--color-ink-faint)" strokeWidth={2} strokeDasharray="4,4" />
        )}

        {activeIndex !== null && (
          <>
            <line x1={scaleX(activeIndex, days.length)} y1={padTop} x2={scaleX(activeIndex, days.length)} y2={height - padBottom} stroke={color} strokeWidth={1.5} strokeDasharray="3,3" />
            <circle cx={scaleX(activeIndex, days.length)} cy={activeIndex <= splitIdx ? solidPoints[activeIndex]?.y : dottedPoints[activeIndex - splitIdx]?.y} r={5} fill="var(--color-bg-elevated)" stroke={color} strokeWidth={2.5} />
          </>
        )}
        {activeIndex === null && solidPoints.length > 0 && (
          <circle cx={solidPoints[solidPoints.length - 1].x} cy={solidPoints[solidPoints.length - 1].y} r={5} fill="var(--color-bg-elevated)" stroke={color} strokeWidth={2.5} />
        )}

        {interactive && (
          <>
            <text x={0} y={height - 4} fontSize={11} fill="var(--color-ink-faint)">{shortDayLabel(days[0])}</text>
            <text x={WIDTH} y={height - 4} fontSize={11} fill="var(--color-ink-faint)" textAnchor="end">{shortDayLabel(days[days.length - 1])}</text>
            <text x={WIDTH + padRight - 2} y={padTop + 4} fontSize={11} fill="var(--color-ink-faint)" textAnchor="end">{formatAxisMoney(Math.max(...allValues))}</text>
            <text x={WIDTH + padRight - 2} y={height - padBottom} fontSize={11} fill={minValue < 0 ? 'var(--color-negative)' : 'var(--color-ink-faint)'} textAnchor="end">{formatAxisMoney(minValue)}</text>
            {/* The £0 constant line only needs its own label when it sits somewhere between the
                max/min labels above — if the balance never goes negative, minValue is already 0
                and the bottom label above already reads "£0", so this would just duplicate it. */}
            {view === 'balance' && minValue < 0 && (
              <text x={WIDTH + padRight - 2} y={zeroY + 4} fontSize={11} fill="var(--color-ink-faint)" textAnchor="end">£0</text>
            )}
          </>
        )}
      </svg>
    </div>
  )
}

// ── Savings Pot pill/column chart ──────────────────────────────────────

export interface SavingsPotPillChartProps {
  series: SavingsPotTrendSeries
  color: string
  interactive?: boolean
  height?: number
  /** Rendered over the card's own callout/header area, per the prompt doc ("tooltip renders over the callout section... not floating next to the tapped column") — the caller (SavingsPotDetail/TrendsModal) owns that placement; this component just reports which point is active via this callback. */
  onActivePointChange?: (point: SavingsPotPillPoint | null) => void
}

const MAX_PILL_WIDTH = 24

export function SavingsPotPillChart({ series, color, interactive = false, height = 140, onActivePointChange }: SavingsPotPillChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)

  const points = series.points
  const padTop = 4
  const padBottom = interactive ? 18 : 2
  const trackHeight = height - padTop - padBottom
  // Stride first, bar width derived from it, so n columns always span exactly WIDTH.
  // Previously barWidth was clamped to >= 2 with a fixed 3px gap, so past 64 columns
  // the stride exceeded WIDTH / n and the later columns rendered outside the viewBox —
  // invisible and unreachable. Not reachable at today's granularities; latent.
  const stride = points.length > 0 ? WIDTH / points.length : WIDTH
  // Capped and centred in its slot: with few columns (a pot opened this cycle has ONE Year
  // column) an uncapped pill spanned the whole chart and rendered as an ellipse. The slot, not
  // the drawn pill, stays the touch target, so hit-testing below is unchanged.
  const barGap = Math.min(3, stride / 3)
  const barWidth = Math.min(MAX_PILL_WIDTH, stride - barGap)

  // Column heights (Adam, 2026-09-16 — corrects the first build): every
  // column's background track is full height and stands for the highest
  // balance the pot reaches anywhere in this view (series.peakBalance,
  // including a peak inside a single day); the coloured fill is that
  // period's END BALANCE against it — the original Trends spec's "each
  // column is the pot's end-of-period balance". The first build drew the
  // fill from |netChange| instead, so on Adam's pot the only tall column
  // was the day he withdrew £242, and the day it held £242.85 was flat.
  // The net saved/withdrawn figure lives in the tooltip, not in bar height.
  const scaleMax = series.peakBalance > 0 ? series.peakBalance : 1

  function fillHeight(balance: number) {
    return Math.min(trackHeight, (Math.max(0, balance) / scaleMax) * trackHeight)
  }

  // Cap x-axis LABELS at 4 even though every column still renders — per
  // the prompt doc's own table ("Both Savings Pot's 'This Cycle'/'Last 6
  // Cycles' groupings cap x-axis labels at 4 even when more columns
  // render").
  const labelIndices = new Set<number>()
  if (points.length > 0) {
    const maxLabels = Math.min(4, points.length)
    for (let i = 0; i < maxLabels; i++) {
      labelIndices.add(Math.round((i / Math.max(1, maxLabels - 1)) * (points.length - 1)))
    }
  }

  function hitTest(clientX: number) {
    const svg = svgRef.current
    if (!svg || points.length === 0) return
    const relX = clientToViewBoxX(svg, clientX)
    if (relX === null) return
    const idx = Math.min(points.length - 1, Math.max(0, Math.floor(relX / stride)))
    setActiveIndex(idx)
    onActivePointChange?.(points[idx])
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive) return
    e.preventDefault()
    dragging.current = true
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    hitTest(e.clientX)
  }
  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!interactive || !dragging.current) return
    hitTest(e.clientX)
  }
  function endGesture() {
    dragging.current = false
    setActiveIndex(null)
    onActivePointChange?.(null)
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${height}`}
      width="100%"
      height={height}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={endGesture}
      onContextMenu={(e) => interactive && e.preventDefault()}
      style={{ touchAction: interactive ? 'none' : undefined, display: 'block', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
    >
      {points.map((p, i) => {
        const h = Math.max(2, fillHeight(p.endBalance))
        const x = i * stride + (stride - barWidth) / 2
        const y = height - padBottom - h
        const isActive = activeIndex === i
        return (
          <g key={`${p.periodStart}-${i}`}>
            <rect x={x} y={padTop} width={barWidth} height={trackHeight} rx={barWidth / 2} fill="var(--color-track)" opacity={0.4} />
            <rect x={x} y={y} width={barWidth} height={h} rx={barWidth / 2} fill={color} opacity={activeIndex === null || isActive ? 1 : 0.3} />
            {interactive && labelIndices.has(i) && (
              <text x={x + barWidth / 2} y={height - 4} fontSize={9} textAnchor="middle" fill="var(--color-ink-faint)">
                {p.axisLabel}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

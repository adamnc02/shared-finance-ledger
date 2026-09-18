import { PROGRESS_BAR_MARKERS, progressBarGeometry, progressTooltipLayout } from '../lib/progressSection'

interface ProgressBarProps {
  /** 0-100, how much of the bar is filled right now. */
  percent: number
  /**
   * Optional — when set and greater than `percent`, a translucent (50%
   * opacity) extension is drawn from `percent` out to this value, showing
   * where the bar is projected to be by the end of the current horizon.
   * The solid segment is never touched by it, exactly as ProgressRing's
   * projected arc works: both go through `progressBarGeometry`, which is
   * ProgressRing's own cumulative-segment rule written down once.
   */
  projectedPercent?: number
  color?: string
  trackColor?: string
  /** Bar thickness. The default is the "total" bar; the smaller per-loan bars on Joint/Household pass 8. */
  height?: number
  /**
   * A per-loan bar's own label, shown above the tooltip in the app's
   * standard faded-italic sub-label style (the one EffectiveDatedChangeFlow
   * and RecurringChangeConfirmModal use). The combined/total bar has none —
   * the section title above it already says what it is.
   */
  name?: string
  /**
   * The 25/50/75 axis figures under the bar. On by default for the
   * headline bar, off for the small per-loan bars, where three sets of
   * repeated axis numbers say nothing the first set didn't.
   */
  showAxis?: boolean
}

// The mini-tooltip's own dimensions. Only these four are pixels; every
// horizontal POSITION is a percentage of the bar's width (see
// progressTooltipLayout), which is what stops the arrows drifting.
const TOOLTIP_H = 22
const ARROW_H = 6
const ARROW_HALF_W = 5
/** Breathing room between the arrow's tip and the bar (Adam, 2026-09-18) — the tip pointed at the bar from hard against it. */
const ARROW_GAP = 5
/** The arrow is drawn twice: a slightly larger triangle in the card's own colour behind a `--color-bg` one, leaving a thin tinted rim along the slanted edges and the tip (Adam: "a slight tint to the edge of the arrows using the cards colour, just to highlight the tip"). A CSS border-triangle cannot carry a border of its own, so two stacked triangles is the mechanism. */
const ARROW_RIM = 1.5
/**
 * How far each arrow sits from its nearest end of the box. Adam: "The
 * arrows always need to be the same distance from the end of the tooltip
 * box, with the box stretching to cover." So the box's width is the
 * arrow span plus twice this — unless the label needs more, in which case
 * the arrows simply sit further in, still symmetrically.
 */
const ARROW_INSET = 13
/**
 * Enough for the widest label each variant can produce ("100% paid" and
 * "100-100% paid" at 11px semibold). Fixed rather than measured so the
 * box's width is known at render time, which is what lets it be centred
 * and edge-clamped in pure CSS with no layout pass.
 */
const MIN_W_SINGLE = 80
const MIN_W_DUAL = 106

/**
 * PROMPT-08b Part 1 — the progress SECTION's preview, the direct analogue
 * of TrendPreview's small inline chart. Adam, 2026-09-18:
 *
 *  > "I want a similar feel to the trends preview, where I see a progress
 *  > bar, with x axis markers for 25%, 50%, and 75%, with the loading
 *  > progress fill representing the % of the loan payed back so far, plus
 *  > the faded colour for projected if next 3 cycles is selected."
 *
 * The markers are LINES THROUGH the bar (Adam's choice over ticks under
 * it), overhanging it by 3px top and bottom so they stay visible where
 * the fill has already passed them. They're drawn ON TOP of both
 * segments for that reason, and are non-interactive.
 *
 * Above the bar sits a mini-tooltip carrying the "N% paid" figure, with a
 * down arrow landing exactly on the end of the fill — and under "Next 3
 * cycles", two arrows under one box: one on today's fill, one on the end
 * of the projected extension, reading "25-32% paid". The tooltip row and
 * the bar are siblings of identical width, so a "42%" in one is the same
 * x as a "42%" in the other by construction.
 */
export function ProgressBar({ percent, projectedPercent, color = 'var(--color-coral)', trackColor = 'var(--color-track)', height = 12, name, showAxis = true }: ProgressBarProps) {
  const geo = progressBarGeometry(percent, projectedPercent)
  const tooltip = progressTooltipLayout(geo)
  const MARKER_OVERHANG = 3

  const dual = tooltip.arrowPercents.length > 1
  const label = dual ? `${geo.labelPercent}-${geo.projectedLabelPercent}% paid` : `${geo.labelPercent}% paid`

  // The box stretches to cover the arrow span, or to fit its label,
  // whichever is wider — `max()` of a percentage and a pixel length, which
  // resolves against this container (the bar's width) exactly as the
  // arrows' own percentages do.
  const boxWidth = `max(${dual ? MIN_W_DUAL : MIN_W_SINGLE}px, calc(${tooltip.spanPercent}% + ${ARROW_INSET * 2}px))`
  // Centred on the arrows' midpoint, then clamped so a bar filled to 0% or
  // 100% cannot push the box off the side of the card. Clamping is the one
  // case where an arrow stops being centred in the box — the alternative
  // is a tooltip hanging over the card's edge, and the arrows themselves
  // still land exactly on the fill either way.
  const boxLeft = `clamp(calc(${boxWidth} / 2), ${tooltip.centerPercent}%, calc(100% - ${boxWidth} / 2))`

  return (
    <div className="w-full">
      {name && <p className="text-xs italic text-[var(--color-ink-faint)] truncate mb-1">{name}</p>}

      {/* Same width as the bar below — this is the whole anti-drift
          mechanism, so these two must stay siblings in one w-full parent. */}
      <div className="relative w-full" style={{ height: TOOLTIP_H + ARROW_H + ARROW_GAP }}>
        <div
          className="absolute flex items-center justify-center whitespace-nowrap"
          style={{
            top: 0,
            left: boxLeft,
            transform: 'translateX(-50%)',
            width: boxWidth,
            height: TOOLTIP_H,
            borderRadius: 8,
            background: 'var(--color-bg)',
            color: 'var(--color-ink)',
          }}
        >
          <span className="text-[11px] font-semibold tabular-nums">{label}</span>
        </div>
        {tooltip.arrowPercents.map((p, i) => (
          // Both triangles share the same `left`, so the tinted rim stays
          // concentric with the arrow it outlines and the TIP — the part
          // that has to land on the end of the fill — is still at `p%`.
          <span key={i} aria-hidden>
            <span
              className="absolute"
              style={{
                top: TOOLTIP_H - 1,
                left: `${p}%`,
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: `${ARROW_HALF_W + ARROW_RIM}px solid transparent`,
                borderRight: `${ARROW_HALF_W + ARROW_RIM}px solid transparent`,
                borderTop: `${ARROW_H + ARROW_RIM * 2}px solid ${color}`,
                opacity: 0.6,
              }}
            />
            <span
              className="absolute"
              style={{
                top: TOOLTIP_H,
                left: `${p}%`,
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: `${ARROW_HALF_W}px solid transparent`,
                borderRight: `${ARROW_HALF_W}px solid transparent`,
                borderTop: `${ARROW_H}px solid var(--color-bg)`,
              }}
            />
          </span>
        ))}
      </div>

      <div className="relative w-full" style={{ height, background: trackColor, borderRadius: 999 }}>
        {/* Both segments in one flex row, so the faded one always starts
            exactly where the solid one stops — no absolute-left arithmetic
            to drift out of step with the geometry helper. */}
        <div className="absolute inset-0 flex" style={{ borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${geo.fillPercent}%`, background: color, transition: 'width 0.6s ease' }} />
          <div style={{ width: `${geo.projectedPercent}%`, background: color, opacity: 0.5, transition: 'width 0.6s ease' }} />
        </div>
        {PROGRESS_BAR_MARKERS.map((m) => (
          <span
            key={m}
            aria-hidden
            className="absolute"
            style={{
              left: `${m}%`,
              top: -MARKER_OVERHANG,
              height: height + MARKER_OVERHANG * 2,
              width: 1,
              background: 'var(--color-ink-faint)',
              opacity: 0.55,
            }}
          />
        ))}
      </div>

      {showAxis && (
        <div className="relative w-full" style={{ height: 14 }}>
          {PROGRESS_BAR_MARKERS.map((m) => (
            <span key={m} className="absolute text-[10px] text-[var(--color-ink-faint)] tabular-nums" style={{ left: `${m}%`, top: 3, transform: 'translateX(-50%)' }}>
              {m}%
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

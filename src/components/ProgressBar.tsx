import { PROGRESS_BAR_MARKERS, progressBarGeometry } from '../lib/progressSection'

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
   * A per-loan bar's own label, shown left of the percentage above the
   * bar in the app's standard faded-italic sub-label style (the one
   * EffectiveDatedChangeFlow and RecurringChangeConfirmModal use). The
   * combined/total bar has none — the section title above it already
   * says what it is.
   */
  name?: string
  /**
   * The 25/50/75 axis figures under the bar. On by default for the
   * headline bar, off for the small per-loan bars, where three sets of
   * repeated axis numbers say nothing the first set didn't.
   */
  showAxis?: boolean
}

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
 */
export function ProgressBar({ percent, projectedPercent, color = 'var(--color-coral)', trackColor = 'var(--color-track)', height = 12, name, showAxis = true }: ProgressBarProps) {
  const geo = progressBarGeometry(percent, projectedPercent)
  const MARKER_OVERHANG = 3

  return (
    <div className="w-full">
      {/* The data label Adam asked for: whole percent, no decimals. On a
          per-loan bar it shares the row with that loan's name. */}
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        {name ? <span className="text-xs italic text-[var(--color-ink-faint)] truncate">{name}</span> : <span />}
        <span className="text-xs font-semibold text-[var(--color-ink)] tabular-nums shrink-0">
          {geo.labelPercent}
          {geo.projectedLabelPercent !== undefined && <span style={{ color: 'var(--color-coral)' }}>→{geo.projectedLabelPercent}</span>}% paid
        </span>
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

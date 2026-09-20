import type { RagSegment } from '../lib/progressSection'
import { RAG_SEGMENT_COLORS } from '../lib/progressSection'

interface ProgressRingProps {
  percent: number // 0-100, how much of the ring should be filled right now
  // Optional — when set and greater than `percent`, an additional
  // translucent (50% opacity) arc is drawn from `percent` out to this
  // value, showing where the ring is projected to be by some future
  // point (e.g. the end of a 3-cycle horizon) on top of where it
  // genuinely stands today. The solid `percent` arc is never touched by
  // this — it's always exactly today's real figure.
  //
  // 🚨 PROMPT-13 (2026-09-20): this two-arc treatment is what CREDIT-CARD
  // and SAVINGS-POT rings still use, and it is deliberately unchanged.
  // Only LOAN rings moved to the three-segment RAG treatment below
  // ("We will keep this just to loans, exclude credit cards from this
  // work... Debt rings only" — Adam). `verify-progress-section.ts`
  // asserts the card and pot rings are byte-for-byte unaffected.
  projectedPercent?: number
  /**
   * PROMPT-13 Part A — the RAG mode, used by loan rings ONLY.
   *
   * When present this REPLACES `percent`/`projectedPercent` rendering
   * entirely: the ring is drawn as N solid, round-capped arcs from
   * `ragProgress` (green paid / amber projected / red remaining), which
   * always sum to 100. Absent, the component behaves exactly as it did
   * before this prompt — that is what keeps the card and pot rings out of
   * scope rather than merely untouched by accident.
   */
  segments?: RagSegment[]
  size?: number
  strokeWidth?: number
  color?: string
  trackColor?: string
  icon?: React.ReactNode
  value: string
  label: string
}

/**
 * ── How adjacent round-capped segments are kept from overlapping ───────
 *
 * PROMPT-13 A1 required this to be decided once, here, and written down,
 * because getting it wrong "will look like a rendering bug at small
 * percentages".
 *
 * THE CHOICE MADE: a small angular GAP between segments — the first of
 * the two options the prompt offered, and what most donut charts do.
 * Z-ordering was rejected: it only hides the overlap, so the boundary
 * between green and amber still sits half a stroke-width away from the
 * number it represents, and the last segment drawn always eats into its
 * neighbour.
 *
 * THE MECHANISM. `strokeLinecap="round"` extends each end of an arc by
 * HALF THE STROKE WIDTH beyond the path's real endpoint. So two arcs
 * butted together at the same angle overlap by a full stroke width. Each
 * segment's drawn path is therefore INSET at both ends by
 * `strokeWidth / 2 + SEGMENT_GAP / 2`: the round cap then fills back out
 * to (near enough) the nominal boundary, and what is left between two
 * neighbours is `SEGMENT_GAP` of visible background.
 *
 * The consequence to know about: a segment's path can inset to nothing.
 * An arc shorter than `2 × inset` would render with a NEGATIVE dash
 * length, which SVG draws as a full circle — i.e. a 0.3% segment would
 * paint the entire ring. Those segments are dropped instead (see
 * `visibleLength <= 0` below). A sub-1% arc is not legible at any size
 * anyway, and dropping it is why the ring degrades quietly rather than
 * catastrophically.
 *
 * The single-segment case skips all of this and draws a plain full
 * circle: a 100% ring with a gap cut into it reads as a bug, not a
 * detail.
 */
const SEGMENT_GAP = 4 // px of visible background between two adjacent arcs

export function ProgressRing({
  percent,
  projectedPercent,
  segments,
  size = 220,
  strokeWidth = 22,
  color = 'var(--color-coral)',
  trackColor = 'var(--color-track)',
  icon,
  value,
  label,
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, percent))
  // Cumulative-segment technique (the standard SVG multi-arc donut-chart
  // approach): each segment gets its own `stroke-dasharray` of exactly
  // [its own length, everything else], offset by the negative sum of
  // every segment drawn before it. That keeps the segments' start/end
  // points mathematically exact regardless of how many there are, so the
  // projected segment always picks up exactly where the real one stops
  // rather than approximating it.
  const solidLength = (clamped / 100) * circumference
  const clampedProjected = projectedPercent !== undefined ? Math.max(clamped, Math.min(100, projectedPercent)) : clamped
  const shadowLength = ((clampedProjected - clamped) / 100) * circumference

  // The RAG arcs, laid out with the gap treatment described above. Built
  // here rather than inline so the drawable/undrawable decision is made
  // once, in one place, for every segment.
  const ragArcs = (() => {
    if (!segments || segments.length === 0) return null
    const drawn = segments.filter((s) => s.percent > 0)
    // A single segment owning the whole ring: plain circle, no caps, no
    // gap. Also covers a 0%-paid ring, where only red survives the filter.
    if (drawn.length <= 1) {
      const only = drawn[0]
      if (!only) return []
      return [{ kind: only.kind, full: true, length: 0, offset: 0 }]
    }
    const inset = strokeWidth / 2 + SEGMENT_GAP / 2
    const arcs: { kind: RagSegment['kind']; full: boolean; length: number; offset: number }[] = []
    let cursor = 0
    for (const s of segments) {
      const rawLength = (s.percent / 100) * circumference
      const visibleLength = rawLength - 2 * inset
      // Too short to inset — dropping it is the documented degradation.
      // Drawing it would set a negative dash length and paint the whole
      // ring in this segment's colour.
      if (visibleLength > 0) arcs.push({ kind: s.kind, full: false, length: visibleLength, offset: -(cursor + inset) })
      cursor += rawLength
    }
    return arcs
  })()

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          {/* Kept underneath in every mode, including RAG where the
              segments already sum to 100 and cover it — it is what makes
              a 0%-paid ring look deliberate rather than broken, and what
              shows through the gaps between segments. */}
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />

          {ragArcs
            ? ragArcs.map((arc) =>
                arc.full ? (
                  <circle key={arc.kind} cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={RAG_SEGMENT_COLORS[arc.kind]} strokeWidth={strokeWidth} />
                ) : (
                  <circle
                    key={arc.kind}
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    // Every RAG segment is SOLID and round-capped —
                    // including amber, which used to be the 50%-opacity
                    // arc with no linecap at all. That missing cap is
                    // exactly the ragged end Adam reported.
                    stroke={RAG_SEGMENT_COLORS[arc.kind]}
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${arc.length} ${circumference - arc.length}`}
                    strokeDashoffset={arc.offset}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
                  />
                ),
              )
            : (
              <>
                {shadowLength > 0.01 && (
                  <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={color}
                    strokeOpacity={0.5}
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${shadowLength} ${circumference - shadowLength}`}
                    strokeDashoffset={-solidLength}
                    style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
                  />
                )}
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${solidLength} ${circumference - solidLength}`}
                  strokeDashoffset={0}
                  strokeLinecap="round"
                  style={{ transition: 'stroke-dasharray 0.6s ease' }}
                />
              </>
            )}
        </svg>
        {icon && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ color }}>
            {icon}
          </div>
        )}
      </div>
      <div className="flex flex-col items-center gap-1">
        <span className="font-display text-3xl font-semibold text-[var(--color-ink)] tabular-nums">{value}</span>
        <span className="font-body text-sm text-[var(--color-ink-muted)] tracking-wide">{label}</span>
      </div>
    </div>
  )
}

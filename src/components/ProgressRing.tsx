interface ProgressRingProps {
  percent: number // 0-100, how much of the ring should be filled right now
  // Optional — when set and greater than `percent`, an additional
  // translucent (50% opacity) arc is drawn from `percent` out to this
  // value, showing where the ring is projected to be by some future
  // point (e.g. the end of a 3-cycle horizon) on top of where it
  // genuinely stands today. The solid `percent` arc is never touched by
  // this — it's always exactly today's real figure.
  projectedPercent?: number
  size?: number
  strokeWidth?: number
  color?: string
  trackColor?: string
  icon?: React.ReactNode
  value: string
  label: string
}

export function ProgressRing({
  percent,
  projectedPercent,
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

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
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

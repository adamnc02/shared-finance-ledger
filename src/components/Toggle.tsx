// PROMPT-14 Part 7 (2026-09-22) — the app's switch control, extracted from
// Home.tsx's Filters sheet UNCHANGED.
//
// Why it moved rather than being copied: `src/pages/**` is on DIVERGENCE.md's
// "Explicitly NOT allowed to diverge" list, and the sync app needs this exact
// control in its Account modal for the notifications toggle. Copying the
// markup there would be the TEXTUAL route — two copies of one control, free to
// drift — and the register's own rule is that structural beats textual. One
// shared file, used by both, adds no divergence row and improves both apps.
//
// 🚨 This was a PURE MOVE. The body below is byte-for-byte what Home.tsx had,
// and Home renders identically before and after — proven by the existing sweep
// plus `verify-toggle-extraction.ts`. Any behaviour change here is a change to
// the Filters sheet ("Show cleared", "Cycle-end totals", "Group by direction")
// at the same time, in every app, so make it deliberately or not at all.

export function ToggleSwitch({
  label,
  checked,
  onChange,
  help,
  full,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  /** 2026-09-13 (deck controls cleanup) — a short helper caption under the label, only used in the `full` (FiltersSheet row) layout. */
  help?: string
  /** 2026-09-13 (deck controls cleanup) — the full-width "settings row" layout FiltersSheet uses (label + optional help on the left, a slightly larger switch on the right), instead of the compact inline label+switch pair used elsewhere on this page. */
  full?: boolean
  /** 2026-09-13 follow-up (Adam-specified) — greyed out and non-interactive when the current Group by/Order by selection makes this control inapplicable, rather than hiding the row outright. `full` layout only. */
  disabled?: boolean
}) {
  if (full) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className="w-full flex items-center justify-between gap-3 text-left"
        style={{ opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-[var(--color-ink)]">{label}</span>
          {help && <span className="text-[11px] text-[var(--color-ink-muted)]">{help}</span>}
        </span>
        <span
          className="relative inline-block rounded-full transition-colors shrink-0"
          style={{ width: 38, height: 22, background: checked ? 'var(--color-coral)' : 'var(--color-track)' }}
        >
          <span
            className="absolute rounded-full bg-white transition-transform"
            style={{ width: 18, height: 18, top: 2, left: 2, transform: checked ? 'translateX(16px)' : 'translateX(0)', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }}
          />
        </span>
      </button>
    )
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-[11px] font-medium"
      style={{ color: 'var(--color-ink-muted)' }}
    >
      <span>{label}</span>
      <span
        className="relative inline-block rounded-full transition-colors shrink-0"
        style={{ width: 34, height: 20, background: checked ? 'var(--color-coral)' : 'var(--color-track)' }}
      >
        <span
          className="absolute rounded-full bg-white transition-transform"
          style={{ width: 16, height: 16, top: 2, left: 2, transform: checked ? 'translateX(14px)' : 'translateX(0)', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }}
        />
      </span>
    </button>
  )
}

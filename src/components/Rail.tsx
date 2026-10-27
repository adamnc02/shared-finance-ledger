import { useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { PanelLeft } from 'lucide-react'
import { TABS } from './BottomNav'
import { useLedgerData } from '../context/LedgerContext'
import { horizonCycles } from '../lib/projection'
import { daysBetweenInclusive } from '../lib/runningBalance'
import { readRailExpanded, writeRailExpanded } from '../lib/laptop'

/**
 * The laptop view's side rail, in place of the bottom pill (lib/laptop.ts
 * has the breakpoint). Expanded (232px): the app's logo and name, the six
 * tabs with their labels, and the current pay cycle. Collapsed (76px): the
 * logo and the tab icons only; hovering or focusing an icon names it in a
 * label beside it (`data-tip`, styled in index.css — instant, unlike a
 * native `title`). The collapse button is at the foot.
 *
 * It starts EXPANDED, and remembers per device once collapsed
 * (`readRailExpanded`).
 *
 * The logo is `icon-192.png` from the app's own `public/` and the name is
 * the page's own `apple-mobile-web-app-title`, so this one file shows each
 * ledger app's own artwork and name. 🚨 Never import an icon file here:
 * each app's icons are its own (TEST-APP-DIVERGENCE.md lists them as never
 * ported between repos).
 */
export function Rail() {
  const [expanded, setExpanded] = useState(readRailExpanded)
  const name = useMemo(() => document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content') || 'Ledger', [])

  function toggle() {
    const next = !expanded
    setExpanded(next)
    writeRailExpanded(next)
  }

  return (
    <aside
      role="navigation"
      aria-label="Main"
      className={`rail shrink-0 flex flex-col gap-1.5 border-r ${expanded ? '' : 'rail-min'}`}
      style={{
        width: expanded ? 232 : 76,
        padding: `calc(var(--safe-top) + 28px) 16px 20px`,
        background: 'var(--color-bg-elevated)',
        borderColor: 'var(--color-track)',
      }}
    >
      <div className={`flex items-center gap-2.5 pb-5 ${expanded ? 'px-2.5' : 'justify-center'}`}>
        <img src="./icon-192.png" alt="" width={36} height={36} className="w-9 h-9 rounded-[9px] shrink-0" />
        {expanded && <span className="font-display text-base font-bold leading-tight text-[var(--color-ink)]">{name}</span>}
      </div>

      {TABS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          data-tip={label}
          aria-label={expanded ? undefined : label}
          className={`flex items-center gap-3 h-11 rounded-full text-sm font-semibold transition-colors ${expanded ? 'px-3.5' : 'justify-center'}`}
          style={({ isActive }) => ({
            color: isActive ? '#fff' : 'var(--color-ink-muted)',
            background: isActive ? 'var(--color-coral)' : 'transparent',
          })}
        >
          <Icon size={18} strokeWidth={1.8} className="shrink-0" />
          {expanded && <span>{label}</span>}
        </NavLink>
      ))}

      <div className="flex-1 min-h-6" />
      {expanded && <CycleBox />}

      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse the side bar' : 'Expand the side bar'}
        data-tip="Expand"
        className={`mt-2.5 flex items-center gap-3 h-11 rounded-full text-sm font-semibold text-[var(--color-ink-muted)] ${expanded ? 'px-3.5' : 'justify-center'}`}
      >
        <PanelLeft size={20} strokeWidth={2} className="shrink-0" />
        {expanded && <span>Collapse</span>}
      </button>
    </aside>
  )
}

/** The current pay cycle, from `horizonCycles` — the same bounds Home's "This cycle" uses, so the two can never disagree. */
function CycleBox() {
  const { data } = useLedgerData()
  const cycle = useMemo(() => {
    try {
      const today = new Date()
      const { start, end } = horizonCycles(data, data.primaryPersonId, 'current_cycle', today)[0]
      return { start, end, day: daysBetweenInclusive(start, today).length, length: daysBetweenInclusive(start, end).length }
    } catch {
      return undefined
    }
  }, [data])
  if (!cycle) return null
  const left = cycle.length - cycle.day
  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return (
    <div className="rounded-2xl p-3.5 flex flex-col gap-1" style={{ background: 'var(--color-surface)' }}>
      <span className="text-xs text-[var(--color-ink-muted)]">Pay cycle</span>
      <span className="text-sm font-semibold text-[var(--color-ink)]">
        {fmt(cycle.start)} – {fmt(cycle.end)}
      </span>
      <span className="text-xs text-[var(--color-ink-muted)]">
        Day {cycle.day} of {cycle.length} · {left === 0 ? 'ends today' : `${left} ${left === 1 ? 'day' : 'days'} left`}
      </span>
    </div>
  )
}

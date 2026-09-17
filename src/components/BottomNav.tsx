import { NavLink } from 'react-router-dom'
import { Home, Wallet, Landmark, Receipt, Banknote, FlaskConical } from 'lucide-react'

const TABS = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/salary', label: 'Wallet', icon: Wallet },
  { to: '/loans', label: 'Borrowing', icon: Landmark },
  { to: '/bills', label: 'Bills', icon: Receipt },
  { to: '/expenses', label: 'Transactions', icon: Banknote },
  { to: '/scenarios', label: 'What-if', icon: FlaskConical },
]

export function BottomNav() {
  return (
    <nav
      // Icon stacked above a small, always-visible label — matches the
      // BLOC training app's #nav / .nav-btn treatment (flex-direction:
      // column, label under the icon). BLOC hides the label until a tab
      // is active; this app keeps every label visible at all times, so
      // only the stacking/format changed, not that behaviour.
      //
      // Still anchored to #app-shell (position: relative) rather than
      // the native viewport, since `fixed` breaks on iOS standalone —
      // see earlier revisions of this file for the full explanation.
      className="absolute left-0 right-0 mx-3 flex items-stretch gap-0.5 rounded-full backdrop-blur-lg z-[100] border"
      style={{
        bottom: 'calc(var(--safe-bottom) - 6px)',
        height: 60,
        background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
        borderColor: 'var(--color-track)',
        padding: 5,
        boxShadow: '0 14px 32px rgba(0,0,0,0.38), 0 2px 10px rgba(0,0,0,0.22)',
      }}
    >
      {TABS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center gap-0.5 rounded-full transition-colors ${isActive ? '' : 'opacity-70'}`
          }
          style={({ isActive }) => ({
            color: isActive ? '#fff' : 'var(--color-ink-muted)',
            background: isActive ? 'var(--color-coral)' : 'transparent',
          })}
        >
          <Icon size={17} strokeWidth={1.8} />
          <span className="text-[9px] font-semibold tracking-tight whitespace-nowrap leading-none">{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

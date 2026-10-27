import { useEffect, useRef, type ReactNode } from 'react'
import { HashRouter, Routes, Route, useLocation } from 'react-router-dom'
import { LedgerProvider } from './context/LedgerContext'
import type { LedgerStore } from './lib/store/LedgerStore'
// SYNC APP ONLY (DIVERGENCE.md). This file is the ONE wiring file: sign-in,
// the household and PowerSync all live behind SyncRoot, which hands back the
// store the provider runs on, plus the pieces that need to sit inside it (the
// duplicate-person banner, the daily cloud backup). Everything else in this
// app is byte-identical to personal-ledger's. If this grows beyond wiring,
// the store interface is leaking (BUILD-PLAN Phase 1).
import SyncRoot from './components/SyncRoot'
import { BottomNav } from './components/BottomNav'
import { Rail } from './components/Rail'
import { useWide } from './lib/useWide'
import { AppGuards } from './components/AppGuards'
import { Home } from './pages/Home'
import { Salary } from './pages/Salary'
import { Loans } from './pages/Loans'
import { Bills } from './pages/Bills'
import { Expenses } from './pages/Expenses'
import { Scenarios } from './pages/Scenarios'

/** #app-content is the app's only scroll container, so route changes need to reset its scroll manually. */
function ScrollToTop({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const { pathname } = useLocation()
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 })
  }, [pathname, containerRef])
  return null
}

function App() {
  return <SyncRoot>{(store, extras) => <LedgerApp store={store} extras={extras} />}</SyncRoot>
}

function LedgerApp({ store, extras }: { store: LedgerStore; extras?: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null)
  // Laptop-sized (lib/laptop.ts): the side rail replaces the bottom pill.
  const wide = useWide()

  return (
    <LedgerProvider store={store}>
      {extras}
      <AppGuards>
        <HashRouter>
          {/* The app shell is sized from --app-height (JS-measured in index.html,
              see the script there for why) rather than 100dvh/100vh directly, and
              is the single position:relative anchor the nav is positioned against —
              see BottomNav for why that matters on iOS standalone. */}
          <div
            id="app-shell"
            className={`relative flex overflow-hidden ${wide ? 'flex-row' : 'flex-col'}`}
            style={{ height: 'var(--app-height, 100dvh)', background: 'var(--color-bg)' }}
          >
            <div className="edge-fade edge-fade-top" />
            <div className="edge-fade edge-fade-bottom" />
            {wide && <Rail />}
            <div
              id="app-content"
              ref={contentRef}
              className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden"
              style={{
                paddingTop: 'var(--safe-top)',
                paddingBottom: wide ? 'calc(var(--safe-bottom) + 40px)' : 'calc(var(--nav-h) + var(--safe-bottom) - 6px + 20px)',
                WebkitOverflowScrolling: 'touch',
              }}
            >
              <ScrollToTop containerRef={contentRef} />
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/salary" element={<Salary />} />
                <Route path="/loans" element={<Loans />} />
                <Route path="/bills" element={<Bills />} />
                <Route path="/expenses" element={<Expenses />} />
                <Route path="/scenarios" element={<Scenarios />} />
              </Routes>
            </div>
            {!wide && <BottomNav />}
          </div>
        </HashRouter>
      </AppGuards>
    </LedgerProvider>
  )
}

export default App

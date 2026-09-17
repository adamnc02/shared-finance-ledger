import { useEffect, useRef } from 'react'
import { HashRouter, Routes, Route, useLocation } from 'react-router-dom'
import { LedgerProvider } from './context/LedgerContext'
import { BottomNav } from './components/BottomNav'
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
  const contentRef = useRef<HTMLDivElement>(null)

  return (
    <LedgerProvider>
      <AppGuards>
        <HashRouter>
          {/* The app shell is sized from --app-height (JS-measured in index.html,
              see the script there for why) rather than 100dvh/100vh directly, and
              is the single position:relative anchor the nav is positioned against —
              see BottomNav for why that matters on iOS standalone. */}
          <div
            id="app-shell"
            className="relative flex flex-col overflow-hidden"
            style={{ height: 'var(--app-height, 100dvh)', background: 'var(--color-bg)' }}
          >
            <div className="edge-fade edge-fade-top" />
            <div className="edge-fade edge-fade-bottom" />
            <div
              id="app-content"
              ref={contentRef}
              className="flex-1 overflow-y-auto overflow-x-hidden"
              style={{
                paddingTop: 'var(--safe-top)',
                paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) - 6px + 20px)',
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
            <BottomNav />
          </div>
        </HashRouter>
      </AppGuards>
    </LedgerProvider>
  )
}

export default App

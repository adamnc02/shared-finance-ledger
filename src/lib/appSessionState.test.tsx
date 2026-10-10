// Home's view survives leaving the page, and resets on a fresh app load.
//
// The bug: Home kept its view (Show cleared, the horizon, which card is in
// front, every filter toggle) in plain useState, which the router throws away
// on every tab change — so turning Show cleared on, visiting Bills and coming
// back showed the default view again.
//
// What it pins:
//   1. A value set, then the component unmounted and mounted again (a tab
//      change), comes back as set.
//   2. A fresh module load (an app reload) starts from the default.
//   3. Every piece of Home's view state goes through useAppSessionState — a
//      toggle added later with plain useState would quietly reset again.
//   4. It is never written to localStorage/sessionStorage, which would make
//      the view outlive a reload.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import home from '../pages/Home.tsx?raw'
import source from './appSessionState.ts?raw'

afterEach(cleanup)

async function freshModule() {
  vi.resetModules()
  return import('./appSessionState')
}

function Probe({ use }: { use: typeof import('./appSessionState').useAppSessionState }) {
  const [on, setOn] = use('test:showCleared', false)
  return (
    <button onClick={() => setOn((v) => !v)}>{on ? 'on' : 'off'}</button>
  )
}

describe('useAppSessionState', () => {
  it('keeps a value across unmount and remount (a tab change)', async () => {
    const { useAppSessionState } = await freshModule()
    const first = render(<Probe use={useAppSessionState} />)
    act(() => screen.getByRole('button').click())
    expect(screen.getByRole('button').textContent).toBe('on')
    first.unmount()
    render(<Probe use={useAppSessionState} />)
    expect(screen.getByRole('button').textContent).toBe('on')
  })

  it('starts from the default on a fresh app load', async () => {
    const a = await freshModule()
    const first = render(<Probe use={a.useAppSessionState} />)
    act(() => screen.getByRole('button').click())
    first.unmount()
    const b = await freshModule()
    render(<Probe use={b.useAppSessionState} />)
    expect(screen.getByRole('button').textContent).toBe('off')
  })

  it("routes every piece of Home's view state through it", () => {
    const body = home.slice(home.indexOf('export function Home()'), home.indexOf('const deck = useMemo'))
    for (const name of ['mruSelections', 'horizon', 'grouping', 'order', 'cycleTotals', 'showCleared', 'groupByDirection', 'averageSpendForecast']) {
      expect(body, name).toMatch(new RegExp(`const \\[${name}, set\\w+\\] = useAppSessionState`))
    }
    expect(body).not.toMatch(/= useState\b/)
  })

  it('never persists past a reload', () => {
    const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/localStorage|sessionStorage/)
  })
})

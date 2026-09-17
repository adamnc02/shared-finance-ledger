// PROMPT-06 (2026-09-17) — LedgerProvider against fake LedgerStores, so the
// async-load and subscribe paths the PowerSync store (PROMPT-09) will need
// are built and proven now, with no PowerSync code.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { LedgerProvider, useLedgerData } from './LedgerContext'
import { defaultLedgerData } from '../lib/ledgerStorage'
import type { LedgerStore } from '../lib/store/LedgerStore'
import type { AppDataV2 } from '../types/ledger'

afterEach(() => cleanup())

function seed(name: string): AppDataV2 {
  const data = defaultLedgerData()
  return { ...data, people: data.people.map((p) => ({ ...p, name })) }
}

/** Exposes the context to the test through a mutable handle, and renders the first person's name. */
function Probe({ handle }: { handle: { current: ReturnType<typeof useLedgerData> | null } }) {
  const ledger = useLedgerData()
  handle.current = ledger
  return (
    <div>
      <span data-testid="name">{ledger.data.people[0]?.name}</span>
      <span data-testid="generation">{ledger.importGeneration}</span>
    </div>
  )
}

function fakeStore(load: LedgerStore['load'], extra: Partial<LedgerStore> = {}) {
  const save = vi.fn<LedgerStore['save']>()
  const store: LedgerStore = { load, save, ...extra }
  return { store, save }
}

describe('LedgerProvider with a LedgerStore', () => {
  it('a sync store renders children on the first render with its data', () => {
    const { store } = fakeStore(() => seed('Sync Sam'))
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    // No act()/await: the data must be there straight from render().
    render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)
    expect(screen.getByTestId('name').textContent).toBe('Sync Sam')
  })

  it('a sync store returning null falls back to default data', () => {
    const { store } = fakeStore(() => null)
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)
    expect(screen.getByTestId('name').textContent).toBe('Me')
  })

  it('an async store renders nothing until it resolves, then renders children', async () => {
    let resolve!: (data: AppDataV2 | null) => void
    const { store, save } = fakeStore(() => new Promise<AppDataV2 | null>((r) => { resolve = r }))
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)
    expect(screen.queryByTestId('name')).toBeNull()
    expect(save).not.toHaveBeenCalled()

    await act(async () => { resolve(seed('Async Alex')) })
    expect(screen.getByTestId('name').textContent).toBe('Async Alex')
  })

  it('saves once on startup with prev === next (the write-back of loaded data)', () => {
    const loaded = seed('Startup')
    const { store, save } = fakeStore(() => loaded)
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)
    expect(save).toHaveBeenCalledTimes(1)
    const [next, prev] = save.mock.calls[0]
    expect(next).toBe(prev)
    expect(next.people[0].name).toBe('Startup')
  })

  it('a mutation calls save(next, prev) with the state it replaced', () => {
    const { store, save } = fakeStore(() => seed('Before'))
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)
    const before = handle.current!.data
    const personId = before.people[0].id
    save.mockClear()

    act(() => { handle.current!.updatePerson(personId, { name: 'After' }) })

    expect(screen.getByTestId('name').textContent).toBe('After')
    expect(save).toHaveBeenCalledTimes(1)
    const [next, prev] = save.mock.calls[0]
    expect(prev).toBe(before)
    expect(next).toBe(handle.current!.data)
    expect(next.people[0].name).toBe('After')
    expect(screen.getByTestId('generation').textContent).toBe('0')
  })

  it('a subscribe callback with wholesale: true replaces data and bumps importGeneration', () => {
    let emit!: (data: AppDataV2, wholesale: boolean) => void
    const unsubscribe = vi.fn()
    const { store } = fakeStore(() => seed('Local'), {
      subscribe: (cb) => { emit = cb; return unsubscribe },
    })
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    const { unmount } = render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)
    expect(screen.getByTestId('generation').textContent).toBe('0')

    act(() => { emit(seed('First sync'), true) })
    expect(screen.getByTestId('name').textContent).toBe('First sync')
    expect(screen.getByTestId('generation').textContent).toBe('1')

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('a subscribe callback with wholesale: false replaces data without bumping importGeneration', () => {
    let emit!: (data: AppDataV2, wholesale: boolean) => void
    const { store } = fakeStore(() => seed('Local'), {
      subscribe: (cb) => { emit = cb; return () => {} },
    })
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)

    act(() => { emit(seed('Incremental'), false) })
    expect(screen.getByTestId('name').textContent).toBe('Incremental')
    expect(screen.getByTestId('generation').textContent).toBe('0')
  })

  it('setData still bumps importGeneration (unchanged)', () => {
    const { store } = fakeStore(() => seed('Local'))
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)
    act(() => { handle.current!.setData(seed('Restored')) })
    expect(screen.getByTestId('name').textContent).toBe('Restored')
    expect(screen.getByTestId('generation').textContent).toBe('1')
  })
})

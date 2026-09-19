// PROMPT-06 (2026-09-17) — LedgerProvider against fake LedgerStores, so the
// async-load and subscribe paths the PowerSync store (PROMPT-09) will need
// are built and proven now, with no PowerSync code.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { LedgerProvider, useLedgerData } from './LedgerContext'
import { defaultLedgerData, migrateLedgerData } from '../lib/ledgerStorage'
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

// PROMPT-11 (2026-09-19) — a Salary Sort belongs to ONE person.
// Sorts were keyed on payDate alone, which is right with one person and wrong in a shared
// household: when both partners are paid on the same date, both devices read and overwrite one
// record, and each would see the other's transfers as their own. These run through the real
// provider, because saveSalarySort's diff is the thing being scoped.
describe('Salary Sort is scoped to a person', () => {
  function twoPeople(): AppDataV2 {
    const base = defaultLedgerData()
    const me = base.people[0]
    const partner = { ...me, id: 'partner-1', name: 'Ella' }
    return { ...base, people: [me, partner], primaryPersonId: me.id }
  }

  function renderWith(data: AppDataV2) {
    const { store } = fakeStore(() => data)
    const handle = { current: null as ReturnType<typeof useLedgerData> | null }
    render(<LedgerProvider store={store}><Probe handle={handle} /></LedgerProvider>)
    return handle
  }

  it('two people paid on the same date get a sort each, and neither overwrites the other', () => {
    const data = twoPeople()
    const [me, partner] = data.people
    const handle = renderWith(data)

    act(() => handle.current!.saveSalarySort('2026-01-28', [{ to: { type: 'joint' }, amount: 100 }]))
    // The other person is "me" on their own device; that is what scopes the sort.
    act(() => handle.current!.setPrimaryPerson(partner.id))
    act(() => handle.current!.saveSalarySort('2026-01-28', [{ to: { type: 'joint' }, amount: 250 }]))

    const sorts = handle.current!.data.salarySorts.filter((s) => s.payDate === '2026-01-28')
    expect(sorts).toHaveLength(2)
    expect(sorts.map((s) => s.personId).sort()).toEqual([me.id, partner.id].sort())
    expect(sorts.find((s) => s.personId === me.id)!.targets[0].amount).toBe(100)
    expect(sorts.find((s) => s.personId === partner.id)!.targets[0].amount).toBe(250)
    // Two real transfers, one owned by each of them.
    const transfers = handle.current!.data.transactions.filter((t) => t.sourceType === 'salary_sort')
    expect(transfers).toHaveLength(2)
    expect(transfers.map((t) => t.ownerId).sort()).toEqual([me.id, partner.id].sort())
  })

  it('clearing one person\'s sort leaves the other\'s alone', () => {
    const data = twoPeople()
    const [me, partner] = data.people
    const handle = renderWith(data)
    act(() => handle.current!.saveSalarySort('2026-01-28', [{ to: { type: 'joint' }, amount: 100 }]))
    act(() => handle.current!.setPrimaryPerson(partner.id))
    act(() => handle.current!.saveSalarySort('2026-01-28', [{ to: { type: 'joint' }, amount: 250 }]))

    act(() => handle.current!.clearSalarySort('2026-01-28')) // still the partner's device
    const sorts = handle.current!.data.salarySorts.filter((s) => s.payDate === '2026-01-28')
    expect(sorts).toHaveLength(1)
    expect(sorts[0].personId).toBe(me.id)
    expect(handle.current!.data.transactions.filter((t) => t.sourceType === 'salary_sort')).toHaveLength(1)
  })

  it('ids are derived from the person and the payday, so two devices converge on one row', () => {
    const data = twoPeople()
    const me = data.people[0]
    const handle = renderWith(data)
    act(() => handle.current!.saveSalarySort('2026-01-28', [{ to: { type: 'joint' }, amount: 100 }]))
    const sort = handle.current!.data.salarySorts.find((s) => s.personId === me.id)!
    expect(sort.id).toBe(`sort:${me.id}:2026-01-28`)
    expect(sort.targets[0].id).toBe(`${sort.id}:joint`)
    expect(sort.targets[0].transactionId).toBe(`${sort.id}:joint:tx`)
  })

  it('a sort saved before sorts had a person is attributed to the owner of its transfers', () => {
    const data = twoPeople()
    const partner = data.people[1]
    const legacy = {
      ...data,
      salarySorts: [{ id: 'old-sort', payDate: '2025-12-28', targets: [{ id: 't1', to: { type: 'joint' as const }, amount: 75, transactionId: 'old-tx' }] }],
      transactions: [{ ...defaultLedgerData().transactions[0], id: 'old-tx', ownerId: partner.id } as AppDataV2['transactions'][number]],
    } as unknown as AppDataV2
    const handle = renderWith(migrateLedgerData(legacy))
    expect(handle.current!.data.salarySorts[0].personId).toBe(partner.id)
  })
})

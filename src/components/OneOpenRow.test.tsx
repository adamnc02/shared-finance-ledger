// One expanded row at a time on the Transactions and Bills pages.
//
// What it pins:
//   1. Opening a row closes the one that was open, in the same tap.
//   2. A row closes itself; tapping it again does not leave another open.
//   3. A stale close cannot shut the row that has since taken the slot — a
//      row's Save handler closes it after the write, and that close must
//      only ever close itself.
//   4. Outside a provider, rows keep their own independent flags.
//   5. Every expandable row on both pages reads the shared slot. A row added
//      later with its own useState flag would quietly stay open beside others.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import expenses from '../pages/Expenses.tsx?raw'
import bills from '../pages/Bills.tsx?raw'
import { OneOpenRowProvider, useOneOpenRow } from './OneOpenRow'

afterEach(cleanup)

let closers: Record<string, () => void> = {}

function Row({ id }: { id: string }) {
  const [open, setOpen] = useOneOpenRow(`row:${id}`)
  closers[id] = () => setOpen(false)
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)}>{id}</button>
      {open && <p>{id} is open</p>}
    </div>
  )
}

const openRows = () => screen.queryAllByText(/is open$/).map((p) => p.textContent)

describe('one open row', () => {
  it('opening a row closes the open one', async () => {
    render(
      <OneOpenRowProvider>
        <Row id="A" />
        <Row id="B" />
        <Row id="C" />
      </OneOpenRowProvider>,
    )
    await userEvent.click(screen.getByText('A'))
    expect(openRows()).toEqual(['A is open'])
    await userEvent.click(screen.getByText('C'))
    expect(openRows()).toEqual(['C is open'])
    await userEvent.click(screen.getByText('C'))
    expect(openRows()).toEqual([])
  })

  it('a stale close from a row that lost the slot leaves the new row open', async () => {
    closers = {}
    render(
      <OneOpenRowProvider>
        <Row id="A" />
        <Row id="B" />
      </OneOpenRowProvider>,
    )
    await userEvent.click(screen.getByText('A'))
    await userEvent.click(screen.getByText('B'))
    act(() => closers.A())
    expect(openRows()).toEqual(['B is open'])
  })

  it('outside a provider, rows open independently', async () => {
    render(
      <>
        <Row id="A" />
        <Row id="B" />
      </>,
    )
    await userEvent.click(screen.getByText('A'))
    await userEvent.click(screen.getByText('B'))
    expect(openRows()).toEqual(['A is open', 'B is open'])
  })

  it('every expandable row on Transactions and Bills uses the shared slot', () => {
    // A row's own expand flag, by either of the names these files use.
    const ownFlag = /const \[(isEditing|open), set(IsEditing|Open)\] = useState\(/
    expect(expenses.match(new RegExp(ownFlag, 'g')) ?? []).toEqual([])
    expect(bills.match(new RegExp(ownFlag, 'g')) ?? []).toEqual([])
    expect((expenses.match(/useOneOpenRow\(`/g) ?? []).length).toBe(8)
    expect((bills.match(/useOneOpenRow\(`/g) ?? []).length).toBe(1)
    expect(expenses).toContain('<OneOpenRowProvider key={mode}>')
    expect(bills).toContain('<OneOpenRowProvider>')
  })
})

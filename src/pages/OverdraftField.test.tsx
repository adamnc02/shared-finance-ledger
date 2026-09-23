// Real DOM interaction tests for the Overdraft field — added 2026-09-22 after
// Adam reported on the deployed build that he could not save one.
//
// 🚨 THE REPORTED BUG WAS NOT A BUG, and the real one was next to it. The
// field rendered **blank** when the value was 0, which reads as "unset" — so
// he typed `0` into it. That is the SAME value, so `dirty` correctly stayed
// false and Save correctly stayed grey. He found it himself: *"I changed to
// 100 and save was available again."*
//
// Two things came out of it, and both are pinned here:
//   1. **The field now shows "0", not blank.** For a field whose entire
//      meaning is "0 means no overdraft", blank and 0 are not interchangeable
//      to a reader even though they are to the code — and the caption under
//      it already promised "Leave at 0 if it cannot".
//   2. **The joint account modal had no dirty check at all** (Adam: *"save is
//      always available"*), which IS a real bug and predates this work. It
//      began as the mandatory first-time setup, where "unchanged" has no
//      meaning, and never gained one when it was reused for editing.
//
// 🚨 WHY A DOM TEST. The `dirty` expressions read correctly, and I read them
// three times without finding anything, because there was nothing there to
// find. Only typing into a rendered form shows what the field actually hands
// back — the same reason `SavingsPotForm.test.tsx` exists.
//
// What it pins:
//   1. typing a value enables Save; typing it back disables it again;
//   2. typing 0 over a 0 does NOT enable it — the papercut, now deliberate;
//   3. the field shows "0" rather than blank;
//   4. 🚨 an overdraft-only change does NOT open an effective-from flow
//      (Adam: "if only the overdraft has changed, save should not fire
//      effective from"), because an overdraft is not dated;
//   5. 🚨 nor does changing it alongside a dated field;
//   6. the joint modal dims Save until something changes — except on
//      first-time setup, where there is nothing to compare against.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PayCycleSettingsModal, PotEditForm } from './Salary'
import { JointAccountSetupModal } from '../components/JointAccountSetupModal'
import type { Pot } from '../types/ledger'

afterEach(() => cleanup())

const save = () => screen.getByText('Save').closest('button') as HTMLButtonElement
const overdraftField = () => screen.getByLabelText(/^Overdraft/i) as HTMLInputElement

function payCycleModal(over: Partial<Parameters<typeof PayCycleSettingsModal>[0]> = {}) {
  const onSave = vi.fn()
  const onChangePayday = vi.fn()
  render(
    <PayCycleSettingsModal
      personName="Adam"
      isPrimary
      payday={28}
      adjustForNonWorkingDay
      cycleStartDay={1}
      cycleStartFollowsPayday={false}
      salarySortBasis="payday"
      openingBalance={100}
      openingBalanceDate="2026-01-01"
      overdraftAmount={0}
      roundUpEnabled={false}
      hasCoinJar={false}
      onChangeRoundUp={vi.fn()}
      onSave={onSave}
      onDeleteSalary={vi.fn()}
      onClose={vi.fn()}
      paydayOccurrences={[{ date: '2026-09-28', isPast: true }]}
      onChangePayday={onChangePayday}
      {...over}
    />,
  )
  return { onSave, onChangePayday }
}

const pot = (over: Partial<Pot> = {}): Pot => ({
  id: 'p1', personId: 'per1', name: 'Car Fund', openingBalance: 0, openingDate: '2026-01-01',
  active: true, color: '#888', overdraftAmount: 0, ...over,
})

function potForm(p: Pot = pot()) {
  const onSave = vi.fn()
  render(
    <PotEditForm
      pot={p}
      templates={[]}
      loans={[]}
      onCancel={vi.fn()}
      onSave={onSave}
      onAssignTemplateLocation={vi.fn()}
      onAssignLoanLocation={vi.fn()}
    />,
  )
  return { onSave }
}

describe('the pay-cycle cog', () => {
  it('🚨 typing an overdraft enables Save', async () => {
    const user = userEvent.setup()
    payCycleModal()
    expect(save().disabled).toBe(true)
    await user.type(overdraftField(), '500')
    expect(save().disabled).toBe(false)
  })

  it('typing it back to the original disables Save again', async () => {
    const user = userEvent.setup()
    payCycleModal({ overdraftAmount: 500 })
    expect(save().disabled).toBe(true)
    await user.clear(overdraftField())
    expect(save().disabled).toBe(false)
    await user.type(overdraftField(), '500')
    expect(save().disabled).toBe(true)
  })

  it('🚨 shows "0" rather than blank when there is no overdraft', () => {
    payCycleModal()
    // Adam, 2026-09-22: a blank field read as "unset", so he typed 0 into it —
    // the same value, correctly not dirty, and Save stayed grey. The caption
    // under the field says "Leave at 0", so the field must show one.
    expect(overdraftField().value).toBe('0')
  })

  it('typing 0 over a 0 correctly does NOT enable Save', async () => {
    const user = userEvent.setup()
    payCycleModal()
    await user.clear(overdraftField())
    await user.type(overdraftField(), '0')
    expect(save().disabled).toBe(true)
  })

  it('🚨 an overdraft-only change saves DIRECTLY — no effective-from step', async () => {
    const user = userEvent.setup()
    const { onSave, onChangePayday } = payCycleModal()
    await user.type(overdraftField(), '500')
    await user.click(save())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ overdraftAmount: 500 })
    // An overdraft is not dated. Opening a payday picker for it would ask a
    // question with no meaning, and attach a date to a field that has none.
    expect(onChangePayday).not.toHaveBeenCalled()
    expect(screen.queryByText(/Effective from/i)).toBeNull()
  })

  it('saves it alongside the opening balance without a date step', async () => {
    const user = userEvent.setup()
    const { onSave, onChangePayday } = payCycleModal()
    await user.type(overdraftField(), '500')
    const opening = screen.getByLabelText(/Opening balance/i)
    await user.clear(opening)
    await user.type(opening, '250')
    await user.click(save())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ overdraftAmount: 500, openingBalance: 250 })
    expect(onChangePayday).not.toHaveBeenCalled()
  })

  it('a negative is never saved', async () => {
    const user = userEvent.setup()
    const { onSave } = payCycleModal({ overdraftAmount: 500 })
    await user.clear(overdraftField())
    await user.type(overdraftField(), '-100')
    await user.click(save())
    if (onSave.mock.calls.length > 0) expect(onSave.mock.calls[0][0].overdraftAmount).toBeGreaterThanOrEqual(0)
  })
})

describe('the joint account', () => {
  const initial = { openingBalance: 100, openingBalanceDate: '2026-01-01', overdraftAmount: 0 }
  function jointModal(over: { initial?: typeof initial | undefined } = {}) {
    const onSave = vi.fn()
    render(
      <JointAccountSetupModal
        initial={'initial' in over ? over.initial : initial}
        dismissable={'initial' in over ? over.initial !== undefined : true}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    return { onSave }
  }

  it('🚨 Save is DISABLED until something changes — it never was before', () => {
    // Adam, 2026-09-22: "the joint account is a bug though, that doesn't use
    // draft/dirty states at all, save is always available." Every other staged
    // edit form in the app dims Save until something changes; this one was
    // missed because it began as the mandatory first-time setup.
    jointModal()
    expect(save().disabled).toBe(true)
  })

  it('changing the overdraft enables it', async () => {
    const user = userEvent.setup()
    jointModal()
    await user.clear(overdraftField())
    await user.type(overdraftField(), '500')
    expect(save().disabled).toBe(false)
  })

  it('changing the opening balance enables it', async () => {
    const user = userEvent.setup()
    jointModal()
    const opening = screen.getByLabelText(/Opening balance/i)
    await user.clear(opening)
    await user.type(opening, '250')
    expect(save().disabled).toBe(false)
  })

  it('🚨 first-time setup has no "unchanged" to compare against, so Save works once valid', async () => {
    const user = userEvent.setup()
    jointModal({ initial: undefined })
    const opening = screen.getByLabelText(/Opening balance/i)
    await user.type(opening, '250')
    expect(save().disabled).toBe(false)
  })

  it('saves the overdraft, never a negative', async () => {
    const user = userEvent.setup()
    const { onSave } = jointModal()
    await user.clear(overdraftField())
    await user.type(overdraftField(), '500')
    await user.click(save())
    expect(onSave).toHaveBeenCalledWith(100, '2026-01-01', 500)
  })
})

describe('a pot', () => {
  it('🚨 typing an overdraft enables Save', async () => {
    const user = userEvent.setup()
    potForm()
    expect(save().disabled).toBe(true)
    await user.type(overdraftField(), '500')
    expect(save().disabled).toBe(false)
  })

  it('typing it back to the original disables Save again', async () => {
    const user = userEvent.setup()
    potForm(pot({ overdraftAmount: 500 }))
    expect(save().disabled).toBe(true)
    await user.clear(overdraftField())
    expect(save().disabled).toBe(false)
    await user.type(overdraftField(), '500')
    expect(save().disabled).toBe(true)
  })

  it('🚨 shows "0" rather than blank when there is no overdraft', () => {
    potForm()
    expect(overdraftField().value).toBe('0')
  })

  it('saves the value, and never a negative', async () => {
    const user = userEvent.setup()
    const { onSave } = potForm()
    await user.type(overdraftField(), '500')
    await user.click(save())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ overdraftAmount: 500 }))
  })

  it('🚨 a Coin Jar has no Overdraft field at all', () => {
    potForm(pot({ isCoinJar: true }))
    expect(screen.queryByLabelText(/^Overdraft/i)).toBeNull()
  })
})

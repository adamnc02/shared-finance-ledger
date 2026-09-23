// PROMPT-16 Part D (2026-09-22) — a joint bill has NO owner, and the form
// must neither show one nor save one, whoever "me" is.
//
// 🚨 THE REPORTED BUG WAS NOT THE BUG. The report said "Set as me changed the
// owner of my joint bills". `owner_id` never changed on any of them; what
// changed was `payee_share_percent`, 50 → 100, on all nine, through the
// delete guard (lib/deleteReassign.ts, jointItemInvolvesPerson — the control
// for THAT is in verify-delete-reassign.ts). What this file pins is the
// class the prompt named: a falsy-but-meaningful value ('' = "nobody") that
// `||` cannot tell from "unset" (lib/formOwner.ts), and the save that must
// agree with the display.
//
// What it pins:
//   1. a joint bill's form, opened while "me" is someone else, shows NO Owner
//      field — there is no owner to show, and it must not show "me";
//   2. saving that form writes ownerId '' and leaves the 50% share exactly as
//      it was (the display and the save agree about what '' means);
//   3. control: a NEW personal bill still defaults its owner to "me" — that
//      behaviour is correct and must not be lost.
//
// 🚨 WHY A DOM TEST. Only a rendered form shows what the field actually hands
// back — the same reason OverdraftField.test.tsx and SavingsPotForm.test.tsx
// exist.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BillForm } from './Bills'
import { formOwnerId } from '../lib/formOwner'
import { defaultCategories } from '../lib/categories'

afterEach(() => cleanup())

const ADAM = 'person-adam'
const ELLA = 'person-ella'
const TEMP = 'person-temp'
const people = [
  { id: ADAM, name: 'Adam' },
  { id: ELLA, name: 'Ella' },
  { id: TEMP, name: 'Temp' },
]

function form(over: Partial<Parameters<typeof BillForm>[0]> = {}) {
  const onSave = vi.fn()
  render(
    <BillForm
      people={people}
      pots={[]}
      canBeJoint
      categories={defaultCategories()}
      defaultLocation="personal"
      defaultOwnerId={TEMP} // "me" is the temporary third person — the production detour's state
      onAddCategory={() => ({ id: 'x' })}
      onSave={onSave}
      onCancel={vi.fn()}
      {...over}
    />,
  )
  return { onSave }
}

const jointBill = {
  name: 'Netflix',
  amount: 24.98,
  frequency: 'monthly' as const,
  anchorDate: '2026-10-16',
  location: 'joint' as const,
  ownerId: '', // joint: owned by nobody
  payee: ADAM,
  payeeSharePercent: 50,
  categoryId: 'category-seed-streaming',
  paymentMethod: 'standing_order' as const,
}

describe('a joint bill in the bill form', () => {
  it('🚨 shows no Owner field, and does not show "me" as the owner', () => {
    form({ initial: jointBill })
    expect(screen.queryByLabelText(/^Owner$/i)).toBeNull()
    expect(screen.queryByDisplayValue('Temp')).toBeNull()
  })

  it('🚨 saves ownerId "" with the 50% share unchanged, whoever "me" is', async () => {
    const user = userEvent.setup()
    const { onSave } = form({ initial: jointBill })
    await user.click(screen.getByText('Add bill'))
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0]
    expect(saved.location).toBe('joint')
    expect(saved.ownerId).toBe('')
    expect(saved.payee).toBe(ADAM)
    expect(saved.payeeSharePercent).toBe(50)
  })

  it('the split editor shows the real payee (Adam), not "me"', () => {
    form({ initial: jointBill })
    const assigned = screen.getByLabelText(/Assigned to/i) as HTMLSelectElement
    expect(assigned.value).toBe(ADAM)
  })
})

describe('control: a personal bill', () => {
  it('a NEW personal bill still defaults its owner to "me"', () => {
    form()
    const owner = screen.getByLabelText(/^Owner$/i) as HTMLSelectElement
    expect(owner.value).toBe(TEMP)
  })

  it("an existing personal bill keeps its own owner, not \"me\"", () => {
    form({ initial: { ...jointBill, location: 'personal', ownerId: ELLA, payee: '', payeeSharePercent: 100 } })
    const owner = screen.getByLabelText(/^Owner$/i) as HTMLSelectElement
    expect(owner.value).toBe(ELLA)
  })

  it('saving a personal bill writes its owner and a 100% share', async () => {
    const user = userEvent.setup()
    const { onSave } = form({ initial: { ...jointBill, location: 'personal', ownerId: ELLA, payee: '', payeeSharePercent: 100 } })
    await user.click(screen.getByText('Add bill'))
    const saved = onSave.mock.calls[0][0]
    expect([saved.ownerId, saved.payee, saved.payeeSharePercent]).toEqual([ELLA, '', 100])
  })
})

describe('formOwnerId — the rule, stated once', () => {
  it("joint: '' is nobody; the form holds the primary person only as a standby", () => {
    expect(formOwnerId({ location: 'joint', ownerId: '' }, TEMP)).toBe(TEMP)
  })
  it('personal: the item\'s own owner wins; a missing one falls back to the primary person', () => {
    expect(formOwnerId({ location: 'personal', ownerId: ELLA }, TEMP)).toBe(ELLA)
    expect(formOwnerId({ location: 'personal', ownerId: '' }, TEMP)).toBe(TEMP)
    expect(formOwnerId(undefined, TEMP)).toBe(TEMP)
  })
})

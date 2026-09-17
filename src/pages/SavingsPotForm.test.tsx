// Real DOM interaction tests (not just pure-function checks) for
// SavingsPotForm — added 2026-09-02 after Adam reported a typed £10,000
// target amount silently becoming £9,990 on save. That specific value
// couldn't be reproduced with these three interaction patterns against
// the current, keyed field layout (see the "field key" bugfix comment in
// Salary.tsx) — every one round-trips the typed value correctly. Kept as
// a permanent regression suite rather than a throwaway repro: this is
// genuinely the only place in the app that empirically exercises typing
// into a form with conditionally-appearing/reordering siblings, which is
// exactly the class of bug that's easy to reintroduce and hard to catch
// by reading the code. `SavingsPotForm` is exported from Salary.tsx
// specifically so this file can render it directly.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SavingsPotForm } from './Salary'

afterEach(() => cleanup())

/**
 * 2026-09-14 (Adam-specified): "Looks good, save" on the interest
 * explanation no longer saves directly — it advances to a final "where
 * does interest get paid" step with its OWN Save button, which is what
 * actually commits. That step's button is also labelled "Save", so by
 * the time it's clickable there are two "Save"-labelled buttons in the
 * DOM (the form's own, still mounted behind the modal, and the step's) —
 * always the LAST one.
 */
async function clickFinalSave(user: ReturnType<typeof userEvent.setup>) {
  const saveButtons = screen.getAllByText('Save')
  await user.click(saveButtons[saveButtons.length - 1])
}

describe('SavingsPotForm repro — 10000 becoming 9990 on save', () => {
  it('types field-by-field in top-to-bottom order and checks what actually gets saved', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<SavingsPotForm people={[{ id: 'p1', name: 'Beverley', color: '#fff', salaryHistory: [], salaryOverrides: [] }]} defaultPersonId="p1" onCancel={() => {}} onSave={onSave} />)

    // "New pot" chooser first
    await user.click(screen.getByText(/New pot/))

    await user.type(screen.getByPlaceholderText('e.g. Rainy day fund'), 'house deposit')
    // Interest method defaults to aer_credited; leave it.
    await user.clear(screen.getByLabelText('AER (%)'))
    await user.type(screen.getByLabelText('AER (%)'), '4.5')
    // Credited defaults to monthly; leave it.
    await user.type(screen.getByLabelText('Monthly deposit (£, optional)'), '250')
    // On day of month now appears — leave default.
    await user.type(screen.getByLabelText('Target amount (£, optional)'), '10000')

    await user.click(screen.getByText('Save'))
    await user.click(screen.getByText('Looks good, save'))
    await clickFinalSave(user)

    expect(onSave).toHaveBeenCalledTimes(1)
    const [, fields] = onSave.mock.calls[0]
    expect(fields.targetAmount).toBe(10000)
    expect(fields.recurringDepositAmount).toBe(250)
  })

  it('types Target amount BEFORE Monthly deposit — out of DOM order, the more realistic mobile-tap scenario', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<SavingsPotForm people={[{ id: 'p1', name: 'Beverley', color: '#fff', salaryHistory: [], salaryOverrides: [] }]} defaultPersonId="p1" onCancel={() => {}} onSave={onSave} />)
    await user.click(screen.getByText(/New pot/))
    await user.type(screen.getByPlaceholderText('e.g. Rainy day fund'), 'house deposit')
    await user.clear(screen.getByLabelText('AER (%)'))
    await user.type(screen.getByLabelText('AER (%)'), '4.5')
    // Target amount FIRST, while "On day of month" doesn't exist yet.
    await user.type(screen.getByLabelText('Target amount (£, optional)'), '10000')
    // THEN Monthly deposit — this makes "On day of month" appear, inserting a new sibling BETWEEN Monthly deposit and Target amount.
    await user.type(screen.getByLabelText('Monthly deposit (£, optional)'), '250')

    await user.click(screen.getByText('Save'))
    await user.click(screen.getByText('Looks good, save'))
    await clickFinalSave(user)

    const [, fields] = onSave.mock.calls[0]
    expect(fields.targetAmount).toBe(10000)
  })

  it('edits On day of month AFTER Target amount is filled', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<SavingsPotForm people={[{ id: 'p1', name: 'Beverley', color: '#fff', salaryHistory: [], salaryOverrides: [] }]} defaultPersonId="p1" onCancel={() => {}} onSave={onSave} />)
    await user.click(screen.getByText(/New pot/))
    await user.type(screen.getByPlaceholderText('e.g. Rainy day fund'), 'house deposit')
    await user.clear(screen.getByLabelText('AER (%)'))
    await user.type(screen.getByLabelText('AER (%)'), '4.5')
    await user.type(screen.getByLabelText('Monthly deposit (£, optional)'), '250')
    await user.type(screen.getByLabelText('Target amount (£, optional)'), '10000')
    // Go back and edit On day of month AFTER target amount is already filled.
    const dayField = screen.getByLabelText('On day of month')
    await user.clear(dayField)
    await user.type(dayField, '14')

    await user.click(screen.getByText('Save'))
    await user.click(screen.getByText('Looks good, save'))
    await clickFinalSave(user)

    const [, fields] = onSave.mock.calls[0]
    expect(fields.targetAmount).toBe(10000)
    expect(fields.recurringDepositDayOfMonth).toBe(14)
  })
})

// PROMPT-04 Bug C (2026-09-16): the "Credited" dropdown set state that
// defaultMethodOfType never read, so Quarterly/Annual silently saved as
// Monthly. These drive the real form, so they prove the choice reaches
// onSave — not just that a helper returns the right shape.
describe('SavingsPotForm — interest crediting frequency', () => {
  const people = [{ id: 'p1', name: 'Beverley', color: '#fff', salaryHistory: [], salaryOverrides: [] }]

  for (const frequency of ['monthly', 'quarterly', 'annual'] as const) {
    it(`saves a new pot credited ${frequency} as exactly '${frequency}', and the explanation says so`, async () => {
      const user = userEvent.setup()
      const onSave = vi.fn()
      render(<SavingsPotForm people={people} defaultPersonId="p1" onCancel={() => {}} onSave={onSave} />)
      await user.click(screen.getByText(/New pot/))
      await user.type(screen.getByPlaceholderText('e.g. Rainy day fund'), 'house deposit')
      await user.selectOptions(screen.getByLabelText('Credited'), frequency)

      await user.click(screen.getByText('Save'))
      const label = { monthly: 'monthly', quarterly: 'quarterly', annual: 'annually' }[frequency]
      expect(screen.getByText(new RegExp(`paid in ${label}`))).toBeTruthy()
      await user.click(screen.getByText('Looks good, save'))
      await clickFinalSave(user)

      const [, fields] = onSave.mock.calls[0]
      expect(fields.interestMethod).toEqual({ type: 'aer_credited', aer: 4.5, creditingFrequency: frequency })
    })
  }

  it('reopening a quarterly pot shows Quarterly, and editing another field keeps it quarterly', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const initial = { name: 'ISA', openingBalance: 500, openingDate: '2026-01-01', interestMethod: { type: 'aer_credited' as const, aer: 3, creditingFrequency: 'quarterly' as const } }
    render(<SavingsPotForm people={people} defaultPersonId="p1" initial={initial} onCancel={() => {}} onSave={onSave} />)
    expect((screen.getByLabelText('Credited') as HTMLSelectElement).value).toBe('quarterly')

    await user.clear(screen.getByLabelText('AER (%)'))
    await user.type(screen.getByLabelText('AER (%)'), '3.5')
    await user.click(screen.getByText('Save'))
    await user.click(screen.getByText('Looks good, save'))
    await clickFinalSave(user)

    const [, fields] = onSave.mock.calls[0]
    expect(fields.interestMethod).toEqual({ type: 'aer_credited', aer: 3.5, creditingFrequency: 'quarterly' })
  })

  it('daily accrual carries no crediting frequency', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<SavingsPotForm people={people} defaultPersonId="p1" onCancel={() => {}} onSave={onSave} />)
    await user.click(screen.getByText(/New pot/))
    await user.type(screen.getByPlaceholderText('e.g. Rainy day fund'), 'house deposit')
    await user.selectOptions(screen.getByLabelText('Credited'), 'annual')
    await user.selectOptions(screen.getByLabelText('Interest method'), 'daily_accrual_monthly_credited')
    await user.click(screen.getByText('Save'))
    await user.click(screen.getByText('Looks good, save'))
    await clickFinalSave(user)

    const [, fields] = onSave.mock.calls[0]
    expect(fields.interestMethod).toEqual({ type: 'daily_accrual_monthly_credited', aer: 4.5 })
  })
})

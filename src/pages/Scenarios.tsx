import { useEffect, useMemo, useState } from 'react'
import { formatCurrency } from '../lib/format'
import { toLocalIsoDate, todayIso } from '../lib/date'
import { useNavigate } from 'react-router-dom'
import { useLedgerData } from '../context/LedgerContext'
import { buildLegacyAppData } from '../lib/legacyBridge'
import { calculateScenarioImpact, calculateHouseholdScenarioImpact, mergeScenarios, resolveTargets, type ScenarioImpact, type LoanImpact, type SavingsPotImpact, type DebtImpact } from '../lib/scenarios'
import { computePurchaseImpacts, computePurchaseImpactsForScenarios, type PurchaseImpact } from '../lib/purchaseImpact'
import { formatFullDate } from '../lib/format'
import { calculateNetSalary } from '../lib/tax'
import { personalBillsTotal, jointContributionForPerson } from '../lib/bills'
import { summarizeLoan, combineBillsWithLoans } from '../lib/loans'
import { calculateHouseholdFigures, legacyPeopleWithSalaryCount } from '../lib/household'
import { calculateFinanceAgreement } from '../lib/finance'
import { Plus, Trash2, ChevronDown, ChevronUp, Layers, Pencil } from 'lucide-react'
import type { Scenario, ScenarioActionType, ScenarioTargetKind, BillLocation } from '../types/models'
import type { RecurringTemplate, Loan } from '../types/ledger'
import { BILLS_CATEGORY_ID } from '../types/ledger'
import { SplitEditor } from '../components/SplitEditor'
import { ConfirmModal } from '../components/ConfirmModal'
import { nanoid } from 'nanoid'

const ACTION_LABELS: Record<ScenarioActionType, string> = {
  sell_asset: 'Sell an asset',
  pay_off_loan: 'Lump sum toward a loan/credit card',
  new_bill: 'New bill',
  new_finance_agreement: 'New finance agreement',
  exclude_loan: "Exclude a loan/credit card (what if it just didn't count)",
  loan_overpayment: 'Regular extra payment on a loan/credit card',
  salary_change: 'Salary change',
  purchase: 'Buy something',
  savings_pot_lump_sum: 'Lump sum into a savings pot',
  savings_pot_withdrawal: 'Withdrawal from a savings pot',
  savings_pot_recurring_deposit_change: "Change a pot's recurring deposit",
}

const NEEDS_VALUE: ScenarioActionType[] = [
  'sell_asset',
  'pay_off_loan',
  'new_bill',
  'loan_overpayment',
  'salary_change',
  'purchase',
  'savings_pot_lump_sum',
  'savings_pot_withdrawal',
  'savings_pot_recurring_deposit_change',
]
const NEEDS_SPLIT: ScenarioActionType[] = ['new_bill', 'new_finance_agreement']
// The only action type anchored to a real calendar date via purchaseDate
// — see lib/purchaseImpact.ts for why a purchase needs one and nothing
// else does. pay_off_loan/loan_overpayment get their OWN date field
// (action.date) below, shown only once a loan target is actually picked
// (item d — a credit-card-only action stays dateless, per its own scope).
const NEEDS_DATE: ScenarioActionType[] = ['purchase']
const NEEDS_LOAN_DATE: ScenarioActionType[] = ['pay_off_loan', 'loan_overpayment']

// These three action types are meaningless without a loan/credit card to
// point at — a lump sum has nowhere to go, "exclude" has nothing to
// exclude, and a recurring extra payment has nothing to add to. Selling
// an asset is deliberately NOT in this list: the sale can just be cash in
// hand, with no loan/card involved at all.
const REQUIRES_LOAN_TARGET: ScenarioActionType[] = ['pay_off_loan', 'exclude_loan', 'loan_overpayment']

const VALUE_LABELS: Partial<Record<ScenarioActionType, string>> = {
  sell_asset: 'Sale value (£)',
  pay_off_loan: 'Lump sum (£)',
  new_bill: 'Monthly cost (£)',
  loan_overpayment: 'Extra per month (£)',
  salary_change: 'New gross annual salary (£)',
  purchase: 'Cost (£)',
  savings_pot_lump_sum: 'Lump sum (£)',
  savings_pot_withdrawal: 'Withdrawal (£)',
  savings_pot_recurring_deposit_change: 'New monthly deposit (£)',
}

// A pot has nowhere to send money without one picked — same reasoning as
// REQUIRES_LOAN_TARGET.
const REQUIRES_SAVINGS_POT_TARGET: ScenarioActionType[] = ['savings_pot_lump_sum', 'savings_pot_withdrawal', 'savings_pot_recurring_deposit_change']

export function Scenarios() {
  const { data: ledgerData, addScenario, updateScenario, removeScenario } = useLedgerData()
  const navigate = useNavigate()
  // Bridges live ledger data (people/loans/bills/credit cards) into the
  // shape this page's existing simulation engine expects — see
  // lib/legacyBridge.ts for why this is an adapter rather than a
  // rewrite. Re-derived only when the underlying ledger data changes.
  const data = useMemo(() => buildLegacyAppData(ledgerData), [ledgerData])
  const [creating, setCreating] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [combinedOpen, setCombinedOpen] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingRemoveScenarioId, setConfirmingRemoveScenarioId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'personal' | 'household'>('personal')

  const me = data.people.find((p) => p.id === data.primaryPersonId) ?? data.people[0]
  const allBills = combineBillsWithLoans(data.bills, data.loans)
  // Same rule as the summary page's deck (Home.tsx's hasJointItem) — the
  // Household view only makes sense once there's an actual joint bill or
  // loan to combine; otherwise it's identical to Personal and just adds
  // clutter. See lib/household.ts's peopleWithSalaryCount for the related
  // "2+ salaries" rule used elsewhere on this page's own location picker.
  const hasJointItem = data.bills.some((b) => b.location === 'joint') || data.loans.some((l) => l.location === 'joint')

  // If the joint bill/loan that made Household relevant gets removed (or
  // excluded via a scenario) while it's the active view, fall back to
  // Personal rather than leaving the page stuck on a view whose toggle no
  // longer shows.
  useEffect(() => {
    if (!hasJointItem && viewMode === 'household') setViewMode('personal')
  }, [hasJointItem, viewMode])

  const personalAvailableBefore = me
    ? calculateNetSalary(me.salary).netPerPeriod -
      personalBillsTotal(allBills, me.id) -
      jointContributionForPerson(allBills, me.id, data.people)
    : 0
  const householdAvailableBefore = calculateHouseholdFigures(data).totalAvailable
  const monthlyAvailableBefore = viewMode === 'household' ? householdAvailableBefore : personalAvailableBefore

  function getImpact(scenario: Scenario) {
    if (viewMode === 'household') return calculateHouseholdScenarioImpact(scenario, data, monthlyAvailableBefore)
    return me ? calculateScenarioImpact(scenario, data, me.id, monthlyAvailableBefore) : null
  }

  // Purchases are computed off the REAL ledger (ledgerData), not the
  // bridged legacy shape `data` — see lib/purchaseImpact.ts's header.
  // Always against the primary person's own pay cycle and account, in
  // both view modes: a purchase is one person's cash leaving one real
  // account on one real day. There's no household analogue of "the
  // balance on the 14th", so the Household toggle deliberately doesn't
  // change these figures.
  const purchasePayCycle = ledgerData.payCycles.find((pc) => pc.personId === ledgerData.primaryPersonId)

  function getPurchases(scenario: Scenario): PurchaseImpact[] {
    if (!purchasePayCycle) return []
    return computePurchaseImpacts(ledgerData, ledgerData.primaryPersonId, purchasePayCycle, scenario)
  }

  // "Convert to real" for a loan/credit-card impact — rather than
  // auto-saving here, the user is transported to wherever that kind of
  // overpayment is actually created and saves it themselves from there:
  // a one-off payoff goes to the Borrowing page (pre-fills the
  // log-an-overpayment/log-a-payment form — see Loans.tsx's
  // OverpaymentPrefill/overpaymentPrefill handling); a recurring
  // overpayment goes to the Transactions page's Overpayments pill
  // instead (2026-09-09 followup — recurring overpayments are no longer
  // created/edited on the Borrowing page at all), pre-filling the same
  // picker-first wizard used everywhere else.
  // `actionDate` — 2026-09-09 followup (Adam-reported): the wizard this
  // hands off to used to always default to today, silently dropping
  // whichever date the person had actually set on the scenario's own
  // loan_overpayment action. Resolved by the caller (it knows which
  // scenario/action this button belongs to; LoanImpact itself carries no
  // date) and passed straight through.
  function makeImpactReal(li: LoanImpact, actionDate?: string) {
    if (li.kind === 'payoff') {
      navigate('/loans', {
        state: {
          overpaymentPrefill: {
            targetKind: li.targetKind,
            targetId: li.loanId,
            mode: 'payoff',
            amount: li.lumpSumApplied,
            date: actionDate ?? todayIso(),
          },
        },
      })
    } else if (li.kind === 'overpayment' && li.targetKind === 'loan') {
      // 2026-09-09 followup (Adam-specified) — recurring overpayments are
      // no longer created or edited on the Borrowing page at all, only
      // from the Transactions page's Overpayments pill (same picker-first
      // wizard as every other entry point). A one-off payoff (above)
      // still goes to the Borrowing page, which still owns "+ Log an
      // overpayment".
      navigate('/expenses', {
        state: {
          overpaymentPrefill: {
            targetKind: 'loan',
            targetId: li.loanId,
            mode: 'recurring',
            amount: li.overpaymentPerMonth,
            date: actionDate,
          },
        },
      })
    }
  }

  const includedScenarios = data.scenarios.filter((s) => s.includeInCumulative)
  const combinedImpact = includedScenarios.length > 0 ? getImpact(mergeScenarios(includedScenarios)) : null
  // Every included scenario's purchases evaluated together, in date order
  // — so two scenarios that are each individually affordable but not
  // affordable together show that here rather than looking fine twice.
  const combinedPurchases =
    includedScenarios.length > 0 && purchasePayCycle
      ? computePurchaseImpactsForScenarios(ledgerData, ledgerData.primaryPersonId, purchasePayCycle, includedScenarios)
      : []

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">What-if scenarios</h1>
        <button
          onClick={() => setCreating(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-coral)' }}
        >
          <Plus size={18} className="text-white" />
        </button>
      </header>

      {hasJointItem && (
        <div className="flex gap-1 rounded-full p-0.5 mb-6 w-fit" style={{ background: 'var(--color-surface)' }}>
          {(['personal', 'household'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className="px-3.5 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wide capitalize transition-colors"
              style={{
                background: viewMode === mode ? 'var(--color-coral)' : 'transparent',
                color: viewMode === mode ? '#fff' : 'var(--color-ink-muted)',
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      )}

      {combinedImpact && (
        <div className="rounded-2xl p-5 mb-6 border" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-coral)' }}>
          <button onClick={() => setCombinedOpen(!combinedOpen)} className="w-full flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-2">
              <Layers size={16} style={{ color: 'var(--color-coral)' }} />
              <h2 className="font-display text-base font-semibold text-[var(--color-ink)]">
                Combined ({includedScenarios.length} scenario{includedScenarios.length === 1 ? '' : 's'})
              </h2>
            </div>
            {combinedOpen ? (
              <ChevronUp size={18} className="text-[var(--color-ink-muted)]" />
            ) : (
              <ChevronDown size={18} className="text-[var(--color-ink-muted)]" />
            )}
          </button>
          {combinedOpen && (
            <div className="mt-3">
              <ImpactSummary impact={combinedImpact} viewerId={viewMode === 'personal' ? me?.id : undefined} purchases={combinedPurchases} />
            </div>
          )}
        </div>
      )}

      {creating && (
        <ScenarioForm
          people={data.people}
          onCancel={() => setCreating(false)}
          onSave={(s) => {
            addScenario(s)
            setCreating(false)
          }}
        />
      )}

      <div className="flex flex-col gap-4">
        {data.scenarios.map((scenario) => {
          if (editingId === scenario.id) {
            return (
              <ScenarioForm
                key={scenario.id}
                people={data.people}
                initial={scenario}
                onCancel={() => setEditingId(null)}
                onSave={(s) => {
                  updateScenario(scenario.id, s)
                  setEditingId(null)
                }}
              />
            )
          }

          const impact = getImpact(scenario)
          const isOpen = expanded === scenario.id
          return (
            <div key={scenario.id} className="rounded-2xl p-5" style={{ background: 'var(--color-surface)' }}>
              <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(isOpen ? null : scenario.id)}>
                <div>
                  <h2 className="font-display text-lg font-semibold text-[var(--color-ink)]">{scenario.name}</h2>
                  <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                    {scenario.actions.length} action{scenario.actions.length === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingId(scenario.id)
                    }}
                    className="text-[var(--color-ink-faint)]"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmingRemoveScenarioId(scenario.id)
                    }}
                    className="text-[var(--color-ink-faint)]"
                  >
                    <Trash2 size={16} />
                  </button>
                  {isOpen ? <ChevronUp size={18} className="text-[var(--color-ink-muted)]" /> : <ChevronDown size={18} className="text-[var(--color-ink-muted)]" />}
                </div>
              </div>

              <label className="flex items-center gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={scenario.includeInCumulative}
                  onChange={(e) => updateScenario(scenario.id, { includeInCumulative: e.target.checked })}
                />
                <span className="text-xs text-[var(--color-ink-muted)]">Include in combined view</span>
              </label>

              {isOpen && impact && (
                <div className="mt-4 pt-4 border-t flex flex-col gap-3" style={{ borderColor: 'var(--color-track)' }}>
                  {scenario.actions.map((action) => (
                    <div key={action.id} className="flex items-start justify-between text-sm gap-3">
                      <span className="text-[var(--color-ink-muted)]">
                        {action.name || ACTION_LABELS[action.type]}
                        {(() => {
                          const targets = resolveTargets(action)
                          if (targets.length === 0) return null
                          const parts = targets.map((t) => {
                            const name = t.kind === 'loan' ? data.loans.find((l) => l.id === t.id)?.name : data.creditCards.find((c) => c.id === t.id)?.name
                            const label = name ?? (t.kind === 'loan' ? 'loan' : 'credit card')
                            return t.amount != null ? `${label} (£${formatCurrency(t.amount)})` : label
                          })
                          return ` → ${parts.join(' → ')}`
                        })()}
                        {action.type === 'purchase' && action.purchaseDate ? (
                          <span className="block text-xs text-[var(--color-ink-faint)] mt-0.5">{formatFullDate(action.purchaseDate)}</span>
                        ) : null}
                        {REQUIRES_SAVINGS_POT_TARGET.includes(action.type) ? (
                          <span className="block text-xs text-[var(--color-ink-faint)] mt-0.5">
                            {data.savingsPots.find((p) => p.id === action.savingsPotId)?.name ?? 'Savings pot'} ·{' '}
                            {action.type === 'savings_pot_recurring_deposit_change' ? 'from ' : ''}
                            {action.date ? formatFullDate(action.date) : 'today'}
                          </span>
                        ) : null}
                        {action.type === 'new_finance_agreement' && action.termMonths ? (
                          <span className="block text-xs text-[var(--color-ink-faint)] mt-0.5">
                            £{formatCurrency(action.borrowAmount ?? 0)} at {action.aprPercent ?? 0}% APR over {action.termMonths}mo · total £
                            {formatCurrency(action.totalRepayable ?? 0)}
                          </span>
                        ) : null}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-[var(--color-ink)]">£{formatCurrency(action.value)}</span>
                        {(action.type === 'new_bill' || action.type === 'new_finance_agreement') && (
                          <ConvertButtons action={action} people={data.people} />
                        )}
                      </div>
                    </div>
                  ))}

                  <div className="h-px my-1" style={{ background: 'var(--color-track)' }} />

                  <ImpactSummary
                    impact={impact}
                    viewerId={viewMode === 'personal' ? me?.id : undefined}
                    onMakeReal={(li) =>
                      makeImpactReal(
                        li,
                        scenario.actions.find(
                          (a) =>
                            (a.type === 'loan_overpayment' && a.linkedTargetId === li.loanId) ||
                            (a.type === 'pay_off_loan' && a.targets?.some((t) => t.id === li.loanId)),
                        )?.date,
                      )
                    }
                    purchases={getPurchases(scenario)}
                  />
                </div>
              )}
            </div>
          )
        })}

        {data.scenarios.length === 0 && !creating && (
          <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">
            No scenarios yet. Try modelling something like selling the car and putting the money toward a loan, or
            clearing a loan completely to see what it frees up.
          </p>
        )}
      </div>

      {confirmingRemoveScenarioId &&
        (() => {
          const target = data.scenarios.find((s) => s.id === confirmingRemoveScenarioId)
          if (!target) return null
          return (
            <ConfirmModal
              title={`Delete "${target.name}"?`}
              description="This can't be undone."
              confirmLabel="Delete"
              tone="danger"
              onConfirm={() => {
                removeScenario(target.id)
                setConfirmingRemoveScenarioId(null)
              }}
              onCancel={() => setConfirmingRemoveScenarioId(null)}
            />
          )
        })()}
    </div>
  )
}

function ConvertButtons({ action, people }: { action: Scenario['actions'][number]; people: { id: string; name: string }[] }) {
  const navigate = useNavigate()

  function toBill() {
    // RecurringTemplate-shaped now (Bills migrated off the old free-text
    // Bill model) — defaults to a monthly bill under the built-in Bills
    // category, since a scenario action has no concept of frequency or a
    // real category to hand over.
    const billPrefill: Partial<Omit<RecurringTemplate, 'id' | 'active'>> = {
      name: action.name || 'New bill',
      amount: action.value,
      frequency: 'monthly',
      anchorDate: toLocalIsoDate(new Date()),
      categoryId: BILLS_CATEGORY_ID,
      paymentMethod: 'standing_order',
      location: action.location ?? 'personal',
      ownerId: action.ownerId || people[0]?.id || '',
      payee: action.payee || people[0]?.id || '',
      payeeSharePercent: action.payeeSharePercent ?? 100,
    }
    navigate('/bills', { state: { billPrefill } })
  }

  function toLoan() {
    // Loan-shaped now (Loans migrated off the old totalAmount/firstPaymentDate
    // model to monthlyPayment + termMonths + startDate) — action.value is
    // already the monthly figure for a new_finance_agreement action, same
    // meaning as the new Loan.monthlyPayment.
    const loanPrefill: Partial<Omit<Loan, 'id' | 'overpayments'>> = {
      name: action.name || 'New finance agreement',
      monthlyPayment: action.value,
      termMonths: action.termMonths ?? 12,
      startDate: toLocalIsoDate(new Date()),
      categoryId: BILLS_CATEGORY_ID,
      location: action.location ?? 'personal',
      ownerId: action.ownerId || people[0]?.id || '',
      payee: action.payee || people[0]?.id || '',
      payeeSharePercent: action.payeeSharePercent ?? 100,
    }
    navigate('/loans', { state: { loanPrefill } })
  }

  if (action.type === 'new_finance_agreement') {
    return (
      <button onClick={toLoan} className="text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-coral)' }}>
        → Loan
      </button>
    )
  }

  return (
    <button onClick={toBill} className="text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-coral)' }}>
      → Bill
    </button>
  )
}

/**
 * The dated view of a purchase: what the balance is on the day, what the
 * purchase leaves behind, and where the cycle ends up as a result.
 *
 * Deliberately shows the BEFORE figure alongside the after one rather
 * than just the result — the useful question isn't only "can I afford
 * it" but "how much room does it leave", and a bare after-figure hides
 * whether a tight number was tight already.
 */
function PurchaseCard({ purchase: p }: { purchase: PurchaseImpact }) {
  const tense = p.isPastDate ? 'was' : 'will be'
  const warn = p.goesNegativeOnDate || p.goesNegativeByCycleEnd

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
      <p className="text-sm font-medium text-[var(--color-ink)]">
        {p.name}
        <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-coral)' }}>
          Purchase
        </span>
      </p>
      <p className="text-[11px] text-[var(--color-ink-faint)] mb-2">{formatFullDate(p.date)}</p>

      <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
        <span>Balance that day</span>
        <span className="font-mono">£{formatCurrency(p.balanceOnDateBefore)}</span>
      </div>
      <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
        <span>Cost</span>
        <span className="font-mono">-£{formatCurrency(p.amount)}</span>
      </div>
      <div className="flex justify-between text-xs font-medium" style={{ color: p.goesNegativeOnDate ? 'var(--color-negative)' : 'var(--color-ink)' }}>
        <span>Left that day</span>
        <span className="font-mono">£{formatCurrency(p.balanceOnDateAfter)}</span>
      </div>

      <div className="h-px my-2" style={{ background: 'var(--color-track)' }} />

      <p className="text-[11px] text-[var(--color-ink-faint)] mb-1">
        End of that cycle ({formatFullDate(p.cycleStart)} – {formatFullDate(p.cycleEnd)})
      </p>
      <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
        <span>Projected without it</span>
        <span className="font-mono">£{formatCurrency(p.cycleEndBalanceBefore)}</span>
      </div>
      <div className="flex justify-between text-xs font-medium" style={{ color: p.goesNegativeByCycleEnd ? 'var(--color-negative)' : 'var(--color-positive)' }}>
        <span>Projected including it</span>
        <span className="font-mono">£{formatCurrency(p.cycleEndBalanceAfter)}</span>
      </div>

      {warn && (
        <p className="text-[11px] mt-2 leading-relaxed" style={{ color: 'var(--color-negative)' }}>
          {p.goesNegativeOnDate
            ? `This ${tense === 'was' ? 'would have taken' : 'takes'} the balance below zero on the day itself.`
            : `Affordable on the day, but the cycle ${tense === 'was' ? 'ended' : 'ends'} below zero once the rest of the month's outgoings are counted.`}
        </p>
      )}
      {p.isPastDate && (
        <p className="text-[11px] text-[var(--color-ink-faint)] mt-2 leading-relaxed">
          This date has already passed, so these are the figures as they stood rather than a forecast.
        </p>
      )}
    </div>
  )
}

function ImpactSummary({
  impact,
  viewerId,
  onMakeReal,
  purchases = [],
}: {
  impact: ScenarioImpact
  viewerId?: string
  onMakeReal?: (li: LoanImpact) => void
  purchases?: PurchaseImpact[]
}) {
  return (
    <div className="flex flex-col gap-3">
      {purchases.map((p) => (
        <PurchaseCard key={p.actionId} purchase={p} />
      ))}

      {impact.salaryChangeImpact && (
        <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
          <p className="text-sm font-medium text-[var(--color-ink)] mb-2">{impact.salaryChangeImpact.personName}'s salary change</p>
          <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
            <span>Net pay now</span>
            <span className="font-mono">£{formatCurrency(impact.salaryChangeImpact.oldNetMonthly)}/mo</span>
          </div>
          <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
            <span>Net pay after</span>
            <span className="font-mono">£{formatCurrency(impact.salaryChangeImpact.newNetMonthly)}/mo</span>
          </div>
          {viewerId && impact.salaryChangeImpact.personId !== viewerId && (
            <p className="text-[11px] text-[var(--color-ink-faint)] mt-2 leading-relaxed">
              This doesn't count toward your own available cash below, since it's not your salary.
            </p>
          )}
        </div>
      )}

      {impact.loanImpacts
        .filter((li) => li.kind === 'exclude')
        .map((li) => (
          <div key={`${li.targetKind}-${li.loanId}-exclude`} className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
            <p className="text-sm font-medium text-[var(--color-ink)] mb-2">
              {li.loanName}
              <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-ink-faint)' }}>
                Excluded
              </span>
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Balance unchanged (£{formatCurrency(li.originalRemaining)}) — this just stops counting toward your monthly outgoings.
            </p>
            {li.originalMonthlyCostForPerson !== li.newMonthlyCostForPerson && (
              <CardRow
                label={viewerId ? 'Your payment' : 'Household payment'}
                value={`£${formatCurrency(li.originalMonthlyCostForPerson)} → £${formatCurrency(li.newMonthlyCostForPerson)}/mo`}
                color={'var(--color-positive)'}
              />
            )}
          </div>
        ))}

      {impact.debtImpacts.map((di) => (
        <DebtCard key={`${di.targetKind}-${di.targetId}`} impact={di} viewerId={viewerId} onMakeReal={onMakeReal} loanImpacts={impact.loanImpacts} />
      ))}

      {impact.savingsPotImpacts.map((si) => (
        <SavingsPotCard key={si.savingsPotId} impact={si} />
      ))}

      {/* BUGFIX (Adam-reported, 2026-09 session — "I still see the bottom
          Available impact on cash even though it is zero, this should
          not show if the value is 0") — the whole card now only renders
          when there's genuinely something to report (a real monthly
          change, a real one-off change, or both); previously it always
          rendered with at least the "One-off cash impact £0.00" row
          showing regardless. The one-off row itself is separately gated
          the same way, so a scenario with a real monthly impact but no
          leftover one-off cash doesn't show a pointless "£0.00" line
          underneath it either. */}
      {(impact.monthlyImpact !== 0 || impact.oneOffCashImpact !== 0) && (
        <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
          <p className="text-sm font-medium text-[var(--color-ink)] mb-2">Impact on available cash</p>
          {impact.monthlyImpact !== 0 && (
            <>
              <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
                <span>Available now (per month)</span>
                <span className="font-mono">£{formatCurrency(impact.monthlyAvailableBefore)}</span>
              </div>
              <div className="flex justify-between text-xs text-[var(--color-ink-muted)]">
                <span>Available after (per month)</span>
                <span className="font-mono">£{formatCurrency(impact.monthlyAvailableAfter)}</span>
              </div>
              <div className="flex justify-between text-xs mt-1" style={{ color: impact.monthlyImpact > 0 ? 'var(--color-positive)' : 'var(--color-negative)' }}>
                <span>Change</span>
                <span className="font-mono">
                  {impact.monthlyImpact > 0 ? '+' : '-'}£{formatCurrency(Math.abs(impact.monthlyImpact))}/mo
                </span>
              </div>
            </>
          )}

          {impact.monthlyImpact !== 0 && impact.oneOffCashImpact !== 0 && <div className="h-px my-2" style={{ background: 'var(--color-track)' }} />}

          {impact.oneOffCashImpact !== 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-ink-muted)]">One-off cash impact</span>
                <span className="font-mono font-semibold" style={{ color: impact.oneOffCashImpact >= 0 ? 'var(--color-positive)' : 'var(--color-negative)' }}>
                  {impact.oneOffCashImpact >= 0 ? '+' : '-'}£{formatCurrency(Math.abs(impact.oneOffCashImpact))}
                </span>
              </div>
              <p className="text-[11px] text-[var(--color-ink-faint)] mt-1 leading-relaxed">
                A single payment, not a monthly change, so it's kept separate from the figures above
                {impact.loanImpacts.some((li) => li.kind === 'payoff')
                  ? " — whatever's left after every linked loan target in this scenario has taken what it needs."
                  : '.'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function monthsLabel(n: number): string {
  return `${n} month${n === 1 ? '' : 's'}`
}

function CardRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs mt-1" style={{ color: color ?? 'var(--color-ink-muted)' }}>
      <span>{label}</span>
      <span className="font-mono text-right">{value}</span>
    </div>
  )
}

/** One card per loan or credit card: where it stands now, one section per date (each building on the ones before), then all changes against now. Same layout as SavingsPotCard (Adam, 2026-09-17). */
function DebtCard({
  impact: di,
  viewerId,
  onMakeReal,
  loanImpacts,
}: {
  impact: DebtImpact
  viewerId?: string
  onMakeReal?: (li: LoanImpact) => void
  loanImpacts: LoanImpact[]
}) {
  const positive = 'var(--color-positive)'
  const negative = 'var(--color-negative)'
  const paymentLabel = viewerId ? 'Your payment' : 'Household payment'
  const finishLabel = (date: string | null, months: number) => (date ? formatFullDate(date) : months > 0 ? `${monthsLabel(months)} left` : 'Paid off')

  function finishRows(dateBefore: string | null, dateAfter: string | null, monthsBefore: number, monthsAfter: number, monthsSaved: number) {
    const before = finishLabel(dateBefore, monthsBefore)
    const after = finishLabel(dateAfter, monthsAfter)
    if (before === after) return null
    return (
      <>
        <CardRow label={di.dated ? 'Finishes' : 'Paid off in'} value={`${before} → ${after}`} color={positive} />
        {monthsSaved > 0 && <CardRow label="" value={`${monthsLabel(monthsSaved)} sooner`} color={positive} />}
      </>
    )
  }

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
      <p className="text-sm font-medium text-[var(--color-ink)] mb-1">
        {di.targetName}
        {di.fullyPaidOff && (
          <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: positive }}>
            Paid off
          </span>
        )}
      </p>

      <CardRow label="Balance now" value={`£${formatCurrency(di.balanceNow)}`} />
      <CardRow label={di.targetKind === 'credit_card' ? 'Minimum payment' : 'Monthly payment'} value={`£${formatCurrency(di.monthlyPaymentNow)}/mo`} />
      {di.finishDateNow && <CardRow label="Finishes" value={formatFullDate(di.finishDateNow)} />}
      <CardRow label="Months remaining" value={`${di.monthsRemainingNow}`} />

      {di.sections.map((s) => {
        const matchingImpact = loanImpacts.find((li) => li.loanId === di.targetId && li.targetKind === di.targetKind && (s.lumpSum > 0 ? li.kind === 'payoff' : li.kind === 'overpayment'))
        return (
          <div key={s.date}>
            <div className="flex items-center gap-2 mt-3 mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)] whitespace-nowrap">
                {di.dated ? `${s.newRecurringOverpayment !== null && s.lumpSum === 0 ? 'From ' : ''}${formatFullDate(s.date)}` : 'Today'}
              </span>
              <div className="h-px flex-1" style={{ background: 'var(--color-track)' }} />
            </div>

            {s.lumpSum > 0 && <CardRow label="Lump sum" value={`£${formatCurrency(s.lumpSum)}`} />}
            {s.lumpSum > 0 && s.recastMode && di.targetKind === 'loan' && (
              <CardRow label="Then" value={s.recastMode === 'reduce_payment' ? 'Lower the payment' : 'Finish sooner'} />
            )}
            {s.newRecurringOverpayment !== null && <CardRow label="Extra per month" value={`£${formatCurrency(s.newRecurringOverpayment)}/mo`} />}
            {s.balanceOnDateBefore !== s.balanceOnDateAfter && (
              <CardRow
                label={di.dated ? `Balance on ${formatFullDate(s.date)}` : 'Balance after'}
                value={`£${formatCurrency(s.balanceOnDateBefore)} → £${formatCurrency(s.balanceOnDateAfter)}`}
                color={positive}
              />
            )}
            {finishRows(s.finishDateBefore, s.finishDateAfter, s.monthsRemainingBefore, s.monthsRemainingAfter, s.monthsSaved)}
            {s.monthlyPaymentBefore !== s.monthlyPaymentAfter && (
              <CardRow
                label={paymentLabel}
                value={`£${formatCurrency(s.monthlyPaymentBefore)} → £${formatCurrency(s.monthlyPaymentAfter)}/mo`}
                color={s.monthlyPaymentAfter < s.monthlyPaymentBefore ? positive : negative}
              />
            )}
            {s.oneOffCash !== 0 && (
              <CardRow label="One-off cash" value={`-£${formatCurrency(Math.abs(s.oneOffCash))}`} color={negative} />
            )}
            {s.monthlyCashChange !== 0 && (
              <CardRow
                label="Available cash"
                value={`${s.monthlyCashChange > 0 ? '+' : '-'}£${formatCurrency(Math.abs(s.monthlyCashChange))}/month`}
                color={s.monthlyCashChange > 0 ? positive : negative}
              />
            )}
            {onMakeReal && matchingImpact && <MakeRealButton impact={matchingImpact} onMakeReal={onMakeReal} />}
          </div>
        )
      })}

      {di.sections.length >= 2 && (
        <>
          <div className="flex items-center gap-2 mt-3 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)] whitespace-nowrap">All changes</span>
            <div className="h-px flex-1" style={{ background: 'var(--color-track)' }} />
          </div>
          {di.totalLumpSum > 0 && <CardRow label="Lump sums" value={`£${formatCurrency(di.totalLumpSum)}`} />}
          <CardRow label="Balance" value={`£${formatCurrency(di.balanceNow)} → £${formatCurrency(di.balanceAfterAll)}`} color={positive} />
          {finishRows(di.finishDateNow, di.finishDateAfterAll, di.monthsRemainingNow, di.monthsRemainingAfterAll, di.totalMonthsSaved)}
          {di.totalOneOffCash !== 0 && <CardRow label="One-off cash" value={`-£${formatCurrency(Math.abs(di.totalOneOffCash))}`} color={negative} />}
          {di.totalMonthlyCashChange !== 0 && (
            <CardRow
              label="Available cash"
              value={`${di.totalMonthlyCashChange > 0 ? '+' : '-'}£${formatCurrency(Math.abs(di.totalMonthlyCashChange))}/month`}
              color={di.totalMonthlyCashChange > 0 ? positive : negative}
            />
          )}
        </>
      )}
    </div>
  )
}

/** One card per savings pot: the pot now, one section per date (each building on the ones before), then all changes against now. */
function SavingsPotCard({ impact: si }: { impact: SavingsPotImpact }) {
  const positive = 'var(--color-positive)'
  const negative = 'var(--color-negative)'
  const showReach = si.targetAmount !== null && !si.targetReached
  const reachLabel = (date: string | null) => (date ? formatFullDate(date) : 'Not within 30 years')
  const sooner = (months: number) => (months === 0 ? '' : `${monthsLabel(Math.abs(months))} ${months > 0 ? 'sooner' : 'later'}`)
  const money = (n: number) => `${n < 0 ? '-' : '+'}£${formatCurrency(Math.abs(n))}`
  const recurringDates = si.sections.filter((s) => s.newRecurringMonthlyAmount !== null).map((s) => s.date)

  let onTrackNote = ''
  if (si.monthsBehindTarget !== null && si.monthsBehindTarget > 0) onTrackNote = ` (${monthsLabel(si.monthsBehindTarget)} late)`
  if (si.monthsBehindTarget !== null && si.monthsBehindTarget < 0) onTrackNote = ` (${monthsLabel(-si.monthsBehindTarget)} early)`

  function divider(label: string) {
    return (
      <div className="flex items-center gap-2 mt-3 mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-faint)] whitespace-nowrap">{label}</span>
        <div className="h-px flex-1" style={{ background: 'var(--color-track)' }} />
      </div>
    )
  }

  function reachRows(before: string | null, after: string | null, months: number) {
    if (!showReach || before === after) return null
    return (
      <>
        <CardRow label="Reaches target" value={`${reachLabel(before)} → ${reachLabel(after)}`} color={months >= 0 ? positive : negative} />
        {months !== 0 && <CardRow label="" value={sooner(months)} color={months > 0 ? positive : negative} />}
      </>
    )
  }

  function targetDateRow(before: number | null, after: number | null) {
    if (!si.targetDate || before === null || after === null) return null
    return <CardRow label={`On ${formatFullDate(si.targetDate)}`} value={`£${formatCurrency(before)} → £${formatCurrency(after)}`} color={after >= before ? positive : negative} />
  }

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
      <p className="text-sm font-medium text-[var(--color-ink)] mb-1">{si.potName}</p>

      <CardRow label="Balance now" value={`£${formatCurrency(si.balanceNow)}`} />
      {si.targetAmount !== null && (
        <CardRow label="Target" value={`£${formatCurrency(si.targetAmount)}${si.targetDate ? ` by ${formatFullDate(si.targetDate)}` : ''}`} />
      )}
      {si.targetReached && <CardRow label="On track for" value="Target reached" color={positive} />}
      {showReach && <CardRow label="On track for" value={`${reachLabel(si.currentReachDate)}${si.currentReachDate ? onTrackNote : ''}`} />}

      {si.sections.map((s) => {
        const onlyRecurring = s.newRecurringMonthlyAmount !== null && s.lumpSum === 0 && s.withdrawal === 0
        return (
          <div key={s.date}>
            {divider(`${onlyRecurring ? 'From ' : ''}${formatFullDate(s.date)}`)}
            {s.lumpSum > 0 && <CardRow label="Lump sum" value={`+£${formatCurrency(s.lumpSum)}`} />}
            {s.withdrawal > 0 && <CardRow label="Withdrawal" value={`-£${formatCurrency(s.withdrawal)}`} />}
            {s.newRecurringMonthlyAmount !== null && (
              <CardRow label="Monthly deposit" value={`£${formatCurrency(s.oldRecurringMonthlyAmount ?? 0)} → £${formatCurrency(s.newRecurringMonthlyAmount)}/mo`} />
            )}
            {s.balanceOnDateBefore !== s.balanceOnDateAfter && (
              <CardRow label={`Balance on ${formatFullDate(s.date)}`} value={`£${formatCurrency(s.balanceOnDateBefore)} → £${formatCurrency(s.balanceOnDateAfter)}`} />
            )}
            {reachRows(s.reachDateBefore, s.reachDateAfter, s.monthsSaved)}
            {targetDateRow(s.balanceOnTargetDateBefore, s.balanceOnTargetDateAfter)}
            {s.oneOffCash !== 0 && <CardRow label="One-off cash" value={money(s.oneOffCash)} color={s.oneOffCash > 0 ? positive : negative} />}
            {s.monthlyCashChange !== 0 && (
              <CardRow label="Available cash" value={`${money(s.monthlyCashChange)}/month`} color={s.monthlyCashChange > 0 ? positive : negative} />
            )}
          </div>
        )
      })}

      {si.sections.length >= 2 && (
        <>
          {divider('All changes')}
          {reachRows(si.currentReachDate, si.finalReachDate, si.totalMonthsSaved)}
          {targetDateRow(si.balanceOnTargetDateNow, si.balanceOnTargetDateAfterAll)}
          {si.totalOneOffCash !== 0 && <CardRow label="One-off cash" value={money(si.totalOneOffCash)} color={si.totalOneOffCash > 0 ? positive : negative} />}
          {si.totalMonthlyCashChange !== 0 && (
            <CardRow
              label="Available cash"
              value={`${money(si.totalMonthlyCashChange)}/month${recurringDates.length === 1 ? ` from ${formatFullDate(recurringDates[0])}` : ''}`}
              color={si.totalMonthlyCashChange > 0 ? positive : negative}
            />
          )}
        </>
      )}
    </div>
  )
}

/** Sends a lump-sum or recurring-overpayment impact over to the Borrowing page, pre-filled and ready to review — see makeImpactReal above for why this navigates rather than saving directly. */
function MakeRealButton({ impact, onMakeReal }: { impact: LoanImpact; onMakeReal: (li: LoanImpact) => void }) {
  const label = impact.kind === 'payoff' ? `Log £${formatCurrency(impact.lumpSumApplied)} as a real payment` : 'Make this a real recurring overpayment'

  return (
    <button
      onClick={() => onMakeReal(impact)}
      className="text-xs font-medium mt-2"
      style={{ color: 'var(--color-coral)' }}
    >
      {label}
    </button>
  )
}

function ScenarioForm({
  people,
  initial,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  initial?: Scenario
  onSave: (s: Omit<Scenario, 'id'>) => void
  onCancel: () => void
}) {
  const { data: ledgerData } = useLedgerData()
  const data = useMemo(() => buildLegacyAppData(ledgerData), [ledgerData])
  const [name, setName] = useState(initial?.name ?? '')
  const [actions, setActions] = useState<Scenario['actions']>(initial?.actions ?? [])
  // Same rule as the Bills/Loans location pickers — "Joint" only makes
  // sense once 2+ people actually have a salary configured, not just 2+
  // people existing. See lib/household.ts's legacyPeopleWithSalaryCount
  // for why this is the legacy-shape variant of that check.
  const canBeJoint = legacyPeopleWithSalaryCount(data.people) >= 2

  // A lump-sum/exclude/recurring-overpayment action with nothing linked is
  // never valid to save — see REQUIRES_LOAN_TARGET.
  const actionsAllLinkedWhereRequired = actions.every((a) => !REQUIRES_LOAN_TARGET.includes(a.type) || resolveTargets(a).length > 0)
  // Same idea for the three savings-pot actions (REQUIRES_SAVINGS_POT_TARGET), which also need a date.
  const savingsPotActionsHaveTarget = actions.every((a) => !REQUIRES_SAVINGS_POT_TARGET.includes(a.type) || (Boolean(a.savingsPotId) && Boolean(a.date)))
  // A purchase without a date or a cost has nothing to compute against —
  // it would save as a silently inert action, which is exactly the kind
  // of "saved but does nothing" state this app has been bitten by before.
  const purchasesComplete = actions.every((a) => a.type !== 'purchase' || (Boolean(a.purchaseDate) && a.value > 0))
  // A pay_off_loan/loan_overpayment action with a LOAN target needs a
  // date before the real amortisation engine can place it in the
  // schedule (item d) — a credit-card-only target stays dateless (out of
  // this item's scope), so this only gates when a loan is actually
  // picked. Deliberately no default (Adam's own call) — the form forces
  // an explicit pick rather than silently assuming "today."
  const loanActionsHaveDateWhereNeeded = actions.every((a) => {
    if (!NEEDS_LOAN_DATE.includes(a.type)) return true
    const hasLoanTarget = resolveTargets(a).some((t) => t.kind === 'loan')
    return !hasLoanTarget || Boolean(a.date)
  })

  function round2(n: number): number {
    return Math.round(n * 100) / 100
  }

  // A target's current remaining balance, whichever kind it is — used to
  // work out how much a lump sum actually needs without duplicating the
  // loan-vs-card branch everywhere it's needed.
  function remainingForTarget(target: { kind: ScenarioTargetKind; id: string }): number {
    if (target.kind === 'loan') {
      const loan = data.loans.find((l) => l.id === target.id)
      return loan ? summarizeLoan(loan).remaining : 0
    }
    const card = data.creditCards.find((c) => c.id === target.id)
    // `data` here is the legacyBridge-mapped view, whose credit cards
    // already carry DERIVED balances (see withLiveBalances in
    // legacyBridge.ts) — so this is already "what's owed now", not the
    // stored anchor.
    return card ? card.currentBalance : 0
  }

  function addAction() {
    // If the previous action was a loan/card payoff/sale, default the new
    // one's value to whatever was left over after its target(s) were
    // cleared — you can still adjust it manually. With a single action now
    // able to cascade through several targets itself (see the picker
    // below), this mostly matters for chaining a genuinely separate action.
    const prev = actions[actions.length - 1]
    let defaultValue = 0
    if (prev && (prev.type === 'sell_asset' || prev.type === 'pay_off_loan') && prev.value > 0) {
      const targets = resolveTargets(prev)
      const totalNeeded = targets.reduce((sum, t) => sum + (t.amount != null ? t.amount : remainingForTarget(t)), 0)
      if (targets.length > 0) defaultValue = Math.max(0, round2(prev.value - totalNeeded))
    }
    setActions((p) => [...p, { id: nanoid(6), type: 'sell_asset', label: '', value: defaultValue }])
  }

  return (
    <div className="rounded-2xl p-4 mb-6 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Scenario name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sell the car, or Get furniture on finance"
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
        />
      </label>

      {actions.map((action, i) => {
        const currentTargets = resolveTargets(action)
        const totalNeededForTargets = currentTargets.reduce((sum, t) => sum + (t.amount != null ? t.amount : remainingForTarget(t)), 0)
        const showMultiLoanPicker = action.type === 'sell_asset' || action.type === 'pay_off_loan'
        const showSingleLoanPicker = action.type === 'exclude_loan' || action.type === 'loan_overpayment'
        const showFullPayoffHint = showMultiLoanPicker && currentTargets.length > 0
        const showPersonPicker = action.type === 'salary_change'
        const showSavingsPotPicker = REQUIRES_SAVINGS_POT_TARGET.includes(action.type)
        const showValue = NEEDS_VALUE.includes(action.type)
        const showSplit = NEEDS_SPLIT.includes(action.type)
        const showDate = NEEDS_DATE.includes(action.type)
        const showPurchaseName = action.type === 'purchase'
        const showFinanceInputs = action.type === 'new_finance_agreement'
        // item d — only relevant once a LOAN target is actually picked;
        // a credit-card-only pay_off_loan/loan_overpayment stays exactly
        // as it was before this item (out of scope, per Adam's own call).
        const targetsIncludeLoan = currentTargets.some((t) => t.kind === 'loan')
        const showLoanDate = NEEDS_LOAN_DATE.includes(action.type) && targetsIncludeLoan
        const showRecastToggle = action.type === 'pay_off_loan' && targetsIncludeLoan

        function updateAction(patch: Partial<Scenario['actions'][number]>) {
          setActions((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))
        }

        return (
          <div key={action.id} className="grid grid-cols-2 gap-2 rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
            <div className="col-span-2 flex items-center justify-between gap-2">
              <select
                value={action.type}
                onChange={(e) => updateAction({ type: e.target.value as ScenarioActionType })}
                className="flex-1 min-w-0 bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
              >
                {Object.entries(ACTION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button onClick={() => setActions((prev) => prev.filter((_, idx) => idx !== i))} className="text-[var(--color-ink-faint)]" title="Remove action">
                <Trash2 size={14} />
              </button>
            </div>

            {showSplit && (
              <input
                type="text"
                placeholder={action.type === 'new_finance_agreement' ? 'Name (e.g. Garden furniture finance)' : 'Name (e.g. Higher rent)'}
                value={action.name ?? ''}
                onChange={(e) => updateAction({ name: e.target.value })}
                className="col-span-2 w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
              />
            )}

            {showPurchaseName && (
              <input
                type="text"
                placeholder="What is it? (e.g. Washing machine)"
                value={action.name ?? ''}
                onChange={(e) => updateAction({ name: e.target.value })}
                className="col-span-2 w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
              />
            )}

            {showValue && (
              <input
                type="number"
                inputMode="decimal"
                placeholder={VALUE_LABELS[action.type] ?? 'Value (£)'}
                value={action.value || ''}
                onChange={(e) => updateAction({ value: Number(e.target.value) })}
                className={`w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm font-mono ${showMultiLoanPicker || showSingleLoanPicker || showPersonPicker || showSavingsPotPicker || showDate ? '' : 'col-span-2'}`}
              />
            )}

            {showDate && (
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">When</span>
                <input
                  type="date"
                  value={action.purchaseDate ?? ''}
                  onChange={(e) => updateAction({ purchaseDate: e.target.value })}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                />
              </label>
            )}

            {showDate && (!action.purchaseDate || !(action.value > 0)) && (
              <p className="col-span-2 text-[11px]" style={{ color: 'var(--color-negative)' }}>
                A purchase needs a date and a cost before its effect on your balance can be worked out.
              </p>
            )}

            {showLoanDate && (
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                  {action.type === 'pay_off_loan' ? 'When it lands' : 'Starts'}
                </span>
                <input
                  type="date"
                  value={action.date ?? ''}
                  onChange={(e) => updateAction({ date: e.target.value })}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                />
              </label>
            )}

            {showSavingsPotPicker && (
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                  {action.type === 'savings_pot_recurring_deposit_change' ? 'Starts' : action.type === 'savings_pot_withdrawal' ? 'When' : 'When it lands'}
                </span>
                <input
                  type="date"
                  min={todayIso()}
                  value={action.date ?? ''}
                  onChange={(e) => updateAction({ date: e.target.value })}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                />
              </label>
            )}

            {showSavingsPotPicker && !action.date && (
              <p className="col-span-2 text-[11px]" style={{ color: 'var(--color-negative)' }}>
                {action.type === 'savings_pot_recurring_deposit_change' ? 'When does the new deposit start?' : 'Pick a date for this.'}
              </p>
            )}

            {showRecastToggle && (
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">Then</span>
                <select
                  value={action.recastMode ?? 'reduce_term'}
                  onChange={(e) => updateAction({ recastMode: e.target.value as 'reduce_term' | 'reduce_payment' })}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                >
                  <option value="reduce_term">Finish sooner (keep the payment)</option>
                  <option value="reduce_payment">Lower the payment (keep the term)</option>
                </select>
              </label>
            )}

            {showLoanDate && !action.date && (
              <p className="col-span-2 text-[11px]" style={{ color: 'var(--color-negative)' }}>
                {action.type === 'pay_off_loan' ? 'When does this lump sum actually land?' : 'When does this extra payment start?'}
              </p>
            )}

            {showFinanceInputs && (
              <>
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="Amount to borrow (£)"
                  value={action.borrowAmount || ''}
                  onChange={(e) => {
                    const borrowAmount = Number(e.target.value)
                    const result = calculateFinanceAgreement({ borrowAmount, aprPercent: action.aprPercent ?? 0, termMonths: action.termMonths ?? 0 })
                    updateAction({ borrowAmount, value: result.monthlyPayment, totalRepayable: result.totalRepayable })
                  }}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm font-mono"
                />
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="Term (months)"
                  value={action.termMonths || ''}
                  onChange={(e) => {
                    const termMonths = Number(e.target.value)
                    const result = calculateFinanceAgreement({ borrowAmount: action.borrowAmount ?? 0, aprPercent: action.aprPercent ?? 0, termMonths })
                    updateAction({ termMonths, value: result.monthlyPayment, totalRepayable: result.totalRepayable })
                  }}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm font-mono"
                />
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  placeholder="Interest rate % (informational)"
                  value={action.interestRatePercent || ''}
                  onChange={(e) => updateAction({ interestRatePercent: Number(e.target.value) })}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm font-mono"
                />
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  placeholder="APR %"
                  value={action.aprPercent || ''}
                  onChange={(e) => {
                    const aprPercent = Number(e.target.value)
                    const result = calculateFinanceAgreement({ borrowAmount: action.borrowAmount ?? 0, aprPercent, termMonths: action.termMonths ?? 0 })
                    updateAction({ aprPercent, value: result.monthlyPayment, totalRepayable: result.totalRepayable })
                  }}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm font-mono"
                />
                <p className="col-span-2 text-xs text-[var(--color-ink-muted)] -mt-1">
                  £{formatCurrency(action.value)}/month · £{formatCurrency(action.totalRepayable ?? 0)} total repayable
                </p>
              </>
            )}

            {showPersonPicker && (
              <select
                value={action.personId || people[0]?.id || ''}
                onChange={(e) => updateAction({ personId: e.target.value })}
                className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
              >
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}

            {showSavingsPotPicker && (
              <>
                <select
                  value={action.savingsPotId ?? ''}
                  onChange={(e) => updateAction({ savingsPotId: e.target.value || undefined })}
                  className="col-span-2 w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                >
                  <option value="">Choose a savings pot…</option>
                  {people.map((p) => {
                    const potsForPerson = data.savingsPots.filter((pot) => pot.personId === p.id)
                    if (potsForPerson.length === 0) return null
                    return (
                      <optgroup key={p.id} label={p.name}>
                        {potsForPerson.map((pot) => (
                          <option key={pot.id} value={pot.id}>
                            {pot.name}
                          </option>
                        ))}
                      </optgroup>
                    )
                  })}
                </select>
                {data.savingsPots.length === 0 && (
                  <p className="col-span-2 text-[11px]" style={{ color: 'var(--color-negative)' }}>
                    No savings pots yet — add one on the Wallet page first.
                  </p>
                )}
                {data.savingsPots.length > 0 && !action.savingsPotId && (
                  <p className="col-span-2 text-[11px]" style={{ color: 'var(--color-negative)' }}>
                    Select which savings pot this applies to.
                  </p>
                )}
              </>
            )}

            {showSingleLoanPicker && (
              <>
                <select
                  value={currentTargets[0] ? `${currentTargets[0].kind}:${currentTargets[0].id}` : ''}
                  onChange={(e) => {
                    if (!e.target.value) {
                      updateAction({ linkedTargetKind: undefined, linkedTargetId: undefined, linkedLoanId: undefined })
                      return
                    }
                    const [kind, id] = e.target.value.split(':') as [ScenarioTargetKind, string]
                    updateAction({ linkedTargetKind: kind, linkedTargetId: id, linkedLoanId: undefined })
                  }}
                  className="col-span-2 w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                >
                  <option value="">Choose a loan or credit card…</option>
                  {data.loans.map((l) => (
                    <option key={`loan:${l.id}`} value={`loan:${l.id}`}>
                      {l.name}
                    </option>
                  ))}
                  {data.creditCards.map((c) => (
                    <option key={`credit_card:${c.id}`} value={`credit_card:${c.id}`}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {currentTargets.length === 0 && (
                  <p className="col-span-2 text-[11px]" style={{ color: 'var(--color-negative)' }}>
                    {action.type === 'exclude_loan' ? 'Select the loan or credit card to exclude.' : 'Select which loan or credit card this extra payment goes toward.'}
                  </p>
                )}
              </>
            )}

            {showMultiLoanPicker && (
              <div className="col-span-2 flex flex-col gap-1.5">
                {currentTargets.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {currentTargets.map((target, idx) => {
                      const name =
                        target.kind === 'loan' ? data.loans.find((l) => l.id === target.id)?.name : data.creditCards.find((c) => c.id === target.id)?.name
                      const targetRemaining = remainingForTarget(target)
                      const autoAmount = Math.max(0, action.value - currentTargets.slice(0, idx).reduce((s, t) => s + (t.amount ?? remainingForTarget(t)), 0))
                      function updateTarget(patch: Partial<{ kind: ScenarioTargetKind; id: string; amount?: number }>) {
                        const next = currentTargets.map((t, tIdx) => (tIdx === idx ? { ...t, ...patch } : t))
                        updateAction({ targets: next, loanAllocations: undefined, linkedLoanId: undefined })
                      }
                      return (
                        <div key={`${target.kind}:${target.id}`} className="flex items-center gap-2 text-xs rounded-lg px-2 py-1.5" style={{ background: 'var(--color-track)' }}>
                          <span className="text-[var(--color-ink)] flex-1">
                            {idx + 1}. {name ?? (target.kind === 'loan' ? 'Unknown loan' : 'Unknown credit card')}
                          </span>
                          <input
                            type="number"
                            inputMode="decimal"
                            placeholder={`auto (£${formatCurrency(Math.min(autoAmount, targetRemaining))})`}
                            value={target.amount ?? ''}
                            onChange={(e) => updateTarget({ amount: e.target.value === '' ? undefined : Number(e.target.value) })}
                            className="w-24 bg-transparent border-b border-[var(--color-ink-faint)] py-0.5 text-[var(--color-ink)] outline-none font-mono text-right"
                          />
                          <button
                            onClick={() =>
                              updateAction({
                                targets: currentTargets.filter((t) => !(t.kind === target.kind && t.id === target.id)),
                                loanAllocations: undefined,
                                linkedLoanId: undefined,
                              })
                            }
                            className="text-[var(--color-ink-faint)]"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                <select
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return
                    const [kind, id] = e.target.value.split(':') as [ScenarioTargetKind, string]
                    updateAction({ targets: [...currentTargets, { kind, id }], loanAllocations: undefined, linkedLoanId: undefined })
                  }}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                >
                  <option value="">
                    {currentTargets.length === 0
                      ? action.type === 'pay_off_loan'
                        ? 'Choose a loan or credit card…'
                        : 'No linked loan/credit card (optional)'
                      : '+ Add another target…'}
                  </option>
                  {data.loans
                    .filter((l) => !currentTargets.some((t) => t.kind === 'loan' && t.id === l.id))
                    .map((l) => (
                      <option key={`loan:${l.id}`} value={`loan:${l.id}`}>
                        {l.name}
                      </option>
                    ))}
                  {data.creditCards
                    .filter((c) => !currentTargets.some((t) => t.kind === 'credit_card' && t.id === c.id))
                    .map((c) => (
                      <option key={`credit_card:${c.id}`} value={`credit_card:${c.id}`}>
                        {c.name}
                      </option>
                    ))}
                </select>
                {currentTargets.length > 0 && (
                  <p className="text-[11px] text-[var(--color-ink-faint)]">
                    By default each target takes as much as it needs, in order — leave the amount blank for that. Type a number to
                    cap what goes to that one instead.
                  </p>
                )}
                {action.type === 'pay_off_loan' && currentTargets.length === 0 && (
                  <p className="text-[11px]" style={{ color: 'var(--color-negative)' }}>
                    Select at least one loan or credit card for this lump sum to go toward.
                  </p>
                )}
              </div>
            )}

            {showFullPayoffHint && (
              <button
                onClick={() => updateAction({ value: totalNeededForTargets })}
                className="col-span-2 text-xs font-medium text-left mt-1"
                style={{ color: 'var(--color-coral)' }}
              >
                Use total needed to clear {currentTargets.length > 1 ? 'all listed targets' : "the target's remaining balance"} (£
                {formatCurrency(totalNeededForTargets)})
              </button>
            )}

            {showSplit && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--color-ink-muted)]">Location</span>
                {canBeJoint ? (
                  <select
                    value={action.location ?? 'personal'}
                    onChange={(e) => {
                      const loc = e.target.value as BillLocation
                      updateAction(loc === 'joint' ? { location: loc, payee: action.payee || people[0]?.id } : { location: loc })
                    }}
                    className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                  >
                    <option value="personal">Personal</option>
                    <option value="joint">Joint</option>
                  </select>
                ) : (
                  <span className="text-sm text-[var(--color-ink-faint)] py-1">Personal (add a second person's salary on the Salary page to split costs)</span>
                )}
              </label>
            )}
            {showSplit && people.length > 1 && (action.location ?? 'personal') === 'personal' && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--color-ink-muted)]">Owner</span>
                <select
                  value={action.ownerId || people[0]?.id || ''}
                  onChange={(e) => updateAction({ ownerId: e.target.value })}
                  className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
                >
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {showSplit && action.location === 'joint' && (
              <SplitEditor
                people={people}
                payee={action.payee || people[0]?.id || ''}
                percent={action.payeeSharePercent ?? 50}
                onChangePayee={(payee) => updateAction({ payee })}
                onChangePercent={(payeeSharePercent) => updateAction({ payeeSharePercent })}
              />
            )}
          </div>
        )
      })}

      <button onClick={addAction} className="text-sm font-medium self-start" style={{ color: 'var(--color-coral)' }}>
        + Add action
      </button>

      <div className="flex items-center justify-end mt-1">
        <button onClick={onCancel} className="text-xs text-[var(--color-ink-muted)] px-2">
          Cancel
        </button>
      </div>
      <button
        disabled={!name.trim() || actions.length === 0 || !actionsAllLinkedWhereRequired || !savingsPotActionsHaveTarget || !purchasesComplete || !loanActionsHaveDateWhereNeeded}
        onClick={() => {
          onSave({
            name: name.trim(),
            includeInCumulative: initial?.includeInCumulative ?? true,
            actions: actions.map((a) => ({ ...a, label: ACTION_LABELS[a.type] })),
          })
        }}
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        {initial ? 'Save changes' : 'Save scenario'}
      </button>
    </div>
  )
}

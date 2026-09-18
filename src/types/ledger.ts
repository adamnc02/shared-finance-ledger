// ─────────────────────────────────────────────────────────────────────────
// NEW DATA MODEL — proposed shape for the rebuild.
//
// This supersedes src/types/models.ts for the parts of the app that are
// being rebuilt (see requirements doc, Section 4). It is written to sit
// alongside the current app's types during development, not as a live
// replacement — nothing here is wired up yet. The intent is to agree on
// the shape first, then build the Phase 1 ledger/summary UI against it.
//
// What's kept from the old model (imported, not redefined here):
//  - PayFrequency, StudentLoanPlan, SalaryDeduction, DeductionType,
//    DeductionAmountType — the tax engine's inputs are unchanged.
//  - BillLocation ('personal' | 'joint') and the payee/payeeSharePercent
//    split model — this is the one piece of shared plumbing everything
//    else depends on, and it ports over unchanged (doc Section 4.2).
//  - Scenario / ScenarioActionType (What-if) — unchanged, see the note
//    on WhatIfScenario below.
//
// What's new: Transaction, Category, RecurringTemplate (replaces Bill),
// the updated Loan shape, PayCycleConfig, SalarySnapshot/SalaryOverride,
// and the AppDataV2 root object that ties them together.
// ─────────────────────────────────────────────────────────────────────────

import type { PayFrequency, SalaryDeduction, StudentLoanPlan } from '../lib/tax'
import type { BillLocation, Scenario } from './models'

// ── Shared enums ────────────────────────────────────────────────────────

// Confirmed answer to the doc's Section 5 open question: these five, no
// others, for the initial build.
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'direct_debit' | 'standing_order'

export type TransactionStatus = 'cleared' | 'pending'

// What generated this transaction / what it represents. `bill_payment` and
// `loan_payment` are generated from a RecurringTemplate or Loan on schedule;
// the rest are logged directly on the Expenses/Ad-hoc page (doc Section 4.3).
export type TransactionType =
  | 'bill_payment'
  | 'loan_payment'
  | 'expense' // ad-hoc, one-off outgoing paid by cash/bank transfer/direct debit/standing order — real cash out
  | 'income' // ad-hoc, one-off incoming, no effect on standing salary — e.g. a cash gift, a bank transfer from family
  | 'bonus' // ad-hoc incoming that DOES add to that period's net pay — see SalaryOverride
  | 'salary' // the regular pay-day transaction, generated from Person.salaryHistory
  // A pension payment, generated from a Pension (see "Pensions" below) on
  // its own frequency/anchorDate — deliberately a distinct type from
  // 'salary' rather than folded into it, even though both are treated as
  // income the same way everywhere else (direction 'in', INCOME_CATEGORY_ID,
  // counted in every projection/summary salary already was) — a distinct
  // type is what lets the ledger label each row with the PENSION's own
  // name ("State Pension") instead of everything reading "Salary".
  // sourceType 'pension' + sourceId link it back to the Pension.
  | 'pension_income'
  // Something charged TO a credit card, logged from the Transactions page with
  // paymentMethod: 'card'. Deliberately NOT real cash out: this does not
  // touch the ledger's running balance and does not appear on the
  // Personal card's transaction list — it only shows on the specific
  // credit card's own list, and increases that card's currentBalance.
  // direction: 'out' (uses available credit, same convention as any other
  // outgoing type). On the credit card's OWN transaction list, this is
  // displayed as a POSITIVE charge (it added to the balance owed) — that
  // display sign is derived from `type`, not from `direction`; see
  // CreditCard below. creditCardId is required on this type.
  | 'credit_card_spend'
  // A payment made FROM the ledger TOWARD a credit card — the generated
  // monthly minimum/fixed payment, or a logged ad-hoc lump payment. This
  // IS real cash out: it reduces the ledger balance and DOES appear as a
  // negative amount on the Personal card, same as any other outgoing
  // transaction — this is the "modern banking app" behaviour: paying
  // down a card is an expense against your cash account. direction:
  // 'out' (same reasoning — cash left the personal ledger). On the
  // credit card's OWN transaction list, this is displayed as a NEGATIVE
  // charge (it reduced the balance owed) — again derived from `type`,
  // not `direction`. Reduces that card's currentBalance. creditCardId is
  // required on this type.
  | 'credit_card_payment'
  // A manual or recurring deposit INTO a SavingsPot — debits the personal
  // ledger, credits the pot. direction: 'out' on the personal ledger (cash
  // genuinely left the current account), same "type-derived sign on the
  // pot's OWN list" pattern as credit_card_spend/credit_card_payment: on
  // the pot's own ledger this shows as a positive (money added).
  // savingsPotId required. sourceType 'savings_pot' + sourceId identify a
  // GENERATED recurring deposit; a hand-logged one from the Transactions
  // page's Savings button has neither, same convention as ad-hoc
  // expense/income vs a materialized recurring-transaction occurrence.
  | 'savings_deposit'
  // The reverse of savings_deposit — debits the pot, credits the personal
  // ledger. direction: 'in' on the personal ledger ("visible as
  // income-equivalent in the summary page", per spec) — on the pot's own
  // ledger this shows as a negative (money removed). Always hand-logged
  // from the Transactions page's Savings button; nothing generates these
  // automatically. savingsPotId required.
  | 'savings_withdrawal'
  // Interest credited BY THE BANK into a pot, per its interestMethod
  // (lib/savingsInterest.ts) — generated on schedule by
  // lib/savingsPotLedger.ts, or set via a manual override (the ONE thing
  // the pot's info-icon ledger modal allows editing — deposits/
  // withdrawals are not editable there). direction: 'in', but — like
  // credit_card_spend — this does NOT touch the personal ledger's cash
  // balance or appear on the Personal card's list: it's the bank's own
  // money moving inside the pot, not cash from the current account.
  // Only ever shown on the pot's own ledger, always as a positive/green
  // line. savingsPotId required, sourceType 'savings_pot' + sourceId for
  // a generated one; a manually-overridden interest payment (see
  // SavingsPot.interestOverrides) carries no sourceType, same "hand-set
  // beats generated" convention as every other override in this app.
  | 'savings_interest'
  // ── Joint account deposit/withdrawal (Adam-specified, 2026-09-03) ────
  // Hand-logged only, from the Transactions page's "Joint" pill — nothing
  // generates these automatically. The ONLY joint-account-related items
  // that appear on the Household card (see lib/householdLedger.ts) —
  // joint bills themselves are deliberately excluded from Household now,
  // see that file's header for the full reasoning.
  //
  // A deposit debits the depositing person's OWN personal ledger
  // (direction 'out' there — cash genuinely left their current account)
  // and credits the joint account. Same "type-derived sign, not
  // direction-derived" pattern as credit_card_spend/savings_deposit: on
  // the JOINT account's own ledger (lib/jointAccountLedger.ts's
  // jointAccountSignedAmount) this shows as a POSITIVE, regardless of
  // `direction`. personId identifies whose personal account it left;
  // location is always 'personal', ownerId the same personId — an
  // ordinary personal-ledger row in every other respect, which is what
  // lets it flow through computeProjection/isLedgerTransaction with no
  // special-casing needed there.
  | 'joint_deposit'
  // The reverse — credits the withdrawing person's personal ledger
  // (direction 'in'), debits the joint account (negative on its own
  // ledger). Same personId/location/ownerId convention as joint_deposit.
  | 'joint_withdrawal'
  // ── Pot deposit/withdrawal (Pots backlog item, Adam-specified 2026-09-03) ──
  // A manual or recurring deposit INTO a Pot — exactly the same shape and
  // reasoning as savings_deposit (direction 'out' on the personal ledger,
  // location: 'personal', ownerId: pot.personId — a real cash-out event),
  // just against Pot instead of SavingsPot. potId required. sourceType
  // 'pot' + sourceId identify a GENERATED recurring deposit; a
  // hand-logged one from the Transactions page's Pots button has neither.
  // This is the ONLY pot-related transaction type that touches personal
  // cash — see bill_payment/loan_payment below for the deliberately
  // different, "purely internal to the pot" treatment a pot-FUNDED
  // payment gets (Adam confirmed 2026-09-03: the cash-out event is this
  // deposit, not the later bill payment).
  | 'pot_deposit'
  // The reverse of pot_deposit — debits the pot, credits the personal
  // ledger (direction 'in', same "visible as income-equivalent" rule
  // savings_withdrawal/joint_withdrawal already follow). Always
  // hand-logged from the Transactions page's Pots button; nothing
  // generates these automatically. potId required.
  //
  // NOTE: a pot-funded 'bill_payment'/'loan_payment' does NOT get its own
  // new TransactionType — it reuses the existing ones, just carrying
  // location: 'pot' + potId instead of 'personal' (see RecurringTemplate.
  // potId's comment). Same for a pot-funded recurring loan overpayment —
  // still 'loan_payment', sourceType 'loan_recurring_overpayment', just
  // location: 'pot'. Reusing the existing types rather than inventing
  // 'pot_bill_payment'/'pot_loan_payment' keeps every place that already
  // reads "what kind of thing is this" (category grouping, icons,
  // Bills-page filtering) working unchanged for a pot-funded bill/loan —
  // only WHERE it's routed (which ledger) changes, not WHAT it is.
  | 'pot_withdrawal'
  // ── Transfer (2026-09-04 session) — the generic replacement for the six
  // types above. A single Transfer pill on the Transactions page now
  // covers current-account <-> savings pot / joint account / pot in both
  // directions, one-off or recurring — see TransferLocation below and
  // lib/transferLedger.ts. savings_deposit/savings_withdrawal/
  // joint_deposit/joint_withdrawal/pot_deposit/pot_withdrawal are
  // SUPERSEDED by this — no longer generated or hand-loggable anywhere;
  // kept in the union purely so an already-persisted backup still
  // type-checks/loads (same "superseded, kept for round-tripping"
  // convention). `direction`/`location`/
  // `ownerId` are still set on a transfer transaction, using the exact
  // same values the superseded types used to — 'personal' + the primary
  // person's id whenever 'personal' is one of the two endpoints (which,
  // per Adam's 2026-09-04 decision, it always is for anything logged in
  // this app — the "current account" leg of any transfer is always ME,
  // never a picker) — so it flows through the EXISTING personal-ledger
  // machinery (projection.ts/autoClear.ts/runningBalance.ts) with no
  // changes needed there at all. `fromLocation`/`toLocation` are the new
  // fields that identify BOTH endpoints explicitly; savingsPotId/potId
  // are also still populated (mirroring whichever endpoint is a
  // savings pot / pot) purely so every existing simple `t.savingsPotId
  // === pot.id` / `t.potId === pot.id` style filter elsewhere in the app
  // keeps working unchanged — see savingsPotLedger.ts/potLedger.ts/
  // jointAccountLedger.ts's own signed-amount functions for how they
  // derive the correct sign from fromLocation/toLocation now that the
  // same type can mean an inflow OR an outflow to a given entity.
  | 'transfer'

export type RecurrenceFrequency = 'weekly' | 'every_n_weeks' | 'monthly' | 'quarterly' | 'annual'

// ── Transfer locations (2026-09-04 session) ─────────────────────────────
// The four places money can live, for the purposes of a Transfer. Every
// transfer has exactly one `type` here; 'savings'/'pot' additionally
// carry which specific pot. 'personal' needs no id — it always means the
// primary person's own current account (Adam-specified 2026-09-04: no
// picker, always me). 'joint' needs no id — there's only ever one joint
// account.
export type TransferLocationType = 'personal' | 'savings' | 'joint' | 'pot'

export interface TransferLocation {
  type: TransferLocationType
  savingsPotId?: string // set only when type === 'savings'
  potId?: string // set only when type === 'pot'
}

// 2026-09-14 — Transaction.location's own type: everywhere BillLocation
// already reaches ('personal' | 'joint' | 'pot'), plus 'savings', used
// exclusively by a savings_interest row paid into a Savings Pot. Scoped to
// Transaction alone — see Transaction.location's own comment.
export type TransactionLocation = BillLocation | 'savings'

// ── Category ────────────────────────────────────────────────────────────
// First-class entity (doc Section 3.5 / 4.1). Icon + colour live here now,
// not on the individual Bill/Loan/Transaction — every item in a category
// inherits its look automatically. Auto-generated on creation (name in,
// icon+colour chosen automatically); the picker/"key" UI goes away.

// Reserved built-in category id, seeded at app init (isBuiltIn: true,
// undeletable). Every credit_card_payment/credit_card_spend transaction
// carries the owning CreditCard's own (freely user-assignable)
// categoryId, NOT this one directly — this id exists so there's always a
// sensible default to assign a new card to, and so the "group by
// category" summary view (Home.tsx's groupingCategoryId) has a fixed,
// stable bucket to fold every credit-card-ENTITY transaction into
// (identified by `type`: credit_card_payment/credit_card_spend)
// regardless of what real category any individual card carries.
// 2026-09-18 — this does NOT extend to an ordinary expense/bill paid by
// `paymentMethod: 'card'` with no `creditCardId` (a debit card payment).
// That falls through to its own categoryId, same as Cash.
export const CREDIT_CARD_CATEGORY_ID = 'category-credit-card'

// Reserved built-in category id for generated 'salary' transactions
// (Phase 3 — see lib/salaryLedger.ts). Ad-hoc 'income'/'bonus' entries
// are NOT forced onto this one — the person can pick it from the list
// like any other category, or pick something else, since those are
// logged by hand and a forced category would be presumptuous. Only the
// auto-generated payday transaction always uses it.
export const INCOME_CATEGORY_ID = 'category-income'

// Reserved built-in category id for a generic default bills category —
// one of the three defaults (alongside Credit Card and Income) that are
// always present and visible in the category management modal, so
// there's always something sensible to pick even before the person has
// created any categories of their own.
export const BILLS_CATEGORY_ID = 'category-bills'

// Reserved built-in category id for generated savings/pot transfer
// transactions — no category picker for these, same as Credit Card.
export const SAVINGS_CATEGORY_ID = 'category-savings'

export interface Category {
  id: string
  name: string
  icon: string // key into the built-in icon library, see lib/billIcons.ts
  iconColor: string // hex color
  // True for the handful of categories the app ships with (e.g. general
  // "Bills", "Loans" fallbacks) — these can't be deleted, only renamed.
  isBuiltIn?: boolean
}

// ── Transaction — the central new entity ───────────────────────────────
// A single dated, amount-bearing entry. Recurring templates, loans, and
// salary are *generators* of these, not the source of truth themselves
// (doc Section 4.1). The running balance is a fold over this list.

export interface Transaction {
  id: string
  date: string // ISO date — when it clears/is due, not necessarily when it was entered
  amount: number // always positive; direction below decides the sign
  // Sign convention on the Personal/Joint/Household ledger, summarised —
  // 'out' always displays negative, 'in' always displays positive, no
  // exceptions (this is the one place `direction` unambiguously controls
  // display sign; see TransactionType above for the credit-card types,
  // where the card's OWN list uses a separate, `type`-derived sign):
  //   'out' (negative): bill_payment, loan_payment, expense, credit_card_payment
  //   'in'  (positive): salary, bonus, income
  direction: 'in' | 'out'
  // Always CREDIT_CARD_CATEGORY_ID for type 'credit_card_spend' or
  // 'credit_card_payment' — enforced at creation, not just render.
  categoryId: string
  paymentMethod: PaymentMethod
  status: TransactionStatus
  type: TransactionType
  note?: string
  // Whose account this sits in for personal/joint/household splitting —
  // same split model as Bill/Loan today. Not used for direction: 'in'
  // salary/bonus/income entries tied to a specific person (use personId
  // instead); used for bill/loan payments and ad-hoc expenses.
  //
  // 2026-09-14 — Transaction's OWN location is `TransactionLocation`
  // (BillLocation + 'savings'), not `BillLocation` directly — deliberately
  // scoped to just this one field. A Bill/Loan/RecurringTemplate's own
  // `location: BillLocation` field is completely untouched by this and
  // still only ever offers personal/joint/pot — this does NOT give bills
  // the ability to be tagged against a savings pot. 'savings' only ever
  // appears here on a `type: 'savings_interest'` row whose chosen
  // interestDestination is a Savings Pot (see SavingsPot.interestDestination),
  // so it can correctly avoid ALSO counting toward the personal ledger's
  // cash balance the way a plain `location: 'personal'` row would.
  location: TransactionLocation
  ownerId: string // whose personal account, when location = 'personal'
  payee?: string
  payeeSharePercent?: number
  // Which person this belongs to — required for salary/bonus/income,
  // optional context otherwise.
  personId?: string
  // Back-link to what generated this, so edits/deletes on the template
  // can find their generated instances. Undefined for genuinely ad-hoc
  // entries (expense/income logged directly, not from a template).
  // 'credit_card_lump_payment' links a credit_card_payment transaction
  // back to the specific CreditCardLumpPayment record (sourceId), when
  // it wasn't the generated monthly/minimum payment.
  sourceType?:
    | 'recurring_template'
    | 'loan'
    | 'loan_overpayment'
    | 'loan_recurring_overpayment'
    | 'loan_settlement'
    | 'credit_card_lump_payment'
    | 'pension'
    | 'savings_pot' // a generated recurring deposit or generated interest credit — see savings_deposit/savings_interest above
    | 'pot' // a generated recurring pot_deposit — see Pot below
    // A transfer created BY a SalarySort (App_Dev.md "Salary Sorter &
    // Transfer Pill", 2026-09 session) — sourceId points at the
    // SalarySort.id. Unlike every sourceType above, this is NOT a
    // "generated, caller dedupes" link: the transaction this sits on is
    // a REAL, independently-editable row (SalarySort.targets stores its
    // own `transactionId` back-reference — see SalarySort below), the
    // same as any other hand-logged transfer. This sourceType exists
    // purely so LedgerContext's updateTransaction/removeTransaction can
    // find and keep the owning SalarySort's target amount in sync (or
    // detach it, see SalarySort's own comment) without a second lookup
    // table anywhere.
    | 'salary_sort'
  sourceId?: string
  // WHICH occurrence of that source this row is — the natural,
  // anchor-walked date of its slot, i.e. exactly the `originalDate` key
  // `RecurringTemplate.occurrenceOverrides` uses. Set only on rows
  // generated from a RecurringTemplate (sourceType 'recurring_template').
  //
  // 2026-09-16 (Adam-reported, single-occurrence date move) — `date`
  // alone cannot identify a materialized occurrence, because a
  // per-occurrence date move CHANGES it. reconcileRecurringTemplateTransactions
  // used to re-find its row by matching either end of a single move
  // (`o.originalDate === t.date || o.date === t.date`); after a SECOND
  // move there are three dates in play and the intermediate one is
  // recorded nowhere, so the stored row was stranded at a date that no
  // longer corresponded to any occurrence, and the generator — whose
  // dedupeKey is also keyed on the date — then materialized the same
  // occurrence a second time. Two cleared rows, both counting against
  // the balance. This field makes the slot explicit so identity no
  // longer depends on a mutable value. Same class of bug as
  // SalarySnapshot.recordedSeq (see DATA-MODEL-REVIEW-2026-09-15.md
  // §11.7a and PROMPT-02): identity keyed off something that moves.
  //
  // Optional because rows materialized before this field existed don't
  // carry it. They are NOT migrated in ledgerStorage — instead
  // reconcileRecurringTemplateTransactions stamps each one the first
  // time it sees it, deriving the slot from the same two-way date match
  // that worked for a single move, which is all a pre-existing row can
  // have been through. Treat "absent" as "derive it, then stamp it",
  // never as "this row has no slot".
  occurrenceOriginalDate?: string
  // Required when type is 'credit_card_spend' or 'credit_card_payment' —
  // which card this is against. See TransactionType above for how each
  // type does or doesn't affect the ledger balance / Personal card list.
  creditCardId?: string
  // Required when type is 'savings_deposit' | 'savings_withdrawal' |
  // 'savings_interest' — which pot this is against. Same role as
  // creditCardId above: identifies which entity's OWN ledger this row
  // belongs to, separate from whether/how it touches the personal ledger.
  savingsPotId?: string
  // Required when location === 'pot' (a pot-funded bill_payment/
  // loan_payment/recurring-overpayment row), or type is 'pot_deposit' |
  // 'pot_withdrawal' — which Pot this transaction is against. Same
  // convention as savingsPotId/creditCardId: identifies the entity whose
  // OWN ledger (lib/potLedger.ts) this row belongs to. Deliberately a
  // SEPARATE field from savingsPotId even though both point at a
  // "pot"-shaped entity — SavingsPot and Pot are different entities (see
  // Pot's own header comment), and conflating their id spaces would make
  // a stray cross-lookup a silent, hard-to-spot bug.
  potId?: string
  // Required when type === 'transfer' — the two endpoints. See
  // TransferLocation above and TransactionType's own 'transfer' comment
  // for how these interact with the flatter location/ownerId/
  // savingsPotId/potId fields also set on the same row.
  fromLocation?: TransferLocation
  toLocation?: TransferLocation
  // True when a transfer was generated by following the primary
  // person's resolved payday rather than a fixed calendar date — set on
  // both the generating RecurringTemplate and each Transaction it
  // produces, purely for display ("follows payday" badge) since the
  // actual date is already resolved into `date` by generation time.
  followsPayday?: boolean
  // Same idea as followsPayday immediately above, but resolving against
  // the primary person's budgeting-CYCLE start instead (Salary Sorter
  // session, 2026-09) — mutually exclusive with followsPayday on the
  // same template/transaction (RecurringTransferEditor/TransferForm
  // enforce this; schedule.ts's generateTransactionsForTemplate checks
  // followsPayday first, so if both were somehow set, followsPayday
  // wins). Exists because a person's cycle boundary and their payday are
  // deliberately independent settings (PayCycleConfig.
  // cycleStartFollowsPayday) — someone whose budgeting cycle doesn't
  // track payday still wants a recurring transfer that lands exactly on
  // THEIR cycle boundary, not on payday.
  followsCycleStart?: boolean
}

// ── RecurringTemplate — replaces today's Bill ──────────────────────────
// Generalises Bill with a real frequency instead of an implicit "monthly,
// due on day N" (doc Section 3.1, classified Rebuild). Generates
// Transactions on schedule; itself holds no cleared/pending state.

export interface RecurringTemplate {
  id: string
  name: string
  amount: number // the CURRENT amount — always what's shown/edited in the form. See amountEffectiveFrom/amountHistory below for how a scheduled change is recorded without disturbing this.
  categoryId: string
  paymentMethod: PaymentMethod
  frequency: RecurrenceFrequency
  // Only meaningful when frequency === 'every_n_weeks'.
  intervalWeeks?: number
  // Anchor date the schedule is generated from — e.g. for 'monthly' this
  // is only used for its day-of-month; for 'weekly'/'every_n_weeks' the
  // weekday and cadence both come from this date; for 'quarterly'/'annual'
  // it's the first occurrence.
  anchorDate: string // ISO date
  // 2026-09-16 (Adam-specified) — the intended day of month for a
  // monthly/quarterly/annual schedule, when it differs from anchorDate's
  // own day. Set only when a schedule change has to anchor on a month too
  // short for the chosen day (a "31st" bill re-anchored in September is
  // stored as 30 Sep): each occurrence then falls on this day, or the
  // month's last day when the month is shorter, so it's the 31st again in
  // October. Absent = anchorDate's own day, as every template before this.
  // Cleared whenever anchorDate itself is edited.
  anchorDayOfMonth?: number
  location: BillLocation
  ownerId: string
  payee: string
  payeeSharePercent: number
  // Which Pot this bill pays from — set only when location === 'pot',
  // undefined otherwise (Pots backlog item, 2026-09-03). A pot-located
  // bill still generates its normal 'bill_payment' transactions
  // (schedule.ts) — they just carry location: 'pot' + this potId instead
  // of 'personal', which is what routes them onto the pot's own ledger
  // (lib/potLedger.ts) and out of the personal one (projection.ts's
  // `location === 'personal'` filters exclude them automatically, same
  // mechanism that already keeps a 'joint' bill out of anyone's personal
  // ledger — no new exclusion logic needed for this).
  potId?: string
  // Historized location change — mirrors amountEffectiveFrom/amountHistory
  // above, but for WHERE this bill is paid from rather than how much it
  // costs (Adam-specified, 2026-09-03: "an extension of location," not a
  // separate field). `locationEffectiveFrom` is set together with
  // `locationHistory` whenever the location is changed via the Wallet
  // page's "move to a pot" flow. Unlike amount, this does NOT feed a
  // per-occurrence resolver — `location`/`potId` above are always the
  // live, current values that every generator reads directly (see
  // schedule.ts), since generation only ever runs forward from "now."
  // What DOES use `locationEffectiveFrom` is a one-time rewrite, at the
  // moment the change is made, of every already-existing Transaction for
  // this template dated on/after it — including already-CLEARED ones,
  // per Adam's explicit spec ("bill payments leave my personal ledger...
  // including cleared ones, the current balance on personal will need to
  // update accordingly") — see reassignTransactionsForLocationChange in
  // lib/locationChange.ts. A location change is therefore NOT purely
  // forward-looking the way an amount change is; `locationHistory` is
  // kept primarily as an audit trail (Wallet page: "in Bills pot since
  // 1 Sept 2026") rather than something generation logic re-derives.
  // KNOWN SIMPLIFICATION (flagged rather than solved): if
  // `locationEffectiveFrom` is set to a FUTURE date (the change hasn't
  // "started" yet), generation still follows the new `location`
  // immediately, not the old one until that date arrives — the picker
  // defaults to today and Adam's spec describes an immediate-effect
  // workflow, so this hasn't been built. Worth a real decision if a
  // future-dated location change turns out to matter in practice.
  locationEffectiveFrom?: string
  locationHistory?: LocationChange[]
  active: boolean // paused templates stop generating new transactions
  // ISO date `amount` has applied from. Absent means `amount` has always
  // applied (no recorded change) — the common case for a bill that's
  // never had its value edited with a specific "starting from" payment.
  // Set together with amountHistory whenever a change is confirmed
  // through the "which payment should this apply from" picker (Bills.tsx)
  // — see resolveTemplateAmount in schedule.ts for how these three fields
  // combine to answer "what did/will this bill cost on date X."
  amountEffectiveFrom?: string
  // Superseded amounts, each with the date IT started applying from —
  // mirrors Person.salaryHistory's snapshot pattern (see
  // salaryLedger.ts's findApplicableSnapshot) rather than inventing a new
  // shape: every past value is its own self-contained entry, and
  // resolving "what applied on date X" is the same kind of
  // latest-entry-not-after-X lookup either way.
  amountHistory?: { effectiveFrom: string; amount: number }[]

  // ── Recurring TRANSACTIONS (Expenses.tsx's "Recurring" pill) ──────────
  // A RecurringTemplate normally represents a bill (see file header).
  // `kind` generalises it to also cover a recurring ad-hoc expense/
  // income set up from the Transactions page — same schedule engine
  // (frequency/anchorDate/amountHistory all still apply), but it
  // generates plain 'expense'/'income' transactions instead of
  // 'bill_payment' ones, and is always location: 'personal' (no joint
  // concept for these). Absent/'bill' is the default, so every template
  // persisted before this field existed keeps behaving exactly as
  // before with no migration needed.
  // 'transfer' (2026-09-04 session) — a recurring Transfer, set up either
  // from the Transactions page's Transfer pill or from an entity's own
  // card on the Wallet page (Savings/Pots/Joint) — both write the exact
  // same RecurringTemplate, per Adam's explicit "single clean consistent
  // method to create them throughout" (2026-09-04). Generates 'transfer'
  // Transaction occurrences (see generateTransactionsForTemplate in
  // schedule.ts) instead of 'bill_payment' ones. Uses frequency/
  // anchorDate/occurrenceOverrides exactly like every other kind — the
  // existing PausedOccurrencesControl works unchanged. `location`/
  // `ownerId`/`payee`/`payeeSharePercent` are still populated (location:
  // 'personal', ownerId: primary person, payee: '', payeeSharePercent:
  // 100) purely so this template is picked up by the SAME `location ===
  // 'personal' && ownerId === personId` filter projection.ts/autoClear.ts
  // already use for every other kind — since the "current account" leg
  // of a transfer is always the primary person, this is never wrong for
  // a transfer template, unlike a bill/loan. The joint/pot side of
  // generation is a SEPARATE lookup (jointAccountLedger.ts/potLedger.ts
  // filter by transferFrom/transferTo directly, not by `location`) —
  // see those files' own comments.
  kind?: 'bill' | 'transaction' | 'transfer'
  // Required when kind === 'transfer' — the two endpoints this recurring
  // transfer moves money between. Same TransferLocation shape as
  // Transaction.fromLocation/toLocation above.
  transferFrom?: TransferLocation
  transferTo?: TransferLocation
  // When true, each occurrence's date is resolved against the primary
  // person's currently-active payday (see lib/payCycle.ts's payday
  // resolver) instead of walking frequency/anchorDate normally — ties in
  // with the salary sorter (App_Dev.md, next phase). `anchorDate` is
  // still required and used as the frequency's cadence reference even
  // when this is true (e.g. "every 4 weeks, but land on payday" still
  // needs an anchor to count 4-week intervals from) — only the RESOLVED
  // date of each occurrence is swapped for the matching payday.
  followsPayday?: boolean
  // Same idea, resolving against the primary person's budgeting-cycle
  // start instead of payday (Salary Sorter session, 2026-09) — see
  // Transaction.followsCycleStart's own comment for the full reasoning
  // and the followsPayday-wins-if-both-set tie-break.
  followsCycleStart?: boolean
  // Required when kind === 'transaction' — which ad-hoc type each
  // generated occurrence becomes. Mirrors AdHocInput's 'expense'|'income'
  // (LedgerContext.tsx) — direction 'out'/type 'expense' vs direction
  // 'in'/type 'income'.
  recurringTransactionType?: 'expense' | 'income'
  // Whose income this is, for a 'transaction'-kind template with
  // recurringTransactionType 'income' — mirrors addAdHocTransaction's
  // personId, set on every generated income occurrence the same way a
  // hand-logged one is. Not used for 'expense' (ownerId already carries
  // whose account it's against, same as an ad-hoc expense never setting
  // personId — see Transaction.personId's own comment above) or for
  // kind 'bill'.
  personId?: string
  // Per-occurrence edits/deletions for a 'transaction'-kind template,
  // keyed by the occurrence's ORIGINAL scheduled date (i.e. the date the
  // frequency/anchorDate would naturally produce, before any override) —
  // so a repeatedly-edited occurrence keeps resolving to the same slot
  // even after its displayed date has moved. Tapping one of the "next 12
  // upcoming" rows on the Transactions page (Expenses.tsx) writes an
  // entry here: an amount and/or date change that applies ONLY to that
  // single occurrence, overriding the template's frequency-derived
  // date/amount for that slot alone — the trash icon on that same row
  // instead writes `deleted: true`, removing it from the generated
  // schedule entirely. Distinct from amountEffectiveFrom/amountHistory
  // above, which still work exactly the same way on a 'transaction'
  // template too, for "change the STANDING amount, effective from a
  // chosen upcoming occurrence onward" (the same "which payment should
  // this apply from" flow Bills.tsx already has).
  occurrenceOverrides?: RecurringOccurrenceOverride[]
}

export interface RecurringOccurrenceOverride {
  originalDate: string // ISO date — the naturally-scheduled date this override replaces
  date?: string // overridden date; absent = originalDate unchanged
  amount?: number // overridden amount; absent = the template's normal resolved amount
  deleted?: boolean // true = this occurrence is skipped entirely — never generated, never shown
}

// One entry in RecurringTemplate.locationHistory / Loan.locationHistory —
// the prior location, and the date the CURRENT one took over from it.
// See RecurringTemplate.locationEffectiveFrom's comment for the full
// reasoning (Pots backlog item, 2026-09-03).
export interface LocationChange {
  effectiveFrom: string // ISO date
  location: BillLocation
  potId?: string // set only when location === 'pot'
}

// ── Loan — updated inputs, native overpayments ─────────────────────────
// Primary inputs flip to monthly amount + term, with total payable
// becoming a derived/display figure — closer to how a real loan agreement
// reads, and it stops the "no consideration for interest" schedule drift
// the doc's Section 3.2 calls out. Real overpayments are now recorded
// here and actually reduce the tracked balance; the What-if page's
// hypothetical "loan_overpayment" scenario action is unrelated to this —
// it never reads or writes here, see WhatIfScenario below.

export interface Loan {
  id: string
  name: string
  monthlyPayment: number
  // Historized effective-dating for the loan's own standing payment
  // amount (2026-09-09, unified effective-dating work) — mirrors
  // RecurringTemplate's amountEffectiveFrom/amountHistory exactly (same
  // field shapes, same resolution rule in ledgerLoans.ts's
  // resolveMonthlyPayment). buildLoanSchedule walks this per-period so a
  // change only reaches periods on/after `effectiveFrom`; anything
  // before keeps whatever payment was actually in effect at the time,
  // the same guarantee Bills already gives its own amount changes. Only
  // `monthlyPayment` gets this (not apr/termMonths — Adam's own call:
  // those describe what the loan always contractually was, not a new
  // arrangement starting from a chosen date).
  monthlyPaymentEffectiveFrom?: string
  monthlyPaymentHistory?: { effectiveFrom: string; amount: number }[]
  termMonths: number
  startDate: string // ISO date of first payment
  // Derived at render time from monthlyPayment × termMonths, adjusted for
  // recorded overpayments — not stored, but documented here since it's a
  // load-bearing display value (doc Section 3.2). Computed by lib code,
  // not part of the persisted shape.
  categoryId: string
  location: BillLocation
  ownerId: string
  payee: string
  payeeSharePercent: number
  // Same meaning, and same "generators read the live value, a location
  // change rewrites existing Transactions once rather than being
  // resolved per-occurrence" convention, as RecurringTemplate's fields of
  // the same name — see that type's own comment for the full reasoning.
  // Governs ONLY the loan's own regular monthlyPayment — a recurring
  // overpayment has its own, independent location choice (see
  // LoanRecurringOverpayment.location below); a one-off lump overpayment
  // is never pot-funded at all (Adam-specified, 2026-09-03).
  potId?: string
  locationEffectiveFrom?: string
  locationHistory?: LocationChange[]
  // 2026-09-16 — the first date this loan's regular payment generates, set when its schedule
  // is changed from a chosen payment (lib/scheduleChange.ts). Payments before
  // it are stored history and are never re-created on the new schedule, which
  // is what used to duplicate them. Absent = no change has ever been made.
  scheduleFrom?: string
  overpayments: LoanOverpayment[]
  // Optional standing/recurring overpayment on top of the normal monthly
  // payment — e.g. "an extra £100 every month" or "an extra 5% of
  // whatever's left, every month, until it's paid down." Distinct from
  // `overpayments` above, which are one-off, individually-logged extra
  // payments. Folded into the SAME monthly loan_payment transaction
  // amount when generated (not its own separate ledger line) — see
  // ledgerLoans.ts's buildLoanSchedule for how it compounds down for the
  // percent-of-balance case, same idea as a credit card's minimum
  // payment recalculating against the live balance every cycle.
  recurringOverpayment?: LoanRecurringOverpayment

  // ── Amortisation-engine fields (loan-amortisation-engine scope) ──────
  // `principal` is required, added during the amortisation-engine build:
  // `monthlyPayment × termMonths` was usable as a stand-in "balance" for
  // the old flat model (which had no concept of interest, so "total
  // you'll ever pay" and "what you actually borrowed" were the same
  // number by definition) but that stops being true the moment real
  // interest exists — a real loan's total repayable is always MORE than
  // its principal. The engine needs the true starting balance as its own
  // input, not a derived one. See migrateLedgerData in ledgerStorage.ts
  // for how a loan persisted before this field existed gets a one-time
  // best-effort backfill.
  principal: number
  // Everything below is optional/derived at the type level so a loan
  // still works with zero extra input beyond principal (scope §5.2's
  // back-solved baseline) — calibration only refines what's already a
  // strong estimate, it isn't required to make a loan usable.
  lender?: string // free text (scope §4) — labels a saved calibration profile so a future loan from the same lender can offer to reuse it. Not used for hard-coded formulas.
  apr?: number // percentage, e.g. 16.93 — matches CreditCard.interestRatePercent's convention. Purely a reference/pre-fill value: at creation, it suggests a starting monthlyPayment via the standard PMT formula, but the person's REAL contractual payment (freely overridable) is what everything downstream actually uses — back-solving the effective rate from Payment+Principal+Term (resolveLoanRateAndConvention) has consistently proven more accurate than trusting the displayed APR directly, since a displayed APR is routinely rounded and a lender's real internal rate can sit a hair either side of it (see the loan-amortisation-engine scope's Santander/Monzo reconciliation). Never read by the core engine for anything else — this is deliberate, not an oversight.
  advanceDate?: string // ISO — distinct from startDate/firstPaymentDate (scope §4): routinely 3-8 weeks earlier, and one known convention (Monzo) charges interest from this date, not the first payment date. Falls back to startDate when absent (baseline behaviour: no stub period).
  interestConventionId?: string // matches InterestConvention.id in lib/interestConventions.ts — which candidate fitted best, once calibrated. Falls back to the flat-monthly baseline convention when absent — see resolveLoanRateAndConvention in ledgerLoans.ts.
  calibratedMonthlyRate?: number // the fitted (or back-solved-from-payment, pre-calibration) monthly rate. Always a MONTHLY figure regardless of which convention uses it — see interestConventions.ts's file header for why.
  settlementMultiplier?: number // 'k' in settlement ≈ balance × (1 + k × monthlyRate) (scope §6). Defaults applied (k=2 if >12 months remain, else k=1) when absent — only stored once calibrated/overridden against a real settlement quote.
  statementCalibrationLines?: StatementCalibrationLine[] // raw entered calibration inputs, persisted so re-fitting always uses the whole accumulated set (scope §5.3), not just the newest line.
  active: boolean // mirrors CreditCard.active (scope §7) — false once "Settle this loan" has been used to log a real payoff.
  closedDate?: string // ISO date — set together with active: false, when the loan was actually settled. summarizeLoan uses this directly as payoffDate for a closed loan, rather than trusting whatever the mechanical schedule would otherwise predict.
  settledAmount?: number // the REAL amount actually paid to close the loan (scope §7) — may genuinely differ from the app's own settlement estimate (§6). The source of truth for the ledger itself is still the logged Transaction (sourceType: 'loan_settlement'); this is kept on the loan too purely so the Borrowing page can show "Settled for £X" without a separate lookup.
}

export interface StatementCalibrationLine {
  date: string // ISO date
  capital: number
  interest: number
}

export interface LoanRecurringOverpayment {
  startDate: string // ISO date — first month this applies from
  endDate?: string // ISO date, inclusive — last month it applies; unset = indefinite, until the loan itself is paid off. A genuine planned stop (e.g. "until this other debt is cleared"), NOT a pause mechanism — see pausedDates below for that.
  // Ad-hoc individual skips within the active window (Phase 4, 2026-09
  // session) — the same no-separate-resume-flow multi-select checklist
  // Bills/Pensions/SavingsPot recurring deposits already use, just a
  // plain date list here rather than the full RecurringOccurrenceOverride
  // shape: a recurring overpayment has no per-occurrence date/amount
  // override concept of its own to also carry (its amount is always
  // resolved fresh each period, percent-of-balance or fixed; its date is
  // always the loan's own payment date), so a skip-list is all that's
  // needed. Distinct from endDate: pausing one date doesn't mean the
  // arrangement is over, the very next scheduled date still applies.
  pausedDates?: string[]
  amount: { type: 'fixed'; amount: number } | { type: 'percent_of_balance'; percent: number }
  // Historized effective-dating for the recurring overpayment's own
  // standing amount (2026-09-09, unified effective-dating work) — same
  // amountEffectiveFrom/amountHistory shape as RecurringTemplate/Loan,
  // just carrying the whole tagged `amount` union per entry rather than a
  // plain number, since this field can be fixed or percent-of-balance.
  // Resolved per-period in ledgerLoans.ts's recurringOverpaymentForDate
  // via resolveRecurringOverpaymentAmount.
  amountEffectiveFrom?: string
  amountHistory?: { effectiveFrom: string; amount: LoanRecurringOverpayment['amount'] }[]
  // A true single-occurrence amount change ("just a single payment") —
  // unlike Loan.monthlyPayment, a recurring overpayment DOES get this
  // (Adam's own call): a small side-table entry keyed to one exact
  // payment date, leaving amount/amountHistory completely untouched.
  // Mirrors RecurringTemplate.occurrenceOverrides' shape, minus the
  // date-move/delete fields, which don't apply here.
  amountOverrides?: { date: string; amount: LoanRecurringOverpayment['amount'] }[]
  // Recast choice (loan-amortisation-engine scope §9, §11.3) — how the
  // schedule responds once this overpayment lands. 'reduce_term'
  // (default when absent, matching every recurring overpayment recorded
  // before this field existed): keep the payment the same, the loan
  // finishes sooner. 'reduce_payment': keep the same remaining period
  // count, recompute a smaller payment via standard PMT against the new
  // balance — for a RECURRING overpayment this means the effective
  // payment can genuinely change at every period it's applied, not just
  // once, since buildLoanSchedule.ts's own comment on this explains why
  // the schedule tracks a per-period payment rather than one fixed
  // figure once this combination is in play.
  recastMode?: 'reduce_term' | 'reduce_payment'
  // Which account funds this recurring overpayment — independent of the
  // loan's own `location` (Adam-specified, 2026-09-03: "if a loan is
  // tagged to a pot, that means ONLY the monthly payment is paid from the
  // pot, not necessarily recurring overpayments" — the reverse is equally
  // true, a personal-location loan can still take its recurring
  // overpayment from a pot). Never 'joint' — matches lump-sum
  // overpayments always being personal and pots never being joint.
  // Absent = follows the loan's OWN `location` — the only behaviour that
  // existed before this field (every already-persisted recurring
  // overpayment keeps generating exactly where it always did). Chosen via
  // its own location-picker-first step when the recurring overpayment is
  // created; editable afterward like any other field — a flat overwrite,
  // NOT effective-dated/historized the way RecurringTemplate/Loan's own
  // `location` is, since this describes a standing arrangement's setting
  // rather than a fact about a specific past payment. See
  // resolveOverpaymentLocation in ledgerLoans.ts for how this combines
  // with the loan's own location at generation time, and why a JOINT
  // loan's recurring overpayment deliberately ignores this field entirely
  // (always follows the loan) rather than risking the per-person joint
  // split math being applied to a pot-sourced, unsplit amount.
  location?: 'personal' | 'pot'
  potId?: string // set only when location === 'pot'
  // 2026-09-16 — the first date this recurring overpayment generates, set when its schedule
  // is changed from a chosen payment (lib/scheduleChange.ts). Payments before
  // it are stored history and are never re-created on the new schedule, which
  // is what used to duplicate them. Absent = no change has ever been made.
  scheduleFrom?: string
}

export interface LoanOverpayment {
  id: string
  date: string // ISO date
  amount: number
  note?: string
  // Same recast choice as LoanRecurringOverpayment.recastMode above, but
  // for a one-off overpayment — applies once, at this overpayment's own
  // date, recomputing the loan's effective payment from that point
  // onward (until a later recast changes it again, or the loan pays
  // off). Defaults to 'reduce_term' when absent (every overpayment
  // recorded before this field existed keeps its original behaviour
  // exactly — the fixed payment continuing, term shortening).
  recastMode?: 'reduce_term' | 'reduce_payment'
}

// ── Pay cycle configuration ─────────────────────────────────────────────
// Anchors the running balance. Payday and the budgeting-cycle boundary
// are stored as two separate, deliberately-decoupled rules (doc Section
// 3.3): the cycle boundary (e.g. 14th–13th) stays fixed even when the
// actual payday drifts a day or two earlier for a weekend/bank holiday.

export interface PayCycleConfig {
  // Per-person or household — TBD once we settle the multi-person split
  // for this; modelled per-person for now since salary is per-person.
  personId: string
  openingBalance: number
  openingBalanceDate: string // ISO date the opening balance was true as of
  // The nominal day of the month payday falls on.
  paydayDayOfMonth: number
  // If paydayDayOfMonth falls on a weekend or UK bank holiday, pay the
  // last working day on or before it. UK bank-holiday awareness needed —
  // flagging as a lib dependency (a bank-holiday calendar/lookup), not a
  // config field.
  paydayAdjustForNonWorkingDay: boolean
  // The budgeting cycle boundary — day of month the "month" starts on
  // for summary/projection purposes. Independent of paydayDayOfMonth.
  cycleStartDayOfMonth: number
  // OVERRIDE: when true, the cycle boundary stops being a fixed day of
  // the month and instead follows the RESOLVED payday — i.e. the same
  // weekend/bank-holiday adjustment paydayAdjustForNonWorkingDay applies
  // to payday is applied to the cycle boundary too, so a cycle always
  // begins on the day the money actually lands.
  //
  // This exists because setting cycleStartDayOfMonth to the same number
  // as paydayDayOfMonth does NOT achieve that: the two fields are
  // deliberately independent (see lib/payCycle.ts's header), so the
  // boundary stayed pinned to the nominal date while the real payday
  // drifted earlier — putting a payday in the wrong cycle every time the
  // nominal date fell on a weekend or bank holiday.
  //
  // Optional and defaults to FALSE, so every already-persisted config
  // keeps the fixed-day behaviour with no migration. When true,
  // cycleStartDayOfMonth is retained but unused (so unticking restores
  // the previous setting rather than losing it).
  cycleStartFollowsPayday?: boolean

  // ── Which income source this person's cycle boundary follows ─────────
  // Undefined = 'salary' — the only behaviour that existed before Pension
  // did, so nobody's already-saved config silently changes meaning.
  // Generation is NEVER gated by this: every active salary AND every
  // active Pension this person owns always generates its own transactions
  // and always shows in the ledger, regardless of what's picked here.
  // This ONLY decides two things: which source's cadence anchors the
  // budgeting-cycle boundary below, and which source's "next payday"
  // headlines the Home page hero card. Set via the calendar-icon picker
  // on the Wallet page (Wallet.tsx), one radio group per person with 2+
  // active income sources.
  followsIncomeSource?: { type: 'salary' } | { type: 'pension'; pensionId: string }
  // 2026-09-16 — the payday rules in force BEFORE each payday change, oldest
  // first. A payday change from a chosen payday (lib/scheduleChange.ts)
  // records the old rule: it governs paydays before `until` (the chosen
  // payday's old date), and the next rule governs paydays from
  // `nextRuleFrom` (that payday's new date). The two differ, and a new date
  // can even be earlier than the old one. Salary generation and the
  // paid-periods list then resolve each earlier month on the day it was
  // actually paid instead of re-creating it on the new day. Absent = the
  // payday has never been changed.
  paydayHistory?: { paydayDayOfMonth: number; paydayAdjustForNonWorkingDay: boolean; until: string; nextRuleFrom: string }[]

  // ── Salary Sorter (App_Dev.md "Salary Sorter & Transfer Pill", 2026-09
  // session) — which window "due this pay cycle" means when the sorter
  // suggests an amount for a pot/joint target: the literal
  // [payday, next payday) window ('payday'), or this person's actual
  // configured budgeting cycle via cycleBoundsForDate ('budget_cycle') —
  // these can genuinely differ since cycleStartDayOfMonth is independent
  // of paydayDayOfMonth (see this file's own header). Also the default
  // "follow" mode offered on a NEW recurring transfer's follows-payday/
  // follows-cycle-start choice (RecurringTemplate.followsPayday/
  // followsCycleStart) — a convenience default, not a constraint; either
  // can still be picked per-template regardless of this setting.
  // Undefined defaults to 'payday' (Adam's stated habit, 2026-09
  // session) so no migration is needed for an already-persisted config.
  // Edited from the same calendar-icon picker area on the Salary page
  // that already edits followsIncomeSource above — remembers the
  // person's last choice and reuses it for every future sort, per
  // Adam's explicit "give the option, remember it" spec.
  salarySortBasis?: 'payday' | 'budget_cycle'
}

// ── Pensions ──────────────────────────────────────────────────────────
// A second (and third, etc.) income type, genuinely concurrent with a
// salary and with each other — unlike salary, which is a SUCCESSION (one
// governing SalarySnapshot at a time, per person, per
// findApplicableSnapshot), a person can hold a State Pension AND a
// Private Pension AND a winding-down salary all at once. That's why
// Pension is its own top-level, explicitly-OWNED entity (personId, set
// once at creation via an owner-picker, exactly like Loan.ownerId) rather
// than nested under Person the way SalarySnapshot is — nesting would
// have meant either forcing a single succession model onto genuinely
// parallel income, or inventing a second, different nesting shape just
// for pensions. Matches the architecture Bills/Loans/Transactions already
// use, per the household-ownership discussion this design follows from.
//
// Deliberately simpler than SalarySnapshot: no tax engine, no
// deductions, no student loan — a pension's net amount IS the payment
// amount, "a manual net-pay figure" the same way SalaryOverride already
// works for a one-off salary adjustment, just as the standing figure
// here rather than an exception. Frequency is fully flexible (state
// pensions are typically weekly, private ones vary by provider) —
// deliberately NOT constrained to salary's monthly/four-weekly PayFrequency.
//
// The amountEffectiveFrom/amountHistory/occurrenceOverrides fields below
// are the exact same historized-change + per-occurrence-edit shape
// RecurringTemplate already uses (see that type's own comments) — reused
// rather than reinvented, since a pension's "change the standing amount,
// starting from a chosen future payment" and "edit just this one
// upcoming payment" needs are identical in kind, just against a simpler
// schedule engine (lib/pensionLedger.ts) tailored to Pension's smaller
// field set rather than forced through schedule.ts's RecurringTemplate-
// specific walker.
export interface Pension {
  id: string
  personId: string
  name: string // e.g. "State Pension", "Private Pension" — carried onto every generated transaction's note, same as RecurringTemplate.name
  amount: number // CURRENT net amount per payment — always what's shown/edited; see amountEffectiveFrom/amountHistory for how a scheduled change is recorded without disturbing this
  frequency: RecurrenceFrequency
  intervalWeeks?: number // only meaningful when frequency === 'every_n_weeks'
  anchorDate: string // ISO date — schedule anchor, same meaning as RecurringTemplate.anchorDate
  active: boolean // paused pensions stop generating new transactions, same as an inactive RecurringTemplate
  // 2026-09-16 — the first date this pension generates, set when its schedule
  // is changed from a chosen payment (lib/scheduleChange.ts). Payments before
  // it are stored history and are never re-created on the new schedule, which
  // is what used to duplicate them. Absent = no change has ever been made.
  scheduleFrom?: string
  // Same shape and meaning as PayCycleConfig's own fields of the same
  // name — but this pension's OWN copy, since once a person can follow
  // EITHER their salary OR a specific pension (see PayCycleConfig.
  // followsIncomeSource), each source needs to carry its own answer to
  // "does this source's payday shift off a weekend/bank holiday" and
  // "does the budgeting cycle boundary follow THIS source's payday."
  // Default false for both on a new pension (Adam's spec) — salary
  // defaults true/false respectively (defaultPayCycleConfig,
  // ledgerStorage.ts), a deliberate difference: salary's day-of-month
  // model made "adjust for weekend" an easy, near-universal default;
  // pensions are more varied (weekly state pension vs monthly private
  // one) so this starts opt-in instead.
  adjustForNonWorkingDay: boolean
  cycleStartFollowsPayday: boolean
  amountEffectiveFrom?: string
  amountHistory?: { effectiveFrom: string; amount: number }[]
  occurrenceOverrides?: RecurringOccurrenceOverride[]
}

// ── Credit cards ─────────────────────────────────────────────────────────
// Created/managed on the Borrowing page, alongside Loan. Personal only — no
// joint/split model (confirmed). The card's minimum/monthly payment is
// treated as a bill: it's a generator, same idea as RecurringTemplate/
// Loan, producing a `credit_card_payment` Transaction on paymentDayOfMonth
// each cycle. currentBalance is adjusted by two independent flows, which
// are kept deliberately separate from each other in the ledger:
//  - UP, when a `credit_card_spend` transaction is logged against this
//    card from the Transactions page. This does NOT touch the ledger's
//    running balance and does NOT show on the Personal card's list —
//    only on this card's own list, as a POSITIVE charge.
//  - DOWN, when a `credit_card_payment` transaction is generated (the
//    minimum/monthly payment) or a CreditCardLumpPayment is logged. This
//    IS real cash out — it reduces the ledger balance and shows as a
//    negative amount on the Personal card (matches how a real banking
//    app treats a card payment: an expense against your cash account).
//    On the card's OWN list it shows as a NEGATIVE charge.
//
// The card page's pie chart (total paid vs total outstanding) uses:
//  - outstanding = currentBalance (this already reflects spend, since
//    spend increases it directly — so card spend does feed into the
//    chart, just as "more borrowed", without ever touching the cash
//    ledger or any other expense/category report in the app).
//  - paid = the running sum of all credit_card_payment amounts logged
//    against this card to date.
//
// minimumPayment.percentOfBalance is NOT cached as a fixed £ amount — it
// must be recalculated at generation time against currentBalance for that
// cycle, since a fixed percentage of a shrinking balance shrinks in turn
// (5% of next month's lower balance < 5% of this month's). This is lib
// logic, not part of the persisted shape.

export interface CreditCard {
  id: string
  name: string
  categoryId: string // for icon; colour below overrides the category's colour
  color: string // hex — drawn from SHARED_CARD_COLORS, not the personal/joint/household palette
  interestRatePercent: number // APR — genuinely used now: compounds monthly against the balance each billing cycle. See lib/creditCards.ts's monthlyInterestRate for the conversion, and its file header for what's deliberately NOT modelled (daily accrual, purchase grace periods).
  // The STATED balance as at balanceAsOfDate — an anchor, not a live
  // figure. It is never adjusted by the app: spend and payments are not
  // written back into it, and what the card actually owes right now is
  // DERIVED by replaying card activity forward from the anchor date
  // (cardBalanceAsOf in lib/creditCards.ts).
  //
  // This pairing deliberately mirrors PayCycleConfig's openingBalance /
  // openingBalanceDate, and exists for the same reason. currentBalance
  // used to be mutated in place every time a payment cleared, which made
  // it impossible to tell which transactions were already baked into it
  // — so every write path had to hand-reverse its own balance effect,
  // and any code holding a stale copy of the card could silently undo a
  // payment by saving it back. That is exactly what happened: logging a
  // payment from the Borrowing page reduced the balance, then pressing
  // Save on the (still-open, still-stale) edit panel restored the old
  // figure, while the payment transaction remained — so the pie chart
  // showed the amount paid going up but the outstanding amount never
  // coming down. Deriving removes the whole class of bug rather than
  // patching that one path.
  currentBalance: number
  balanceAsOfDate: string // ISO date the currentBalance figure above was true as at. Card activity dated BEFORE this is ignored (already reflected in the figure); activity on or after it is applied on top.

  minimumPayment: CreditCardMinimumPayment
  paymentDayOfMonth: number // like Bill.dueDay — when the minimum/fixed payment is generated
  // Statement window (item e) — a day-of-month pair marking when a
  // billing cycle opens/closes, e.g. 19th–18th. Optional and independent
  // of each other: EITHER being absent means this card stays on the
  // pre-item-e behaviour (every real credit_card_spend transaction dated
  // on/before a payment date counts toward that payment's minimum,
  // exactly as before) — no migration/backfill needed for existing
  // cards. Once both are set, generateMinimumPaymentTransactions instead
  // computes each due date's minimum off the balance as it stood at that
  // window's OWN close (statementEndDay), not the live balance at the
  // payment date — a purchase posted after the window closes rolls into
  // the NEXT window's minimum instead, even though it still shows in the
  // card's live balance immediately. Lump/extra payments are NOT
  // window-gated (confirmed against real UK card practice) — they always
  // reduce what's owed straight away, regardless of which window they
  // land in.
  statementStartDay?: number // 1-31, informational — the window's own maths only needs statementEndDay
  statementEndDay?: number // 1-31 — the day a statement closes and its balance is tallied
  ownerId: string // no joint/payee split
  // 2026-09-16 (Adam-reported) — where the card's MINIMUM PAYMENT is paid
  // from: Personal (absent, every card before this) or one of the owner's
  // Pots. Same "extension of location" as Loan.location, and same one-time
  // rewrite of stored minimum payments from the chosen payment
  // (LedgerContext.assignCreditCardLocation). Only the minimum payment moves;
  // logged/lump payments and Clear stay Personal, the way a loan's
  // overpayments keep their own funding source. No 'joint'.
  location?: 'personal' | 'pot'
  potId?: string // set only when location === 'pot'
  locationEffectiveFrom?: string
  locationHistory?: LocationChange[]
  // 2026-09-16 — the first date this card's minimum payment generates, set when its schedule
  // is changed from a chosen payment (lib/scheduleChange.ts). Payments before
  // it are stored history and are never re-created on the new schedule, which
  // is what used to duplicate them. Absent = no change has ever been made.
  scheduleFrom?: string
  lumpPayments: CreditCardLumpPayment[]
  active: boolean
  // Per-date overrides for the generated minimum charge — set via the
  // credit card ledger modal's "tap a row to adjust" (mirrors the loan
  // ledger modal, but this one's rows are editable). Only used for a date
  // that hasn't been materialized into a real stored Transaction yet; a
  // date that already has one gets edited directly on that transaction
  // instead (see LedgerContext's updateCreditCardMinimumCharge) — an
  // override existing here for an already-materialized date would be
  // silently ignored by generateMinimumPaymentTransactions, since a
  // materialized date is never re-generated in the first place.
  minimumPaymentOverrides?: { date: string; amount: number }[]
}

export type CreditCardMinimumPayment =
  | { type: 'fixed'; amount: number }
  | { type: 'percent_of_balance'; percent: number } // e.g. 5 = 5% of currentBalance, recalculated each cycle

export interface CreditCardLumpPayment {
  id: string
  date: string // ISO date
  amount: number
  note?: string
}

// A palette distinct from the coral/ice/dark-blue used for the Personal/
// Joint/Household summary cards (index.css: --color-coral, --color-joint,
// implicit dark-blue household surface) — those three are reserved and
// never drawn from here. Shared (2026-09-11) by every OTHER "card" kind
// on the Home page's wallet stack — credit cards, savings pots, and pots
// — assigned round-robin on creation from ONE combined count across all
// three (see pickNextSharedCardColor in lib/creditCards.ts), same pattern
// as Category auto-colour, so no two of them ever repeat a colour as far
// as this palette's own size allows. Was CREDIT_CARD_COLORS (6 entries,
// credit-card-only) before that — renamed and expanded to 10 when pots/
// savings pots joined the pool, per Adam's own request ("the bills pot
// card is the same colour as my personal card").
export const SHARED_CARD_COLORS = [
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#f59e0b', // amber
  '#ec4899', // pink
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#6366f1', // indigo
  '#10b981', // emerald
  '#d946ef', // fuchsia
  '#eab308', // yellow
] as const

// ── Salary snapshots + overrides ────────────────────────────────────────
// Person.salary becomes a dated history rather than one fixed figure
// (doc Section 3.4). A "salary change" is either:
//  - permanent: a new SalarySnapshot, effective from a date, affecting
//    current + upcoming periods only (never retroactive).
//  - one-off: a SalaryOverride against a single pay period, e.g. a bonus
//    month — doesn't touch the standing snapshot at all. Per Mum's
//    confirmation this is the common case in practice, so it needs to be
//    the quick path, not a buried edge case.
// Phase 1 scope note (doc Section 3.4): only a manual net-pay override is
// supported for a given period — no automatic tax-code-change modelling
// yet, that's an explicitly separate future conversation.

export interface SalarySnapshot {
  id: string
  personId: string
  effectiveFrom: string // ISO date — this snapshot applies from here until superseded
  grossAnnual: number
  taxCode: string
  studentLoanPlan: StudentLoanPlan
  payFrequency: PayFrequency
  deductions: SalaryDeduction[]
  employerPensionPercent?: number
  // ISO date of the final salary payment this snapshot generates — set
  // from the date-picker at the bottom of the Salary card (Wallet page).
  // undefined/absent = generates indefinitely (the default, and the only
  // behaviour that existed before this field). Only meaningful on
  // whichever snapshot findApplicableSnapshot actually resolves to for a
  // given date — see salaryLedger.ts's own comment on how this interacts
  // with a later snapshot superseding it. Deliberately NOT retroactive:
  // this only stops FUTURE generation (generateSalaryTransactions), it
  // never touches an already-materialized Transaction row, so anything
  // already cleared (today or earlier) is unaffected by setting or
  // changing this.
  endDate?: string
  // The order this snapshot was RECORDED in, increasing per person. This
  // is the tie-break when two snapshots share an effectiveFrom: the
  // highest recordedSeq wins, i.e. the edit made most recently.
  //
  // The guarantee is that a newly recorded snapshot's ordinal is greater
  // than every ordinal currently held by that person's other snapshots —
  // NOT that a number is never reused across the person's whole history.
  // Deleting the most recent snapshot does free its number again, which
  // is harmless: ordinals are only ever compared within the live array.
  // See nextRecordedSeq in salaryLedger.ts.
  //
  // It exists because that tie-break used to be the snapshot's ARRAY
  // POSITION, and array position cannot survive a relational migration.
  // `salaryHistory` becomes a real `salary_snapshots` table (it is the
  // one order-dependent history array that does — the other five stay
  // jsonb, which preserves order), and `SELECT * FROM salary_snapshots
  // WHERE person_id = ?` has no inherent row order. Whatever order the
  // local SQLite happened to return would become the tie-break, and two
  // devices holding identical rows could legitimately resolve DIFFERENT
  // salaries — a wrong net-pay figure with nothing indicating a fault.
  //
  // This is not hypothetical: Adam's own person in
  // finance-ledger-backup-2026-09-15.json already has two snapshots both
  // dated 2026-09-30 (£62,500 and £62,400). See
  // DATA-MODEL-REVIEW-2026-09-15.md §11.7a and PROMPT-02.
  //
  // Required, backfilled by migrateLedgerData in array order for anything
  // persisted before this field existed — the same convention as
  // Loan.active/Loan.principal and SavingsPot.color. Backfilling in array
  // order is what makes it behaviour-preserving: it writes down the order
  // that was already being used, rather than changing it. findApplicableSnapshot
  // still falls back to array index if it ever sees a snapshot without
  // one, since runtime data can always violate the type.
  //
  // ⚠️ This ADDS information; it does not reorder or de-duplicate
  // anything. Duplicate effectiveFrom entries are deliberate and stay —
  // see §11.7b, decided 2026-09-15, and do not revisit it.
  recordedSeq: number
}

export interface SalaryOverride {
  id: string
  personId: string
  payPeriodDate: string // ISO date of the specific pay period this applies to
  // Manual net-pay figure for that one period — bypasses the tax engine
  // entirely for this period, per doc Section 3.4's "user can manually
  // override net pay" caveat.
  netPayOverride: number
  reason?: string // e.g. "April bonus"
  // Set only when this override was produced by "Attach a bonus to a pay"
  // (the GROSS bonus figure the person typed in) rather than a plain manual
  // net-pay override. netPayOverride in that case = the snapshot's ordinary
  // computed net pay for this period + the bonus's taxed net value — kept
  // around purely so the bonus can be edited/removed later without the
  // person having to re-derive what the "extra" amount even was. A plain
  // manual override (typed directly into "override net pay") never sets
  // this field.
  bonusGrossAmount?: number
}

export interface Person {
  id: string
  name: string
  color: string
  salaryHistory: SalarySnapshot[] // sorted by effectiveFrom; current = latest snapshot on/before "today"
  salaryOverrides: SalaryOverride[]
}

// ── Savings pots (backlog item a — "cards, not salary attachments") ────
// Top-level, personId-owned entity — architecturally identical to
// Pension: not nested under Person, freely reassignable after creation,
// its own occurrence-walker file (lib/savingsPotLedger.ts) mirroring
// pensionLedger.ts's structure. Two ways a pot comes into being (Adam's
// spec): "new" (opens at £0, openingDate defaults to today) or "existing"
// (opening balance + date the person actually types in) — either way,
// anything dated before openingDate is completely ignored by every
// calculation in this file's companion lib, not just hidden in the UI.
export interface SavingsPot {
  id: string
  personId: string
  name: string
  openingBalance: number
  openingDate: string // ISO date — see file header; nothing before this date is ever considered
  active: boolean
  // Drawn from SHARED_CARD_COLORS, assigned round-robin on creation
  // (pickNextSharedCardColor, lib/creditCards.ts) across the combined
  // count of credit cards/pots/savings pots — same "required, backfilled
  // by migrateLedgerData for anything persisted before this field
  // existed" pattern as Loan.active/Loan.principal (see ledgerStorage.ts).
  color: string

  // ── Interest ───────────────────────────────────────────────────────
  // Current method — always what's shown/edited. amountEffectiveFrom/
  // History below mirror Pension.amountHistory's exact shape/reasoning
  // (banks change rates; this needs the same "when do these changes take
  // effect from?" historized pattern as everywhere else in the app, not
  // a silent overwrite) — same field NAMES as Pension's amount fields
  // would collide in meaning here, so these are named for what they are.
  interestMethod: SavingsInterestMethod
  interestEffectiveFrom?: string
  interestHistory?: { effectiveFrom: string; method: SavingsInterestMethod }[]
  // Manual overrides for a GENERATED interest payment only — deposits/
  // withdrawals are never editable this way (Adam's spec: the pot's
  // info-icon ledger modal only allows tapping an interest row). Keyed
  // by the interest payment's natural crediting date, same
  // "originalDate as the stable slot key" idea as RecurringOccurrenceOverride,
  // just without a date-move option since a crediting date is a
  // structural/calendar concept, not something a bank lets you shift.
  interestOverrides?: { date: string; amount: number }[]
  // 2026-09-14 (Adam-reported) — where a GENERATED interest payment
  // actually lands. Undefined means "the same savings pot" (self) — the
  // sensible default (interest compounding into the account that earned
  // it), and deliberately NOT stored as an explicit `{type:'savings',
  // savingsPotId: this pot's own id}` so a brand-new pot (no id assigned
  // yet at the point this is first chosen, in the picker-first creation
  // flow) can still mean "self" before it has one. Reuses TransferLocation
  // rather than inventing a new type — the exact same "personal / joint /
  // a pot / a savings pot" vocabulary the Transfer pill already offers.
  // Before this field existed, generated interest was unconditionally
  // `location: 'personal'` AND carried this pot's own `savingsPotId` at
  // once — real double-counted money (it inflated BOTH the pot's own
  // balance and the owner's personal cash balance simultaneously), not
  // just a duplicated row. See savingsPotLedger.ts's
  // resolveInterestDestinationFields.
  interestDestination?: TransferLocation

  // ── Recurring deposits (step 4) ──────────────────────────────────────
  // SUPERSEDED (2026-09-04 session, Transfer pill) — a recurring deposit
  // into a SavingsPot is now a RecurringTemplate with kind: 'transfer'
  // (transferTo: {type:'savings', savingsPotId}), created from either
  // this pot's own Wallet-page card or the Transactions page's Transfer
  // pill — both write the same entity ("single clean consistent method
  // to create them throughout", Adam-specified 2026-09-04). These three
  // fields are kept ONLY so an already-persisted backup carrying a
  // pre-2026-09-04 recurring deposit still type-checks/loads and its
  // schedule keeps resolving — savingsPotLedger.ts's generator reads
  // them as a fallback for a pot that still has one set; nothing in the
  // app writes to them any more. Deliberately monthly-only (not the full
  // RecurrenceFrequency Pension gets) per Adam's original spec wording
  // ("Add monthly recurring deposits into the pot").
  recurringDepositAmount?: number
  recurringDepositDayOfMonth?: number // 1–31, clamped to the shorter month same as Pension's clampToAnchorDay
  recurringDepositStartDate?: string // ISO date of the first occurrence
  // Pause — REDESIGNED again 2026-09-02 per Adam's explicit correction to
  // the previous from/until WINDOW design: "resume deposits does not
  // care what pause dates were selected... let the user select multiple
  // [and] remove the resume flow entirely." There's no separate
  // pause/resume concept any more — just a flat set of individual
  // deposit dates marked skipped, exactly the SAME mechanism
  // recurringDepositOverrides already has for any other occurrence
  // (`deleted: true`, see RecurringOccurrenceOverride above) — pausing
  // and un-pausing a date is just adding/removing its deleted-override
  // entry, both through the one multi-select checklist
  // (lib/savingsPotLedger.ts's setPausedDeposits). On "will this list
  // build up over time" (Adam's own flagged concern): bounded by the
  // same reasoning recurringDepositOverrides already carries below —
  // rare in practice, one entry per genuinely-paused date, not one per
  // month that ever existed.
  recurringDepositOverrides?: RecurringOccurrenceOverride[]

  // ── Goals — two INDEPENDENT optional triggers, per Adam's spec ───────
  // targetAmount alone → the pie chart on the pot's summary card
  // (current + everything pending vs target, projected completion date).
  // targetDate alone → a plain info-only label ("save £X per
  // [salary frequency] to hit this by [date]") — computed off the
  // pot-owner's currently-active SalarySnapshot.payFrequency, nothing
  // else. Neither implies the other; a pot can have one, both, or
  // neither. Setting both does NOT make targetDate drive the pie chart —
  // the pie chart's own projected-completion-date is always computed
  // from current pace, never overridden by an explicit targetDate.
  targetAmount?: number
  targetDate?: string

  // ── Category icon (2026-09-14, "Group by category" fix) ─────────────
  // A SavingsPot's own deposit/withdrawal/interest transactions group
  // under THIS pot's own name in the "Group by category" view (see
  // Home.tsx's groupingCategoryId/CategoryGroupedList), never folded
  // into the shared built-in "Savings" category any more. Optional —
  // unset falls back to one shared generic icon, same "pick one later"
  // convention as Pot.color's own backfill story. Same {icon, iconColor}
  // shape as Category's own fields (see CategoryIconPickerModal), chosen
  // via the exact same picker, opened from this pot's own edit form.
  categoryIcon?: string
  categoryIconColor?: string
}

// ── Pots (App Dev.md "Pots" backlog item, Adam-specified 2026-09-03) ───
// A Pot is somewhere money moves OUT of the current account to pay
// specific personal bills/loans from — e.g. "Bills", funded by a
// standing transfer, that then pays rent/utilities/loan payments
// directly rather than those coming out of the current account. Same
// top-level, personId-owned architecture as Pension/SavingsPot (not
// nested under Person) — and structurally closest to SavingsPot
// (openingBalance/openingDate, active, the same monthly-only recurring-
// deposit + flat-pause-list shape) — but a genuinely SEPARATE entity,
// not a SavingsPot with extra fields bolted on: a Pot has no interest and
// no goals (those are meaningless for a bills pot), and — the real
// difference — RecurringTemplate/Loan rows reference a Pot's id via
// their own `location`/`potId` fields to say "this bill is paid from
// here," a concept SavingsPot has no equivalent of. Bolting bill/loan
// membership onto SavingsPot would force every SavingsPot consumer to
// reason about a field meaningless to it; kept separate instead, mirrors
// how Pension stayed separate from SalarySnapshot despite being "another
// kind of income."
//
// Bill/loan membership is DERIVED, not stored here — see
// lib/potLedger.ts's potBillsAndLoans (filters recurringTemplates/loans
// where potId === this pot's id), same "derive from the owning side"
// principle CreditCard's own transaction list already follows.
//
// Pots are only ever linked to a single person — never joint (Adam's own
// spec, confirmed 2026-09-03) — so unlike RecurringTemplate/Loan there's
// no payee/payeeSharePercent split concept here at all.
export interface Pot {
  id: string
  personId: string
  name: string
  openingBalance: number
  openingDate: string // ISO date — nothing before this date is ever considered, same rule as SavingsPot.openingDate
  active: boolean
  // Same SHARED_CARD_COLORS/pickNextSharedCardColor/backfill convention as
  // SavingsPot.color above.
  color: string

  // ── Recurring deposits — SUPERSEDED, same reasoning as SavingsPot's
  // fields of the same name (see that type's own comment) — a Pot never
  // shipped a live UI against these fields (Phase 4 was still-to-build),
  // so they're kept purely for the type union's/backup-loading's sake,
  // never populated by anything in the app. A recurring deposit into a
  // Pot is a RecurringTemplate with kind: 'transfer' (transferTo:
  // {type:'pot', potId}).
  recurringDepositAmount?: number
  recurringDepositDayOfMonth?: number // 1–31, clamped to the shorter month
  recurringDepositStartDate?: string // ISO date of the first occurrence
  recurringDepositOverrides?: RecurringOccurrenceOverride[]

  // ── Category icon (2026-09-14) — same field/reasoning as
  // SavingsPot.categoryIcon above; a Pot's own deposit/withdrawal
  // transactions group under this pot's own name, not the shared
  // "Savings" category.
  categoryIcon?: string
  categoryIconColor?: string
}

// ── Salary Sort (App_Dev.md "Salary Sorter & Transfer Pill", 2026-09
// session) — a batch of transfers moving money OUT of the primary
// person's current account, on ONE specific payday, into whichever
// pots/savings pots/joint account they choose. Deliberately NOT a
// generator/template the way RecurringTemplate is — "each salary sort is
// specific to the salary, does not persist for future pay periods"
// (Adam's own spec) — a new SalarySort is a fresh, empty choice every
// payday, even though the sorter's OWN suggestion logic (lib/
// salarySortLedger.ts) deliberately looks at the previous one's chosen
// amounts to prefill the next.
//
// Each target's `transactionId` points at a REAL Transaction (created via
// the same buildTransferTransaction/logTransfer path as any other
// transfer, sourceType: 'salary_sort', sourceId: this SalarySort's id) —
// not a synthetic/generated row. This is what makes "I can edit them
// here [Transactions page] and they will update in the salary sort, and
// vice versa" possible: it's the exact same transaction on both screens,
// not two representations that need reconciling.
//
// Two-way edit sync, exactly as specified (2026-09 session):
//  - Editing the AMOUNT of a linked transaction (Transactions page) also
//    patches this target's own `amount` — LedgerContext.updateTransaction.
//  - Editing the DATE of a linked transaction DETACHES it — the
//    transaction keeps existing as an ordinary transfer, but loses its
//    sourceType/sourceId and its target is dropped from `targets` here
//    (a transfer no longer dated to this payday isn't part of "this
//    payday's sort" any more) — LedgerContext.updateTransaction.
//  - Deleting a linked transaction (Transactions page) drops just that
//    one target, leaving the others intact — LedgerContext.
//    removeTransaction. If that empties `targets` entirely, the whole
//    SalarySort record is removed too (an empty sort isn't a sort — see
//    the sort icon's own "coral when configured" rule on the Salary
//    page, which reads `data.salarySorts` directly).
//  - Editing the sort itself (the Salary page's sort icon/modal) is a
//    single upsert — LedgerContext.saveSalarySort — which diffs the
//    incoming target list against what's already saved and creates/
//    updates/removes transactions accordingly. A target whose amount
//    lands on/is edited down to 0 is treated as "don't create/keep this
//    transfer" (Adam's explicit "0 is null, not a real transfer" call),
//    same as pressing that location's own Clear button.
export interface SalarySortTarget {
  id: string
  to: TransferLocation
  amount: number
  transactionId: string
}

export interface SalarySort {
  id: string
  payDate: string // ISO date — the specific payday occurrence this sort is for
  targets: SalarySortTarget[]
}

// ── Savings interest methods ────────────────────────────────────────
// Two built for now (2026-09 session) — see savingsInterest.ts for the
// actual math and SUPABASE-MIGRATION-PLAN.md's item a addendum for the
// full menu that was considered. A third, genuinely different shape —
// fixed-term/bond-style (rate locked for a term, no further deposits,
// interest paid annually or at maturity) — is DELIBERATELY NOT built
// yet, flagged as near-term future work once ISA/bond-style products are
// actually tracked (they need a term/maturity-date field and a "deposits
// disallowed after opening" constraint neither of these two methods
// has) — see the migration doc rather than guessing that shape now.
export type SavingsInterestMethod =
  | {
      type: 'aer_credited'
      // Annual Equivalent Rate, as a percentage (e.g. 4.5, not 0.045) —
      // matches every other rate field in this app (CreditCard.
      // interestRatePercent, Loan's APR inputs).
      aer: number
      // How often the bank actually credits (and compounds) interest.
      // Interest accrues against the balance AS AT the start of each
      // period — see savingsInterest.ts's own comment for why this is
      // deliberately simpler than method 2 below, and what that
      // simplification gets wrong for a pot with mid-period activity.
      creditingFrequency: 'monthly' | 'quarterly' | 'annual'
    }
  | {
      type: 'daily_accrual_monthly_credited'
      // Same AER meaning as above, but accrued daily against the ACTUAL
      // daily balance (replaying every deposit/withdrawal), only
      // actually credited into the balance — and starting to compound —
      // once a month. The realistic "everyday easy-access account"
      // convention; needs the pot's full transaction history to compute
      // correctly, not just the opening balance.
      aer: number
    }

// ── What-if scenarios — decoupled from the ledger, NOW NEEDS A CHANGE ──
// The What-if page stays a pure hypothetical planning layer: it reads
// default/current data to run its calculations but never writes to
// Transaction, RecurringTemplate, Loan, or CreditCard. That part is
// unchanged. What DOES need to change: 'pay_off_loan', 'loan_overpayment',
// 'exclude_loan', and the sell_asset/pay_off_loan `loanAllocations` array
// are all currently loan-only (linkedLoanId, loanId). You asked to be
// able to target a credit card with these same actions, which means
// generalising the target from "loan" to "debt" — e.g. renaming
// linkedLoanId → linkedDebtId with a companion linkedDebtType: 'loan' |
// 'credit_card', and the same for loanAllocations' `loanId` field. Not
// applied yet — this is a real change to the existing Scenario shape in
// models.ts (not just an addition), so flagging it as its own decision
// rather than silently redefining it here.
export type WhatIfScenario = Scenario

// ── Summary page view state ─────────────────────────────────────────────
// Not persisted app data — this is the shape of the Summary page's local
// UI state, included here because the doc spells out specific toggle
// behaviour that the data layer needs to support (Section 4.1, Running
// Balance Engine row):
//  - grouping: list vs category, same as today's Bills page
//  - order: 'date' (ascending, next due first, cleared items collapsed
//    below) vs 'amount' — running balance column only shows when
//    grouping='list' AND order='date'
//  - horizon: 'current_month' vs 'next_3_months' (current + 2 ahead,
//    using default/recurring salary and bills to fill the unresolved
//    future) — affects everything on the page EXCEPT the pie charts,
//    which always reflect actuals regardless of this toggle.
// None of grouping/order/horizon apply when a credit-card deck card is
// active — see SummaryCardKind below.

export interface SummaryViewState {
  grouping: 'list' | 'category'
  order: 'date' | 'amount'
  horizon: 'current_month' | 'next_3_months'
}

// ── Summary page swipeable deck ─────────────────────────────────────────
// The deck is no longer a fixed 3 cards. Card presence is derived, not
// stored (doc addendum):
//  - 'personal'   — always present, one per... actually one per viewer,
//                   see note below.
//  - 'joint'      — present only if people.length >= 2 AND at least one
//                   joint-location RecurringTemplate, Loan, or CreditCard
//                   exists. (Reading "bill" broadly here — flag if you
//                   meant literal Bills only.)
//  - 'household'  — present only if people.length >= 2.
//  - 'credit_card'          — one per active CreditCard, always present
//                               per card regardless of salary count.
//  - 'credit_cards_combined' — present only if there is more than one
//                               active CreditCard; pages between them,
//                               separate from the individual cards above.
// Individual and combined credit-card cards suppress the grouping/order
// controls entirely and show a single pie chart (total paid vs total
// outstanding) below the payment list, instead of the category/list
// breakdown the other card kinds show.

export type SummaryCardKind = 'personal' | 'joint' | 'household' | 'credit_card' | 'credit_cards_combined'

export interface SummaryDeckCard {
  kind: SummaryCardKind
  // Only set when kind === 'credit_card' — which card this entry is for.
  creditCardId?: string
}

// ── Joint account (Adam-specified, 2026-09-03) ──────────────────────────
// A real account, with its own reconciled opening balance — NOT derived
// from anything, same idea as CreditCard's currentBalance/balanceAsOfDate
// anchor pairing, or PayCycleConfig's openingBalance/openingBalanceDate.
// Null until the household's first joint-location RecurringTemplate/Loan
// is created — see lib/jointAccountLedger.ts's needsJointAccountSetup for
// the non-optional setup flow that fills this in at that moment, and
// AppGuards.tsx for where it's enforced. Editable afterward from the
// Wallet page's own Joint Account section once it exists.
export interface JointAccountConfig {
  openingBalance: number
  openingBalanceDate: string // ISO date
}

// ── Root data object ─────────────────────────────────────────────────────

export interface AppDataV2 {
  people: Person[]
  categories: Category[]
  recurringTemplates: RecurringTemplate[]
  loans: Loan[]
  creditCards: CreditCard[]
  pensions: Pension[]
  savingsPots: SavingsPot[]
  pots: Pot[]
  transactions: Transaction[]
  payCycles: PayCycleConfig[] // one per person
  // Salary Sorter (2026-09 session) — one entry per payday that's
  // actually been sorted; a payday with no entry here simply hasn't been
  // sorted yet (the Salary page's sort icon reads this directly to
  // decide whether to render coral). See SalarySort's own comment.
  salarySorts: SalarySort[]
  scenarios: WhatIfScenario[]
  primaryPersonId: string
  // Null until the first joint-location bill/loan exists — see
  // JointAccountConfig's own comment above.
  jointAccount: JointAccountConfig | null
}

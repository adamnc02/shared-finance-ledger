# Data Model Review — `shared-finance-ledger`, 2026-09-15

**Supersedes** `Supabase Migration/DATA-MODEL-REVIEW.md` (2026-09-03). That review is now
materially out of date: the app gained four new persisted concepts (`Pot`, `SalarySort`,
transfers, effective-dated location changes) and `BillLocation` itself changed shape. Treat
this document as the current truth and the 2026-09-03 one as history.

**Revised 2026-09-15 (evening)** after analysing two real backup files — Adam's
(`finance-ledger-backup-2026-09-15.json`, 2 people, joint account, pots, transfers) and his mum's
(`finance-ledger-backup-2026-09-15-mum.json`, 70 transactions, 2 real credit cards, 2 loans with
calibration data). Findings in §11; several sections below were corrected as a result.

> ## ✅ AS BUILT — PROMPT-08, 2026-09-19. Where the real schema differs from this review, the schema wins
> Migrations `20260919200000`–`20260919200400` in `silver-octo-invention`. Full reference:
> `silver-octo-invention/docs/shared-finance-ledger-SUPABASE.md`. The shapes were read from the live
> `src/types/ledger.ts` at `main` `15e0369`, not from this review.
> - **25 app tables, not 26** (§4's own list names 25; "26 + 3 = 29" was an arithmetic slip). **28 in
>   total.** No table is missing.
> - **Build order ≠ §8.** `pots` and `savings_pots` come before `recurring_templates`/`loans`/
>   `credit_cards`, which reference them.
> - **Ids for app items that have none:**
>   - `pay_cycles.id = person_id`;
>   - `joint_account.id = household_id::text`;
>   - the override tables use `'<parent_id>:<date>'` / `'<parent_id>:<original_date>'`;
>   - calibration lines use `'<loan_id>:<date>:<n>'`, because two can share a date.
>
>   The app keeps one entry per date, so two devices converge on one row.
> - **Category ids are `'<app id>@<household_id>'`** (Adam, option B). The app has **35** fixed
>   category ids (4 built-in + 31 `category-seed-*`), not 4. The sync layer adds/strips the suffix.
>   `ensure_household()` seeds all 35 server-side.
> - **Foreign keys (§5 / Q5 refined).** PowerSync discards any write an FK rejects, so FKs exist only
>   where the app never dangles:
>   - `category_id` has **no FK** (custom categories are deleted without reassignment);
>   - **no `transactions` reference is an FK** (cleared history keeps deleted ids by design, so Q5
>     item 2's "SET NULL" became "no FK": history keeps the id exactly as the offline app does);
>   - children CASCADE with their parent;
>   - entity → person/pot/savings-pot references are plain FKs, because the app blocks those deletes;
>   - `salary_sort_targets.transaction_id` and `pay_cycles.follows_pension_id` are `SET NULL`.
> - `household_members.user_id` is `ON DELETE CASCADE`, the one exception to "SET NULL"; it deletes
>   no data. UNIQUE(user_id): one household per user.
> - **§9 is fully resolved (recorded 2026-09-23, PROMPT-12 Part 5).** §9.1 `LegacyDataMigration`
>   shipped with PROMPT-10 in the same release as the store switch; §9.2 `setData()` clears and remaps
>   every table (`verify-import-regenerates-ids.ts` walks every id at any depth); §9.3 the schema is
>   exposed and was smoke-tested by a real `.rpc()` (PROMPT-09); §9.4 Google OAuth was verified end to
>   end on the live URL (ADAM-TASKS 5d). **§9.5 — the Salary Sort's two-way sync:** designed and built
>   in PROMPT-11. A sort's person is **derived from the owner of its transfers**, not stored (there is no
>   `person_id` column on `salary_sorts`, so nothing can drift); ids are `sort:<personId>:<payDate>`,
>   with targets `…:<destination>` and transfers `…:tx`, so two devices sorting the same payday converge
>   on one record. `verify-salary-sort-sync.ts` carries the controls (£600 moved instead of £300).
> - `salary_deductions.sort_order` added (the list's display order). `loans.color`,
>   `credit_cards.statement_start_day/_end_day` present (newer than this review).
> - **Merge-aware redeem** (Adam, 2026-09-19): the joiner's linked person and everything attached to
>   it moves. Joint items and the joint account stay behind, and a now-empty old household is
>   deleted. A same-named guess is reported, not merged. It refuses if the joiner hasn't done "Set as me".
> - **PROMPT-09 additions (2026-09-19):**
>   - `position double precision` on the 24 array-backed tables (`20260919230000`): the app's array order, kept without
>     renumbering;
>   - salary deduction row ids are `'<snapshot>:<deduction>'`, because real data repeats a deduction id across snapshots;
>   - jsonb is uploaded as JSON values (MIGRATION-LESSONS §33).
> - **Import regenerates ids** (Adam, 2026-09-19), keeping only the fixed category ids. PROMPT-10's
>   `setData()` remap must cover every id reference, including `sourceId`, `transactionId`, scenario
>   `linkedTargetId`/`targets[].id`/`linkedLoanId`/`loanAllocations[].loanId`, and the derived child ids.

**Method:** read directly from `personal-ledger`'s live code at commit `3b0f1d8` —
`src/types/ledger.ts` (1460 lines), `src/types/models.ts`, `src/lib/ledgerStorage.ts`,
`src/context/LedgerContext.tsx`. Not inferred from a backup JSON, not carried over from the
previous review. `finance-ledger-test`'s `src/` is byte-identical to `personal-ledger`'s as of
this date, so there is no divergence to reconcile before copying.

**Scope note — two type files, one of them still doesn't matter for migration.**
`src/types/models.ts` and `src/types/ledger.ts` both define a `Loan`, a `Scenario`, etc.
Only **`ledger.ts`'s `AppDataV2` is the real, persisted app state**. `models.ts`'s shapes are a
derived, non-persisted bridge (`legacyBridge.ts`) rebuilt from real `AppDataV2` on every render.
Two exceptions, both genuinely persisted, whose *types* just live in the other file:
`Scenario` (at `AppDataV2.scenarios`) and `BillLocation` (used on `RecurringTemplate`/`Loan`).

**Persistence today:** one key, `localStorage['ledger:app-data-v2:v1']`, holding one
`AppDataV2` JSON blob. That is the *only* localStorage key the app uses — verified by grep.
`loadLedgerData()` runs every read through `migrateLedgerData()`, which backfills fields
introduced by later sessions. Both matter for the legacy-data-migration prerequisite (§9).

---

## 1. Root object — what changed since 2026-09-03

```
AppDataV2
├── people:             Person[]
├── categories:         Category[]
├── recurringTemplates: RecurringTemplate[]
├── loans:              Loan[]
├── creditCards:        CreditCard[]
├── pensions:           Pension[]
├── savingsPots:        SavingsPot[]
├── pots:               Pot[]                ← NEW
├── transactions:       Transaction[]
├── payCycles:          PayCycleConfig[]      — one per person
├── salarySorts:        SalarySort[]         ← NEW
├── scenarios:          WhatIfScenario[]
├── primaryPersonId:    string                — LOCAL ONLY, never syncs
└── jointAccount:       JointAccountConfig | null
```

**New since the last review, and each one has real migration consequences:**

| Change | Consequence |
|---|---|
| `Pot` + `pots[]` — a second, simpler pot type alongside `SavingsPot` (no interest, no targets, single-person-only) | Its own table. Its id space is deliberately separate from `SavingsPot`'s; do not merge them. |
| `SalarySort` + `salarySorts[]` — one record per payday that's been "sorted" into pots/joint | Own table + child target table. Each target holds a **real** `transactionId` back-reference into `transactions` — a genuine FK, unlike `sourceId`. |
| `BillLocation` widened to `'personal' \| 'joint' \| 'pot'` | Every `location` column gains a third legal value; `potId` becomes a required companion when `location === 'pot'`. |
| `TransactionLocation = BillLocation \| 'savings'` — `Transaction.location` only | `transactions.location` has a **wider** check constraint than `recurring_templates.location`/`loans.location`. Don't share one enum across all three. |
| `TransferLocation` value object (`{type, savingsPotId?, potId?}`) on transactions and transfer templates | Flatten to 2–3 columns per endpoint (`from_location_type`, `from_savings_pot_id`, `from_pot_id`, and the same for `to_`). Not a child table, not jsonb. |
| Effective-dated `locationHistory`/`locationEffectiveFrom` on `RecurringTemplate` AND `Loan` | A third historized array on each. |
| `Loan.monthlyPaymentHistory`/`monthlyPaymentEffectiveFrom` | Loans now historize payment amount the same way templates historize `amount`. |
| `LoanRecurringOverpayment` grew `pausedDates[]`, `amountHistory[]`, `amountOverrides[]`, `location`/`potId` | This is no longer a flat "single nested object → flatten onto the loan row". It now has three arrays of its own. See §4. |
| `RecurringTemplate.kind` gained `'transfer'`, plus `transferFrom`/`transferTo`/`followsPayday`/`followsCycleStart` | A recurring template can now be a transfer generator, not just a bill or a transaction. |
| `SavingsPot` gained `color`, `interestDestination` (a `TransferLocation`), `categoryIcon`, `categoryIconColor` | More columns, one of them another flattened `TransferLocation`. |
| `PayCycleConfig.salarySortBasis` | One more column. |
| `Scenario` gained `ScenarioTargetKind = 'loan' \| 'credit_card'` | No schema impact — scenarios stay `jsonb` (§7). |
| Eight new `TransactionType` values and two new `sourceType` values | Wider check constraints; see §3. |

---

## 2. Person-linkage patterns — now FIVE shapes, not four

| Shape | Meaning | Used by |
|---|---|---|
| **`ownerId`** | Personal item, belongs to one person's own account | `RecurringTemplate`, `Loan`, `Transaction` (`location: 'personal'`) |
| **`personId`** | Same idea, named for an inherently person-scoped entity | `Pension`, `SavingsPot`, `Pot`, `SalarySnapshot`, `SalaryOverride`, `PayCycleConfig`, `Transaction.personId` (income rows) |
| **`payee` + `payeeSharePercent`** | Joint item split between household members | `RecurringTemplate`/`Loan`/`Transaction` when `location: 'joint'` |
| **`potId`** *(new)* | The item is funded from / lives in a specific `Pot`, which is itself person-owned — an INDIRECT person link | `RecurringTemplate`, `Loan`, `Transaction`, `LoanRecurringOverpayment`, `LocationChange` when `location === 'pot'` |
| **No person at all** | Household-level | `Category`, `JointAccountConfig`, `CreditCard` (personal-only, see below) |

Two things worth pinning down before writing any RLS:

1. **`location`/`ownerId`/`payee`/`payeeSharePercent`/`potId` is ONE consistent five-field group**
   repeated on `RecurringTemplate`, `Loan`, and `Transaction`. Good news for migration — design
   the column group once, use it three times. `Transaction` additionally widens `location` to
   allow `'savings'`.
2. **`CreditCard` is still personal-only** — `ownerId` and nothing else. No `location`, no
   `payee`, no `potId`. Don't build those columns here; they'd be dead forever.
3. **`Pot` is deliberately single-person-only, never joint** (Adam's own spec, 2026-09-03) — so
   `pots` has `person_id` and no split columns at all, unlike everything else.

---

## 3. Entity-by-entity — current shape

### Person
`id, name, color, salaryHistory[], salaryOverrides[], savingsEntries[]`

Root of the household. `salaryHistory`/`salaryOverrides` become their own tables (§4).

**`savingsEntries` — REMOVED from the code 2026-09-17 (all apps; see §11.4).** It was dead weight, superseded by `SavingsPot`, kept only so an already-
persisted legacy goal round-trips. **Recommendation unchanged and now stronger: do NOT create a
`savings_entries` table.** Either drop it at cutover or migrate any surviving rows into
`SavingsPot` once, and never carry the old shape into Postgres. (See Q6 in `OPEN-QUESTIONS.md`.)

**New for this app:** `people` needs `linked_user_id uuid` from the very first migration —
tied to `auth.uid()`, trigger-enforced to self-claim only. This is the stable cross-device
anchor for "which row structurally IS me", and the thing merge-on-redeem depends on. Building it
as a follow-up cost `personal-f` a whole extra migration; don't repeat that.
(`MIGRATION-LESSONS.md` §5.)

### Category
`id, name, icon, iconColor, isBuiltIn?`

**Household-level, no person link.** Four reserved built-in ids seeded at init
(`category-credit-card`, `category-income`, `category-bills`, `category-savings`). Note
`migrateLedgerData()` re-adds any missing built-in by id on every load and never touches an
existing one — the same guarantee needs to hold once categories come from PowerSync, or a
household whose categories arrive mid-sync could briefly look uncategorised.

### RecurringTemplate (replaces the old "Bill")
```
id, name, amount, categoryId, paymentMethod, frequency, intervalWeeks?, anchorDate
location, ownerId, payee, payeeSharePercent, potId?          — five-field group (§2)
locationEffectiveFrom?, locationHistory[]                    — HISTORIZED (new)
amountEffectiveFrom?, amountHistory[]                        — HISTORIZED
occurrenceOverrides[]                                        — HISTORIZED
active
kind?: 'bill' | 'transaction' | 'transfer'                   — 'transfer' is new
transferFrom?, transferTo?: TransferLocation                 — only when kind === 'transfer'
followsPayday?, followsCycleStart?                           — mutually exclusive
recurringTransactionType?: 'expense' | 'income', personId?   — only when kind === 'transaction'
```
**Person link:** `ownerId` / `payee` / `potId`. When `kind === 'transaction'` it *also* carries
an independent `personId` (whose income this is) — a genuinely different column from `ownerId`,
don't conflate them. Three historized child arrays now, not two.

### Loan
```
id, name, monthlyPayment, termMonths, startDate, principal, categoryId
monthlyPaymentEffectiveFrom?, monthlyPaymentHistory[]        — HISTORIZED (new)
location, ownerId, payee, payeeSharePercent, potId?
locationEffectiveFrom?, locationHistory[]                    — HISTORIZED (new)
overpayments[]                                               — HISTORIZED
recurringOverpayment?: LoanRecurringOverpayment              — now has arrays of its own (§4)
statementCalibrationLines[]                                  — HISTORIZED
lender?, apr?, advanceDate?, interestConventionId?, calibratedMonthlyRate?, settlementMultiplier?
active, closedDate?, settledAmount?
```
Still the most field-heavy entity. The six optional amortisation fields are **genuinely
optional — their absence is meaningful** (it selects different maths). Do not give them
`NOT NULL` + a default.

### LoanRecurringOverpayment — reclassified
```
startDate, endDate?, pausedDates[], location?, potId?
amount: {type:'fixed', amount} | {type:'percent_of_balance', percent}
amountEffectiveFrom?, amountHistory[]
amountOverrides[]
recastMode?
```
The 2026-09-03 review said "flatten onto the loan row". **That is no longer right** — it now has
three arrays of its own. See §4 for the recommendation.

### CreditCard
```
id, name, categoryId, color, interestRatePercent
currentBalance, balanceAsOfDate                  — anchor pair, not a live figure
minimumPayment: {type:'fixed'|'percent_of_balance', ...}   — single object, flatten
paymentDayOfMonth, statementStartDay?, statementEndDay?
ownerId                                          — PERSONAL ONLY
lumpPayments[]                                   — HISTORIZED
minimumPaymentOverrides[]                        — HISTORIZED
active
```

### Pension
```
id, personId, name, amount, frequency, intervalWeeks?, anchorDate, active
adjustForNonWorkingDay, cycleStartFollowsPayday
amountEffectiveFrom?, amountHistory[]            — HISTORIZED
occurrenceOverrides[]                            — HISTORIZED
```
Architecturally the same shape as `SavingsPot`/`Pot` — top-level, `personId`-owned. Write the
migration pattern once, reuse.

### SavingsPot
```
id, personId, name, openingBalance, openingDate, active, color
interestMethod: SavingsInterestMethod            — discriminated union, flatten
interestEffectiveFrom?, interestHistory[]        — HISTORIZED
interestOverrides[]                              — HISTORIZED
interestDestination?: TransferLocation           — flatten to 3 columns (new)
recurringDepositAmount?, recurringDepositDayOfMonth?, recurringDepositStartDate?
recurringDepositOverrides[]                      — HISTORIZED
targetAmount?, targetDate?
categoryIcon?, categoryIconColor?                — new
```
`SavingsInterestMethod` is a two-arm union: `{type:'aer_credited', aer, creditingFrequency}` and
`{type:'daily_accrual_monthly_credited', aer}`. Flatten to
`interest_type / interest_aer / interest_crediting_frequency` (the last nullable) — not jsonb,
so a future third arm (fixed-term/bond, explicitly deferred) is an additive column change.

### Pot (NEW)
```
id, personId, name, openingBalance, openingDate, active, color
recurringDeposit* / recurringDepositOverrides[]  — SUPERSEDED, never populated
categoryIcon?, categoryIconColor?
```
Bill/loan membership is **derived**, not stored (`potLedger.ts` filters
`recurringTemplates`/`loans` by `potId`), so there's no join table to build. Its
`recurringDeposit*` fields never shipped a UI — a recurring deposit into a Pot is a
`RecurringTemplate` with `kind:'transfer'`. **Recommendation: do not create columns for them**
(same call as `savingsEntries`), unless a real backup turns out to contain values — confirm.

### Transaction
```
id, date, amount, direction, categoryId, paymentMethod, status, type, note?
location (WIDER: + 'savings'), ownerId, payee?, payeeSharePercent?, potId?
personId?                                        — required for salary/bonus/income/pension
sourceType?, sourceId?                           — polymorphic back-link to generator
creditCardId?                                    — required for card types
savingsPotId?                                    — required for savings_* types
fromLocation?, toLocation?: TransferLocation     — required when type === 'transfer' (new)
followsPayday?, followsCycleStart?               — display flags (new)
```
Largest table by row count, unbounded growth, and the target every other entity's
`sourceType`/`sourceId` points into.

**`type` (17 values, up from 9):** `bill_payment`, `loan_payment`, `expense`, `income`, `bonus`,
`salary`, `pension_income`, `credit_card_spend`, `credit_card_payment`, `savings_contribution`
*(dead — legacy only)*, `savings_deposit`, `savings_withdrawal`, `savings_interest`,
`joint_deposit`, `joint_withdrawal`, `pot_deposit`, `pot_withdrawal`, `transfer`.

**`sourceType` (11 values):** `recurring_template`, `loan`, `loan_overpayment`,
`loan_recurring_overpayment`, `loan_settlement`, `credit_card_lump_payment`, `savings_entry`
*(dead — legacy only)*, `pension`, `savings_pot`, `pot` *(new)*, `salary_sort` *(new)*.

`sourceId` stays polymorphic — no single FK can express it. Enforce at the app layer or via a
trigger, not a constraint. **One exception worth knowing:** `sourceType: 'salary_sort'` is NOT a
"generated, caller dedupes" link like the others — the transaction is a real, independently
editable row, and `SalarySortTarget.transactionId` points back at it. That pair is a genuine
two-way link and the only place in the model where a FK could actually be declared.

### PayCycleConfig
```
personId (exactly one row per person), openingBalance, openingBalanceDate
paydayDayOfMonth, paydayAdjustForNonWorkingDay
cycleStartDayOfMonth, cycleStartFollowsPayday?
followsIncomeSource?: {type:'salary'} | {type:'pension', pensionId}
salarySortBasis?: 'payday' | 'budget_cycle'      — new
paySchedule?: {kind: 'four_weekly' | 'four_weekly_fiscal', anchorPayDate}   — 2026-09-19, PROMPT-08c
```
**2026-09-19 (PROMPT-08c):** `paySchedule` is how 4-weekly pay DATES repeat; absent = monthly on
`paydayDayOfMonth`. Flatten to `pay_schedule_kind text NULL CHECK (kind IN ('four_weekly','four_weekly_fiscal'))`
+ `pay_schedule_anchor date NULL`, both NULL or both set. `salary_snapshots.pay_frequency` gains a third
value, `'four_weekly_fiscal'` (a CHECK constraint must allow it). `payday_history` entries may now carry
a `paySchedule` too.
Nothing in the app layer stops two rows existing per person other than `updatePayCycle`'s
upsert convention — **add a real `UNIQUE(person_id)`**. `followsIncomeSource` flattens to
`follows_income_source_type` + `follows_pension_id` (a real FK), not jsonb.

### SalarySnapshot / SalaryOverride / SalaryDeduction
```
SalarySnapshot: id, personId, effectiveFrom, grossAnnual, taxCode, studentLoanPlan,
                payFrequency, deductions[], employerPensionPercent?, endDate?
SalaryOverride: id, personId, payPeriodDate, netPayOverride, reason?, bonusGrossAmount?
```
Currently nested on `Person`, but structurally already top-level, `personId`-owned, historized
tables. **Give all three their own tables from the start** — `salary_snapshots`,
`salary_overrides`, `salary_deductions` (child of `salary_snapshots`).

### SalarySort / SalarySortTarget (NEW)
```
SalarySort:       id, payDate, targets[]
SalarySortTarget: id, to: TransferLocation, amount, transactionId
```
One record per payday actually sorted. Two-way edit sync with `transactions` is already built
in `LedgerContext` (editing a linked transaction's amount patches the target; editing its date
detaches it; deleting it drops the target, and an emptied sort deletes itself). **All of that
logic has to survive the move to PowerSync** and is the single most sync-sensitive piece of the
app — see §8.

### JointAccountConfig
`openingBalance, openingBalanceDate`. Household-level singleton, `null` until first needed.
Simplest table in the app.

### Scenario (What-if)
`id, name, description?, includeInCumulative, actions[]` — nine action shapes in a discriminated
union, with `ScenarioTargetKind = 'loan' | 'credit_card'`. **Stays `jsonb`** — the prior
review's call is still correct; normalising would mean nine near-empty sparse tables.
Open decision: whether scenarios are household-shared or stay per-user (§7, and Q4).

---

## 4. Consolidated child-array inventory — and the normalise-vs-jsonb call

Every array below was a nested list on a parent object. There are now **16**, up from 14:

| Parent | Child array | Independently edited? |
|---|---|---|
| `RecurringTemplate` | `amountHistory` | No — written with the parent's amount change |
| `RecurringTemplate` | `locationHistory` *(new)* | No — written with the parent's location change |
| `RecurringTemplate` | `occurrenceOverrides` | **Yes** — "Manage upcoming payments" edits these alone |
| `Loan` | `monthlyPaymentHistory` *(new)* | No |
| `Loan` | `locationHistory` *(new)* | No |
| `Loan` | `overpayments` | **Yes** — logged as standalone records |
| `Loan` | `statementCalibrationLines` | **Yes** — accumulated across calibration sessions |
| `Loan.recurringOverpayment` | `pausedDates` *(new)* | **Yes** |
| `Loan.recurringOverpayment` | `amountHistory` *(new)* | No |
| `Loan.recurringOverpayment` | `amountOverrides` *(new)* | **Yes** |
| `CreditCard` | `lumpPayments` | **Yes** |
| `CreditCard` | `minimumPaymentOverrides` | **Yes** |
| `Pension` | `amountHistory` | No |
| `Pension` | `occurrenceOverrides` | **Yes** |
| `SavingsPot` | `interestHistory` | No |
| `SavingsPot` | `interestOverrides` | **Yes** |
| `SavingsPot` | `recurringDepositOverrides` | **Yes** |
| `Person` | `salaryHistory` | **Yes** |
| `Person` | `salaryOverrides` | **Yes** |
| `SalarySnapshot` | `deductions` | **Yes** |
| `SalarySort` | `targets` *(new)* | **Yes** |

`RecurringOccurrenceOverride` is still the SAME shape (`{originalDate, date?, amount?, deleted?}`)
reused by `RecurringTemplate`, `Pension` and `SavingsPot` — design one child-table shape, use it
three times.

**The decision this forced — RESOLVED, see §11.3 for the evidence:**

**DECIDED: hybrid, split on "is this array ever written on its own?"** — 26 app tables + 3
household tables. The dividing line is not size or importance, it is whether a user action exists
that writes the array **without also writing a scalar column on the parent row**. §11.3 explains
why that is the only line that matters.

**Own table** — a user can add/edit/remove one of these on its own, so two people can touch two
different children with nothing else changing:

| Table | Source array |
|---|---|
| `salary_snapshots` | `Person.salaryHistory` — **needs a `recorded_seq` ordinal column, see §11.7a** |
| `salary_deductions` | `SalarySnapshot.deductions` |
| `salary_overrides` | `Person.salaryOverrides` |
| `recurring_template_occurrence_overrides` | `RecurringTemplate.occurrenceOverrides` |
| `loan_overpayments` | `Loan.overpayments` |
| `loan_statement_calibration_lines` | `Loan.statementCalibrationLines` |
| `credit_card_lump_payments` | `CreditCard.lumpPayments` |
| `credit_card_minimum_payment_overrides` | `CreditCard.minimumPaymentOverrides` |
| `pension_occurrence_overrides` | `Pension.occurrenceOverrides` |
| `savings_pot_interest_overrides` | `SavingsPot.interestOverrides` |
| `savings_pot_recurring_deposit_overrides` | `SavingsPot.recurringDepositOverrides` |
| `salary_sort_targets` | `SalarySort.targets` |

**`jsonb` column on the parent** — written *only* by the effective-dated change flow, which always
sets a scalar on the same row in the same action, so a separate table would buy nothing:

`RecurringTemplate.amountHistory`, `RecurringTemplate.locationHistory`,
`Loan.monthlyPaymentHistory`, `Loan.locationHistory`, `SavingsPot.interestHistory`, and the whole
`Loan.recurringOverpayment` object including its `pausedDates` / `amountHistory` /
`amountOverrides` (all three are edited through the one recurring-overpayment editor, which
rewrites the object as a unit).

**Full table list — 25 app + 3 household = 28** *(corrected 2026-09-19; see AS BUILT at the top)*:

`households`, `household_members`, `household_link_codes`,
`people`, `categories`, `pay_cycles`, `salary_snapshots`, `salary_deductions`, `salary_overrides`,
`recurring_templates`, `recurring_template_occurrence_overrides`,
`loans`, `loan_overpayments`, `loan_statement_calibration_lines`,
`credit_cards`, `credit_card_lump_payments`, `credit_card_minimum_payment_overrides`,
`pensions`, `pension_occurrence_overrides`,
`savings_pots`, `savings_pot_interest_overrides`, `savings_pot_recurring_deposit_overrides`,
`pots`, `transactions`, `salary_sorts`, `salary_sort_targets`, `joint_account`, `scenarios`.

Against full normalisation (~38) this saves the 5 pure-history arrays — which are the fiddliest to
normalise (effective-dated, order-sensitive) and the ones with **zero** conflict benefit. It also
lets `EffectiveDatedChangeFlow.tsx` and `lib/locationChange.ts` keep working on the same in-memory
shape they use today.

**Single nested objects — flatten onto the parent row, still correct:**
`CreditCard.minimumPayment`, `SavingsPot.interestMethod` (current value only),
`PayCycleConfig.followsIncomeSource`, `SavingsPot.interestDestination`,
`Transaction.fromLocation`/`toLocation`, `SalarySortTarget.to`.
**No longer correct:** `Loan.recurringOverpayment` — see §3.

---

## 5. Orphan-reference / integrity risks — updated

The three gaps from 2026-09-03 are all still present in the code. Two new ones:

1. **`reconcilePersonReferences` (`lib/household.ts`) only reassigns
   `RecurringTemplate`/`Loan`/`CreditCard`'s `ownerId`/`payee`.** It still does NOT touch
   `Pension.personId`, `SavingsPot.personId`, or — new — `Pot.personId`. Removing a person
   leaves all three dangling with nothing cleaning up.
2. **Historical `Transaction` rows referencing a removed person are never reassigned.** Arguably
   correct (a transaction is a historical fact), but it means `transactions.owner_id`/`person_id`
   **cannot** be `ON DELETE CASCADE` or `RESTRICT` — `SET NULL` at minimum, or a soft-delete
   tombstone for `Person`.
3. **Deleting a generator doesn't clean up already-materialised `Transaction` rows** that point
   at it via `sourceType`/`sourceId`. Deliberate for cleared rows; a genuine orphan for a
   *pending* one.
4. **NEW — `potId` has no reconciliation at all.** Deleting a `Pot` leaves any
   `RecurringTemplate`/`Loan`/`Transaction` with `location: 'pot'` pointing at a dead
   `potId`, and `location: 'pot'` with no pot is not a state any of the ledger code expects.
   Worth checking `removePot`'s actual behaviour before writing the FK.
5. **NEW — `SalarySortTarget.transactionId` is the one place a real FK exists**, and the app's
   own two-way sync logic already handles detach/delete. A `ON DELETE CASCADE` here would be
   wrong (it would silently drop a target the app expects to handle explicitly); the app's
   existing behaviour should be preserved and the FK left as `RESTRICT` or omitted.

All five need a conscious `CASCADE`/`SET NULL`/`RESTRICT` decision — see Q5.

> ### ✅ Enforced in the app since 2026-09-16 (PROMPT-05, `personal-ledger` `e430c75`)
> The migration can declare these FKs with confidence. The app no longer creates the states they
> would reject.
> - **Items 1 and 4 → `RESTRICT`.** Deleting a Person, Pot or Savings Pot is blocked in the UI while
>   anything references it (`lib/deleteReassign.ts` `findDeleteBlockers`):
>   - **Person:** pensions, savings pots, pots, templates/loans by `ownerId`/`personId`, joint
>     splits by `payee` (and any split < 100%), cards, hand-logged pending transactions.
>   - **Pot:** templates/loans `potId`, loan recurring overpayment `potId`, transfer templates by
>     either endpoint, hand-logged pending rows by `potId` OR either endpoint, savings-pot
>     `interestDestination`.
>   - **Savings Pot:** the same by `savingsPotId`/endpoints.
>
>   Every reference is resolved by an explicit move or delete, applied with the delete in one update.
>   **Correction to this section's older text:** item 1 was already backstopped for
>   pensions/savings pots/pots by `reconcilePersonReferences` before this.
> - **Item 2 → `ON DELETE SET NULL`** for `transactions.owner_id`/`person_id`. Cleared rows keep the
>   deleted id, asserted byte-for-byte by `verify-delete-reassign.ts`.
> - **Item 3 unchanged:** pending rows are swept with their generator, cleared rows survive.
> - **Load-time backstop:** `reconcilePersonReferences` nulls/repairs anything older data or an
>   import still carries:
>   - a transfer template with a dead endpoint is switched off, with that end set to Personal;
>   - pending rows touching a missing pot are dropped;
>   - a dangling `interestDestination`, overpayment `potId` or `followsIncomeSource` is reset;
>   - Salary Sort targets whose transaction is gone are dropped.
>
>   Idempotent on both real backups.
> - **Transfer endpoints need their own FKs:** `from_location_pot_id`, `to_location_pot_id` and the
>   savings equivalents. The flat `pot_id` cannot identify a Pot→Pot transfer's second pot (§1.4 of
>   APP-KNOWLEDGE); this was one of the gaps.
>
> **New optional columns from the same session (all additive, all nullable):**
> - `recurring_templates.anchor_day_of_month`
> - `schedule_from` on `pensions`, `loans`, the loan recurring overpayment, and `credit_cards`
> - `pay_cycles.payday_history` (jsonb, ordered, `{paydayDayOfMonth, paydayAdjustForNonWorkingDay, paySchedule?, until, nextRuleFrom}` — `paySchedule` added 2026-09-19, PROMPT-08c)
>
> See APP-KNOWLEDGE §1.12.
>
> **2026-09-16 (Batch 20, live in both apps): a credit card's minimum payment can be paid from a Pot.**
> `credit_cards.location` (`'personal' | 'pot'`, NULL = personal), `credit_cards.pot_id` (FK `pots`,
> `RESTRICT` like loans), `credit_cards.location_effective_from`, `credit_cards.location_history`
> (jsonb, same shape as `loans.location_history`). Stored minimum-payment `transactions` rows then
> carry `location: 'pot'` + `pot_id`. Add `credit_cards` to the pot RLS/FK audit and to the pot
> delete-guard list. See APP-KNOWLEDGE §1.15.

---

## 6. Household scoping — the thing that's actually different about this app

`personal-ledger` is single-user. `shared-finance-ledger` is a two-person household. Every table
needs a `household_id uuid not null` alongside its `user_id uuid` (kept for attribution — "who
logged this" — not for access control), and RLS moves from `auth.uid() = user_id` to household
membership.

**Non-negotiables, carried straight from `MIGRATION-LESSONS.md`:**

- `households` / `household_members` / `household_link_codes`, with **permanent, reusable** link
  codes (not the original 15-minute single-use design), plus `regenerate_household_link_code()`
  as the deliberate "this leaked" action. (§17, and the superseded-flow note in
  `SUPABASE-MIGRATION-PLAN.md`.)
- `ensure_household()` as its own idempotent function, called by the app on first write — never
  as a side effect of generating a link code. (§17.)
- `people.linked_user_id`, trigger-enforced to self-claim only, in the **first** migration. (§5.)
- Every group-membership RLS check goes through a `SECURITY DEFINER` + **`language plpgsql`**
  helper (`my_household_ids()`). A `language sql` helper gets inlined and the infinite recursion
  comes straight back, while looking correct on read. (§21.)
- **Audit every table with a FK into `people`** for RLS completeness, not just the obvious three.
  Last time `salary_deductions`/`savings_entries` were missed and would have silently hidden a
  partner's pension deductions. This app has far more such tables. (§3.)
- Child tables keyed off `person_id`/`loan_id`/etc. rather than `household_id` directly need
  their Sync Stream query to join *through* the parent — and the **source** table in a synced
  query must never be aliased, or the rows land in a differently-named local SQLite table with
  no error. (§7.)

**What's shared vs. what stays personal** is a real product decision, not a technical one — see
Q3 and Q4.

**`primaryPersonId` never syncs.** It's per-device "which person am I looking at" state and was
never a column. But the auto-default effect that picks it **must actively re-prefer the
linked-to-me row on every `people` update**, not just check the current value is still valid —
otherwise a transient partial-sync window locks it onto the wrong person permanently. This is a
confirmed, already-experienced bug in `personal-f`. (§23.)

---

## 7. What's shared, what's personal, what never syncs

| Data | Proposal | Confidence |
|---|---|---|
| `people`, `categories`, `recurring_templates`, `loans`, `credit_cards`, `pensions`, `transactions`, `joint_account` | **Household-shared** | High — this is the product |
| `pay_cycles`, `salary_snapshots`, `salary_overrides`, `salary_deductions` | **Household-shared** — the combined-income view depends on seeing a partner's salary | High, but confirm (Q3) |
| `savings_pots`, `pots`, `salary_sorts` | **Household-shared** — they're person-owned but visible household-wide, same as bills | Medium — confirm (Q3) |
| `scenarios` | **Per-user, not shared** (matches `personal-f`'s call: a what-if is a private sandbox) | Medium — confirm (Q4) |
| `primaryPersonId` | **Never syncs.** Per-device local state | High |
| `SummaryViewState` / `SummaryDeckCard` | **Never syncs** — not in `AppDataV2`, not persisted at all today | High |

---

## 8. Migration order

> *2026-09-19: built in FK order instead: `pots`/`savings_pots` before templates, loans and cards. See AS BUILT at the top.*

1. `households`, `household_members`, `household_link_codes` + `ensure_household()` +
   `my_household_ids()` + link-code functions.
2. `people` (with `linked_user_id` + its self-claim trigger), `categories`, `pay_cycles`.
3. `salary_snapshots`, `salary_overrides`, `salary_deductions`.
4. `recurring_templates` (+ any child tables kept out of jsonb).
5. `loans`, `loan_overpayments`, `loan_statement_calibration_lines`.
6. `credit_cards`, `credit_card_lump_payments`.
7. `pensions`.
8. `savings_pots`, `pots`.
9. `joint_account`.
10. `transactions` — depends on everything above.
11. `salary_sorts`, `salary_sort_targets` — **last**, because targets reference `transactions`.
12. `scenarios` (jsonb).

Then, and only then: `powersync_role` grants, `ALTER PUBLICATION powersync ADD TABLE ...`, and
an **additive** second `streams:` block in the existing Sync Streams config.

---

## 9. Hard prerequisites before any of this reaches a real user

> ✅ **All five done — see the AS BUILT box at the top (2026-09-23).** Kept as written for the record.

These aren't polish items. Each one is a known, already-experienced failure.

1. **`LegacyDataMigration` (`MIGRATION-LESSONS.md` §24) — built and deployed in the SAME session
   that adds auth.** The moment `LedgerContext` sources from PowerSync instead of
   `localStorage`, anyone's pre-existing `ledger:app-data-v2:v1` data becomes invisible with no
   error. Port `personal-f`'s `src/components/LegacyDataMigration.tsx` directly: check the synced
   household is genuinely empty → check the old key → if non-trivial, show a blocking
   import-or-start-fresh prompt → feed the import through `setData()` → clear the old key either
   way. `parseLedgerBackupJson`/`migrateLedgerData` in `ledgerStorage.ts` already do the parsing
   and backfilling half of this.
2. **`setData()` must clear AND remap every table.** `personal-f`'s version had two real bugs
   found only by restoring the same backup twice: it remapped `ownerId` but not `payee`, and it
   deleted people/scenarios but never bills/loans (so a second restore duplicated everything).
   This app has far more tables and far more id-referencing fields — `ownerId`, `payee`,
   `personId`, `potId`, `savingsPotId`, `creditCardId`, `categoryId`, `sourceId`,
   `transactionId`, and `pensionId` inside `followsIncomeSource`. Audit every one. (§22.)
3. **Verify the schema is actually in Settings → Data API → Exposed schemas**, by making a real
   client `.rpc()` call early and deliberately as its own smoke test. PowerSync replication is
   a completely separate path and gives zero signal about this. (§20.)
4. **Verify Google OAuth end-to-end for this app's own URL** — three independent settings, three
   different failure points, and the Redirect-URLs one fails *silently* by redirecting to a
   different app entirely. (§2.)
5. **`SalarySort`'s two-way transaction sync** is the most sync-fragile feature in the app. Its
   detach-on-date-edit and delete-empties-the-sort logic currently runs inside a single
   synchronous `setDataState` over one blob. Under PowerSync it becomes two rows in two tables
   mutated across a network boundary, potentially from two devices. This needs its own design
   pass, not a mechanical port.

---

## 10. Decisions — resolved

All ten questions from `OPEN-QUESTIONS.md` were answered on 2026-09-15. See
`DECISIONS-2026-09-15.md` for each decision and its reasoning. The two that changed this document
are Q2 (§4, table split) and Q5 (§5, `RESTRICT` + reassign flow).

---

## 11. Findings from the two real backup files (2026-09-15)

Analysed: `finance-ledger-backup-2026-09-15.json` (Adam — 2 people, 17 templates, 1 loan,
1 credit card, 1 pot, 1 savings pot, 23 transactions, joint account, 3 scenarios) and
`finance-ledger-backup-2026-09-15-mum.json` (mum — 1 person, 29 templates, 2 loans with real
calibration data, 2 real credit cards, 70 transactions).

### 11.1 Empty strings are used where NULL is meant — this WILL break foreign keys

This is the single most important finding, and it is invisible until the first insert fails.

| Field | Adam's backup | Mum's backup |
|---|---|---|
| `recurringTemplates.ownerId === ''` | 9 rows | 0 |
| `recurringTemplates.payee === ''` | 7 rows | 29 rows |
| `loans.payee === ''` | 1 row | 2 rows |
| `transactions.ownerId === ''` | 2 rows | 0 |
| `transactions.payee === ''` | 3 rows | 30 rows |

Every joint bill carries `ownerId: ''`; every personal item carries `payee: ''`. A column declared
`owner_id text references people(id)` rejects `''` with a 23503 foreign-key violation — which
PowerSync's connector treats as a **fatal, non-retryable** error and silently discards
(`FATAL_RESPONSE_CODES` includes `/^23...$/`). The write would vanish with a console line and
nothing else.

**Required, in `mapping.ts`, both directions:**
- Writing to Postgres: `'' → NULL` for `owner_id`, `payee`, `person_id`, `pot_id`,
  `savings_pot_id`, `credit_card_id`, and any other id-shaped column.
- Reading back: `NULL → ''` for `ownerId`/`payee` specifically, because app code compares them
  against `''` (e.g. `billsByLocation`, the split editor). Returning `undefined` where the app
  expects `''` would change behaviour silently.

Write a `verify-mapping-nulls.ts` script that round-trips both real backups through the mapping
layer and asserts the output is deep-equal to the input. This is cheap and catches the whole class.

### 11.2 Dangling `sourceId` already exists in live data

Three transactions across the two backups point at a `recurring_template` id that no longer
exists:

| Backup | Transaction | `sourceId` | Note |
|---|---|---|---|
| Adam | `4qm7pCAF` (2026-09-09) | `gk2yOo9p` | "Bills Top Up" |
| Mum | `MUyOsuRW` (2026-08-25) | `--TYnK1A` | "Apple.com" |
| Mum | `aIPM3y3J` (2026-08-26) | `--TYnK1A` | "Apple.com" |

Confirms two things: **`source_id` must never be a real foreign key** (already the plan), and the
§5.3 orphan question is a live condition in both real datasets, not a theoretical one. Note that
mum's two orphans are cleared historical rows — correct to keep. Adam's is also cleared. No
*pending* orphans exist today, so the cleanup rule can be written and tested against a
deliberately constructed case rather than real data.

Every other reference in both backups resolves cleanly — no dangling `ownerId`, `personId`,
`categoryId`, `creditCardId`, `potId` or `savingsPotId` anywhere.

### 11.3 Conflict granularity is per-COLUMN, not per-row — which is what settles §4

`personal-f`'s connector maps a PowerSync `PATCH` to
`supabase.from(table).update(op.opData).eq('id', op.id)`, and `op.opData` contains **only the
columns the local `UPDATE` actually set**. `writes.ts` deliberately builds narrow updates
(`UPDATE people SET name = ?`), so two devices editing two *different columns of the same row*
both survive — no conflict at all.

That reframes the whole normalise-vs-jsonb question:

- **Nothing fails to sync under the hybrid.** Every field reaches every device. jsonb columns sync
  as text and are parsed at the mapping boundary.
- The **only** loss case is two devices writing **the same jsonb column** before either syncs —
  then the later writer's whole array replaces the earlier one's, and an entry disappears with no
  error.
- Splitting a child array into its own table helps **only** when a user action writes that array
  *without* touching any scalar on the parent. If the action also sets a scalar, the parent row is
  in the write anyway and normalising the array buys nothing.

That is exactly the line drawn in §4: `occurrenceOverrides` and the override/log arrays get tables
(pausing a payment or logging an overpayment touches nothing else); `amountHistory`,
`locationHistory`, `monthlyPaymentHistory` and `interestHistory` stay jsonb (the effective-dated
change flow always writes `amount` + `amountEffectiveFrom` + the array together).

**Standing design rule this creates:** every mutation in `writes.ts` must issue a **narrow**
`UPDATE` that sets only the fields that actually changed. A convenience "write the whole row"
helper would silently destroy this property across every table at once. Worth a comment at the top
of `writes.ts` saying so.

### 11.4 `savingsEntries` is confirmed dead — drop it

`savingsEntries: []` on all three people across both backups. No transaction anywhere has
`type: 'savings_contribution'`, and no transaction has `sourceType: 'savings_entry'`.

**Decision: drop entirely.** No `savings_entries` table, no columns, and remove `SavingsEntry`,
the `'savings_contribution'` transaction type and the `'savings_entry'` sourceType from this app's
copy of `ledger.ts`, plus their read paths in `legacyBridge.ts`, `lib/savings.ts` and
`clearTransaction.ts`. **Update 2026-09-17: removed from all apps instead, not just this one**
(Adam: keep the codebase clean; no divergence). `migrateLedgerData` drops the key. See
`DECISIONS-2026-09-15.md` Q6.

### 11.5 `Pot.recurringDeposit*` is confirmed unused — drop it

Adam's only `Pot` has keys `active, categoryIcon, categoryIconColor, color, id, name,
openingBalance, openingDate, personId` — no `recurringDeposit*` field is present at all. His only
`SavingsPot` likewise has no `recurringDeposit*` fields, no `interestHistory` and no
`interestOverrides`.

**Decision: no `recurring_deposit_*` columns on `pots`.** Keep them on `savings_pots` (that type's
own comment does not mark them superseded, unlike `Pot`'s) but treat them as nullable and unused
until a real backup shows otherwise.

### 11.6 Which history arrays are actually used, and how much

| Array | Adam | Mum |
|---|---|---|
| `recurringTemplates.locationHistory` | 9 | 0 |
| `recurringTemplates.amountHistory` | 5 | 2 |
| `recurringTemplates.occurrenceOverrides` | 2 | 2 |
| `people.salaryHistory` | 4 | 1 |
| `salarySnapshot.deductions` | 6 | 3 |
| `loans.locationHistory` | 2 | 0 |
| `loans.overpayments` | 0 | 1 |
| `loans.statementCalibrationLines` | 0 | 3 |
| `creditCards.minimumPaymentOverrides` | 0 | 1 |
| `people.salaryOverrides` | 0 | 1 |
| `loans.recurringOverpayment` | 1 (no sub-arrays populated) | 0 |
| everything on `savingsPots` | 0 | n/a |
| `salarySorts`, `pensions` | 0 | n/a |

Every array is tiny. Nothing here argues for normalising on volume grounds — only on the
conflict-granularity grounds in §11.3.

### 11.7 Array ORDER is load-bearing semantics — and this corrects an earlier recommendation

My first read of the duplicate history entries called them a bug and recommended "de-duplicate on
`effectiveFrom` and keep the array sorted on write". **The sorting half of that is wrong and would
re-introduce a bug this app already fixed.** Adam flagged it; the code confirms it.

**What the resolvers actually do.** `schedule.ts`'s `resolveTemplateAmount` breaks ties between two
candidates sharing the same `effectiveFrom` by **array index — recency of recording, not date**:

```js
.map((c, index) => ({ ...c, index }))
.filter((c) => c.effectiveFrom <= dateIso)
.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.index - a.index)
```

Its own comment names the failure this prevents, as a confirmed real bug rather than a theoretical
one: without the index tiebreak, "whichever candidate happened to land first in the array — always
the STALE one, since the true current value is appended last — silently and permanently won every
date it was asked about, **making the edit the person just made never show up anywhere**."

That is the same-day-edit bug class: `applyTemplateAmountChange`'s "prior value" entry falls back to
`anchorDate` the first time a bill is edited, and the anchor date is routinely the exact date the
person picks in the apply-from picker. The collision is the single most common edit, not an edge
case. The 2026-09-09 session fixed the materialised-transaction half of it
(`reconcileRecurringTemplateTransactions` / `reconcileLoanTransactions` in `autoClear.ts`, resyncing
an already-cleared row to what the template now resolves); this index tiebreak is the resolver half.

**Six resolvers depend on array order, all with the identical tiebreak:**

| Resolver | Array |
|---|---|
| `schedule.ts:80` `resolveTemplateAmount` | `RecurringTemplate.amountHistory` |
| `ledgerLoans.ts:109` `resolveRecurringOverpaymentAmount` | `recurringOverpayment.amountHistory` |
| `ledgerLoans.ts:228` `resolveMonthlyPayment` | `Loan.monthlyPaymentHistory` |
| `pensionLedger.ts:51` `resolvePensionAmount` | `Pension.amountHistory` |
| `savingsPotLedger.ts:66` | `SavingsPot.interestHistory` |
| `salaryLedger.ts:46` `findApplicableSnapshot` | **`Person.salaryHistory`** |

**Five of those six are going to `jsonb`, which preserves array order — so they are safe, and this
is a second, independent argument for the §4 split.** The sixth is not.

### 11.7a 🚨 `salary_snapshots` is a table, and its resolver needs an ordinal column

`Person.salaryHistory` → `salary_snapshots` (a real table, per §4, because snapshots are added and
edited individually). **`SELECT * FROM salary_snapshots WHERE person_id = ?` has no inherent row
order.** Whatever order PowerSync's local SQLite happens to return becomes the tiebreak — and it
can legitimately differ between two devices holding identical data.

**This is already live in real data.** Adam's backup has two snapshots for himself both
`effectiveFrom: 2026-09-30`, one `grossAnnual: 62500` and one `62400`. Post-migration, which one
governs his pay from that date would be arbitrary, and **his device and Ella's could resolve
different salaries from the same rows** — a wrong net-pay figure with nothing anywhere indicating a
problem.

> ### ✅ DONE IN THE APP — 2026-09-16 (PROMPT-02, session 2026-09-16b)
> **`recordedSeq` now exists on `SalarySnapshot` and is the live tie-break.** The migration
> session reads a field that is already there, on every person, in both real backups:
> - `SalarySnapshot.recordedSeq: number` — required, see its own comment in `src/types/ledger.ts`.
> - Backfilled by `migrateLedgerData()` in **current array order** (0, 1, 2 …), which is what makes
>   it behaviour-preserving — it writes down the order already in use rather than changing it.
> - Assigned on creation in `addSalarySnapshot` as `max(existing) + 1` (`nextRecordedSeq` in
>   `salaryLedger.ts`); `recordedSeq` is omitted from that function's parameter type so no caller
>   can pass one.
> - Used as the tie-break by `findApplicableSnapshot` **and** `latestSalarySnapshot` — the latter
>   had the same dependency less visibly (`>=` let the last equal-dated array element win).
> - Array index is kept only as a defensive fallback for a snapshot without one.
>
> **So `salary_snapshots.recorded_seq integer not null` maps straight from the field**; there is no
> longer any need to derive it from array position at migration time. Verified by
> `scripts/verify-salary-snapshot-ordinal.ts`, which exercises all 24 permutations of a 4-snapshot
> history and asserts both real backup files resolve identically to the old index rule.
>
> Nothing was sorted, reordered or de-duplicated — see §11.7b.

**Required:** give `salary_snapshots` an explicit monotonic `recorded_seq integer not null` (or
`recorded_at timestamptz`), populate it in insertion order at migration time, and change
`findApplicableSnapshot` to order by it instead of array index. Then audit every other array
becoming a table for the same dependency — `occurrenceOverrides` is keyed by `originalDate` and
looks order-independent, `loan_overpayments` / `credit_card_lump_payments` are keyed by their own
`date`, but each needs checking rather than assuming.

### 11.7a-bis A second instance of the same class — `transactions.date` (2026-09-16)

Found while fixing a bug Adam reported the same day, and recorded here because the migration
session needs to know it: **a materialized `Transaction` generated from a `RecurringTemplate` used
to be identified by its `date`** — both by `reconcileRecurringTemplateTransactions` and by
`dedupeKey` (`sourceType:sourceId:date`). A per-occurrence date move changes that date, so after a
SECOND move the row could not be re-found and the same occurrence was materialized twice, leaving
two `cleared` rows both counting against the balance.

Same shape as §11.7a: **identity keyed off something mutable.** Fixed by
`Transaction.occurrenceOriginalDate`, which stamps the occurrence's natural (anchor-walked) slot —
the same key `occurrenceOverrides` uses — onto the row. Rows materialized before the field existed
are stamped on first sight by the reconciler rather than migrated.

**For the migration:** `transactions` is a real table, so carry this column
(`occurrence_original_date`, nullable — legacy rows genuinely have none until the reconciler stamps
them). `dedupeKey` itself was deliberately left date-based: keying it off the new field would have
duplicated every pre-existing row, because legacy rows have no `occurrence_original_date` until the
reconciler stamps one.

### 11.7b The duplicates are left alone — decided, do not revisit

**Adam's decision, 2026-09-15: no de-duplication, no sorting, ever.** Recorded here because both
my first and second drafts of this section proposed touching these arrays, and both were wrong.

- The duplicates are **not damage**. `scripts/verify-bill-amount-tiebreak.ts`'s own header states
  the fix "self-heals that data with no migration needed, purely by resolving history correctly
  going forward." Leaving them is the deliberate design, not an oversight.
- **Sorting is actively harmful** — it reassigns the array indices the tiebreak depends on and
  silently restores the stale-value bug that fix exists to prevent.
- De-duplication would be behaviour-preserving but buys only bytes, in a subsystem where a mistake
  is silent and the arrays are tiny (nine entries at most across both real backups).

The one real risk — a table losing array order — is removed by `recordedSeq` (§11.7a), which adds
information rather than destroying it. That is the whole mitigation.

**If a future session believes these arrays need normalising, sorting or de-duplicating: re-read
§11.7 first, then raise it with Adam rather than doing it.**

### 11.8 Schema-version spread between the two real datasets

Mum's backup has **no** `pensions`, `savingsPots`, `pots`, `salarySorts` or `jointAccount` keys at
all — it predates those features and relies on `migrateLedgerData()` backfilling them on load.
Adam's has all of them.

**Consequence for `LegacyDataMigration`:** it must run the imported blob through
`migrateLedgerData()` *before* deciding whether the data is "non-trivial", and before writing any
row — otherwise a pre-feature backup hits `undefined.length` on the first array it touches. This
is exactly the existing `parseLedgerBackupJson` path, so reuse it rather than writing a second
parser.

---

## ✅ AS BUILT — PROMPT-13 Part B6, 2026-09-20: round-ups and the Coin Jar

Migration `20260920120000_shared_finance_ledger_round_ups.sql`. **Seven additive, nullable columns
with no defaults, across three existing tables.** Nothing dropped, renamed or recreated; no data
written; no function replaced. Table count stays **28**, publication membership stays **27 + 8**.

| Table | Column | Type | For |
|---|---|---|---|
| `transactions` | `rounded_from` | `numeric` | The pre-rounding amount. `amount` is ALREADY the rounded figure |
| `transactions` | `rounding_pot_id` | `text` | Which Coin Jar the uplift feeds |
| `transactions` | `round_up_skipped` | `boolean` | B1a — this ONE row opted out of rounding |
| `pots` | `is_coin_jar` | `boolean` | The one restricted pot per person |
| `pay_cycles` | `round_up_enabled` | `boolean` | The switch, per person |
| `pay_cycles` | `round_up_effective_from` | `date` | When the current setting began |
| `pay_cycles` | `round_up_history` | `jsonb` | The on/off windows before it |

**Two deviations from PROMPT-13's own spec, both confirmed by Adam on 2026-09-20:**

1. **`round_up_effective_from` is `date`, not `text`.** It is a real calendar date, and every
   adjacent date column in this schema (`opening_balance_date`, `pay_schedule_anchor`) is already
   `date`. The mapping sends an ISO `yyyy-mm-dd` string either way.
2. **`round_up_history` entries carry `from`** as well as `until`/`nextRuleFrom`, which
   `payday_history` does not. See `MIGRATION-LESSONS.md` §42: a payday rule can safely govern all
   of time before the first change; a switch cannot, because it was OFF before it was first
   enabled. Without it, turning rounding off retroactively declared it to have been on for every
   date before it existed.

**`rounding_pot_id` deliberately has NO foreign key**, though it points at `pots(id)`.
`MIGRATION-LESSONS.md` §27: an FK the app can violate is a silently discarded write under
PowerSync. Two devices can legitimately order these writes either way round — device B can receive
a rounded shop before it receives the pot that shop names — and an FK would reject that shop
permanently. The app matches ids and ignores a row naming a pot it cannot find, so a dangling id
costs nothing while a rejected row costs the transaction.

**One CHECK constraint, `transactions_rounding_pair`:** `(rounded_from is null) = (rounding_pot_id
is null)`. Safe on existing data (both are null on every current row) and unviolatable by the app
(`roundUpFields` returns both or neither), so it is not a §27 hazard.

**No Sync Streams change.** The stream queries are `SELECT *` and never name columns, so the
regenerated YAML is byte-identical and PowerSync needs no dashboard action.

**The Coin Jar credit is NOT a table.** There is no `round_up_credits` or equivalent, and there
must never be one: the jar's balance is derived by summing `amount - rounded_from` over the rows
naming it. Adam chose the derived option so that deleting an expense removes its credit
automatically. See `APP-KNOWLEDGE.md` §1.19d.

**`round_up_skipped` is stored, not inferred** (added 2026-09-20 on Adam's request, after the other
six were approved; the same unapplied migration was amended rather than a second one added for one
feature). On a saved row "was not rounded" and "was deliberately not rounded" are indistinguishable
— both simply lack `rounded_from` — and the app recomputes rounding from the rules on every save, so
without the column an edit would silently round a row the person had excluded.

**Verification:** `supabase/checks/20260920_shared_finance_ledger_round_ups_verify.sql`, 12 checks,
all passing in PGlite. **Check 9 is vacuously true until a real device has synced a round-up
history — re-run it after the first live toggle** (`jsonb_typeof` must never say `string`, §33).

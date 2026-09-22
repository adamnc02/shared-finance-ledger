# Shared Ledger — Technical Documentation

Implementation-level reference for `shared-finance-ledger`. README.md stays user-facing; this
document is how it is built, and — more importantly — **why**, because most of the non-obvious
decisions here were paid for with real bugs against real data.

**§1–§35 are the ledger itself, and are byte-for-byte the same subject matter as
`personal-ledger/TECHNICAL.md`**, because the code they describe is byte-identical between the two
live apps. **§36–§44 are the sync layer, which exists only here.**

> Companion documents, outside this repo:
> `Downloads/App Development & Bug Tracking/shared-finance-ledger/` holds `APP-KNOWLEDGE.md` (the
> invariants register), `DATA-MODEL-REVIEW-2026-09-15.md`, `BUILD-PLAN.md`, `OPEN-QUESTIONS.md` and
> the dated PROMPT/UAT files. `DIVERGENCE.md` is in this repo and is enforced by
> `npm run check:divergence`. The Supabase schema, RLS and functions are documented in
> `silver-octo-invention/docs/`.

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [File structure](#2-file-structure)
3. [The data model](#3-the-data-model)
4. [Persistence and the `LedgerStore` interface](#4-persistence-and-the-ledgerstore-interface)
5. [`LedgerContext` — the mutation surface](#5-ledgercontext--the-mutation-surface)
6. [App shell, viewport and navigation](#6-app-shell-viewport-and-navigation)
7. [Design system](#7-design-system)
8. [Modals, sheets and portals](#8-modals-sheets-and-portals)
9. [The generator contract](#9-the-generator-contract)
10. [Auto-clear](#10-auto-clear)
11. [Occurrence identity and overrides](#11-occurrence-identity-and-overrides)
12. [Effective-dated history](#12-effective-dated-history)
13. [Schedule changes](#13-schedule-changes)
14. [Pay cycles, paydays and the fiscal calendar](#14-pay-cycles-paydays-and-the-fiscal-calendar)
15. [The tax engine](#15-the-tax-engine)
16. [Salary, pensions and the Salary Sorter](#16-salary-pensions-and-the-salary-sorter)
17. [The loan engine](#17-the-loan-engine)
18. [The credit-card engine](#18-the-credit-card-engine)
19. [Pots, savings pots and interest](#19-pots-savings-pots-and-interest)
20. [Transfers](#20-transfers)
21. [Round-ups and the Coin Jar](#21-round-ups-and-the-coin-jar)
22. [The joint account and the household](#22-the-joint-account-and-the-household)
23. [Projection and the running balance](#23-projection-and-the-running-balance)
24. [Module: Home](#24-module-home)
25. [Module: Wallet](#25-module-wallet)
26. [Module: Borrowing](#26-module-borrowing)
27. [Module: Bills](#27-module-bills)
28. [Module: Transactions](#28-module-transactions)
29. [Module: What-if](#29-module-what-if)
30. [Charts and hit-testing](#30-charts-and-hit-testing)
31. [Progress bars, rings and RAG](#31-progress-bars-rings-and-rag)
32. [Categories and icons](#32-categories-and-icons)
33. [Delete semantics](#33-delete-semantics)
34. [Testing: the verify suite](#34-testing-the-verify-suite)
35. [Known limitations and open items](#35-known-limitations-and-open-items)

**The sync layer — this app only**

36. [Why the sync layer is shaped like this](#36-why-the-sync-layer-is-shaped-like-this)
37. [The table registry and the Sync Streams](#37-the-table-registry-and-the-sync-streams)
38. [The mapping boundary](#38-the-mapping-boundary)
39. [Narrow writes and the connector](#39-narrow-writes-and-the-connector)
40. [`powerSyncLedgerStore`](#40-powersyncledgerstore)
41. [Boot, auth and the rescue](#41-boot-auth-and-the-rescue)
42. [Households, link codes and "Set as me"](#42-households-link-codes-and-set-as-me)
43. [Imports, ids, patches and Backup & Restore](#43-imports-ids-patches-and-backup--restore)
44. [The divergence register, and the other apps on this project](#44-the-divergence-register-and-the-other-apps-on-this-project)
45. [Low-balance alerts](#45-low-balance-alerts-prompt-14-part-7)

---

## 1. Architecture overview

Vite + React 19 + TypeScript, Tailwind v4, React Router (`HashRouter`, for GitHub Pages), `date-fns`
for date arithmetic, `lucide-react` for icons, `nanoid` for ids — plus `@supabase/supabase-js`,
`@powersync/web` and `@journeyapps/wa-sqlite` for the sync layer (§36 onward).

```
┌────────────────────────────────────────────────────────────┐
│  pages/            Home · Salary · Loans · Bills ·         │
│                    Expenses · Scenarios                    │
│      ▲ reads derived values, calls mutations               │
│      │                                                     │
│  context/LedgerContext.tsx                                 │
│      one AppDataV2 blob · ~76 mutations · no persistence    │
│      ▲                              │ store.save(next,prev)│
│      │ store.load()                 ▼                      │
│  lib/store/LedgerStore.ts ── powerSyncLedgerStore          │
│                                  └─ PowerSync (local SQLite│
│                                     over OPFS) ⇄ Supabase  │
│                                                            │
│  lib/*.ts   PURE finance engines — no React, no storage.   │
│             Every verify script points here.               │
└────────────────────────────────────────────────────────────┘
```

**The layering rule.** `src/lib` is pure: no React, no `localStorage`, no `Date.now()` hidden
inside a calculation (an "as of" date is always a parameter). That is what lets
`scripts/verify-*.ts` run the real functions in Node against the real backup files. A calculation
that only exists inside a component cannot be verified, which is why things like
`progressSection.ts` and `cycleSummary.ts` were pulled out of `Home.tsx`.

**The single-blob rule.** All state is one `AppDataV2` object. `LedgerContext` owns every
mutation; pages never write to storage and never mutate `data` directly. This is what makes the
store interface possible — and what makes a single-key backup meaningful.

---

## 2. File structure

```
src/
  App.tsx                 Shell, routes, scroll reset, LedgerProvider + AppGuards
  main.tsx                createRoot — identical in every app
  index.css               Design tokens, base styles, edge fades
  types/
    ledger.ts             AppDataV2 and every entity. THE COMMENTS ARE THE SPEC
    models.ts             Legacy shapes still in use: BillLocation, Scenario, tax inputs
  context/
    LedgerContext.tsx     ~76 mutations over one blob. Byte-identical in both live apps
    LedgerProvider.test.tsx
  lib/
    store/
      LedgerStore.ts            The interface
      localStorageLedgerStore.ts The offline implementation (still present, still the default
                                 export the provider falls back to)
      powerSyncLedgerStore.ts   SYNC APP ONLY — the wired-in store (§40)
    powersync/                  SYNC APP ONLY (§36–§43)
      tables.ts schema.ts mapping.ts writes.ts connector.ts database.ts
      household.ts linking.ts importIds.ts legacyData.ts backup.ts
      powerSyncAdapter.ts
    supabaseClient.ts           SYNC APP ONLY — one client, scoped to this app's schema
    ledgerStorage.ts      load/save/migrate against one localStorage key
    schedule.ts           RecurringTemplate → occurrences
    occurrenceOverrides.ts Shared override rules for every schedule that has them
    scheduleChange.ts     "Change from this payment" for the non-template generators
    autoClear.ts          Materialise what is due; reverse what is no longer due
    pendingSweep.ts       What happens to generated rows when the generator is deleted
    projection.ts         Cleared + generated future, to a horizon
    runningBalance.ts     signedAmount / isLedgerTransaction — the sign convention
    cycleSummary.ts       The Personal/Joint income-vs-outgoings breakdown card
    averageSpendForecast.ts Placeholder ad-hoc spend, as a daily rate
    payCycle.ts           Paydays, bank holidays, cycle bounds
    fiscalCalendar.ts     4-4-4 fiscal years and the 5-week P13
    tax.ts                UK PAYE, per period
    salaryLedger.ts       Salary occurrences and net pay for a period
    salarySortLedger.ts   Salary Sort suggestions and conflicts
    pensionLedger.ts      Pensions as scheduled income; resolveCycleBounds
    loans.ts / ledgerLoans.ts  Amortisation, overpayments, settlement, progress
    interestConventions.ts Loan interest convention library + best-fit
    loanLedger.ts         A loan's own card, ledger and trend series
    creditCards.ts        The card engine
    potLedger.ts / savingsPotLedger.ts  Pot and savings-pot ledgers
    savingsInterest.ts    AER and daily-accrual interest
    transferLedger.ts     Transfer endpoints and per-entity signs
    roundUp.ts            The round-up predicate
    jointLedger.ts / jointAccountLedger.ts / householdLedger.ts
    household.ts          reconcilePersonReferences — load-time self-healing
    deleteReassign.ts     RESTRICT deletes and staged reassignment
    locationChange.ts     Moving where a bill/loan/card is paid from
    progressSection.ts    The pure half of the progress section (bar + ring numbers)
    purchaseImpact.ts     The date-aware What-if action
    scenarios.ts          The date-free What-if engine
    legacyBridge.ts       AppDataV2 → legacy AppData adapter for scenarios.ts
    categories.ts / billIcons.ts / extendedIcons.ts / iconSuggestions.ts / datamuse.ts
    categorySuggestion.ts Category pre-pick from a similar past transaction name
    format.ts / date.ts / finance.ts / bills.ts / pickerFirst.ts
  pages/
    Home.tsx        4.4k lines — the deck, the ledger, the progress section, trends
    Salary.tsx      5.4k lines — the Wallet
    Expenses.tsx    4.0k lines — four tabs
    Loans.tsx       2.5k lines — loans and credit cards
    Scenarios.tsx   1.4k lines — What-if
    Bills.tsx       1.0k lines — bills
  components/       ~33 shared components (see §7–§8), plus SYNC APP ONLY:
                    SyncRoot.tsx AuthGate.tsx AccountModal.tsx
                    LegacyDataMigration.tsx DuplicatePersonBanner.tsx syncControls.ts
  context/AuthContext.tsx   SYNC APP ONLY — Supabase Auth session state
scripts/
  verify-*.ts       executable checks, including the sync-only ones (§44)
  check-divergence.ts  the guard against drifting from personal-ledger
  check-sync-build.ts  proves the LIVE bundle carries this app's sync wiring
  print-sync-streams.ts prints the Sync Streams YAML from tables.ts
  lib/fakeSyncDb.ts    in-memory stand-in for PowerSync's local database
  fixtures/         real backups and baselines
```

---

## 3. The data model

`AppDataV2` (`src/types/ledger.ts`) is fourteen lists plus two scalars:

```ts
interface AppDataV2 {
  people: Person[]
  categories: Category[]
  recurringTemplates: RecurringTemplate[]
  loans: Loan[]
  creditCards: CreditCard[]
  pensions: Pension[]
  savingsPots: SavingsPot[]
  pots: Pot[]
  transactions: Transaction[]
  payCycles: PayCycleConfig[]      // one per person
  salarySorts: SalarySort[]
  scenarios: WhatIfScenario[]
  primaryPersonId: string
  jointAccount: JointAccountConfig | null
}
```

> 🚨 **`src/types/ledger.ts` is heavily commented and the comments are the specification.** Read
> the comment on a field before changing what it means. Several of them record a decision that is
> not recoverable from the code.

### `Transaction` — the only thing that carries money

| Field | Meaning |
|---|---|
| `date` | When it clears or is due — not when it was entered |
| `amount` | Always positive; `direction` decides the sign |
| `direction` | `'in'` / `'out'`. On the Personal/Joint/Household ledger this unambiguously controls display sign |
| `status` | `'cleared'` / `'pending'` |
| `type` | What it represents — see below |
| `location` | `'personal'` / `'joint'` / `'pot'` / `'savings'` |
| `ownerId` | Whose personal account, when `location === 'personal'` |
| `sourceType` / `sourceId` | Back-link to the generator |
| `occurrenceOriginalDate` | Which *slot* of that generator this row is — see §11 |
| `creditCardId` / `savingsPotId` / `potId` | Which entity's own ledger this belongs to |
| `fromLocation` / `toLocation` | A transfer's two endpoints — the authoritative sides |
| `roundedFrom` / `roundingPotId` / `roundUpSkipped` | Round-ups — see §21 |
| `payee` / `payeeSharePercent` | The joint two-way split |
| `followsPayday` / `followsCycleStart` | Display badges; the date is already resolved |

**`TransactionType`,** and what each one does to the personal cash balance:

| Type | Personal ledger | Notes |
|---|---|---|
| `bill_payment`, `loan_payment` | −, when `location: 'personal'` | Generated from a template or loan |
| `expense` | − | Ad-hoc cash out |
| `income`, `bonus` | + | Ad-hoc in; a bonus is taxed properly but logs standalone |
| `salary` | + | Generated from `Person.salaryHistory` |
| `pension_income` | + | Its own type so the row can carry the pension's name |
| `credit_card_spend` | **no effect** | Only on that card's own list, shown positive there |
| `credit_card_payment` | − | Paying down a card is cash out of your account |
| `savings_interest` | **no effect** | The bank's money moving inside a pot |
| `transfer` | ± | The generic replacement for the six deposit/withdrawal types |
| `savings_deposit`/`_withdrawal`, `joint_deposit`/`_withdrawal`, `pot_deposit`/`_withdrawal` | ± | **Superseded** by `transfer`. Kept in the union so persisted backups still load |

> **The sign is type-derived on an entity's own list, direction-derived on the personal ledger.**
> A credit-card payment is negative on Personal and negative-on-the-card (it reduced what is
> owed); a card spend is invisible on Personal and positive on the card. `runningBalance.ts`'s
> `signedAmount` is the one place `direction` becomes a number for the personal ledger; each
> entity ledger (`potSignedAmount`, `jointAccountSignedAmount`, `loanSignedAmount`) has its own.

### The generator entities

- **`RecurringTemplate`** — bills, recurring transactions and recurring transfers, discriminated by
  `kind`. 🚨 **`kind` is `undefined` for a real bill** — it is never set to the literal `'bill'`.
  Filters must test `kind !== 'transfer'`, never `kind === 'bill'`. Getting this backwards broke
  the pot checklist entirely once already.
- **`Loan`** — monthly payment (with history), term, start date, principal, optional APR, advance
  date, a fitted `interestConventionId` + `calibratedMonthlyRate`, `settlementMultiplier`,
  `statementCalibrationLines`, one-off `overpayments[]` and one `recurringOverpayment`.
- **`CreditCard`** — APR, a `currentBalance` **anchor** at `balanceAsOfDate`, a minimum payment
  (fixed or percent), a payment day, an optional statement window, `lumpPayments[]` and
  `minimumPaymentOverrides[]`.
- **`Pension`** — name, amount history, frequency, anchor, weekend adjustment, overrides.
- **`SavingsPot`** — opening balance/date, interest method with its own history and overrides, an
  interest destination, recurring deposits, an optional target.
- **`Pot`** — opening balance/date, recurring deposits, `isCoinJar`.
- **`Person`** + **`SalarySnapshot`** (`recordedSeq`-ordered) + **`SalaryOverride`**.
- **`PayCycleConfig`** — one per person: payday, weekend adjustment, cycle start, `paydayHistory`,
  `paySchedule`, `roundUpEnabled` + `roundUpHistory`, `salarySortBasis`.

---

## 4. Persistence and the `LedgerStore` interface

```ts
interface LedgerStore {
  load(): AppDataV2 | null | Promise<AppDataV2 | null>
  save(next: AppDataV2, prev: AppDataV2): void
  subscribe?(cb: (data: AppDataV2, wholesale: boolean) => void): () => void
}
```

- `load()` returns **migrated** data. `migrateLedgerData` runs inside the store, so the provider
  stays ignorant of schema.
- A synchronous `load` renders on the very first render, so the offline app gets no loading flash.
  Only a Promise puts the provider into a loading state — which is what the sync app needs.
- `save` is called on **every** change, undebounced, and must never throw.
- `subscribe` is optional; `wholesale` bumps `importGeneration` (§5).

**This app wires in `powerSyncLedgerStore`** from `App.tsx` — that one wiring file is the only
divergence above the store. **`LedgerContext.tsx` does not know the sync layer exists.**

**The offline implementation** is `localStorageLedgerStore`: a thin wrapper over
`lib/ledgerStorage.ts`'s existing `loadLedgerData` / `saveLedgerData`, on one key,
`localStorage['ledger:app-data-v2:v1']`. Same key, same migration, same JSON format, same error
handling (log, never throw). `createLocalStorageLedgerStore({ storage, key })` exists for tests.

> 🚨 `ledger:app-data-v2:v1` on this origin is also the **offline `personal-ledger` app's** key —
> a real, unbacked-up ledger on that person's devices. In this app it is **read** by the rescue
> (§41) and by nothing else, ever. `verify-ledger-store.ts` snapshots the context's 76-member
> public API so a mutation cannot be added or removed silently, and is widened here for the one
> sync-only file allowed to read that key.

**Why the interface exists at all:** so this app can pass `powerSyncLedgerStore` from its
`App.tsx` while `LedgerContext.tsx` stays byte-identical in both repos. **If that file ever needs
to differ between the apps, the interface is leaking — reconsider it rather than forking the
file.**

---

## 5. `LedgerContext` — the mutation surface

One provider, one `AppDataV2` in `useState`, ~76 exported members. Everything goes through
`setDataState`, which writes to the store in the same pass. Pages call mutations; they never touch
storage.

The shape of the API, by area: categories (3), transactions (4), credit cards (7), loans (8),
recurring templates (5), people and pay cycles (8), salary (8), savings pots (6), pots (6),
pensions (3), transfers and Salary Sorts (6), scenarios (3), joint account (3), location
assignment (4), deletes with resolutions (1).

### `importGeneration`

`setData` (a wholesale replacement — a restore, or an import) bumps `importGeneration`. `Salary.tsx`,
`Bills.tsx` and `Loans.tsx` each have a `useEffect` keyed on it to resync derived UI state:
section-open flags, default owner ids, expanded rows.

> **Ordinary mutations must not bump it**, or sections snap open and shut under the user
> mid-edit.

> 🚨 **Under PowerSync, `setData` stops being the only wholesale-replacement path.** A first sync,
> or a large inbound sync, delivers a whole new dataset without ever calling `setData`. The store
> therefore marks its **first delivery `wholesale`**, which bumps `importGeneration` through the
> provider's `subscribe` callback. Without that, every one of those pages renders stale derived
> state after signing in.

### The first save

`LedgerProvider`'s first save is `save(data, data)` — the long-standing write-back of freshly
migrated data on startup. **That is one of the three reasons the first-sync gate (§40) exists**:
ungated, a device that had not yet synced would push freshly seeded defaults into a household that
already has data.

---

## 6. App shell, viewport and navigation

`App.tsx` renders `LedgerProvider` → `AppGuards` → `HashRouter` → `#app-shell`.

- **`--app-height`** is measured in JS in `index.html` rather than using `100dvh`/`100vh`. iOS
  standalone reports a stale viewport on first paint, and there is no scroll to force a recompute.
- **`#app-shell` is the single `position: relative` anchor**, and `BottomNav` is `absolute`
  against it. `fixed` breaks on iOS standalone for the same reason.
- **`#app-content` is the app's only scroll container.** Route changes therefore reset its scroll
  manually (`ScrollToTop`), and every overlay must portal out of it (§8).
- **`AppGuards`** holds app-wide blocking checks. Currently one: the first time any path creates a
  joint-location bill or loan, `needsJointAccountSetup(data)` fires `JointAccountSetupModal` so
  the joint account gets a real opening balance. Checked once, here, rather than inside both
  pages' save handlers.

---

## 7. Design system

Tokens live in `src/index.css`. Dark ground (`--color-bg: #0e1320`), layered surfaces
(`--color-bg-elevated`, `--color-surface`, `--color-surface-raised`), three ink weights, one track
colour, semantic positive/negative/warning, and **one accent: `--color-coral: #ff5b4c`**.

Fonts: **Space Grotesk** (display), **Inter** (body), **JetBrains Mono** (figures), from Google
Fonts.

### Shared components

| Component | Role |
|---|---|
| `BottomNav` | The floating nav pill |
| `WalletStack` | The Home deck — stacked cards, tap to bring to front, MRU ordering |
| `BankCard` | A hero card face |
| `CollapsibleSection` | The Wallet's section wrapper; its `+` can force it open |
| `SwipeToDelete` | The universal delete gesture. Respects `[data-no-swipe]` |
| `ProgressRing` / `ProgressBar` / `RagLegend` | §31 |
| `TrendChart` | `BalanceSpendChart` and `SavingsPotPillChart` — §30 |
| `CategoryIcon` / `CategoryIconPickerModal` / `CategoryManagerModal` | §32 |
| `NumberInput` | Numeric-keypad input with the app's parsing rules |
| `EditField` / `FormButtons` / `SavedFlash` | Form primitives; `SavedFlash` is the green "Saved" pulse |
| `ConfirmModal` / `DeleteGuardModal` / `RecurringChangeConfirmModal` | Confirmations |
| `EffectiveDatedChangeFlow` | **The shared "which payment does this start from?" picker**, in either of its two date modes — §13 |
| `PausedOccurrencesControl` | The shared pause/resume list for every schedule |
| `SplitEditor` | The two-way joint split |
| `TransferSteps` | The shared From/To wizard |
| `LocationEditor` | Current account / Joint / a Pot |
| `DeductionModal` | A salary deduction |
| `RebalanceAccountsModal` / `JointAccountSetupModal` / `AttachBonusButton` | One-purpose modals |
| `HeaderAccessory` | **A deliberately empty slot.** Renders nothing unless an app fills it — which is how *this* app puts its Account button in the Wallet header while `Salary.tsx` stays identical in both repos. It is shared with `personal-ledger` and is deliberately **not** a divergence carve-out |

### Small shared UI is duplicated on purpose

`PersonPickerCard` and `LocationPickerCard` exist as near-identical local copies in `Bills.tsx`
and `Loans.tsx`. That is the codebase's convention for small page-local UI. What *is* shared is the
**decision**, not the component: `lib/pickerFirst.ts` owns whether the picker step can be skipped,
so three files cannot drift into three different booleans.

---

## 8. Modals, sheets and portals

**Every modal portals to `document.body`** via `createPortal`. Page components render inside
`#app-content`, which is `overflow-y-auto`; an overlay inside it is clipped, and the bottom nav
renders on top of it. Neither a z-index bump nor switching to `absolute` fixes it — the second
makes it worse. `FiltersSheet` is the reference implementation; `TrendsModal` copies its portal
pattern verbatim for exactly this reason.

---

## 9. The generator contract

Every generator in `src/lib` obeys the same contract:

> **Compute what SHOULD exist in this range. Do not look at what does. The caller dedupes.**

Pure, idempotent, no writes. The dedupe key is `sourceType:sourceId:date`, and
`autoClearDuePayments` builds **one global** key set shared by every step —
deliberately location-agnostic. Per-location sets produced duplicate transactions when a bill's
location changed twice with a past effective date.

Generators, and where they live:

| Generator | File | Emits |
|---|---|---|
| Recurring templates (bills, transactions, transfers) | `schedule.ts` | `bill_payment`, `expense`/`income`, `transfer` |
| Loans | `ledgerLoans.ts` | `loan_payment` (+ overpayment, settlement) |
| Credit-card minimums | `creditCards.ts` | `credit_card_payment` |
| Salary | `salaryLedger.ts` | `salary` |
| Pensions | `pensionLedger.ts` | `pension_income` |
| Pot / savings-pot recurring deposits | `potLedger.ts` / `savingsPotLedger.ts` | `transfer` |
| Savings interest | `savingsPotLedger.ts` + `savingsInterest.ts` | `savings_interest` |

Each of `pensionLedger`, `savingsPotLedger` and `potLedger` is a **deliberate near-copy** of
`schedule.ts`'s date walker rather than a shared generic one. `schedule.ts`'s functions read
`RecurringTemplate`-only fields throughout, and genericising it would touch the Bills/Transactions
pipeline it is already load-bearing for. The *algorithm* is intentionally identical; only the field
set differs.

---

## 10. Auto-clear

`lib/autoClear.ts`. **There is no tap-to-clear anywhere in the app.**

Two separate things come due, and both are handled:

1. Anything **generated** whose date has arrived is materialised into a real, persisted, `cleared`
   `Transaction` for the first time.
2. Anything **already stored but still pending** whose date has arrived — a future-dated logged
   lump payment, an ad-hoc expense — is flipped to `cleared`. Without this step, nothing else in
   the app ever revisits a persisted pending row.

Pure and idempotent: it returns the **same `data` reference, unchanged**, when there is nothing to
settle, which is what lets the caller run it on every load without causing a write.

**Clearing runs both ways.** `reconcileRecurringTemplateTransactions` does the reverse: a
generated row dated in the future is **never** `cleared`. Written as a *state* rule rather than a
transition, so rows already stranded by an earlier bug self-heal on load. Safe only because
`autoClearDuePayments` is the only thing in the app that clears anything, and clearing has no side
effect of its own. **If a manual "mark as cleared" path is ever added, this needs revisiting.**

**Deterministic ids.** Every materialised payment gets `id = 'auto:' + dedupeKey(...)`
(`autoClearedTransactionId`). Offline, nothing changes but the id. It exists for the sync app,
where two devices clearing the same payment before syncing used to create two rows and double the
household balance. **Rule: any row the app creates without a user action must get a deterministic
id.** Pinned by `verify-auto-clear-ids.ts`.

**Look-ahead for payments moved earlier.** Every override-bearing walk steps through *original*
slot dates and applies a moved date afterwards, so a walk that stops at `rangeEnd` never sees a
slot after the range that was moved *into* it. The walks now run
`earlyMoveLookaheadDays(overrides)` past the end (**0** when no override moves a slot earlier, so
nothing else changes), plus ten days for a pension with the working-day adjustment. Two rules stop
double counting: a slot reached only by the look-ahead counts only if its moved date is inside the
range, and a payment moved to before a range's start belongs to the earlier range.

**Pending sweep on delete** (`lib/pendingSweep.ts`): deleting a generator removes its **pending**
rows. Cleared rows survive — deleting the generator does not un-happen the payment — with one
exception, `isSweepableOnGeneratorDelete`: a cleared row dated **today** is swept too. Loans need
their own matcher, because a one-off overpayment's `sourceId` is the *overpayment's* id, not the
loan's (§17).

---

## 11. Occurrence identity and overrides

> 🚨 **A materialised occurrence's identity is its SLOT, not its date.**

`Transaction.occurrenceOriginalDate` holds the occurrence's natural, anchor-walked date — the same
key `RecurringTemplate.occurrenceOverrides` uses. **Identify a generated row by that, never by
`t.date`**, because a per-occurrence date move changes the date.

The bug this fixed: the reconciler matched its row by either end of a *single* move, so a **second**
move stranded the row (the intermediate date is recorded nowhere) and the generator materialised
the same occurrence again — two cleared rows, both counting against the balance. All three
single-occurrence surfaces share one generator and one reconciler, so all three had it.

> **`dedupeKey` is deliberately still `sourceType:sourceId:date`.** Do not "finish the job" by
> keying it off `occurrenceOriginalDate`: rows materialised before that field existed carry none,
> so their key would stop matching fresh candidates and every legacy row would duplicate. The
> reconciler moving the row onto the override's current date is what makes the date-based key
> correct again. Legacy rows are stamped on first sight; there is no migration.

**`RecurringOccurrenceOverride`** is `{ originalDate, date?, amount?, deleted? }` and is shared by
templates, pensions, pots and savings pots. `lib/occurrenceOverrides.ts` owns the shared rules.

**The "· Adjusted" badge** comes from one rule, `isOccurrenceAdjusted(actual, natural)`: the date
**or** the amount differs, to the penny. Each schedule wraps it because "natural" differs — a
follows-payday transfer's natural date is payday-resolved; a pension's weekend shift is natural;
pots compare against the standing amount. **"An override exists" is the wrong test**: an override
set back to the standing amount is not adjusted, and a paused occurrence shows "Paused", never
"Adjusted".

**"Manage upcoming payments" is one window for all seven lists**: `manageUpcomingRange(asOf)`
(−13 months to +13 years, wide enough for an annual schedule) then
`trimToManageUpcoming(rows, dateOf, asOf)` → the last payment on or before today plus the next
twelve. Compared by the **displayed** date, so a payment moved earlier counts by its moved date, and
a payment due today is the "last payment", not an upcoming one. The open card is `[data-no-swipe]`.

**Date-moving transfers are range-checked by the date they are PAID.** A `followsPayday` /
`followsCycleStart` transfer's slot resolves to a later date, up to a full pay period later. A range
starting between the slot and the payday used to drop that payment silently. Those walks now start
two months early and filter by the **resolved** date; identity is still the slot. Plain templates
are unaffected (slot === date). **If you add a "from today" view of transfers you get this for
free — do not filter by `originalDate`.**

---

## 12. Effective-dated history

Several entities record a change as a dated entry rather than overwriting a value:
`RecurringTemplate.amountHistory`, `Loan.monthlyPaymentHistory`,
`LoanRecurringOverpayment.amountHistory`, `Pension.amountHistory`, `SavingsPot.interestHistory`,
`Person.salaryHistory`, `PayCycleConfig.paydayHistory` and `roundUpHistory`, plus
`locationHistory` on templates, loans and cards.

> 🚨 **Array order is load-bearing.** Five resolvers break same-`effectiveFrom` ties by **array
> index** — recency of recording: `resolveTemplateAmount`, `resolveRecurringOverpaymentAmount`,
> `resolveMonthlyPayment`, `resolvePensionAmount`, and the savings-interest resolver. **Never sort
> these arrays.** `verify-bill-amount-tiebreak.ts` documents the real bug this prevents.

**The one exception: `Person.salaryHistory`** tie-breaks on `SalarySnapshot.recordedSeq`, an
explicit per-person ordinal, because it is the one of the six that becomes a real *table* in the
sync app's schema, where row order does not exist. `findApplicableSnapshot` and
`latestSalarySnapshot` use the same rule; the array index survives only as a defensive fallback.

The design decision is explicitly **"fix the resolver, don't migrate the data"** — corrupted
history self-heals by being resolved correctly. Do not add a data migration on the assumption
duplicates are damage.

**A dated on/off switch needs a start date.** `roundUpHistory` mirrors `paydayHistory`'s shape and
adds `from`. A payday rule can safely govern all of time before the first recorded change, because
*some* payday rule has always applied. Rounding has not — before it was first switched on it was
off. Without an explicit start, switching rounding off retroactively declares it to have been on
for every date before it existed, and every historic card expense starts reporting as rounded.
**Anything else recording a dated on/off switch needs the same field.**

---

## 13. Schedule changes

> 🚨 **Changing WHEN a schedule pays re-dates stored payments; it never re-creates them.**

Every generator re-derives occurrences on the fly and dedupes against stored rows by **date**
(templates by slot). Changing the day, frequency or follows-payday rule of any schedule therefore
orphaned every stored payment and re-materialised the whole history on the new day. That was
confirmed on templates, loans, recurring overpayments, card payment days, salary paydays, pensions
and savings-interest opening dates.

**The rule, on every surface:** the user picks the payment the change starts from
(`EffectiveDatedChangeFlow`).

- Stored payments from that one on are re-dated one-to-one (k-th old → k-th new).
- Keyed data moves with them: overrides, pauses, amount boundaries, salary overrides and sorts,
  card minimum overrides.
- Nothing before it is re-generated.

**Two date modes, and which one a caller gets is a statement about the change** (2026-09-22). The
flow's date step is either an **occurrence list** — one button per real upcoming payment — or a
**plain `<input type="date">` calendar (`datePicker`)**:

| Mode | For | Why |
|---|---|---|
| `occurrences` | Anything that **re-dates something stored**: a payday, a bill's amount, a loan payment, a pension | The new rule has to take hold on a date a payment actually falls on |
| `datePicker` | A change that **re-dates nothing** — so far, only the round-up on/off switch (§21) | Any calendar date is legitimate, including one that is not a payday |

> 🚨 **Do not fold the two into one.** A payday change borrowing the calendar could be dated to a
> day no salary is ever paid on; a round-up switch borrowing the occurrence list gets the two bugs
> §21 records. The calendar step carries its own Continue, disabled while the field is empty,
> because a date input — unlike a list of buttons — advances nothing by itself.

**How each generator enforces "nothing before":**

| Generator | Mechanism |
|---|---|
| Templates | Re-anchor (`applyTemplateScheduleChange`), plus `anchorDayOfMonth` for a 31st anchored on a short month |
| Pensions, loans, overpayments, cards | `scheduleFrom` floors (`lib/scheduleChange.ts`) |
| Salary | `PayCycleConfig.paydayHistory` |
| Savings interest | A period already paid on another day is skipped |

**Any new generator, or any new editable date on an existing one, needs this too.**
`verify-no-duplicates-on-schedule-edit.ts` is the template for proving it: old behaviour
duplicates, new does not, earlier rows untouched, auto-clear stable, projected ledger clean.

Two details that cost real time:

- **A payday change has two boundaries** — `until` (the chosen payday's old date) and
  `nextRuleFrom` (its new date). They differ, and 2nd → 28th makes September hold two paydays.
- **The picker shows display dates; identity is the slot.** Always map through
  `occurrenceSlotForDate` (with the pay cycle, for follows-payday transfers).

**The reconciler must resolve dates exactly as the generator does.**
`reconcileRecurringTemplateTransactions` once used `override?.date ?? slot`, while the generator
applies `resolveTemplateOccurrenceDate` (payday / cycle-start) on top — so every follows-payday
transfer's stored row was moved back to its slot on the next load and the payday row was generated
again: **one more duplicate per load, live, needing no user action.** It also skips rows whose slot
is before the template's anchor; those belong to an earlier schedule, and re-pricing them rewrites
paid history.

**Location changes are different.** `lib/locationChange.ts` is deliberately *not* forward-only the
way an amount change is: moving where a bill or loan is paid from is a **one-time rewrite** of
every existing transaction for it dated on or after the chosen date, cleared ones included, because
the question being answered is "which payments left my personal ledger". Future occurrences
generate against the entity's own updated `location`/`potId`.

---

## 14. Pay cycles, paydays and the fiscal calendar

`lib/payCycle.ts` holds **two deliberately independent dates**:

- **Payday** — the nominal day-of-month salary arrives, adjusted to the last working day on or
  before it if that day is a weekend or a UK bank holiday.
- **Cycle boundary** — the budgeting "month" (e.g. 14th–13th) used for summary and projection
  scoping. It stays fixed even when payday drifts a day or two earlier.

They are separate fields on `PayCycleConfig` for exactly this reason. **Do not derive one from the
other.** (`cycleStartFollowsPayday` is the opt-in that ties them, per person.)

Bank holidays are **computed, not tabulated**, so payday resolution keeps working for any future
year without a data update: the real UK substitute-day rule for fixed-date holidays falling on a
weekend, and Easter computed for Good Friday and Easter Monday. England & Wales only — Scotland and
NI diverge, and there is no location setting.

### Pay frequency vs pay schedule

> 🚨 **Pay FREQUENCY is tax; pay SCHEDULE is dates.**

- `SalarySnapshot.payFrequency` chooses the **tax** thresholds:
  `'monthly' | 'four_weekly' | 'four_weekly_fiscal'`.
- `PayCycleConfig.paySchedule` is the **date** schedule. Absent means monthly, so every config
  saved before this feature is unchanged.
- **The two must agree.** `salaryNeedsPayDate(person, payCycle)` says when they do not. Salary is
  then **not generated** and the Wallet asks for the date. Nothing is guessed or written silently.
- **One source of pay dates.** `paydaysForMonth` (a four-weekly rule contributes the paydays that
  *land* in the month) feeds every pay-date list and generator, and `cycleBoundsForDate` gives a
  four-weekly earner payday-to-payday cycles. Everything reaches cycles through
  `resolveCycleBounds` → `cycleBoundsForDate`. Joint and Household follow the primary person.

### The fiscal calendar

`lib/fiscalCalendar.ts`. A 4-4-4 fiscal year, 13 periods, ending on the **last pay weekday on or
before 31 March**, starting the day after the previous one ended. 13 × 28 = 364, so when two
year-ends are 371 days apart the year is 53 weeks and **P13 is five weeks**. Those years come every
five *or* six years (2027/28, 2032/33, 2038/39…) because of leap days, so the calendar is computed
from the rule, never from a fixed cycle or a stored table, and extends indefinitely. Every fiscal
year ends before 6 April, so each UK tax year holds exactly 13 paydays.

A five-week period sets `SalaryInput.periodWeeks: 5`, scaling the four-weekly thresholds ×5/4
(`periodsPerYear` 13 → 10.4). Gross, allowance, bands, student loan and percentage deductions all
follow; fixed per-period deductions do not. **Anything computing a net pay must pass the pay cycle,
or a P13 is priced as four weeks.** Everything in this file works on unadjusted nominal dates; the
weekend/bank-holiday adjustment is applied on top by `payCycle.ts` and never moves a period
boundary.

---

## 15. The tax engine

`lib/tax.ts`, rates confirmed for 2026/27.

It calculates **per period**, the way real PAYE does — HMRC's published per-period thresholds and
payroll rounding — rather than computing an annual figure and dividing. Those are not equivalent,
and the difference is not rounding noise.

It is **non-cumulative** ("Month 1" / "Week 1"). For level pay it matches a single real payslip to
the penny; real cumulative PAYE reconciles rounding across the year, so `netAnnual`
(= `netPerPeriod × periods`) can differ from a true year-end figure by a pound or two. That is a
deliberate trade-off: a per-period-exact payslip is the more useful thing for a budgeting app to be
right about.

Covers: Personal Allowance and its £1-per-£2 taper, the 20/40/45 bands, employee NI, student loan
plans 1/2/4/5 and postgraduate, and pension relief at source / salary sacrifice / net pay — each
changing what income tax and NI are actually calculated against. Deductions can be fixed or a
percentage, and pre- or post-tax.

**Not modelled:** Scottish bands (an S code is treated as rest-of-UK), multiple employments,
benefits in kind, higher-rate relief reclaimed through Self Assessment.

`computeNetBonusAmount` runs the same engine to net down a gross bonus. A bonus is **not** folded
into the payday transaction: it logs as its own standalone incoming row, because folding it in
would mean either double counting or silently rewriting a logged bonus into an invisible
adjustment to a different transaction.

---

## 16. Salary, pensions and the Salary Sorter

**Salary** (`lib/salaryLedger.ts`) is a dated history. `computeNetPayForPeriod` returns a manual
`SalaryOverride` for that exact date if one exists, otherwise runs the tax engine against whichever
`SalarySnapshot` was effective then. `generateSalaryTransactions` turns that into dated pending
`salary` rows under the usual generator contract.

**Pensions** (`lib/pensionLedger.ts`) are their own scheduled income source, with a distinct
`pension_income` type purely so the ledger row can carry the pension's own name instead of
everything reading "Salary". `resolveCycleBounds` also lives here — a pay cycle can follow a
pension rather than a salary (`PayCycleConfig.followsIncomeSource`).

### Salary Sort

`lib/salarySortLedger.ts` is read-only: suggestions and conflict detection. The upsert, detach and
orphan cleanup live in `LedgerContext`.

- **A sort belongs to one person.** `SalarySort.personId` scopes every lookup. Until this existed a
  sort was keyed on `payDate` alone, so two people paid on the same date shared one record,
  overwrote each other's targets, and saw each other's amounts in the suggestion box.
- **Older records are attributed, not guessed** — `migrateLedgerData` fills `personId` from the
  owner of the transfers the sort created, which is the same answer it would have had.
- **The ids are derived**, so two devices converge: `sort:<personId>:<payDate>`, its target
  `…:<destination>`, its transfer `…:<destination>:tx`. Records made before this keep their nanoid
  ids; nothing reads the shape.
- **Each target is a real transfer**, independently editable. `sourceType: 'salary_sort'` exists
  purely so `updateTransaction`/`removeTransaction` can keep the owning sort in step, or detach it.
- Destinations are the primary person's own pots and the joint account only — it is the primary
  person's cash that is leaving.
- A target whose transaction is gone is **hidden by `reconcilePersonReferences`, never deleted**.

---

## 17. The loan engine

`lib/ledgerLoans.ts` + `lib/interestConventions.ts` + `lib/loanLedger.ts`.

`buildLoanSchedule` runs genuine reducing-balance interest. The rate comes from
`resolveLoanRateAndConvention`: a fitted `InterestConvention` once calibrated, otherwise a
back-solved flat-monthly baseline from payment + principal + term.

**Why a convention library rather than one formula:** two real loans reconciled against real
statement data during scoping turned out to use genuinely different conventions, and neither
formula fits the other loan's figures well. There is no single "the" loan interest formula to
hard-code, so the engine tests a small, growable library of candidates against whatever statement
lines exist and keeps the best fit (`bestFitConvention`). `Loan.apr` is a reference/pre-fill value
only — it suggests a starting payment via PMT at creation and is **never read by the core engine**,
because a displayed APR is routinely rounded and a lender's real internal rate sits a hair either
side of it. `advanceDate` matters: it is routinely 3–8 weeks before the first payment, and at least
one lender charges interest from it.

### Four source types land on a loan, and one breaks the obvious rule

| `sourceType` | `sourceId` is |
|---|---|
| `loan` | the loan's id |
| `loan_recurring_overpayment` | the loan's id |
| `loan_settlement` | the loan's id |
| **`loan_overpayment`** | **the OVERPAYMENT's own id** |

> 🚨 Anything selecting a loan's rows with `t.sourceId === loan.id` silently drops one-off
> overpayments — and drops them only on the loan's own surfaces, since the funding account's ledger
> filters by type and category instead. Match `loan_overpayment` against **that loan's own
> overpayment ids**; matching on `sourceType` alone would let one loan absorb another's.

### A paid date and a recognised date are different

`buildLoanSchedule` folds a one-off overpayment into whichever period shares its **month**. That is
correct and must not be "fixed" — the engine must not compound interest differently because a lump
landed mid-period. But the absorbing schedule entry is routinely **later** than the day the money
left the account: a payment on the 17th on a loan due the 28th is recognised on the 28th.

> 🚨 **Any "as of today" read derived from `schedule.filter(e => e.date <= today)` is therefore
> wrong for up to a month after every overpayment.** This has bitten twice — a trend chart drawing
> the dip on the wrong date, and `summarizeLoan`/`summarizeLoanProgress` reporting a loan exactly
> as it stood before a £7,000 payment, taking the owed figure, the progress bar, the pie chart and
> the whole Borrowing page with them.

Use the helpers rather than writing a third copy of the consumption loop:
`appliedOneOffOverpayments(loan, schedule)` maps each overpayment to **both** dates, and
`unrecognisedOneOffOverpayments(loan, schedule, asOfIso)` returns what is paid-but-not-yet-
recognised. A one-off overpayment is 100% principal, so crediting the cash straight against capital
is exact. **Once the absorbing period passes, the credit falls to zero and the schedule takes over
— check that boundary in anything new. It is the double-count trap.**

### Two totals, and which one a progress figure needs

- **`nominalTotalPayable`** — the contractual total, deliberately frozen against overpayments and
  pinned by `verify-loan-amortisation.ts`. Right for `summarizeLoan.totalPayable` and settlement.
- **`amortisedTotalPayable`** — the real schedule's own total, after every logged overpayment.

A progress figure needs the second. Against the first, **a loan with overpayments can never reach
100%**: overpaying shortens the term and cuts the interest, so the real total falls below the
contractual one and the bar tops out short. `LoanProgress.percentPaid` and `amortisedRemaining` use
the amortised pair; `totalBalance` and `nominalRemaining` keep the contractual view. The two are
identical for a loan with no overpayments, which is why this was invisible for so long.

### Recast, settlement, calibration

- **Recast mode** — every overpayment chooses `reduce_term` (keep the payment, finish sooner) or
  `reduce_payment` (keep the length, pay less).
- **Settlement** — `settlement ≈ balance × (1 + k × monthlyRate)`, `k` defaulting to 2 if more than
  12 months remain and 1 otherwise, overridable once calibrated against a real quote. "Settle this
  loan" logs the **real** amount actually paid, which may differ from the estimate; the loan goes
  `active: false` with a `closedDate` that `summarizeLoan` uses directly as the payoff date rather
  than trusting what the mechanical schedule would predict.
- **Calibration** — `statementCalibrationLines` are kept raw and persisted, so re-fitting always
  uses the whole accumulated set, not just the newest line.

### A loan's own ledger card

`lib/loanLedger.ts`. 🚨 **The positive row on a loan's own ledger is a derived view of the existing
`loan_payment` transaction, never a second stored one.** One payment is one stored row, shown twice
— negative on whatever funded it, positive here. **Nothing in that file writes a transaction, and
nothing should ever be added that does**: every path that already sums `loan_payment` rows would
then double-count, and each one missed is a silently wrong number in a live app holding real data.
This is the same display convention the credit-card list and the Joint/Pot ledgers already use.

---

## 18. The credit-card engine

`lib/creditCards.ts`. **This is the single most fragile area of the app.** One reported symptom —
"balance never reaches zero" — took five separate fixes, each a genuinely different mechanism. Run
the **full** verify sweep after any change here.

### The balance is derived, not stored

`card.currentBalance` is a **stated anchor** as at `card.balanceAsOfDate`, changed only by the
person editing it. What the card owes right now comes from `cardBalanceAsOf()`, which replays
interest and card activity forward from that anchor. Card activity dated *before* the anchor is
ignored — it is already in the figure.

Two kinds of function live here and are kept apart:

- **Pure schedule generation** (`generateMinimumPaymentTransactions`) — the generator contract.
  Produces pending rows; does not touch `currentBalance`.
- **Recording functions** (`recordCreditCardSpend`, `recordCreditCardLumpPayment`) — for things
  the person is telling the app already happened. **Neither writes to `currentBalance`.**

### Two balances are tracked

`workingBalance` (the true running balance, clamped to 0) and `statementBalance` (what the minimum
is sized off, deliberately lagged on a statement-window card, and deliberately unclamped). **They
can legitimately diverge**; a fix that reasons about only one is incomplete.

### The five mechanisms behind "never reaches zero"

| # | Mechanism |
|---|---|
| 1 | `NEGLIGIBLE_BALANCE` (£0.02) — a tiny residual is a stable rounding fixed point under a `balance <= 0` guard |
| 2 | Amortisation deadlock — a rounded percent-minimum that does not cover the cycle's interest |
| 3 | `workingBalance` vs `statementBalance` diverging permanently on a windowed card |
| 4 | Interest-free grace on new purchases, plus two regressions its own fix introduced |
| 5 | The deadlock guard force-paying off **genuine** debt traps — narrowed to fire only when *rounding*, not payment policy, erased the progress |
| 6 | `rangeStart` landing on an already-cleared payment date, so that payment is applied twice: once in the opening `cardBalanceAsOf` (`t.date <= asOfIso`, inclusive) and once as that cycle's own charge (`paymentDate >= rangeStart`, also inclusive). Two inclusive comparisons meeting. Fixed by starting the simulation the day **after** a payment already inside the opening balance — and the guard now lives **inside `generateMinimumPaymentTransactions`**, so no caller can reintroduce it |

**Three things about mechanism 6 that cost real time. Do not re-derive them:**

- **`storedDates` filters the display row, never the deduction.**
  `buildCreditCardMinimumChargeRows` discards the duplicate generated row via
  `.filter(t => !storedDates.has(t.date))` — but that runs *after* the generator returns, by which
  point the duplicate deduction has already corrupted the running balance every later cycle is
  computed from. A fix built on the assumption that this filter suppresses the re-simulation would
  double-correct.
- **A statement window masked it by cancellation, not protection.** `statementBalance` opens from
  the previous close and is unclamped, so the doubled payment sits as a legitimate overpayment
  credit and nets out when the delayed spend's window closes. **There is no protective mechanism in
  the windowed path — don't go looking for one.**
- **The two clamping rules decide the symptom.** `workingBalance` is clamped to 0, so a
  100%-minimum card swallows the whole residual and generates nothing further (loud). A
  fixed-minimum card just loses one instalment off the end (quiet — it passed two rounds of
  review). This is why `sum(pending) === live balance` is the assertion that matters and "does a
  row appear" is not.

### Other structural traps

- 🚨 **`withLiveBalance` output must never be fed back in.** It updates `currentBalance` but leaves
  `balanceAsOfDate` at the original anchor, so `cardBalanceAsOf` /
  `generateMinimumPaymentTransactions` replay the same activity a second time and double it. Two
  real call sites did exactly this. Pinned by `verify-credit-card-live-balance-misuse.ts`.
- 🚨 **A simulation must never re-apply a transaction already folded into its own opening
  balance.** Whenever a replay starts from `cardBalanceAsOf(x)`, everything dated on or before `x`
  is already in that figure.
- **A window boundary that depends on time of day is a latent seasonal bug.**
  `new Date('2026-09-14')` is 01:00 in BST but 00:00 in GMT, so a `>=` against a locally
  constructed midnight flips behaviour twice a year. Compare window boundaries on **ISO date
  strings**.

### Cards use their own periods

> 🚨 **HARD RULE.** A credit card's periods come from its own `paymentDayOfMonth` and statement
> window, with the payment due date as the **last day of the cycle**. Every other card type
> (Personal, Joint, Household, Pot, Savings Pot) follows the **household pay cycle**. Never align a
> credit card to the household cycle, and never align the others to a card.
> `creditCardCyclePeriods` is confirmed working and must not be changed.

A statement window also changes which cycle spend belongs to: spend inside a window is due on the
payment date **after** that window closes. Without a window, spend counts toward the very next
payment date with no lag.

Two figures once documented as constraints were re-measured after the mechanism-6 fix and found to
be free choices: a statement window does **not** need to close after the payment date (all 28
closing days reconcile), and `creditCardCyclePeriods` has **no** due-date off-by-one.

### A card's minimum can be paid from a Pot

`CreditCard.location` / `potId` (absent = Personal), changed from a chosen payment exactly like a
loan.

- **Only the minimum payment moves.** Logged/lump payments and Clear stay Personal.
- **Stored minimum payments have no `sourceType`**, so they are matched by `creditCardId` +
  `type: 'credit_card_payment'` + `!sourceType` — never by `sourceType`/`sourceId`.
- Every generator caller filters by the row's location.
- **Always pass the full `data.transactions`:** the balance simulation must see every payment,
  whatever funded it.

---

## 19. Pots, savings pots and interest

**`Pot` and `SavingsPot` are different entities with separate id spaces**, and conflating them
would make a stray cross-lookup a silent bug. A `Pot` is the thing bills, loans and card minimums
are *paid from*; a `SavingsPot` earns interest and has a target.

**The cash-out event is the deposit, not the payment.** A pot-funded `bill_payment`/`loan_payment`
does **not** get its own transaction type — it reuses the existing one and carries
`location: 'pot'` + `potId`. That keeps every place that already asks "what kind of thing is this"
(category grouping, icons, Bills filtering) working unchanged; only *where* it is routed changes,
not *what* it is.

**A pot's balance folds transactions**, it is not a stored field. `potBalanceAsOf` /
`savingsPotBalanceAsOf` walk from `openingBalance` at `openingDate`. **Nothing before `openingDate`
is ever considered**, and any new consumer must clamp to it or it will show money before the pot
existed.

### Savings interest

`lib/savingsInterest.ts`, two conventions:

1. **`aer_credited`** — the bank quotes an AER and a crediting frequency. Interest for a period is
   calculated against the balance **as at the start** of that period and credited at the end.
   Cheap, but slightly wrong for a pot with mid-period movements: a deposit on the 15th earns
   nothing until the following crediting date. **That is the trade-off, not a bug.**
2. **`daily_accrual_monthly_credited`** — the realistic convention: a daily rate accrues against the
   actual balance on each day, replaying every deposit and withdrawal, credited monthly.

Interest is `type: 'savings_interest'`, `direction: 'in'`, and — like `credit_card_spend` — it does
**not** touch the personal cash balance: it is the bank's money moving inside the pot. A
hand-overridden interest payment carries no `sourceType`, the same "hand-set beats generated"
convention as every other override. `SavingsPot.interestDestination` can route it elsewhere, which
is the only case where a `Transaction.location` is `'savings'`.

### The Coin Jar's restrictions

A Coin Jar (`Pot.isCoinJar`) has no ring, no target, no recurring deposits, funds no bill, loan or
card payment, and has no ad-hoc spending out of it. Those are enforced **in the generators in
`potLedger.ts`, not only in the pickers**, because "a hidden picker entry is not enforcement": a
hand-edited backup can point a bill at the jar and the pickers can do nothing about it.

`fundablePots` filters the funding pickers and is deliberately **not** applied to transfers, the
Wallet stack or rebalance targets — transfers in and out are allowed, and a jar you cannot empty is
a trap.

> 🚨 **The "What this pot pays" checklist is a picker too, and it was missed.** It does not go
> through `fundablePots` — `potEligibleItems` in `Salary.tsx` builds its own list from the
> templates and loans directly — and it is the most direct route in the app to pointing a bill at a
> pot: one tap, no location flow. **When adding a restriction, grep for every list built locally,
> not only the ones going through the shared helper.**

**Why a Coin Jar's opening balance is editable when no other pot's is:** every other pot's
`openingBalance`/`openingDate` pair is a one-time creation-only anchor, because you state it on the
form that creates the pot. **A Coin Jar is created by a switch, not a form**, so it never got that
chance. This is not an inconsistency to tidy up.

---

## 20. Transfers

`lib/transferLedger.ts`. One `Transaction`/`RecurringTemplate` shape (`type`/`kind: 'transfer'`)
covers every combination of current account / savings pot / joint account / pot, one-off or
recurring. It supersedes six older types, which remain in the union only so persisted backups still
load.

**`fromLocation` / `toLocation` are the authoritative sides.** The flat `potId` / `savingsPotId`
columns are convenience denormalisations that cannot represent both ends of a Pot→Pot transfer and
are **not trustworthy for membership questions**. `potLedger.ts` and `savingsPotLedger.ts` read
from/to directly for exactly this reason.

When `'personal'` is one of the two endpoints — the overwhelmingly common case, and always true for
anything logged through the Salary Sorter — the row also carries `location: 'personal'`,
`ownerId: <primary person>` and a `direction` derived from which side personal is on, which is what
lets it flow through the existing personal-ledger machinery unchanged. A direct transfer with **no
personal leg** (Pot ↔ Pot, Savings ↔ Joint) gets `location: 'joint'` or `'pot'` instead, which is
what correctly keeps it off the personal ledger. `locationTypeForTransfer` resolves to
`'personal'` whenever personal is *either* endpoint.

---

## 21. Round-ups and the Coin Jar

`lib/roundUp.ts`. A £7.50 card shop is **stored as £8.00**, remembering it came from £7.50. The
50p funds a pot called Coin Jar. £7.50 leaves net worth; 50p moves.

**The predicate, in full** (`shouldRoundUp`), every clause with its own control in
`verify-round-up-predicate.ts`:

```
!roundUpSkipped
  && type === 'expense' && paymentMethod === 'card' && location === 'personal'
  && !creditCardId && roundUpEnabledOn(payCycle, t.date) && uplift > 0
```

Card expenses only. Not cash, not a bank transfer, not a bill, loan payment, credit-card payment or
card spend, and nothing located in a pot or the joint account. An exact pound is not rounded — that
falls out of `Math.ceil` returning the same pound. `!creditCardId` is belt and braces: a card charge
is `credit_card_spend`, never an expense, but the edit path can still attach a card id.

> 🚨 **THERE IS NO SECOND TRANSACTION, AND THE UPLIFT MUST NEVER REACH PERSONAL CASH TWICE.**
> `amount` is *already* £8.00, so every existing reader — the ledger, every projection, every total
> — is correct **untouched**. The danger is a well-meaning addition: wire the uplift into the
> personal ledger "so it balances" and a £7.50 shop takes £8.50 out of cash.
> `verify-coin-jar-balance.ts` measures the move against a rounding-off control.

The jar's balance is the sum of `amount − roundedFrom` over rows naming it, folded in **inside
`potBalanceAsOf` itself** rather than at the call sites, so a caller cannot forget it and report an
empty jar. **Delete the expense and the credit goes with it, automatically, because it was never a
row.**

**Editing recomputes, from the REAL price.** The edit forms seed their amount field from
`roundedFrom ?? amount`, so a £7.50 shop stored as £8.00 opens at 7.50 — seeding from `amount`
would ratchet the row up a pound on every save. This does not contradict "a switch never rewrites a
stored row": `roundUpEnabledOn` resolves against the **row's own date**.

**The per-transaction opt-out is stored, not inferred.** On a saved row, "was not rounded" and "was
deliberately not rounded" are indistinguishable — both simply lack `roundedFrom` — and
`roundUpFields` recomputes from the rules every time a row is saved. Without
`Transaction.roundUpSkipped`, editing the note on an excluded row would silently round it after
all. `shouldRoundUp` checks it **first**. It is offered whenever a Coin Jar exists, rounding is on
for that row's own date, and the row is a card/personal/ad-hoc expense — deliberately **not** gated
on the amount, so it cannot blink in and out as a figure is typed, and still offered on a row that
has already opted out, or there would be no way to opt back in.

**The switch's effective-from is a DATE, not a payday** (2026-09-22). It once borrowed the pay
cycle settings' payday picker, which it sat next to. Adam: *"it should be a date picker... which
doesn't affect the salary."* The *rules* were always right — `roundUpEnabledOn` resolved correctly
against whatever date was chosen — so nothing about the history, the boundaries or any stored row
changed; only the control did. **A payday change keeps the payday picker**, because it re-dates
stored salary; a round-up switch is instantaneous and re-dates nothing, so any date will do.

> 🚨 **The borrowed picker was not just the wrong wording — it broke the switch for a person with
> no salary configured.** The date step renders one button per occurrence, so on the Coin Jar they
> got a sheet with no options at all; and from the pay cycle settings the toggle *silently did
> nothing*, because `handleSave` read `if (roundUpChanged && paydayOccurrences.length > 0)` — the
> flow never opened, `onChangeRoundUp` was never called, and the draft died on close, directly
> beneath a comment claiming the step could not be skipped. The guard is unconditional now.
> `verify-round-up-date-picker.ts` reproduces the old guard as its control.

**The toggle's home is derived from whether the jar exists:**

| State | Where the toggle is |
|---|---|
| No Coin Jar yet | The person's pay cycle settings (the Wallet cog) |
| Coin Jar exists | The jar's own expanded form; settings shows a one-line pointer |
| Jar deleted | Back to pay cycle settings, and rounding is switched **off** |

> 🚨 **Deleting the jar must also switch rounding off, and that is why the arrangement is safe.** A
> Coin Jar is an ordinary `Pot` to `SwipeToDelete`; a toggle living only on the pot would become
> unreachable the moment the jar was deleted, and `roundUpEnabled` would sit at `true` while
> `coinJarForOwner` returned `undefined`. The switch would read "on" and do nothing.
> `removePot` therefore applies `applyRoundUpChange(cycle, false, today)` when the pot it is
> deleting is a jar. The delete is dated and recorded in the history like any other switch, so the
> window rounding *was* on for is preserved.

**Whose jar:** the expense's own `ownerId`, gated on that person's own switch. There is no
household-wide jar.

---

## 22. The joint account and the household

Three files, three different questions:

- **`jointAccountLedger.ts`** — the joint account's **own** ledger. A real account with its own
  reconciled opening balance and date, fed by every joint-location template/loan occurrence and
  every hand-logged joint transfer. Its `jointAccountSignedAmount` derives the sign from
  from/to, since one `transfer` type can now mean an inflow or an outflow.
- **`jointLedger.ts`** — cost *splitting*. `personShareOfJointAmount` is the maths;
  `generateJointContributionTransactions` builds synthetic personal-scoped rows for one person's
  share. Those used to be folded into the Personal ledger and that was **deliberately reversed**:
  the Personal ledger shows nothing about joint bills at all. Its only remaining consumer is the
  Salary Sorter's suggested joint top-up, a pure calculation never displayed as a transaction.
  `computeJointSummary` is the Joint card's own view.
- **`householdLedger.ts`** — the Household card: **each person's own personal picture only**. No
  joint bills, and no synthetic per-person share of one.

**Assumption, unchanged from the pre-rebuild app: every joint item splits between exactly two
people.** `payee` + `payeeSharePercent` is a two-way split by construction. Three or more people
are not modelled.

**Household and Joint share ONE "Group by Person" implementation.** Both render it as
`CycleGroupedList groupByPerson` → `PersonPills` (cycle-outer, person-inner). They differ only in
the `buildPersonGroups` they pass and in `amountSign`. **A change to either card's Person view must
be checked on the other.**

`buildHouseholdPersonGroups` attributes a row by **object identity** to the projection it came
from, because the combined list is `personProjections.flatMap(pp => pp.transactions)`. That is what
makes a cycle's pills sum to its ungrouped total by construction. **Do not "simplify" it into an
`ownerId` lookup, and do not clone rows** between `computeHouseholdProjections` and the list —
`ownerId` is only a fallback. A pill's figure is that person's **net for the cycle**, not a balance;
that meaning deliberately changed from the old `clearedBalance` view.

**`reconcilePersonReferences`** (`lib/household.ts`) is the load-time self-healing backstop for
imported or old data — a dangling reference is hidden, never deleted.

---

## 23. Projection and the running balance

`lib/runningBalance.ts` owns the sign convention: `signedAmount(t)` is the one place `direction`
becomes a number for the personal ledger, and `isLedgerTransaction(t)` filters out everything that
never touches personal cash (`credit_card_spend`, `savings_interest`, anything located in a pot or
the joint account) **up front**, so callers cannot accidentally include one by forgetting a check.

`lib/projection.ts` combines cleared rows with generated future occurrences up to a horizon
(default: the end of the current pay cycle; extendable to three cycles), dedupes the generated
against the stored, and returns one figure plus one list. `computeProjectionToDate` is the
date-specific variant the What-if purchase action uses.

`lib/cycleSummary.ts` is the pop-down breakdown behind the Personal and Joint heroes — income vs
outgoings vs what is left. It lives in `lib` rather than `Home.tsx` precisely so a verify script
can assert it.

`lib/averageSpendForecast.ts` projects a placeholder ad-hoc spend figure, Personal and Joint only,
from ad-hoc `type: 'expense'` rows (never bills, loans, card spend, recurring templates or income).
The methodology is a **single daily rate** — total matching spend over the window divided by the
window's own day count — scaled by each cycle's actual length, and then reduced by whatever real
ad-hoc spend already sits in that cycle. **The window's end is today, not the last matching
transaction's date**: no-spend days between the last transaction and today pull the rate down, and
excluding them would flatter it.

> **The home page ledger is the downstream consumer of everything.** Bills, Loans, Borrowing,
> Transactions and Wallet all write into state the Home hero cards render. **Any engine change must
> be verified on Home too, not only on the page that owns the feature.** A fix that looks right on
> Borrowing and wrong on Home is not finished.

---

## 24. Module: Home

`src/pages/Home.tsx` (~4,400 lines).

### The deck

`buildDeck(data)` returns the canonical order: Personal, Joint*, Pots*, Credit Cards*, Loans*,
Savings Pots*, Household*. `deckEntryKey(e)` gives each entry a stable string key, needed because
the wallet stack's MRU reorder tracks *which entries* were tapped across renders, not their
(unstable) index. `backToFront` is re-derived every render from the canonical order plus the MRU
pointer: never-selected entries keep `buildDeck`'s relative order; ever-selected entries follow
recency, most recent frontmost. An entry removed from `buildDeck` (a deleted pot) simply cannot
appear and is filtered out of the MRU the same render.

Visibility: Joint needs two people **and** a joint item; Household needs two people; credit cards
and pots are scoped to the primary person's own active ones; a loan card's visibility is
`isLoanCardVisible`'s call in `loanLedger.ts`, not re-derived here.

### The hero figures

`pendingNetTotal` is the **net** of everything still pending inside the horizon — outgoings
negative, income positive. It deliberately replaced an outgoings-only version: logging a +£100
transfer moved Projected and appeared in the list, but Pending did not budge, which reads as the
app having missed the entry. Netting them makes the hero self-consistent — **Current + Pending is
exactly Projected, for every horizon** — which is a stronger property than the old label precision
was worth. There is no double counting: Projected is computed independently in `projection.ts` and
never reads this function.

`amountSign` is threaded as an override throughout, so a non-personal ledger with its own
type-derived convention (`potSignedAmount`, `loanSignedAmount`, `jointAccountSignedAmount`) reuses
the same list components.

### Grouping

`groupingCategoryId(t)` is **not** `t.categoryId`. It is the bucket a row's amount counts toward in
the category view, while the row itself still shows its own real category:

- `loan_payment` → the seeded Loan category
- `credit_card_payment` / `credit_card_spend` → `CREDIT_CARD_CATEGORY_ID`
- a Pot's own deposit/withdrawal/transfer → `pot:<id>`, a synthetic key so a pot named the same as
  a real category can never merge with it
- a Savings Pot's own rows → `savingspot:<id>`
- everything else → its own `categoryId`

> A `paymentMethod: 'card'` row with **no** `creditCardId` is a **debit** card payment and falls
> through to its own category — it used to fold into the Credit Card bucket regardless. A genuine
> credit-card entity row is still caught above by `type`, which is what actually identifies it.

`iconPotOrSavingsPotFor` reuses that exact resolution for the single-row icon case, so a transfer
shows the specific pot's chosen icon rather than a generic "Savings" one.

### Controls

`DeckControls` is a horizon pill plus one **Filters** button. `activeFilterLabels` summarises what
is on as chips; `resetToDefault` restores the lot. **The horizon is a pill, not a filter** — it is
deliberately absent from both. `canShowCycleTotals(entry, horizon, grouping, order)` gates the
cycle-totals view, and `cycleTotalsActive` is gated by the same predicate that decides whether the
toggle is even offered, so a value left switched on from an earlier card cannot silently reshape a
view whose control is hidden. A control that does not apply says why ("A loan only has repayments
going one way", "No spend history yet to estimate from").

### The list renderers

`CycleGroupedList`, `DateOrderedList`, `AmountOrderedList`, `CategoryGroupedList`,
`DirectionGroupedRows`, `PersonPills`, `CreditCardCycleGroupedList`, `SavingsPotCycleGroupedList` —
each taking the same `amountSign` override. `TransactionRow` is the single row.

### Detail sections

`PersonalDetail`, `JointDetail`, `HouseholdDetail`, `PotDetail`, `SavingsPotDetail`, `LoanDetail`,
`CreditCardDetail` — one per deck kind, rendered below the deck for whichever card is active.
`SalaryBreakdownCard` and `JointBreakdownCard` are the pop-down breakdowns, and exist only for
those two faces because no other card has a salary-vs-outgoings picture.

---

## 25. Module: Wallet

`src/pages/Salary.tsx` (~5,400 lines) — the biggest file in the app. Five `CollapsibleSection`s:
**Salary**, **Pensions**, **Savings**, **Pots**, **Joint Account**, plus Manage people, Rebalance
all accounts and Backup.

Key internals:

- **`transferLocationOptions`** is built **once** here from `lib/transferLedger.ts` and threaded
  down into every deposit/withdrawal/recurring wizard on the page, rather than each row rebuilding
  it — the same options the Transactions page's Transfer pill builds, shared so the two cannot
  drift.
- **`SalarySetupForm`** is the one-time setup, replaced for good by `PayPeriodsSection` once saved.
- **`PayPeriodsSection`** lists the next four periods plus a collapsed history, both tapping into
  the **same** `PeriodEditor` — identical for upcoming and closed periods, same breakdown, same
  fields, same "+ Add bonus", one Save, with the scope-confirm modal for upcoming periods only.
- **`PayCycleSettingsModal`** (the cog) holds payday, weekend adjustment, budgeting cycle start,
  opening balance, round-ups (while no jar exists) and the Salary Sort basis. It is behind a cog
  because it is set once and rarely touched.
- **`PayScheduleNeededCard`** / `NextPayDateField` is what appears when frequency and schedule
  disagree (§14) — the app asks rather than guessing.
- **`SalarySortModal`** is the sort flow, including "Already sorted" conflict detection.
- **`SavingsPotForm`** carries the interest method, the `InterestExplanationModal` (which spells
  out what the chosen convention will actually do before you commit to it), and the interest
  destination step.
- **`PotEditForm`** carries **What this pot pays** (`potEligibleItems`) and, for a Coin Jar only,
  the round-up toggle and the editable opening balance. `coinJarRoundUpProps` returns `undefined`
  for every ordinary pot, which is what keeps the toggle off every other pot's form; it reads the
  **jar owner's** pay cycle, not the primary person's — and the switch takes a plain date (§13),
  so a jar owner with no salary configured can still turn round-ups on.
- **`WalletBackupSlot`** (`src/components/BackupSection.tsx`, PROMPT-14 Part 1) — the Backup card
  used to be declared inline here. It is now a **shared** component behind a placement slot, because
  `src/pages/**` may not diverge and this app shows Backup & Restore in the Account modal instead.
  The slot renders the card by default and renders **nothing** under a `'account'` provider, which
  `SyncRoot` supplies — so the difference between the apps is which one renders a provider, not
  which one compiles a file. It still restores through `setData`, so it stays store-agnostic, and
  its confirm is the app's own portalled `ConfirmModal` rather than `window.confirm`.
- Several rows use a **`SavedFlash`** pulse; a brand-new pension or pot flashes on *mount* rather
  than at save time, and the Joint Account card watches for the account appearing, because its
  first creation goes through `AppGuards`' modal and there is no click handler on this page to
  hang a flash off.

---

## 26. Module: Borrowing

`src/pages/Loans.tsx`. Two sections: **Loans** and **Credit Cards**.

`LoanRow` / `CreditCardRow` are wrappers owning the collapse-on-save and the green saved flash.
`LoanEditPanel` / `CreditCardEditPanel` are draft-then-Save panels (`draftFromLoan`,
`draftFromCard`) matching the Wallet's `PeriodEditor` shape — nothing is written until Save.

Modals: `LoanLedgerModal` (every repayment, ad-hoc overpayment and recurring overpayment with its
capital/interest split), `CreditCardLedgerModal`, `SettleLoanModal` (true outstanding balance vs
estimated settlement figure), `CalibrationModal`, `LoanOverpaymentForm` / `OverpaymentForm` (with
the recast choice), `MinimumPaymentEditor`. `CreditCardDueSection` shows the payment due with "Most
recent due" / "Upcoming due" and a **Set to Clear** action.

`LocationPickerCard` and `PersonPickerCard` are this page's local copies (§7); the skip decision
comes from `lib/pickerFirst.ts`.

> **Known, not fixed:** `buildLoanLedgerRows`' `balanceAfter` goes non-monotonic when a recurring
> overpayment falls on a different day of the month from the payment. Each row's `balanceAfter` is
> computed on the amortisation engine's within-period order (payment → one-off → recurring), but
> the recurring row is then re-dated to its own real date, which routinely lands *before* the
> payment it is aggregated into. Sorted by date the balances read 374.55 → 0 → 14.55. The Home
> page's loan trend chart avoids it by walking capital down in date order instead
> (`buildLoanTrendSeries`, pinned by a check). Fix the modal the same way if it is ever raised.

---

## 27. Module: Bills

`src/pages/Bills.tsx`. One list of `RecurringTemplate`s with `kind !== 'transfer'`.

`BillRow` → `BillEditPanel` (draft-then-Save, `draftFromTemplate`), with `FrequencyEditor`,
`PaymentMethodEditor`, `LocationEditor`, `SplitEditor` for a joint bill, the
`EffectiveDatedChangeFlow` for an amount or schedule change, and `PausedOccurrencesControl` +
**Manage upcoming payments** for per-occurrence edits.

"Just a single payment" is how a one-off is expressed — there is no separate entity for it.

---

## 28. Module: Transactions

`src/pages/Expenses.tsx`. Four tabs: **Transactions**, **Recurring**, **Transfers**,
**Overpayments**.

- **`ExpenseForm`** is the add wizard: name → amount → date → category → payment method →
  location, with a card step when the method is a card and a final `round_up` step when a Coin Jar
  exists (rounding pre-picked in coral, the same treatment "Card" gets on the payment-method step).
  The category step pre-picks from `lib/categorySuggestion.ts` — normalised name match against the
  most recent similar past transaction, run once on leaving the name step, with no index and no
  dependency.
- **`EditEntryForm`** edits any ad-hoc row, including bonus and card-spend entries created
  elsewhere, since a correction should not require re-deriving where the entry came from. The
  round-up opt-out is a plain checkbox here — *editing just loads the form, no flow*.
- **`MonthCollapsedTransactionList`** groups cleared entries by month.
- **`TransferForm`** / `TransferRowItem` / `TransferRecurringRow` — one-off and recurring
  transfers, with the shared `TransferSteps` From/To picker, a "Swap From and To" control, and the
  follows-payday / follows-cycle-start options (mutually exclusive; `schedule.ts` checks
  `followsPayday` first).
- **`RecurringTransactionForm`** / `RecurringTransactionEditPanel` / `RecurringTransactionRow` —
  the same schedule engine as Bills, generating plain expense/income occurrences, personal only.
  They use the shared `PausedOccurrencesControl`; their old per-row form wrote the same `deleted`
  override Pause writes.
- **`OverpaymentCreateForm`** / `LoanRecurringOverpaymentRow` / `OverpaymentEditForm` — one-off and
  recurring loan overpayments with the recast choice and "Manage paused overpayments".
- **`SavingsRecurringDepositRow`** / `PotRecurringDepositRow` — a pot's standing deposit, edited
  here rather than on the Wallet.

---

## 29. Module: What-if

`src/pages/Scenarios.tsx` + `lib/scenarios.ts` + `lib/purchaseImpact.ts` + `lib/legacyBridge.ts`.

**Two engines, on purpose.**

`lib/scenarios.ts` is deliberately **date-free**. It answers "how much does this change my
available cash per month" and "how much one-off cash does it move" — neither has a calendar in it.
It works on the pre-rebuild `AppData` shape, and `lib/legacyBridge.ts` is an **adapter** that
converts current ledger state into a synthetic, correctly computed `AppData` so the existing engine
runs against real data without being rewritten. That was a deliberate choice over rewriting ~380
lines of tested simulation logic against the new types, with real risk of subtly changing behaviour
that already works.

`lib/purchaseImpact.ts` is the date-aware half, and exists because a **purchase** is the first
action where the date *is* the question: two £400 purchases have identical monthly and one-off
impact, but one the day before payday and one the day after are completely different propositions.
It runs against the real `AppDataV2` via `computeProjectionToDate` — the same engine every Home
figure comes from.

> **Known gap, stated explicitly:** credit-card minimums *are* folded into the adapted bills list
> (so they count toward the baseline monthly outgoings) but cannot be individually **targeted** by
> a scenario action — `pay_off_loan` / `exclude_loan` / `loan_overpayment` only accept a `loanId`.
> Doing it properly means generalising `ScenarioAction.linkedLoanId` to `linkedDebtId` +
> `linkedDebtType`, a real change to the `Scenario` shape.

Actions: sell an asset, new bill, new finance agreement, salary change, buy something, lump sum
into a savings pot, withdrawal from a savings pot, change a pot's recurring deposit. `DebtCard`,
`SavingsPotCard`, `PurchaseCard` and `ImpactSummary` render the results; `MakeRealButton` converts
a scenario's overpayment into a real recurring one.

---

## 30. Charts and hit-testing

This app hand-rolls several charts (`components/TrendChart.tsx`).

> 🚨 **A responsive SVG with a fixed `viewBox` misleads a `getBoundingClientRect` hit-test.**
> `width="100%"` plus a fixed `viewBox` and no `preserveAspectRatio` means the default
> `xMidYMid meet`: the drawing is scaled **uniformly** and **centred**, so it does not fill the
> element. Measured, not assumed — in the 350px Trends modal the 320-wide pill chart had 15px of
> dead margin each side, and the 364-wide line chart rendered at 0.962. Any hit-test of the form
> `(clientX - rect.left) / rect.width * WIDTH` is then wrong near the edges.

**Map through the rendered transform instead:**
`(clientX - svg.getScreenCTM().e) / svg.getScreenCTM().a` (`clientToViewBoxX`). Correct at any
size, letterboxed or not. `preserveAspectRatio="none"` also works but distorts rounded pill caps.
**Any new chart must hit-test this way.** Touch tests need real CDP `Input.dispatchTouchEvent`, not
mouse events.

**The savings-pot pill chart**, specifically:

- **Fill = the period's end balance.** The full track height is the **highest balance reached
  anywhere in the view** (`SavingsPotTrendSeries.peakBalance`), counting a day's money in before
  its money out, because rows have no time of day. It is **not** net change — the first build did
  that, and the only tall column was a withdrawal.
- **Tooltip:** period label + end balance; red ↓ `£X OUT` / green ↑ `£X SAVED` / `No change` (net);
  a small `£in · £out` sub-label (gross); **fixed height**, no per-transaction list. Every point
  satisfies `moneyIn − moneyOut === netChange`, asserted in `verify-savings-pot-trend-series.ts`.
- **Periods before `openingDate` are not shown** in any granularity.
- Pills are capped at 24 viewBox units and centred in their slot; the slot is the touch target.

---

## 31. Progress bars, rings and RAG

`lib/progressSection.ts` holds the **pure** half: what the section is called, whether it renders at
all, and the numbers its bars and rings are drawn from. It lives in `lib` so a verify script can
assert it against the real backups, and so the **bar** and the **ring** are mathematically
incapable of disagreeing — both go through `summarizeLoansProgress`.

### A loan's ring and its legend carry different numbers, on purpose

Three solid round-capped arcs — green paid, amber projected, red remaining — plus a legend table.
On a £10,000 loan with £4,000 paid and £500/month over the next three cycles:

| | segments (the ring) | legend (the table) |
|---|---|---|
| Paid | 40% | 40%, £4,000 |
| Projected | **15%** | **55%**, £5,500 |
| Remaining | 45% | 45%, £4,500 |
| **Sums to** | **100** | **140** |

The amber **arc** is the £1,500 *increment*, because it is drawn starting where green stops.
The amber **row** is the £5,500 *cumulative* figure, because the table exists to explain the
balances printed beside it. **The `%` column summing to 140 is correct**, and the single most
likely "fix" a later session will attempt is to make them agree. Likewise the delta column: **only
the amber row carries one**; green and red both read an em dash. `verify-rag-legend-rows.ts` pins
it because `−£1,500` on the red row is the plausible mistake.

Red is derived as the **remainder** of the ring (`100 − paid − projected`), which guarantees the
arcs sum to exactly 100 at every rounding.

**Scope is enforced by construction.** RAG is loans only. `ProgressRing` switches on whether a
`segments` prop was passed at all, and `verify-progress-section.ts` asserts at the **source** that
exactly two of the four rings pass one — a numeric check cannot see a later session helpfully
extending RAG to every ring.

### Round caps overlap by a full stroke width

`strokeLinecap="round"` extends each end of an arc by **half** the stroke width beyond the path's
real endpoint, so two arcs butted together at the same angle overlap by a **whole** stroke width —
at the ring's 22px stroke, very visible, and it reads as a rendering bug. `ProgressRing` insets
every segment at both ends by `strokeWidth / 2 + SEGMENT_GAP / 2`; the cap then fills back out to
the nominal boundary and `SEGMENT_GAP` of background shows between neighbours. Chosen over
z-ordering, which only *hides* the overlap while leaving the boundary half a stroke width from the
number it represents.

> **The consequence to know about:** a segment's path can inset to nothing. An arc shorter than
> `2 × inset` would render with a **negative** dash length, which SVG draws as a **full circle** —
> a 0.3% segment would paint the entire ring in its colour. Those segments are dropped instead. A
> single segment owning the whole ring skips the mechanism and draws a plain circle.

### The progress bar's tooltip

`ProgressBar`'s mini-tooltip arrows must land exactly on the end of the fill. **Every x is a
percentage of the bar's width** (`progressTooltipLayout`) and the tooltip row is a sibling of the
bar inside one `w-full` parent — so "42%" resolves to the same x in both at any screen width, with
nothing measured and nothing to drift. The only pixel values are the box's height and the arrow's
own size. **If anyone "simplifies" this to a measured pixel offset, the arrows will be right at one
width and wrong at another.** Near 0%/100% the *box* is clamped inside the bar's bounds; the arrows
never are.

Related: a CSS border-triangle **cannot carry a border**. Outlining one with a second, larger
triangle leaves its flat top edge showing as a sliver. The arrow is an SVG `<polyline>` tracing
left corner → tip → right corner precisely so the top edge is never drawn.

### A modal's horizon and the page's are allowed to disagree

`ProgressModal` covers the page, so the page's This cycle / Next 3 cycles control sits behind it and
cannot be reached. The loan modals therefore carry **their own** control, deliberately independent
of the page's. The preview bar outside keeps following the page.

> 🚨 **This is why `horizonEndDate` became `horizonEndFor(horizon)`.** The old fixed date was
> derived by each caller from the *page's* horizon. With the page on This cycle and the modal on
> Next 3 cycles, the projection would have been taken against this cycle's end and every amber
> segment would have been far too small, with nothing on screen to suggest anything was wrong.

---

## 32. Categories and icons

A `Category` is a first-class entity carrying the icon and colour; every item in it inherits the
look. Four reserved built-in ids are seeded at init and undeletable:
`CREDIT_CARD_CATEGORY_ID`, `INCOME_CATEGORY_ID`, `BILLS_CATEGORY_ID`, `SAVINGS_CATEGORY_ID`.

**Icon selection is three layers:**

1. `lib/billIcons.ts` — the 35 permanent, always-visible icons. **These never change**, so existing
   categories never shift meaning.
2. `lib/extendedIcons.ts` — the "invisible" library, used **only** to suggest an icon for a
   brand-new category. Each entry is offered at most once: an icon in use by any category is
   excluded, computed live from the category list rather than a persisted flag, so deleting a
   category quietly frees its icon again. **Every name here was checked against the installed
   `lucide-react` exports before being added** — some very plausible-sounding icon names do not
   exist and will break the build.
3. `lib/iconSuggestions.ts` — the pure matcher. `lib/datamuse.ts` is an optional, best-effort
   network fallback supplying *extra keywords* when the local match is weak. It is **the only
   network call in the app**, needs no key, and any failure — no connection, timeout, non-2xx,
   malformed JSON — silently resolves to an empty list, so category creation always works offline.

---

## 33. Delete semantics

`lib/deleteReassign.ts`. Deleting a **Person**, a **Pot** or a **Savings Pot** is **RESTRICT**:
blocked while anything still points at it.

- `findDeleteBlockers` lists what is blocking.
- **Decisions are staged.** The sheet stages Move or Delete per item and nothing changes until
  Delete, which applies all of them plus the delete in one update, or nothing.
- **Moves from a delete rewrite PENDING rows only** (a row cleared today included). The
  Bills/Borrowing "move to a pot" flow keeps its own cleared-rows-too behaviour, because it is
  answering a different question (§13).
- **Joint splits:** a deleted person's joint split items move at 100% and become Personal when one
  person is left.

**Deliberately not restricted:**

- **Cleared transactions** are historical fact. They keep their ids and references exactly as they
  are and never block anything.
- **Pending rows generated by something** follow their generator: reassigning it rewrites them,
  deleting it sweeps them (`pendingSweep.ts`). Only hand-logged pending rows are listed
  individually.
- **`locationHistory` entries** are an audit trail, not live references.

---

## 34. Testing: the verify suite

**The house testing idiom** is `scripts/verify-*.ts` — 141 plain `tsx` executables printing ✓/✗,
each with a header explaining the real bug it prevents. Several read the fixtures in
`scripts/fixtures/`. **Write one alongside any change to `src/lib/`.**

> 🚨 **Some verify scripts read real backups from OUTSIDE this repo, by absolute path** — see the
> warning in §44. They are not in git and there is no second copy.

```bash
npx tsc -b                 # must be clean
npx vitest run             # SavingsPotForm + LedgerProvider suites
npm run check:divergence   # must pass: no un-registered difference from personal-ledger
for f in scripts/verify-*.ts; do out=$(npx tsx "$f" 2>&1); rc=$?; \
  if [ $rc -ne 0 ] || echo "$out" | grep -qE "✗|^FAIL|Error:"; then \
  echo "FAIL: $f"; echo "$out" | grep -E "✗|^FAIL|Error:" | head -5; fi; done; echo DONE
```

**The sweep is strict on purpose:** a non-zero exit, a `✗`, a line starting `FAIL`, or an `Error:`
all fail. The old `✗`-only grep once let eight crashing or `FAIL:`-printing scripts count as
passes.

Things worth knowing about the suite itself:

- **Run the FULL sweep after any shared-engine change.** Two of one batch's three regressions were
  sitting undetected in files that session had not touched.
- **A verify script can assert the OLD behaviour.** Two scripts had sanity checks baked in that
  asserted behaviour a later decision reversed; both needed updating *with* the change, not
  "fixing".
- **Scripts reading real backups read them as of their export date.** An earlier "as of" makes
  already-cleared payments look future and fails for non-bug reasons.
- **Retesting the same entity across rounds gives false failures**, because cleared is immutable.
  Always build a fresh card or bill for a retest.
- Several scripts assert **from the source text**, not just numerically — because some failures (a
  restriction quietly extended to every ring, a toggle with no reachable home) are invisible to a
  numeric check.

---

## 35. Known limitations and open items

**Structural**

- Single device, no sync, no cloud backup. The JSON download is the only backup.
- Two-person households only for joint splitting.
- England & Wales bank holidays only; Scottish tax bands are not modelled.
- Tax constants are 2026/27 only; there is no year picker.
- Auto-clear is not byte-deterministic (fresh ids on newly due rows).

**Open items** — flagged, never fixed, each needing a decision:

| Item | Where | Note |
|---|---|---|
| Savings pot Year tooltip labels a cycle by its START month | `savingsPotLedger.ts` `buildSavingsPotTrendSeries` | A 28 Aug → 29 Sep cycle reads "Aug 2026" |
| Interest explanation reads "paid in quarterly" / "paid in annually" | `Salary.tsx` `InterestExplanationModal` | Pre-existing wording |
| Pot checklist lists the pot's own recurring-deposit template | `Salary.tsx` `potEligibleItems` | Partly fixed (`kind !== 'transfer'` added) |
| Pot row's stale "+£100 since" net-activity figure | Home / Wallet | Never investigated |
| Transactions duplicated by the pre-fix relocate bug | user data | Not retroactively cleaned; would need a one-off data pass |
| Statement bill as its own ledger row with one-tap clear | credit cards | A feature idea, partly delivered by the "Balance due" row |
| Combined multi-card cycle-grouped ledger | Home | Different cards have different payment days |
| `buildLoanLedgerRows`' non-monotonic `balanceAfter` | `ledgerLoans.ts`, Borrowing's loan ledger modal | §26 |
| Household header "projected" sums each person's OWN horizon | `householdLedger.ts` | Every Household list uses the **primary** person's cycles, so a four-weekly person's later horizon can hold a row that counts in the header but appears in no cycle |

**Things a previous session was surprised by — don't re-learn these**

- **A bug report's literal framing is often wrong.** "Buttons show in the collapsed card" turned
  out to be an ordering issue *within* the expanded block. Investigate before accepting the
  framing.
- **A "same fix" applied to a similar component often isn't.** `kind === 'transaction'` looked like
  the mirror of `kind !== 'transfer'` and broke the feature completely.
- **Empirical repro beats first-principles reading** for the credit-card engine: one root cause was
  found by running the real functions against synthetic data, after a code read suggested the
  reported behaviour was impossible.
- **When a fix changes one field on a materialised row, check every other field computed from it.**
  The occurrence date fix was tested against dates and balances, and nobody asked what *else* on
  the row was derived from the date. It was the cleared flag.

---
---

# The sync layer

Everything from here on exists **only in this repo**. `src/lib/powersync/**`,
`src/lib/store/powerSyncLedgerStore.ts`, `src/lib/supabaseClient.ts`, `src/context/AuthContext.tsx`
and five components are the whole of it, and every one of them is a listed row in
`DIVERGENCE.md`. Each file opens with a `SYNC APP ONLY` banner.

---

## 36. Why the sync layer is shaped like this

Supabase holds the data (Postgres + RLS + Auth + Storage); PowerSync holds a local SQLite database
on the device, keeps it in step, and queues writes for upload. The app is offline-first: every read
in the app is a read of the **local** database, never the network.

Four apps share one Supabase project, one `powersync_role`, one `powersync` publication and one
PowerSync instance, each in its own schema. Everything this app adds is additive.

**The design constraints that follow from that, and produce most of the rules below:**

1. **The origin is shared.** `personal-f`, both live ledger apps and the test app all live on
   `adamnc02.github.io`, so they share browser storage. Local table names and the local database
   file must be per-app or two apps read each other's rows.
2. **PowerSync resolves conflicts per column.** Two people editing two different fields of one bill
   must both survive, so every UPDATE must be narrow.
3. **A permanently rejected write blocks the upload queue forever.** The connector must discard
   them — and therefore must make that discard loud, or a wrong row disappears silently.
4. **`LedgerContext.tsx` must stay byte-identical** with `personal-ledger`. Everything the sync
   layer needs has to fit behind `LedgerStore`.

```
 React pages ──► LedgerContext ──► LedgerStore
                                      │
                       powerSyncLedgerStore  (first-sync gate, shadow diff,
                          │        ▲          echo suppression, per-device
                          │        │          primaryPersonId)
                   writes.ts    mapping.ts   (AppDataV2 ⇄ rows)
                          │        ▲
                   powerSyncAdapter  (one read txn / one write txn)
                          │
                   @powersync/web  (local SQLite over OPFS)
                          │  connector.ts (JWT + upload queue)
                          ▼
                   Supabase / Postgres  (RLS, schema shared_finance_ledger)
```

---

## 37. The table registry and the Sync Streams

`src/lib/powersync/tables.ts` is **the one list**. `schema.ts` builds the local PowerSync schema
from it, `connector.ts` maps local names back to Postgres ones, and
`scripts/print-sync-streams.ts` prints the Sync Streams YAML from it — so the three can never drift
apart.

27 tables, declared in **FK order, parents first**. Inserts run in that order, deletes in reverse.
Each entry declares its Postgres name, its columns and their kinds, whether it is scoped by
`household_id` (every table but `scenarios`, which is per user), and whether the **app** writes it
(`households` and `household_members` are read-only — functions write them).

> 🚨 **Local names are prefixed `sfl_` on purpose.** `personal-f`'s stream is auto-subscribed and
> outputs `people`, `households`, `household_members`, `loans`, `salary_deductions` and
> `scenarios`. A user of both apps would otherwise get two apps' rows in one local table. Each Sync
> Streams query renames its source with `AS sfl_<table>` — documented PowerSync behaviour: the
> alias maps the table to the new client-side name.

**Deliberately not declared locally:**

- **`id`** — PowerSync adds it.
- **`user_id`** on app tables — it defaults to `auth.uid()` server-side, and a declared column
  would send `user_id: null` over it on upsert.

**Column kinds:** numeric → `real`, so the app gets numbers; boolean → 0/1; `date`, `uuid` and
`jsonb` → `text`. Every array-backed table also carries a `position` (§38).

**The stream** is `shared_ledger_household`, `auto_subscribe: false`, one query per table:
household-scoped tables filter on `household_id IN (SELECT household_id FROM household_members
WHERE user_id = auth.user_id())`; `scenarios` filters on `user_id` directly.

> 🚨 The app connects with `includeDefaultStreams: false` and subscribes to that one stream
> explicitly. `personal-f`'s stream is auto-subscribed and must not download here.

---

## 38. The mapping boundary

`src/lib/powersync/mapping.ts` converts `AppDataV2` ⇄ rows, both directions. It is **pure** — no
PowerSync or Supabase import — so `verify-mapping-nulls.ts` runs it in Node against the real
backups.

**Every rule here fails silently if broken**, because the connector discards constraint-violating
writes. That is why each one has a check.

- **`'' ↔ NULL` on every id-shaped column.** Real data uses `''` for "no owner / no payee";
  Postgres rejects `''` in an FK column. Up: `'' → NULL`. Down: `NULL → ''` where the app type
  requires a string (`ownerId`, `payee` on templates and loans), otherwise the key is omitted.
- **Category ids carry `@<household_id>`.** Appended to `categories.id` and every `category_id`
  going up, stripped coming down. The 35 built-in ids are fixed, so without this two households
  would collide on every one of them. **The app never sees the suffix** — except Listly, which
  stores it verbatim.
- **Derived ids for app items that have none**, so two devices converge on one row (the connector
  upserts on id): pay cycle = the person's id; joint account = the household id; an override =
  `<parent>:<date>`; a calibration line = `<loan>:<date>:<n>`; a deduction =
  `<snapshot>:<deduction>`; a Salary Sort = `sort:<personId>:<payDate>` (§16).
- **Empty optional child lists come back absent**, not as `[]`.
- **`jsonb` is canonical text locally and a JSON *value* on upload.** Send the TEXT SQLite holds
  and Postgres stores a *string*, which syncs back as one.
- **Pot `recurringDeposit*` is not synced** (superseded).
- **Order.** Every array-backed table has a `position`. An append gets `last + 1`; a mid-list
  insert takes the midpoint of its neighbours; **a delete never renumbers**; reads sort by
  `(position, id)`. That is what preserves §12's index-based tie-breaks across a database that has
  no row order.

---

## 39. Narrow writes and the connector

`src/lib/powersync/writes.ts` turns "the app's data changed from A to B" into the smallest set of
row writes and applies them to the local database, which queues them for upload.

> 🚨 **HARD RULE — NARROW UPDATEs ONLY.** Every UPDATE sets only the columns whose value genuinely
> changed. PowerSync resolves conflicts per column (the connector PATCHes only what the local
> UPDATE set), and the whole table split rests on that. **A "write the whole row" shortcut would
> silently destroy that on every table at once.** `verify-powersync-store-diff.ts` proves a
> one-field edit writes one column.

**Order within one save** (FKs are `NO ACTION`):

1. **inserts**, parent tables first in `TABLE_ORDER` — and within `savings_pots`, a pot before any
   pot whose interest goes to it;
2. **updates**, so a reference is re-pointed before its old target goes;
3. **deletes**, child-first.

`src/lib/powersync/connector.ts` is PowerSync ⇄ Supabase:

- `fetchCredentials()` — the PowerSync URL plus the Supabase session's JWT.
- `uploadData()` — drains the local write queue one transaction at a time.
- **A PUT (local INSERT) drops null columns before the upsert.** A PUT only ever creates a row, so
  a null adds nothing on insert; but if the row already exists — two devices inserting one derived
  id — it would blank a column the other device set.
- **`jsonb` columns are sent as JSON values**, per §38.
- **A discarded write is logged loudly and kept** in `ledger:sync:rejected-writes`, never silently
  dropped. The discard itself stays: a write Postgres permanently rejects would otherwise block
  every later write behind it forever.

`src/lib/powersync/database.ts` is the database singleton. It uses **`OPFSCoopSyncVFS`**, not the
default VFS, which PowerSync's own docs flag as unreliable for multi-tab Safari/iOS — and this is a
PWA.

> 🚨 **`dbFilename` MUST differ per app.** OPFS is per **origin**. This app's name comes from the
> build (`VITE_POWERSYNC_DB_FILENAME`): `shared-finance-ledger.db` live,
> `finance-ledger-test-sync.db` in the test app's `/sync/` build, and `personal-finance.db` belongs
> to `personal-f`. **No default**, so a build that forgot it fails loudly rather than sharing a
> file.

`src/lib/powersync/powerSyncAdapter.ts` is the real `SyncDatabase` behind the store: every table
read in **one** read transaction (a consistent snapshot, never half a sync), writes in one write
transaction, and a change callback over this app's tables only.

---

## 40. `powerSyncLedgerStore`

`src/lib/store/powerSyncLedgerStore.ts` implements `LedgerStore` (§4) without changing it.

### The first-sync gate

> 🚨 **Nothing is written until PowerSync reports this app's stream has synced.** `save()` is a
> logged no-op before then, and `load()` does not resolve. Three things write without the user
> touching anything — `defaultLedgerData()`'s seed, `migrateLedgerData()`'s re-added built-ins, and
> `autoClearDuePayments` — and ungated, a device that had not synced would duplicate categories
> across the household and push transactions against an empty ledger.
> `verify-first-sync-gate.ts` proves it.

`SyncRoot` shows "Syncing your household…" until then; the store's own gate is the second lock.

`migrateLedgerData()`'s backfills are **re-derived on every read and never written**. A re-derived
row is only inserted if the user edits it.

### The shadow diff

`save(next)` diffs the store's own **shadow of the database**, not the provider's `prev`. Data the
store delivered through `subscribe` is recognised **by reference** and never written back (echo
suppression).

### Deliveries

Every local or synced change triggers one consistent read of all 27 tables in one read
transaction. **A read that overlapped a save is dropped** — the save's own change triggers the next
read. **The first delivery is `wholesale`**, which bumps `importGeneration` (§5).

### `primaryPersonId` is per device and never syncs

Resolved on every read, in order:

1. a choice made on **this device** (`localStorage['ledger:sync:primary-person:<dbFile>:<userId>']`);
2. otherwise the person whose `linked_user_id` is me;
3. otherwise the first person.

It is **re-preferred on every read**, not only on the first.

### The store decides what an import is

`LedgerContext.setData` is shared code and says nothing about imports. So: **a save is an import
when *none* of its twelve lists is one the store has delivered, loaded or saved before.** Every
real edit keeps at least the lists it did not touch.

> Comparing against the provider's `prev` is **not** enough: when a sync delivery and an edit land
> in one render, `prev` is older than the edit's base and every list looks new — which would re-id
> the whole household.

### The household can change under an open device

Every read checks the synced `household_members`. Once the user has been seen in the session's
household, **losing it suspends the store** — no writes, no deliveries, `onHouseholdLost` — and
`SyncRoot` clears the local copy and boots again. Without this, a stale device re-sent its whole
ledger into the old household (a live test produced 16 RLS rejections). The empty-household screen
also moves on by itself when another device fills the household.

---

## 41. Boot, auth and the rescue

`src/context/AuthContext.tsx` holds the Supabase Auth session. `src/components/AuthGate.tsx` is the
mandatory sign-in screen (Google, or email and password). `src/lib/supabaseClient.ts` is the one
client, scoped to `shared_finance_ledger` **once, here**, so every `.from()` and `.rpc()` targets
the right schema. The publishable key is public by design: **RLS protects the data, not the key.**

`src/components/SyncRoot.tsx` is everything between "the app opened" and "the ledger renders":

```
sign in → ensure_household() → connect (this app's stream only) → wait for first sync
        → empty household? Import / Start fresh / Join : the ledger
```

`ensure_household()` (`src/lib/powersync/household.ts`) creates the household on first call, seeded
server-side with the 35 categories, and is resolved once per user per session, cleared on sign-out
so a different account on the same device never reuses it. **It runs before the first sync counts**,
or the gate would open on a truly empty ledger.

**An empty household is never given a "Me" automatically** — that would be carried into the second
person's join path.

### The rescue

`src/components/LegacyDataMigration.tsx` is the empty-household screen: *Import this device's data*
(only when there is some worth offering) / *Import a backup file* / *Start fresh* / *Join with a
code*. `src/lib/powersync/legacyData.ts` is the reader.

> 🚨 **`ledger:app-data-v2:v1` is read with `getItem` and nothing else, ever.** It is the same key,
> on the same origin, as the offline `personal-ledger` app — a real, unbacked-up ledger.
> `personal-f`'s version of this component removed its old key after importing **and** after "Start
> fresh"; ported as-is, that would delete the offline app's data on any device with both apps.
> "Offered" is recorded under `ledger:sync:legacy-offered:<userId>`.
> `verify-legacy-migration.ts` proves it from the source and from a Storage that records every
> call.

The read still runs `migrateLedgerData`, because a pre-feature backup has no pots, salary sorts or
joint account and must be backfilled before it is anything the app can load.

> **The switch and the rescue ship together.** The moment this app reads from PowerSync, anything
> under the old key is invisible. `scripts/check-sync-build.ts` proves the live bundle carries this
> app's database file, its own stream, `includeDefaultStreams`, the wired-in sync layer **and** the
> rescue, in the same release. `npm run deploy` runs it.

---

## 42. Households, link codes and "Set as me"

`src/lib/powersync/linking.ts` calls the household link-code functions in
`shared_finance_ledger` — `security definer`, the caller only.

**Redeem moves the joiner's OWN data server-side** (their "Set as me" person and everything
attached to it; joint items stay behind). **The local copy does not follow**: the caller clears
this device's database and boots again through the first-sync gate. The redeemer's *other* open
devices find out from synced membership and do the same (§40).

A same-named person left behind comes back as `duplicate_person_id` and is kept on this device
until it is dealt with. `src/components/DuplicatePersonBanner.tsx` resolves it **through the app's
own `DeleteGuardModal`** (§33): everything still pointing at the duplicate has to be moved or
deleted first, deliberately, and only then is the row removed. That is the tested path, and it
means **no second merge implementation**.

### "Set as me" = link + view

The button only changes `primaryPersonId` — shared code, unchanged from the offline app. The
**store** turns that into `people.linked_user_id`, as one-column UPDATEs:

| Case | What is written |
|---|---|
| An **unlinked** row → me | Linked, with my previous row cleared **first** (unique index) |
| A row linked to **someone else** | View only, never taken — **unless I have no linked row at all**, which is how the second person claims their row if the first tapped it before they joined |
| `primaryPersonId` moving because my person was **deleted** | Nothing is written |
| An import, or Start fresh | Links its own new "Me" |

`verify-set-as-me.ts` pins all of it.

---

## 43. Imports, ids, patches and Backup & Restore

### Every import regenerates ids

`src/lib/powersync/importIds.ts`. Every synced table has one table-wide text primary key, so the
same backup imported into two households would give both the same row ids: the second household's
upload is refused and **the connector discards it, silently**.

An import therefore keeps **only** the 35 fixed category ids (already made unique per household by
the `@<household>` suffix) and gives everything else a new id.

> **Why a generic walk and not a list of fields:** the field nobody thought of fails silently.
> Every object in the data that has an `id` gets a new one, and then **every string value anywhere
> in the data** that equals one of the old ids is replaced by its new one — `ownerId`, `payee`,
> `personId`, `potId`, `savingsPotId`, `creditCardId`, `categoryId`, `sourceId`, `transactionId`,
> `followsIncomeSource.pensionId`, `interestDestination.*` and anything added later.
> `auto:<dedupeKey>` ids are **re-derived** from the remapped transaction (§10).

### …unless the file is this household's own (PROMPT-14 Part 4)

`isSameHouseholdPatch` in `powerSyncLedgerStore.ts`. If **any** id in the incoming data is one the
store already holds, the file came from here and was edited: the ids are kept and `diffRows` does
its ordinary narrow work. One field edited is one `UPDATE` of one column — no id churn, no identity
reset, one narrow update on the other phone.

🚨 **Two id classes must never count as evidence**, and dropping either would call a genuinely
foreign backup a patch — the collision above, through the front door:

- the **35 fixed category ids**, which `regenerateIds` keeps on purpose so every household has them;
- **`auto:` and `sort:` ids**, which are derived from the ids inside them, so a match there is
  already being reported by the person or source id it contains.

A hand-trimmed file (rows deleted by hand) still reads as a patch and the diff deletes the missing
rows. That is correct — and it is why the confirm says how many rows will be **deleted**
(`rowsRemovedByPatch`), not only how many replaced.

### A restore must not reassign who everyone is (PROMPT-14 Part 5)

`linked_user_id` is a **server-only column `toRows` never writes**, so a full import deletes every
other member's link along with their row. `linkOps` re-links only the person doing the restore.
Their next read then walks choice → linked → `people[0]`: a dead choice, no linked row, and they
**silently become whoever sorts first, with that person's pay cycle**.

`relinkOps` carries each pre-restore link across to the incoming person with the **same name**
(trimmed, case-insensitive), as narrow one-column updates after the diff has done its deleting.
🚨 **Ambiguous or missing is never guessed:** no match, or more than one, leaves that member
unlinked, the store reports `staleChoice`, and `SyncRoot` asks "which person are you?" on that
device's next boot — the flow a fresh join already uses.

### Backup & Restore

`src/lib/powersync/backup.ts`. One snapshot a day, automatically, to a private bucket at
`<user id>/<yyyy-mm-dd>.json` (the bucket's policies limit each user to their own folder). A second
backup the same day replaces it. **The newest 30 are kept** — `pruneSnapshots`, deliberately a
separate function from `removeAllSnapshots`, which is Delete my app data's and takes no filter.

Since PROMPT-14 there is **one** Backup & Restore, in the Account modal, each button opening one
follow-up step (cloud / this device, cloud / a file). Both restore routes converge on one
`restoreFrom(source)` so they cannot drift, and both are gated on the ledger being present — which
`SyncRoot` only provides after first sync, because restoring into a half-populated shadow would diff
against rows that have not arrived and **delete what it cannot see**.

A snapshot is **the same bytes as the Wallet page's download**: both write paths call
`serialiseLedgerBackup` and both read paths call `parseLedgerBackupJson`. That used to be true by
coincidence — two call sites that happened to agree — and `verify-backup-format-parity.ts` now holds
it as an invariant.

> **Restore replaces the WHOLE HOUSEHOLD on every device**, so it is always a deliberate action
> behind a warning that names the source and says what it replaces, and is **never offered at
> sign-in**.

---

## 44. The divergence register, and the other apps on this project

### `DIVERGENCE.md`

`npm run check:divergence` reads the **Allowed divergence** table, diffs this repo's `src/` against
`personal-ledger/src/`, and **fails on any difference not covered by a listed path**. Keep the
table machine-readable: one path or glob per row, no prose in the path column.

> 🚨 **`DIVERGENCE.md` is NOT in this repo.** It lives at
> `~/Downloads/App Development & Bug Tracking/shared-finance-ledger/DIVERGENCE.md` and
> `scripts/check-divergence.ts` reads it there **by absolute path**. It is one of four files in
> that folder the repos depend on at runtime — the other three are the real backups
> `finance-ledger-backup-2026-09-15.json`, `finance-ledger-backup-2026-09-15-mum.json` and
> `finance-ledger-backup-2026-09-17-mum.json`, which **45 verify scripts across the three ledger
> repos read by absolute path**. Deleting any of the four breaks the sweep.

**Explicitly not allowed to diverge** — a difference here is a bug, not a decision:

- `src/lib/**`, except `src/lib/powersync/**`, `src/lib/supabaseClient.ts` and
  `src/lib/store/powerSyncLedgerStore.ts`
- `src/pages/**`
- `src/components/**`, except the five sync components and `syncControls.ts`
- `src/types/models.ts`
- **`src/context/LedgerContext.tsx`** — the whole point of the store interface. If this file ever
  needs to differ, **stop and reconsider the interface.**

> Two bullets in that file (`src/lib/**` and `src/components/**`) must each stay on **one line**:
> `check-divergence.ts` reads each bullet's first path as the rule and every path after "except" as
> a carve-out, per line.

Out of scope for the register: `finance-ledger-test` (which has its own, `TEST-APP-DIVERGENCE.md`)
and divergences that are only *planned* (those live in `BUILD-PLAN.md`).

### Sync-only verify scripts

| Script | Proves |
|---|---|
| `verify-first-sync-gate.ts` | Nothing written before first sync; wholesale first delivery; per-device `primaryPersonId` |
| `verify-powersync-store-diff.ts` | Narrow writes, echo suppression, positions, FK order, import |
| `verify-mapping-nulls.ts` | Every real backup round-trips; no `''` in an FK column; every written column exists; `jsonb` never sent as a string |
| `verify-legacy-migration.ts` | The rescue runs only on an empty household, is offered once per account, and **never writes or removes `ledger:app-data-v2:v1`** |
| `verify-import-regenerates-ids.ts` | One backup in two households shares no row id; every reference remapped; restoring twice leaves no duplicate |
| `verify-set-as-me.ts` | `linked_user_id` written narrowly, previous row cleared first, a partner's row never taken |
| `verify-salary-sort-sync.ts` | Two devices sorting one payday converge on one sort and one transfer; two people paid the same day get a sort each |

`scripts/lib/fakeSyncDb.ts` is the in-memory stand-in for PowerSync's local database those checks
run against. It is deliberately **not** named `verify-*`, so the in-repo sweep does not pick it up.
`check-divergence.ts` is deliberately not named `verify-*` either, so the sweep does not require
the sibling repo to exist.

### The other apps

| App | Schema | Note |
|---|---|---|
| `personal-f` | `personal_finance` | Its stream **auto-subscribes**, which is why local table names here are prefixed and `includeDefaultStreams` is false |
| `my_dream_clean` | `my_dream_clean` | No relational tables — Supabase Auth plus JSON snapshots in Storage |
| **this app** | `shared_finance_ledger` | 27 tables |
| `listly` | `listly` | **Writes into this schema** — see below |

> 🚨 **`shared_finance_ledger.transactions` has a second writer.** Listly turns a priced shop into
> a transaction via a `security definer` trigger on its own `listly.shop_completions` table. Those
> rows are `type: 'expense'`, `direction: 'out'`, `payment_method: 'card'`, `note` = the shopping
> list's name, with the household's own `category_id` and the `owner_id`/`pot_id` of whichever
> account was picked (null owner for a joint shop). **`source_type` and `source_id` are null**, so
> they cannot be told apart from a hand-entered ad-hoc expense — which is deliberate: they are
> ordinary spend and should behave like it.
>
> They need no special handling. But **any assumption that this app created every row in
> `transactions` is now wrong**, including anything inferring provenance from `source_id`,
> `user_id` or the absence of them.
>
> Listly also depends on this schema's household model. **Before changing `my_household_ids()`,
> `households`, `household_members`, `ensure_household()`, the link-code functions,
> `erase_my_data()`, or the shapes of `people` / `categories` / `pots` / `savings_pots` /
> `joint_account`, read `listly/docs/LEDGER-INTEGRATION.md`. Every failure there is silent.**

---

## 45. Low-balance alerts (PROMPT-14 Part 7)

At **20:00 Europe/London** every evening, one push notification per watched account whose projected
running balance dips below zero at any point in the current pay cycle — repeating each evening until
it clears.

### The rule

`src/lib/shortfall.ts`, **shared with `personal-ledger`** because it is pure arithmetic over the
existing engines and invents no maths of its own.

🚨 **It is the DIP, not the end-of-cycle balance.** `cycleBalanceSeries` walks every day of the
cycle and `findShortfalls` reports the **first** day the projected balance goes below zero. So it
fires on an account that ends the cycle perfectly healthy — which is the entire point, because money
that is £200 short on the 12th still bounces a direct debit on the 12th. The one-line-shorter
end-of-cycle comparison is `verify-shortfall.ts`'s control, and it must keep missing a case the real
rule catches.

| Watched | Not watched |
|---|---|
| Each person's personal current account | `SavingsPot` — entirely. There are **two** pot types and only `Pot` is in scope |
| Every active `Pot` where `isCoinJar !== true` | A Coin Jar. One emptying is it working |
| The joint account | Credit cards. A balance owed is not a balance held |

**Recipients:** the account's owner; joint has two owners. That single sentence is the whole rule,
and a `Pot` is never joint, so a pot alert has exactly one recipient.

### Where it runs, and why there is only ONE engine

The `ledger-alerts` Edge Function runs **this app's own TypeScript**, bundled by
`scripts/build-alert-engine.ts` from `src/lib/powersync/alertEngine.ts` into
`silver-octo-invention/supabase/functions/ledger-alerts/_engine.js`.

PROMPT-14 §0b Q5 originally chose to reimplement the projection in SQL and accepted a second
implementation of pay cycles, loans, cards and round-ups as the cost. **Edge Functions are Deno**,
and this engine is environment-free — every `verify-*` script runs it in Node — so the server runs
the real thing instead. 🚨 **Do not move the logic "closer to the data".** That was considered and
rejected, because the two engines would drift with nothing to say so.

What replaces that risk is mechanical and loud: `verify-alert-engine-bundle.ts` fails the sweep when
the committed bundle is no longer what `src/lib` produces, and proves behaviourally that bundle and
source find the same shortfalls over the three real backups. **After any `src/lib` change the alert
path can reach, run `npx tsx scripts/build-alert-engine.ts`** — the sweep will tell you if you
forget.

`ALERT_TABLES` is derived from the table registry rather than listed in the function, so it cannot
fall out of step with the schema and compute an alert from an incomplete ledger.

### The server side

`20260922120000_shared_finance_ledger_alerts.sql`. Two tables — `push_subscriptions` (one row per
**device**, id derived from the endpoint) and `notification_log` (the claim table, whose `id` **is**
the dedupe key) — and four `service_role`-only functions. Neither table is in the `powersync`
publication and neither may ever be: a push endpoint is a capability URL.

🚨 **The gate is `= 20`, not `>= 20`.** pg_cron runs in UTC, so the job runs hourly and the SQL
returns nothing unless it is the 20 hour in London — no drift across the clock change. The dedupe
makes a looser gate *safe*, which is exactly why someone will loosen it.

🚨 **The dedupe key carries the London date:**
`shortfall:<kind>:<account_id>:<user_id>:<london_date>`. A shortfall is a *state*, not an event.
Listly's keys are event-shaped and are the worked example being copied — drop the date and the alert
fires once and never again.

### The app side

`src/lib/powersync/push.ts` and `pushState.ts`, plus the Account modal's card and `public/sw.js`
(push only; **no `fetch` handler**, so the worker can never pin an old build).

🚨 **The toggle branches on `Notification.permission`, never on toggle history.** Toggling the app
switch off does not revoke the OS permission, so the ordinary second toggle is still `'granted'` and
must just work, silently. Only `'denied'` gets the Settings instruction.

🚨 **The state is per DEVICE.** It reads from whether this browser's own subscription row exists on
the server. A user-level flag would render ON on a second phone that has never registered, and that
phone would then receive nothing while claiming to be on.

**A subscription belongs to a service-worker SCOPE; permission belongs to an ORIGIN.** So this app
and Listly cannot share subscriptions — different registrations — but a phone that already allowed
Listly arrives here already `'granted'` and sees **no prompt**. That is correct, not a bug.

**No email path, ever.** A phone without permission receives nothing, which is why the toggle
distinguishes five ways of being off rather than one.

**There is no deposit alert**, deliberately (§0b Q7, cut 2026-09-22). The hourly cron exists to hit
the 20:00 gate, not as an invitation.

---

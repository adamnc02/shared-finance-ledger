# Decisions — `shared-finance-ledger`, 2026-09-15

Adam's answers to the ten questions in `OPEN-QUESTIONS.md`, with what each one means for the
build. **This document is the authority.** `OPEN-QUESTIONS.md` is kept as the record of what was
asked and why; where the two disagree, this one wins.

Three answers changed the plan materially (Q2, Q5, Q9). Two were confirmed against the real backup
files rather than taken on trust (Q6, Q7).

---

## Q1 — Schema and bucket naming ✅ RENAME

**Decision: rename. Drop the old tables, start clean.**

A migration will:
- `drop schema personal_finance_ledger cascade` — removes all 17 tables from
  `20260831120002`. Verified empty; no app code, no data, not in the `powersync` publication.
- Delete the `personal-finance-ledger-backups` bucket and its three storage policies.
- Create `shared_finance_ledger` schema + `shared-finance-ledger-backups` bucket, with the same
  grants and `ALTER DEFAULT PRIVILEGES` pattern `20260831120001` used.

**Explicitly untouched:** `personal_finance`, `my_dream_clean`, `public`, and every storage bucket
except `personal-finance-ledger-backups`. The drop is named-schema-scoped — it cannot reach
another schema. This will be restated in the written migration description before it runs.

---

## Q2 — Normalisation ✅ HYBRID, split on "is this array ever written alone?"

**You asked what would not sync under the hybrid. Answer: nothing.** Every field reaches every
device either way. I had framed this imprecisely — the real difference is not coverage, it is
*conflict granularity*, and it is narrower than I first described.

**Why.** `personal-f`'s connector turns a PowerSync `PATCH` into
`supabase.from(table).update(op.opData).eq('id', op.id)`, where `op.opData` holds **only the
columns the local `UPDATE` actually set**. Because `writes.ts` issues narrow updates
(`UPDATE people SET name = ?`), two devices editing two *different columns of the same row* both
survive. Conflicts are effectively per-column, not per-row.

So normalising a child array into its own table helps in exactly one case: **a user action that
writes the array without touching any scalar on the parent row.** If the action also sets a
scalar, the parent row is in the write anyway and a separate table buys nothing.

**That is the dividing line, and it produces a cleaner split than "important vs unimportant":**

**Own table** (written alone — two people can touch two different children with nothing else
changing): `salary_snapshots`, `salary_deductions`, `salary_overrides`,
`recurring_template_occurrence_overrides` *(your carve-out — agreed, and the reasoning generalises
to the two below)*, `pension_occurrence_overrides`, `savings_pot_recurring_deposit_overrides`,
`savings_pot_interest_overrides`, `loan_overpayments`, `loan_statement_calibration_lines`,
`credit_card_lump_payments`, `credit_card_minimum_payment_overrides`, `salary_sort_targets`.

**jsonb on the parent** (only ever written by the effective-dated change flow, which always sets a
scalar on the same row in the same action): `amountHistory`, `locationHistory`,
`monthlyPaymentHistory`, `interestHistory`, and the whole `recurringOverpayment` object including
its three sub-arrays.

**Total: 25 app tables + 3 household tables = 28** *(corrected 2026-09-19: the list always named 25)*. Full normalisation would be ~38. The nine
saved are the pure effective-dated history arrays — the fiddliest to normalise and the ones with
zero conflict benefit. It also means `EffectiveDatedChangeFlow.tsx` and `lib/locationChange.ts`
keep working on the shape they use today.

**The only remaining loss case:** two devices writing the same jsonb column before either syncs —
the later writer's whole array replaces the earlier one's. In practice that means two people
editing the *same bill's scheduled amount change* within the same sync window.

**Standing rule this creates:** every mutation in `writes.ts` must issue a narrow `UPDATE` setting
only genuinely-changed fields. A "write the whole row" convenience helper would destroy the
per-column property across every table at once.

---

## Q3 — What's shared ✅ EVERYTHING, and pay cycles already work the way you want

**Decision: all data household-shared. Scenarios are the one exception (Q4).**

**On pay cycles — the behaviour you describe is already the design, and it needs no special
casing.** `PayCycleConfig` is keyed `personId`, one row per person. So:

- **The rows are shared.** Both devices hold both pay cycles. That is necessary, not incidental —
  the household/joint views need to resolve the other person's cycle to render at all.
- **Which one you *see* is per-device**, selected by `primaryPersonId`, which stays purely local
  and is never a column. Your device resolves to your row (payday = last working day of the
  month); Ella's resolves to hers (every 4 Thursdays).
- `paydayDayOfMonth` / `paydayAdjustForNonWorkingDay` / `cycleStartFollowsPayday` already express
  both patterns, and Ella's `payFrequency: 'four_weekly'` is already in your backup.

**I checked `personal-f`'s migrations as you asked. There is no pay-cycle mechanism there to
copy** — `personal_finance` has only `people`, `salary_deductions`, `savings_entries`, `bills`,
`loans`, `scenarios`. No `pay_cycles` table exists, and salary lives as columns directly on
`people`. `personal-f` is a substantially simpler app, so its migrations are a **shape** template
(household tables, `linked_user_id`, the self-link trigger, the merge-aware redeem function), not
a scale template. Nothing about per-person pay cycles is solved there.

**What actually makes "set as me" work across devices** is `people.linked_user_id`
(`20260901150000`): a nullable uuid, enforced by trigger to only ever equal `auth.uid()`, with a
unique index on `(household_id, linked_user_id)`. Your device sets it on your row, Ella's on hers.
`primaryPersonId` then defaults to "the row linked to me".

**The `personal-f` bug you're thinking of is fixed, and the fix is what we copy.** You're right
that Ella clicking "set as me" pushed through to your phone. `AppContext.tsx:131-146,169-177` is
the resolved version, and four things make it work — all four are needed here:
- `primaryPersonId` is `useState`, never persisted and never a column. Purely per-device.
- The effect matches `p.linkedUserId === session?.user.id` — **scoped to the signed-in user**.
  Matching "any row with a `linkedUserId`" is what made Ella's action move your view.
- A `manualSelection` ref separates a real user choice from the effect's own corrective assignment,
  so active re-preference doesn't fight a deliberate override.
- `setAsMe` clears the previous row's `linked_user_id` before setting the new one, so the
  `(household_id, linked_user_id)` unique index can never collide.

**The remaining trap, already experienced on `personal-f` and directly applicable here**
(`MIGRATION-LESSONS.md` §23): the effect choosing `primaryPersonId` must **actively re-prefer the
linked-to-me row on every `people` update**, not merely check the current value is still valid.
During a resync PowerSync can briefly deliver the *other* person's row first; an effect that only
checks validity locks onto it permanently, because by then it is a perfectly valid person. With
per-person pay cycles that failure shows up as *your device silently rendering Ella's pay cycle* —
a much louder symptom here than it was on `personal-f`.

---

## Q4 — Scenarios ✅ PER-USER, not shared

Matches `personal-f`. Scenarios stay `auth.uid() = user_id` RLS and get their own Sync Streams
line scoped by `user_id` rather than the household join. No `household_id` column on `scenarios`.

Your backup has 3 scenarios, all loan-targeted planning — consistent with "not real data".

---

## Q5 — Deletes ✅ RESTRICT + a forced reassign flow, built in the TEST APP FIRST

**Decision: `RESTRICT`, where "restrict" means the app blocks the delete and makes you reassign
first. Built and signed off in `finance-ledger-test` before any Supabase work starts**, because it
is app behaviour that belongs in both live apps, not a sync concern.

Applies to:
1. **Deleting a person** who owns pensions / savings pots / pots → blocked; reassign or delete
   those first. (Today they are silently left dangling — `reconcilePersonReferences` only handles
   templates/loans/credit cards.)
2. **Deleting a `Pot`** referenced by any template/loan/transaction with `location: 'pot'` →
   blocked. New gap with no current handling; `location: 'pot'` with a dead `potId` is not a state
   the ledger code expects.

Two related items that are **not** `RESTRICT`, deliberately:
3. **Historical transactions referencing a deleted person** → `ON DELETE SET NULL`. A transaction
   is a historical fact; blocking a person-delete on their entire transaction history would make
   the reassign flow unusable.
> *As built 2026-09-19 (PROMPT-08): item 3 is "no foreign key" rather than SET NULL. History keeps the id exactly as the offline app does, and an FK would make PowerSync silently discard deletes and imported history. See DATA-MODEL-REVIEW's AS BUILT.*

4. **Pending transactions orphaned by deleting their generator** → delete the pending ones, keep
   cleared ones with `source_id` nulled. Confirmed against real data: both backups contain
   dangling `sourceId` values, all on *cleared* rows (see `DATA-MODEL-REVIEW-2026-09-15.md`
   §11.2), so this rule only ever touches rows the app can safely regenerate.

---

## Q6 — `savingsEntries` ✅ CONFIRMED DEAD — DROP

Verified in both backups: `savingsEntries: []` on all three people. No transaction has
`type: 'savings_contribution'`. No transaction has `sourceType: 'savings_entry'`.

**Drop entirely** in `shared-finance-ledger`: no table, no columns, and remove `SavingsEntry`, the
`'savings_contribution'` type and the `'savings_entry'` sourceType from this app's `ledger.ts`
plus their read paths in `legacyBridge.ts` / `lib/savings.ts` / `clearTransaction.ts`.

~~**Leave them in `personal-ledger`.**~~ **Superseded 2026-09-17 (Adam): drop it everywhere, to keep
the codebase clean.** Removing it only from the sync app would have made `LedgerContext.tsx`,
`types/models.ts`, `pages/Scenarios.tsx` and six `src/lib/` files diverge, all of which
`DIVERGENCE.md` says must stay identical. So it was removed in `finance-ledger-test` first, then both live
apps, as ordinary signed-off work. **It's not a divergence.**
- **Migration:** `migrateLedgerData` drops the key from every person, and nothing else changes
  (`verify-savings-entries-removed.ts`, both real backups).
- **Also removed:**
  - `lib/savings.ts`, `lib/savingsLedger.ts`;
  - `lib/clearTransaction.ts`, whose only remaining side effect was the goal one;
  - the What-if "lump sum toward a savings goal" action. **Rebuilding What-if against savings pots
    is a PROMPT-07 job, before the copy.**

---

## Q7 — `Pot.recurringDeposit*` ✅ CONFIRMED UNUSED — DROP

Your only `Pot` has exactly: `active, categoryIcon, categoryIconColor, color, id, name,
openingBalance, openingDate, personId`. No `recurringDeposit*` key present at all. Consistent with
the type's own comment that a recurring deposit into a Pot is a `RecurringTemplate` with
`kind: 'transfer'` — which your backup confirms ("Bills Deposit", `transferTo: {type: 'pot'}`).

**No `recurring_deposit_*` columns on `pots`.** Keeping them on `savings_pots`, which is not
marked superseded — nullable and unused for now.

---

## Q8 — Divergence management ✅ REGISTER + CHECK SCRIPT + a structural suggestion

Agreed on the running document. `DIVERGENCE.md` is created in this folder, and updating it is a
**hard rule**: any commit that makes the two live apps differ must add its entry in the same
commit.

**Beyond what you asked, three recommendations:**

**1. A check script, not just a document.** `scripts/check-divergence.ts` in
`shared-finance-ledger` diffs its `src/` against `personal-ledger`'s and fails on any file that
differs but is not listed in `DIVERGENCE.md`. The register then stops being a thing to remember
and becomes a thing the build enforces. Roughly an hour to write; without it, drift is silent.

**2. Make the divergence structural instead of textual — the higher-value option.** Rather than
two copies of `LedgerContext.tsx` that slowly drift, extract persistence behind one interface:

```
LedgerContext  →  LedgerStore (interface)
                    ├── localStorageLedgerStore   (personal-ledger)
                    └── powerSyncLedgerStore      (shared-finance-ledger)
```

`LedgerContext` keeps the whole ~70-function API and all the business logic; only *where rows go*
changes. The diff between the two live apps then collapses to **which store is wired in
`main.tsx`, plus the presence of `src/lib/powersync/` and the auth components** — a handful of
files instead of a scattered set of edits. It also makes the test app's job trivial (below).

Worth going further, if you want it: with that interface in place the two live apps could be the
**same codebase deployed twice** behind a `VITE_SYNC_ENABLED` flag, since Vite dead-code-eliminates
on `import.meta.env` constants so `personal-ledger`'s bundle would not ship the PowerSync code.
That removes the divergence problem rather than managing it — but it collapses three repos into
two and changes the deployment model you have just set up, so I would not do it without you
explicitly choosing it. **Decision (Adam: "happy to take your recommendation"): do (2) now, keep three repos, leave the
single-codebase option open.** So `BUILD-PLAN.md` Phase 0.6 (PROMPT-06) extracts `LedgerStore` in
the test app *before* the copy, and adds the `VITE_SYNC_ENABLED` flag (test app only) in the same
prompt. *(Originally numbered Phase 0.3/0.4; renumbered when PROMPTs 03–05 were inserted.)*

**3a. A hard rule, at Adam's request — added to BOTH info docs.** Before starting any development
work, the session must **ask which app (or apps) the change is for** — test-only,
`personal-ledger`, `shared-finance-ledger`, or all three — and must not assume. The test app then
mirrors whichever target was named. This is now in the HARD RULES of both
`SHARED-FINANCE-LEDGER-INFO.md` and `PERSONAL-LEDGER-INFO.md`.

**3. For flicking between versions in the test app:** with the store interface in place, add
`VITE_SYNC_ENABLED` to `finance-ledger-test` and two npm scripts — `npm run dev` (offline) and
`npm run dev:sync` (syncing) — off one branch. Two branches would drift and force you to re-apply
every fix twice; an env flag cannot drift, because both modes build from the same source.

---

## Q9 — Users and first-run behaviour ✅ WITH ONE CORRECTION

**Confirmed:** your backup (`finance-ledger-backup-2026-09-15.json`) is the seed for the new app.
Today's live users are you and your mum; mum stays on `personal-ledger` and is never asked to sign
in to anything.

**First sign-up on your own device — exactly as you describe.** `LegacyDataMigration` runs, finds
the synced household genuinely empty, finds your `ledger:app-data-v2:v1` data, and offers
**"Import my existing data"** or **"Start fresh"**. Blocking prompt; old key cleared either way so
it never asks twice. This is `MIGRATION-LESSONS.md` §24's component, ported directly.

**Second device — this is the one thing I'd change.** You said "if I log in on another device, I
should be asked to restore from last backup." I'd recommend **not** doing that, and here is why:

- PowerSync already delivers the household's data to device 2 automatically on sign-in. There is
  nothing to restore — the data arrives by sync, usually within seconds.
- A restore prompt at that moment is actively dangerous: cloud restore **replaces data for the
  whole household**, not just that device, because every write syncs onward. Offering it routinely
  at sign-in puts a "wipe the household and roll back" button in the most common flow in the app.
- It would also fire for Ella on her very first sign-in after redeeming your link code — the exact
  moment she should be receiving your data, not being asked to overwrite it.

**AGREED (Adam, 2026-09-15): signing in on an already-registered account pulls the most recent
synced data automatically and ignores local data. The explicit requirement: it must not push empty
data to the sync stream.**

- **Device 2, empty household** → the import-or-start-fresh prompt (same component as first
  sign-up). Covers Ella arriving with her own local data before linking.
- **Device 2, non-empty household** → no prompt, no local-data question. Sync, with a visible
  "Syncing your household…" state so it doesn't just look empty for a moment.
- **Restore from a cloud backup stays a deliberate manual action** in Account & Data, behind a
  confirmation stating plainly that it replaces data for the whole household.

**🚨 The empty-data hazard is real and needs an explicit gate — this is the riskiest single thing
in the whole build.** `LedgerContext` boots from `defaultLedgerData()`, which seeds the four
built-in categories, and `migrateLedgerData()` re-adds any missing built-in on *every* load. On a
device that signs in before its first sync lands, the local database is empty, so left ungated:
- built-in categories get inserted again, duplicating them household-wide;
- `autoClearDuePayments` — which runs on every data change and **writes** — could materialise
  transactions against an empty ledger and push them up;
- any other default-writing effect does the same.

**Required (Plan 3.3a):** the store performs **no write of any kind** until PowerSync reports
first sync complete (`hasSynced` / the `syncStatus` stream). Until then the app renders the
syncing state rather than a seeded-empty ledger. Built-in category seeding happens once,
server-side at household creation, never per-device on boot. `autoClearDuePayments` is gated on
the same flag.

---

## Q10 — Feature freeze ✅ YOUR APPROACH, AND IT'S BETTER THAN A FREEZE

**Your proposal — weekly-average until ~2 months of history, then switch to median — is sound, and
it needs no freeze at all.**

I checked: the forecast toggle is `useState` in `Home.tsx` (line 260), not persisted, and
`averageSpendForecast.ts` computes entirely from existing `transactions`. **The median work adds
no persisted field**, so it does not touch `AppDataV2`, the migration, or the mapping layer. Build
it whenever you like, in the test app, in parallel with the Supabase work.

On the auto-switch itself: it's a good instinct, and it removes the thing that made the median
awkward to ship (a median over 2–3 data points is worse than a mean, not better). Two details
worth settling when it's built — best handled in that session, not now:
- **Threshold in weeks, not months**, consistent with the existing week-aligned window
  (`weekAlignedWindowStart`) — 8 whole weeks rather than "2 months".
- **Say which mode is active** in the forecast's own tooltip/label, so a number that changes
  methodology mid-cycle doesn't look like a bug.

Trends is live, so nothing else is in flight. **No data-model freeze needed** — but the rule still
stands that anything genuinely adding or changing a field in `AppDataV2` gets raised before it
lands, so the migration isn't chasing a moving target.

**One exception to "no freeze": Phase 0.1/0.1a** (`BUILD-PLAN.md`) touch the effective-dated
history arrays and add `recordedSeq` to `SalarySnapshot`. Those are data-model changes, but they
are prerequisites *of* the migration rather than competition with it, and they land in both live
apps as ordinary signed-off work.

---

## The `docs/` files ✅ RESOLVED — four files, one pair per app

`silver-octo-invention/docs/` is empty because these were never written, the ledger migration
having been outstanding. The template is BLOC's own `super-duper-octo-barnacle/docs/`:
**`SUPABASE.md`** (a written schema/RLS/sync reference — tables by module, the RLS model, the sync
layer, snapshots, GDPR functions, how to apply the migrations) and **`bloc-erd.html`** (a
self-contained interactive ERD — SVG, pan/scroll, colour-coded by ownership, filter buttons).

**To produce, per Adam: one pair per app, four files total.**

| File | Covers |
|---|---|
| `personal-finance-SUPABASE.md` | the live `personal_finance` schema |
| `personal-finance-erd.html` | same |
| `shared-finance-ledger-SUPABASE.md` | the new `shared_finance_ledger` schema |
| `shared-finance-ledger-erd.html` | same |

The `shared-finance-ledger` pair gets written **alongside** the migrations that create the tables
(Plan 2.5), not retrofitted; the `personal-finance` pair is backfilled from its existing live
schema in the same session. `my_dream_clean` needs neither — it has no tables.

---

## What this changes in the other documents

| Document | Change |
|---|---|
| `DATA-MODEL-REVIEW-2026-09-15.md` §4 | Table split rewritten per Q2; final 29-table list |
| `DATA-MODEL-REVIEW-2026-09-15.md` §5 | `RESTRICT` + reassign decision per Q5 |
| `DATA-MODEL-REVIEW-2026-09-15.md` §11 | New — findings from the two real backups |
| `DIVERGENCE.md` | New — the register per Q8 |
| `BUILD-PLAN.md` | New — sequenced hand-off plan |

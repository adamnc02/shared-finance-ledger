# Shared ledger — the phase register and the standing risks

**This is not a plan any more. The build is finished** — all nine phases shipped, and
`shared-finance-ledger` has been live in production since 2026-09-20.

It is kept, and slimmed to this, for exactly two reasons.

> ## 1. 🚨 The phase numbers are identifiers the SHIPPED CODE uses
>
> `BUILD-PLAN 3.3a`, `4.4`, `4.5`, `2.3`, `Phase 1`, `Phase 7` are cited **by number** from about
> thirty places — live `src/` files in two repos, the verify suite, `TECHNICAL.md`, the registers,
> `.env.production`, and **one applied migration that can never be edited**
> (`20260919200400_shared_finance_ledger_functions.sql`).
>
> The most important of them: `powerSyncLedgerStore.ts` explains the app's single most dangerous
> invariant — the first-sync gate — by pointing at **3.3a**. Delete that number and the code's
> explanation of why it must never push an empty row into a populated household points at nothing.
>
> **So: never renumber a phase.** Append and annotate, the same rule `MIGRATION-LESSONS.md` and
> `APP-KNOWLEDGE.md` live under.

> ## 2. The standing-risks register is not duplicated anywhere
>
> `TECHNICAL.md` carries every one of those risks **individually**, in the section it belongs to.
> What it does not carry is the **index** — one list of everything on this project that fails
> *silently*. That list is below, and it is the reason to open this file.

## What was removed on 2026-09-23, and where it went

| Removed | Why, and where it is now |
|---|---|
| The session log — **3,126 lines, 82% of the file** | Pure history. The outcome of every session is in the code, `TECHNICAL.md`, and the registers |
| The prompt index | It pointed at PROMPT-01 … PROMPT-16, all of which were retired once their work shipped and was documented |
| "Current baseline" | `TECHNICAL.md` §34 owns the verify counts now, beside the suite it counts |
| "Session protocol" | The `app-session` skill and `SHARED-FINANCE-LEDGER-INFO.md` own it |

**The only work still open is `PROMPT-17-average-spend-forecast-median.md`** — the median forecast,
which was step 1 of the 2026-09-21 execution order and was skipped while steps 2–4 all shipped.

> **A note on the phase descriptions below.** They are written in the future tense, as plans, because
> that is what they were. **Every one of them is done.** Read them as the record of what was
> intended and why — the record of what was actually *built* is the code and `TECHNICAL.md`. Where
> the two disagree, the code wins.

---

## Phase 0 — Test-app groundwork (no Supabase)

Ordinary signed-off work, deployed to both live apps. Doing it now is deliberate: it is far
cheaper while the data model is still one blob.

- **0.1 — Credit card stranded balance + home-ledger pending charges + 100% due display**
  (PROMPT-01). Three parts. Affects cards with **no statement window** (both of mum's) or with a
  manual override. Would have broken on its own at the October clock change regardless.
- **0.2 — Salary-snapshot `recordedSeq`, and bill single-occurrence date moves** (PROMPT-02). Two
  tasks, both "identity keyed off something mutable".
  **Task A:** the one order-dependent array becoming a real table. **Do not sort or de-duplicate
  history arrays** — Adam ruled that out permanently on 2026-09-15; the design self-heals by
  resolving correctly.
  **Task B (added 2026-09-16, reproduced end-to-end):** moving a single bill occurrence's date
  doesn't update "Manage upcoming payments" (`scheduledTemplateDates` ignores `occurrenceOverrides`
  by design, `date` included), and a **second** move writes a duplicate cleared transaction —
  `reconcileRecurringTemplateTransactions`' two-way date match only survives one move, and
  `dedupeKey` is keyed on the mutable date. **B2 corrupts balance data; do it first.**
- **0.3 — Household "Group by Person" → cycle-outer** (PROMPT-03). Joint was redesigned 2026-09-14;
  Household was never migrated. The mechanism (`CycleGroupedList groupByPerson`) already exists.
- **0.4 — Savings pot fixes** (PROMPT-04). Trend-chart hit-test offset by SVG letterboxing; tooltip
  carries no transaction detail; **and** `creditingFrequency` silently saving as Monthly
  (`Salary.tsx:468/688`) — Adam scheduled this on 2026-09-15 for both apps before the copy.
- **0.5 — Delete-reassign flows** (PROMPT-05). `RESTRICT` behaviour, per Q5.
- **0.6 — `LedgerStore` interface + `VITE_SYNC_ENABLED`** (PROMPT-06). Extract persistence behind
  one interface; `useLedger()`'s public API byte-identical. This is what keeps the two live apps
  from drifting. Test app only: the flag, a "SYNC MODE" badge, and a two-build deploy (root = offline,
  `/sync/` = sync mode). This creates the first `TEST-APP-DIVERGENCE.md` rows.

**Gate:** `tsc -b` clean, full sweep green, signed off in the test app, merged to both live apps.

---

## Phase 1 — Copy the app into the repo (PROMPT-07) — ✅ **DONE 2026-09-17** (built, not pushed)

Kept for the record; the outcome of each step is in the session log at the bottom.

1. `git checkout main` in `shared-finance-ledger` — **ask Adam first**; normally forbidden, this
   is the one-time carve-out to materialise a working tree. **What actually worked was
   `git checkout -B main origin/main`**: local `main` was unborn, so a plain checkout is a no-op.
2. Copy `personal-ledger`'s tree, excluding `.git/`, `node_modules/`, `dist/`,
   `pensions-and-wallet-redesign.patch`. **Keep the existing app icon** — it is the
   apple-touch-icon.
3. Rename in `package.json` / `index.html` / `README.md`; set the Pages base path. Confirm
   `npm install && npx tsc -b && npm run build` clean before anything else.
4. ~~Apply the `savingsEntries` removal (Q6).~~ **Done 2026-09-17 in all apps instead** (Adam:
   drop it everywhere). No divergence, no `DIVERGENCE.md` rows.
4a. **Before the copy (Adam, 2026-09-17):** rewire What-if scenarios to savings pots (the old
   savings-goal action was removed with `savingsEntries`), in the test app, then `personal-ledger`.
   Then **pause for Adam to test and sign off** before any code is copied. See PROMPT-07.
5. Add `scripts/check-divergence.ts` — diffs `src/` against `personal-ledger` and fails on any
   file that differs but is not listed in `DIVERGENCE.md`.

**Copy point:** take the copy from `personal-ledger` `main` at or after **PROMPT-06's merge
([PR #11](https://github.com/adamnc02/personal-ledger/pull/11))**. `6b4d9112` (Batch 20) is too old:
it has no `LedgerStore`, so the copy would start with persistence inside `LedgerContext.tsx`.

### Expected divergences (planned, not yet real)

`DIVERGENCE.md` records only differences that actually exist. These are the ones the plan expects.

**Realised 2026-09-17 (PROMPT-07 Part 2) and moved out of this table into `DIVERGENCE.md`:**
`index.html`, `README.md`, `public/**` (manifest, three icon PNGs, and `favicon.svg` deleted here)
and `package.json` — all of them app name, icon or docs. `package.json` keeps its row below too,
because PROMPT-09 widens it for the sync dependencies. `scripts/check-divergence.ts` is a new,
unplanned row: the check itself, which only this repo has.

**Still expected, not yet real:**

**`src/context/LedgerContext.tsx` is store-agnostic as of PROMPT-06 (2026-09-17).** It never
touches `localStorage` or `loadLedgerData`/`saveLedgerData`. It takes a `store?: LedgerStore` prop
(`src/lib/store/LedgerStore.ts`) and defaults to `localStorageLedgerStore`. So it has no row here
and must never get one. The sync app differs only in the store `App.tsx` passes in. The
interface already carries what PROMPT-09 needs: async `load`, `save(next, prev)` for narrow
UPDATEs, and `subscribe(data, wholesale)` bumping `importGeneration` (§1.6).
**Add each row to `DIVERGENCE.md` in the same commit that makes the difference real**, and drop or
correct any that turn out unnecessary.

| Path / glob | Expected type | Reason | Arrives in |
|---|---|---|---|
| `src/lib/powersync/**` | sync-app-only files | The PowerSync client layer. No offline equivalent. | PROMPT-09 |
| `src/lib/supabaseClient.ts` | sync-app-only file | Supabase client. | PROMPT-09/10 |
| `src/context/AuthContext.tsx` | sync-app-only file | Auth session state. | PROMPT-10 |
| `src/components/AuthGate.tsx` | sync-app-only file | Mandatory sign-in gate. | PROMPT-10 |
| `src/components/AccountModal.tsx` | sync-app-only file | Account & Data / sign-out / cloud backup UI, **and the household link-code UI** (Adam, 2026-09-17 — one modal, not two). See Phase 4.4. | PROMPT-10 |
| ~~`src/components/LinkHouseholdModal.tsx`~~ | — | **Dropped 2026-09-17.** The link-code UI lives inside `AccountModal.tsx` instead, so this file is not expected to exist. | — |
| `src/components/LegacyDataMigration.tsx` | sync-app-only file | First-sign-in local-data rescue (`MIGRATION-LESSONS.md` §24). | PROMPT-10 |
| `src/components/DuplicatePersonBanner.tsx` | sync-app-only file | Flags a duplicate left by merge-on-redeem. | PROMPT-10 |
| `src/components/PullToRefresh.tsx` | sync-app-only file | Forces a real sync check; meaningless offline. | PROMPT-09/10 |
| `src/App.tsx` | small diff | Pass `powerSyncLedgerStore` to `<LedgerProvider store={…}>` and mount `AuthGate` around it. **Decided in PROMPT-06: `App.tsx` is the one wiring file**, since it already renders `LedgerProvider` and `AuthGate` must sit next to it. `src/main.tsx` stays identical. Should stay a few lines. If it grows, the store interface is leaking. | PROMPT-09/10 |
| `package.json` | small diff | `@powersync/web`, `@supabase/supabase-js`. The name, and the `check:divergence` script, are already real. | PROMPT-09 |

---

## Phase 2 — Supabase schema (PROMPT-08) — ✅ **DONE 2026-09-19**

As built: `silver-octo-invention/docs/shared-finance-ledger-SUPABASE.md`. Differences from the plan below are in DATA-MODEL-REVIEW's "AS BUILT" box and this session's log entry.

Every migration gets a written description to Adam **before** it runs.

- **2.1 Rename migration** — drop `personal_finance_ledger` schema (cascade) + its bucket and
  policies; create `shared_finance_ledger` + `shared-finance-ledger-backups`. State explicitly
  that `personal_finance`, `my_dream_clean` and `public` are untouched.
- **2.2 Household infrastructure** — `households`, `household_members`, `household_link_codes`
  (permanent/reusable codes), `ensure_household()`, `create_household_link_code()` (idempotent),
  `regenerate_household_link_code()`, `redeem_household_link_code()` (merge-aware), and
  `my_household_ids()` as **`SECURITY DEFINER` + `language plpgsql`** — never `language sql`.
- **2.3 App tables** — the 26 from `DATA-MODEL-REVIEW-2026-09-15.md` §4, ordered per §8.
  `people.linked_user_id` + self-link trigger + `(household_id, linked_user_id)` unique index in
  the **same** migration as `people`.

  **🚨 PowerSync constraint (confirmed 2026-09-15, docs.powersync.com/usage/sync-streams):
  every synced table needs a primary key column literally named `id`, of type `text`.** That
  changes two planned tables: `pay_cycles` (planned PK `person_id` → needs its own `id text` PK
  plus `UNIQUE(person_id)`) and `joint_account` (singleton → still needs an `id text`). Audit all
  26 for this before writing the SQL.

  **Delete-my-app-data-ready FKs (Adam, 2026-09-16):** every reference to `auth.users`
  (`user_id`, `created_by`, `last_redeemed_by`, `linked_user_id`) is `ON DELETE SET NULL`, never
  `CASCADE` or the implicit `RESTRICT`. Also write `shared_finance_ledger.erase_user_data(uid)` here
  (`security definer` + `plpgsql`, row-count summary, no `service_role`). No closure log and no
  Edge Function: the login is never deleted. See `DELETE-APP-DATA-SHARED-FINANCE-LEDGER.md`.

  Also: `household_id uuid not null` everywhere except `scenarios`; `user_id` for attribution
  only; `source_id` **not** a foreign key; `transactions.location` allows `'savings'` while
  `recurring_templates`/`loans` do not; `salary_snapshots.recorded_seq` from PROMPT-02.
- **2.4 RLS** — every table via `my_household_ids()`. **Audit every table with an FK into
  `people`** — `personal-f` missed two and would have silently hidden a partner's pension
  deductions.
- **2.5 Schema docs** — four files in `silver-octo-invention/docs/`, one pair per app, following
  BLOC's `SUPABASE.md` + `bloc-erd.html` pattern. Write the ledger pair alongside the migrations.
- **2.6 Data API smoke test** — Adam does **TASK 1**, then a real `.rpc()` call immediately.

---

## Phase 3 — PowerSync (PROMPT-09) — ✅ **DONE 2026-09-19** (see the session log; the live app is deliberately not switched until PROMPT-10)

- **3.1** Extend the existing role/publication/instance. Adam does **TASK 2** and **TASK 3**.
- **3.2** Sync Streams (`config: edition: 3`), additive block. **27 synced tables** *(as built 2026-09-19)*: 26
  household-joined, plus `scenarios` scoped by `user_id`. `household_link_codes` is never synced. **Every table carries
  its own `household_id`**, so no stream joins through a parent. **Never alias the source table.** Adam does **TASK 6**.
- **3.3** Client layer mirroring `personal-f`'s six files, then `powerSyncLedgerStore` behind the
  Phase 0.6 interface.
  - **`'' ↔ NULL` mapping both directions** — real data has ~80 rows with `ownerId: ''` /
    `payee: ''`; an FK rejects `''` with a 23503, which the connector treats as fatal and
    **silently discards**. Write `verify-mapping-nulls.ts` round-tripping both real backups.
  - **Narrow `UPDATE`s only** — per-column conflict resolution is the basis of the whole table
    split. Comment this at the top of `writes.ts`.
- **3.3a 🚨 First-sync gate** — no write of any kind until PowerSync reports first sync complete.
  `defaultLedgerData()` seeds built-in categories, `migrateLedgerData()` re-adds missing ones on
  every load, and `autoClearDuePayments` **writes** on every data change. Ungated, a pre-sync
  device duplicates categories household-wide and can push transactions against an empty ledger.
  Built-in seeding happens once, server-side, at household creation.
- **3.3b Bump `importGeneration` on first sync.** `Salary.tsx`/`Bills.tsx`/`Loans.tsx` resync
  derived UI state only when it changes; a first sync delivers a whole dataset without ever
  calling `setData`, so those pages render stale state. See `APP-KNOWLEDGE.md` §1.6.
- **3.4 `primaryPersonId` effect** — copy `personal-f`'s resolved version
  (`AppContext.tsx:131-146,169-177`): `useState` only, match on
  `p.linkedUserId === session?.user.id`, a `manualSelection` ref, and `setAsMe` clearing the
  previous row first.

---

## Phase 4 — Auth and the data-safety prerequisites (PROMPT-10) — ✅ **DONE 2026-09-20, live**

- **4.1** Auth ported from `personal-f`. Adam does **TASK 5** (all three parts). Add
  `…/finance-ledger-test/sync/` to the Supabase Auth redirect URLs too (`TEST-APP-DIVERGENCE.md`).
- **4.1a Account modal + "Delete my app data" — SAME SESSION as 4.1** (Adam, 2026-09-16). Sync
  features are tested with real test accounts on the live project, so no test account may exist
  before it can be deleted from inside the app. Copy `personal-f`'s Account button + `AccountModal`
  as-is (rewired only), add **Delete my app data** (two confirmation modals, instant, no queue,
  login kept; every account can delete its own). All decisions made:
  `DELETE-APP-DATA-SHARED-FINANCE-LEDGER.md`. If any session before
  PROMPT-10 needs a signed-in test account, this moves forward with it.
- **4.2 `LegacyDataMigration` — SAME SESSION as 4.1, never after.** Run the blob through
  `parseLedgerBackupJson`/`migrateLedgerData` **before** judging it non-trivial — mum's backup has
  no `pots`/`salarySorts`/`jointAccount` keys and would throw on first array access.
- **4.3 Audit `setData()`** — clear *and* remap every table. Fields that need remapping:
  `ownerId`, `payee`, `personId`, `potId`, `savingsPotId`, `creditCardId`, `categoryId`,
  `sourceId`, `transactionId`, and `pensionId` inside `followsIncomeSource`. **Test by restoring
  the same backup twice and diffing.**
- **4.4** Household linking UI. **Adam, 2026-09-17 (during PROMPT-07 session): unlike `personal-f`,
  household link-code generation/entry lives INSIDE the Account modal — not a separate
  `LinkHouseholdModal`.** The Phase 1 divergence table above still lists
  `src/components/LinkHouseholdModal.tsx` as a planned sync-app-only file arriving in PROMPT-10; when
  this phase is built, fold that UI into `AccountModal.tsx` instead and drop the separate-file plan
  (update that table row, or repoint it at the section of `AccountModal.tsx` this becomes). **4.5**
  Cloud snapshot backup — restore stays a deliberate manual action behind a whole-household warning.
  **4.6** Sign-in states per Q9.

---

## Phase 5 — `SalarySort` (PROMPT-11) — ✅ **DONE 2026-09-20** (built in session 10, folded in at Adam's request)

**As built:** sorts carry a `personId` (derived on read in the sync layer, backfilled from the
transfers' owner offline — no column, no migration), and sort/target/transfer ids are derived from
the person and the payday so two devices converge instead of moving the money twice. Full reasoning
in `PROMPT-11-salary-sort-sync-design.md`.

Deliberately last and deliberately separate. Its two-way transaction sync currently runs as one
synchronous `setDataState` over one blob; under PowerSync it becomes two rows in two tables across
a network boundary, possibly from two devices. `salarySorts: []` in Adam's backup, so there is no
live data to preserve — build it right rather than fast.

---

## Phase 6 — Verification and docs (PROMPT-12)

Adam does **TASK 7**. Plus: restore the same backup twice and diff; round-trip both real backups
through the mapping layer; finalise the four schema docs; re-verify every `DIVERGENCE.md` row
against what was actually built.

> ### 🚨 EXECUTION ORDER ≠ PHASE NUMBER (Adam, 2026-09-21)
>
> **Phase 8's Part 7 runs BEFORE this phase.** Adam: *"I want to get part 7 (alerts) in before
> prompt-12, so this can be included in the final validation script."* The final validation has to
> validate the last thing built, and that is now the alerts.
>
> **The phase numbers are deliberately NOT renumbered** — they are cited by number across the
> prompts, `APP-KNOWLEDGE.md` and the session log, and renumbering them would break those
> references for no benefit. The same rule `MIGRATION-LESSONS.md` lives under: append and annotate,
> never renumber.
>
> **Run order, as it actually went:**
>
> | # | Work | Where | State |
> |---|---|---|---|
> | 1 | Average-spend-forecast median — its own session | `personal-ledger/2026-10-28/PROMPT-average-spend-forecast-median-2026-10-28.md` | Not started |
> | 2 | **PROMPT-14 Parts 1–7, in ONE session** — Adam merged steps 2 and 4 on 2026-09-22: *"This and the backup work should be done in the same session"* | PROMPT-14 (Phase 8) | ✅ **BUILT 2026-09-22 (session 13)**, awaiting UAT and the migration's go-ahead |
> | 3 | **This phase** — final validation, now covering the alerts (🔔 items throughout PROMPT-12) | PROMPT-12 (Phase 6) | 🟡 **IN PROGRESS (session 17, 2026-09-23)** — baseline taken, Parts 4 and 5 built; waiting on one real 20:00 |
> | 4 | PowerSync keep-alive | Phase 7, still genuinely last | ✅ **DONE 2026-09-23** — runs from this repo only |
>
> **Phase 7 stays last regardless** — its own section says "only once Phase 6 is signed off", and
> that is still true.
>
> ✅ **The baseline WAS re-taken, 2026-09-22 (session 13):** sweep **139 / 150 / 150** (personal /
> shared / test), `check:divergence` **53 files, 0 unaccounted**, vitest 20/20, `tsc -b` clean
> everywhere, `check:sync-build` green. Higher than before, as predicted — that is Part 7's scripts
> and the two sync-only import-path checks, not drift. See **Current baseline** at the top.
>
> 🔔 **One PROMPT-12 item changed shape.** Its "🔔 verify the SQL projection against the app's"
> validation no longer exists to be done: §0b Q5 was revised on 2026-09-22 and **there is no SQL
> projection** — the Edge Function runs the app's own engine. What PROMPT-12 should validate instead
> is the **bundle freshness check** and a real 20:00 alert on a real phone.

---

## Phase 7 — FINAL TASK: move the PowerSync keep-alive into this repo

**Do this last — only once Phase 6 is signed off and `shared-finance-ledger` is live and in daily
use.** No prompt doc; this section is self-contained.

**Why it exists:** PowerSync Cloud **deprovisions Free-plan instances after 7 days with no deploys
or client connections** (`docs.powersync.com/resources/usage-and-billing`). On 2026-09-16 that took
`personal-f`'s sync down — nobody had opened the app for over a week. Restarted by redeploying Sync
Streams (same instance, same URL, no app redeploy). Adam ruled out the Pro plan: this stays free.

**What was built instead** (`personal-f`, [PR #1](https://github.com/adamnc02/personal-f/pull/1), merged 2026-09-16):
- `.github/workflows/powersync-keepalive.yml` — runs Mon + Thu 06:17 UTC (never >4 days apart), plus
  a manual **Run workflow** button.
- `keepalive/keepalive.mjs` + its own `package.json`/`package-lock.json` — signs in to Supabase as a
  dedicated **no-household keep-alive user**, makes a real PowerSync client connection, waits for the
  first sync checkpoint, disconnects and signs out. Exits non-zero on any failure, so GitHub's
  failed-run email is the outage alert.
- **Deliberately not a scheduled redeploy:** every deploy reprocesses from scratch, re-syncs every
  device (possibly twice), needs an account-wide PowerSync admin token, and can orphan a replication
  slot that holds WAL on the shared database.
- Also configured by Adam, free: PowerSync **Alerts** — issue alerts for Database Connection +
  Replication (Warning + Fatal) and one Email Rule (issue alert + deploy state changes).

**Why move it here:** this app will be used — and its repo worked on — far more than `personal-f`.
That matters because **GitHub automatically disables scheduled workflows in public repos with no
commits for 60 days** (both repos are public). GitHub emails a warning first; re-enabling is one
click in the Actions tab.

### Steps

**Order matters: a gap (zero copies running) is the danger; a short overlap (both repos running) is
harmless.** So the new copy is proven working *before* the old one is removed. Reuse the **existing
keep-alive user** (`adam+powersync-keepalive@gmail.com`, password in Adam's password manager) — do
**not** create a new one.

Everything below marked **ADAM** was tested end-to-end on 2026-09-16 in `personal-f` and worked
first time — give Adam these exact steps, only changing the repo name where noted.

#### Part A — Claude: copy it into this repo
1. **Copy, don't rewrite.** From `personal-f`'s `main`, copy `keepalive/keepalive.mjs`,
   `keepalive/package.json`, `keepalive/package-lock.json` and
   `.github/workflows/powersync-keepalive.yml` into this repo, unchanged except:
   - remove the "planned move" notes in both files' header comments;
   - re-check the workflow's `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `POWERSYNC_URL` against this
     app's `.env.local` (they should be identical — one shared project, one shared instance);
   - confirm `node_modules` is gitignored in subfolders (`keepalive/node_modules` must never be
     committed). **Do not** add these dependencies to the app's own `package.json`.
2. `cd keepalive && npm ci` (installs exactly what the copied lockfile says), check
   `npx tsc -b` is unchanged for the app, and test the failure path with a wrong password — expect
   `✗ PowerSync keep-alive FAILED: Supabase sign-in failed: Invalid login credentials` and exit 1.
3. Check which SDK version string each side reports, for step D2:
   `keepalive/node_modules/@powersync/shared-internals/lib/version.js` vs the app's
   `node_modules/@powersync/shared-internals/lib/version.js`. Note both in the handoff.
4. Commit on the feature branch. Nothing is pushed until Adam types **"push this"**.

#### Part B — ADAM: test it on your Mac (the password never goes into chat or a file)
1. Open Terminal and paste this. If this app's `.env.local` uses different variable names than
   `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` / `VITE_POWERSYNC_URL`, Claude must adjust the
   third line first:
   ```bash
   cd ~/Documents/GitHub/shared-finance-ledger/keepalive
   set -a; . ../.env.local; set +a
   read "KEEPALIVE_EMAIL?Keep-alive email: "; read -s "KEEPALIVE_PASSWORD?Password: "; echo
   SUPABASE_URL=$VITE_SUPABASE_URL SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY POWERSYNC_URL=$VITE_POWERSYNC_URL \
   KEEPALIVE_EMAIL=$KEEPALIVE_EMAIL KEEPALIVE_PASSWORD=$KEEPALIVE_PASSWORD npm start
   ```
2. Type the keep-alive email, press Enter, then the password (nothing shows as you type — that's
   deliberate), press Enter.
3. You should see exactly:
   ```
   ✓ Signed in to Supabase as the keep-alive user
   ✓ Connected to PowerSync and completed a sync (lastSyncedAt: …)
   ```
4. Paste the output back to Claude.

#### Part C — ADAM: add the two secrets to this repo
GitHub secrets belong to one repo — they don't move with the code.
1. Go to github.com → `adamnc02/shared-finance-ledger` → **Settings** (top tab bar).
2. Left sidebar, under **Security** → **Secrets and variables** → **Actions**.
3. Make sure the **Secrets** tab is selected (not Variables), then click **New repository secret**.
4. Name: `POWERSYNC_KEEPALIVE_EMAIL` · Secret: the keep-alive email → **Add secret**.
5. Click **New repository secret** again.
6. Name: `POWERSYNC_KEEPALIVE_PASSWORD` · Secret: the keep-alive password → **Add secret**.
7. Both names must match exactly (capitals and underscores), or the run fails with
   `Missing environment variables`.

#### Part D — ADAM: merge, then prove it runs on GitHub
1. Type **"push this"**. Claude pushes the branch and opens the PR. **Claude's merge may be blocked**
   by Claude Code's auto-mode safety check (it was for `personal-f` PR #1) — if so, open the PR link
   Claude gives you → **Merge pull request** → **Confirm merge**. Merging adds the workflow only; it
   does not deploy the site (only `npm run deploy` does that).
2. github.com → `adamnc02/shared-finance-ledger` → **Actions** tab → **PowerSync keep-alive** in the
   left list → **Run workflow** (right-hand side) → **Run workflow** (green button). Wait a minute or
   two and refresh — you want a **green tick**.
3. PowerSync Dashboard → select the instance → **Health** → look at the **Clients Connected in Last
   30 Days** card. There is no list of individual clients (the docs' "recently connected clients"
   wording doesn't match the UI, checked 2026-09-16) — clients are grouped into bars by SDK version.
   On 2026-09-16 the keep-alive was `powersync-js/1.2.0` and `personal-f` was `powersync-js/1.1.1`;
   use the versions Claude noted in A3. The keep-alive's bar should exist (its count may go up).
   **Clients Connected Now** showing "No data available" is normal — the keep-alive disconnects
   within seconds.
4. Tell Claude the result. **Do not start Part E until D2 is green.**

#### Part E — remove it from `personal-f`
**What Claude does:** on a `personal-f` feature branch, delete `.github/workflows/powersync-keepalive.yml`
and the whole `keepalive/` folder, commit, and (after **"push this"**) push and open the PR. Also
delete the leftover local `personal-f/keepalive/node_modules` folder (gitignored, never on GitHub).
Nothing else in `personal-f` changes — the app never depended on any of it.

**What ADAM does — things a PR cannot do:**
1. **Merge the removal PR** (if Claude's merge is blocked): open the PR link → **Merge pull request**
   → **Confirm merge**. Once merged, the schedule stops — GitHub only runs workflows whose file
   exists on `main`. No separate "delete workflow" step is needed.
2. **Delete the two secrets from `personal-f`** (a PR can't touch secrets):
   1. github.com → `adamnc02/personal-f` → **Settings** → left sidebar, under **Security** →
      **Secrets and variables** → **Actions** → **Secrets** tab.
   2. Under **Repository secrets**, click the **bin (delete) icon** next to
      `POWERSYNC_KEEPALIVE_EMAIL` → confirm the removal prompt. (GitHub's docs don't show the exact
      confirm-button wording — it's the one that removes the secret.)
   3. Do the same for `POWERSYNC_KEEPALIVE_PASSWORD`.
   4. The list should now be empty of both. This doesn't affect `shared-finance-ledger`'s copies.
3. **Optional tidy-up of old run history:** `personal-f` → **Actions** tab. If **PowerSync
   keep-alive** is still listed on the left, it can't run any more (its file is gone) — it's only
   showing past runs. To clear them: click the workflow → click a run → **⋯** (top right) → **Delete
   workflow run** → confirm. Repeat per run. Purely cosmetic; skipping it is fine.
4. **Check the handover**, after the next Monday or Thursday: `shared-finance-ledger` → **Actions**
   → **PowerSync keep-alive** shows a new scheduled run with a green tick, and `personal-f` →
   **Actions** shows no new keep-alive run.
5. **Keep the keep-alive user in Supabase** — `shared-finance-ledger`'s copy still signs in with it.

**If Adam ever wants the old copy stopped immediately** (e.g. before the removal PR is merged):
`personal-f` → **Actions** → **PowerSync keep-alive** in the left sidebar → **⋯** menu (top right) →
**Disable workflow**. Only after Part D2 is green.

#### Part F — Claude: docs
Update `ADAM-TASKS-SUPABASE-POWERSYNC.md` (where the keep-alive lives, how to re-run it, what a
failure email means), `MIGRATION-LESSONS.md` (the deprovisioning lesson), `personal-f`'s
`PERSONAL-F-INFO.md` (no longer hosts the keep-alive), and this file's baseline + session log.

**If GitHub emails that the scheduled workflow will be disabled** (public repos with no commits for
60 days): **Actions** tab → **PowerSync keep-alive** → **Enable workflow**.

**Keep it even though the app is used daily.** Daily use keeps PowerSync alive on its own, but a
holiday or a quiet fortnight would not — the workflow is the safety net, and its failure email is
the only warning of an outage.

**If a failure email ever arrives:** PowerSync Dashboard → select the instance → **Health**. If
deprovisioned: **Sync Streams** → **Validate** → **Deploy** (no edits), then check **Logs** within
24 hours and run `select slot_name, active from pg_replication_slots;` in Supabase — drop only
*inactive* `powersync%` slots (`docs.powersync.com/configuration/source-db/postgres-maintenance`).

---


## Phase 8 — Backup & Restore, safe hand-editing, and low-balance alerts (PROMPT-14) — ✅ **DONE, merged and deployed 2026-09-23**

| Part | What | State |
|---|---|---|
| 1 | Backup & Restore moves into the Account modal, behind a **shared placement slot**, so `Salary.tsx` stays byte-identical in both live apps | ✅ built |
| 1b | The copy corrected while it moved; `window.confirm` replaced by the app's own portalled `ConfirmModal` in **all three** apps | ✅ built |
| 2 | Back Up Now → cloud or this device. Cloud disabled with its reason when offline; local never touches the network | ✅ built |
| 3 | Restore → cloud or a file, both converging on one `restoreFrom(source)`, both gated on first sync | ✅ built |
| 4 | Re-importing this household's own file is a **patch** — only what changed is written | ✅ built |
| 5 | 🚨 A restore no longer silently reassigns the other member; ambiguity is asked about, never guessed | ✅ built |
| 6 | The hand-editing decision rule, with a worked example each way (`APP-KNOWLEDGE.md` §1.30) | ✅ written |
| 7 | Low-balance push alerts at 20:00 Europe/London, per device, running the app's **own** engine server-side | ✅ built; migration **not applied** |

**Still outstanding for this phase:** UAT, the migration's written go-ahead, the two VAPID secrets,
Ella's device registration (a task, not a decision — §0b Q8), then merge/deploy/clean-up in one pass.


## Phase 9 — Overdrafts (PROMPT-15) — ✅ **DONE, merged and deployed 2026-09-23**

An agreed overdraft limit per account, so the 8pm alert stops crying wolf on an account that has a
buffer. One editable field, `overdraftAmount`, on `PayCycleConfig`, `JointAccountConfig` **and
`Pot`**; `0` means none; the shortfall floor becomes `-overdraftAmount`.

🚨 **Pots are included on purpose** (Adam, 2026-09-22). I argued to exclude them — a Pot is a
notional pocket, not a facility — and was overruled, correctly: *"i use pots because monzo has them,
but mum might use pots as other bank account, so we need to add the flexibility."* Do not tidy it
back out.

**Smaller than first written.** I claimed the whole app would have to honour the limit — RAG
colours, progress bars, projections — and that the alert and the app would otherwise disagree.
**Adam challenged it (*"I don't believe the app treats zero as a floor for anything currently, does
it?"*) and the codebase agrees with him.** Every `Math.max(0, …)` is about DEBT (a card or loan
balance cannot go negative) or a percentage; the RAG rings are loan repayment progress, not cash;
and a red balance is a display colour, not a rule. So the floor has exactly one consumer — the
alert — and this phase is one field, one comparison and a three-column migration. See §0 Q3.

**Coin Jars are excluded** (Adam, 2026-09-22), ordinary pots are not.

**Extended the same day — TWO kinds of alert, not one** (Adam: *"one to show you're going into an
arranged overdraft if we dip below zero, and another when we physically don't have enough
money"*). 🚨 This reverses a recommendation I had made in the prompt against alerting on entry to
an overdraft — and the reversal is right: I was picturing a second event-shaped alert, whereas this
is **one nightly alert with two severities**. With no limit configured the two collapse into
today's behaviour exactly.

**The cadence is Adam's design and it is better than anything I proposed** (2026-09-22): the
out-of-money alert stays **nightly**; the overdraft heads-up fires **Sunday evenings only**, and is
suppressed entirely while the cleared balance has not reached £0 since the last one. Self-clearing
— it goes quiet for someone who lives in their overdraft without them turning anything off, and
starts talking again when their situation actually changes.

🚨 **It also reverses something I had ruled out:** the dedupe key now carries the severity, because
the suppression has to find *the last overdraft alert* specifically. **§0 is fully answered (11
questions); the only outstanding item is the notification wording, which Adam is redrafting
himself.**

## ⚠️ Standing risks — re-read before each phase

### 🚨 Listly depends on this schema (added 2026-09-20)

A fourth app, `listly`, reuses this app's **household**: its RLS calls
`shared_finance_ledger.my_household_ids()`, four of its tables have FKs into
`shared_finance_ledger.households`, and **a trigger of its own writes into
`shared_finance_ledger.transactions`** — live since `20260920160000` (2026-09-20).

🚨 **The household id is literally shared.** A Listly row is scoped by the same `households.id`
this app uses, and there is one link code for both apps, not one each.

`redeem_household_link_code()` and `erase_my_data()` now carry **guarded `listly` blocks**
(`20260920150000`), and `create_`/`regenerate_household_link_code()` were made race-safe on
2026-09-20 (`20260920160100`) after Listly's UAT hit a raw `23505` in the UI. **Rewriting either without carrying its block forward silently destroys a Listly
user's shopping lists and house jobs.**

**Read `listly/docs/LEDGER-INTEGRATION.md` before changing anything it lists.** Every failure mode
in that table is silent — neither Postgres nor PowerSync will warn you.

| Risk | Reference |
|---|---|
| Empty-string FKs silently discarded as fatal writes | DMR §11.1 |
| Dropping a published table kills replication for **every** table, `personal-f` included | ML §19 |
| `language sql` RLS helper reintroduces infinite recursion while looking correct | ML §21 |
| Exposed-schemas gate is invisible to PowerSync; fails only on a real client RPC | ML §20 |
| Auth redirect lands on the wrong app with no error at all | ML §2 |
| Signing in makes all pre-existing local data invisible, silently | ML §24 |
| Source-table aliasing in a Sync Stream silently renames the local table | ML §7 |
| `primaryPersonId` locks onto the wrong person during a partial-sync window | ML §23 |
| Sorting an effective-dated history array restores a fixed stale-value bug | DMR §11.7 |
| `salary_snapshots` row order is arbitrary — two devices can resolve different salaries | DMR §11.7a |
| A pre-sync device pushes empty/default rows into a populated household | Plan 3.3a |
| Pages render stale derived state after a first sync | APP-KNOWLEDGE §1.6 |
| Every synced table needs an `id text` primary key | Plan 2.3 |
| The credit-card engine has needed five fixes for one symptom — full sweep, always | APP-KNOWLEDGE §2 |
| **HARD RULE:** credit cards use their own pay-cycle windows, never the household cycle | APP-KNOWLEDGE §1.8 |
| A simulation window whose behaviour depends on time-of-day is a latent seasonal bug | PROMPT-01 |
| A responsive SVG with a fixed viewBox misleads a `getBoundingClientRect` hit-test | PROMPT-04 |
| Free-plan PowerSync is deprovisioned after 7 days idle; the keep-alive must never have a gap between repos | Plan Phase 7 |
| A test-app-only file (sync flag, badge) ported into a live app | `TEST-APP-DIVERGENCE.md` |
| The test app's `/sync/` build uses the LIVE Supabase project; test accounts are real users, and migrations aren't sandboxed | `TEST-APP-DIVERGENCE.md` |
| Deleting a test login in the dashboard also cascades `personal_finance` rows; only delete logins that never used `personal-f`/`my-dream-clean` | `DELETE-APP-DATA-SHARED-FINANCE-LEDGER.md` |

*DMR = `DATA-MODEL-REVIEW-2026-09-15.md` · ML = `Supabase Migration/MIGRATION-LESSONS.md`*

---

## Not yet scoped

- ~~**Account closure**~~ — **SCOPED 2026-09-16** for this app: Phase 2.3 (FKs, erasure function)
  + Phase 4.1a (UI). **Replaced by "Delete my app data"** (login kept): `DELETE-APP-DATA-SHARED-FINANCE-LEDGER.md`. Cross-app closure
  (`personal-f`, `my-dream-clean`) is still unscoped: `Supabase Migration/SHARED-ACCOUNT-CLOSURE.md`.
- ~~Four-weekly pay generation~~ — **CLOSED 2026-09-15.** Adam confirmed the Household hero
  callout figures (Adam £41.08 / Ella £2,373.30 on "Next 3 cycles") are correct — current balance
  per person — and that Ella's four-weekly cycle renders correctly once "set as me" is used. No
  scoping needed.
- The open flagged-not-fixed items in `APP-KNOWLEDGE.md` §4.

---

# 📓 Session log

Newest first. **Every session appends here before finishing.**

### Template
```
### {{yyyy-mm-dd}} — SESSION NN — <title>
**Prompt doc:** PROMPT-NN · **Apps touched:** … · **Branch:** … · **Merged:** yes/no
**Done:** what actually shipped.
**Root causes:** the real mechanism, not the symptom.
**Files:** the ones that matter, with paths.
**Verify:** tsc state, sweep count, new scripts added.
**Learnt / surprising:** anything a future session would waste time rediscovering.
**Deviated from the plan:** what and why.
**Next:** which prompt doc, and what changed in it because of this session.
```

---


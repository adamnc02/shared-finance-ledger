# Shared Ledger — household finance PWA, synced across two phones

> A two-person household's money, on both people's phones, offline-first: net salary (UK PAYE),
> bills and recurring transactions, loans with a genuine amortisation engine, credit cards with
> real interest, pots and savings pots, a joint account, transfers, round-ups, and what-if
> modelling — **plus Supabase Auth, PowerSync sync, household link codes and cloud backup.**

![Stack](https://img.shields.io/badge/stack-Vite%20%C2%B7%20React%2019%20%C2%B7%20TypeScript-blue)
![Sync](https://img.shields.io/badge/sync-Supabase%20%2B%20PowerSync-3ecf8e)
![PWA](https://img.shields.io/badge/PWA-ready-brightgreen)

---

## What this app is, and which app it isn't

This repo is the **shared** app. It started as a byte-for-byte copy of `personal-ledger` and gains
Supabase/PowerSync sync on top. `personal-ledger` stays offline-only, permanently.

| App | Role | Backend |
|---|---|---|
| `finance-ledger-test` | **Test app.** Where non-Supabase development happens first. Its `/sync/` build exists only for sync work on this app. | None (+ a sync preview) |
| `personal-ledger` | **Live offline app.** Single device, `localStorage` only. | None — permanently offline |
| **`shared-finance-ledger`** *(this repo)* | **Live syncing app** for a two-person household. | Supabase + PowerSync |

The two live apps are kept deliberately close. **Divergence is structural, not textual:**
persistence sits behind one `LedgerStore` interface with two implementations, so
`src/context/LedgerContext.tsx` and everything above it stay **byte-identical** in both repos.

> `npm run check:divergence` diffs `src/` against `personal-ledger/src/` and **fails on any
> difference not listed in `DIVERGENCE.md`.** That register is enforced, not advisory. A commit that
> makes the two apps differ must add its row in the same commit.

The rule for deciding, when a change is needed here:

1. **Non-destructive and sensible in both apps → put it in both.** Deploy to `personal-ledger` too
   and add nothing to the register. This is the preferred outcome every time.
2. **Only makes sense with a backend → this app only**, and add a row.
3. **Would change behaviour or risk data in the offline app → this app only**, add a row, and say
   why.

If a row is a whole duplicated file that *could* be an interface plus two small implementations,
that is a signal to refactor rather than to accept the row.

---

## Getting started

```bash
npm install
npm run dev                  # vite dev server
npm run build                # tsc -b && vite build
npm run lint
npm test                     # vitest
npm run verify
npm run check:divergence     # fails on any un-registered difference from personal-ledger
npm run check:sync-build     # proves the built bundle carries this app's sync wiring
npm run deploy               # build + check:sync-build + publish dist/ to gh-pages — the LIVE site
```

### `.env.local`

Create it **from the terminal, never from Finder** — macOS can silently drop the leading dot when
renaming, and Vite then ignores the file with no error at all.

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...        # publishable; public by design — RLS protects the data, not the key
VITE_POWERSYNC_URL=...
```

`VITE_POWERSYNC_DB_FILENAME` lives in the committed `.env.production` and is
`shared-finance-ledger.db`. It has **no default on purpose**: four apps share the
`adamnc02.github.io` origin, OPFS is per origin, and two apps sharing a database file would each
read — and upload — the other's rows. A build that forgets it fails loudly.

**Nothing in `.env.local` should be a value that matters if seen.** Database passwords live in
`~/.pgpass`, outside every repo.

---

## Everything the offline app does

**The whole of `personal-ledger`'s README applies to this app**, screen for screen: the Home wallet
deck and ledger, the Wallet page (salary, pensions, savings pots, pots, joint account, backup),
Borrowing (loans and credit cards), Bills, Transactions (ad-hoc, recurring, transfers,
overpayments) and What-if. The finance engines are the same files.

See **`TECHNICAL.md`** for the full reference — it is this repo's own copy of the offline app's
technical documentation, with the sync layer added on top.

What follows is only what this app adds.

---

## What this app adds

### Sign-in is required, and there is no guest mode

Supabase Auth: Google, or email and password. The app does not render a ledger until there is a
session.

> 🚨 **This is a defence, not a preference.** The moment the app reads from PowerSync, anything
> under the old `localStorage` key becomes invisible, with no error. That cost a family member's
> data on another app in this project. This app's answer is the rescue screen below, shipped in the
> same release as the switch.

### The boot sequence

```
sign in → ensure_household() → connect (this app's stream only, includeDefaultStreams: false)
  → subscribe to shared_ledger_household → wait for first sync
  → household has no people?  →  the rescue screen
  → otherwise                 →  the ledger
```

`ensure_household()` runs **before** the first sync counts: a brand-new user has no household until
it runs, so the stream would report "synced" with nothing in it and the gate would open on a truly
empty ledger. A full-screen "Syncing your household…" covers the wait.

It boots again from the top, clearing the local database, whenever the household changes under the
session — another device ran "Delete my app data", or a link code was redeemed here.

### The rescue screen (an empty household)

One screen, four choices, rather than a prompt stacked on a prompt:

- **Import this device's data** — only offered when there is some worth offering;
- **Import a backup file**;
- **Start fresh**;
- **Join a household with a code** — the second person's path: join *before* creating anything,
  then tap "Set as me" on their own row.

> 🚨 **The old key is READ and nothing else.** `ledger:app-data-v2:v1` on this origin is also the
> offline `personal-ledger` app's key — a real, unbacked-up ledger on that person's devices. The
> app this component was ported from removed its old key after importing and after "Start fresh";
> **that line is deliberately not ported.** `verify-legacy-migration.ts` proves it from the source
> and from a Storage that records every call.

### Households, link codes and "Set as me"

A household is created on first sign-in and seeded server-side with the 35 built-in categories.
The Account modal shows this household's **invite code** (show / copy / regenerate) and **Join with
a code**.

Redeeming a code moves the joiner's **own** data server-side (their "Set as me" person and
everything attached to it; joint items stay behind), so the device clears its local copy and boots
again through the first-sync gate. **Never assume the local copy follows.** A joiner who brought
nothing is asked "which of these is you?" once. A same-named person left behind comes back as a
duplicate and is resolved by a banner, through the app's **own** delete-reassign flow — no second
merge implementation.

**"Set as me" = link + view.** The button only changes `primaryPersonId` (shared code); the store
turns that into `people.linked_user_id`:

- an **unlinked** row → linked to me, my previous row cleared **first** (there is a unique index);
- a row linked to **someone else** → view only, never taken — *unless* I have no linked row at all,
  which is how the second person claims their row if the first tapped it before they joined;
- `primaryPersonId` moving because my person was **deleted** → nothing is written.

### Cloud backup

One snapshot a day, automatically, to a private bucket, plus **Back Up Now**. A snapshot is the
same JSON the Wallet page's download produces, so either can be restored anywhere.

> **Restore replaces the whole household** on every device, so it sits behind a warning that says
> so, and goes through the app's normal restore — which the store treats as an import, with fresh
> row ids.

### The Account modal

Identity and provider; **Change password** (email accounts only — an OAuth account has no app
password); sync status and **Force Sync** (there is deliberately no pull-to-refresh); the
**rejected-writes** line, always shown — either the list or "No changes rejected by the server ✓";
the household invite code and Join with a code; Cloud Backup; Sign out; **Delete my app data**.

The button itself sits in the Wallet header through `HeaderAccessory.tsx`, a shared, empty slot
that renders nothing unless an app fills it. **That is what keeps `Salary.tsx` identical in both
live apps** while only this one has an Account button.

---

## How the sync behaves

- **Nothing is written before first sync.** `save()` is a logged no-op and `load()` does not
  resolve until this app's stream reports first sync. Three things write without the user touching
  anything — the default-data seed, the migration's re-added built-ins, and auto-clear — and
  ungated, a device that had not synced would duplicate categories across the household and push
  transactions against an empty ledger.
- **Writes are narrow.** A save diffs the store's own shadow of the database and writes only
  changed columns, so one field edit is one PATCH carrying one column. **PowerSync resolves
  conflicts per column**, and the whole design rests on that: two partners editing two different
  fields of one bill must both survive.
- **Every local or synced change triggers one consistent read** of all 27 tables in one read
  transaction. A read that overlapped a save is dropped; the save's own change triggers the next
  read.
- **`primaryPersonId` is per device and never syncs.** It is resolved on every read: a choice made
  on this device, else the person whose `linked_user_id` is me, else the first person.
- **Rejected writes are never silent.** The connector still discards permanent Postgres rejections
  (they would block the upload queue forever) but logs each one loudly and keeps it in a local list
  the Account modal shows.
- **The household can change under an open device.** Every read checks synced membership; losing
  it suspends the store and reboots the app. Without this, a stale device re-sent its whole ledger
  into the old household.
- **Auto-cleared payments have deterministic ids.** Two devices clearing the same payment before
  syncing used to make two rows and double the household balance.
- **Every import regenerates ids.** The same backup imported into two households would otherwise
  collide on every row id, and those writes are discarded silently.

---

## Other apps on this Supabase project

Four apps share one Supabase project, one `powersync` publication and one PowerSync instance, each
in its own schema: `personal_finance` (personal-f), `my_dream_clean`, `shared_finance_ledger` (this
app) and `listly`. Everything each one adds is additive.

> 🚨 **`shared_finance_ledger.transactions` has a second writer.** **Listly** writes into it via a
> `security definer` trigger on its own `listly.shop_completions` table when a finished shop is
> priced. Those rows are ordinary `type: 'expense'` rows and need no special handling — but **any
> assumption that this app created every row in `transactions` is now wrong**, including anything
> inferring provenance from `source_id`, `user_id` or the absence of them.
>
> Listly also depends on this schema's household model and functions. Before changing
> `my_household_ids()`, `households`, `household_members`, `ensure_household()`, the link-code
> functions, `erase_my_data()`, or the shapes of `people` / `categories` / `pots` / `savings_pots` /
> `joint_account`, read **`listly/docs/LEDGER-INTEGRATION.md`**. Every failure there is silent.

---

## Testing

```bash
npx tsc -b
npx vitest run
npm run check:divergence
for f in scripts/verify-*.ts; do out=$(npx tsx "$f" 2>&1); rc=$?; \
  if [ $rc -ne 0 ] || echo "$out" | grep -qE "✗|^FAIL|Error:"; then \
  echo "FAIL: $f"; echo "$out" | grep -E "✗|^FAIL|Error:" | head -5; fi; done; echo DONE
```

`npm run check:sync-build` reads build output, so it is not part of the sweep; `npm run deploy`
runs it.

---

## Known limitations

Everything in `personal-ledger`'s "Known limitations", plus:

- **Two people, one household.** The joint split model is two-way by construction.
- **A restore replaces the whole household**, on every device.
- **Local database files are per origin.** Never point this app at another app's `.db` file.
- **A permanently rejected write is discarded**, not retried — it is logged and surfaced, but the
  row does not reach the server without a fix and a re-save.

---

## Where the rest is written down

| Document | Holds |
|---|---|
| `TECHNICAL.md` | The full implementation reference, offline engines and sync layer |
| `DIVERGENCE.md` | The enforced register of what may differ from `personal-ledger` |
| `src/types/ledger.ts` | **The comments are the spec** |
| `silver-octo-invention/docs/` | The Supabase schema, RLS and functions, per app |
| `listly/docs/LEDGER-INTEGRATION.md` | What Listly depends on in this schema |
| `Downloads/App Development & Bug Tracking/shared-finance-ledger/` | Build plan, app knowledge, prompts, UAT scripts |

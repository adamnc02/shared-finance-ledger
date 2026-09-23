# My Ledger — household finance PWA, synced across two phones

> **The app is called "My Ledger" (renamed 2026-09-22, from "Shared Ledger").** The repo, the
> Supabase schema and the PowerSync app id keep their old names — only the display name changed.
> It lives in **four** places, and all four must agree: `index.html`'s `<title>` and
> `apple-mobile-web-app-title`, `public/manifest.webmanifest`'s `name`/`short_name`, and
> `public/sw.js`'s fallback notification title.
>
> 🚨 **iOS reads the name from the INSTALLED copy**, both for the home-screen label and for the
> "from …" suffix on a push notification. An already-installed phone keeps showing the old name
> until the home-screen icon is deleted and re-added — that is iOS, not a bug here.

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
>
> 🚨 **`DIVERGENCE.md` lives OUTSIDE this repo**, at
> `~/Downloads/App Development & Bug Tracking/shared-finance-ledger/DIVERGENCE.md`, and
> `scripts/check-divergence.ts` reads it there by absolute path. Deleting or moving it breaks the
> check.

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

**"Set as me" = link + view.** The button is an explicit tap (the context tells the store before it
changes `primaryPersonId`); the store turns the tap into `people.linked_user_id`:

- a tap on an **unlinked** row → linked to me, my previous row cleared **first** (there is a unique
  index) — including a tap on the person you are already viewing, which used to do nothing;
- a tap on a row linked to **someone else** → view only, never taken — *unless* I have no linked row
  at all, which is how the second person claims their row if the first tapped it before they joined;
- anything that is **not a tap** (a delete moving the view, a sync, an edit) → nothing is written.

**Each device remembers who it showed.** If that person is gone after a restore, or now belongs to
someone else, the device links the one unlinked person with the same name, or asks "Which of these
is you?". A device whose link was never written but whose view was right heals itself on launch. Only
you can write your own link — the server refuses anyone else's — so nobody can be re-linked for you.

### Backup & Restore

**One pair of buttons, in the Account modal, and nowhere else in this app.** The Wallet page shows
**no Backup card at all** — not an empty one: the slot renders `null`, so there is no card, no
heading and no gap where one used to be. Two doors to something that replaces the whole household is
one too many. (`personal-ledger` keeps its Wallet buttons exactly where they have always been.)

Each button asks one follow-up question:

| | Cloud | This device / A file |
|---|---|---|
| **Back Up Now** | Uploads today's snapshot. Disabled, with the reason shown, while offline | Saves a backup file. Deliberately does **not** also upload — you were asked, and the answer is honoured |
| **Restore** | The list of daily snapshots | The file picker |

A cloud snapshot and a downloaded file are **the same bytes** — one serialiser, one parser — which
is what makes one question over one format possible at all. Either restores through either path.

One snapshot a day still happens automatically. **The newest 30 are kept**; older ones are pruned.

> **Restore replaces the whole household** on every device, so it sits behind a warning that names
> the source and says what it is replacing.

**Except when it doesn't.** Re-importing a file **this household exported** is treated as a patch:
if any id in it is one the app already holds, the ids are kept and only the rows you actually
changed are written. That is what makes hand-editing cheap — Back Up Now → This device, edit the
JSON, Restore → A file — and the confirm says so, including how many rows the file will **delete**
if you trimmed it. A backup from anywhere else still gets fresh ids for every row.

> 🚨 **A restore used to make the other person somebody else.** Regenerating ids deleted their
> "this is me" link, and their phone quietly adopted whoever sorted first, with that person's pay
> cycle. Links are now carried across by name; if the name is ambiguous, their phone **asks** rather
> than guessing.

### Low-balance alerts

At **8pm** every evening, a push notification for any watched account whose **projected running
balance dips below zero at any point in the current pay cycle** — and again each evening until it
clears.

🚨 **It is the dip, not the end-of-cycle balance.** An account can end the cycle perfectly healthy
and still bounce a direct debit on the 12th, and that is the case this exists for.

### Overdrafts, and the two kinds of alert

Each account — your current account, the joint account, and **any pot** — can be given an
**Overdraft**: how far below zero it is allowed to go. Leave it at 0 if it cannot. It is edited
where that account already is: the pay-cycle cog, the pot's own form, the joint account's.

> **Why pots have one:** you might use pots the way Monzo means them, or you might use one to stand
> in for a separate bank account. The app does not decide which of those is right. (A Coin Jar is
> the exception — it has no overdraft and is never watched.)

With a limit set, there are **two** alerts rather than one:

| | When | How often |
|---|---|---|
| **"runs short"** | You'll dip into your overdraft, but stay inside it | **Sunday evenings**, and it goes quiet while you stay in it |
| **"not enough money"** | You'll go past your limit — the payment won't go through | **Every evening** until it clears |

With no overdraft set, only the second exists: dipping below zero *is* running out of money.

🚨 **The Sunday one is self-clearing.** If you live in your overdraft it stops telling you, without
you turning anything off — and starts again the moment your balance gets back to zero or above. So
the alert you do get means something.

**Watched:** each person's current account, every Pot that is not a Coin Jar, and the joint account
— each against **its own** overdraft.
**Not watched:** savings pots, Coin Jars (one emptying is it working) and credit cards (a balance
owed is not a balance held). **Who is told:** the account's owner — and joint has two owners.

**There is deliberately no deposit alert.** It reads like the obvious missing half and it is not: a
notification every time money lands is chatter, and the shortfall alert already says the thing that
matters.

Turn it on per device, in the Account modal, with a test button beside it. **A phone without
notification permission receives nothing at all** — there is no email fallback, and there never will
be — so the toggle says which of the five ways of being off this device is in. On iPhone, add the
app to the Home Screen first; notifications do not work in a Safari tab. And on a phone that already
allows notifications for Listly, the first toggle shows no prompt and simply works, because
permission belongs to the website rather than the app.

### The Account modal

Identity and provider; **Change password** (email accounts only — an OAuth account has no app
password); sync status and **Force Sync** (there is deliberately no pull-to-refresh); the
**rejected-writes** line, always shown — either the list or "No changes rejected by the server ✓";
the household invite code and Join with a code; **Backup & Restore**; **Low-balance alerts**;
Sign out; **Delete my app data**.

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
- **Every import regenerates ids** — unless the file is this household's own, in which case the
  ids are kept and only what changed is written. The same backup imported into two households would
  otherwise collide on every row id, and those writes are discarded silently.
- **After a restore, every other member's device re-links itself by name, or asks.** Before, the
  restoring phone tried to re-link them and the server refused it, so their phone silently became
  whoever sorted first.
- **A second device online during a restore writes nothing stale.** It used to re-create occurrences
  the restore had deleted, or double up the ones the file was about to deliver.
- **The 8pm alert runs the app's own projection engine**, server-side, rather than a second copy of
  it written in SQL. The alert and the figure on your phone are the same code.

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
| `DIVERGENCE.md` (in the tracking folder, **not** this repo) | The enforced register of what may differ from `personal-ledger` |
| `src/types/ledger.ts` | **The comments are the spec** |
| `silver-octo-invention/docs/` | The Supabase schema, RLS and functions, per app |
| `listly/docs/LEDGER-INTEGRATION.md` | What Listly depends on in this schema |
| `Downloads/App Development & Bug Tracking/shared-finance-ledger/` | Build plan, app knowledge, prompts, UAT scripts |


## What each button does

Plain English, for when you are looking at the app rather than the code. All of these live in the
**Account** modal (the person icon in the Wallet header). The Wallet page itself has **no Backup
card in this app** — see Backup & Restore above for why.

### Back Up Now → **Cloud**

Uploads a copy of the **whole household** to your own private folder in Supabase Storage.

- One file per day: doing it twice today replaces today's rather than making a second.
- The newest **30** are kept; older ones are pruned.
- This already happens **once a day on its own**. The button is for "I am about to do something
  risky and want today's copy to be current".
- Greyed out, with the reason shown, while the device is offline.

### Back Up Now → **This device**

The **same JSON**, saved to the phone instead.

- No network at all, so it still works when syncing is the thing that is broken — which is exactly
  when you want it.
- 🚨 **It does not also upload to the cloud.** You were asked which one, and the answer is honoured
  literally. The daily automatic snapshot already covers "always have a cloud copy".

### Restore → **Cloud** → tap a date

Fetches that day's copy and **replaces the whole household with it — on every device, and for
everyone in it**. Anything either of you added since that backup is gone.

The confirmation names the date and says what it is replacing.

### Restore → **A file**

The same thing, from a file you pick. It behaves differently depending on where the file came from,
and the confirmation tells you which case you are in:

| The file | What happens |
|---|---|
| **This household's own export** — you backed up, edited the JSON, brought it back | Treated as a **patch**. Only the rows you actually changed are written. No new ids, nobody has to say who they are again, and the other phone sees one small update. If you deleted rows out of the file, it tells you **how many will be deleted** |
| **A file from anywhere else** | A full replace, with a fresh id for every row — exactly as it always was |

That first case is what makes hand-editing cheap: **Back Up Now → This device**, edit the JSON,
**Restore → A file**. The decision rule for when to do that instead of editing a row in Supabase
directly is in `APP-KNOWLEDGE.md` §1.30.

### Force Sync

Drops the connection to PowerSync and reconnects.

- ✅ **It is safe.** It deletes nothing, changes no data, and cannot lose anything.
- It does **not** re-download your ledger from scratch.
- It does **not** push anything that was not already queued to go — the queue uploads on its own.

Use it when the line above it says *Offline* when it should not, or *last synced* is stuck at an old
time.

### Three things worth knowing

1. **Restore is not a merge.** Except the "this household's own file" case above, it throws away
   what is there.
2. **Restore reaches the other person's phone too**, not just yours.
3. **Restore is refused until first sync finishes.** Restoring into a half-synced copy would compare
   against rows that have not arrived yet and delete what it could not see, so the card says
   "available once your household has synced" instead.

> **Not on this list, and not the same thing:** *Delete my app data*, at the bottom of the same
> modal. That erases your ledger data server-side and keeps your login. It is not a backup
> operation and nothing above will bring it back except a restore from a copy you already had.

# Decision — the loan ledger's positive row is a DERIVED VIEW, not a stored transaction

**Date:** 2026-09-18 · **Decided by:** Adam, on the recommendation below · **Scope:** PROMPT-08a
Part C, both live apps.

PROMPT-08a Part C required this to be decided explicitly and written down before building:

> Get the existing transaction model straight before building this. Decide explicitly whether the
> positive row is a second stored transaction or a derived view of the existing `loan_payment`, and
> **write the decision down**.

## The decision

**Derived view.** A loan's own ledger reads the *same* `loan_payment` transactions the funding side
already has, and displays them **positive**. Nothing new is written to `data.transactions`, ever.

One payment is one stored row, shown twice:

| Where | Sign | Source |
|---|---|---|
| The funding location (Personal / Joint / a Pot) | **negative** — money leaving | the `loan_payment` row, as today |
| That loan's own hero-card ledger | **positive** — money arriving at the debt | the *same* row, sign-flipped for display |

## Why

1. **A second stored row would double-count, everywhere.** `projection.ts`, `cycleSummary.ts`,
   `scenarios.ts`, every hero-card total and every trend chart already sum `loan_payment` rows. Each
   of them would need to learn to exclude the mirror row, and *every one of them missed* is a silent
   wrong number in a live app with real data. The prompt flags this risk itself.
2. **This app already does exactly this for credit cards.** `Transaction`'s own comment in
   `types/ledger.ts` says the credit-card types use "a separate, `type`-derived sign" on the card's
   OWN list, while `direction` governs the personal/joint ledger. The Joint and Pot ledgers do the
   same through `amountSign` overrides (`jointAccountSignedAmount`, `potSignedAmount`) passed into
   the shared list components. **The mirrored sign is an established display mechanism here, not a
   new concept** — a loan ledger is the fifth user of it, not a special case.
3. **Status comes for free.** Part C requires "show cleared" to bound cleared payments too. Only a
   real `Transaction` carries `status`. A schedule-derived row (`buildLoanLedgerRows`) has none, so
   deriving the ledger from the transactions rather than from the amortisation schedule is what
   makes the required filter possible at all.
4. **Non-destructive.** No migration, no backfill, nothing written. It cannot corrupt mum's live
   data, and it is trivially reversible — it is a rendering choice, not a data change.
5. **It matches the register's own preference.** `DIVERGENCE.md` rule: structural over textual, one
   source of truth over two copies that can drift. Two stored rows per payment is precisely the
   "two copies drifting apart" shape this project already rejects.

## What this rules out, deliberately

- **No mirror row is ever written**, including for historical payments. There is nothing to backfill
  and nothing to clean up if this is reverted.
- **The loan ledger's rows are not independently editable or deletable.** Editing a payment happens
  where the payment lives — on the funding side, or through the loan's own editor on Borrowing.
  A derived row has no identity of its own to edit.
- **No capital/interest split in the ledger** (Adam, explicit). `buildLoanLedgerRows` computes
  `capital`/`interest` per row and that stays available for the amortisation views on Borrowing —
  the loan's *hero-card ledger* simply does not show it.

## The consequence worth remembering

The loan ledger and the funding ledger can never disagree, because they are the same rows. If a
payment ever appears on one and not the other, that is a **window/filter** bug (the cycle bounds, or
the `showCleared` filter), never a data-sync bug — there is nothing to sync. Look at
`loanCyclePeriods` and the `inCycleWindow`/`cycleEndIso` call sites first; PROMPT-08a warns that the
2026-09-17 work needed `inCycleWindow` at 8 call sites and `cycleEndIso` at 4 for exactly this class
of bug.

## Decisions taken alongside it (Adam, 2026-09-18)

| Question | Decision |
|---|---|
| Which loans get a hero card | Any **active loan the logged-in person owns**, whatever its location — the same ownership rule credit cards and pots already use. **Plus: hide it once the loan is settled or fully repaid** (`!loan.active`, which `settleLoan` sets, *or* `summarizeLoan().remainingBalance <= 0` for one that simply ran to the end of its schedule — `active` alone does not cover that second case). |
| Ledger time range | **This cycle / Next 3 cycles**, the same two buttons every other card has — *not* the prompt's original "no horizon". The cycles counted are the **loan's own due-date periods**, not the pay cycle, exactly as a credit card counts its own statement periods. |
| Hero card front | **Owed now · projected · due date**, mirroring the credit card hero it sits next to. |
| Group by / order by | Still **not offered** (per the prompt). Every row on a single loan's ledger carries that loan's own category, so grouping by it is meaningless. |

**Note the two overrides of the written prompt.** PROMPT-08a Part C says "The only filter is 'show
cleared'. No group-by, no order-by, no horizon." Adam changed the horizon part on 2026-09-18: "This
cycle and next 3, matching the existing home page buttons. It should look exactly like everything
else." Group-by/order-by stay off as originally written. The prompt has been corrected in place.

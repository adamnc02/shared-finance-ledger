# App Knowledge — invariants, fragile areas, and open items

Written 2026-09-15 from a full read of `UAT-TRACKER.md` (15 batches), every dated PROMPT/UAT
script from 2026-09-07 → 2026-10-28, the live code at `personal-ledger@3b0f1d8`, both real backup
files, and a full run of all 103 `scripts/verify-*.ts`.

**Read this before any session that touches ledger logic.** It is the "how this app actually
behaves" companion to `DATA-MODEL-REVIEW-2026-09-15.md`'s "what the data looks like". Neither
replaces reading the code, but both stop you re-deriving things that cost real sessions to learn.

---

## 1. Core invariants — violate these and you will break real data

### 1.1 "Cleared is immutable"
A cleared `Transaction` is historical fact and is **never** retroactively rewritten or deleted.
This rule has resolved at least four separate bug reports as "not a bug, that's the rule":
- Joint-share rows in Adam's backup from before the 2026-09-04 reversal (`UAT-TRACKER` 4.2).
- Minimum-charge rows materialised under pre-fix credit-card code across three retest rounds
  (Batch 12) — which is why a retest of a card bug must use a **brand new card**, never the one
  from the previous round.
- Duplicated transactions from the location-relocate bug (Batch 7) — the fix guards future
  materialisation, it does not clean up what already landed.

**The one deliberate exception:** `isSweepableOnGeneratorDelete(t, asOfIso)` — a cleared row dated
**today** IS swept when its generator is deleted. Everything older survives.

### 1.2 Array order in effective-dated history is load-bearing
Six resolvers break same-`effectiveFrom` ties by **array index** (recency of recording):
`resolveTemplateAmount`, `resolveRecurringOverpaymentAmount`, `resolveMonthlyPayment`,
`resolvePensionAmount`, the savings-interest resolver, and `findApplicableSnapshot`.
**Never sort these arrays.** See `DATA-MODEL-REVIEW-2026-09-15.md` §11.7 and
`scripts/verify-bill-amount-tiebreak.ts`, whose header documents the real bug this prevents.

**Exception, 2026-09-16 — `Person.salaryHistory` no longer uses the array index.** It now
tie-breaks on `SalarySnapshot.recordedSeq`, an explicit per-person ordinal, because it is the one
of the six that becomes a real TABLE (`salary_snapshots`) in the Supabase migration, where row
order does not exist. `latestSalarySnapshot` uses the same rule. The array index survives only as
a defensive fallback. **The other five are unchanged and still index-based** — they become `jsonb`,
which preserves order. This ADDED a field; it did not sort or de-duplicate anything.

The design decision is explicitly *"fix the resolver, don't migrate the data"* — corrupted
history self-heals by being resolved correctly. Do not add a data migration on the assumption
duplicates are damage.

### 1.3 `kind` is `undefined` for a real bill
`RecurringTemplate.kind` is never set to the literal `'bill'`. Filters must test
`kind !== 'transfer'`, never `kind === 'bill'`. Getting this backwards broke the pot checklist
entirely once already (Batch 4 follow-up).

### 1.4 A transfer's `location` is derived, not independent
`locationTypeForTransfer` resolves to `'personal'` whenever personal is *either* endpoint. For a
transfer, the authoritative sides are **`fromLocation` / `toLocation`** — the flat
`potId`/`savingsPotId` columns cannot represent both ends of a Pot→Pot transfer and are not
trustworthy for membership questions. `potLedger.ts`/`savingsPotLedger.ts` read the
from/to fields directly for exactly this reason.

**Migration consequence:** `from_location_*` / `to_location_*` columns are the source of truth on
transfer rows; `pot_id`/`savings_pot_id` are convenience denormalisations. Do not build sync or
RLS logic that assumes the flat fields identify a transfer's pot.

### 1.5 Dedupe on materialisation is global, not per-location
`autoClearDuePayments` builds ONE `globalExistingKeys` set (`sourceType:sourceId:date`) shared by
every step, deliberately location-agnostic. Per-location sets caused duplicate transactions when
a bill's location changed twice with a past effective date (Batch 7, Bug 8.1).

### 1.5a A materialised occurrence's identity is its SLOT, not its date
`Transaction.occurrenceOriginalDate` holds the occurrence's natural, anchor-walked date — the same
key `RecurringTemplate.occurrenceOverrides` uses. **Identify a generated row by that, never by
`t.date`**, because a per-occurrence date move changes the date.

Added 2026-09-16 after a reported bug: `reconcileRecurringTemplateTransactions` matched its row by
either end of a *single* move, so a **second** move stranded the row (the intermediate date is
recorded nowhere) and the generator materialised the same occurrence again — two `cleared` rows,
both counting against the balance. All three single-occurrence surfaces (bills, recurring
transactions, recurring transfers) share one generator and one reconciler, so all three had it.

`dedupeKey` is deliberately still `sourceType:sourceId:date`. **Do not "finish the job" by keying
it off `occurrenceOriginalDate`** — rows materialised before that field existed carry none, so
their key would stop matching fresh candidates and every legacy row would duplicate. The reconciler
moving the row onto the override's current date is what makes the date-based key correct again.
Legacy rows are stamped on first sight by the reconciler; there is no migration.

### 1.5b Clearing runs BOTH ways
`autoClearDuePayments` Step 1 moves a row pending → cleared once its date arrives.
`reconcileRecurringTemplateTransactions` does the reverse: **a generated row dated in the future is
never `cleared`.** Adam hit this in UAT on 2026-09-16 — a bill moved from yesterday to tomorrow
stayed cleared, so money showed as already spent on a date that had not happened.

Written as a **state** rule, not a transition, so rows already stranded by the bug self-heal on
load. Safe only because a `recurring_template` row's cleared status is never hand-set —
`autoClearDuePayments` is the only thing in the app that clears anything — and
clearing has no side effect at all (`applyClearSideEffects` and the `savings_contribution` type were
removed with `savingsEntries`, 2026-09-17).
**If a manual "mark as cleared" path is ever added, this invariant needs revisiting.**

> **The generalisable lesson:** the date fix was tested against dates and balances, and nobody
> asked what *else* on the row was derived from the date. When a fix changes one field on a
> materialised row, check every other field computed from it.

### 1.6 `importGeneration` is how pages recover from a wholesale data replacement
`setData` bumps `importGeneration`; `Salary.tsx`/`Bills.tsx`/`Loans.tsx` each have a `useEffect`
keyed on it to resync derived UI state (section-open flags, default owner ids, expanded rows).
Ordinary mutations must **not** bump it, or sections snap open/shut under the user.

> **🚨 Migration consequence:** under PowerSync, `setData` stops being the only wholesale-
> replacement path — a first sync, or a large inbound sync, delivers a whole new dataset without
> ever calling `setData`. Unless `importGeneration` is also bumped on "first sync complete",
> every one of those pages will render stale derived state after signing in. This is a
> non-obvious, near-certain bug in the PowerSync session if not planned for.

### 1.7 A statement window changes which cycle spend belongs to — and protects it
With `statementStartDay`/`statementEndDay` set, spend inside a window is due on the payment date
**after** that window closes (19 Aug–18 Sept → due 14 Oct). Without a window, spend counts toward
the **very next** payment date, with no lag. Verified 2026-09-15.

That difference is not cosmetic: the no-window path puts spend inside the same cycle as a payment,
which is what exposes credit-card mechanism 6 (above). Both of Adam's mum's cards predate the
statement-window feature and have none.

**Two separate home-hero ledger paths, and they disagree:** with `cycleTotals` ON,
`buildCreditCardCycleSections` includes generated pending minimum charges; with it OFF, the flat
`activity` list (`Home.tsx:3608`) is built purely from `data.transactions` and showed **only
materialised rows**, so a pending minimum charge never appeared. **FIXED 2026-09-16 (Batch 16):**
the flat list is now derived by flattening the same sections the cycle-totals-on path renders, so
the two cannot disagree by construction.

### 1.8 The home page ledger is the downstream consumer of everything
Adam's standing rule, 2026-09-15: *"everything done in the other pages feeds the home page ledger."*
Bills, Loans, Borrowing, Transactions and Wallet all write into state the home hero cards render.

**So any engine change must be verified on the home page too, not only on the page that owns the
feature.** A fix that looks right on Borrowing and wrong on Home is not finished.

> ### 🚨 HARD RULE — credit cards use their own periods
> Adam, 2026-09-15: *"credit cards explicitly use their own pay cycle windows, they do not follow
> the other cards periods. This is a hard rule, not to be touched."*
>
> A credit card's periods come from its own `paymentDayOfMonth` and statement window, with the
> payment due date as the **last day of the cycle**. Every other card type (Personal, Joint,
> Household, Pot, Savings Pot) follows the **household pay cycle**. Never align a credit card to the
> household cycle, and never align the others to a card.
>
> **`creditCardCyclePeriods` is confirmed working (Adam, 2026-09-15) and must not be changed.**
> Verified: mum's cards both give `2026-09-15 → 2026-10-14`, due `2026-10-14`.
>
> **Former violation, FIXED 2026-09-16 (Batch 16):** the home hero's flat list filtered by
> `resolveCycleBounds(data, primaryPersonId, …)` / `horizonRangeEnd(…)` — the household cycle. For
> mum's cards that window ends 2026-10-13, one day before the card's own due date of 2026-10-14,
> so the upcoming charge could never appear there. It now reads the card's own periods.
>
> **Expected consequence, not a regression:** a payment belonging to the *previous* period (mum's
> 14 Sept cleared payment) correctly drops out of "This cycle", where the household cycle used to
> include it.

Two traps found 2026-09-15 while checking this:
- **Credit cards have two home paths that can disagree.** `cycleTotals` ON uses
  `buildCreditCardCycleSections` (the card's own periods); OFF uses a flat `activity` list
  (`Home.tsx:3608`) filtered to the **household pay cycle**. For mum's card the cycle-sections path
  is *already correct* while Borrowing's `buildCreditCardMinimumChargeRows` is not — so the home
  page is the better reference implementation, not the thing to bring into line.
- **The two windows differ, and one of them is wrong.** A card's due date (14 Oct) falls outside the
  household's current cycle (ending 13 Oct), so "This cycle" on the flat list hides a charge the
  cycle-sections view shows. Per the hard rule above, the flat list is the one at fault.

### 1.8a Household and Joint share ONE "Group by Person" implementation
Since 2026-09-16 (PROMPT-03) both cards render Person grouping as `CycleGroupedList groupByPerson`
→ `PersonPills` (cycle-outer, person-inner, cycles auto-expand). They differ only in the
`buildPersonGroups` they pass — Joint defaults to `buildJointPersonGroups` (payee shares + an
unattributed "Spend" bucket); Household passes `buildHouseholdPersonGroups` — and in `amountSign`.
**A change to either card's Person view must be checked on the other.**

`buildHouseholdPersonGroups` attributes a row by **object identity** to the projection it came
from, because the combined list is `personProjections.flatMap(pp => pp.transactions)`. That is
what makes a cycle's pills sum to its ungrouped total by construction. Do not "simplify" it into
an `ownerId` lookup, and do not clone rows between `computeHouseholdProjections` and the list
(`ownerId` is only a fallback). `verify-household-person-grouping.ts` asserts the reconciliation.

A pill's figure is that person's **net for the cycle**, not a balance. The old Household view
showed `clearedBalance` per person; that meaning deliberately changed.

**Known, pre-existing, not fixed:** Household's header "projected" sums each person's OWN horizon
(`pp.projectedBalance`), but every Household list uses the **primary person's** cycles. A
four-weekly person's horizon can end later (Ella: 7 Jan vs Adam's 30 Dec), so a row between the two
(her £260 Tesco loan payment, 1 Jan) counts in the header but appears in no cycle. Raised with
Adam 2026-09-16.

### 1.9 Modals must portal to `document.body`
Page components render inside `#app-content` (`overflow-y-auto`). The trends work re-confirmed
this: `TrendsModal` copies `FiltersSheet`'s portal pattern verbatim because the bottom nav
otherwise renders on top of the sheet. (`MIGRATION-LESSONS.md` §15.)

### 1.10 A responsive SVG with a fixed viewBox misleads a `getBoundingClientRect` hit-test
Learnt 2026-09-16 (PROMPT-04 Bug A), **measured, not assumed.** `width="100%"` plus a fixed viewBox
and no `preserveAspectRatio` means the default `xMidYMid meet`: the drawing is scaled **uniformly**
and **centred**, so it doesn't fill the element. In the 350px Trends modal the 320-wide pill chart
had 15px of dead margin each side, and the 364-wide line chart rendered at 0.962. Any hit-test of
the form `(clientX - rect.left) / rect.width * WIDTH` is then wrong near the edges. The line chart
was also scaling by 320 instead of its real viewBox width, so it trailed by 38px.

**Map through the rendered transform:** `(clientX - svg.getScreenCTM().e) / svg.getScreenCTM().a`
(`clientToViewBoxX` in `TrendChart.tsx`). Correct at any size, letterboxed or not.
`preserveAspectRatio="none"` also works but distorts rounded pill caps. **This app hand-rolls
several charts; any new one must hit-test this way.** Touch tests need real CDP
`Input.dispatchTouchEvent`, not mouse events.

### 1.11 Savings pot pill chart — what a column means (Adam, 2026-09-16)
- **Fill = the period's end balance.** Full track height = the **highest balance reached anywhere in
  the view** (`SavingsPotTrendSeries.peakBalance`), counting a day's money **in before its money
  out**, because rows have no time of day. It is *not* net change; the first build did that, and
  the only tall column was a withdrawal.
- **Tooltip:** period label + end balance; red ↓ `£X OUT` / green ↑ `£X SAVED` / `No change` (net);
  a small `£in · £out` sub-label (gross); **fixed height**, no per-transaction list. Every point has
  `moneyIn − moneyOut === netChange`, asserted in `verify-savings-pot-trend-series.ts`.
- **Periods before `openingDate` are not shown** in any granularity (Year drops them explicitly).
  `savingsPotBalanceAsOf` still returns `openingBalance` for a pre-opening date. **Any new
  consumer must clamp to `openingDate` itself**, or it will show money before the pot existed.
- Pills are capped at 24 viewBox units and centred in their slot; the slot is the touch target.

### 1.12 Changing WHEN a schedule pays re-dates stored payments; it never re-creates them
Learnt 2026-09-16 (PROMPT-05 UAT, then an app-wide audit). Every generator re-derives occurrences on the fly and dedupes against stored rows by DATE (templates by slot). Changing the day, frequency or follows-payday rule of any schedule therefore orphaned every stored payment and re-materialised the whole history on the new day. That was confirmed on templates, loans, recurring overpayments, card payment day, salary payday, pensions and savings-interest opening date.

**The rule, on every surface:** the user picks the payment the change starts from (`EffectiveDatedChangeFlow` picker).
- Stored payments from that one on are re-dated one-to-one.
- Keyed data moves with them: overrides, pauses, amount boundaries, salary overrides/sorts, card minimum overrides.
- Nothing before it is re-generated.

**How each generator enforces "nothing before":**
- **Templates:** re-anchor (`applyTemplateScheduleChange`), plus `anchorDayOfMonth` for a 31st anchored on a short month.
- **Pensions, loans, overpayments, cards:** `scheduleFrom` floors (`lib/scheduleChange.ts`).
- **Salary:** `PayCycleConfig.paydayHistory`.
- **Savings interest:** a period already paid on another day is skipped.

**Any new generator, or any new editable date on an existing one, needs this too.** `verify-no-duplicates-on-schedule-edit.ts` is the template for proving it: old behaviour duplicates, new doesn't, earlier rows untouched, auto-clear stable, projected ledger clean.

Two details that cost time:
- **Payday rules have two boundaries.** A payday change needs `until` (the chosen payday's old date) AND `nextRuleFrom` (its new date). They differ, and 2nd → 28th makes September hold two paydays.
- **The picker shows display dates; identity is the slot.** Always map through `occurrenceSlotForDate` (with the pay cycle, for follows-payday transfers).

### 1.13 The template reconciler must resolve dates exactly as the generator does
`reconcileRecurringTemplateTransactions` used `override?.date ?? slot` for a stored row's date. The generator applies `resolveTemplateOccurrenceDate` (payday / cycle-start) on top. So every follows-payday transfer's stored row was moved back to its slot on the next load, and the payday row was generated again: **one more duplicate per load, live, needing no edit** (Adam's deposits from 1 Oct 2026, caught 16 Sep). Fixed.

The reconciler also skips rows whose slot is before the template's anchor. Those belong to an earlier schedule, and re-pricing or re-dating them under the new rules rewrites paid history.

### 1.13a A date-moving transfer is range-checked by the date it's PAID (2026-09-17)
- **The mechanism:** a `followsPayday`/`followsCycleStart` transfer's slot (walked from its anchor)
  resolves to a LATER date, the next payday or cycle start, up to one pay period later.
- **The bug:** `walkOccurrences`/`scheduledTemplateDates` used to keep an occurrence if its slot
  was in range. So a range starting between the slot and the payday silently dropped that payment.
  - **Adam's case:** slot 12 Sep, paid 30 Sep. On 17 Sep the transfer header said "Next 30 Oct",
    and a savings pot opened 12 Sep had no 30 Sep deposit.
  - **Also wrong, found afterwards:** the Home savings pot card's projected balance
    (`projectedBalanceAt` from today) was one deposit short: "Next 3 cycles" £2,004.17 vs the
    correct £3,009.52.
  - **Why only some views:** "Manage upcoming payments" (then −2 months; since 2026-09-19c a −13-month
    range trimmed to the last payment + next 12, §1.23) and the Home ledger (cycle start) looked right
    because their ranges start earlier.
- **The rule now:** for those templates, the walk starts 2 months early and filters by the resolved
  date. Identity is still the slot (§1.5a). Plain templates are unaffected (slot === date).
- **If you add a "from today" view of transfers, you get this for free. Don't filter by
  `originalDate`.**
- **Proof:** `verify-follows-payday-range.ts`. Stored rows, auto-clear and Home were identical
  before and after in a 4-month simulation on both real backups.

### 1.14 Deletes are RESTRICT, and the decisions are a draft
A Person, Pot or Savings Pot can't be deleted while anything references it (`findDeleteBlockers`).
- **Decisions are staged:** the sheet stages Move/Delete per item, and nothing changes until Delete, which applies all of them plus the delete in one update, or nothing.
- **Moves from a delete rewrite PENDING rows only** (a row cleared today included). The Bills/Borrowing "move to a pot" flow keeps its own cleared-rows-too behaviour.
- **Joint splits:** a deleted person's joint split items move at 100% and become Personal when one person is left.

### 1.15 A card's minimum payment can be paid from a Pot (2026-09-16, Batch 20)
`CreditCard.location` / `potId` (absent = Personal), changed from a chosen payment exactly like a
loan (`applyCreditCardLocationChange`, `lib/locationChange.ts`).
- **Only the minimum payment moves.** Logged/lump payments and Clear stay Personal.
- **Stored minimum payments have no `sourceType`**, so they're matched by `creditCardId` +
  `type: 'credit_card_payment'` + `!sourceType`, never by `sourceType/sourceId`.
- **Every generator caller filters by the row's location:**
  - Personal projection and auto-clear Step 2 take `personal`;
  - `generatePotOutgoingTransactions` (pot ledger, auto-clear Step 3, Salary Sort) takes the pot's rows.
- **Always pass the full `data.transactions`:** the card's balance simulation must see every
  payment, whatever it was paid from.
- **Not in the pot checklist** ("What this pot pays"): it lists bills and loans only. The card is
  moved from its own edit form on Borrowing.

### 1.16 A loan's `sourceId` is NOT always the loan (2026-09-18, PROMPT-08b)

Four transaction source types land on a loan, and one of them breaks the obvious rule:

| `sourceType` | `sourceId` is |
|---|---|
| `loan` | the loan's id |
| `loan_recurring_overpayment` | the loan's id |
| `loan_settlement` | the loan's id |
| **`loan_overpayment`** | **the OVERPAYMENT's own id** (`applyLoanOverpayment`) |

Anything selecting a loan's rows with `t.sourceId === loan.id` therefore silently drops one-off
overpayments — and drops them *only* on the loan's own surfaces, since the funding account's ledger
filters by type and category instead. PROMPT-08a shipped exactly that bug with a comment asserting
the opposite. Match `loan_overpayment` against **that loan's own overpayment ids**; matching on
`sourceType` alone would let one loan absorb another's.

### 1.17 An overpayment's PAID date and its RECOGNISED date are different (2026-09-18, PROMPT-08b)

`buildLoanSchedule` folds a one-off overpayment into whichever period shares its **month**. That is
correct and must not be "fixed": the engine must not compound interest differently because a lump
landed mid-period. But it means the absorbing schedule entry is routinely **later** than the day the
money left the account — a payment on the 17th on a loan due the 28th is recognised on the 28th.

**Any "as of today" read derived from `schedule.filter(e => e.date <= today)` is therefore wrong for
up to a month after every overpayment.** This has now bitten twice:

- PROMPT-08a — the trend chart drew the dip on the period's date, labelled with the monthly payment.
- PROMPT-08b — `summarizeLoan` and `summarizeLoanProgress` reported the loan exactly as it stood
  before a £7,000 payment, taking the owed figure, the progress bar, the pie chart and the Borrowing
  page with them.

`appliedOneOffOverpayments(loan, schedule)` maps each overpayment to **both** dates, and
`unrecognisedOneOffOverpayments(loan, schedule, asOfIso)` returns what is paid-but-not-yet-recognised.
A one-off overpayment is 100% principal, so crediting the cash figure straight against capital is
exact. Once the absorbing period passes the credit falls to zero and the schedule takes over — check
that boundary in anything new, it is the double-count trap. **Use these helpers rather than writing
a third copy of the consumption loop**; two copies is what let the chart and the reads disagree.

### 1.18 Two loan totals, and which one a progress figure needs (2026-09-18, PROMPT-08b)

- **`nominalTotalPayable`** — the CONTRACTUAL total, deliberately frozen against overpayments and
  pinned by `verify-loan-amortisation.ts`. Right for `summarizeLoan.totalPayable` and settlement.
- **`amortisedTotalPayable`** — the real schedule's own total, after every logged overpayment.

A progress figure needs the second. Against the first, **a loan with overpayments can never reach
100%** — overpaying shortens the term and cuts the interest, so the real total falls below the
contractual one and the bar tops out short of full before the loan closes (mum's Car Finance with a
£7,000 overpayment: 90.65%). `LoanProgress.percentPaid` and `amortisedRemaining` use the amortised
pair; `totalBalance` and `nominalRemaining` are kept for the contractual view. The two totals are
identical for a loan with no overpayments, which is why this was invisible for so long.

### 1.19 The progress bar's tooltip is positioned in percentages, on purpose (2026-09-18, PROMPT-08b)

`ProgressBar`'s mini-tooltip arrows must land exactly on the end of the fill. The mechanism is that
**every x is a percentage of the bar's width** (`progressTooltipLayout`) and the tooltip row is a
sibling of the bar inside one `w-full` parent — so "42%" resolves to the same x in both at any screen
width, with nothing measured and nothing to drift. The only pixel values are the box's height and
the arrow's own size. If anyone ever "simplifies" this to a measured pixel offset, the arrows will
be right at one width and wrong at another. Near 0%/100% the BOX is clamped inside the bar's bounds
(CSS `clamp()`); the arrows are never clamped.

Related: a CSS border-triangle **cannot carry a border**. Outlining one with a second, larger
triangle leaves its flat top edge showing as a sliver. The arrow is an SVG `<polyline>` tracing
left corner → tip → right corner precisely so the top edge is never drawn.

### 1.19a The loan ring's segments and its legend are DIFFERENT numbers (2026-09-20, PROMPT-13 Part A)

Extends §1.16–§1.19. A loan's pie chart is three solid, round-capped arcs — green paid, amber
projected, red remaining — and a legend table above it. **The two carry different figures on
purpose, and the single most likely "fix" a later session will attempt is to make them agree.**

On Adam's own worked example, a £10,000 loan with £4,000 paid and £500/month over the next 3 cycles:

| | segments (the ring) | legend (the table) |
|---|---|---|
| Paid | 40% | 40%, £4,000 |
| Projected | **15%** | **55%**, £5,500 |
| Remaining | 45% | 45%, £4,500 |
| **Sums to** | **100** | **140** |

The amber **ARC** is the £1,500 INCREMENT, because it is drawn starting where green stops — anything
else overlaps it. The amber **ROW** is the £5,500 CUMULATIVE figure, because the table exists to
explain the balances printed beside it, and a 15% matching nothing else on its row invites a bug
report. Adam settled it on 2026-09-20 (§0 Q1). The `%` column summing to 140 is correct.

Likewise the delta column: **only the amber row carries one.** Green and red both read an em dash
(§0 Q2 — Adam chose this over the recommendation). `−£1,500` on the red row is wrong, and
`verify-rag-legend-rows.ts` pins it explicitly because it is the plausible mistake.

Both come out of `ragProgress` in `src/lib/progressSection.ts` — never computed in a component, so
the sweep can see them. Red is derived as the REMAINDER of the ring (`100 − paid − projected`),
which is what guarantees the arcs sum to exactly 100 at every rounding.

**Scope, and how it is enforced.** Loans only. Credit-card and savings-pot rings keep the
two-arc colour-plus-translucent treatment and are out of scope by CONSTRUCTION: `ProgressRing`
switches on whether a `segments` prop was passed at all, and `verify-progress-section.ts` asserts at
the SOURCE that exactly two of the four rings pass one. A numeric check cannot see a later session
helpfully extending RAG to every ring — every ring would still be handed the same `percent`.

### 1.19b Adjacent round-capped arcs overlap by a full stroke width (2026-09-20, PROMPT-13 A1)

`strokeLinecap="round"` extends each end of an SVG arc by HALF THE STROKE WIDTH beyond the path's
real endpoint. Two arcs butted together at the same angle therefore overlap by a **whole** stroke
width, which at the ring's 22px stroke is very visible and reads as a rendering bug.

`ProgressRing` insets every segment at both ends by `strokeWidth / 2 + SEGMENT_GAP / 2`; the cap then
fills back out to the nominal boundary and `SEGMENT_GAP` of background shows between neighbours. The
gap treatment was chosen over z-ordering because z-ordering only HIDES the overlap — the boundary
between two segments still sits half a stroke width away from the number it represents.

**The consequence to know about:** a segment's path can inset to nothing. An arc shorter than
`2 × inset` would render with a NEGATIVE dash length, which SVG draws as a **full circle** — so a
0.3% segment would paint the entire ring in its colour. Those segments are dropped instead. A
single segment owning the whole ring skips the mechanism entirely and draws a plain circle, since a
100% ring with a gap cut into it also reads as a bug.

### 1.19c A modal's horizon and the page's are allowed to disagree (2026-09-20, PROMPT-13 A3)

`ProgressModal` covers the page, so the page's This cycle / Next 3 cycles control sits behind it and
cannot be reached. The LOAN modals now carry their own control and are **deliberately independent**
of the page's filter — that is what Adam meant by "not restricted due to the filters on the main
home page". The preview bar outside keeps following the page. 08b-era comments saying the two
"always agree" described the bug, not the design.

🚨 **This is why `horizonEndDate` became `horizonEndFor(horizon)`.** The old fixed date was derived
by each caller from the PAGE's horizon. With the page on This cycle and the modal switched to Next 3
cycles, the projection would have been taken against **this cycle's end**, and every amber segment
would have been far too small with nothing on screen to suggest anything was wrong. Each call site
returns its own previous value unchanged for the page's own horizon, so the default view is provably
identical to before.

### 1.19d Round-ups and the Coin Jar: the credit is DERIVED (2026-09-20, PROMPT-13 Part B)

A £7.50 card shop is stored as **£8.00**, remembering it came from £7.50. The 50p funds a pot called
Coin Jar. £7.50 leaves net worth; 50p moves.

**The predicate, in full** (`shouldRoundUp`, `src/lib/roundUp.ts`), every clause with its own
assertion and its own control in `verify-round-up-predicate.ts`:

```
type === 'expense' && paymentMethod === 'card' && location === 'personal'
  && !creditCardId && roundUpEnabledOn(payCycle, t.date) && uplift > 0
```

Adam: *"Card expenses only."* Not cash, not bank transfer, not a bill, loan payment, credit-card
payment or credit-card spend, and nothing located in a pot or the joint account. An exact pound is
not rounded — that falls out of `Math.ceil` returning the same pound, so the uplift is zero.
`!creditCardId` is belt and braces: a credit-card charge is `credit_card_spend`, never an expense,
but the EDIT path can still attach a card id, and a card charge is not money leaving the account.

🚨 **THERE IS NO SECOND TRANSACTION, AND THE UPLIFT MUST NEVER REACH PERSONAL CASH TWICE.**
`amount` is ALREADY £8.00, so every existing reader — the ledger, every projection, every total — is
correct **untouched**. The danger is a well-meaning addition: wire the uplift into the personal
ledger "so it balances" and a £7.50 shop takes £8.50 out of cash. `verify-coin-jar-balance.ts`
measures the move against a rounding-off control so the figure cannot drift.

The jar's balance is the sum of `amount − roundedFrom` over rows naming it, folded in inside
`potBalanceAsOf` itself rather than at the call sites, so a caller cannot forget it and report an
empty jar. **Delete the expense and the credit goes with it, automatically, because it was never a
row.** Same "derive it, don't store it twice" rule PROMPT-11 used for a Salary Sort's person.

**Editing recomputes, from the REAL price.** The edit forms seed their amount field from
`roundedFrom ?? amount`, so a £7.50 shop stored as £8.00 opens at 7.50 — seeding from `amount` would
ratchet the row up a pound on every save. This does not contradict "a switch never rewrites a stored
row": `roundUpEnabledOn` resolves against the **row's own date**, so a row logged inside an enabled
window keeps rounding after the switch is turned off, and an edit is the person's action.

**Whose jar:** the expense's own `ownerId`, gated on that person's own switch (§0b Q5). In a
two-person household Ella's card expense rounds into Ella's jar. There is no household-wide jar.

### 1.19d-3 The Coin Jar is now fed by TWO apps, and only one of them rounds (2026-09-21, Listly PROMPT-05)

Listly writes `shared_finance_ledger.transactions` through a trigger, and since `20260921220000` it
writes `rounded_from` / `rounding_pot_id` too. So **the jar's balance can now come from rows this
app never created**, and the assumption that every row in `transactions` was made here is wrong.

🚨 **The ledger app must NEVER re-round a bridge row.** It arrives with `roundedFrom` set and
`amount` **already** at £8.00. Rounding it again takes £9.00 out for a £7.50 shop. Nothing in this
app needed changing to read one — `mapping.ts` already maps the pair and `potBalanceAsOf` already
folds the uplift in — so **if a session finds itself editing `src/lib/roundUp.ts` "for Listly", the
likely cause is re-rounding a row that is already rounded.** `shouldRoundUp` is safe as written,
because £8.00 has a zero uplift; the danger is a future change that seeds from `amount` rather than
`roundedFrom ?? amount`.

**The rule is the same in both apps, and it is decided in the app, not the database.** Listly shows
the person the rounded figure at pick time and the trigger carries it; there is no rounding engine
in SQL, and there must not be one.

🚨 **A BACKDATED Listly shop does not round — deliberately** (Adam, 2026-09-21). Answering "was
rounding on *then*" means walking `roundUpHistory`, and a second implementation of that walk in SQL
is precisely the thing that drifts from this one silently (§1.19f is what it would have to
reproduce). Listly's RPC answers against the current rule only, and the step simply disappears when
the date is not today. **This is a limitation, not a bug** — it is written down here because it is
exactly the kind of deliberate gap that gets reported as one six weeks later. A backdated expense
entered **in this app** still rounds on its own date, unchanged.

🚨 **§1.19d-2 REACHES ACROSS THE APP BOUNDARY, and it took a bug to notice** (UAT 2026-09-22). A
Listly shop where the person chose "leave it" arrived correctly unrounded, and this app's
transaction form then showed its round-up checkbox **TICKED** — because the form seeds from
`roundUpSkipped`, and Listly stored no such flag. Editing anything else on that row and saving would
have **rounded it**: a declined £4.25 booked at £5.00, with 75p appearing in the jar.

The argument that Listly needed no flag was that a Listly completion is written once and never
recomputed. True of the completion; **false of the transaction it becomes.** The row is shared, and
**only one of the two apps recomputes rounding on every save — this one.** That is the app whose
rules decide whether a flag is needed, whoever writes the row.

**Fixed at source 2026-09-22** (`20260922030000`): Listly stores the decline and the bridge carries
it into `transactions.round_up_skipped`, which this app already reads — **no change was needed
here.** Only an explicit decline is marked; a Listly shop that could never have rounded (joint, pot,
exact pound, backdated, or booked offline) carries nothing, so this app is still free to round it if
the person edits it here. 🚩 Rows booked BEFORE that migration carry no flag and still ratchet —
`PROMPT-13a` §0.3.

🚨 **Do not "simplify" the form to seed its checkbox from `roundedFrom` instead.** It breaks the
exact pound: £8.00 has no `roundedFrom` because there was nothing to round, and the box would then
read "will not round" when editing it to £8.50 would.

**Whose jar, from either app:** the expense's own `ownerId`. In a two-person household Ella's
Current Account shop booked from Listly on Adam's phone feeds **Ella's** jar, gated on **her**
switch — the same rule §1.19d states, reaching a second app.

### 1.19f-2 The switch's two fields describe the CURRENT rule, not the timeline (2026-09-22, Listly UAT)

`round_up_enabled` and `round_up_effective_from` are a **snapshot of the rule in force now**, not a
description of history. Read them alone and you get the right answer only while that rule started in
the **past**.

🚨 **A change dated in the FUTURE inverts them.** Adam switched round-ups off *effective from the
24th*: the pair becomes `(false, 24th)`, so `enabled AND effective_from <= date` reports **not
enabled for every date before the 24th** — exactly the dates on which rounding is still ON. Listly
stopped rounding two days early while the ledger, which walks `roundUpHistory`, kept rounding
correctly to the 24th.

**There is no pair of fields that can express "on until the 24th, off after".** That is two rules,
and the earlier one lives in the history. Anything asking "was rounding on THEN" — this app, the
Listly RPC, a future report — must resolve the rule set, not read the pair. This is §1.19f one level
up: the history is not an audit trail, it is **part of the answer**.

🚩 **And a latent hole in `roundUpEnabledOn` itself, found by the parity test that came out of
this — ✅ FIXED the same day (PROMPT-13a Part C).** An earliest history entry with a null `from` was
read as governing *from the beginning of time* (`rule.from === null || dateIso >= rule.from`), the
very failure §1.19f warns about: switching rounding off would retroactively declare every historic
card expense rounded. `applyRoundUpChange` always writes a `from`, so it could not arise from the
UI — but a restored backup, a hand-edited file or any future writer of `roundUpHistory` could
produce one.

The clause now reads `rule.from !== null && dateIso >= rule.from`: **a rule with no resolvable start
governs nothing**, matching what the SQL already did. Ported to all three ledger repos, and the
parity test asserts plain AGREEMENT, so a revert cannot pass quietly.

🚨 **The lesson is the one worth keeping: the hole was found by a test written for a DIFFERENT app.**
Nobody was looking at `roundUpEnabledOn`. Listly needed the same answer from SQL, the two were run
side by side, and the disagreement was the bug. **When a second implementation is unavoidable, the
test that compares them is worth more than either implementation's own tests.**

### 1.19e Why the Coin Jar's opening balance is editable when no other pot's is (2026-09-20, B5)

Every other pot's `openingBalance`/`openingDate` pair is **deliberately a one-time creation-only
anchor** (`Salary.tsx` ~1857: *"a one-time creation-only anchor"*), because you state it on the form
that creates the pot.

**A Coin Jar is created by a SWITCH, not by a form, so it never got that chance.** Adam: *"it needs
the ability to set opening balance and as of date."* Both therefore stay editable on a Coin Jar and
only on a Coin Jar. **This is not an inconsistency to tidy up**, and both the type and the form say
so in as many words.

The rest of B5's restrictions — no ring, no target, no recurring deposits, funds no bill/loan/card
payment, no ad-hoc spending out of it — are enforced in the **generators** in `potLedger.ts`, not
only in the pickers, because "a hidden picker entry is not enforcement": a hand-edited backup or an
import can point a bill at the jar and the pickers can do nothing about it. `fundablePots` filters
the funding pickers and is deliberately **not** applied to transfers, the Wallet stack or the
rebalance targets — transfers in and out are allowed, and a jar you cannot empty is a trap.

🚨 **The "What this pot pays" checklist is a picker too, and it was missed** (found by Adam,
2026-09-20). It does NOT go through `fundablePots` — `potEligibleItems` in `Salary.tsx` builds its
own list from the templates and loans directly — and it is the single most direct route in the app
to pointing a bill or loan at a pot: one tap, no location flow. It now returns nothing for a Coin
Jar, which hides the whole section. The generators would have refused the payment anyway, so no
money could ever have moved; the jar was simply offering a choice it would then silently ignore,
which is worse than either answer alone. **When adding a restriction, grep for every list that is
built locally, not only the ones that go through the shared helper.**

### 1.19d-2 The per-transaction opt-out must be STORED, not inferred (2026-09-20, B1a)

Adam, 2026-09-20: *"the per transaction level ability to ignore rounding ONLY if the coin jar
exists. By default, the value should be set to round up if the toggle is on. But I can turn it off
per transaction."*

`Transaction.roundUpSkipped` is a real field, and it has to be.

🚨 **On a saved row, "was not rounded" and "was DELIBERATELY not rounded" are indistinguishable** —
both simply lack `roundedFrom`. And `roundUpFields` recomputes from the rules **every time a row is
saved** (that is what makes B3's "editing recomputes" work). So without a stored flag, editing the
note on an excluded row would silently round it after all, and the person would have no way to make
the exclusion stick. This is the same class of problem as §1.19f: a decision that cannot be
reconstructed from the data has to be recorded in it.

`shouldRoundUp` checks it **first**, before every other clause — the person has said "not this one",
and that beats the rules.

**Where it is offered** (`roundUpAvailable`): a Coin Jar exists, rounding is on **for that row's own
date**, and the row is a card / personal / ad-hoc expense with no `creditCardId` — i.e. exactly the
rows that would otherwise round. Two deliberate details:

- **It is NOT gated on the amount.** An exact pound still offers the control, so it cannot blink in
  and out as a figure is typed in the edit form. Callers with nothing to ask — the add wizard, where
  the amount is already fixed — check the uplift themselves and skip the step.
- **A row that has already opted out still offers it**, or there would be no way to opt back in.

**Two surfaces, each matching how that screen already works:** a final `round_up` step in the add
wizard (rounding pre-picked in coral, the same treatment "Card" gets on the Payment method step),
and a plain checkbox on the edit form — *"Editing just loads the form, no flow"*.

### 1.19e-2 The round-up toggle's home is DERIVED from whether the jar exists (2026-09-20, B4)

Adam's refinement, after the first build put it permanently in the pay cycle settings:

| State | Where the toggle is |
|---|---|
| No Coin Jar yet | The person's **pay cycle settings** (the Wallet cog) |
| Coin Jar exists | The **jar's own expanded form**; settings shows a one-line pointer |
| Jar deleted | Back to **pay cycle settings**, and rounding is switched **off** |

It cannot simply live on the pot, because the pot does not exist until the switch is first turned on
and an always-visible Coin Jar for someone who has never used the feature was explicitly rejected:
*"this is a circular dependency"*. But once the jar is real, the jar is where you look for it.

🚨 **Deleting the jar MUST also switch rounding off, and that is why the arrangement is safe.** A
Coin Jar is an ordinary `Pot` to `SwipeToDelete` — there is no `isCoinJar` special-case on deletion.
A toggle living only on the pot would become unreachable the moment the jar was deleted, and worse,
`roundUpEnabled` would sit at `true` while `coinJarForOwner` returned `undefined` and
`roundUpFields` quietly rounded nothing. The switch would read "on" and do nothing, with no way to
tell and no way to fix it. `removePot` therefore applies `applyRoundUpChange(cycle, false, today)`
when the pot it is deleting is a jar.

**B3 survives it.** The delete is dated and recorded in the history like any other switch, so the
window rounding WAS on for is preserved — rows logged then still resolve as rounded, and nothing
stored is rewritten. Their derived credits disappear with the jar, because they were only ever
derived from it.

The pot form uses the **jar owner's** pay cycle and paydays, not the primary person's.
`verify-coin-jar-restrictions.ts` asserts that exactly one of the two homes shows the toggle at any
moment — the unreachable-toggle failure is invisible to any numeric check.

### 1.19f A dated on/off history needs a start date; a payday history does not (2026-09-20, B4)

`PayCycleConfig.roundUpHistory` mirrors `paydayHistory`'s shape and adds one field, `from`. It is
not decoration, and its absence was a **real bug caught by its own check on the first run**.

A payday rule can safely govern all of time before the first recorded change, because *some* payday
rule has always applied. **Rounding has not** — before it was first switched on it was OFF. Without
an explicit start, the earliest history entry governs from the beginning of time, so the moment you
switch rounding off you retroactively declare it to have been ON for every date before it existed,
and every historic card expense starts reporting as rounded.

Anything else in this app that records a dated on/off switch in the same shape needs the same field.

### 1.19f-2 The round-up switch's date is a DATE; a payday change's is a PAYDAY (2026-09-22, PROMPT-13a B)

`EffectiveDatedChangeFlow` has two date modes, and which one a caller gets says what kind of change
it is:

| Mode | The change | Why |
|---|---|---|
| `occurrences` — one button per real payment | **Re-dates something stored**: a payday, a bill, a loan payment, a pension | The new rule has to take hold on a date a payment actually falls on |
| `datePicker` — a plain `<input type="date">` | **Re-dates nothing**: so far only the round-up on/off switch | Any calendar date is legitimate, including one that is not a payday |

The switch borrowed the payday picker because it first lived next to the payday change in the pay
cycle settings. Adam, 2026-09-22: *"it should be a date picker... which doesn't affect the salary."*
🚨 **Nothing about the RULES changed** — `roundUpEnabledOn`, `applyRoundUpChange`, the history shape
and every stored row are untouched, and §1.19f still holds in full. Adam confirmed the blocking
behaviour had always been right; it was only the control that was wrong.

🚨 **THE BORROWED PICKER WAS NOT COSMETIC — IT BROKE THE SWITCH FOR A PERSON WITH NO SALARY.** The
date step renders one button per occurrence, and both call sites passed `[]` when
`hasSalaryConfigured` was false:

- on the Coin Jar, a sheet with a description, **no options**, and Cancel — a control that cannot do
  the thing it offers (MIGRATION-LESSONS §18's cousin);
- from the pay cycle settings, **the toggle silently did nothing**: `handleSave` read
  `if (roundUpChanged && paydayOccurrences.length > 0)`, so with no paydays the flow never opened,
  `onChangeRoundUp` was never called, and the draft was discarded on close — **directly beneath a
  comment claiming "the switch never commits without a date, so this step cannot be skipped".**

**The lesson worth keeping is the second bullet, not the first.** A guard written as
`condition && thereIsSomethingToShow` silently *skips the whole action* when there is nothing to
show, rather than failing. Grep for that shape before trusting any comment about a step being
mandatory: this one had its own comment contradicting it in the same five lines.

Both homes get the picker (§1.19e-2 — exactly one of them is visible at a time, and fixing only the
tested one is the "same fix applied to a similar component" trap). Pinned by
`verify-round-up-date-picker.ts` (38 assertions), which reproduces the old guard as its control and
asserts that the payday change still uses `occurrences`.

**The same shape was found once more, one layer down, in the same session.** `setRoundUp` opened
with `if (!payCycle) return prev`, so a person with no `PayCycleConfig` row got the toggle back with
no error and no switch. `addPerson` always writes one, but `migrateLedgerData` does **not** backfill
(`payCycles: data.payCycles ?? []`), so a restored backup can reach it without one. It now creates
the default config on the spot, as `updatePayCycle` already did.

### 1.20 Schedule walks look AHEAD for payments moved earlier (2026-09-19, PROMPT-08c Part B)

Every override-bearing schedule (`walkOccurrences` in `schedule.ts`, pensions, pots, savings pots)
steps through **original** slot dates and applies an override's moved date afterwards. A walk that
stops at `rangeEnd` therefore never sees a slot *after* the range that was moved *into* it. That is
why mum's Weekly shopping, moved 19 → 18 Sep, did not auto-clear until the 19th. The walks now go
`earlyMoveLookaheadDays(overrides)` past the end (the furthest any override moves a slot earlier;
**0** when none do, so nothing else changes), plus 10 days for a pension with the working-day
adjustment (a Sunday-the-1st pension is paid Friday the 30th).

Two rules keep it from double-counting, pinned by `verify-early-moved-autoclear.ts`:
- a slot reached **only** by the look-ahead counts only if its moved date is inside the range;
- a payment moved to **before** a range's start belongs to the earlier range, so it is left out of
  this one. Without that, two adjacent per-cycle windows would both show it.

A slot inside the range but moved **past** its end is still emitted, as before, because the next
range's walk would never reach it. `autoClear` never settles it early (`candidate.date > asOfIso`).

### 1.21 "Adjusted" compares RESULTS, per schedule (2026-09-19, PROMPT-08c Part A)

The coral "· Adjusted" badge on every Manage upcoming payments list comes from one rule,
`isOccurrenceAdjusted(actual, natural)` (`occurrenceOverrides.ts`): date **or** amount differs, to
the penny. Each schedule has its own wrapper, because "natural" differs:
- `templateOccurrenceAdjusted`: a follows-payday transfer's natural date is payday-resolved;
- `pensionOccurrenceAdjusted`: a weekend shift is natural;
- pots and savings pots: the standing amount;
- `recurringOverpaymentOccurrenceAdjusted`: overrides are amount-only, keyed on the period date.

"An override exists" is the wrong test. An override set back to the standing amount is not
adjusted, and a paused (`deleted`) occurrence shows "Paused", never "Adjusted".
Recurring transactions now use the shared `PausedOccurrencesControl`. Their old per-row form and
bin wrote the same `deleted` override that Pause writes.

### 1.22 Pay FREQUENCY is tax; pay SCHEDULE is dates (2026-09-19, PROMPT-08c Parts C and D)

Before 08c, `SalarySnapshot.payFrequency: 'four_weekly'` only chose the tax thresholds, and every
payday came from `PayCycleConfig.paydayDayOfMonth`, so a 4-weekly salary was paid monthly. Now:
- `payFrequency` (snapshot) is the **tax** frequency: `'monthly' | 'four_weekly' | 'four_weekly_fiscal'`.
- `PayCycleConfig.paySchedule` is the **date** schedule. Absent means monthly, so every config saved
  before this is unchanged.
- **The two must agree.** `salaryNeedsPayDate(person, payCycle)` says when they don't (an old 4-weekly
  salary with no schedule, or a frequency changed later). Salary is then **not generated**, and the
  Wallet asks for the date. Nothing is guessed or written silently.
- **One source.** `paydaysForMonth` (a 4-weekly rule contributes the paydays that *land* in the month)
  feeds every pay-date list and generator, and `cycleBoundsForDate` gives a 4-weekly earner
  payday-to-payday cycles. Home, projections, pots and joint all reach cycles through
  `resolveCycleBounds` → `cycleBoundsForDate`. Joint and Household follow the primary person, as ever.
- **Switching schedule** goes through `applyPaydayChange` (now carrying `paySchedule`), so salary
  already paid keeps its date and `paydayHistory` records the old rule, schedule included.
- **The fiscal calendar** (`fiscalCalendar.ts`): the year ends on the last pay weekday on or before
  31 March, and P13 is 5 weeks when the year is 371 days. That matches all 25 years in Adam's
  spreadsheets. The 5-week years come every 5 **or** 6 years (2027/28, 2032/33, 2038/39…), so the
  calendar must be computed, never assumed. Every fiscal year ends before 6 April, so each UK tax
  year holds exactly 13 paydays.
- **A 5-week period:** `payPeriodWeeks(payCycle, payDate)` → `SalaryInput.periodWeeks: 5`, which
  scales the 4-weekly thresholds ×5/4 (`periodsPerYear` 13 → 10.4). Gross, allowance, bands, student
  loan and percentage deductions all follow; fixed per-period deductions don't. Anything computing a
  salary net pay must pass the pay cycle, or a P13 is priced as 4 weeks.
- **Monthly regression proof:** `verify-four-weekly-pay.ts` compares both backups against
  `scripts/fixtures/monthly-pay-baseline-2026-09-19.json`, taken from the pre-08c code. Regenerate
  it only from code before a deliberate monthly change.

### 1.23 "Manage upcoming payments" = last payment on or before today + the next 12 (2026-09-19c)

One rule for all 7 lists (bills, recurring transactions, transfers, loan recurring overpayments, pots,
savings pots, pensions), Adam-specified: `manageUpcomingRange(asOf)` (−13 months to +13 years, wide
enough for an annual schedule) then `trimToManageUpcoming(rows, dateOf, asOf)` (`occurrenceOverrides.ts`).
- Compared by the **displayed** date, so a payment moved earlier counts by its moved date. A payment due
  **today** is the "last payment", not an upcoming one.
- Before this every list showed −2/+12 **months**. 08c Part A moved recurring transactions onto that
  window, so they showed up to 3 cleared payments. `schedulePreviewWindow`/`schedulePotPreviewWindow`
  are no longer used by these lists (the pot ledger modals still use them). Pots never show a date before
  opening, because the date helpers already drop those.
- A paused payment outside the trimmed rows keeps its pause: `setPaused*` only rewrites dates it is given.
- **The open card is `[data-no-swipe]`**, so a drag inside it scrolls the list and never starts the
  parent row's swipe-to-delete (same guard as the pot's "What this pot pays" checklist).
- **Checks:** `verify-manage-upcoming-window.ts` (includes source checks: 7 controls, 7 trims, no
  `addMonths(new Date(), -2)`), `verify-no-swipe-regions.ts`.

---

### 1.24 The sync store: what `powerSyncLedgerStore` guarantees (2026-09-19, PROMPT-09)

Sync app only (`shared-finance-ledger`, the test app's `/sync/`). `LedgerContext.tsx` does not know it exists: it
talks to a `LedgerStore`, and the provider is byte-identical everywhere.

**1. The first-sync gate.**
- `save()` is a logged no-op and `load()` doesn't resolve until this app's stream reports first sync.
- `SyncRoot` shows "Syncing your household…" until then.
- **Order:** sign in → `ensure_household()` → connect with `includeDefaultStreams: false` → subscribe to
  `shared_ledger_household` → first sync.
- `migrateLedgerData()`'s backfills (a re-added built-in category) are re-derived on every read and **never
  written**. A re-derived row is only inserted if the user edits it.

**2. Narrow diffs.**
- `save(next)` diffs the store's own **shadow of the database**, not the provider's `prev`, and writes only
  changed columns. On real PowerSync, one field edit is one PATCH carrying one column.
- Order within one save: inserts parent-first (`savings_pots` topologically) → updates → deletes child-first.
- Data the store delivered through `subscribe` is recognised by reference and never written back.

**3. Deliveries.**
- Every local or synced change triggers one consistent read of all 27 tables in one read transaction.
- A read that overlapped a save is dropped; the save's own change triggers the next read.
- The first delivery is `wholesale` (bumps `importGeneration`, §1.6).

**4. `primaryPersonId` is per device and never syncs.** It is resolved on every read:
1. a choice made on this device (localStorage `ledger:sync:primary-person:<dbFile>:<userId>`);
2. otherwise the person whose `linked_user_id` is me;
3. otherwise the first person.

It is re-preferred on every read (MIGRATION-LESSONS §23). Writing `linked_user_id` ("Set as me") is PROMPT-10.

**5. Mapping (`src/lib/powersync/mapping.ts`).**
- `'' ↔ NULL` on id columns: `ownerId`/`payee` come back `''` where the type requires a string. A transaction's
  optional `payee` comes back absent.
- Category ids carry `@<household>`.
- Derived ids: pay cycle = person, joint account = household, overrides `<parent>:<date>`, calibration lines
  `<loan>:<date>:<n>`, deductions `<snapshot>:<deduction>`.
- Empty optional child lists come back absent.
- `jsonb` is canonical text locally and a JSON **value** on upload (§33).
- Pot `recurringDeposit*` is not synced (superseded).
- **Order:** every array-backed table has `position`. An append gets `last + 1`, a mid-list insert the midpoint of
  its neighbours; a delete never renumbers; reads sort by `(position, id)`.

**6. One local database file per app per origin.**
- `personal-f`: `personal-finance.db`.
- Live `shared-finance-ledger`: `shared-finance-ledger.db` (set when PROMPT-10 wires it).
- Test `/sync/`: `finance-ledger-test-sync.db`.
- `VITE_POWERSYNC_DB_FILENAME` has no default, so a build without it fails loudly.
- If a different account signed in last, `SyncRoot` clears the local copy first.

**7. Rejected writes are never silent.** The connector still discards `22xxx`/`23xxx`/`42501` (they would block the
queue forever), but logs each one loudly and keeps it in `ledger:sync:rejected-writes`. The Account modal shows
either the list or "No changes rejected by the server ✓".

**8. The household can change under an open device** (deleted on another device; PROMPT-10's redeem). Every read checks the
synced `household_members`. Once the user has been seen in the session's household, losing it suspends the store (no writes, no
deliveries, `onHouseholdLost`), and `SyncRoot` clears the local copy and boots again. Without this, a stale device re-sent its whole
ledger into the old household (live test 2026-09-19: 16 RLS rejections). MIGRATION-LESSONS §38. The empty-household screen also moves
on by itself when another device fills the household.

### 1.25 Auto-cleared payments have deterministic ids (2026-09-19, PROMPT-09, all three apps)

`autoClearDuePayments` gives each materialised payment `id = 'auto:' + dedupeKey(...)`
(`autoClearedTransactionId`, `lib/autoClear.ts`). Offline nothing changes but the id; existing rows keep theirs.

**Why:** with two devices, both clear the same payment before syncing; random ids made two rows and doubled the
household balance. Deterministic ids make both devices write one row, which the upsert merges.

**Rule:** any row the app creates without a user action must get a deterministic id. Pinned by
`verify-auto-clear-ids.ts`.

### 1.26 Auth, the legacy rescue, linking and "Set as me" (2026-09-19, PROMPT-10)

Sync app only (`shared-finance-ledger`, the test app's `/sync/`).

**1. The boot sequence** (`SyncRoot.tsx`): sign in → `ensure_household()` → connect with
`includeDefaultStreams: false` → subscribe to `shared_ledger_household` → first sync → the
empty-household screen if the household has no people → the ledger. It boots again from the top,
clearing the local database, whenever the household changes under the session: another device ran
"Delete my app data" (§1.24.8), or a link code was redeemed here.

**2. The legacy rescue is part of the empty-household screen** (`LegacyDataMigration.tsx`). It
offers: this device's pre-sign-in data / a backup file / Start fresh / Join with a code.

> 🚨 **`ledger:app-data-v2:v1` is read and NOTHING else.** It is the same key, on the same origin,
> as the offline `personal-ledger` app — Adam's mum's real, unbacked-up data. `personal-f`'s
> version of this component removed its old key after importing and after "Start fresh"; that line
> is deliberately not ported. "Offered" is recorded under `ledger:sync:legacy-offered:<userId>`.
> `verify-legacy-migration.ts` proves it from the source and from a Storage that records every call.

**3. Every import regenerates ids** (`lib/powersync/importIds.ts`). The same backup imported into
two households would otherwise collide on every row id, and the connector discards those writes
silently (§31, §27). Only the 35 fixed category ids survive; every reference is remapped by a
generic walk (so a field nobody thought of cannot be missed, §22), and `auto:<dedupeKey>` ids are
re-derived from the remapped transaction (§36).

**The store decides what an import is**, because `LedgerContext.setData` is shared code and says
nothing: a save is an import when **none** of its twelve lists is one the store has delivered,
loaded or saved before. Every real edit keeps at least the lists it didn't touch. (Comparing with
the provider's `prev` is NOT enough: when a sync delivery and an edit land in one render, `prev` is
older than the edit's base and every list looks new — which would re-id the whole household.)

**4. "Set as me" = link + view** (Adam, 2026-09-19). The button only changes `primaryPersonId`
(shared code); the store turns that into `people.linked_user_id`, as one-column UPDATEs:
- an unlinked row → linked to me, my previous row cleared **first** (the unique index);
- a row linked to someone else → view only, never taken — **unless I have no linked row at all**,
  which is how Ella claims her row if Adam tapped it before she joined;
- `primaryPersonId` moving because my person was deleted → nothing is written;
- an import or Start fresh links its own new "Me".

**5. Joining a household** moves the joiner's data **server-side**, so the device clears its local
copy and boots again through the first-sync gate — never assume the local copy follows. A joiner
who brought nothing is asked "which of these is you?" once. A same-named person left behind comes
back as `duplicate_person_id` and is resolved by the banner, through the app's own
`DeleteGuardModal` (no second merge path).

**6. The Account button sits in the Wallet header** through `HeaderAccessory.tsx`, a shared,
empty slot that renders nothing unless an app fills it. That is what keeps `Salary.tsx` identical
in both live apps while only this one has an Account button.

**7. Cloud backup** (`lib/powersync/backup.ts`): one snapshot a day, automatically, to
`shared-finance-ledger-backups/<user>/<date>.json`, plus Back Up Now. **Restore replaces the whole
household** on every device, so it is a deliberate action behind a warning that says so, and it
goes through the same id-regenerating import.

### 1.27 A Salary Sort belongs to one person, and its ids say so (2026-09-19, PROMPT-11)

All three apps.

**1. Scoped to a person.** `SalarySort.personId` is who the sort is for. Every lookup —
`saveSalarySort`, both Clear actions, the Salary page's two lookups, `lastSortedAmountFor`,
`findSalarySortConflicts` — is scoped to it, and a payday change re-dates only that person's sorts.
Until 2026-09-19 a sort was keyed on `payDate` alone: two people paid on the same date shared one
record, overwrote each other's targets, and saw each other's amounts in the suggestion box.

**2. Older records are attributed, not guessed.** `migrateLedgerData` fills `personId` in from the
owner of the transfers the sort created, which is the same answer it would have had. The sync layer
derives it the same way on every read, so `salary_sorts` needs **no `person_id` column** and no
migration — and a stored value can never disagree with the transfers.

**3. The ids are derived, so two devices converge** (MIGRATION-LESSONS §36):
`sort:<personId>:<payDate>`, its target `…:<destination>`, its transfer `…:<destination>:tx`.
Two devices sorting the same payday before either has synced write the SAME rows and the upsert
merges them. With the old per-save `nanoid`s the household got two sorts, two targets and two real
transfers — the money moved twice, with no error anywhere. Records made before this keep their
nanoid ids; nothing reads the shape.

**4. What was already right, and must stay right:** the two-way edit writes one column on each row;
detaching deletes the target before the sort (child first); and a target whose transaction is gone
is **hidden by `reconcilePersonReferences`, never deleted** — the store's shadow is the reconciled
view, so a partial read can't turn into household-wide deletes. `verify-salary-sort-sync.ts` pins
all four, with controls that reproduce the old behaviour.

### 1.28 A restore must not silently reassign who everyone is (2026-09-22, PROMPT-14 Part 5)

**The invariant: after any restore, no member of the household ends up pointed at a different
person than before, without being asked.**

Why it was broken, and why nothing caught it. An import deletes every `people` row and inserts a
fresh one (`regenerateIds`, §31), and `linked_user_id` is a **server-only column `toRows` never
writes**. `linkOps` re-links only the person doing the restore. So on Ella's next sync, `assemble`
walks choice → linked → `people[0]`: her stored choice is a dead id and there is no linked row, and
**she silently becomes whoever sorts first, with his pay cycle**. That is the §23 failure
`verify-first-sync-gate.ts` exists to prevent, arriving through a door it does not watch.

The rule now:

1. **Re-link by name.** Each pre-restore link is carried across to the incoming person with the
   same name — trimmed and case-insensitive, because a restore of a hand-edited file is exactly
   where "Ella" becomes "ella" — as narrow one-column updates, after the diff has done its
   deleting (the `(household, linked_user_id)` unique index).
2. **Ambiguous or missing is NEVER guessed.** No match, or more than one, leaves that member
   unlinked; the store reports `staleChoice`, and their device asks "which person are you?" on its
   next boot — the flow a fresh join already uses.

🚨 **"Just take the first match" is the bug wearing a different hat**, not a simplification of the
fix. `verify-restore-preserves-identity.ts` section 1 is the control: it reproduces the old
behaviour and must keep failing the way it does today, or the check has stopped being able to fail.

### 1.29 Re-importing this household's OWN file is a patch, not an import (2026-09-22, PROMPT-14 Part 4)

If **any** id in an incoming file is one the store already holds, the file came from here and was
edited: the ids are kept and `diffRows` writes only what actually changed. One field edited is one
`UPDATE` of one column. No id churn, no identity reset, and Ella sees one narrow update.

🚨 **Two id classes must never count as evidence**, and dropping either calls a genuinely foreign
backup a patch — which is §31's collision (23505, then silently discarded by the connector) through
the front door:

- **the 35 fixed category ids** — `regenerateIds` keeps them on purpose, so every household on
  earth has them;
- **`auto:` and `sort:` ids** — derived from the ids inside them, so a match there is already being
  reported by the person or source id it contains.

**The foot-gun to keep saying out loud:** a hand-trimmed file (rows deleted by hand) still reads as
a patch, and the diff deletes the missing rows. That is correct, and it is why the confirm says how
many rows will be **deleted**, not only how many replaced.

### 1.30 How to hand-edit the data, and which of the two ways to use (2026-09-22, PROMPT-14 Part 6)

Both routes are legitimate and **they fail in opposite directions**, so the decision rule matters
more than either procedure.

#### Edit the row in the Supabase table editor when…

…the change is a **value**, in a column that is not a reference and is not part of a composite id.
It is surgical, it replicates down the normal sync path, and it costs nothing.

*Worked example:* a bill's `amount` is £42.00 and should be £45.00. Open
`shared_finance_ledger.recurring_templates`, find the row, change `amount`. Done — both phones have
it within seconds.

Three traps, all learnt the hard way:

- **jsonb must be a JSON value, never a string** (§33). `amount_history`, `interest_history`,
  `payday_history` and a scenario's actions are jsonb. Pasting `"[{\"from\":…}]"` stores a
  *string that looks like JSON*, and the app reads it as empty.
- **Composite ids encode their own data** (§36). Changing `salary_sorts.pay_date` orphans
  `sort:<personId>:<payDate>`, its targets and its transfer — they still exist, pointing at a date
  that is no longer the sort's. Change the id too, or do it in JSON. The same goes for
  `auto:<dedupeKey>`.
- **`position` is real-valued.** Append = last + 1; mid-list = the midpoint of its neighbours.
  **Never renumber a list**, which is a write to every row and a conflict with the other device on
  each one.

#### Export, edit the JSON, re-import when…

…the change is **structural**: deleting an entity and the rows that point at it, re-parenting a
pot, anything touching a `sort:` or `auto:` id. One edit in a self-consistent document beats a
hand-written cascade across 27 tables — and `migrateLedgerData` and `reconcilePersonReferences` run
on the way back in, which the table editor bypasses entirely.

*Worked example:* a pot belongs to Adam and should belong to Ella. In the table editor that is
`pots.person_id`, plus every `transactions.pot_id` that assumed the old owner, plus any round-up
`rounding_pot_id`, plus the sort targets that pay into it — and one missed row is a silent
inconsistency. In JSON it is one `personId`, re-imported, with the diff working out the rest.

The workflow, which §1.29 is what makes cheap:

> Account → **Back Up Now → This device** → edit the JSON → Account → **Restore → A file**.
> Only the rows you actually changed are written.

#### Never, by hand

**`households`, `household_members` and `people.linked_user_id`.** Those are what the RLS policies
and the link/redeem functions maintain, and Listly's RLS reads the same household rows
(`listly/docs/LEDGER-INTEGRATION.md`). A hand-edit there breaks two apps and reports nothing.

### 1.31 A shortfall is the DIP, not a balance at the far end (2026-09-22, PROMPT-14 Part 7)

**The invariant, in Adam's own terms (2026-09-21):** *"comparing this cycle projection to pending
payments, if value dips below zero, send alert."*

Walk forward day by day and alert if the projected running balance passes the account's **floor**.

> 🚨 **"The whole current cycle" became "the next 7 days" on 2026-09-23.** Adam, on a real alert:
> *"these notifications aren't tied to a cycle, they're simply a day-by-day walkthrough … 7 day walk
> ahead, but don't use the same limit for checking next incoming money, this is unbounded … next
> incoming is quite literally the next incoming cash."* **Nothing about the DIP rule below changed** —
> only how far the search for one runs. See §1.31b for the two horizons and the three defects the
> cycle binding caused, and §1.31c for the owner's-payday fix that came with it.

> ⚠️ **"Below zero" became "below the floor" on 2026-09-22 (PROMPT-15).** Zero is still the floor
> for an account with no overdraft, which is every account until someone sets one — so nothing
> about this invariant changed for existing data. See §1.32. That means the alert fires on an account that ends the cycle perfectly
healthy — which is the entire point. Money that is £200 short on the 12th and £400 up by the 28th
still bounces a direct debit on the 12th.

🚨 **The cheap version — compare the projected END-of-cycle balance with zero — is one line shorter,
looks equivalent, and loses the whole feature.** It is `verify-shortfall.ts`'s control, over a
household built to dip and recover, and it must keep missing what the real rule catches. This was
chosen knowingly over the two cheaper options.

**What is watched, and what is deliberately not:**

| Watched | Not watched |
|---|---|
| Each person's personal current account | `SavingsPot` — **entirely**. 🚨 There are **two** pot types (`SavingsPot` and `Pot`) and only `Pot` is in scope |
| Every active `Pot` where `isCoinJar !== true` | A **Coin Jar**. One emptying is the Coin Jar working, not a problem |
| The **joint account** | **Credit cards.** A balance owed is not a balance held |

**Who is told:** the account's owner, and joint has two owners. That one sentence is the whole
recipient rule — chosen precisely because it needs no special-casing. A `Pot` is never joint (the
type's own comment says so), so a pot alert has exactly one recipient.

**Exactly £0.00 is not a shortfall.** Below zero means below zero.

### 1.31b TWO horizons: a 7-day dip, an UNBOUNDED lookahead (2026-09-23, Adam)

**Never use one number for both.** The dip search stops at `SHORTFALL_WALK_DAYS` (7, from tomorrow);
`nextMoneyIn`, `moneyInBefore` and `recoversOn` look as far ahead as the ledger generates.

🚨 **Collapsing them is SILENT.** The alert still sends — it just stops telling the truth about when
things get better. `verify-shortfall-walk-window.ts` §§1–2 are the controls.

**What the old cycle binding actually did.** Until 2026-09-23 the search ran to the end of the
*primary person's* current pay cycle. One real notification on 2026-09-23 hit all three of its
failure modes at once:

> *"Disney+ (£14.99) on 28 September leaves you £13.57 short. Nothing more due in before 7 October."*

1. 🚨 **The joint account has no cycle of its own, and the SERVER has no primary person.**
   `primaryPersonId` is per-device and never syncs (DECISIONS Q3), so `shortfallsForHousehold`
   guessed *"the first `people` row with a `linked_user_id"* — off an **unordered `select('*')`** in
   the Edge Function. Whose cycle every joint alert was measured against was effectively **random**,
   and could flip between nights. *(A guess made from unordered rows is not a default; it is a
   coin toss with a plausible-looking result.)*
2. 🚨 **A cycle boundary must never appear in the prose as a date.** "7 October" was the end of
   Ella's four-weekly cycle. Nothing was due in on it. Adam read it as a payment date and went
   looking. **That line now carries no date at all** — by definition nothing happens on it, because
   it is the branch where the unbounded search found nothing.
3. 🚨 **The boundary truncated the lookahead**, so an £800 deposit one day past it read as "nothing
   more due in". It did not vanish, which would have been obvious. It **moved** — see §1.31c.

`cyclePersonId` survives in the code, but **only as a generation horizon** — how far ahead to build
the ledger. **No date is ever compared against it**, and making it a boundary again restores all
three defects.

### 1.31c A `followsPayday` transfer follows its OWNER's payday, not the primary's (2026-09-23)

`payCycleForTemplate` (`schedule.ts`), used by `computeJointAccountProjection` and `autoClear`'s
non-personal transfer step.

A `kind: 'transfer'` template never carries `location: 'joint'`, so both callers reached for the
only pay cycle to hand — `primaryPersonId`'s — and resolved **every** member's payday-following
transfer against that one person's payday.

🚨 **This is invisible in a one-person household**, which is how it survived to production. In a
two-person one it **moves money silently**: Adam's £800 joint deposit, owner Adam, payday the 28th,
generated on **8 October** when measured against Ella's four-weekly cycle. Not dropped — *moved*,
which is far harder to notice. The `autoClear` call site is the worse of the two: it materialises a
**cleared** Transaction at the wrong date, in real data.

A template with no `ownerId` (a joint-location bill has `''`) still falls back to the primary —
there is no better answer, and `kind: 'bill'` ignores `followsPayday` anyway.

### 1.31a There is deliberately NO deposit alert (2026-09-22, Adam)

**Adam, 2026-09-22: *"I also want to remove the joint account deposit alerts please. I only want the
alerts for balance dipping below zero."***

🚨 **Do not re-add it as "the obvious missing half."** It reads like an oversight sitting beside the
shortfall alert and it is not — it is a decision. The shortfall alert already says the thing that
matters (the money runs out); a deposit alert is chatter arriving within the hour, every time,
forever. The hourly cron exists to hit the 20:00 London gate, **not** as an invitation to add an
event alert because the tick is right there.

**What is NOT cut:** the joint account is still *watched* for a shortfall, and a joint shortfall
still notifies both people.

### 1.31b The alert runs the app's OWN engine, and the bundle is what can go stale (2026-09-22)

The `ledger-alerts` Edge Function runs `src/lib`'s real projection code, bundled — not a second
implementation in SQL. PROMPT-14 §0b Q5 originally chose the SQL route and accepted a second engine
as the cost; Edge Functions are Deno, so there never needed to be one.

**The consequence to remember:** after changing anything in `src/lib` that the alert path can reach
— which is most of it, since the shortfall rule composes the real projections — the bundle must be
rebuilt (`npx tsx scripts/build-alert-engine.ts`). `verify-alert-engine-bundle.ts` fails the sweep
until it is, and also proves behaviourally that bundle and source find the same shortfalls over the
three real backups. **That check is the only thing keeping "one engine" true.**

### 1.32 An overdraft is a FLOOR, and the two severities take different numbers (2026-09-22, PROMPT-15)

`overdraftAmount` — on `PayCycleConfig`, `JointAccountConfig` and `Pot` — is **how far below zero
that account may go**. A positive number; `0` means none.

🚨 **THE CONCEPTUAL POINT, and I got it wrong twice before Adam corrected it.** He said:

> *"I can't go below zero or below my overdraft limit, so going 712 into a 500 overdraft makes no
> sense, same for below 0."*

**A balance cannot pass its floor — the bank declines the payment.** So there are two genuinely
different things to describe, and they take **different numbers**:

| Severity | What it describes | The number means |
|---|---|---|
| `'overdraft'` | A state that **will really happen**: you dip into a buffer you are allowed to use | **How far below zero** you go |
| `'shortfall'` | A state that **cannot happen**: the payment does not go through | **How much you are SHORT BY** — how much more money is needed for it to clear |

**Never describe a balance beyond its floor.** "£712.40 into your £500 overdraft" and, with no
overdraft, "£212.40 below zero", are both impossible states.

**Three consequences that are each a separate line of code, and each easy to miss:**

1. The dip test uses the floor.
2. `amount` is measured from that floor.
3. **`recoversOn` uses it too** — back above zero for `'overdraft'`, back within the limit for
   `'shortfall'`. A different line from the dip test.

**With no limit there is no `'overdraft'` severity at all** — dipping below zero IS running out of
money. Getting that wrong downgrades a real alert into a heads-up.

### 1.32a Pots have an overdraft on purpose (2026-09-22, Adam)

🚨 **I argued they should not, on the grounds that a `Pot` is a notional pocket inside a real
account rather than a facility of its own. Adam overruled it, and he was right:**

> *"i use pots because monzo has them, but mum might use pots as other bank account, so we need to
> add the flexibility."*

A `Pot` is **whatever the person using it needs it to be** — a Monzo pot for Adam, a separate bank
account for mum, who has no Monzo and models her accounts with the tool she has. The app does not
get to decide which of those is correct.

**Do not "tidy" this out.** A Coin Jar is the one exception: its field is hidden and it is not
watched for shortfalls at all.

### 1.32b The overdraft is NOT effective-dated, and here is the test for when something should be (2026-09-22)

Adam: *"the only thing it's referenced by is the alerts, so effective from is useless."*

**The general rule worth keeping:** an effective-dated value earns its keep only when something
**replays history** through it. Salary snapshots and the round-up on/off history are both replayed
— a projection walks past dates and has to know what was true then. The overdraft is read **once,
for today, by one consumer**.

🚨 Everything else in this area carries a history, so the next session will add one out of symmetry
unless the reason not to is written down. It is written down in the type's own comment.

### 1.32c The Sunday heads-up is self-clearing, and it is the only remembered state (2026-09-22)

Adam's design, and better than the toggle I proposed:

> *"it should fire on Sundays… if a user was in overdraft at the last notification, and they haven't
> come out of it since last week, then the notification should not fire the second week."*

| Alert | Cadence |
|---|---|
| **Out of money** | Every evening until it clears |
| **Into your overdraft** | **Sundays only**, and silent while the account has not come out since the last one |

**Why it beats a toggle:** it is **self-clearing**. Someone who lives in their overdraft stops
hearing about it without turning anything off, and starts hearing about it again the moment their
situation changes. A toggle puts that work on the person, and a person who turns an alert off never
turns it back on.

**"Came out of it" means the CLEARED balance reached £0 or above** — what actually happened, not
what the projection says. Answering it from the alert's own prior output would be circular. Known
quirk, accepted: paid in and straight back out the same day counts, which errs towards telling you.

🚨 **This is the ONLY remembered state in the whole alert rule**, and it must stay that narrow:
"when did I last tell this person about this account?". Everything else is a fresh projection each
evening with nothing carried over, and §1.31's *"no 'resolve' button, no state to clear"* is
otherwise still true.

🚨 **It is also why the dedupe key carries the severity.** I ruled that out as machinery for an
impossible case; the suppression made it necessary, because it has to find the last **overdraft**
alert rather than the last alert of any kind.

### 1.33 Identity: the view is not evidence of the link, and only YOU can write your link (2026-09-22/23, PROMPT-16)

Sync app only.

**1. The view is not evidence of the link.** `assemble` resolves `primaryPersonId` as choice → link
→ `people[0]`, so a device whose choice is stored shows the right person for ever whether or not
`people.linked_user_id` was ever written. Adam's production row was unlinked for days while every
screen looked right. Alerts are addressed from the link alone, so they were silent, with no
symptom. **Never infer "linked" from "the app shows me".** Check the column
(`20260922_shared_finance_ledger_identity_verify.sql`, in the SQL editor).

**2. "Set as me" is an explicit tap, never a diff.** `LedgerContext.setPrimaryPerson` calls
`store.setPrimaryPerson(id)` before it changes state; the sync store links on that and on nothing
else. The old rule — "link when `primaryPersonId` changes" — is §39 one field down: tapping the
person you already view changed nothing, so nothing was written; and any save that moved the view
could take a partner's row with nobody tapping anything. A save with no tap writes no link.

**3. 🚨 A link can only be written by the user it names.** `people_enforce_self_link` refuses
(42501, discarded by the connector) any `linked_user_id` that is not `auth.uid()`. Consequences,
each learnt live on 2026-09-22:
- a device can link ITS OWN account and nobody else's, so **"the restorer re-links every member
  after a restore" (§1.28) could never work** — Adam's phone wrote Ella's link, the server threw it
  away, the unit test passed against a fake with no trigger, and three UAT runs failed. It is gone;
- **no SQL repair exists for a missing link.** In the SQL editor `auth.uid()` is null, so every
  value is refused. The repair must run in the app, as that user;
- **unlinking is allowed for anyone** (the `is not null` guard) — which is how a restore could wipe a
  link it could never put back from that device.

**4. Every device remembers who it showed, and decides for itself on boot** (`identityAction`):
linked → ready; my chosen row unlinked → link it (the self-heal that repairs a device whose view was
always right — Adam's production case; it can only fill an empty column); the person I was showing
is gone or now someone else's → link the ONE unlinked person with the same name, else **ask**;
otherwise ready. The `people[0]` fallback is never allowed to stand as an identity. 🚨 The old ask
was gated on `staleChoice`, which only exists for a user who overrode their link — a member resolved
BY link never stored a choice, so when a restore destroyed the link nothing went stale and Ella's
phone silently showed Adam. The memory covers all three resolution paths.

**5. 🚨 A display inside an EDITOR is not cosmetic, and a guard that over-lists is a display bug.**
The nine production joint bills went 50 → 100 through the **delete guard**: deleting a temporary
third person listed every joint bill as "Temp pays 25%" (true of the model — every non-payee gets an
equal slice of the remainder), and each "Move to Adam" set the share to 100. `owner_id` never
changed. A joint bill now blocks a person's delete only when they are the **payee**, taking one over
keeps the split, and 100% is right only when one person is left (§1.11's rule, narrowed). **Never run
the "add a temp person, Set as me, delete it" detour again** — it is what caused this, and the
self-heal in (4) makes it unnecessary.

**6. 🚨 A second device must not re-create what a restore deleted (Part G, found in UAT
2026-09-23).** A wholesale restore reaches the other device as several server commits: new rows,
then the old transactions' deletes, then the old templates, people and pay cycles. In that window
`autoClearDuePayments` — which runs on every data change — sees old templates whose occurrences
have "gone missing" and materialises them again, often under a fresh `auto:` id because the row it
replaces had a hand-logged id; the server accepts them (right household, no FK) and they survive as
orphans pointing at ids of the previous generation. Eight were in a real export. The store now
remembers every row id AND every occurrence slot (`dedupeKey`) that arrived deleted from the server
this session and drops any derived insert that would refill one. Own deletes are excluded; an
explicit setData may still bring a row back. With the other device offline nothing stale was ever
written — the control. **The same window has an INSERT half:** parents (templates, people, loans…)
arrive before the file's transactions, the other device materialises occurrences for them, and the
file's rows then land on the same slots — a bill counted twice (TV License and Barkin Bistro pairs
in three real exports). So a derived transaction insert that points at a parent which arrived from
the server in the latest read is dropped too; the parent is settled from the next read on. And the
store coalesces change events for 400 ms so a burst of commits is read once.
`verify-stale-writes-during-restore.ts` (§1–4 delete half, §7–8 insert half, each with its control).

`verify-set-as-me.ts`, `verify-restore-preserves-identity.ts`, `verify-delete-reassign.ts` (the
production file, with a temp person), `BillOwner.test.tsx`, `verify-stale-writes-during-restore.ts`, and
`tools/schema-test/behaviour-shared-ledger-identity.mjs` (the trigger, against the real migrations).

> **§1.28 above is superseded in one respect:** the re-link is done by each member's own device, by
> the name that device remembers, not by the restorer. Everything else in §1.28 stands — ambiguous
> or missing is never guessed, and "just take the first match" is still the bug in a different hat.

### 1.34 A 100%-of-balance card makes an early payment NEUTRAL over three cycles (2026-09-21, PROMPT-12 Part 3)

Mum's report: she logged a £91.24 "Santander — balance paid" and her projected balance "did not
change". It had — on **This cycle**, by exactly £91.24. She was reading **Next 3 cycles**, where the
projection is *correctly* unchanged: her Santander minimum is **100% of balance**, so the £91.24 was
already scheduled to leave on 14 Oct. Paying it on 20 Sep moves the **date**, not the three-cycle
position. From her own backup, before → after:

| | This cycle | Next 3 cycles |
|---|---|---|
| Current balance | £1,262.35 → £1,171.11 | £1,262.35 → £1,171.11 |
| Pending | −£1,016.29 → −£1,016.29 | £2,150.68 → £2,241.92 |
| **Projected** | £246.06 → **£154.82** | £3,413.03 → **£3,413.03** |

Current balance falls by £91.24, Pending rises by the same, and the hero stays self-consistent
(£1,171.11 + £2,241.92 = £3,413.03). **Not a bug; no projection code was touched.** This is
counter-intuitive and *will* be asked again: the answer is "which horizon were you on?".

🚨 **The second lesson is about the investigation, not the app.** Part of this was spent diffing a
projection out of a **stale backup file** — a plausible, confidently-wrong answer. Before diffing
anything from a backup, **check the backup's own export date against the event being investigated.**
It is the second time real data has been the thing that misled rather than helped (§1.33's "the view
is not evidence of the link" is the first).

### 1.35 An import re-derives a composite id from the ids INSIDE it, never from current state (2026-09-23, PROMPT-12 Part 4)

Sync app only. Two kinds of id are composite: `auto:<sourceType>:<sourceId>:<slotDate>` (an
auto-cleared occurrence, §1.25) and `sort:<personId>:<payDate>[:<destination>[:tx]]` (a Salary Sort,
§1.27). On an import both must change (the ids inside them do) and both must keep their shape.

Two defects the synthetic fixture found, both invisible to every real backup:

1. **A `sort:` id was handed a nanoid.** `importIds.ts` collected it like any other id, the generic
   remap replaced it, and the re-derivation — keyed on the `sort:` prefix — never saw it. Every
   imported sort, target and transfer lost the derived shape PROMPT-11 built for the two-device merge.
   No real backup had a salary sort, so nothing noticed.
2. **A moved occurrence was re-slotted.** The auto id was re-derived from `dedupeKey(t)`, which reads
   the row's CURRENT date; the id names the **slot** (§1.5a). Mum's 2026-09-20 backup has two rows
   auto-cleared on the 20th and then moved to the 21st: an import rewrote them as `…:2026-09-21`.

**The rule:** composite ids are excluded from the generic walk and re-derived by swapping the ids
inside them — `auto:recurring_template:OLD:2026-09-20` → `auto:recurring_template:NEW:2026-09-20`.
Never recompute from state; state can have moved since the id was minted.
`verify-import-regenerates-ids.ts` carries both controls (6 checks fail on the merged `importIds.ts`).

**The lesson behind both:** a check over shapes that only a synthetic fixture produces is the only
coverage those shapes have. Every "generic" round-trip check passed vacuously over the five tables no
real backup fills (§53, §63). When a fixture is added for a shape, assert the count it exercised.

## 2. The credit-card engine is the single most fragile area

**One reported symptom — "balance never reaches zero" — took five separate fixes**, each a
genuinely different mechanism. Treat any change here with proportional care and always run the
**full** verify sweep.

| # | Batch | Mechanism |
|---|---|---|
| 1 | 8 | `NEGLIGIBLE_BALANCE` (£0.02) — a tiny residual is a stable rounding fixed point under a `balance <= 0` guard |
| 2 | 10 | Amortisation deadlock — a rounded percent-minimum that doesn't cover the cycle's interest |
| 3 | 11 | `workingBalance` vs `statementBalance` diverging permanently on a statement-window card |
| 4 | 14 | Interest-free grace period on new purchases — plus two regressions its own fix introduced |
| 5 | 14 | The deadlock guard was force-paying off **genuine** debt traps (a real card behaviour) — narrowed to fire only when *rounding*, not payment policy, erased the progress |
| 6 | 16 | **FIXED 2026-09-16.** `rangeStart` lands on an already-cleared payment date, so that payment is applied twice — once in the opening `cardBalanceAsOf` (filter `t.date <= asOfIso`, inclusive), once as that cycle's own charge (`paymentDate >= rangeStart`, also inclusive). Two inclusive comparisons meeting. Fixed by starting the simulation the day **after** a payment already inside the opening balance. **Batch 20 (2026-09-16): that guard had lived in one caller only; Home's Personal ledger (`computeProjection`, rangeStart = cycle start) still hit it and lost mum's £91.24. The guard is now inside `generateMinimumPaymentTransactions`, so no caller can reintroduce it** |

**Three things about mechanism 6 that cost real time to establish — do not re-derive them:**

- **`storedDates` filters the display row, never the deduction.** `buildCreditCardMinimumChargeRows`
  discards the duplicate generated row via `.filter((t) => !storedDates.has(t.date))`, so nothing
  looks wrong at that date — but that runs *after* the generator returns, by which point the
  duplicate deduction has already corrupted the running balance every later cycle is computed
  from. An earlier analysis assumed this filter already suppressed the re-simulation; a fix built
  on that assumption would have double-corrected.
- **A statement window masked it by cancellation, not protection.** `statementBalance` opens from
  the previous close and is deliberately unclamped, so the doubled payment sits as a legitimate
  negative (an overpayment credit) and nets out when the delayed spend's window closes. A 19→18
  window opens the 14 Sept cycle at −£100 and recovers correctly at 14 Oct. Do not go looking for
  a protective mechanism in the windowed path; there isn't one.
- **The two clamping rules decide the symptom.** `workingBalance` is clamped to 0, so a
  100%-minimum card swallows the whole residual and generates nothing further (loud). A
  fixed-minimum card just loses one instalment off the end (quiet, and it passed two rounds of
  review). This is why `sum(pending) === live balance` is the assertion that matters and
  "does a row appear" is not.

**Two documented figures that were artifacts of mechanism 6, not real constraints** — both
re-measured after the fix and found to be free choices: a statement window does *not* need to
close after the payment date (all 28 closing days reconcile), and `creditCardCyclePeriods` has
**no** due-date off-by-one (period `dueDate` equals the generated charge date for every closing
day).

Three structural facts that keep causing trouble:
- **Two balances are tracked.** `workingBalance` (true running) and `statementBalance` (what the
  minimum is sized off, deliberately lagged on a statement-window card). They can legitimately
  diverge; a fix that reasons about only one is incomplete.
- **`withLiveBalance` output must never be fed back in.** It updates `currentBalance` but leaves
  `balanceAsOfDate` at the original anchor, so `cardBalanceAsOf` /
  `generateMinimumPaymentTransactions` replay the same activity a second time and double it. Two
  real call sites did exactly this (fixed 2026-09-16, `verify-credit-card-live-balance-misuse.ts`).
- **A window boundary that depends on the time of day is a latent seasonal bug** (learnt
  2026-09-15). `new Date('2026-09-14')` is 01:00 in BST but 00:00 in GMT, so a `>=` comparison
  against a locally-constructed midnight flips behaviour twice a year. Compare window boundaries on
  ISO date strings, or construct them so an hour cannot change which cycles fall inside.
- **A simulation must never re-apply a transaction already folded into its own opening balance.**
  Whenever a replay starts from `cardBalanceAsOf(x)`, everything dated on or before `x` is already
  in that figure. This is the same shape as the `withLiveBalance` trap above, and it is how
  mechanism 6 got in.

**Process note, from the tracker itself:** run the FULL `scripts/verify-*.ts` sweep after any
shared-engine change. Two of Batch 14's three regressions were sitting undetected in files that
session had not touched.

---

## 3. Verify-suite baseline as of 2026-09-16

**Full sweep of all 103 scripts: 103 pass, 0 fail. `npx tsc -b` is clean, 0 errors.**
Verified in `finance-ledger-test` AND `personal-ledger` independently, both on `origin/main`.

Use **"103/103, tsc clean"** as the baseline. Anything less is yours.

**Update, PROMPT-03 (2026-09-16c): baseline is now 104/104, tsc clean** — on `main` in both
`finance-ledger-test` (`3066ff51`) and `personal-ledger` (`5e3519d`), verified independently in
each (+`verify-household-person-grouping.ts`).

**Update, PROMPT-04 (2026-09-16d): baseline is now 105/105, vitest 8/8, tsc clean** — `main`
`2e8bb71a` (test) / `60f2932c` (live), verified independently in each
(+`verify-savings-interest-crediting-frequency.ts`; vitest has 5 new `SavingsPotForm` cases, so run
`npx vitest run` too).

**Update, PROMPT-05 (2026-09-16e): baseline is now 108/108, vitest 8/8, tsc clean** — `main`
`8fc1e7f0` (test) / `e430c75` (live), verified independently in each (+`verify-delete-reassign.ts`,
`verify-template-schedule-change.ts`, `verify-no-duplicates-on-schedule-edit.ts`). Local `main` =
`origin/main` in both repos.

**Update, Batch 20 (2026-09-16, urgent UAT fixes): baseline is now 109/109, vitest 8/8, tsc clean**
in both repos (+`verify-credit-card-pot-location.ts`). `origin/main` is `de042dd4` (test) /
`6b4d9112` (live).

**Update, 2026-09-17b (test app, pending port): 111 scripts, strict sweep clean, vitest 16/16, tsc clean.**
- **Removed / added:** −`verify-savings.ts`; +`verify-savings-entries-removed.ts`,
  +`verify-follows-payday-range.ts`.
- **8 scripts fixed** that had been crashing or printing `FAIL:` unseen. The sweep command below
  is now strict: exit code, `✗`, `^FAIL`, `Error:`.
- **Scripts reading real backups:** `verify-cycle-end-totals` and `verify-overpayment-independence`
  now read mum's real 15 Sep backup, as of its export date. An earlier "as of" makes already-cleared
  payments look future and fails for non-bug reasons.

**Update, 2026-09-19c: baseline is now 126/126, vitest 16/16, tsc clean** in all three repos
(+`verify-manage-upcoming-window.ts`, +`verify-no-swipe-regions.ts`; 124 after PROMPT-08c).

**Update, PROMPT-06 (2026-09-17): baseline is now 110/110, vitest 16/16, tsc clean** in both repos
(+`verify-ledger-store.ts`; vitest +8 in `src/context/LedgerProvider.test.tsx`). In the test app
only, also `npm run check:sync-build` (reads build output, so it's not in the sweep).

**Update, PROMPT-12 (2026-09-23): baseline is now 154 / 154 / 140 (test / shared / personal), vitest
45/45 everywhere, tsc clean, `check:divergence` 58 files / 0 unaccounted, `check:sync-build` green
in both sync repos.** The 14-script gap between the offline and sync apps is the sync-only set. Four
real backups are fixtures now (Adam 09-15, mum 09-15, 09-17 and **09-20** — the first with a lump
payment and with `auto:` ids), plus the synthetic fixture in `scripts/lib/syntheticFixture.ts` for
the shapes no real file carries. **Use these figures, not the older ones above.**

```bash
# Strict (2026-09-17): a non-zero exit, ✗, a line starting FAIL, or "Error:" all fail.
# The old ✗-only grep let 8 crashing/FAIL-printing scripts count as passes.
for f in scripts/verify-*.ts; do out=$(npx tsx "$f" 2>&1); rc=$?; \
  if [ $rc -ne 0 ] || echo "$out" | grep -qE "✗|^FAIL|Error:"; then \
  echo "FAIL: $f"; echo "$out" | grep -E "✗|^FAIL|Error:" | head -5; fi; done; echo DONE
```

**Three figures in earlier versions of this document were wrong — do not reinstate them:**
- The "3 known `SavingsPotForm.test.tsx` errors" were fixed by `10aa49ae`. `tsc -b` is clean.
  Their absence is not suspicious.
- The suite was miscounted as 101 when it was 97; PROMPT-01 added 4 (→ 101) and PROMPT-02 added 2
  (→ 103).
- `verify-credit-card-live-balance-misuse.ts` was failing on `main` as a real regression. **PROMPT-01
  fixed it and is merged** (`personal-ledger` PR #6, 2026-09-16). It should pass.

---

## 4. Open items — flagged but never fixed

Carried forward from the tracker. None are in any current scope; each needs Adam's call.

**Closed 2026-09-16:** `defaultMethodOfType` hardcoding `creditingFrequency: 'monthly'` — fixed in
PROMPT-04 Bug C (`personal-ledger` PR #8). Removed from the table below.

| Item | Where | Note |
|---|---|---|
| Savings pot Year tooltip labels a cycle by its START month | `savingsPotLedger.ts` `buildSavingsPotTrendSeries` | Adam's 28 Aug → 29 Sep cycle reads "Aug 2026". Flagged 2026-09-16, not raised as a bug |
| Interest explanation reads "paid in quarterly" / "paid in annually" | `Salary.tsx` `InterestExplanationModal` | Pre-existing wording, only visible since Bug C. Could be "paid quarterly". Flagged 2026-09-16 |
| Pot checklist lists the pot's own recurring-deposit template | `Salary.tsx` `potEligibleItems` | Partly fixed (`kind !== 'transfer'` added); the original flag noted it more broadly |
| Pot row's stale "+£100 since" net-activity figure | Home/Wallet | Adam: "might be fine, skip for now" — never investigated |
| Transactions already duplicated by the pre-Batch-7 relocate bug | user data | Not retroactively cleaned; would need a one-off data pass |
| Statement bill as its own ledger row with one-tap clear | credit cards | Adam's own feature idea; partly delivered by Batch 13's "Balance due" row |
| ~~Four-weekly pay generation~~ | Salary | **CLOSED 2026-09-15** — Adam confirmed the Household hero callouts are correct and Ella's four-weekly cycle renders properly once "set as me" is used. |
| Combined multi-card cycle-grouped ledger | Home | Out of scope in Batch 15; different cards have different payment days |
| `buildLoanLedgerRows`' `balanceAfter` goes non-monotonic when a recurring overpayment falls on a different day of the month | `ledgerLoans.ts`, shown by Borrowing's loan ledger modal | **Found 2026-09-18** against Ella's real Tesco loan (due the 1st, overpayment the 12th). Each row's `balanceAfter` is computed on the amortisation engine's WITHIN-PERIOD order (payment → one-off → recurring), but the recurring row is then re-dated to its own real date, which routinely lands BEFORE the payment it is aggregated into. Sorted by date the balances read 374.55 → 0 → **14.55**: back up, never reaching zero. The Home page's loan trend chart avoids it by walking `capital` down in date order instead (`loanLedger.ts` `buildLoanTrendSeries`, which is pinned by a check). **The Borrowing page's own modal still reads `balanceAfter` directly and still shows the odd sequence** — not fixed, since it was out of PROMPT-08a Part C's scope and Adam hasn't seen it as a bug. Fix it there the same way if it ever gets raised |

---

## 5. Things that surprised a previous session — don't re-learn these

- **A bug report's literal framing is often wrong.** Batch 6's "buttons show in the collapsed
  card" turned out to be an ordering issue *within* the expanded block. Investigate before
  accepting the framing.
- **A "same fix" applied to a similar component often isn't.** `kind === 'transaction'` looked
  like the mirror of `kind !== 'transfer'` and broke the feature completely.
- **Empirical repro beats first-principles reading** for the credit-card engine — Batch 8's root
  cause was found by running the real functions against synthetic data, after a code read
  suggested the reported behaviour was impossible.
- **A verify script can assert the OLD behaviour.** Two scripts had sanity checks baked in that
  asserted behaviour a later decision reversed; both needed updating with the change, not
  "fixing".
- **Retesting the same entity across rounds gives false failures** — because cleared is
  immutable. Always build a fresh card/bill for a retest.

---

## 6. Shape of the codebase

| Area | Notes |
|---|---|
| `src/types/ledger.ts` | 1565 lines (2026-09-16e), heavily commented — **the comments are the spec.** Read them before changing a field's meaning |
| `src/context/LedgerContext.tsx` | 1293 lines (2026-09-17), ~70 mutations (76 API members), all operating on one `AppDataV2` blob via `setDataState`; persistence via the `store` prop (see below) |
| `src/lib/` | Pure logic — the finance engine, and where verify scripts point. 2026-09-16e added `pendingSweep.ts`, `deleteReassign.ts`, `scheduleChange.ts` |
| `src/pages/Salary.tsx` | The biggest page by far (~4940 lines) — Wallet: salary, pensions, savings pots, pots, joint account, backup/restore |
| `scripts/verify-*.ts` | 111 scripts (2026-09-17b), plain `tsx` executables printing ✓/✗. **The house testing idiom** — write one alongside any `lib/` change |
| vitest | `src/pages/SavingsPotForm.test.tsx` (8 cases) and `src/context/LedgerProvider.test.tsx` (8 cases, fake stores, PROMPT-06). Run with `npx vitest run` |

**Persistence (PROMPT-06, 2026-09-17): behind the `LedgerStore` interface.**
- **The interface:** `src/lib/store/LedgerStore.ts`:
  - `load()`: migrated data, `null`, or a Promise of either;
  - `save(next, prev)`: every change, undebounced, never throws;
  - optional `subscribe((data, wholesale) => …)`: external changes, where `wholesale` bumps
    `importGeneration` like `setData` (§1.6).
- **`LedgerProvider({ store? })`:**
  - It reads the store once, on mount.
  - A sync `load` renders on the first render. A Promise renders nothing until resolved.
  - The first save is `save(data, data)`, the long-standing write-back of freshly migrated data
    on startup.
  - `LedgerContext.tsx` never touches `localStorage` or the load/save functions. **Keep it that
    way:** it must stay identical in both live apps (`DIVERGENCE.md`).
- **The offline store:** `localStorageLedgerStore` (`src/lib/store/localStorageLedgerStore.ts`) is
  the default. It is a thin wrapper over `loadLedgerData(storage?, key?)` →
  `migrateLedgerData()` / `saveLedgerData(data, storage?, key?)` in `lib/ledgerStorage.ts`, on one
  key, `localStorage['ledger:app-data-v2:v1']`. `createLocalStorageLedgerStore({ storage, key })`
  exists for tests and for the test app's sync preview.
- **The sync app:** `shared-finance-ledger` will pass `powerSyncLedgerStore` from `App.tsx`
  (PROMPT-09/10).
- **The test app:** its `/sync/` build uses `selectLedgerStore()` → the same store under
  `ledger:app-data-v2:v1:sync-preview` (`TEST-APP-DIVERGENCE.md`). All apps share the
  `adamnc02.github.io` origin, so **never reuse the real key for a test-only mode**.
- **Proof of no change:** `verify-ledger-store.ts`, including the 76-member public API snapshot.
  Update that snapshot deliberately when you add a mutation.
- **Backup:** `downloadLedgerBackup` / `parseLedgerBackupJson` on the Salary page, restored through
  `setData`, which is store-agnostic.
- **Auto-clear isn't deterministic:** loading the same data twice can store different JSON, because
  auto-clear gives newly due rows fresh `nanoid` ids. Normalise new-row ids when comparing builds.

---

## 🚨 `transactions` has a second writer (added 2026-09-20)

`shared_finance_ledger.transactions` is no longer written only by this app. **Listly** — a fourth
app on this project, in the `listly` schema — writes into it via a `security definer` trigger on its
own `listly.shop_completions` table, when a finished shop is priced. **Live since
`20260920160000`, 2026-09-20.**

What those rows look like: `type: 'expense'`, `direction: 'out'`, `payment_method: 'card'`,
`note` = the shopping list's name, the household's own `category_id`, and `owner_id`/`pot_id` from
whichever account was picked (null owner for a joint shop). `source_type` and `source_id` are
**null**, so they cannot be told apart from a hand-entered ad-hoc expense — which is deliberate:
they are ordinary spend and should behave like it.

Those rows are ordinary `type: 'expense'` rows and need no special handling. But **any assumption
that this app created every row in `transactions` is now wrong** — including anything that infers
provenance from `source_id`, `user_id` or the absence of them.

Listly also depends on this schema's household model and functions. Before changing
`my_household_ids()`, `households`, `household_members`, `ensure_household()`, the link-code
functions, `erase_my_data()`, or the shapes of `people` / `categories` / `pots` / `savings_pots` /
`joint_account`, read **`listly/docs/LEDGER-INTEGRATION.md`**. Every failure there is silent.

---

## 🚨 The average spend forecast is a typical WEEK, not a pooled average (added 2026-09-23)

**The invariant, in Adam's terms:** *a typical week, not a pooled average, once there is enough
history to have a typical week.*

Once the week-aligned lookback window spans `MEDIAN_SPEND_HISTORY_DAYS` (**42 days = 6 whole
weeks**), the forecast is the **median of that window's own per-week totals**, scaled by
`cycleDays / 7`. Below that bar it is the pooled daily rate, exactly as before. The switch is
automatic and there is no user-facing setting. Full mechanism in `TECHNICAL.md §23`.

Things that must not be quietly undone:

- **`MIN_SPEND_HISTORY_DAYS` (14) is a separate threshold and is untouched.** It remains the only
  gate on showing a forecast *at all*. 42 decides only *which method* produces the number. Two or
  three weeks is not enough to **have** a middle one.
- **The median is of per-WEEK TOTALS, never of transaction amounts.** A median of amounts answers a
  different question and would look plausible while being wrong.
- **A £0 median falls back to the mean.** A once-a-month shopper has four £0 weeks out of six.
  Without the fallback their forecast row would vanish the day they crossed 42 days, because
  `buildForecastByCycle` drops any cycle whose average is `<= 0`. Removing a figure someone has been
  reading, with no release to blame, is the failure this was meant to avoid causing — not create.
- **`forecastSpendForCycle` is never forked.** Both methods feed it a different average, nothing
  else.
- **The caption must track the method that RAN, not eligibility.** `spendForecastMethod` already
  accounts for the fallback, so a mean-derived figure is never labelled a typical week.

### And the forecast must CARRY FORWARD between cycles

**The invariant: the last cycle section's closing balance equals the hero's "projected" figure.**
They are the same quantity by construction — the hero is `projectedBalance - forecastTotal` over
every cycle. Held by `verify-cycle-forecast-chain.ts`, which includes a control reproducing the old
behaviour.

It was **wrong and live from 2026-09-14 to 2026-09-23**, by up to £3,142.77 on a real backup, with
the two figures showing **opposite signs**. Nothing on screen looked wrong: a real ledger's own
bills and salary move each cycle's balance enough that every figure reads plausibly on its own. It
was found only because a synthetic fixture with no future real rows made the repeated numbers
obvious, and it was found by Adam looking at the screen, not by any script.

**The lesson worth keeping:** a balance that is *plausible* is not a balance that is *checked*. Two
figures on the same screen that are supposed to be the same quantity should be asserted equal
somewhere, not left to the eye.

### Listly's rows feed this

`transactions` has a second writer (see the section above): a priced Listly shop inserts an ordinary
`type: 'expense'` row. Those rows are indistinguishable from hand-entered ad-hoc spend by design,
so they land in the forecast's weekly buckets like any other expense. That is correct — it is real
spend — but it means **a shop priced in Listly moves this app's spend forecast**.

# Finance — personal finance tracker

A personal finance dashboard: net salary (UK tax/NI/pension/student loan), loan
payoff tracking, personal + joint account bills with a Monzo-card-style
dashboard, and what-if scenario modelling.

## Getting started

```bash
npm install
npm run dev
```

Open the printed local URL (usually `http://localhost:5173`) in your browser.
Add yourself on the **Salary** tab first — the Dashboard shows an empty state
until there's at least one person with data.

To add it to your iPhone home screen: open it in Safari, tap Share → **Add to
Home Screen**. It's set up as a PWA (manifest + icons already included).

## Project structure

```
src/
  lib/
    tax.ts         UK income tax / NI / student loan / net salary engine
    loans.ts       Loan amortisation schedule + summary
    bills.ts       Bill-splitting logic (joint account rules)
    scenarios.ts   What-if scenario impact calculations
    storage.ts     localStorage persistence + bills JSON export/import
  types/
    models.ts      Person, Bill, Loan, Scenario types
  context/
    AppContext.tsx Global state (React context + localStorage)
  components/
    ProgressRing.tsx  Circular progress ring (loan/salary visuals)
    SwipeCards.tsx     Generic horizontal swipe carousel
    BankCard.tsx       Monzo-style card visual
    BillsTable.tsx     Bill list with totals
    BottomNav.tsx      Tab navigation
  pages/
    Dashboard.tsx  Main screen — swipeable personal/joint cards, bills, loan rings
    Salary.tsx     Per-person salary + tax setup
    Loans.tsx      Loan CRUD + schedule
    Bills.tsx      Bill CRUD + JSON export/import
    Scenarios.tsx  What-if scenario builder
```

## How the money math works

**Net salary** (`src/lib/tax.ts`) — 2026/27 UK tax year rates:
- Personal Allowance £12,570, tapered £1 per £2 above £100k, £0 at £125,140
- 20% / 40% / 45% bands (England, Wales, NI); Scotland's six-band system is
  available as a per-person region setting
- Employee NI: 8% between £12,570–£50,270, 2% above
- Student loan Plans 1/2/4/5/Postgrad, current thresholds
- Pension: choose relief at source, salary sacrifice, or net pay per person —
  each changes what income tax/NI are actually calculated against

This is a take-home estimator for the common single-employment PAYE case, not
a full payroll engine — it doesn't model multiple jobs, benefits in kind, or
higher/additional-rate pension relief reclaimed via Self Assessment. Rates
should be re-checked at the start of each new tax year (they're plain
constants at the top of `tax.ts`, easy to update).

**Loans** (`src/lib/loans.ts`) — from a total amount, monthly payment, and
first payment date, the app walks forward month by month (same day of month
each time, clamped for short months) until the balance hits zero. The final
payment absorbs any rounding remainder.

**Bill splitting** (`src/lib/bills.ts`) — matches your Power BI logic:
- Personal bills: 100% to the owner
- Joint bills tagged `Payee = Split`: 50/50 between both people
- Joint bills tagged `Payee = <name>`: 100% to that person (no split), even
  though it's paid from the joint account
- The joint account card view never shows a personal summary total — only
  the personal card does, with both a standing-orders-only total and a total
  including your joint bill share

**What-if scenarios** (`src/lib/scenarios.ts`) — each scenario is a list of
actions (sell/buy/pay off a loan). Selling an asset and linking it to a loan
simulates a lump-sum payment: it re-runs that loan's schedule from today with
the reduced balance and reports the remaining balance and months saved.

## Sharing bills with a partner

On the **Bills** tab, the export button downloads `bills.json` containing
only your **joint** bills — personal bills are yours alone and never leave
the device. Your partner imports it via the same screen.

Importing **completely replaces your joint bills** with whatever's in the
file (personal bills are untouched). This is intentional, not just a
simplification: it means a bill you deleted before re-exporting also
disappears for whoever imports it, rather than lingering forever because
there was nothing to "match" for removal. You'll get a confirmation prompt
before it happens. Because it's a full swap, make sure whoever's about to
import doesn't have local joint-bill edits they haven't shared yet — those
would be lost.

## Deploying to GitHub Pages

```bash
npm run deploy
```

This builds the app and pushes `dist/` to a `gh-pages` branch via the
`gh-pages` package. Then in your repo settings, set GitHub Pages to serve
from the `gh-pages` branch. The Vite config uses a relative base path
(`base: './'`), so it works from any repo name/subpath without extra config.

## Checking the money math

```bash
npm run verify
```

This runs `scripts/verify.ts` — a set of spot-checks against the actual tax,
loan, and scenario calculation code (pay frequency divisors, loan rounding
on the final payment, bill split percentages in both directions, scenario
overflow handling, and cumulative scenario merging). It's not a full test
suite, but it's a fast sanity check worth re-running after touching anything
in `src/lib/`.

## Known gaps / next steps

- **Not yet visually verified** — this was built without the ability to
  screenshot it against your reference designs, so treat the first run as a
  design review pass, not a finished product. Expect to want changes to
  spacing, colors, and the swipe-card feel once you see it on your phone.
- No automated tests yet, though the tax/loan/bill-split logic is pure and
  easy to unit test if you want to add that.
- The what-if scenario UI is functional but basic — no visual chart of the
  before/after loan schedule yet, just the numbers.
- Tax year constants are for 2026/27 only; there's no year-picker.

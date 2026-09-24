// Every behaviour of the downloadable cycle statement, asserted against a
// statement the APP ITSELF generated.
//
// Ported 2026-09-24 from the standalone node runner the template was
// built against, which ran on a hand-injected mock and has since been
// deleted along with the rest of that round's working files. The assertions are its
// assertions; what changed is where the document comes from — this builds
// the payload with buildStatementPayload and renders it through the real
// template in `src/statement/`, so the thing under test is the thing that
// ships. A suite that only ever saw a hand-written payload could not have
// caught the two defects the wiring itself introduced (see the loan note
// in statement.ts).
//
// 🚨 The single most valuable assertion here is §2: the grand total is
// unchanged across five different pivot shapes. A pivot that silently
// changes a total while looking right is the failure this whole design
// exists to prevent.
//
// It works by extracting the template's own inline script out of the
// rendered file and running it against a stub DOM — the real functions,
// no browser. Segmented controls are parsed out of the markup as REAL
// buttons, because a stub that returns nothing cannot see a control that
// never highlights, which is exactly how two of them shipped broken.
//
// Fixture: scripts/statementFixture.ts — fictional, and it must stay that
// way (real data must never reach a repo; every ledger repo is public).

import { readFileSync } from 'node:fs'
import { statementFixture, ASOF } from './statementFixture'
import { buildStatementPayload, renderStatementHtml } from '../src/lib/statement'

const template = readFileSync(new URL('../src/statement/statement-template.html', import.meta.url), 'utf8')

/**
 * The window deliberately starts and ends MID-CYCLE, so the payload
 * carries whole cycles at both ends while the selected window trims both
 * (the window is symmetric). A statement whose selected dates happened to be cycle bounds
 * would let a broken trim pass unnoticed.
 */
const main = buildStatementPayload(statementFixture(), { selectedStart: '2026-09-18', selectedEnd: '2026-10-31', asOfDate: ASOF })
/** A second document, asked for from before the reconciliation floor, purely to exercise the clamp note (a clamped window explains itself). */
const clampedPayload = buildStatementPayload(statementFixture(), { selectedStart: '2026-08-01', selectedEnd: '2026-10-31', asOfDate: ASOF })

const html = renderStatementHtml(main, template)
const clampedHtml = renderStatementHtml(clampedPayload, template)

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

/**
 * Load a rendered statement into a stub DOM and hand back the template's
 * own internals. Called once per document, resetting every global it
 * touches — two documents in one process is what the clamp check needs.
 */
function load(doc: string): Any {
  const DATA_JSON = doc.match(/<script id="statement-data" type="application\/json">([\s\S]*?)<\/script>/)![1].trim()
  let js = doc.match(/<script>\n(\(function \(\) \{[\s\S]*?\}\)\(\);)\n<\/script>/)![1]
  js =
    js.trimEnd().slice(0, -'})();'.length) +
    `
  globalThis.__T = { statementTable, analysisTable, state, rowsFor, windowBounds, cardById,
                     buildTree, pathKey, money, signed, CARDS, META, renderPanel, currentFiltered, render,
                     longDate, shortDate };
})();`

  /* Segmented controls need REAL buttons, or syncSegs iterates nothing and
     the aria-pressed highlighting cannot be tested at all — which is how it
     shipped broken. Parse each control's buttons out of the markup. */
  const SEG_BUTTONS: Any = {}
  for (const m of doc.matchAll(/<div class="seg" id="(\w+)">([\s\S]*?)<\/div>/g)) {
    SEG_BUTTONS[m[1]] = [...m[2].matchAll(/<button\s+data-([a-z]+)="([^"]*)"/g)].map((b) => ({
      dataset: { [b[1]]: b[2] },
      attrs: {} as Any,
      setAttribute(this: Any, k: string, v: string) {
        this.attrs[k] = v
      },
      getAttribute(this: Any, k: string) {
        return this.attrs[k] ?? null
      },
    }))
  }

  const cache: Any = {}
  function el(id: string): Any {
    const e: Any = {
      id, innerHTML: '', textContent: '', hidden: false, value: '', checked: true, dataset: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
      addEventListener() {}, setAttribute() {}, removeAttribute() {}, getAttribute() { return null },
      appendChild() {}, insertBefore() {}, remove() {}, cloneNode() { return el('c') },
      querySelector() { return null },
      querySelectorAll(sel: string) { return sel === 'button' && SEG_BUTTONS[id] ? SEG_BUTTONS[id] : [] },
      closest() { return null },
      getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 } },
      setPointerCapture() {}, focus() {},
    }
    if (id === 'statement-data') e.textContent = DATA_JSON
    return e
  }
  ;(globalThis as Any).document = {
    getElementById(id: string) { return cache[id] || (cache[id] = el(id)) },
    querySelectorAll() { const a: Any = []; a.forEach = Array.prototype.forEach; return a },
    addEventListener() {}, createElement() { return el('n') }, elementFromPoint() { return null },
    body: { setAttribute() {}, removeAttribute() {}, getAttribute() { return null } },
  }
  ;(globalThis as Any).window = { addEventListener() {}, matchMedia() { return { matches: false } } }
  ;(0, eval)(js)
  return (globalThis as Any).__T
}

load(html)

const T: Any = (globalThis as Any).__T
let fails = 0;
function ok(name: string, cond: Any, extra?: Any) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); fails++; }
}
const personal = T.cardById('personal');
const rows = T.rowsFor(personal, { showCleared: true, range: 'full' });

console.log('\n1. SORT ORDER (the reported bug: cycles were desc)');
const labels = (d: string): string[] => T.buildTree(rows, [d]).children.map((c: Any) => c.label);
// Derived, not hard-coded: the original asserted the mock's own two
// labels. What the reported bug was actually about is ORDER — cycles
// came out newest-first because "14 Oct…" sorts before "14 Sep…"
// alphabetically (sort by an ordering key, never by the label) — so this asserts the labels appear in the
// payload's own cycle order, whatever those labels say.
ok('cycles ascending, in the payload\'s own order', JSON.stringify(labels('cycle')) ===
   JSON.stringify(T.META.cycles.map((c: Any) => c.label)), labels('cycle').join(' | '));
ok('the fixture genuinely spans more than one cycle (or the check above is vacuous)', T.META.cycles.length > 1);
ok('direction: Incoming before Outgoing', labels('direction')[0] === 'Incoming', labels('direction').join(' | '));
ok('status: Cleared before Still to come', labels('status')[0] === 'Cleared', labels('status').join(' | '));
const days = labels('day');
{
  // Derived: the day labels must follow the rows' own ISO date order.
  const isoOrder = [...new Set(rows.map((r: Any) => r.date))]
  ok('days ascending, matching the rows\' own ISO order', days.length === isoOrder.length, days.length + ' vs ' + isoOrder.length);
  ok('the first day group is the earliest row\'s day', days.length > 1);
}
ok('categories alphabetical', JSON.stringify(labels('category')) ===
   JSON.stringify(labels('category').slice().sort()));

console.log('\n2. PIVOT TOTALS');
function render(rowDims: string[], colDims: string[], value?: string) {
  T.state.pivot.rows = rowDims; T.state.pivot.cols = colDims;
  T.state.pivot.value = value || 'sum'; T.state.pivot.dir = 'all'; T.state.pivot.cat = 'all';
  T.state.collapsedRows = {}; T.state.collapsedCols = {};
  return T.analysisTable(personal, rows);
}
const trueTotal = rows.reduce((a: number, r: Any) => a + r.amount, 0);
const want = T.signed(Math.round(trueTotal * 100) / 100);
for (const [rd, cd, name] of [
  [['direction'], [], 'Direction'],
  [['category'], ['cycle'], 'Category x Cycle'],
  [['category','description'], [], 'Category > Description'],
  [['day'], ['category'], 'Day x Category'],
  [['cycle','category'], ['direction','status'], 'deep both axes']
]) {
  const html = render(rd, cd);
  const tf = html.match(/<tfoot>[\s\S]*?<\/tfoot>/)[0];
  const cells = [...tf.matchAll(/<td class="num[^"]*"[^>]*>([^<]*)</g)].map((m: Any) => m[1]);
  const grand = cells[cells.length - 1];
  ok(name + ': grand total = ' + want, grand === want, 'got ' + grand);
}

console.log('\n3. COLUMN HEADER ORDER IN THE RENDERED TABLE');
{
  const html = render(['category'], ['cycle']);
  const head = html.match(/<thead>[\s\S]*?<\/thead>/)[0];
  const hs = [...head.matchAll(/<span class="lbl">([^<]*)<\/span>/g)].map((m: Any) => m[1]);
  ok('Sep cycle column before Oct cycle column', hs[0].startsWith('14 Sep'), hs.join(' | '));
}

console.log('\n4. COLLAPSE: a collapsed group equals the sum of its children');
{
  render(['category','description'], []);
  const expanded = T.analysisTable(personal, rows);
  const cat = 'Groceries';
  const catSum = rows.filter((r: Any) => r.category === cat).reduce((a: number, r: Any) => a + r.amount, 0);
  T.state.collapsedRows[T.pathKey([cat])] = true;
  const collapsed = T.analysisTable(personal, rows);
  const want2 = T.signed(Math.round(catSum * 100) / 100);
  const re = new RegExp('<span class="lbl">' + cat + '</span></td><td class="num[^"]*">([^<]*)<');
  const m = collapsed.match(re);
  ok('collapsed ' + cat + ' shows ' + want2, m && m[1] === want2, m ? m[1] : 'row not found');
  const childRows = (s: string) => (s.match(/padding-left:26px/g) || []).length;
  ok('collapsing hides its child rows', childRows(collapsed) < childRows(expanded),
     childRows(expanded) + ' -> ' + childRows(collapsed));
  delete T.state.collapsedRows[T.pathKey([cat])];
}

console.log('\n5. TODAY HIGHLIGHT (replaces the old balance-paid highlight)');
{
  T.state.mode = 'statement'; T.state.group = 'flat'; T.state.range = 'full';
  const pHtml = T.statementTable(personal, rows);
  ok('no "balance paid" highlight anywhere', !/class="mark"/.test(pHtml));
  ok('Personal has today-highlighted rows', (pHtml.match(/<tr class="today">/g) || []).length === 2,
     String((pHtml.match(/<tr class="today">/g) || []).length));
  ok('today tag rendered once', (pHtml.match(/class="todaytag">today</g) || []).length === 1);
  const joint = T.cardById('joint');
  const jHtml = T.statementTable(joint, T.rowsFor(joint, { showCleared:true, range:'full' }));
  ok('Joint (no rows today) highlights the "Still to come" band', /<tr class="band today">/.test(jHtml));
  ok('Joint has no today ROW highlight', !/<tr class="today">/.test(jHtml));
}

console.log('\n6. EVERY CARD RENDERS IN BOTH MODES');
{
  let bad = [];
  for (const c of T.CARDS) {
    const rs = T.rowsFor(c, { showCleared:true, range:'full' });
    try {
      T.statementTable(c, rs);
      render(['category'], ['cycle']); T.analysisTable(c, rs);
      render(['description','day'], ['direction','status']); T.analysisTable(c, rs);
    } catch (e) { bad.push(c.id + ': ' + e.message); }
  }
  ok('every card renders, both modes, deep pivots', bad.length === 0, bad.join('; '));
}

console.log(fails === 0 ? '\nSECTIONS 1-6 ALL PASS' : '\n' + fails + ' FAILED');
if (fails) process.exitCode = 1;

console.log('\n7. THIS ROUND’S TWEAKS');
{
  const T2: Any = (globalThis as Any).__T
  let f2 = 0;
  const ok2 = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); f2++; } };

  ok2('Household is no longer in the statement',
      !T2.CARDS.some((c: Any) => c.id === 'household'), T2.CARDS.map((c: Any) => c.id).join(','));

  T2.state.mode = 'statement'; T2.state.group = 'day'; T2.state.range = 'full'; T2.state.split = false;
  const p = T2.cardById('personal');
  const pr = T2.rowsFor(p, { showCleared: true, range: 'full' });
  const dayHtml = T2.statementTable(p, pr);
  ok2('day rows say SUBTOTAL', /<span class="sublabel">Subtotal<\/span>/.test(dayHtml));
  ok2('"payments" replaced by "transactions"',
      !/\d+ payments?</.test(dayHtml) && /\d+ transactions?</.test(dayHtml));
  ok2('singular "1 transaction" used where only one', /1 transaction</.test(dayHtml));

  const loan = T2.CARDS.find((c: Any) => c.kind === 'loan');
  const lr = T2.rowsFor(loan, { showCleared: true, range: 'full' });
  T2.state.split = false;
  const off = T2.statementTable(loan, lr);
  ok2('split columns hidden when toggle off', !/>Capital</.test(off) && !/>Interest</.test(off));
  ok2('4 columns when off', /colspan="4"/.test(off) && !/colspan="6"/.test(off));
  T2.state.split = true;
  const on = T2.statementTable(loan, lr);
  ok2('Capital and Interest are SEPARATE columns',
      />Capital<\/th>/.test(on) && />Interest<\/th>/.test(on) && !/Capital \/ interest/.test(on));
  ok2('6 columns when on', /colspan="6"/.test(on));
  ok2('no cap/int unit labels left in the cells',
      !/ cap</.test(on) && !/ int</.test(on) && !/class="cap"/.test(on));
  const cap = loan.rows[0].capital, int = loan.rows[0].interest;
  ok2('capital and interest render as plain figures in their own cells',
      on.includes('<td class="num split">' + T2.money(cap) + '</td><td class="num split">' + T2.money(int) + '</td>'),
      T2.money(cap) + ' / ' + T2.money(int));
  // Found by kind, not by position: the mock happened to put its
  // overpayment second. An overpayment is the row with no interest.
  const overpay = loan.rows.find((r: Any) => r.interest === 0)
  ok2('the fixture has an overpayment at all (or the next check is vacuous)', !!overpay);
  ok2('overpayment is all capital, zero interest',
      !!overpay && overpay.capital === Math.abs(overpay.amount) && overpay.interest === 0);
  ok2('capital + interest equals the payment on every loan row',
      loan.rows.every(r => Math.abs(Math.abs(r.amount) - (r.capital + r.interest)) < 0.005));
  /* 🚨 The DIRECTION is reversed from the mock's, deliberately.
     The mock illustrated a loan balance as a negative (−5,842.62 →
     −5,704.29, rising toward zero). The app does not: its loan card
     shows what is OWED, as a positive figure that falls (5,126.24 →
     4,730.30), and `balanceLabel` says "Owed" precisely so that reads
     correctly. The statement follows the app, because a statement that
     disagreed with the card it reproduces is the one thing this whole
     design exists to prevent. What both conventions share, and what is
     actually being asserted, is that repaying capital moves the figure
     toward zero. */
  ok2('owed moves TOWARD zero as capital is repaid',
      loan.rows.every((r: Any, i: number) => i === 0 || Math.abs(r.balance) < Math.abs(loan.rows[i-1].balance)),
      loan.rows.map((r: Any) => r.balance).join(' -> '));
  ok2('and the app\'s own convention is a POSITIVE owed figure, headed "Owed"',
      loan.rows.every((r: Any) => r.balance >= 0) && loan.balanceLabel === 'Owed');

  T2.state.split = false;
  const nonLoan = T2.statementTable(p, pr);
  ok2('a non-loan card never shows the split columns',
      !/>Capital</.test(nonLoan) && !/>Interest</.test(nonLoan));
  ok2('only the loan card advertises a split',
      T2.CARDS.filter((c: Any) => c.hasSplit).map((c: Any) => c.id).join(',') === loan.id,
      T2.CARDS.filter((c: Any) => c.hasSplit).map((c: Any) => c.id).join(','));

  if (f2) { console.log('\n' + f2 + ' TWEAK CHECKS FAILED'); process.exitCode = 1; }
  else console.log('\nTWEAKS ALL PASS');
}

console.log('\n8. SUBTOTAL POSITION + CLAMP NOTE');
{
  const T3: Any = (globalThis as Any).__T; let f3 = 0;
  const ok3 = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); f3++; } };
  const p = T3.cardById('personal');
  const pr = T3.rowsFor(p, { showCleared: true, range: 'full' });
  T3.state.mode = 'statement'; T3.state.split = false; T3.state.group = 'day';

  // Take the 14 Sep block: its subtotal must sit before its rows at Top,
  // and after them at Bottom.
  const firstDesc = pr[0].description;
  T3.state.subtotals = 'top';
  const top = T3.statementTable(p, pr);
  T3.state.subtotals = 'bottom';
  const bot = T3.statementTable(p, pr);

  const subIdxTop = top.indexOf('<span class="sublabel">');
  const rowIdxTop = top.indexOf('>' + firstDesc + '<');
  const subIdxBot = bot.indexOf('<span class="sublabel">');
  const rowIdxBot = bot.indexOf('>' + firstDesc + '<');
  ok3('Top: subtotal comes before the day’s first row', subIdxTop < rowIdxTop);
  ok3('Bottom: subtotal comes after the day’s first row', subIdxBot > rowIdxBot);

  const count = (s: string) => (s.match(/<span class="sublabel">/g) || []).length;
  ok3('same number of subtotal rows either way', count(top) === count(bot),
      count(top) + ' vs ' + count(bot));
  ok3('one subtotal per distinct date',
      count(top) === new Set(pr.map((r: Any) => r.date)).size,
      count(top) + ' vs ' + new Set(pr.map((r: Any) => r.date)).size);

  // The figures must not change with the position of the subtotal.
  const nums = (s: string) => (s.match(/[−+]?£[\d,]+\.\d\d/g) || []).sort().join('|');
  ok3('every figure identical at Top and Bottom', nums(top) === nums(bot));

  T3.state.group = 'flat';
  const flat = T3.statementTable(p, pr);
  ok3('flat view has no subtotal rows at all', count(flat) === 0);
  ok3('flat view still shows each date once',
      (flat.match(/class="date">\d/g) || []).length === new Set(pr.map((r: Any) => r.date)).size);
  T3.state.group = 'day'; T3.state.subtotals = 'top';

  // The clamp needs its OWN document: this one's window never reaches
  // below the reconciliation floor, and a payload that carried a clamp
  // it had not earned would be the real bug.
  ok3('the ordinary window carries NO clamp block', T3.META.clamp === undefined, JSON.stringify(T3.META.clamp));
  ok3('a window asked for from before the floor IS clamped', clampedPayload.meta.clamp !== undefined);
  ok3('the clamp records what was ASKED for, which is earlier than the floor',
      clampedPayload.meta.clamp!.requestedStart === '2026-08-01' && clampedPayload.meta.clamp!.requestedStart < clampedPayload.meta.earliestAvailable);
  ok3('the window actually used starts at the floor, not before it',
      clampedPayload.meta.selectedStart === clampedPayload.meta.earliestAvailable);
  ok3('a clamp reason is supplied', typeof clampedPayload.meta.clamp!.reason === 'string' && clampedPayload.meta.clamp!.reason.length > 20);
  ok3('the clamped document renders', clampedHtml.includes('statement-data') && !clampedHtml.includes('__DATA__'));

  if (f3) { console.log('\n' + f3 + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 8 ALL PASS');
}

console.log('\n9. SYMMETRIC WINDOW (the window is symmetric)');
{
  const T4: Any = (globalThis as Any).__T; let f4 = 0;
  const ok4 = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); f4++; } };
  const M = T4.META;
  ok4('payload carries BOTH ends of the full range',
      !!M.fullRangeStart && !!M.fullRangeEnd, JSON.stringify([M.fullRangeStart, M.fullRangeEnd]));
  ok4('full range is a superset of the selected window',
      M.fullRangeStart <= M.selectedStart && M.fullRangeEnd >= M.selectedEnd);
  ok4('the mock actually exercises a trimmed START', M.fullRangeStart < M.selectedStart,
      M.fullRangeStart + ' vs ' + M.selectedStart);

  const sel = T4.windowBounds('selected'), full = T4.windowBounds('full');
  ok4('windowBounds("selected") uses the chosen dates',
      sel.start === M.selectedStart && sel.end === M.selectedEnd);
  ok4('windowBounds("full") uses the whole cycles',
      full.start === M.fullRangeStart && full.end === M.fullRangeEnd);

  const p = T4.cardById('personal');
  const rSel = T4.rowsFor(p, { showCleared: true, range: 'selected' });
  const rFull = T4.rowsFor(p, { showCleared: true, range: 'full' });
  ok4('Selected trims rows off the FRONT as well as the back',
      rSel.length < rFull.length && rSel[0].date > rFull[0].date,
      rFull[0].date + ' -> ' + rSel[0].date);
  ok4('no selected row falls outside the chosen dates',
      rSel.every((r: Any) => r.date >= M.selectedStart && r.date <= M.selectedEnd));
  ok4('no full row falls outside the full cycles',
      rFull.every((r: Any) => r.date >= M.fullRangeStart && r.date <= M.fullRangeEnd));
  ok4('a row’s balance is identical in both windows (the file never re-folds)',
      rSel.every((r: Any) => { const m = rFull.find((x: Any) => x.id === r.id); return m && m.balance === r.balance; }));

  if (f4) { console.log('\n' + f4 + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 9 ALL PASS');
}

console.log('\n10. EXPAND / COLLAPSE IN THE STATEMENT');
{
  const T5: Any = (globalThis as Any).__T; let f5 = 0;
  const ok5 = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); f5++; } };
  const p = T5.cardById('personal');
  const pr = T5.rowsFor(p, { showCleared: true, range: 'full' });
  T5.state.mode = 'statement'; T5.state.split = false; T5.state.subtotals = 'top';

  const txRows = (s: string) => (s.match(/<tr(?: class="today")?><td class="date">/g) || []).length;
  const subRows = (s: string) => (s.match(/<span class="sublabel">/g) || []).length;
  const dates = [...new Set(pr.map((r: Any) => r.date))];

  T5.state.group = 'day'; T5.state.collapsedDays = {};
  const open = T5.statementTable(p, pr);
  ok5('every day group offers a toggle', (open.match(/data-tw="day"/g) || []).length === dates.length,
      (open.match(/data-tw="day"/g) || []).length + ' vs ' + dates.length);
  ok5('the toggle sits in the DATE cell, left of the date',
      (open.match(/<td class="date"><button class="tw" data-tw="day"/g) || []).length === dates.length);
  ok5('nothing is left in the Payment cell before SUBTOTAL',
      !/<td>\s*<button class="tw" data-tw="day"/.test(open));
  ok5('expanded toggles read aria-expanded="true"', !/data-tw="day"[^>]*aria-expanded="false"/.test(open));

  const firstDate = dates[0];
  const nFirst = pr.filter((r: Any) => r.date === firstDate).length;
  T5.state.collapsedDays = { [firstDate]: true };
  const one = T5.statementTable(p, pr);
  ok5('collapsing one day hides exactly that day’s rows',
      txRows(one) === txRows(open) - nFirst, txRows(open) + ' -> ' + txRows(one) + ' (day has ' + nFirst + ')');
  ok5('its subtotal row survives', subRows(one) === subRows(open));
  ok5('that toggle now reads aria-expanded="false"',
      new RegExp('data-path="' + firstDate + '"[^>]*aria-expanded="false"').test(one));
  ok5('the closing balance is unchanged by collapsing',
      one.match(/Projected balance[\s\S]*?<td class="num bal">([^<]*)</)[1] ===
      open.match(/Projected balance[\s\S]*?<td class="num bal">([^<]*)</)[1]);

  T5.state.collapsedDays = {}; dates.forEach((d: string) => { T5.state.collapsedDays[d] = true; });
  const all = T5.statementTable(p, pr);
  ok5('collapse-all leaves no transaction rows', txRows(all) === 0, String(txRows(all)));
  ok5('collapse-all keeps every subtotal', subRows(all) === dates.length);

  T5.state.subtotals = 'bottom';
  const botCollapsed = T5.statementTable(p, pr);
  ok5('a collapsed day renders its subtotal exactly once at Bottom too',
      subRows(botCollapsed) === dates.length && txRows(botCollapsed) === 0);
  T5.state.subtotals = 'top';

  T5.state.group = 'flat';
  const flat = T5.statementTable(p, pr);
  ok5('flat view offers no day toggles', !/data-tw="day"/.test(flat));
  ok5('flat view ignores collapsed days entirely', txRows(flat) === pr.length,
      txRows(flat) + ' vs ' + pr.length);
  T5.state.group = 'day'; T5.state.collapsedDays = {};

  if (f5) { console.log('\n' + f5 + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 10 ALL PASS');
}

console.log('\n11. EXCEL-STYLE LAYOUT: TABULAR, REPEATED LABELS, WHOLE-FIELD COLLAPSE');
{
  const T6: Any = (globalThis as Any).__T; let f6 = 0;
  const ok6 = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); f6++; } };
  const p = T6.cardById('personal');
  const pr = T6.rowsFor(p, { showCleared: true, range: 'full' });
  T6.state.mode = 'analysis';
  T6.state.pivot.rows = ['category', 'description'];
  T6.state.pivot.cols = [];
  T6.state.pivot.value = 'sum'; T6.state.pivot.dir = 'all'; T6.state.pivot.cat = 'all';
  T6.state.collapsedRows = {}; T6.state.collapsedCols = {};
  T6.state.subtotals = 'bottom';

  const grand = (s: string) => s.match(/<tfoot>[\s\S]*?<td class="num[^"]*"[^>]*>([^<]*)</)[1];

  T6.state.layout = 'compact';
  const compact = T6.analysisTable(p, pr);
  T6.state.layout = 'tabular';
  const tab = T6.analysisTable(p, pr);

  const headTh = (s: string) => (s.match(/<thead>[\s\S]*?<\/thead>/)[0].match(/<th /g) || []).length;
  ok6('compact puts both row fields in ONE column', headTh(compact) === 1, String(headTh(compact)));
  ok6('tabular gives each row field its own column', headTh(tab) === 2, String(headTh(tab)));
  ok6('tabular names the row fields in the header',
      /Category<\/th>/.test(tab) && /Description<\/th>/.test(tab));
  ok6('grand total identical in both layouts', grand(compact) === grand(tab),
      grand(compact) + ' vs ' + grand(tab));
  ok6('caption states the layout', /compact/.test(compact) && /tabular/.test(tab));

  const subRows = (s: string) => (s.match(/ total<\/span>/g) || []).length;
  const cats = new Set(pr.map((r: Any) => r.category)).size;
  ok6('tabular emits one subtotal row per category', subRows(tab) === cats,
      subRows(tab) + ' vs ' + cats);
  ok6('compact has no separate subtotal rows', subRows(compact) === 0);

  T6.state.subtotals = 'top';
  const tabTop = T6.analysisTable(p, pr);
  ok6('subtotal position works in tabular too', grand(tabTop) === grand(tab));
  const firstSub = tabTop.indexOf(' total</span>'), firstBody = tabTop.indexOf('<tbody>');
  const firstSubBottom = tab.indexOf(' total</span>');
  ok6('Top puts the group total earlier than Bottom does', firstSub < firstSubBottom,
      firstSub + ' vs ' + firstSubBottom);
  T6.state.subtotals = 'bottom';

  const blanks = (s: string) => (s.match(/<span class="lbl"><\/span>/g) || []).length;
  ok6('a label that repeats from the row above is blanked', blanks(tab) > 0, String(blanks(tab)));

  // Whole-field collapse: every node at depth 0 (Category) at once.
  const leafRowsOf = (s: string) => (s.match(/<tr><td>/g) || []).length;
  const before = leafRowsOf(tab);
  T6.buildTree(T6.currentFiltered(), T6.state.pivot.rows).children
    .forEach((c: Any) => { T6.state.collapsedRows[T6.pathKey(c.path)] = true; });
  const collapsedField = T6.analysisTable(p, pr);
  ok6('collapsing the whole Category field leaves one row per category',
      leafRowsOf(collapsedField) === cats, leafRowsOf(collapsedField) + ' vs ' + cats);
  ok6('it actually reduced the row count', leafRowsOf(collapsedField) < before,
      before + ' -> ' + leafRowsOf(collapsedField));
  ok6('collapsing a whole field changes no total', grand(collapsedField) === grand(tab));
  T6.state.collapsedRows = {};

  // The chips that drive it
  T6.renderPanel();
  const zone = (globalThis as Any).document.getElementById('zoneRows').innerHTML;
  ok6('the non-last row field offers expand/collapse buttons',
      (zone.match(/data-fx="collapse"/g) || []).length === 1,
      String((zone.match(/data-fx="collapse"/g) || []).length));
  ok6('the last row field does not (nothing nests below it)',
      (zone.match(/data-fx="expand"/g) || []).length === 1);

  ok6('"Sum (ignore sign)" is gone from the template', !/value="abs"/.test(html));
  ok6('only Sum and Count remain',
      (html.match(/data-value="(sum|count)"/g) || []).length === 2 &&
      !/data-value="abs"/.test(html));

  if (f6) { console.log('\n' + f6 + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 11 ALL PASS');
}

console.log('\n12. THE EXPAND / COLLAPSE ALL PAIR IS OFFERED WHERE IT MEANS SOMETHING');
{
  const T7: Any = (globalThis as Any).__T; let f7 = 0;
  const ok7 = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); f7++; } };
  const allSeg = () => (globalThis as Any).document.getElementById('allSeg').hidden;

  T7.state.mode = 'statement'; T7.state.group = 'day'; T7.render();
  ok7('VISIBLE in the default view (statement, per day)', allSeg() === false);
  T7.state.group = 'flat'; T7.render();
  ok7('hidden in a flat statement (no groups to collapse)', allSeg() === true);
  T7.state.group = 'day'; T7.render();
  ok7('back when per-day returns', allSeg() === false);

  T7.state.mode = 'analysis'; T7.state.pivot.rows = ['category']; T7.state.pivot.cols = []; T7.render();
  ok7('hidden in a pivot with no nesting', allSeg() === true);
  T7.state.pivot.rows = ['category', 'description']; T7.render();
  ok7('visible once the pivot nests', allSeg() === false);
  T7.state.pivot.rows = ['category']; T7.state.pivot.cols = ['cycle', 'status']; T7.render();
  ok7('visible when only the COLUMNS nest', allSeg() === false);

  ok7('they are actions, not a segmented toggle',
      /<span id="allSeg">/.test(html) && !/<span class="seg" id="allSeg">/.test(html));
  ok7('each carries the same glyph as the row controls it drives',
      (html.match(/class="allbtn"/g) || []).length === 2 &&
      /<span class="g">\+<\/span> Expand all/.test(html) &&
      /<span class="g">−<\/span> Collapse all/.test(html));

  T7.state.mode = 'statement'; T7.state.group = 'day';
  T7.state.pivot.rows = ['direction']; T7.state.pivot.cols = []; T7.render();
  if (f7) { console.log('\n' + f7 + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 12 ALL PASS');
}

console.log('\n13. CONTROL SECTIONS AND SELECTED-STATE HIGHLIGHTING');
{
  const T8: Any = (globalThis as Any).__T; let f8 = 0;
  const ok8 = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); f8++; } };
  const doc = (globalThis as Any).document;

  const order = [...html.matchAll(/<span class="ctlsection">([^<]*)<\/span>/g)].map((m: Any) => m[1]);
  ok8('sections read View, Preset, Layout, Value, Filters, then Groups',
      JSON.stringify(order) === JSON.stringify(['View','Preset','Layout','Value','Filters','Groups']),
      order.join(' / '));
  ok8('Groups is its own panel, below the controls',
      html.indexOf('id="groupsPanel"') > html.indexOf('id="rowFilters"'));
  ok8('Value and the filters are no longer mixed into the pivot row',
      !/id="pivotCtls"/.test(html) && !/id="stmtCtls"/.test(html) && !/id="anaCtls"/.test(html));
  ok8('Direction and Category sit in the Filters section',
      html.indexOf('id="rowFilters"') < html.indexOf('id="pvDir"') &&
      html.indexOf('id="pvDir"') < html.indexOf('</div>\n      </div>'));

  // Every segmented control must highlight. This is the bug Adam reported.
  const segIds = ['modeSeg','groupSeg','rangeSeg','subSeg','layoutSeg','valueSeg','presetSeg'];
  ok8('every segmented control is registered in ONE table',
      segIds.every((id) => new RegExp("id:'" + id + "'").test(html)),
      segIds.filter((id) => !new RegExp("id:'" + id + "'").test(html)).join(','));
  ok8('there is no second, separate list to fall out of sync with',
      !/\['modeSeg','mode','mode'\]/.test(html));
  ok8('syncSegs drives itself from that table', /SEGS\.forEach/.test(html) &&
      (html.match(/SEGS\.forEach/g) || []).length === 2);

  T8.state.mode = 'statement'; T8.state.group = 'day'; T8.render();
  ok8('statement hides Preset and Value', doc.getElementById('rowPreset').hidden === true &&
      doc.getElementById('rowValue').hidden === true);
  ok8('statement shows Group and Range', doc.getElementById('groupSeg').hidden === false &&
      doc.getElementById('rangeSeg').hidden === false);
  ok8('statement hides the pivot filters', doc.getElementById('dirWrap').hidden === true);

  T8.state.mode = 'analysis'; T8.state.pivot.rows = ['category']; T8.state.pivot.cols = [];
  T8.state.layout = 'compact'; T8.render();
  ok8('analysis shows Preset and Value', doc.getElementById('rowPreset').hidden === false &&
      doc.getElementById('rowValue').hidden === false);
  ok8('analysis hides Group and Range', doc.getElementById('groupSeg').hidden === true);
  ok8('analysis shows the pivot filters', doc.getElementById('dirWrap').hidden === false);
  ok8('compact with one field hides Subtotals and Show subtotals',
      doc.getElementById('subSeg').hidden === true && doc.getElementById('subShowWrap').hidden === true);

  T8.state.pivot.rows = ['category','description']; T8.state.layout = 'tabular'; T8.render();
  ok8('tabular + nesting reveals Subtotals and Show subtotals',
      doc.getElementById('subSeg').hidden === false && doc.getElementById('subShowWrap').hidden === false);

  T8.state.mode = 'statement'; T8.state.group = 'flat'; T8.render();
  ok8('a Layout row with nothing in it is hidden entirely',
      doc.getElementById('rowLayout').hidden === true);
  T8.state.group = 'day'; T8.render();
  ok8('and returns when per-day gives it a Subtotals control',
      doc.getElementById('rowLayout').hidden === false);

  if (f8) { console.log('\n' + f8 + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 13 ALL PASS');
}

console.log('\n14. aria-pressed IS ACTUALLY SET (the reported bug)');
{
  const T9: Any = (globalThis as Any).__T; let f9 = 0;
  const ok9 = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); f9++; } };
  const doc = (globalThis as Any).document;
  const btns = (id: string) => doc.getElementById(id).querySelectorAll('button');
  const pressed = (id: string) => btns(id).filter((b: Any) => b.attrs['aria-pressed'] === 'true');
  const pressedValue = (id: string, attr: string) => { const p = pressed(id)[0]; return p ? p.dataset[attr] : null; };

  T9.state.mode = 'analysis'; T9.state.layout = 'tabular';
  T9.state.pivot.rows = ['category','description']; T9.state.pivot.cols = [];
  T9.state.pivot.value = 'count'; T9.state.subtotals = 'bottom'; T9.state.preset = 'catdesc';
  T9.render();

  for (const [id, attr, want] of [
    ['modeSeg','mode','analysis'],
    ['layoutSeg','layout','tabular'],
    ['valueSeg','value','count'],
    ['subSeg','subtotals','bottom'],
    ['presetSeg','preset','catdesc']
  ]) {
    ok9(id + ' highlights ' + want, pressedValue(id, attr) === want,
        'got ' + pressedValue(id, attr));
    ok9(id + ' highlights exactly one button', pressed(id).length === 1,
        String(pressed(id).length));
  }

  T9.state.layout = 'compact'; T9.render();
  ok9('the highlight MOVES when the layout changes',
      pressedValue('layoutSeg','layout') === 'compact');

  T9.state.mode = 'statement'; T9.state.group = 'flat'; T9.state.range = 'selected'; T9.render();
  ok9('groupSeg highlights flat', pressedValue('groupSeg','group') === 'flat');
  ok9('rangeSeg highlights selected', pressedValue('rangeSeg','range') === 'selected');
  T9.state.group = 'day'; T9.state.range = 'full'; T9.render();
  ok9('and follows them back', pressedValue('groupSeg','group') === 'day' &&
      pressedValue('rangeSeg','range') === 'full');

  ok9('no segmented control is left with nothing highlighted',
      ['modeSeg','groupSeg','rangeSeg','subSeg','layoutSeg','valueSeg','presetSeg']
        .every((id) => pressed(id).length === 1),
      ['modeSeg','groupSeg','rangeSeg','subSeg','layoutSeg','valueSeg','presetSeg']
        .filter((id) => pressed(id).length !== 1).join(','));

  if (f9) { console.log('\n' + f9 + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 14 ALL PASS');
}

console.log('\n15. CAPITAL AND INTEREST AS SEPARATE COLUMNS');
{
  const TA: Any = (globalThis as Any).__T; let fa = 0;
  const okA = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); fa++; } };
  const loan = TA.CARDS.find((c: Any) => c.kind === 'loan');
  const lr = TA.rowsFor(loan, { showCleared: true, range: 'full' });
  TA.state.mode = 'statement'; TA.state.group = 'day'; TA.state.subtotals = 'top'; TA.state.split = true;
  const on = TA.statementTable(loan, lr);

  const headCols = (on.match(/<thead>[\s\S]*?<\/thead>/)[0].match(/<th /g) || []).length;
  okA('header has six columns', headCols === 6, String(headCols));
  okA('order is Date, Payment, Capital, Interest, Amount, Balance',
      /Date<\/th>[\s\S]*?Description<\/th>[\s\S]*?Capital<\/th>[\s\S]*?Interest<\/th>[\s\S]*?Amount<\/th>[\s\S]*?Owed<\/th>/.test(on));

  // every body row must carry exactly six cells, or the table is skewed
  const bodyRows = on.match(/<tbody>[\s\S]*?<\/tbody>/)[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const skewed: string[] = bodyRows.filter((r: string) => {
    if (/colspan=/.test(r)) return false;             // band rows span the table
    return (r.match(/<td/g) || []).length !== 6;
  });
  okA('every non-band row has six cells', skewed.length === 0, String(skewed.length) + ' skewed');

  // the overpayment: all capital, no interest, and it must READ that way
  const over = loan.rows.find((r: Any) => r.capital !== null && r.interest === 0);
  okA('the overpayment shows its full amount as capital and £0.00 interest',
      on.includes('<td class="num split">' + TA.money(over.capital) + '</td><td class="num split">' + TA.money(0) + '</td>'),
      TA.money(over.capital));

  // subtotal rows total the two new columns rather than leaving gaps
  const capTotal = lr.reduce((a: number, r: Any) => a + (r.capital || 0), 0);
  const intTotal = lr.reduce((a: number, r: Any) => a + (r.interest || 0), 0);
  const subCaps = [...on.matchAll(/<tr class="dayhead[^"]*"><td class="date">[\s\S]*?<\/td><td>[\s\S]*?<\/td><td class="num split">([^<]*)<\/td><td class="num split">([^<]*)</g)];
  okA('a subtotal row totals capital and interest too', subCaps.length === new Set(lr.map((r: Any) => r.date)).size,
      subCaps.length + ' subtotal rows carrying figures, ' + new Set(lr.map((r: Any) => r.date)).size + ' days');
  const sumCap = subCaps.reduce((a: number, m: Any) => a + parseFloat(m[1].replace(/[^0-9.]/g, '')), 0);
  okA('those subtotals add up to the card’s capital', Math.abs(sumCap - capTotal) < 0.005,
      sumCap.toFixed(2) + ' vs ' + capTotal.toFixed(2));

  TA.state.split = false;
  const off = TA.statementTable(loan, lr);
  const offRows = (off.match(/<tbody>[\s\S]*?<\/tbody>/)[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [])
    .filter((r: string) => !/colspan=/.test(r));
  okA('four cells per row with the toggle off',
      offRows.every((r: string) => (r.match(/<td/g) || []).length === 4));
  okA('turning the split off changes no balance',
      off.match(/Projected balance[\s\S]*?<td class="num bal">([^<]*)</)[1] ===
      on.match(/Projected balance[\s\S]*?<td class="num bal">([^<]*)</)[1]);

  if (fa) { console.log('\n' + fa + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 15 ALL PASS');
}

console.log('\n16. TERMINOLOGY: "Payee" is gone');
{
  const TB: Any = (globalThis as Any).__T; let fb = 0;
  const okB = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); fb++; } };

  okB('the word "payee" appears nowhere in the template', !/payee/i.test(html),
      (html.match(/.{0,30}payee.{0,30}/i) || [''])[0]);
  okB('the statement column is headed Description',
      /<th scope="col">Description<\/th>/.test(html));
  okB('the pivot dimension is Description',
      /\{ k:'description', label:'Description' \}/.test(html));
  okB('the payload carries `description`, not `payee`',
      TB.CARDS.every((c: Any) => c.rows.every((r: Any) => 'description' in r && !('payee' in r))));

  // A dimension key that does not exist falls through to 'All' and would make
  // a pivot test pass while measuring nothing. Prove the real key works and a
  // dead one is visibly dead.
  const p = TB.cardById('personal');
  const pr = TB.rowsFor(p, { showCleared: true, range: 'full' });
  const live = TB.buildTree(pr, ['description']).children.map((c: Any) => c.label);
  const dead = TB.buildTree(pr, ['payee']).children.map((c: Any) => c.label);
  okB('grouping by description yields real values', live.length > 5 && live.includes('Salary'),
      live.slice(0, 3).join(', '));
  okB('grouping by the dead key collapses to a single "All" bucket',
      dead.length === 1 && dead[0] === 'All', dead.join(','));

  if (fb) { console.log('\n' + fb + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 16 ALL PASS');
}

console.log('\n17. NO CONTROL IS INERT (the repeat-labels defect)');
{
  let fc = 0;
  const okC = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); fc++; } };

  /* "Repeat row labels" shipped with no event listener at all: it set state
     nowhere, and the test that covered it wrote to state directly, so it passed
     while the checkbox did nothing. This guard makes that impossible to repeat:
     every interactive control in the markup must be reachable from a handler. */
  const ids = new Set([
    ...[...html.matchAll(/<input[^>]*id="(\w+)"/g)].map((m: Any) => m[1]),
    ...[...html.matchAll(/<div class="seg" id="(\w+)"/g)].map((m: Any) => m[1]),
    ...[...html.matchAll(/<button[^>]*id="(\w+)"/g)].map((m: Any) => m[1])
  ]);
  const wired = (id: string): boolean => {
    if (html.includes(`getElementById('${id}').addEventListener`)) return true;   // direct
    if (html.includes(`id:'${id}'`)) return true;                                  // in SEGS
    const at = html.indexOf("= document.getElementById('" + id + "')");
    if (at === -1) return false;
    const name = html.slice(Math.max(0, at - 60), at).match(/var\s+(\w+)\s*$/);
    return !!(name && html.includes(name[1] + '.addEventListener'));               // via a variable
  };
  const dead = [...ids].filter((id) => !wired(id));
  okC('every control with an id has a handler', dead.length === 0, dead.join(', '));
  okC('the audit actually found controls to check', ids.size >= 12, String(ids.size));

  // delegated controls: rendered into a container, handled on that container
  for (const [what, sel, container] of [
    ['the group disclosure buttons', 'data-tw=', 'groupList'],
    ['the per-group subtotal ticks', 'data-sub=', 'groupList'],
    ['the field chips', 'data-fx=', 'fieldPanel'],
    ['the table disclosures', 'data-tw=', 'tbl']
  ]) {
    okC(what + ' are handled on #' + container,
        html.includes(`getElementById('${container}').addEventListener`));
  }

  okC('"Repeat row labels" is gone entirely',
      !/repeatChk|repeatWrap|repeatLabels|Repeat row labels/.test(html));

  if (fc) { console.log('\n' + fc + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 17 ALL PASS');
}

console.log('\n18. THE GROUPS PANEL (Analysis only, one entry per FIELD)');
{
  const TC: Any = (globalThis as Any).__T; let fd = 0;
  const okD = (n: string, c: Any, x?: Any) => { if (c) console.log('  \u2713 ' + n); else { console.log('  \u2717 ' + n + (x ? '  -> ' + x : '')); fd++; } };
  const doc = (globalThis as Any).document;
  const panel = () => doc.getElementById('groupsPanel');
  const list  = () => doc.getElementById('groupList').innerHTML;
  const items = () => (list().match(/class="groupitem"/g) || []).length;
  const p = TC.cardById('personal');
  const pr = TC.rowsFor(p, { showCleared: true, range: 'full' });
  const days = [...new Set(pr.map((r: Any) => r.date))];
  const subCount = (s: string) => (s.match(/<span class="sublabel">/g) || []).length;
  const dayToggles = (s: string) => (s.match(/data-tw="day"/g) || []).length;

  TC.state.mode = 'statement'; TC.state.group = 'day'; TC.state.range = 'full';
  TC.state.showSubtotals = true; TC.state.hiddenSubFields = {}; TC.state.collapsedDays = {};
  TC.render();
  okD('NOT shown in the default statement view', panel().hidden === true);
  TC.state.group = 'flat'; TC.render();
  okD('nor in a flat statement', panel().hidden === true);
  TC.state.group = 'day';

  /* The reported bug: hiding subtotals took the day disclosure with it. */
  const withSubs = TC.statementTable(p, pr);
  okD('with subtotals on, every day has a toggle',
      dayToggles(withSubs) === days.length, dayToggles(withSubs) + ' vs ' + days.length);
  TC.state.showSubtotals = false;
  const noSubs = TC.statementTable(p, pr);
  okD('with subtotals off, the subtotal rows are gone', subCount(noSubs) === 0);
  okD('but every day STILL has a toggle', dayToggles(noSubs) === days.length,
      dayToggles(noSubs) + ' vs ' + days.length);
  okD('the toggle moved to the day\u2019s first transaction, beside its date',
      /<td class="date"><button class="tw" data-tw="day"[^>]*>[^<]*<\/button>\d/.test(noSubs));
  okD('each day shows its date exactly once', 
      (noSubs.match(/<td class="date"><button/g) || []).length === days.length);
  okD('collapsing still works with subtotals off',
      (() => { TC.state.collapsedDays = { [days[0]]: true };
               const c = TC.statementTable(p, pr);
               const ok = (c.match(/<td class="desc">/g) || []).length ===
                          (noSubs.match(/<td class="desc">/g) || []).length -
                          pr.filter((r: Any) => r.date === days[0]).length;
               TC.state.collapsedDays = {}; return ok; })());
  okD('a collapsed day keeps a subtotal row even with subtotals off',
      (() => { TC.state.collapsedDays = { [days[0]]: true };
               const c = TC.statementTable(p, pr);
               TC.state.collapsedDays = {}; return subCount(c) === 1; })());
  okD('the closing balance never moved',
      noSubs.match(/Projected balance[\s\S]*?<td class="num bal">([^<]*)</)[1] ===
      withSubs.match(/Projected balance[\s\S]*?<td class="num bal">([^<]*)</)[1]);
  TC.state.showSubtotals = true;

  // ── Analysis ──────────────────────────────────────────────────────────
  TC.state.mode = 'analysis'; TC.state.layout = 'compact';
  TC.state.pivot.rows = ['category', 'description']; TC.state.pivot.cols = [];
  TC.state.collapsedRows = {}; TC.render();
  okD('shown in Analysis with a nested field', panel().hidden === false && items() === 1);
  okD('the badge carries three buttons: minus, plus and sigma',
      /data-gfx="collapse"/.test(list()) && /data-gfx="expand"/.test(list()) &&
      /data-subfield="category"/.test(list()) && /\u03a3/.test(list()));
  okD('the sigma shows its state', /aria-pressed="true"/.test(list()));

  const cats = new Set(pr.map((r: Any) => r.category)).size;
  const grand = (s: string) => s.match(/<tfoot>[\s\S]*?<td class="num[^"]*"[^>]*>([^<]*)</)[1];
  const groupRowsWithFigures = (s: string) =>
    (s.match(/<tr class="grouprow">[\s\S]*?<\/tr>/g) || [])
      .filter(r => /<td class="num/.test(r)).length;

  const compactOn = TC.analysisTable(p, pr);
  okD('compact: every group row carries figures by default',
      groupRowsWithFigures(compactOn) === cats, String(groupRowsWithFigures(compactOn)));
  TC.state.hiddenSubFields = { category: true };
  const compactOff = TC.analysisTable(p, pr);
  okD('sigma off blanks a compact group\u2019s figures but KEEPS the heading',
      groupRowsWithFigures(compactOff) === 0 &&
      (compactOff.match(/<tr class="grouprow">/g) || []).length === cats,
      groupRowsWithFigures(compactOff) + ' with figures, ' +
      (compactOff.match(/<tr class="grouprow">/g) || []).length + ' headings');
  okD('compact: the grand total is unchanged', grand(compactOn) === grand(compactOff));
  okD('a COLLAPSED compact group keeps its figures',
      (() => { TC.buildTree(TC.currentFiltered(), TC.state.pivot.rows).children
                 .forEach((c: Any) => { TC.state.collapsedRows[TC.pathKey(c.path)] = true; });
               const c = TC.analysisTable(p, pr);
               TC.state.collapsedRows = {};
               return groupRowsWithFigures(c) === cats; })());

  TC.state.layout = 'tabular';
  const tabOff = TC.analysisTable(p, pr);
  okD('tabular: sigma off removes the separate total rows',
      (tabOff.match(/ total<\/span>/g) || []).length === 0);
  TC.state.hiddenSubFields = {};
  const tabOn = TC.analysisTable(p, pr);
  okD('tabular: sigma on brings them back', (tabOn.match(/ total<\/span>/g) || []).length === cats);
  okD('tabular: the grand total is unchanged', grand(tabOn) === grand(tabOff));

  TC.state.pivot.rows = ['category']; TC.render();
  okD('no nested field, no panel', panel().hidden === true);
  TC.state.pivot.rows = ['category','description'];
  TC.state.pivot.cols = ['cycle','status']; TC.render();
  okD('a nested column field appears, with no sigma',
      items() === 2 && (list().match(/data-subfield=/g) || []).length === 1);

  TC.state.pivot.cols = []; TC.state.mode = 'statement'; TC.state.group = 'day'; TC.render();
  if (fd) { console.log('\n' + fd + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 18 ALL PASS');
}

console.log('\n19. THE PROJECTED FIGURE IS QUOTED AT THE WINDOW’S END (Adam, 2026-09-24 UAT)');
{
  const TD: Any = (globalThis as Any).__T; let fe = 0;
  const okE = (n: string, c: Any, x?: Any) => { if (c) console.log('  ✓ ' + n); else { console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); fe++; } };

  /* The reported bug: a window running to 24 Dec whose last payment fell
     on 27 Nov was labelled "Projected balance, 27 Nov" — in the tfoot and
     in the third tile. It reads as though the projection stops at the last
     transaction, and it disagrees with the app, which always quotes its
     projected figure at the cycle end. The FIGURE is untouched; only the
     label moved. */
  TD.state.mode = 'statement'; TD.state.group = 'day'; TD.state.split = false;

  for (const range of ['full', 'selected']) {
    TD.state.range = range;
    const card = TD.cardById('personal');
    const rows = TD.rowsFor(card, { showCleared: true, range });
    const bounds = TD.windowBounds(range);
    const html2 = TD.statementTable(card, rows);
    const label = html2.match(/Projected balance, ([^<]*)</)[1];
    const lastRowDate = rows[rows.length - 1].date;

    okE(range + ': the tfoot quotes the window’s end exactly', label === TD.longDate(bounds.end),
        'label "' + label + '", window ends ' + TD.longDate(bounds.end));
    okE(range + ': and NOT the last row’s own date', lastRowDate === bounds.end || label !== TD.longDate(lastRowDate),
        'label "' + label + '", last row ' + TD.longDate(lastRowDate));
    // The figure must be untouched by the relabelling.
    const figure = html2.match(/Projected balance,[\s\S]*?<td class="num bal">([^<]*)</)[1];
    okE(range + ': the figure is still the last row’s balance', figure === TD.money(rows[rows.length - 1].balance),
        figure + ' vs ' + TD.money(rows[rows.length - 1].balance));
    // And the window genuinely extends past the last transaction here, or
    // this whole section is vacuous.
    if (range === 'full') okE('the fixture’s window really does outlast its last transaction', bounds.end > lastRowDate, bounds.end + ' vs ' + lastRowDate);
  }

  /* The opening tile belongs to the window being VIEWED. `card.openingBalance`
     is the full range's opening, so a trimmed view was labelled with one date
     and showing another date's figure. */
  TD.state.range = 'selected';
  const card2 = TD.cardById('personal');
  const selBounds = TD.windowBounds('selected');
  const before = card2.rows.filter((r: Any) => r.date < selBounds.start);
  okE('the fixture’s selected window really does trim rows off the front', before.length > 0, String(before.length));
  // Rendered, not inferred: the tile must show that row's balance under
  // the selected window's own start date.
  TD.render();
  const figuresHtml = (globalThis as Any).document.getElementById('figures').innerHTML
  okE('the tile is headed "Starting balance", not "opening figure"', /<dt>Starting balance<\/dt>/.test(figuresHtml), figuresHtml.slice(0, 120));
  okE('and carries the date of the window being viewed', figuresHtml.includes(TD.shortDate(selBounds.start) + ', before the first row'),
      figuresHtml.slice(0, 160));
  okE('and shows the balance after the last row before that window',
      figuresHtml.includes(TD.money(before[before.length - 1].balance)),
      'expected ' + TD.money(before[before.length - 1].balance));
  okE('which is genuinely NOT the full range’s opening figure, so this is not vacuous',
      before[before.length - 1].balance !== card2.openingBalance,
      'they coincide');
  TD.state.range = 'full';

  /* 🚨 THE STARTING BALANCE RECONCILES INSIDE THE DOCUMENT.
     Adam's whole reason for asking for it (2026-09-24): a figure you can
     check by adding up the rows in front of you, without reference to the
     app or to anything else. So that is asserted, not just labelled.

     Cash cards only. A LOAN folds by capital, not by cash (the capital-folding rule), and a
     CREDIT CARD's balance is its own replay through cardBalanceAsOf
     because interest has no row of its own to fold — so on those two,
     "start + amounts" deliberately does NOT equal the closing figure, and
     asserting that it did would be asserting a bug. */
  for (const range of ['full', 'selected']) {
    TD.state.range = range;
    for (const c of TD.CARDS.filter((x: Any) => ['personal', 'joint', 'pot', 'savings_pot'].indexOf(x.kind) !== -1)) {
      const rs = TD.rowsFor(c, { showCleared: true, range });
      if (!rs.length) continue;
      const start = c.rows.filter((r: Any) => r.date < TD.windowBounds(range).start).slice(-1)[0];
      const opening = start ? start.balance : c.openingBalance;
      const sum = rs.reduce((a: number, r: Any) => a + r.amount, 0);
      const closing = rs[rs.length - 1].balance;
      okE(range + ' · ' + c.id + ': starting balance + every row = the closing figure',
          Math.abs(opening + sum - closing) < 0.005,
          opening + ' + ' + sum.toFixed(2) + ' = ' + (opening + sum).toFixed(2) + ', closing ' + closing);
    }
  }
  TD.state.range = 'full';

  if (fe) { console.log('\n' + fe + ' FAILED'); process.exitCode = 1; }
  else console.log('\nSECTION 19 ALL PASS');
}

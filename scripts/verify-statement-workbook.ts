// The statement's Excel export says exactly what the statement says.
//
// THE BUG THIS PREVENTS: a spreadsheet export is the obvious place for a
// second engine to creep in — a "quick" re-fold of amounts into a balance
// column, a date written from a local-time Date that lands a BST row on the
// day before, a sheet that silently drops the rows of a card whose label
// Excel refuses. Every one of those produces a workbook that opens cleanly
// and looks right while disagreeing with the app about real money.
//
// So this reads the .xlsx BYTES back — unzips them, parses every part as
// XML — and compares every row of every sheet against the statement
// payload the HTML file is built from: the same row count, the same dates,
// the same amounts and balances to the penny, and nothing else (no totals,
// no bands). It runs on the fictional statement fixture and on three real
// backups, read from the tracking folder and never copied into the repo.
// A control tampers one balance and proves the comparison can fail.

import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { JSDOM } from 'jsdom'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { buildStatementDetail, buildStatementPayload, type StatementDetail } from '../src/lib/statement'
import { excelSerial, renderXlsx, sheetName, statementWorkbookSheets, type WorkbookSheet } from '../src/lib/statementWorkbook'
import { ASOF, statementFixture } from './statementFixture'

let failures = 0
function ok(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? '✓' : '✗'} ${label}${!pass && detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

const parser = new new JSDOM('').window.DOMParser()
function parseXml(s: string): Document {
  return parser.parseFromString(s, 'application/xml')
}
const isWellFormed = (s: string) => parseXml(s).getElementsByTagName('parsererror').length === 0

interface ReadSheet {
  name: string
  rows: { cells: Map<string, { v: string | null; t: string | null; text: string | null; s: string | null }> }[]
}

/** Unzip and read every sheet back, the way a spreadsheet would. */
function readWorkbook(bytes: Uint8Array): { parts: Record<string, string>; sheets: ReadSheet[] } {
  const zip = unzipSync(bytes)
  const parts: Record<string, string> = {}
  for (const [k, v] of Object.entries(zip)) parts[k] = strFromU8(v)
  const wb = parseXml(parts['xl/workbook.xml'])
  const sheets = Array.from(wb.getElementsByTagName('sheet')).map((el, i) => {
    const doc = parseXml(parts[`xl/worksheets/sheet${i + 1}.xml`])
    const rows = Array.from(doc.getElementsByTagName('row')).map((r) => {
      const cells = new Map<string, { v: string | null; t: string | null; text: string | null; s: string | null }>()
      for (const c of Array.from(r.getElementsByTagName('c'))) {
        const col = c.getAttribute('r')!.replace(/\d+$/, '')
        cells.set(col, {
          v: c.getElementsByTagName('v')[0]?.textContent ?? null,
          t: c.getAttribute('t'),
          s: c.getAttribute('s'),
          text: c.getElementsByTagName('t')[0]?.textContent ?? null,
        })
      }
      return { cells }
    })
    return { name: el.getAttribute('name')!, rows }
  })
  return { parts, sheets }
}

/** Header → column letter, from the sheet's own first row. */
function headerIndex(sheet: ReadSheet): Map<string, string> {
  const m = new Map<string, string>()
  for (const [col, cell] of sheet.rows[0].cells) m.set(cell.text ?? '', col)
  return m
}

/** Every disagreement between the workbook and the payload it came from. Empty = they agree. */
function compare(detail: StatementDetail, bytes: Uint8Array): string[] {
  const problems: string[] = []
  const { sheets } = readWorkbook(bytes)
  const { cards } = detail.payload
  if (sheets.length !== cards.length) problems.push(`${sheets.length} sheets for ${cards.length} cards`)
  cards.forEach((card, i) => {
    const sheet = sheets[i]
    if (!sheet) return
    const h = headerIndex(sheet)
    const col = (name: string) => h.get(name)!
    if (sheet.rows.length !== card.rows.length + 1) problems.push(`${card.label}: ${sheet.rows.length - 1} rows for ${card.rows.length}`)
    card.rows.forEach((row, j) => {
      const cells = sheet.rows[j + 1]?.cells
      if (!cells) return
      const num = (c: string) => (cells.get(c)?.v == null ? null : Number(cells.get(c)!.v))
      const where = `${card.label} row ${j + 2}`
      if (num(col('Date')) !== excelSerial(row.date)) problems.push(`${where}: date ${num(col('Date'))} ≠ ${row.date}`)
      if (num(col('Amount')) !== row.amount) problems.push(`${where}: amount ${num(col('Amount'))} ≠ ${row.amount}`)
      if (num(col(card.balanceLabel)) !== row.balance) problems.push(`${where}: balance ${num(col(card.balanceLabel))} ≠ ${row.balance}`)
      if ((cells.get(col('Description'))?.text ?? '') !== row.description) problems.push(`${where}: description`)
      if (num(col('Capital')) !== row.capital || num(col('Interest')) !== row.interest) problems.push(`${where}: capital/interest`)
    })
  })
  return problems
}

const iso = (serial: number) => new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10)

// ── 1. Dates ──────────────────────────────────────────────────────────
console.log('\n1. DATES: a real Excel date, on the right day, in summer and winter')
ok('2026-01-01 is serial 46023 (Excel\'s own number for it)', excelSerial('2026-01-01') === 46023, String(excelSerial('2026-01-01')))
ok('a BST date round-trips to itself (no slip to the day before)', iso(excelSerial('2026-07-15')) === '2026-07-15', iso(excelSerial('2026-07-15')))
ok('a GMT date round-trips to itself', iso(excelSerial('2026-12-25')) === '2026-12-25')
ok('the BST/GMT changeover day round-trips', iso(excelSerial('2026-10-25')) === '2026-10-25')

// ── 2. Sheet names ────────────────────────────────────────────────────
console.log('\n2. SHEET NAMES: ones Excel accepts, and never two the same')
{
  const taken = new Set<string>()
  const a = sheetName('Bills', taken)
  const b = sheetName('bills', taken)
  const c = sheetName('Pot [old]: a/b?*', taken)
  const d = sheetName('x'.repeat(40), taken)
  const e = sheetName('x'.repeat(40), taken)
  ok('a duplicate label (ignoring case) gets " (2)"', a === 'Bills' && b === 'bills (2)', `${a} / ${b}`)
  ok('[ ] : * ? / \\ are removed', !/[[\]:*?/\\]/.test(c), c)
  ok('at most 31 characters, even with a suffix', d.length === 31 && e.length === 31 && d !== e, `${d.length} ${e}`)
}

// ── 3. The fixture, cell by cell ──────────────────────────────────────
console.log('\n3. THE FIXTURE: every row, every figure, against the payload')
const range = { selectedStart: '2026-09-14', selectedEnd: '2026-11-13', asOfDate: ASOF }
const fixtureDetail = buildStatementDetail(statementFixture(), range)
const fixtureBytes = renderXlsx(statementWorkbookSheets(fixtureDetail))
{
  ok('the HTML payload is unchanged by carrying details beside it', JSON.stringify(buildStatementPayload(statementFixture(), range)) === JSON.stringify(fixtureDetail.payload))
  ok('one detail per row, on every card', fixtureDetail.payload.cards.every((c, i) => fixtureDetail.details[i].length === c.rows.length))
  const { parts, sheets } = readWorkbook(fixtureBytes)
  ok('every part is well-formed XML', Object.entries(parts).every(([, v]) => isWellFormed(v)), Object.keys(parts).filter((k) => !isWellFormed(parts[k])).join(', '))
  ok('one sheet per statement card', sheets.length === fixtureDetail.payload.cards.length && sheets.length > 1, `${sheets.length}`)
  ok('each sheet is named after its card', sheets.every((s, i) => s.name === fixtureDetail.payload.cards[i].label), sheets.map((s) => s.name).join(', '))
  const problems = compare(fixtureDetail, fixtureBytes)
  ok('every row agrees with the payload (date, amount, balance, description, split)', problems.length === 0, problems.slice(0, 3).join('; '))
  const rowCount = fixtureDetail.payload.cards.reduce((n, c) => n + c.rows.length, 0)
  ok('nothing but a header and the transactions — no totals, no bands', sheets.reduce((n, s) => n + s.rows.length, 0) === rowCount + sheets.length)
  ok('every data row is dated', sheets.every((s) => s.rows.slice(1).every((r) => r.cells.get('A')?.v != null && r.cells.get('A')?.s === '2')))
  ok('the same data gives the same bytes', Buffer.from(renderXlsx(statementWorkbookSheets(buildStatementDetail(statementFixture(), range)))).equals(Buffer.from(fixtureBytes)))
}

// ── 4. Text that could break the file ─────────────────────────────────
console.log('\n4. TEXT: a note that is markup, or holds a control character')
{
  const nasty = 'Tom & Jerry <b>"lunch"</b>\u0001 £5'
  const sheet: WorkbookSheet = { name: 'A & B', headers: ['Note'], widths: [10], rows: [[{ kind: 'text', value: nasty }]] }
  const { parts, sheets } = readWorkbook(renderXlsx([sheet]))
  ok('still well-formed', isWellFormed(parts['xl/worksheets/sheet1.xml']) && isWellFormed(parts['xl/workbook.xml']))
  ok('reads back as the text, minus the control character', sheets[0].rows[1].cells.get('A')?.text === nasty.replace('\u0001', ''), sheets[0].rows[1].cells.get('A')?.text ?? '')
  ok('the sheet name with & survives', sheets[0].name === 'A & B')
}

// ── 5. Real backups ───────────────────────────────────────────────────
console.log('\n5. REAL FILES: three backups, full cycles June 2026 – January 2027')
const F = '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/fixtures/'
const asOf = new Date(2026, 9, 8, 12)
for (const f of ['finance-ledger-backup-2026-09-22-PROD.json', 'finance-ledger-backup-2026-10-05-mum.json', 'finance-ledger-backup-2026-10-06-mum.json']) {
  const raw = JSON.parse(readFileSync(F + f, 'utf8'))
  const data = migrateLedgerData(raw.data ?? raw)
  const detail = buildStatementDetail(data, { selectedStart: '2026-06-01', selectedEnd: '2027-01-31', asOfDate: asOf })
  const bytes = renderXlsx(statementWorkbookSheets(detail))
  const problems = compare(detail, bytes)
  const rows = detail.payload.cards.reduce((n, c) => n + c.rows.length, 0)
  ok(`${f}: ${detail.payload.cards.length} sheets, ${rows} rows agree`, problems.length === 0 && rows > 0, problems.slice(0, 3).join('; '))
  const { parts } = readWorkbook(bytes)
  ok(`${f}: every part is well-formed XML`, Object.values(parts).every(isWellFormed))
  const flat = detail.details.flat()
  const transfers = flat.filter((d) => d.type === 'Transfer')
  ok(`${f}: every transfer row names both ends (${transfers.length})`, transfers.every((d) => d.from !== '' && d.to !== ''))
  ok(`${f}: every row says what it is and where it came from`, flat.every((d) => d.type !== '' && d.source !== ''))
}

// ── 6. Control ────────────────────────────────────────────────────────
console.log('\n6. CONTROL: a workbook one penny out is caught')
{
  const tampered = structuredClone(fixtureDetail)
  const card = tampered.payload.cards[0]
  card.rows[card.rows.length - 1].balance = Math.round((card.rows[card.rows.length - 1].balance + 0.01) * 100) / 100
  const problems = compare(fixtureDetail, renderXlsx(statementWorkbookSheets(tampered)))
  ok('the comparison reports the moved balance', problems.length === 1 && problems[0].includes('balance'), problems.join('; '))
  const dropped = structuredClone(fixtureDetail)
  dropped.payload.cards[0].rows.pop()
  dropped.details[0].pop()
  ok('…and a dropped row', compare(fixtureDetail, renderXlsx(statementWorkbookSheets(dropped))).some((p) => p.includes('rows for')))
}

console.log(failures === 0 ? '\nALL PASS' : `\nFAIL: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)

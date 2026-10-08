// The statement as an Excel workbook: one sheet per statement card, one row
// per transaction, every column the app holds on it. A flat ledger for
// sorting and filtering in a spreadsheet — no totals, no subtotals, no
// bands, no highlighting.
//
// 🚨 THIS IS A THIRD DESTINATION FOR THE SAME ROWS, NOT A THIRD ENGINE.
// Every row and every figure comes from buildStatementDetail — the same
// build the HTML file is rendered from — so the workbook, the file and the
// Home cards agree by construction. Nothing here sums, folds or re-derives
// a balance; the Balance column is the row's own running balance, exactly
// as the statement prints it. See TECHNICAL.md §"The cycle statement".
//
// The .xlsx is written by hand: a handful of SpreadsheetML parts zipped
// with fflate. A spreadsheet library would add hundreds of kilobytes to an
// app that only ever WRITES one simple shape of sheet, and personal-ledger
// is offline, so whatever is used has to be bundled. Plain tsx can run
// all of this, which is what lets verify-statement-workbook.ts read the
// bytes back.

import { strToU8, zipSync } from 'fflate'
import type { AppDataV2 } from '../types/ledger'
import { buildStatementDetail, type StatementDetail, type StatementOptions, type StatementRow, type StatementRowDetail } from './statement'

type Cell = { kind: 'date'; iso: string } | { kind: 'money'; value: number | null } | { kind: 'text'; value: string }

interface Column {
  header: string
  width: number
  cell: (row: StatementRow, detail: StatementRowDetail) => Cell
}

export interface WorkbookSheet {
  name: string
  headers: string[]
  widths: number[]
  rows: Cell[][]
}

const text = (value: string): Cell => ({ kind: 'text', value })
const money = (value: number | null): Cell => ({ kind: 'money', value })

/**
 * The columns, in order. The Balance column's heading is the card's own
 * (`Balance`, `Pot balance`, `Owed`, `Card balance`), so it is filled in
 * per sheet.
 */
function columns(cycleLabels: Map<string, string>, balanceLabel: string): Column[] {
  return [
    { header: 'Date', width: 12, cell: (r) => ({ kind: 'date', iso: r.date }) },
    { header: 'Cycle', width: 24, cell: (r) => text(cycleLabels.get(r.cycle) ?? '') },
    { header: 'Description', width: 28, cell: (r) => text(r.description) },
    { header: 'Category', width: 18, cell: (r) => text(r.category) },
    { header: 'Type', width: 18, cell: (_r, d) => text(d.type) },
    { header: 'Direction', width: 10, cell: (r) => text(r.direction === 'in' ? 'In' : 'Out') },
    { header: 'Amount', width: 12, cell: (r) => money(r.amount) },
    { header: balanceLabel, width: 13, cell: (r) => money(r.balance) },
    { header: 'Status', width: 13, cell: (r) => text(r.status === 'cleared' ? 'Cleared' : 'Still to come') },
    { header: 'Payment method', width: 15, cell: (_r, d) => text(d.paymentMethod) },
    { header: 'Payee', width: 18, cell: (_r, d) => text(d.payee) },
    { header: 'Note', width: 24, cell: (_r, d) => text(d.note) },
    { header: 'Owner', width: 12, cell: (_r, d) => text(d.owner) },
    { header: 'From', width: 18, cell: (_r, d) => text(d.from) },
    { header: 'To', width: 18, cell: (_r, d) => text(d.to) },
    { header: 'Linked to', width: 22, cell: (_r, d) => text(d.linkedTo) },
    { header: 'Source', width: 18, cell: (_r, d) => text(d.source) },
    { header: 'Capital', width: 11, cell: (r) => money(r.capital) },
    { header: 'Interest', width: 11, cell: (r) => money(r.interest) },
    { header: 'Rounded up from', width: 15, cell: (_r, d) => money(d.roundedFrom) },
  ]
}

/**
 * A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`, not
 * starting or ending with an apostrophe, and unique ignoring case. Two
 * cards can share a label (two pots both called "Bills"), and Excel refuses
 * the whole file over a duplicate, so the second gets " (2)".
 */
export function sheetName(label: string, taken: Set<string>): string {
  const base = (label.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '') || 'Sheet').slice(0, 31)
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  taken.add(name.toLowerCase())
  return name
}

/** Every card's rows, in the statement's own order, as sheets. Rows outside "Full cycles" do not exist in the payload, so the sheet covers exactly the full cycles the picker chose. */
export function statementWorkbookSheets({ payload, details }: StatementDetail): WorkbookSheet[] {
  const cycleLabels = new Map(payload.meta.cycles.map((c) => [c.key, c.label]))
  const taken = new Set<string>()
  return payload.cards.map((card, i) => {
    const cols = columns(cycleLabels, card.balanceLabel || 'Balance')
    return {
      name: sheetName(card.label, taken),
      headers: cols.map((c) => c.header),
      widths: cols.map((c) => c.width),
      rows: card.rows.map((row, j) => cols.map((c) => c.cell(row, details[i][j]))),
    }
  })
}

// ── SpreadsheetML ─────────────────────────────────────────────────────

/** XML text, with the control characters XML 1.0 cannot carry removed — a pasted note can contain one, and a single one makes Excel refuse the file. */
function xml(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** Column letter for a 0-based index: 0 → A, 25 → Z, 26 → AA. */
function colLetter(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/**
 * An ISO date as an Excel serial day number (days since 30 Dec 1899), so the
 * column is a real date that sorts and filters as one. Computed in UTC from
 * the date's own digits: a local-time Date would shift by the UTC offset and
 * land a BST date on the day before.
 */
export function excelSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86400000 + 25569
}

// Style indexes into styles.xml's cellXfs, in order.
const STYLE_HEADER = 1
const STYLE_DATE = 2
const STYLE_MONEY = 3

function cellXml(cell: Cell, ref: string): string {
  switch (cell.kind) {
    case 'date':
      return `<c r="${ref}" s="${STYLE_DATE}"><v>${excelSerial(cell.iso)}</v></c>`
    case 'money':
      return cell.value === null ? '' : `<c r="${ref}" s="${STYLE_MONEY}"><v>${cell.value}</v></c>`
    case 'text':
      return cell.value === '' ? '' : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`
  }
}

function sheetXml(sheet: WorkbookSheet): string {
  const lastCol = colLetter(sheet.headers.length - 1)
  const head = `<row r="1">${sheet.headers.map((h, i) => `<c r="${colLetter(i)}1" s="${STYLE_HEADER}" t="inlineStr"><is><t>${xml(h)}</t></is></c>`).join('')}</row>`
  const body = sheet.rows.map((cells, r) => `<row r="${r + 2}">${cells.map((c, i) => cellXml(c, `${colLetter(i)}${r + 2}`)).join('')}</row>`).join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    // The header row stays put while the ledger scrolls beneath it.
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${head}${body}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}${sheet.rows.length + 1}"/>` +
    '</worksheet>'
  )
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="d mmm yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00;-#,##0.00"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>'

/** The .xlsx bytes: a zip of the parts Excel, Numbers and Google Sheets need, and nothing else. */
export function renderXlsx(sheets: WorkbookSheet[]): Uint8Array {
  const n = sheets.length
  const ids = sheets.map((_, i) => i + 1)
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        ids.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        // Each sheet's autofilter needs its defined name, or Excel repairs the file on opening.
        `<definedNames>${sheets.map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(s.name.replace(/'/g, "''"))}'!$A$1:$${colLetter(s.headers.length - 1)}$${s.rows.length + 1}</definedName>`).join('')}</definedNames>` +
        '</workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        ids.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('') +
        `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES_XML),
  }
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))
  })
  // A fixed timestamp: two workbooks built from the same data are the same bytes.
  return zipSync(files, { level: 6, mtime: new Date(2026, 0, 1) })
}

/** `finance-ledger-statement-2026-09-14-to-2026-11-13.xlsx` — the HTML file's name with the workbook's extension. */
export function statementWorkbookFilename(detail: StatementDetail): string {
  return `finance-ledger-statement-${detail.payload.meta.selectedStart}-to-${detail.payload.meta.selectedEnd}.xlsx`
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Build the workbook in one step. */
export function buildStatementWorkbook(data: AppDataV2, options: StatementOptions): { bytes: Uint8Array; filename: string } {
  const detail = buildStatementDetail(data, options)
  return { bytes: renderXlsx(statementWorkbookSheets(detail)), filename: statementWorkbookFilename(detail) }
}

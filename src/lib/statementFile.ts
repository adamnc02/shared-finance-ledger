// Handing the generated statement to the phone.
//
// This file is the Vite-only half: it imports the template with `?raw`
// (inlined at build time — never fetched, because personal-ledger is
// permanently offline and T5 allows no network at all) and hands the
// result to the share path. Everything testable lives in statement.ts,
// which runs under plain `tsx`.
//
// See TECHNICAL.md §"The cycle statement".

import templateHtml from '../statement/statement-template.html?raw'
import type { AppDataV2 } from '../types/ledger'
import { buildStatementPayload, renderStatementHtml, statementFilename, type StatementOptions } from './statement'
import { shareOrDownloadFile } from './ledgerStorage'

/** The template as it ships in the repo. */
export function statementTemplate(): string {
  return templateHtml
}

/**
 * Build the statement once: the exact bytes that get both shown in the
 * app and saved to a file.
 *
 * 🚨 One render, two destinations. Generating separately for the viewer
 * and for the download would be two chances to differ, on the one
 * artefact whose entire value is that its figures are right.
 */
export function buildCycleStatement(data: AppDataV2, options: StatementOptions): { html: string; filename: string } {
  const payload = buildStatementPayload(data, options)
  return { html: renderStatementHtml(payload, templateHtml), filename: statementFilename(payload) }
}

/**
 * Hand a built statement to the Share Sheet (or a plain download where
 * sharing files is not available) — the same path a backup takes, reused
 * rather than reimplemented.
 */
export async function shareCycleStatement(statement: { html: string; filename: string }): Promise<void> {
  await shareOrDownloadFile(statement.html, statement.filename, 'text/html')
}

/** Build and share in one step, for anywhere that wants the file and not the viewer. */
export async function downloadCycleStatement(data: AppDataV2, options: StatementOptions): Promise<void> {
  await shareCycleStatement(buildCycleStatement(data, options))
}

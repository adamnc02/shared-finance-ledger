import { formatCurrency } from '../lib/format'
import { RAG_ROW_LABELS, RAG_SEGMENT_COLORS, type RagProgress } from '../lib/progressSection'

/**
 * PROMPT-13 Part A2 — the legend table that sits ABOVE each loan RAG
 * ring, explaining the three segments in cash.
 *
 * Adam's spec, verbatim (2026-09-20): "rounded square colour icons as
 * column 1, col 2 is status (paid, projected or remaining), col 3 is
 * balance, col 4 is delta, and col 5 is %. there should be no vertical
 * gridlines in the table, only horizontal."
 *
 * 🚨 THE NUMBERS HERE ARE NOT THE SEGMENT SIZES, AND THE `%` COLUMN DOES
 * NOT SUM TO 100. On Adam's worked example the ring's arcs are
 * 40% / 15% / 45% while this table reads 40% / 55% / 45% — 140% in total,
 * deliberately. Each row's `%` is that row's own balance as a share of
 * the loan's amortised total, because the table's job is to explain the
 * balances printed next to it. Likewise only the Projected row carries a
 * delta; Paid and Remaining both read an em dash. All of it is settled
 * (PROMPT-13 §0 Q1 and Q2, 2026-09-20) and all of it is computed in
 * `ragProgress` — this component only renders what it is handed, so
 * there is nothing here for the sweep to miss. **Do not "fix" the 140%.**
 */
export function RagLegend({ progress }: { progress: RagProgress }) {
  return (
    <table className="w-full border-collapse tabular-nums" style={{ fontSize: 12 }}>
      <tbody>
        {progress.rows.map((row, i) => (
          <tr
            key={row.kind}
            style={{
              // Horizontal rules only — no vertical gridlines anywhere,
              // per the spec. The last row carries no bottom border so
              // the table doesn't close with a line the ring then sits
              // under.
              borderBottom: i === progress.rows.length - 1 ? undefined : '1px solid var(--color-track)',
            }}
          >
            <td style={{ padding: '7px 0', width: 22 }}>
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  borderRadius: 3, // "rounded square colour icons"
                  background: RAG_SEGMENT_COLORS[row.kind],
                }}
              />
            </td>
            <td className="text-left text-[var(--color-ink-muted)]" style={{ padding: '7px 8px 7px 0' }}>
              {RAG_ROW_LABELS[row.kind]}
            </td>
            <td className="text-right font-semibold text-[var(--color-ink)]" style={{ padding: '7px 8px 7px 0' }}>
              £{formatCurrency(row.balance)}
            </td>
            <td className="text-right text-[var(--color-ink-muted)]" style={{ padding: '7px 8px 7px 0' }}>
              {/* An em dash on Paid and Remaining is the ANSWER, not a
                  placeholder for a figure that could not be worked out
                  (§0 Q2). */}
              {row.delta === undefined ? '—' : `+£${formatCurrency(row.delta)}`}
            </td>
            <td className="text-right text-[var(--color-ink-muted)]" style={{ padding: '7px 0', width: 44 }}>
              {Math.round(row.percent)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

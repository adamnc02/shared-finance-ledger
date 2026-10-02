/**
 * "Whose is this?" — a small pill naming the person a row belongs to.
 *
 * It exists because of page-level household visibility (lib/householdView.ts):
 * those pages hide the other person's rows, but JOINT rows stay visible to
 * everyone, so on a shared page a transfer in or out of the joint account may
 * well be theirs with nothing to say so.
 *
 * Shown ONLY when the row is someone else's. A badge on every row would put
 * the viewer's own name on almost all of them, which is noise — the same rule
 * the Bills page's "Joint" and pot pills follow: a badge marks the exception.
 * No badge therefore means "mine", and with one person in the app no badge
 * ever renders.
 *
 * Neutral outlined, matching those bill pills exactly rather than filling with
 * `Person.color`: that field is not used as an identity colour anywhere else in
 * the app, so white-on-whatever-it-holds would be an untested contrast gamble,
 * and an outlined pill reads against any background.
 */
export function OwnerBadge({ name }: { name: string }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0"
      style={{ background: 'var(--color-surface-raised)', border: '1px solid var(--color-track)', color: 'var(--color-ink-muted)' }}
    >
      {name}
    </span>
  )
}

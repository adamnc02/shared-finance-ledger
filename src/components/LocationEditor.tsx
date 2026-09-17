import { SplitEditor } from './SplitEditor'
import type { BillLocation } from '../types/models'
import type { Pot } from '../types/ledger'

/**
 * The "Joint" option is only shown once a second person exists AND that
 * second person actually has a salary configured — with only one real
 * income there is nothing to split a joint item against, so offering it
 * was a real bug (doc feedback: "I can still see the option to select
 * joint account even with only one salary"). `canBeJoint` is computed by
 * the caller (who has access to the full Person list with salaryHistory,
 * or the legacy equivalent) via `hasSalaryConfigured`/`peopleWithSalaryCount`
 * in lib/household.ts, rather than derived here from a narrowed
 * `{id, name}[]` shape that can't see salary data.
 *
 * If the location was somehow already 'joint' (e.g. the second person or
 * their salary was later removed), this still displays the current value
 * correctly but the select won't offer switching back to it as a fresh
 * choice — onChange's caller should ideally have migrated it back to
 * 'personal' at that point (see LedgerContext.removePerson, which doesn't
 * currently reassign existing joint items — a known follow-up).
 *
 * With one salary configured, `canBeJoint` is false and there's only one
 * person to own anything anyway — the whole "Location" concept is moot,
 * not just the Joint option within it. This renders nothing at all in
 * that case, rather than a "Personal (add a second person's salary...)"
 * placeholder: a field with a single, unchangeable, unexplained value is
 * not useful information, it's just noise on a form for something that
 * hasn't happened yet.
 *
 * "Pot" (Pots backlog item, 2026-09 session) follows the same instinct —
 * only offered once the CURRENT owner actually has at least one pot,
 * recomputed live off `pots`/`ownerId` rather than a static flag, since
 * unlike joint-ness it can change mid-edit as the owner picker itself is
 * touched. IMPORTANT: this component only ever hands back a plain patch —
 * for a bill/loan that's being EDITED (as opposed to freshly created,
 * where there's nothing to retroactively touch), the caller must NOT feed
 * a location/potId change straight into a plain field-merge the way every
 * other field here works. Adam's own spec requires an effective-date step
 * and a retroactive rewrite of existing transactions (lib/locationChange.ts)
 * — see BillEditPanel/LoanEditPanel's own handling of this patch for the
 * real flow; this component stays a dumb, uncommitted draft editor
 * exactly like every field around it, on purpose.
 */
export function LocationEditor({
  people,
  pots,
  canBeJoint,
  location,
  ownerId,
  potId,
  payee,
  payeeSharePercent,
  onChange,
}: {
  people: { id: string; name: string }[]
  pots: Pot[]
  canBeJoint: boolean
  location: BillLocation
  ownerId: string
  potId?: string
  payee: string
  payeeSharePercent: number
  onChange: (patch: { location: BillLocation; ownerId?: string; potId?: string; payee?: string; payeeSharePercent?: number }) => void
}) {
  const ownerPots = pots.filter((p) => p.personId === ownerId)
  const canBePot = ownerPots.length > 0

  const showLocationField = canBeJoint || canBePot
  const showOwnerField = (location === 'personal' || location === 'pot') && people.length > 1
  const showSplitEditor = location === 'joint' && canBeJoint

  if (!showLocationField && !showOwnerField && !showSplitEditor) return null

  // Batch 3 (2026-09-04 UAT): "Location" and "Pot" used to be two
  // separate selects (pick Pot, then a second dropdown appears to pick
  // WHICH pot) — flattened into one flat list, matching the picker-first
  // creation flow's own already-flat design (Personal, Joint, then each
  // pot individually by name — lib/pickerFirst.ts's shouldOfferLocationPicker
  // comment/App_Dev.md's "Location is one flat list" decision). Picking a
  // pot by name sets location:'pot' + potId in one tap, no second step.
  const flatValue = location === 'pot' ? `pot:${potId && ownerPots.some((p) => p.id === potId) ? potId : ownerPots[0]?.id ?? ''}` : location

  return (
    <div className="grid grid-cols-2 gap-3">
      {showLocationField && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Location</span>
          <select
            value={flatValue}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === 'joint') onChange({ location: 'joint', payee: payee || people[0]?.id || '', potId: undefined })
              else if (raw.startsWith('pot:')) onChange({ location: 'pot', ownerId: ownerId || people[0]?.id || '', potId: raw.slice('pot:'.length) })
              else onChange({ location: 'personal', ownerId: ownerId || people[0]?.id || '', potId: undefined })
            }}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            <option value="personal" style={{ color: '#000' }}>
              Personal
            </option>
            {canBeJoint && (
              <option value="joint" style={{ color: '#000' }}>
                Joint
              </option>
            )}
            {ownerPots.map((p) => (
              <option key={p.id} value={`pot:${p.id}`} style={{ color: '#000' }}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {showOwnerField && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Owner</span>
          <select
            value={ownerId}
            onChange={(e) => {
              const nextOwner = e.target.value
              // Changing the owner while location: 'pot' can strand
              // potId pointing at a pot that belongs to the OLD owner —
              // pots are single-person by construction, so re-point at
              // the new owner's first pot (if they have one) rather than
              // leaving a cross-owner reference dangling. If the new
              // owner has no pots at all, LocationEditor's own re-render
              // will naturally stop showing the Pot field at all next
              // paint (canBePot recomputes off the new ownerId) — the
              // caller's next real save should route through the same
              // location-reassignment flow as any other location change,
              // since this is genuinely changing where the bill is paid
              // from, not just relabelling who it belongs to.
              const nextOwnerPots = pots.filter((p) => p.personId === nextOwner)
              onChange({ location, ownerId: nextOwner, potId: location === 'pot' ? nextOwnerPots[0]?.id : potId })
            }}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id} style={{ color: '#000' }}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {showSplitEditor && (
        <SplitEditor
          people={people}
          payee={payee || people[0]?.id || ''}
          percent={payeeSharePercent}
          onChangePayee={(p) => onChange({ location, payee: p })}
          onChangePercent={(pct) => onChange({ location, payeeSharePercent: pct })}
        />
      )}
    </div>
  )
}

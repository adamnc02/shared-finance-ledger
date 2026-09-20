// SYNC APP ONLY. A same-named person left behind by a household join
// (PROMPT-10 Part 4; personal-f's DuplicatePersonBanner, rewired).
//
// redeem_household_link_code reports (never merges) an unlinked person in the
// new household whose name matches the joiner's — Adam's guess of "Ella"
// before she ever signed in. The id comes back as duplicate_person_id and is
// kept on this device until it is dealt with here.
//
// Merging goes through the app's OWN delete-reassign flow (DeleteGuardModal,
// PROMPT-05): everything still pointing at the duplicate has to be moved or
// deleted first, deliberately, and only then is the row removed. That is the
// tested path for this, and it means no second merge implementation.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, X } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { DeleteGuardModal } from './DeleteGuardModal'
import { duplicatePersonKey } from '../lib/powersync/linking'

export function DuplicatePersonBanner({ userId }: { userId: string }) {
  const { data, removePerson } = useLedgerData()
  const [duplicateId, setDuplicateId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(duplicatePersonKey(userId))
    } catch {
      return null
    }
  })
  const [dismissed, setDismissed] = useState(false)
  const [resolving, setResolving] = useState(false)

  const forget = () => {
    try {
      localStorage.removeItem(duplicatePersonKey(userId))
    } catch {
      /* ignore */
    }
    setDuplicateId(null)
  }

  const duplicate = duplicateId ? data.people.find((p) => p.id === duplicateId) : undefined
  const me = data.people.find((p) => p.id === data.primaryPersonId)
  // Gone already (merged here, or removed on the other device): nothing to say.
  if (duplicateId && !duplicate) {
    forget()
    return null
  }
  if (!duplicate || dismissed || duplicate.id === data.primaryPersonId) return null

  return (
    <>
      {createPortal(
        <div className="fixed left-0 right-0 z-[9000] px-4" style={{ top: 'calc(var(--safe-top, 0px) + 8px)' }}>
          <div className="max-w-md mx-auto flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg" style={{ borderColor: 'var(--color-coral)', background: 'var(--color-surface)' }}>
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[var(--color-coral)]" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--color-ink)]">
                "{duplicate.name}" was already in this household
              </p>
              <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                It looks like someone's guess of you, made before you joined{me ? `, and you are now "${me.name}"` : ''}. Move anything on it to your
                own person, then remove it. Nothing joint is affected.
              </p>
              <div className="flex gap-2 mt-2">
                <button onClick={() => setResolving(true)} className="text-xs font-semibold px-3 py-1.5 rounded-full bg-[var(--color-ink)] text-[var(--color-surface)]">
                  Review and remove
                </button>
                <button onClick={forget} className="text-xs font-medium px-3 py-1.5 rounded-full text-[var(--color-ink-muted)]">
                  Not a duplicate
                </button>
              </div>
            </div>
            <button onClick={() => setDismissed(true)} aria-label="Dismiss for now" className="shrink-0">
              <X size={16} className="text-[var(--color-ink-muted)]" />
            </button>
          </div>
        </div>,
        document.body,
      )}
      {resolving && (
        <DeleteGuardModal
          subject={{ type: 'person', id: duplicate.id }}
          name={duplicate.name}
          description={`Remove "${duplicate.name}"? Nothing points at this person any more.`}
          onConfirm={() => {
            removePerson(duplicate.id)
            setResolving(false)
            forget()
          }}
          onCancel={() => setResolving(false)}
        />
      )}
    </>
  )
}

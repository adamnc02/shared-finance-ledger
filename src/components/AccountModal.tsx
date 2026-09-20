// SYNC APP ONLY. The Account modal (PROMPT-10 Part 5): personal-f's
// AccountModal (main 90794ea), rewired to this app, plus what this app adds.
//
//   - identity + provider; Change password for email accounts only (an
//     OAuth account has no app password: personal-f / BLOC);
//   - sync status, Force Sync (Adam, 2026-09-19: no pull-to-refresh), and
//     the rejected-writes line, always shown ("No changes rejected by the
//     server ✓" or the list: UAT 2026-09-19);
//   - Household: this household's invite code (show / copy / regenerate),
//     and Join with a code (BUILD-PLAN 4.4: inside this modal, not a
//     separate one). Redeem moves your own data server-side, so this device
//     clears its copy and boots again through the first-sync gate;
//   - Cloud Backup: Back Up Now / Restore (BUILD-PLAN 4.5). Restore replaces
//     the WHOLE HOUSEHOLD's data, so it sits behind a warning that says so
//     (DECISIONS Q9) and goes through the app's normal restore (setData),
//     which the store turns into an id-regenerating import;
//   - Sign out;
//   - Delete my app data (DELETE-APP-DATA-SHARED-FINANCE-LEDGER.md), as built
//     in PROMPT-09: two confirmations, instant, login kept:
//       1. stop syncing and clear this device's copy, upload queue included
//          (so nothing queued can land after the erase);
//       2. remove this user's backup files (SQL can't delete Storage objects);
//       3. erase_my_data(): only member → the household and everything in it;
//          others remain → only your membership, attribution and scenarios;
//       4. clear this app's keys on this device, reload. ensure_household()
//          then makes a new, empty household, and the empty-household screen
//          shows.
// Everything is portalled to document.body (MIGRATION-LESSONS §15).

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloudUpload, Copy, History, RefreshCw, X } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import type { AppDataV2 } from '../types/ledger'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { POWERSYNC_DB_FILENAME, powerSyncDb } from '../lib/powersync/database'
import { clearHouseholdCache } from '../lib/powersync/household'
import { REJECTED_WRITES_KEY, readRejectedWrites } from '../lib/powersync/connector'
import { downloadSnapshot, listSnapshots, removeAllSnapshots, uploadSnapshot, type SnapshotInfo } from '../lib/powersync/backup'
import { duplicatePersonKey, getLinkCode, justJoinedKey, redeemLinkCode, regenerateLinkCode, rememberDuplicate } from '../lib/powersync/linking'
import { legacyOfferedKey } from '../lib/powersync/legacyData'
import { useSyncControls } from './syncControls'

/** personal-f / BLOC: an absent provider IS the email/password signal. */
export function isEmailPasswordAccount(session: Session | null | undefined): boolean {
  if (!session) return false
  return (session.user.app_metadata?.provider || 'email') === 'email'
}

export function providerLabel(session: Session | null | undefined): string {
  if (!session) return ''
  const provider = session.user.app_metadata?.provider || 'email'
  return provider === 'email' ? 'Signed in with email' : `Signed in with ${provider.charAt(0).toUpperCase()}${provider.slice(1)}`
}

function useSyncStatus() {
  const [status, setStatus] = useState(() => powerSyncDb.currentStatus)
  useEffect(() => powerSyncDb.registerListener({ statusChanged: (s) => setStatus(s) }), [])
  return status
}

/** The ledger, when the modal is opened from inside it (the Wallet header). Absent on the boot screens. */
export interface AccountLedger {
  data: AppDataV2
  setData: (data: AppDataV2) => void
}

type Confirm =
  | { kind: 'delete1' }
  | { kind: 'delete2' }
  | { kind: 'regenerate' }
  | { kind: 'join'; code: string }
  | { kind: 'restore'; name: string }

const errorText = (err: unknown) => (err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err))

export function AccountModal({ ledger, onClose }: { ledger?: AccountLedger; onClose: () => void }) {
  const { session, signOut } = useAuth()
  const { userId, email, householdId, restart, forceSync } = useSyncControls()
  const status = useSyncStatus()
  const [rejected, setRejected] = useState(readRejectedWrites)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [changingPassword, setChangingPassword] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null)
  const [restoreOpen, setRestoreOpen] = useState(false)

  useEffect(() => {
    if (!ledger) return
    listSnapshots(userId)
      .then(setSnapshots)
      .catch((err) => console.warn('[backup] could not list snapshots', err))
  }, [ledger, userId])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setNote(null)
    try {
      await fn()
    } catch (err) {
      console.error(`[account] ${label} failed`, err)
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const deleteMyData = () =>
    run('delete', async () => {
      await powerSyncDb.disconnectAndClear()
      await removeAllSnapshots(userId)
      const { data: summary, error: rpcError } = await supabase.rpc('erase_my_data')
      if (rpcError) throw rpcError
      console.info('[account] erase_my_data', summary)
      clearHouseholdCache()
      clearThisAppsKeys(userId)
      window.location.reload()
    })

  const join = (value: string) =>
    run('join', async () => {
      const result = await redeemLinkCode(value)
      console.info('[account] joined a household', result)
      rememberDuplicate(localStorage, userId, result.duplicate_person_id)
      if (!result.brought_own_data) {
        try {
          localStorage.setItem(justJoinedKey(userId), '1')
        } catch {
          /* the "which one is you?" prompt just won't appear */
        }
      }
      onClose()
      restart('Joined the household. Syncing it to this device…')
    })

  const restore = (name: string) =>
    run('restore', async () => {
      if (!ledger) return
      const data = await downloadSnapshot(userId, name)
      ledger.setData(data)
      setRestoreOpen(false)
      setNote(`Restored the backup from ${name.replace('.json', '')}.`)
    })

  const lastSynced = status.lastSyncedAt ? status.lastSyncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not yet'
  const others = ledger ? ledger.data.people.length : 0

  return createPortal(
    <div className="fixed inset-0 z-[10002] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[88vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--safe-bottom, 0px) + 24px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Account</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* Identity */}
        <Card>
          <p className="text-sm font-semibold text-[var(--color-ink)] break-all">{email || '(no email on file)'}</p>
          <p className="text-xs text-[var(--color-ink-muted)]">{providerLabel(session)}</p>
          {isEmailPasswordAccount(session) && (
            <button onClick={() => setChangingPassword(true)} className="mt-2 text-xs font-medium text-[var(--color-coral)]">
              Change password
            </button>
          )}
        </Card>

        {/* Sync */}
        <Card>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-[var(--color-ink-muted)]">
              {status.connected ? 'Connected' : status.connecting ? 'Connecting…' : 'Offline'} · last synced {lastSynced}
              {status.dataFlowStatus?.uploading ? ' · uploading…' : ''}
            </p>
            <button
              onClick={() => void run('sync', async () => {
                await forceSync()
                setNote('Reconnected.')
              })}
              disabled={busy !== null}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full text-[var(--color-ink)] disabled:opacity-60 shrink-0"
              style={{ background: 'var(--color-surface)' }}
            >
              <RefreshCw size={12} className={busy === 'sync' ? 'animate-spin' : ''} />
              {busy === 'sync' ? 'Syncing…' : 'Force Sync'}
            </button>
          </div>
          {rejected.length === 0 ? (
            // Always say it, so "nothing rejected" is visible rather than inferred from an absent box (UAT 2026-09-19 step 10).
            <p className="text-xs text-[var(--color-positive)] mt-2">No changes rejected by the server ✓</p>
          ) : (
            <div className="mt-2">
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className="text-xs font-semibold text-[var(--color-negative)]">
                  {rejected.length} change(s) were rejected by the server and are not saved there
                </p>
                <button
                  onClick={() => {
                    try {
                      localStorage.removeItem(REJECTED_WRITES_KEY)
                    } catch {
                      /* ignore */
                    }
                    setRejected([])
                  }}
                  className="text-[11px] font-semibold text-[var(--color-ink-muted)] shrink-0"
                >
                  Clear
                </button>
              </div>
              {rejected.slice(0, 5).map((r, i) => (
                <p key={i} className="text-[11px] text-[var(--color-ink-muted)] break-all">
                  {r.at.slice(0, 16).replace('T', ' ')} · {r.op} {r.table} · {r.code} {r.message}
                </p>
              ))}
            </div>
          )}
        </Card>

        {/* Household */}
        <Card>
          <p className="text-sm font-semibold text-[var(--color-ink)] mb-0.5">Household</p>
          <p className="text-xs text-[var(--color-ink-faint)] mb-3 break-all">
            {householdId ? `Household ${householdId.slice(0, 8)}` : 'Finding your household…'}
            {ledger ? ` · ${others} ${others === 1 ? 'person' : 'people'}` : ''}
          </p>
          <p className="text-xs text-[var(--color-ink-muted)] mb-2">Invite someone: they enter this code in their own Account → Join a household.</p>
          {code ? (
            <div className="flex items-center gap-2 mb-2">
              <span className="font-mono text-lg tracking-[0.2em] font-semibold text-[var(--color-ink)]">{code}</span>
              <button
                onClick={() => void navigator.clipboard?.writeText(code).then(() => setNote('Code copied.'), () => setNote('Copy it by hand: ' + code))}
                className="p-1.5 rounded-full text-[var(--color-ink-muted)]"
                aria-label="Copy code"
              >
                <Copy size={14} />
              </button>
              <button onClick={() => setConfirm({ kind: 'regenerate' })} disabled={busy !== null} className="ml-auto text-[11px] font-semibold text-[var(--color-ink-muted)]">
                New code
              </button>
            </div>
          ) : (
            <button
              onClick={() => void run('code', async () => setCode(await getLinkCode()))}
              disabled={busy !== null}
              className="w-full py-2.5 rounded-xl text-xs font-semibold text-[var(--color-ink)] mb-3 disabled:opacity-60"
              style={{ background: 'var(--color-surface)' }}
            >
              {busy === 'code' ? 'Getting code…' : 'Show my invite code'}
            </button>
          )}
          <p className="text-xs text-[var(--color-ink-muted)] mb-2 mt-1">Join a household with a code:</p>
          <div className="flex gap-2">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="8-character code"
              autoCapitalize="characters"
              autoComplete="off"
              className="flex-1 min-w-0 font-mono tracking-widest text-sm py-2 px-3 rounded-xl outline-none text-[var(--color-ink)]"
              style={{ background: 'var(--color-surface)' }}
            />
            <button
              onClick={() => setConfirm({ kind: 'join', code: joinCode.trim() })}
              disabled={busy !== null || joinCode.trim().length < 6}
              className="px-4 rounded-xl text-xs font-semibold text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-50"
            >
              {busy === 'join' ? 'Joining…' : 'Join'}
            </button>
          </div>
        </Card>

        {/* Cloud Backup */}
        {ledger ? (
          restoreOpen ? (
            <Card>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-[var(--color-ink)]">Restore a backup</p>
                <button onClick={() => setRestoreOpen(false)} className="text-xs text-[var(--color-ink-muted)]">
                  Cancel
                </button>
              </div>
              {snapshots === null ? (
                <p className="text-xs text-[var(--color-ink-muted)]">Loading…</p>
              ) : snapshots.length === 0 ? (
                <p className="text-xs text-[var(--color-ink-muted)]">No cloud backups yet.</p>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                  {snapshots.map((s) => (
                    <button
                      key={s.name}
                      onClick={() => setConfirm({ kind: 'restore', name: s.name })}
                      disabled={busy !== null}
                      className="w-full text-left text-sm py-2 px-3 rounded-xl text-[var(--color-ink)] disabled:opacity-60"
                      style={{ background: 'var(--color-surface)' }}
                    >
                      {busy === 'restore' ? 'Restoring…' : s.name.replace('.json', '')}
                    </button>
                  ))}
                </div>
              )}
            </Card>
          ) : (
            <Card>
              <p className="text-sm font-semibold text-[var(--color-ink)] mb-0.5">Cloud Backup</p>
              <p className="text-xs text-[var(--color-ink-muted)] mb-3">
                {snapshots?.[0] ? `Last backed up ${snapshots[0].name.replace('.json', '')}` : 'No cloud backup yet'} · one a day, automatically
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => void run('backup', async () => {
                    await uploadSnapshot(userId, ledger.data)
                    setSnapshots(await listSnapshots(userId))
                    setNote('Backed up.')
                  })}
                  disabled={busy !== null}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2.5 rounded-xl text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-60"
                >
                  <CloudUpload size={14} />
                  {busy === 'backup' ? 'Backing up…' : 'Back Up Now'}
                </button>
                <button
                  onClick={() => {
                    setRestoreOpen(true)
                    void listSnapshots(userId).then(setSnapshots, (err) => setError(errorText(err)))
                  }}
                  disabled={busy !== null}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2.5 rounded-xl text-[var(--color-ink)] disabled:opacity-60"
                  style={{ background: 'var(--color-surface)' }}
                >
                  <History size={14} />
                  Restore
                </button>
              </div>
            </Card>
          )
        ) : (
          <Card>
            <p className="text-xs text-[var(--color-ink-muted)]">Cloud Backup is available once your household has synced.</p>
          </Card>
        )}

        {note && <p className="text-xs text-center text-[var(--color-positive)] mb-3">{note}</p>}
        {error && <p className="text-xs text-center text-[var(--color-negative)] mb-3 break-words">{error}</p>}

        <button onClick={() => void signOut()} className="w-full py-3 rounded-2xl text-sm font-medium text-[var(--color-ink)] mb-6" style={{ background: 'var(--color-bg-elevated)' }}>
          Sign out
        </button>

        <div className="border-t pt-4" style={{ borderColor: 'var(--color-track)' }}>
          <button onClick={() => setConfirm({ kind: 'delete1' })} disabled={busy !== null} className="w-full py-3 rounded-2xl text-sm font-semibold text-[var(--color-negative)] disabled:opacity-60" style={{ background: 'var(--color-bg-elevated)' }}>
            {busy === 'delete' ? 'Deleting…' : 'Delete my app data'}
          </button>
          <p className="text-[11px] text-[var(--color-ink-faint)] mt-2 text-center">Your ledger data in this app. Your login is kept.</p>
        </div>
      </div>

      {confirm && (
        <ConfirmSheet
          confirm={confirm}
          onCancel={() => setConfirm(null)}
          onDelete1={() => setConfirm({ kind: 'delete2' })}
          onGo={() => {
            const c = confirm
            setConfirm(null)
            if (c.kind === 'delete2') void deleteMyData()
            if (c.kind === 'regenerate') void run('code', async () => setCode(await regenerateLinkCode()))
            if (c.kind === 'join') void join(c.code)
            if (c.kind === 'restore') void restore(c.name)
          }}
        />
      )}
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </div>,
    document.body,
  )
}

/** This app's own keys for this account on this device. Never the ledger's old key (ledger:app-data-v2:v1). */
export function clearThisAppsKeys(userId: string) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (
        key.startsWith(`ledger:sync:primary-person:${POWERSYNC_DB_FILENAME}:`) ||
        key === `ledger:sync:db-user:${POWERSYNC_DB_FILENAME}` ||
        key === REJECTED_WRITES_KEY ||
        key === legacyOfferedKey(userId) ||
        key === duplicatePersonKey(userId) ||
        key === justJoinedKey(userId)
      ) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl p-4 mb-3" style={{ background: 'var(--color-track)' }}>
      {children}
    </div>
  )
}

const CONFIRM_TEXT: Record<Confirm['kind'], { title: string; body: string; go: string; danger?: boolean }> = {
  delete1: {
    title: 'Delete your ledger data?',
    body: "This deletes your data in Shared Ledger: if you're the only member of your household, every person, bill, loan, card, pot and transaction in it. If someone else is in your household, their shared data stays and only your own part goes. Your login is not deleted.",
    go: 'Continue',
    danger: true,
  },
  delete2: {
    title: "This can't be undone",
    body: "Your ledger data and your backups in this app are deleted now, on every device. You'll stay signed in with an empty ledger.",
    go: 'Delete everything',
    danger: true,
  },
  regenerate: {
    title: 'Make a new invite code?',
    body: "The current code stops working straight away. Use this if the code was shared with someone it shouldn't have been. People already in your household stay in it.",
    go: 'New code',
  },
  join: {
    title: 'Join this household?',
    body: 'You move into the household that owns this code, and see its data on every device you sign in on. Your own person (the one marked Me via "Set as me") comes with you, with your own bills, loans, cards, pots and transactions. Joint items stay behind. If you have data but no person marked as you, it will ask you to do that first.',
    go: 'Join',
  },
  restore: {
    title: 'Replace the whole household?',
    body: "Restoring replaces ALL of this household's data, on every device and for everyone in it, with this backup. Anything added since the backup is lost. Anyone else in the household will need to tap \"Set as me\" on their own person again afterwards.",
    go: 'Replace everything',
    danger: true,
  },
}

function ConfirmSheet({ confirm, onCancel, onDelete1, onGo }: { confirm: Confirm; onCancel: () => void; onDelete1: () => void; onGo: () => void }) {
  const t = CONFIRM_TEXT[confirm.kind]
  return (
    <div className="fixed inset-0 z-[10003] flex items-center justify-center px-6" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={(e) => (e.stopPropagation(), onCancel())}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: 'var(--color-surface)' }} onClick={(e) => e.stopPropagation()}>
        <h4 className="font-display text-base font-semibold text-[var(--color-ink)] mb-2">{t.title}</h4>
        {confirm.kind === 'join' && <p className="font-mono text-sm tracking-widest text-[var(--color-ink)] mb-2">{confirm.code}</p>}
        {confirm.kind === 'restore' && <p className="text-sm font-semibold text-[var(--color-ink)] mb-2">Backup from {confirm.name.replace('.json', '')}</p>}
        <p className="text-sm text-[var(--color-ink-muted)] mb-4">{t.body}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl text-sm text-[var(--color-ink)]" style={{ background: 'var(--color-track)' }}>
            {confirm.kind === 'delete2' ? 'Keep my data' : 'Cancel'}
          </button>
          <button
            onClick={confirm.kind === 'delete1' ? onDelete1 : onGo}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: t.danger ? 'var(--color-negative)' : 'var(--color-ink)' }}
          >
            {t.go}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * personal-f's Change Password (from BLOC): two new-password fields in a real <form>, so iOS offers
 * its strong-password suggestion and Keychain save. updateUser needs no current password: the
 * session authorises it.
 */
function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { updatePassword } = useAuth()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!password || !again) return setStatus({ text: 'Enter and confirm your new password.', error: true })
    if (password !== again) return setStatus({ text: "Passwords don't match.", error: true })
    setSubmitting(true)
    setStatus(null)
    try {
      await updatePassword(password)
      setStatus({ text: 'Password updated.', error: false })
      setTimeout(onClose, 900)
    } catch (e) {
      setStatus({ text: errorText(e), error: true })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[10003] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={(e) => (e.stopPropagation(), onClose())}>
      <div className="w-full max-w-md rounded-t-3xl p-5" style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--safe-bottom, 0px) + 24px)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Change Password</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={(e) => (e.preventDefault(), void submit())} className="space-y-3">
          <input type="password" autoComplete="new-password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full text-sm py-2.5 px-3 rounded-xl outline-none text-[var(--color-ink)]" style={{ background: 'var(--color-track)' }} />
          <input type="password" autoComplete="new-password" placeholder="Confirm new password" value={again} onChange={(e) => setAgain(e.target.value)} className="w-full text-sm py-2.5 px-3 rounded-xl outline-none text-[var(--color-ink)]" style={{ background: 'var(--color-track)' }} />
          <button type="submit" disabled={submitting} className="w-full py-3 rounded-2xl font-semibold text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-60">
            {submitting ? 'Updating…' : 'Update Password'}
          </button>
        </form>
        {status && <p className="text-xs mt-3 text-center" style={{ color: status.error ? 'var(--color-negative)' : 'var(--color-positive)' }}>{status.error ? status.text : '✓ ' + status.text}</p>}
      </div>
    </div>
  )
}

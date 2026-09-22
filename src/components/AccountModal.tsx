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
//   - Backup & Restore (BUILD-PLAN 4.5; merged into one pair in PROMPT-14
//     Parts 1-3). Back Up Now and Restore each open one follow-up step —
//     cloud or this device / cloud or a file — over ONE format: a cloud
//     snapshot and a downloaded file are the same AppDataV2 JSON, which is
//     what makes a single step over a single format possible at all. The
//     file route moved here from the Wallet page, whose Backup slot this app
//     claims (BackupSection.tsx). Restore replaces the WHOLE HOUSEHOLD's
//     data, so it sits behind a warning that says so (DECISIONS Q9) and goes
//     through the app's normal restore (setData), which the store turns into
//     an import;
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

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloudUpload, Copy, Download, History, RefreshCw, Upload, X } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import type { AppDataV2 } from '../types/ledger'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { POWERSYNC_DB_FILENAME, powerSyncDb } from '../lib/powersync/database'
import { clearHouseholdCache } from '../lib/powersync/household'
import { REJECTED_WRITES_KEY, readRejectedWrites } from '../lib/powersync/connector'
import { downloadSnapshot, listSnapshots, pruneSnapshots, removeAllSnapshots, SNAPSHOTS_KEPT, uploadSnapshot, type SnapshotInfo } from '../lib/powersync/backup'
import { duplicatePersonKey, getLinkCode, justJoinedKey, redeemLinkCode, regenerateLinkCode, rememberDuplicate } from '../lib/powersync/linking'
import { legacyOfferedKey } from '../lib/powersync/legacyData'
import { describeBackupContents } from './BackupSection'
import { downloadLedgerBackup, parseLedgerBackupJson } from '../lib/ledgerStorage'
import { isSameHouseholdPatch, rowsRemovedByPatch } from '../lib/store/powerSyncLedgerStore'
import { ToggleSwitch } from './Toggle'
import { forgetThisDevice, listDevices, pushState, removeDevice, sendTest, thisDeviceId, turnOffHere, turnOnHere, type Device, type PushState } from '../lib/powersync/push'
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

/**
 * Where a restore is coming from. Both routes carry everything the confirm needs to name the
 * source, so the two can't describe the same act differently (PROMPT-14 Part 3).
 */
export type RestoreSource = { kind: 'cloud'; name: string } | { kind: 'file'; fileName: string; data: AppDataV2 }

type Confirm =
  | { kind: 'delete1' }
  | { kind: 'delete2' }
  | { kind: 'regenerate' }
  | { kind: 'join'; code: string }
  | { kind: 'restore'; source: RestoreSource }

/** The one follow-up step Back Up Now and Restore each open (PROMPT-14 Parts 2 and 3). */
type Step = null | 'backup-choice' | 'restore-choice' | 'cloud-list'

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
  const [step, setStep] = useState<Step>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  /**
   * The ONE function both restore routes converge on (PROMPT-14 Part 3). A cloud snapshot and a
   * downloaded file are the same JSON — `uploadSnapshot` writes the app's own AppDataV2 and
   * `downloadSnapshot` parses it back through `parseLedgerBackupJson`, the identical function
   * the file picker uses — so there is nothing legitimate for two paths to do differently, and
   * two paths is how they start drifting. `verify-backup-format-parity.ts` holds that invariant.
   */
  const restoreFrom = (source: RestoreSource) =>
    run('restore', async () => {
      if (!ledger) return
      const data = source.kind === 'cloud' ? await downloadSnapshot(userId, source.name) : source.data
      ledger.setData(data)
      setStep(null)
      setNote(source.kind === 'cloud' ? `Restored the backup from ${source.name.replace('.json', '')}.` : `Restored ${source.fileName}.`)
    })

  function handleRestoreFile(file: File) {
    setError(null)
    file
      .text()
      .then((text) => setConfirm({ kind: 'restore', source: { kind: 'file', fileName: file.name, data: parseLedgerBackupJson(text) } }))
      .catch((err) => setError(errorText(err)))
  }

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

        {/* Backup & Restore (PROMPT-14 Parts 1-3): ONE pair of buttons, each
            with a cloud-or-this-device follow-up step. Both existing flows are
            unchanged behind it; the file route moved here from the Wallet page,
            whose slot this app claims (BackupSection.tsx).

            🚨 The gate is `ledger`. SyncRoot only hands it over in the 'ready'
            phase, which it reaches by awaiting store.load() — and that resolves
            only after first sync. Restoring into a half-populated shadow would
            diff against rows that have not arrived and DELETE what it cannot
            see, so "available once your household has synced" is a real guard,
            not a courtesy. */}
        {ledger ? (
          step === 'cloud-list' ? (
            <Card>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-[var(--color-ink)]">Restore a cloud backup</p>
                <button onClick={() => setStep('restore-choice')} className="text-xs text-[var(--color-ink-muted)]">
                  Back
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
                      onClick={() => setConfirm({ kind: 'restore', source: { kind: 'cloud', name: s.name } })}
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
          ) : step === 'backup-choice' || step === 'restore-choice' ? (
            <Card>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-semibold text-[var(--color-ink)]">{step === 'backup-choice' ? 'Back up where?' : 'Restore from where?'}</p>
                <button onClick={() => setStep(null)} className="text-xs text-[var(--color-ink-muted)]">
                  Cancel
                </button>
              </div>
              <p className="text-xs text-[var(--color-ink-muted)] mb-3">
                {step === 'backup-choice'
                  ? 'The cloud copy and the file are the same backup — either can be restored anywhere.'
                  : 'Either replaces this whole household, on every device.'}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (step === 'backup-choice') {
                      void run('backup', async () => {
                        await uploadSnapshot(userId, ledger.data)
                        await pruneSnapshots(userId)
                        setSnapshots(await listSnapshots(userId))
                        setStep(null)
                        setNote('Backed up to the cloud.')
                      })
                    } else {
                      setStep('cloud-list')
                      void listSnapshots(userId).then(setSnapshots, (err) => setError(errorText(err)))
                    }
                  }}
                  disabled={busy !== null || (step === 'backup-choice' && !status.connected)}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2.5 rounded-xl text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-60"
                >
                  <CloudUpload size={14} />
                  {busy === 'backup' ? 'Backing up…' : 'Cloud'}
                </button>
                <button
                  onClick={() => {
                    if (step === 'backup-choice') {
                      // Honours the choice literally (§0 Q6): a local download
                      // never touches the network. It is exactly what you want
                      // when sync is the thing that is broken.
                      void downloadLedgerBackup(ledger.data)
                      setStep(null)
                      setNote('Saved a backup file to this device.')
                    } else {
                      fileInputRef.current?.click()
                    }
                  }}
                  disabled={busy !== null}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2.5 rounded-xl text-[var(--color-ink)] disabled:opacity-60"
                  style={{ background: 'var(--color-surface)' }}
                >
                  {step === 'backup-choice' ? <Download size={14} /> : <Upload size={14} />}
                  {step === 'backup-choice' ? 'This device' : 'A file'}
                </button>
              </div>
              {step === 'backup-choice' && !status.connected && (
                // Disabled, not hidden, with the reason: hiding it would read
                // as "cloud backup is gone".
                <p className="text-[11px] text-[var(--color-ink-faint)] mt-2">Cloud is unavailable while this device is offline. A backup file still works.</p>
              )}
            </Card>
          ) : (
            <Card>
              <p className="text-sm font-semibold text-[var(--color-ink)] mb-0.5">Backup &amp; Restore</p>
              <p className="text-xs text-[var(--color-ink-muted)] mb-3">
                {snapshots?.[0] ? `Last cloud backup ${snapshots[0].name.replace('.json', '')}` : 'No cloud backup yet'} · one a day, automatically · the last {SNAPSHOTS_KEPT} are kept
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setStep('backup-choice')}
                  disabled={busy !== null}
                  className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2.5 rounded-xl text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-60"
                >
                  <CloudUpload size={14} />
                  Back Up Now
                </button>
                <button
                  onClick={() => setStep('restore-choice')}
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
            <p className="text-xs text-[var(--color-ink-muted)]">Backup &amp; Restore is available once your household has synced.</p>
          </Card>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleRestoreFile(file)
            e.target.value = ''
          }}
        />

        {/* Low-balance alerts (PROMPT-14 Part 7). Sync-only UI, so it belongs
            here rather than in a shared page behind a runtime check — the
            offline bundle has to stay sync-free. The switch itself is the
            SHARED Toggle.tsx, extracted from Home's filter sheet rather than
            copied into this file. */}
        <NotificationsCard />

        {note && <p className="text-xs text-center text-[var(--color-positive)] mb-3">{note}</p>}
        {error && <p className="text-xs text-center text-[var(--color-negative)] mb-3 break-words">{error}</p>}

        {/* Signing out unregisters this phone first: otherwise someone else
            signing in here would be sent this household's alerts. Best effort —
            signing out must never be blocked by it, online or not. */}
        <button onClick={() => void forgetThisDevice().finally(() => void signOut())} className="w-full py-3 rounded-2xl text-sm font-medium text-[var(--color-ink)] mb-6" style={{ background: 'var(--color-bg-elevated)' }}>
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
          replacing={ledger ? describeBackupContents(ledger.data) : null}
          current={ledger?.data ?? null}
          onCancel={() => setConfirm(null)}
          onDelete1={() => setConfirm({ kind: 'delete2' })}
          onGo={() => {
            const c = confirm
            setConfirm(null)
            if (c.kind === 'delete2') void deleteMyData()
            if (c.kind === 'regenerate') void run('code', async () => setCode(await regenerateLinkCode()))
            if (c.kind === 'join') void join(c.code)
            if (c.kind === 'restore') void restoreFrom(c.source)
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

function ConfirmSheet({ confirm, replacing, current, onCancel, onDelete1, onGo }: { confirm: Confirm; replacing: string | null; current: AppDataV2 | null; onCancel: () => void; onDelete1: () => void; onGo: () => void }) {
  const t = CONFIRM_TEXT[confirm.kind]
  // A file this household exported and someone edited is a PATCH: only what
  // changed is written (Part 4). Say so — and say what it will DELETE, because
  // a hand-trimmed file reads as a patch too and the diff does as it is told.
  const patch = confirm.kind === 'restore' && confirm.source.kind === 'file' && current && isSameHouseholdPatch(confirm.source.data, current)
  const removing = patch && current && confirm.kind === 'restore' && confirm.source.kind === 'file' ? rowsRemovedByPatch(confirm.source.data, current) : 0
  return (
    <div className="fixed inset-0 z-[10003] flex items-center justify-center px-6" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={(e) => (e.stopPropagation(), onCancel())}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: 'var(--color-surface)' }} onClick={(e) => e.stopPropagation()}>
        <h4 className="font-display text-base font-semibold text-[var(--color-ink)] mb-2">{t.title}</h4>
        {confirm.kind === 'join' && <p className="font-mono text-sm tracking-widest text-[var(--color-ink)] mb-2">{confirm.code}</p>}
        {confirm.kind === 'restore' && (
          <>
            {/* Name the source, say what it replaces, and — for a file, where the
                incoming contents are known before the restore — say what arrives
                instead. A cloud snapshot is only downloaded on Replace, so its
                contents can't honestly be listed here. */}
            <p className="text-sm font-semibold text-[var(--color-ink)] mb-2">
              {confirm.source.kind === 'cloud' ? `Cloud backup from ${confirm.source.name.replace('.json', '')}` : confirm.source.fileName}
            </p>
            {replacing && (
              <p className="text-xs text-[var(--color-ink-muted)] mb-2">
                Replacing {replacing}
                {confirm.source.kind === 'file' ? ` with ${describeBackupContents(confirm.source.data)}` : ''}.
              </p>
            )}
            {patch && (
              <p className="text-xs text-[var(--color-positive)] mb-2">
                This is this household's own file, so only what you changed is written — no ids change and nobody has to say who they are again.
                {removing > 0 ? ` ${removing} row${removing === 1 ? '' : 's'} in the app ${removing === 1 ? 'is' : 'are'} missing from this file and will be DELETED.` : ''}
              </p>
            )}
          </>
        )}
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

/**
 * Low-balance alerts, per device (PROMPT-14 Part 7; Adam's spec, 2026-09-21:
 * "a toggle on/off for push notifications in the account modal… we can re-use
 * the toggle style from the home page filters").
 *
 * 🚨 IT BRANCHES ON `Notification.permission`, NOT ON TOGGLE HISTORY.
 * Adam's "toggling on a second time instructs users where to go in settings"
 * is right only when permission is actually DENIED. Toggling off does not
 * revoke it, so the ordinary case is 'granted' and toggling back on should
 * just work, silently — instructing someone to visit Settings when nothing is
 * wrong there is worse than useless. `decidePushState` (pushState.ts) is where
 * that decision lives, and `verify-notification-toggle.ts` proves every case.
 *
 * 🚨 THE SWITCH IS PER DEVICE. It reads from whether THIS browser's own
 * subscription row exists on the server, never a user-level flag: a
 * user-level boolean would render ON on a second phone that has never
 * registered, and that phone would then receive nothing while claiming to be
 * on. The device list below is here so "why is my phone not getting these" is
 * answerable without a database query.
 */
function NotificationsCard() {
  const [state, setState] = useState<PushState | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [hereId, setHereId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  const refresh = async () => {
    try {
      const list = await listDevices()
      setDevices(list)
      setHereId(await thisDeviceId())
      setState(await pushState(list.map((d) => d.id)))
    } catch (err) {
      setMessage({ text: errorText(err), error: true })
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setMessage({ text: errorText(err), error: true })
      await refresh() // the switch must show what is TRUE, not what was tapped
    } finally {
      setBusy(false)
      void label
    }
  }

  if (state === null) {
    return (
      <Card>
        <p className="text-xs text-[var(--color-ink-muted)]">Checking notifications on this device…</p>
      </Card>
    )
  }

  // Every way of being off says WHY, because there is no email fallback: a
  // device that cannot receive push receives nothing at all.
  const help: Record<PushState, string> = {
    on: 'This device gets an alert at 8pm on any day one of your accounts is projected to dip below zero.',
    off: 'This device is not registered, so it will not get alerts.',
    ask: "You'll be asked to allow notifications.",
    denied: 'Notifications are turned off for this app and it cannot ask again. Turn them on in iOS Settings → Notifications → Shared Ledger, then come back.',
    'needs-install': 'On iPhone and iPad, notifications only work from the Home Screen app. Share → Add to Home Screen, then open it from there.',
    unsupported: 'This browser cannot show notifications, so this device will not get alerts.',
  }
  const canToggle = state === 'on' || state === 'off' || state === 'ask'

  return (
    <Card>
      <ToggleSwitch
        full
        label="Low-balance alerts"
        help={help[state]}
        checked={state === 'on'}
        disabled={busy || !canToggle}
        onChange={(next) =>
          void act('toggle', async () => {
            // 'granted' re-subscribes with NO prompt and no Settings
            // instruction; 'default' asks; 'denied' never gets here, because
            // the switch is disabled and the instruction is already showing.
            if (next) await turnOnHere()
            else await turnOffHere()
          })
        }
      />

      {state === 'on' && (
        <button
          onClick={() =>
            void act('test', async () => {
              const r = await sendTest()
              setMessage({ text: r.sent > 0 ? `Sent to ${r.sent} device${r.sent === 1 ? '' : 's'}.` : 'Nothing was sent — no device is registered.', error: false })
            })
          }
          disabled={busy}
          className="mt-3 w-full py-2.5 rounded-xl text-xs font-semibold text-[var(--color-ink)] disabled:opacity-60"
          style={{ background: 'var(--color-surface)' }}
        >
          {busy ? 'Sending…' : 'Send me a test notification'}
        </button>
      )}

      {devices.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] text-[var(--color-ink-faint)] mb-1">Registered devices</p>
          {devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 py-1">
              <span className="text-xs text-[var(--color-ink-muted)] truncate">
                {d.label}
                {d.id === hereId ? ' · this device' : ''}
                {d.failedCount > 0 ? ` · ${d.failedCount} failed send${d.failedCount === 1 ? '' : 's'}` : ''}
              </span>
              <button onClick={() => void act('remove', () => removeDevice(d.id))} disabled={busy} className="text-[11px] font-semibold text-[var(--color-ink-muted)] shrink-0">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {message && (
        <p className="text-xs mt-2" style={{ color: message.error ? 'var(--color-negative)' : 'var(--color-positive)' }}>
          {message.text}
        </p>
      )}
    </Card>
  )
}

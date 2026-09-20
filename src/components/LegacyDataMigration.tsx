// SYNC APP ONLY. The empty-household screen, with the rescue of data saved on
// this device before sign-in existed (MIGRATION-LESSONS §24; PROMPT-10 Part 2).
//
// Shown after first sync when the household has no people. One screen, four
// choices (Adam, 2026-09-19), rather than a prompt stacked on a prompt:
//   - Import this device's data — only when there is some worth offering;
//   - Import a backup file;
//   - Start fresh;
//   - Join a household with a code (Ella's path: join BEFORE creating
//     anything, then tap "Set as me" on her own row).
//
// 🚨 The old key is READ and nothing else. 'ledger:app-data-v2:v1' on this
// origin is also the offline personal-ledger app's data — Adam's mum's real,
// unbacked-up ledger on her devices. personal-f's version of this component
// removed its old key after importing and after "Start fresh"; ported as-is
// that would delete the offline app's data on any device with both apps. So
// the choice is recorded under this app's own key instead
// (legacyData.ts, verify-legacy-migration.ts).
//
// Every import goes through the store's save(), i.e. the same narrow-diff
// path as every edit, after first sync — and the store regenerates its ids
// (importIds.ts), so the same backup can be imported into two households.

import { useEffect, useRef, useState } from 'react'
import type { AppDataV2 } from '../types/ledger'
import { defaultLedgerData, parseLedgerBackupJson } from '../lib/ledgerStorage'
import { describeLedger, findLegacyData, markLegacyOffered } from '../lib/powersync/legacyData'
import { justJoinedKey, redeemLinkCode, rememberDuplicate } from '../lib/powersync/linking'
import type { PowerSyncLedgerStore } from '../lib/store/powerSyncLedgerStore'

type Pending = { data: AppDataV2; from: 'device' | 'file'; name?: string }

export function LegacyDataMigration({
  store,
  current,
  userId,
  onDone,
  onJoined,
}: {
  store: PowerSyncLedgerStore
  current: AppDataV2
  userId: string
  onDone: () => void
  onJoined: (line: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [legacy] = useState<AppDataV2 | null>(() => findLegacyData(localStorage, userId))
  const [pending, setPending] = useState<Pending | null>(null)
  const [joining, setJoining] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commit = async (next: AppDataV2, choice: 'imported' | 'file' | 'fresh') => {
    setBusy(true)
    setError(null)
    markLegacyOffered(localStorage, userId, choice)
    store.save(next, current)
    await store.flush()
    onDone()
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      setPending({ data: parseLedgerBackupJson(await file.text()), from: 'file', name: file.name })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be read as a ledger backup.')
    }
  }

  const join = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await redeemLinkCode(code)
      console.info('[sync] joined a household', result)
      markLegacyOffered(localStorage, userId, 'joined')
      rememberDuplicate(localStorage, userId, result.duplicate_person_id)
      try {
        localStorage.setItem(justJoinedKey(userId), '1')
      } catch {
        /* the "which one is you?" prompt just won't appear */
      }
      onJoined('Joined the household. Syncing it to this device…')
    } catch (err) {
      console.error('[sync] join failed', err)
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  // Another device may fill the household (import, start fresh) while this one
  // waits here: move on as soon as people arrive by sync.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => store.subscribe?.((data) => {
    if (data.people.length > 0) onDoneRef.current()
  }), [store])

  const potDeposits = pending?.data.pots.filter((p) => p.recurringDepositAmount).length ?? 0

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center overflow-y-auto px-5 py-6" style={{ background: 'var(--color-bg)' }}>
      <div className="w-full max-w-[360px] mx-auto text-center">
        <div className="font-display text-2xl font-bold text-[var(--color-ink)] mb-2">Your household is empty</div>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6">Bring in your data, start with a blank ledger, or join someone else's household.</p>

        {pending ? (
          <div className="rounded-2xl p-4 text-left space-y-2" style={{ background: 'var(--color-surface)' }}>
            <p className="text-sm font-semibold text-[var(--color-ink)] break-words">
              {pending.from === 'device' ? 'Data saved on this device' : pending.name}
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">{describeLedger(pending.data)}</p>
            <p className="text-xs text-[var(--color-ink-muted)]">This becomes your household's data on every device signed in to it.</p>
            {pending.from === 'device' && (
              <p className="text-xs text-[var(--color-ink-faint)]">The offline Ledger app's own copy on this device is left exactly as it is.</p>
            )}
            {potDeposits > 0 && (
              <p className="text-xs text-[var(--color-negative)]">
                {potDeposits} pot(s) use the old pot recurring deposit, which doesn't sync. Set those up as recurring transfers after importing.
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <button disabled={busy} onClick={() => setPending(null)} className="flex-1 py-2.5 rounded-xl text-sm text-[var(--color-ink-muted)]" style={{ background: 'var(--color-track)' }}>
                Back
              </button>
              <button
                disabled={busy}
                onClick={() => void commit(pending.data, pending.from === 'device' ? 'imported' : 'file')}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-60"
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        ) : joining ? (
          <div className="rounded-2xl p-4 text-left space-y-2" style={{ background: 'var(--color-surface)' }}>
            <p className="text-sm font-semibold text-[var(--color-ink)]">Join a household</p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Enter the code from the other person's Account screen. You'll see their household's data on this device. Nothing from this device
              comes with you, so join before adding anything of your own — then tap "Set as me" on your own person in Wallet → People.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="8-character code"
              autoCapitalize="characters"
              autoComplete="off"
              className="w-full font-mono tracking-widest text-sm py-2.5 px-3 rounded-xl outline-none text-[var(--color-ink)]"
              style={{ background: 'var(--color-track)' }}
            />
            <div className="flex gap-2 pt-1">
              <button disabled={busy} onClick={() => (setJoining(false), setError(null))} className="flex-1 py-2.5 rounded-xl text-sm text-[var(--color-ink-muted)]" style={{ background: 'var(--color-track)' }}>
                Back
              </button>
              <button
                disabled={busy || code.trim().length < 6}
                onClick={() => void join()}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-50"
              >
                {busy ? 'Joining…' : 'Join'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {legacy && (
              <button
                disabled={busy}
                onClick={() => setPending({ data: legacy, from: 'device' })}
                className="w-full py-3 px-4 rounded-2xl text-left text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-60"
              >
                <span className="block text-sm font-semibold">Import this device's data</span>
                <span className="block text-[11px] opacity-80 mt-0.5">Saved on this device by the offline Ledger app · {describeLedger(legacy)}</span>
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className={`w-full py-3 rounded-2xl font-semibold disabled:opacity-60 ${legacy ? 'text-sm text-[var(--color-ink)]' : 'text-[var(--color-surface)] bg-[var(--color-ink)]'}`}
              style={legacy ? { background: 'var(--color-surface)' } : undefined}
            >
              Import a backup file
            </button>
            <button
              disabled={busy}
              onClick={() => {
                const d = defaultLedgerData() // a fresh 'Me' (new id) and their pay cycle; categories already exist server-side
                void commit({ ...current, people: d.people, payCycles: d.payCycles, primaryPersonId: d.primaryPersonId }, 'fresh')
              }}
              className="w-full py-3 rounded-2xl font-medium text-sm text-[var(--color-ink)] disabled:opacity-60"
              style={{ background: 'var(--color-surface)' }}
            >
              Start fresh
            </button>
            <button
              disabled={busy}
              onClick={() => setJoining(true)}
              className="w-full py-3 rounded-2xl font-medium text-sm text-[var(--color-ink)] disabled:opacity-60"
              style={{ background: 'var(--color-surface)' }}
            >
              Join a household with a code
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
        )}
        {error && <p className="text-xs text-[var(--color-negative)] mt-3 break-words">{error}</p>}
      </div>
    </div>
  )
}

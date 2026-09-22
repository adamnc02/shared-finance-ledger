// SHARED, NOT DIVERGENT. Identical in all three apps, and it must stay that
// way: `src/pages/**` is on DIVERGENCE.md's "Explicitly NOT allowed to
// diverge" list, and this file is what lets Salary.tsx render one line in
// both live apps while the sync app shows Backup & Restore somewhere else.
//
// 🚨 It must never import from `src/lib/powersync/**`, `supabaseClient` or
// `@powersync/*`. It ships in the OFFLINE bundle, which `check-sync-build.ts`
// proves carries no sync code at all, and `verify-backup-placement.ts` asserts
// that directly against this file's source. A later session "tidying" this
// into a sync-only file would break both.
//
// The mechanism is HeaderAccessory.tsx's, inverted (PROMPT-14 Part 1).
// HeaderAccessory is an empty slot that renders nothing unless an app FILLS
// it; this is a full slot that renders unless an app CLAIMS it:
//
//   - BackupPlacementContext defaults to 'wallet', so with no provider at all
//     — the offline apps — the card renders on the Wallet page exactly as it
//     always has;
//   - the sync app's SyncRoot provides 'account', so WalletBackupSlot renders
//     null there and the only door to a whole-household replace is the Account
//     modal (§0 Q2, Adam 2026-09-22: "two doors is one too many").
//
// The difference between the apps is therefore WHICH APP RENDERS A PROVIDER,
// not which app compiles a file. No `if (sync)`, no `import.meta.env`, no
// VITE_SYNC_ENABLED (that is test-app-only; TEST-APP-DIVERGENCE.md).

import { createContext, useContext, useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import type { AppDataV2 } from '../types/ledger'
import { downloadLedgerBackup, parseLedgerBackupJson } from '../lib/ledgerStorage'
import { isBillTemplate } from '../lib/bills'
import { ConfirmModal } from './ConfirmModal'

export type BackupPlacement = 'wallet' | 'account'

/** 'wallet' with no provider, which is what keeps the offline apps unchanged. */
export const BackupPlacementContext = createContext<BackupPlacement>('wallet')

export function useBackupPlacement(): BackupPlacement {
  return useContext(BackupPlacementContext)
}

/**
 * What a restore is about to replace, in the person's own terms. One function, so the Wallet
 * confirm and the sync app's Account confirm can never describe the same thing differently
 * (PROMPT-14 Part 3: both paths converge or they drift).
 */
export function describeBackupContents(data: AppDataV2): string {
  const people = data.people.length
  const bills = data.recurringTemplates.filter(isBillTemplate).length
  return [
    `${people} ${people === 1 ? 'person' : 'people'}`,
    `${bills} ${bills === 1 ? 'bill' : 'bills'}`,
    `${data.loans.length} ${data.loans.length === 1 ? 'loan' : 'loans'}`,
    `${data.creditCards.length} ${data.creditCards.length === 1 ? 'credit card' : 'credit cards'}`,
    `${data.scenarios.length} ${data.scenarios.length === 1 ? 'scenario' : 'scenarios'}`,
  ].join(', ')
}

export function BackupSection({ data, onRestore }: { data: AppDataV2; onRestore: (data: AppDataV2) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  // Held until the confirm is answered. A portalled ConfirmModal rather than
  // window.confirm: this page renders inside #app-content, which is
  // overflow-y-auto (MIGRATION-LESSONS §15), and a bare confirm gives no room
  // to say what is actually being replaced.
  const [pending, setPending] = useState<{ data: AppDataV2; fileName: string } | null>(null)

  function handleFile(file: File) {
    setError(null)
    setRestored(false)
    file
      .text()
      .then((text) => setPending({ data: parseLedgerBackupJson(text), fileName: file.name }))
      .catch((err) => setError(err.message))
  }

  return (
    <div className="rounded-2xl p-4 mb-6 flex items-center justify-between" style={{ background: 'var(--color-surface)' }}>
      <div>
        <h2 className="font-body text-sm font-semibold text-[var(--color-ink)]">Backup</h2>
        <p className="text-xs text-[var(--color-ink-faint)] mt-0.5 max-w-[220px]">
          Everything lives in this browser's storage — save a copy somewhere safe in case it gets cleared.
        </p>
        {error && (
          <p className="text-xs mt-1" style={{ color: 'var(--color-negative)' }}>
            {error}
          </p>
        )}
        {restored && (
          <p className="text-xs mt-1" style={{ color: 'var(--color-positive)' }}>
            Restored.
          </p>
        )}
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={() => downloadLedgerBackup(data)}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-bg-elevated)' }}
          title="Download a full backup"
        >
          <Download size={16} className="text-[var(--color-ink)]" />
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-bg-elevated)' }}
          title="Restore from a backup file"
        >
          <Upload size={16} className="text-[var(--color-ink)]" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
      </div>
      {pending && (
        <ConfirmModal
          title="Replace everything with this backup?"
          description={`This replaces everything currently in the app (${describeBackupContents(data)}) with the contents of ${pending.fileName}, which holds ${describeBackupContents(pending.data)}. This can't be undone.`}
          confirmLabel="Replace everything"
          tone="danger"
          onConfirm={() => {
            onRestore(pending.data)
            setPending(null)
            setRestored(true)
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}

/**
 * The Wallet page's slot. Renders the card unless an app has claimed Backup & Restore for
 * somewhere else. Salary.tsx renders this — identically in both live apps.
 */
export function WalletBackupSlot(props: { data: AppDataV2; onRestore: (data: AppDataV2) => void }) {
  return useBackupPlacement() === 'wallet' ? <BackupSection {...props} /> : null
}

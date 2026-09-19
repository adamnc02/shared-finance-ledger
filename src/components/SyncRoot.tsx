// SYNC APP ONLY. Everything between "the app opened" and "the ledger renders"
// in the sync app, in the order PROMPT-09 §3.2b requires:
//
//   sign in → ensure_household() → connect (this app's stream only) →
//   wait for first sync → empty household? Import / Start fresh / Join :
//   the ledger
//
// - ensure_household() runs BEFORE the first sync counts: a brand-new user
//   has no household until it runs, so the stream would report "synced" with
//   nothing in it and the gate would open on a truly empty ledger.
// - Full-screen "Syncing your household…" until first sync (Adam, §0.1 Q4).
//   The store's own gate (powerSyncLedgerStore) is the second lock.
// - connect(…, { includeDefaultStreams: false }) + an explicit subscription:
//   personal-f's stream is auto-subscribed and must not download here.
// - An empty household (35 categories, no people) is never given a "Me"
//   automatically (Adam, 2026-09-19: Ella's join path would carry it into
//   his household as a duplicate). LegacyDataMigration offers this device's
//   old data, a backup file, Start fresh, or joining with a code.
// - If the household changes under a running session (deleted on another
//   device, or joined elsewhere), the store suspends itself and this boots
//   again from ensure_household(), clearing the local copy first (UAT
//   2026-09-19: a phone left open across "Delete my app data" re-sent a
//   stale ledger into the deleted household). PROMPT-10: redeeming a link
//   code reboots the same way, deliberately — the joiner's data is moved
//   SERVER-side and the local copy must not be assumed to follow.
// - One local database per app, and per account on this device: if a
//   different account signed in last, the local copy is cleared first, so
//   nobody ever sees, or gates on, someone else's synced data.
// - The Account button lives in the Wallet header once the ledger is up
//   (HeaderAccessory, shared) and floats on the boot screens, where there is
//   no header to put it in but sign-out and Delete my app data must still be
//   reachable.
//
// Rendered only in the /sync/ build (App.tsx, lazy); the root build never
// contains it (check-sync-build.ts).

import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { User } from 'lucide-react'
import type { AppDataV2 } from '../types/ledger'
import type { LedgerStore } from '../lib/store/LedgerStore'
import { AuthProvider, useAuth } from '../context/AuthContext'
import { useLedgerData } from '../context/LedgerContext'
import { AuthGate } from './AuthGate'
import { AccountModal } from './AccountModal'
import { DuplicatePersonBanner } from './DuplicatePersonBanner'
import { HeaderAccessoryContext } from './HeaderAccessory'
import { SyncControlsContext, type SyncControls } from './syncControls'
import { LegacyDataMigration } from './LegacyDataMigration'
import { LEDGER_STREAM, POWERSYNC_DB_FILENAME, powerSyncConnector, powerSyncDb } from '../lib/powersync/database'
import { clearHouseholdCache, getHouseholdId } from '../lib/powersync/household'
import { justJoinedKey } from '../lib/powersync/linking'
import { powerSyncAdapter } from '../lib/powersync/powerSyncAdapter'
import { maybeUploadDailySnapshot } from '../lib/powersync/backup'
import { createPowerSyncLedgerStore, type PowerSyncLedgerStore } from '../lib/store/powerSyncLedgerStore'

export const LAST_USER_KEY = `ledger:sync:db-user:${POWERSYNC_DB_FILENAME}`
export const primaryPersonKey = (userId: string) => `ledger:sync:primary-person:${POWERSYNC_DB_FILENAME}:${userId}`

export default function SyncRoot({ children }: { children: (store: LedgerStore, extras: ReactNode) => ReactNode }) {
  return (
    <AuthProvider>
      <Gate>{children}</Gate>
    </AuthProvider>
  )
}

function Gate({ children }: { children: (store: LedgerStore, extras: ReactNode) => ReactNode }) {
  const { session } = useAuth()
  if (session === undefined) return <FullScreen title="Shared Ledger" line="Checking sign-in…" />
  if (session === null) return <AuthGate />
  return (
    <SignedIn key={session.user.id} userId={session.user.id} email={session.user.email ?? ''}>
      {children}
    </SignedIn>
  )
}

type Phase =
  | { kind: 'starting'; line: string }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; store: PowerSyncLedgerStore; current: AppDataV2 }
  | { kind: 'claim'; store: PowerSyncLedgerStore; current: AppDataV2 }
  | { kind: 'ready'; store: PowerSyncLedgerStore }

function SignedIn({ userId, email, children }: { userId: string; email: string; children: (store: LedgerStore, extras: ReactNode) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting', line: 'Finding your household…' })
  const [householdId, setHouseholdId] = useState('')
  const [attempt, setAttempt] = useState(0)
  const restartLine = useRef('Syncing your household…')

  const restart = (line?: string) => {
    restartLine.current = line ?? 'Syncing your household…'
    setPhase({ kind: 'starting', line: restartLine.current })
    void (async () => {
      await powerSyncDb.disconnectAndClear()
      clearHouseholdCache()
      setAttempt((a) => a + 1)
    })()
  }

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    ;(async () => {
      try {
        const hh = await getHouseholdId(userId)
        if (cancelled) return
        setHouseholdId(hh)

        let lastUser: string | null = null
        try {
          lastUser = localStorage.getItem(LAST_USER_KEY)
        } catch {
          /* private mode: treat as unknown */
        }
        if (lastUser !== userId) {
          setPhase({ kind: 'starting', line: 'Preparing this device…' })
          await powerSyncDb.disconnectAndClear()
          try {
            localStorage.setItem(LAST_USER_KEY, userId)
          } catch {
            /* ignore */
          }
        }

        setPhase({ kind: 'starting', line: restartLine.current })
        await powerSyncDb.connect(powerSyncConnector, { includeDefaultStreams: false })
        const sub = await powerSyncDb.syncStream(LEDGER_STREAM).subscribe()
        unsubscribe = () => sub.unsubscribe()
        const firstSync = sub.waitForFirstSync()
        const store = createPowerSyncLedgerStore({
          db: powerSyncAdapter(powerSyncDb),
          householdId: hh,
          userId,
          firstSync,
          storageKey: primaryPersonKey(userId),
          // Deleted on another device, or moved by a link code redeemed
          // elsewhere: drop this device's copy, including anything queued for
          // the old household, and boot again so ensure_household() gives the
          // current one.
          onHouseholdLost: () => {
            if (cancelled) return
            restart('Your household changed on another device. Syncing again…')
          },
        })
        const current = await store.load() // resolves only after first sync
        if (cancelled || !current) return
        restartLine.current = 'Syncing your household…'
        if (current.people.length === 0) return setPhase({ kind: 'empty', store, current })
        // Just joined, brought nothing, and no row is linked to me yet: ask
        // which person is me once, rather than leaving the partner's
        // dashboard showing (it resolves to the first person otherwise).
        if (justJoined(userId) && store.linkedPersonId === null) {
          return setPhase({ kind: 'claim', store, current })
        }
        setPhase({ kind: 'ready', store })
      } catch (err) {
        console.error('[sync] could not start', err)
        if (!cancelled) setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
      void powerSyncDb.disconnect()
    }
  }, [userId, attempt])

  const controls: SyncControls = {
    userId,
    email,
    householdId,
    restart,
    forceSync: async () => {
      await powerSyncDb.disconnect()
      await powerSyncDb.connect(powerSyncConnector, { includeDefaultStreams: false })
    },
  }

  const floatingAccount = <AccountButton floating />

  return (
    <SyncControlsContext.Provider value={controls}>
      {phase.kind === 'starting' && <FullScreen title="Shared Ledger" line={phase.line} spinner>{floatingAccount}</FullScreen>}
      {phase.kind === 'error' && (
        <FullScreen title="Couldn't start syncing" line={phase.message}>
          <button onClick={() => setAttempt((a) => a + 1)} className="mt-6 px-5 py-2.5 rounded-2xl text-sm font-semibold text-[var(--color-surface)] bg-[var(--color-ink)]">
            Try again
          </button>
          {floatingAccount}
        </FullScreen>
      )}
      {phase.kind === 'empty' && (
        <>
          <LegacyDataMigration
            store={phase.store}
            current={phase.current}
            userId={userId}
            onDone={() => setPhase({ kind: 'ready', store: phase.store })}
            onJoined={(line) => restart(line)}
          />
          {floatingAccount}
        </>
      )}
      {phase.kind === 'claim' && (
        <>
          <WhichPersonAmI store={phase.store} current={phase.current} userId={userId} onDone={() => setPhase({ kind: 'ready', store: phase.store })} />
          {floatingAccount}
        </>
      )}
      {phase.kind === 'ready' && (
        <HeaderAccessoryContext.Provider value={<AccountButton />}>
          <LedgerErrorBoundary>
            {children(
              phase.store,
              <>
                <DuplicatePersonBanner userId={userId} />
                <DailyBackup userId={userId} />
              </>,
            )}
          </LedgerErrorBoundary>
        </HeaderAccessoryContext.Provider>
      )}
    </SyncControlsContext.Provider>
  )
}

const justJoined = (userId: string) => {
  try {
    return localStorage.getItem(justJoinedKey(userId)) !== null
  } catch {
    return false
  }
}
const forgetJustJoined = (userId: string) => {
  try {
    localStorage.removeItem(justJoinedKey(userId))
  } catch {
    /* ignore */
  }
}

/**
 * Straight after joining a household with nothing of your own: which of these people is you?
 * Choosing writes people.linked_user_id through the store ("Set as me"), so every device of yours
 * resolves to that person from then on.
 */
function WhichPersonAmI({ store, current, userId, onDone }: { store: PowerSyncLedgerStore; current: AppDataV2; userId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const choose = async (id: string) => {
    setBusy(true)
    store.save({ ...current, primaryPersonId: id }, current)
    await store.flush()
    forgetJustJoined(userId)
    onDone()
  }
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center overflow-y-auto px-5 py-6" style={{ background: 'var(--color-bg)' }}>
      <div className="w-full max-w-[360px] mx-auto text-center">
        <div className="font-display text-2xl font-bold text-[var(--color-ink)] mb-2">You're in</div>
        <p className="text-sm text-[var(--color-ink-muted)] mb-6">Which of these is you? Your dashboard, pay cycle and personal bills follow this choice, on every device you sign in on.</p>
        <div className="space-y-2">
          {current.people.map((p) => (
            <button
              key={p.id}
              disabled={busy}
              onClick={() => void choose(p.id)}
              className="w-full py-3 rounded-2xl font-semibold text-sm text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-60"
            >
              {p.name}
            </button>
          ))}
          <button
            disabled={busy}
            onClick={() => (forgetJustJoined(userId), onDone())}
            className="w-full py-3 rounded-2xl font-medium text-sm text-[var(--color-ink)] disabled:opacity-60"
            style={{ background: 'var(--color-surface)' }}
          >
            I'll do this later
          </button>
        </div>
        <p className="text-[11px] text-[var(--color-ink-faint)] mt-4">You can change it any time in Wallet → People → Set as me.</p>
      </div>
    </div>
  )
}

/** One cloud snapshot a day, silently (BUILD-PLAN 4.5). Inside the ledger, so it has the data. */
function DailyBackup({ userId }: { userId: string }) {
  const { data } = useLedgerData()
  const attempted = useRef(false)
  useEffect(() => {
    if (attempted.current || data.people.length === 0) return
    attempted.current = true
    void maybeUploadDailySnapshot(userId, data)
  }, [userId, data])
  return null
}

/**
 * A render error in the ledger used to blank the whole page, Account button
 * included (UAT 2026-09-19, step 4). This shows what broke, and the Account
 * button (rendered by this boundary's fallback) stays usable.
 */
class LedgerErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[sync] the ledger crashed while rendering', error, info.componentStack)
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="fixed inset-0 z-[10000] overflow-y-auto px-5 py-10" style={{ background: 'var(--color-bg)' }}>
        <div className="max-w-md mx-auto">
          <div className="font-display text-xl font-bold text-[var(--color-ink)] mb-2">Something in the ledger crashed</div>
          <p className="text-sm text-[var(--color-ink-muted)] mb-3">Your data is safe on the server. Please copy the text below and send it over.</p>
          <pre className="text-[11px] leading-snug whitespace-pre-wrap break-words rounded-xl p-3 text-[var(--color-ink)] select-all" style={{ background: 'var(--color-surface)' }}>
            {`${error.name}: ${error.message}\n\n${(error.stack ?? '').split('\n').slice(0, 12).join('\n')}`}
          </pre>
          <button onClick={() => window.location.reload()} className="mt-4 w-full py-3 rounded-2xl font-semibold text-[var(--color-surface)] bg-[var(--color-ink)]">
            Reload
          </button>
        </div>
        <AccountButton floating />
      </div>
    )
  }
}

function FullScreen({ title, line, spinner, children }: { title: string; line: string; spinner?: boolean; children?: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[10000] flex flex-col items-center justify-center px-6 text-center" style={{ background: 'var(--color-bg)' }}>
      <div className="font-display text-2xl font-bold text-[var(--color-ink)] mb-3">{title}</div>
      {spinner && <div className="w-6 h-6 mb-3 rounded-full border-2 border-[var(--color-track)] border-t-[var(--color-coral)] animate-spin" />}
      <p className="text-sm text-[var(--color-ink-muted)] max-w-[320px] break-words">{line}</p>
      {children}
    </div>
  )
}

/**
 * In the Wallet header (HeaderAccessory) once the ledger is up, where it scrolls with the page and
 * sits beside People; floating on the boot screens, which have no header. Inside the ledger it hands
 * the modal the ledger itself, which is what Cloud Backup's Back Up Now / Restore need.
 */
function AccountButton({ floating }: { floating?: boolean }) {
  const [open, setOpen] = useState(false)
  const button = (
    <button
      onClick={() => setOpen(true)}
      aria-label="Account"
      className={
        floating
          ? 'fixed z-[10001] w-8 h-8 rounded-full flex items-center justify-center border'
          : 'w-9 h-9 rounded-full flex items-center justify-center'
      }
      style={
        floating
          ? { top: 'calc(var(--safe-top, 0px) + 6px)', right: 12, background: 'var(--color-bg-elevated)', borderColor: 'var(--color-track)' }
          : { background: 'var(--color-surface)' }
      }
    >
      <User size={floating ? 15 : 18} className={floating ? 'text-[var(--color-ink-muted)]' : 'text-[var(--color-ink)]'} />
    </button>
  )
  return (
    <>
      {floating ? createPortal(button, document.body) : button}
      {open && (floating ? <AccountModal onClose={() => setOpen(false)} /> : <AccountModalWithLedger onClose={() => setOpen(false)} />)}
    </>
  )
}

/** Inside the ledger: the modal gets the data and setData (Cloud Backup). */
function AccountModalWithLedger({ onClose }: { onClose: () => void }) {
  const { data, setData } = useLedgerData()
  return <AccountModal ledger={{ data, setData }} onClose={onClose} />
}

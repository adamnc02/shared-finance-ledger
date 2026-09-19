// SYNC APP ONLY. Ported from personal-f (main 90794ea) unchanged (same import
// paths here). PROMPT-09 pulled it forward into the test app's /sync/
// build (Adam, 2026-09-19, §0.1 Q2 option A); PROMPT-10 brings it to
// shared-finance-ledger.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, AUTH_PROVIDERS } from '../lib/supabaseClient'
import { clearHouseholdCache } from '../lib/powersync/household'

interface AuthContextValue {
  /** undefined = not checked yet, null = checked & signed out, Session = signed in.
   *  Same three-state shape as BLOC's `_authResolvedSession` — the app shell
   *  waits on `undefined` before rendering anything, same as BLOC's
   *  `maybeFinalizeBoot()` waits on it before revealing the app past the gate. */
  session: Session | undefined | null
  authMode: 'signin' | 'signup'
  setAuthMode: (mode: 'signin' | 'signup') => void
  signInWithGoogle: () => Promise<void>
  submitEmailAuth: (email: string, password: string) => Promise<{ needsConfirmation: boolean } | void>
  sendPasswordReset: (email: string) => Promise<void>
  signOut: () => Promise<void>
  updatePassword: (newPassword: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | undefined | null>(undefined)
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')

  useEffect(() => {
    // Mirrors BLOC's initSupabaseAuth(): resolve the current session once,
    // then keep listening for changes (sign-in, sign-out, token refresh).
    // The first onAuthStateChange callback fires synchronously with the
    // same session getSession() already returned — harmless duplicate
    // set, not worth guarding against, same as BLOC's own comment on this.
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.warn('[auth] session check failed:', error.message)
        setSession(null)
        return
      }
      setSession(data.session ?? null)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  const signInWithGoogle = async () => {
    const cfg = AUTH_PROVIDERS.find((p) => p.id === 'google')
    if (!cfg) return
    const { error } = await supabase.auth.signInWithOAuth({
      provider: cfg.provider,
      // Explicit redirectTo — same fix confirmed working in my-dream-clean's
      // real deployment (per HANDOFF.md; BLOC's own version of this fix was
      // never actually run in a browser, so MDC is the proven reference,
      // not BLOC). Without it, the redirect silently depends on the
      // dashboard's Site URL matching this app's actual deployed path.
      options: { redirectTo: window.location.href },
    })
    if (error) throw error
    // Redirect-based flow — browser navigates away; nothing further here.
  }

  const submitEmailAuth: AuthContextValue['submitEmailAuth'] = async (email, password) => {
    if (!email || !password) {
      throw new Error('Enter both an email and a password.')
    }
    if (authMode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.href },
      })
      if (error) throw error
      if (!data.session) {
        // Email confirmation is on — no session until they confirm.
        setAuthMode('signin')
        return { needsConfirmation: true }
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
    }
  }

  const sendPasswordReset = async (email: string) => {
    if (!email) throw new Error('Enter your email above first.')
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.href })
    if (error) throw error
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) console.warn('[auth] sign-out failed:', error.message)
    clearHouseholdCache()
    // onAuthStateChange fires with a null session and the gate reappears.
    // Local data is left completely untouched, same as BLOC — a sign-out
    // never clears on-device state.
  }

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) throw error
  }

  return (
    <AuthContext.Provider
      value={{ session, authMode, setAuthMode, signInWithGoogle, submitEmailAuth, sendPasswordReset, signOut, updatePassword }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

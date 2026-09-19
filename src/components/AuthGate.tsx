// SYNC APP ONLY. Ported from personal-f (main 90794ea) as-is apart from the
// title. PROMPT-09 pulled it forward into the test app's /sync/ build.
import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { AUTH_PROVIDERS } from '../lib/supabaseClient'

/** Same multi-color "G" mark BLOC and My Dream Clean both use, for visual
 *  consistency across all three apps — identical SVG paths, just JSX
 *  instead of an innerHTML string (BLOC's AUTH_PROVIDERS carries the icon
 *  as a raw SVG string it injects via innerHTML; React renders it as a
 *  real element instead, same visual result). */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18">
      <path fill="#4285F4" d="M23.52 12.27c0-.82-.07-1.6-.2-2.36H12v4.47h6.47c-.28 1.5-1.13 2.77-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.73z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.1C3.24 21.3 7.28 24 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.29c-.24-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29v-3.1H1.26A11.96 11.96 0 0 0 0 12c0 1.94.46 3.77 1.26 5.39l4.01-3.1z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0 7.28 0 3.24 2.7 1.26 6.61l4.01 3.1C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  )
}

/** Keyed by AUTH_PROVIDERS' `id` — same "one-line addition, no markup
 *  change" intent as BLOC's config array. Add Apple/Microsoft's icon here
 *  when either provider is actually added, nothing else needs to change. */
const PROVIDER_ICONS: Record<string, () => React.ReactElement> = {
  google: GoogleIcon,
}

/**
 * Full-screen mandatory sign-in, shown whenever `session` is `null`
 * (checked and signed out) — never for `undefined` (still checking), which
 * the caller in App.tsx handles separately so there's no signed-out flash
 * for an already-authenticated returning user. Structurally the same flow
 * as BLOC's #auth-gate: OAuth buttons, a Sign In/Sign Up tab pair, an
 * email/password form, and a Forgot Password link — same fields, same
 * autocomplete-swap-on-mode-change behavior (see the `autoComplete` prop
 * below), just React state instead of direct DOM manipulation.
 */
export function AuthGate() {
  const { authMode, setAuthMode, signInWithGoogle, submitEmailAuth, sendPasswordReset } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const switchMode = (mode: 'signin' | 'signup') => {
    setAuthMode(mode)
    setError(null)
    setStatus(null)
  }

  const handleGoogle = async () => {
    setError(null)
    try {
      await signInWithGoogle()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed. Please try again.')
    }
  }

  const handleSubmit = async () => {
    setError(null)
    setStatus(null)
    setSubmitting(true)
    try {
      const result = await submitEmailAuth(email.trim(), password)
      if (result?.needsConfirmation) {
        setStatus('Check your email to confirm your account, then sign in.')
      }
      // Otherwise: onAuthStateChange picks up the new session and the
      // gate unmounts on its own — nothing further to do here.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleForgotPassword = async () => {
    setError(null)
    setStatus(null)
    try {
      await sendPasswordReset(email.trim())
      setStatus('Password reset email sent.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send reset email.')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center overflow-y-auto px-5 py-6"
      style={{ background: 'var(--color-bg)' }}
    >
      <div className="w-full max-w-[360px] mx-auto">
        <div className="font-display text-3xl font-extrabold text-center tracking-wide text-[var(--color-ink)] mb-8">
          Shared Ledger
        </div>

        <div className="space-y-2 mb-5">
          {AUTH_PROVIDERS.map((p) => {
            const Icon = PROVIDER_ICONS[p.id]
            return (
              <button
                key={p.id}
                type="button"
                onClick={handleGoogle}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl font-medium text-sm text-[var(--color-ink)]"
                style={{ background: 'var(--color-surface)' }}
              >
                {Icon && <Icon />}
                {p.label}
              </button>
            )
          })}
        </div>

        <div className="flex items-center gap-3 mb-5">
          <div className="flex-1 h-px" style={{ background: 'var(--color-track)' }} />
          <span className="text-xs text-[var(--color-ink-muted)]">or</span>
          <div className="flex-1 h-px" style={{ background: 'var(--color-track)' }} />
        </div>

        <div className="flex rounded-full p-1 mb-5" style={{ background: 'var(--color-track)' }}>
          <button
            type="button"
            onClick={() => switchMode('signin')}
            className={`flex-1 py-1.5 text-sm font-medium rounded-full ${authMode === 'signin' ? 'bg-[var(--color-surface)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => switchMode('signup')}
            className={`flex-1 py-1.5 text-sm font-medium rounded-full ${authMode === 'signup' ? 'bg-[var(--color-surface)] text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'}`}
          >
            Sign Up
          </button>
        </div>

        {/* A real <form> (not bare inputs) for the same reason as BLOC's own
            comment: without a <form> boundary, iOS Safari can't scope its
            password AutoFill bar to just these fields. */}
        <form onSubmit={(e) => e.preventDefault()} className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            inputMode="email"
            className="w-full text-sm py-3 px-4 rounded-2xl outline-none text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            // Same autocomplete swap as BLOC's setAuthMode(): 'current-password'
            // tells iOS to fill a saved credential, 'new-password' tells it to
            // offer/suggest a strong one and prompt to save — without this,
            // Sign Up never gets the suggest/save prompt.
            autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'}
            className="w-full text-sm py-3 px-4 rounded-2xl outline-none text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          />

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full py-3 rounded-2xl font-semibold text-[var(--color-surface)] bg-[var(--color-ink)] disabled:opacity-60"
          >
            {submitting ? '…' : authMode === 'signin' ? 'Sign In →' : 'Sign Up →'}
          </button>

          {authMode === 'signin' && (
            <button
              type="button"
              onClick={handleForgotPassword}
              className="w-full text-center text-xs text-[var(--color-ink-muted)]"
            >
              Forgot password?
            </button>
          )}
        </form>

        {error && <p className="text-xs text-[var(--color-negative)] mt-3 text-center">{error}</p>}
        {status && <p className="text-xs text-[var(--color-positive)] mt-3 text-center">{status}</p>}
      </div>
    </div>
  )
}

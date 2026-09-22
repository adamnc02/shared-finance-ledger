/**
 * SYNC APP ONLY. Which low-balance-alerts state a device is in — pure, so
 * `scripts/verify-notification-toggle.ts` can prove every case without a phone.
 * Adapted from Listly's `src/lib/pushState.ts`, the worked example PROMPT-14
 * §7.1 says to recycle the shape of.
 *
 * 🚨 IT BRANCHES ON `Notification.permission`, NEVER ON TOGGLE HISTORY.
 * Adam's framing — "toggling on a second time instructs users where to go in
 * settings" — is right only when the OS permission is actually DENIED.
 * Toggling the app switch off does NOT revoke it, so the common case is that
 * permission is still 'granted' and toggling back on should just work,
 * silently. Sending someone to Settings when nothing is wrong there is worse
 * than useless.
 *
 * 🚨 THE STATE IS PER DEVICE, NOT PER USER. A subscription belongs to one
 * device; a user-level "notifications on" flag would render ON on a second
 * phone that has never registered, and that phone would then silently receive
 * nothing. A device reads 'on' ONLY when the server has its registration too —
 * a local subscription whose row was removed from another device, or pruned as
 * dead by the alert job, alerts nobody, and must say so.
 *
 * 🚨 There is no email fallback, ever (no domain, no paid plan), so a device
 * that cannot receive push receives nothing at all. That is why this
 * distinguishes five ways of being off rather than one.
 */
export type PushState =
  /** No service worker / PushManager / Notification at all. */
  | 'unsupported'
  /** An iPhone or iPad, but not opened from the Home Screen. */
  | 'needs-install'
  /** The user said no. Only the phone's own Settings can undo it. */
  | 'denied'
  /** Never asked on this device. */
  | 'ask'
  /** Permission granted, but this device is not registered for alerts. */
  | 'off'
  /** This device is registered and will get the 8pm alerts. */
  | 'on'

export interface DeviceFacts {
  ios: boolean
  standalone: boolean
  supported: boolean
  permission: 'default' | 'granted' | 'denied'
  /** This browser's own subscription, as a row id — null if it has none. */
  hereId: string | null
  /** This account's rows in push_subscriptions. */
  registeredIds: string[]
}

export function decidePushState(f: DeviceFacts): PushState {
  // First: in a Safari tab on iOS, PushManager does not exist at all, so
  // this has to be asked before "supported" or it would read as a browser
  // that can never do it — when three taps would fix it.
  if (f.ios && !f.standalone) return 'needs-install'
  if (!f.supported) return 'unsupported'
  if (f.permission === 'denied') return 'denied'
  if (f.permission === 'default') return 'ask'
  return f.hereId !== null && f.registeredIds.includes(f.hereId) ? 'on' : 'off'
}

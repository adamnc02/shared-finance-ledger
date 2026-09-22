/*
 * Shared Ledger's service worker — push notifications and nothing else.
 *
 * 🚨 A SEPARATE REGISTRATION FROM LISTLY'S, and it has to be. A push
 * subscription belongs to a service worker registration, which is per SCOPE:
 * /listly/ and /shared-finance-ledger/ are different registrations on the same
 * origin and get different subscriptions. (Notification PERMISSION is per
 * ORIGIN and IS shared, which is why a phone that already allowed Listly is
 * never prompted here.)
 *
 * 🚨 THERE IS NO `fetch` HANDLER, AND THERE MUST NEVER BE ONE WITHOUT A PLAN.
 * A service worker that caches is how a PWA gets permanently stuck on an old
 * build: the cached index.html keeps loading the cached bundle, and no deploy
 * reaches the phone. With no fetch handler this worker never sees a request,
 * so every load goes to the network exactly as it did before it existed
 * (PROMPT-14 Part 7). Shared Ledger is offline-first through PowerSync's local
 * database, not through a cache — it has no need of one.
 *
 * `skipWaiting` + `clients.claim` so a changed sw.js takes over at once
 * rather than waiting for every Shared Ledger window to close, which on an installed
 * iPhone app can be days.
 *
 * Plain JS in public/ on purpose: it is served as-is at /shared-finance-ledger/sw.js, with
 * scope /shared-finance-ledger/, and never goes through the bundler.
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// 🚨 iOS requires every push to show a notification. A push handled without
// one counts against the site, and repeated silent pushes get its permission
// revoked — so this always shows something, even for a payload it cannot read.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Shared Ledger'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : 'You have a low balance coming up.',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: 'icon-192.png',
      data: { url: typeof data.url === 'string' ? data.url : self.registration.scope },
    }),
  )
})

// Tapping the notification opens Shared Ledger on the right tab. An open Shared Ledger
// window is reused rather than a second one opened — a second window would
// fight the first for PowerSync's on-device database, which on iOS only one
// can hold.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || self.registration.scope, self.registration.scope)
  // Only ever somewhere inside Shared Ledger.
  const url = target.href.startsWith(self.registration.scope) ? target.href : self.registration.scope
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (w.url.startsWith(self.registration.scope)) {
          w.postMessage({ type: 'ledger:open', url })
          return w.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})

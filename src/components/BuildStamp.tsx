// Which build this device is running: the commit and the time it was built,
// at the foot of the Wallet page.
//
// A device can keep running an old build for weeks — a home-screen app that is
// never fully closed does not reload — and in the sync app that device keeps
// writing to the shared household with the old rules. Its writes carry no
// trace of their build: an UPDATE keeps the row's original `user_id`. This
// line is how to tell, by looking at each phone, which build each is on.
//
// `__BUILD_ID__` is replaced at build time by vite.config.ts (`define`).

declare const __BUILD_ID__: string

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

export function BuildStamp() {
  return <p className="text-[10px] text-[var(--color-ink-faint)] mt-4 text-center tabular-nums">Build {BUILD_ID}</p>
}

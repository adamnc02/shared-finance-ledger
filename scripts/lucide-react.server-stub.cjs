// SYNC APP ONLY, build-time only. What `lucide-react` becomes inside the
// ledger-alerts Edge Function bundle (scripts/alertEngineBundle.ts).
//
// WHY THIS EXISTS. The projection engine reaches `src/lib/categories.ts`
// (through ledgerStorage's migrateLedgerData), which imports BILL_ICONS from
// billIcons.ts, which imports 35 icon COMPONENTS from lucide-react. But
// categories.ts only ever uses the object's KEYS — `icon in BILL_ICONS`,
// `Object.keys(BILL_ICONS)` — and the keys come from billIcons.ts's own object
// literal, not from lucide. The components themselves are never read on the
// server, and never can be: there is no DOM there to render one into.
//
// Without this, bundling the engine drags lucide-react AND React into a
// server function that renders nothing — hundreds of kB of UI on the cold
// start of a job whose entire output is a push notification.
//
// A Proxy rather than a list of 35 names on purpose: an icon added to
// billIcons.ts later must not break the alert build. CommonJS rather than ESM
// on purpose too — esbuild checks named exports against an ESM module at build
// time and would reject a Proxy, whereas a CJS namespace is read at runtime.
//
// 🚨 If something on the alert path ever genuinely needs to RENDER an icon,
// this stub is not the thing to fix: the alert path should not be rendering.
const placeholder = () => null
module.exports = new Proxy(
  { __esModule: true, default: placeholder },
  {
    get: (target, prop) => (prop in target ? target[prop] : placeholder),
    has: () => true,
  },
)

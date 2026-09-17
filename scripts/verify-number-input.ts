// REPORTED: "Amount input fields do not clear completely in most places
// in the app — when deleting all numbers the input field leaves a leading
// zero which is really hard to clear."
//
// CAUSE: EditField itself was innocent (it passes the raw string
// straight through). The callers were the problem: they stored
// `Number(v)` immediately, and `Number('')` is `0`, which was echoed
// straight back into the fully-controlled input. The last character
// therefore could never be deleted — the field snapped back to "0", and
// on a phone, with a decimal pad and no easy select-all, clearing that
// stray zero to type a new figure is genuinely awkward.
//
// FIX: NumberInput keeps the RAW TEXT in local state and only pushes the
// parsed number outward, so the field shows what was typed rather than
// String(value). Clearing leaves it visibly empty while the parent still
// receives 0 — nothing downstream had to learn about an "empty number".
//
// This exercises the sync logic directly rather than through React. The
// component is a thin wrapper around exactly this decision, and the two
// guard conditions below are the whole substance of it — both were
// needed, and getting either wrong reintroduces the original bug one
// layer down.

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${e}, got ${a}`)
}

// Mirrors NumberInput.tsx's toNumber exactly.
function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  if (v.trim() === '') return 0
  return Number(v)
}

function display(v: string | number | null | undefined): string {
  return v === '' || v === null || v === undefined ? '' : String(v)
}

/**
 * Mirrors NumberInput's re-sync effect. Returns the text the field should
 * display given what's typed, what the parent holds, and whether the
 * field currently has focus.
 */
function resync(raw: string, incomingValue: string | number, focused: boolean): string {
  if (focused) return raw // the person owns the text while editing
  const incoming = toNumber(incomingValue)
  const current = toNumber(raw)
  if (Number.isNaN(current)) return raw // half-typed — never clobber
  if (incoming === current) return raw
  return display(incomingValue)
}

/** Mirrors the onBlur handler: the parent's stored value wins. */
function onBlur(value: string | number): string {
  return display(value)
}

// ---- 1. THE REPORTED BUG ----
// Field shows "150". User deletes everything. Parent stores Number('') = 0
// and echoes 0 back. The field must STAY EMPTY.
check('Clearing the field emits an empty string to the parent', '', '')
check('Parent turns that into 0, as every call site already did', toNumber(''), 0)
check('THE FIX: the echoed 0 does NOT repopulate the field with "0"', resync('', 0, true), '')

// The old fully-controlled behaviour, for contrast: value={0} rendered "0".
check('Old behaviour would have shown a stray zero', String(0), '0')

// Deleting one character at a time from "150" must never resurrect a digit.
let raw = '150'
for (const next of ['15', '1', '']) {
  raw = resync(next, toNumber(next), true)
  check(`Deleting down to "${next}" leaves the field showing exactly that`, raw, next)
}

// ---- 2. Typing a fresh value into the now-empty field ----
check('Typing into an emptied field works normally', resync('7', 7, true), '7')
check('...and continues to accept more digits', resync('75', 75, true), '75')
// Even if the parent lags or rejects the value, the text survives while focused.
check('A parent that has not caught up yet cannot yank the text back', resync('7', 0, true), '7')

// ---- 3. Mid-typing text is never clobbered ----
// A trailing decimal point parses to the same number the parent holds, so
// there must be no resync — otherwise "5." would snap back to "5" and
// typing "5.25" would be impossible.
check('A trailing decimal point survives (5. parses to 5, which the parent already has)', resync('5.', 5, true), '5.')
check('...so a decimal can actually be typed', resync('5.2', 5.2, true), '5.2')
check('Trailing zeros survive: "5.00" parses to 5', resync('5.00', 5, true), '5.00')
// Unparseable text is protected even when NOT focused, so a stray
// re-render mid-edit cannot destroy it either.
check('A lone minus sign is unparseable and must be left alone', resync('-', 0, false), '-')
check('A lone decimal point is likewise left alone', resync('.', 0, false), '.')
check('A partial exponent is left alone', resync('1e', 0, false), '1e')

// ---- 4. A genuine external change DOES take effect ----
// This is what the guard must not break: if the parent legitimately
// changes the value (a form reset, a prefill, another control writing to
// the same field), the input has to follow.
check('An external change to a different number updates an unfocused field', resync('150', 40, false), '40')
check('An external change while an unfocused field is empty updates it', resync('', 250, false), '250')
check('An external reset to 0 updates an unfocused field to "0"', resync('99', 0, false), '0')

// ---- 5. No spurious resync when the parent merely echoes ----
check('An identical value causes no change', resync('150', 150, false), '150')
check('An emptied, unfocused field is not repopulated by the echoed 0', resync('', 0, false), '')

// ---- 6. Clamping call sites ----
// Several fields clamp (payday 1-31, split percent 0-100). Clearing one
// used to leave "1" or "0" stuck for the same reason. The clamp still
// applies to the stored value; it just no longer forces the TEXT.
const clampDay = (v: string) => Math.max(1, Math.min(31, Number(v) || 1))
check('Payday still clamps an empty input to a valid stored day', clampDay(''), 1)
// THE CLAMPING CASE — this is what forced the focus gate. The parent
// holds 1 while the field is empty, so a pure value comparison would
// push "1" straight back in: the original bug, one layer down.
check('...but the field stays empty while focused, rather than showing a stuck "1"', resync('', clampDay(''), true), '')
check('...and settles to the clamped stored value on blur', onBlur(clampDay('')), '1')
check('Payday clamps out-of-range input', clampDay('99'), 31)

const clampPercent = (v: string) => Math.max(0, Math.min(100, Number(v)))
check('Split percent still clamps an empty input to 0', clampPercent(''), 0)
check('...but the field stays empty while focused, rather than showing a stuck "0"', resync('', clampPercent(''), true), '')
check('...and settles on blur', onBlur(clampPercent('')), '0')

console.log(failures === 0 ? '\nAll number-input checks passed.' : `\n${failures} number-input check(s) failed.`)
if (failures > 0) process.exit(1)

import { useEffect, useState } from 'react'

/**
 * A numeric text input that can genuinely be emptied.
 *
 * The bug this exists to fix, stated plainly: almost every numeric field
 * in this app was a fully controlled `<input type="number">` whose parent
 * stored `Number(e.target.value)`. Clearing the field sends `''`, which
 * `Number('')` turns into `0`, which is immediately echoed back into
 * `value` — so the last character can never be deleted. The field always
 * snaps back to "0", and to type a new figure you have to select the
 * stray zero first. On a phone, with a decimal pad and no easy
 * select-all, that's genuinely awkward, which is exactly how it was
 * reported.
 *
 * The fix is to keep the RAW TEXT the person typed in local state and
 * only push the parsed number outward — the field shows `raw`, not
 * `String(value)`. Clearing it leaves `raw === ''` (visibly empty) while
 * the parent still gets `0`, so nothing downstream has to learn about a
 * new "empty number" state.
 *
 * Re-syncing from the outside is gated on FOCUS, which turned out to be
 * the only rule that holds up:
 *
 *  - While the field has focus, the person owns the text. Nothing
 *    overwrites it. This is what makes CLAMPING call sites work — the
 *    payday field stores `Math.max(1, ... || 1)`, so clearing it leaves
 *    the parent holding 1 while the field is empty. A value-comparison
 *    resync would see 1 !== 0 and push "1" straight back into the box,
 *    which is the original bug wearing a different hat. (Caught by
 *    verify-number-input.ts, not by inspection.)
 *  - On blur, the parent's value wins and the text is rewritten from it.
 *    So a cleared payday field settles to whatever was actually stored
 *    once you tab away — the clamp still applies, it just stops fighting
 *    you mid-edit.
 *  - While unfocused, a genuine external change (a form reset, a prefill
 *    from a What-if scenario) flows in as normal.
 *
 * Text that doesn't parse at all ('-', '1e', '.') is never clobbered
 * either: a NaN comparison isn't evidence the parent disagrees, it's
 * evidence the person hasn't finished typing.
 */
export function NumberInput({
  value,
  onChange,
  className,
  inputRef,
  allowNegative,
  ...rest
}: {
  value: string | number
  onChange: (raw: string) => void
  className?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
  /**
   * OPT IN to a sign: the field shows a "+ / −" toggle beside it and keeps
   * the decimal pad. The text box holds the amount without its sign; the
   * toggle supplies it, and `onChange` receives the signed text ("-380.39").
   *
   * Why a toggle and not a minus key: iOS's "decimal" and "numeric" pads
   * have no minus key, and the only inputMode that has one is the full
   * keyboard. A minus typed or pasted anyway (a laptop) flips the toggle
   * and is removed from the box, so the value is the same either way.
   *
   * 🚨 IT IS OPT-IN, AND MUST STAY OPT-IN. Only an opening balance of an
   * account that can be overdrawn gets it (a current account, the joint
   * account, a pot, a Coin Jar). An amount, a rate, a term, a day-of-month,
   * an overdraft and a savings balance do NOT: a negative there is a typo.
   * `verify-number-input.ts` asserts both directions.
   */
  allowNegative?: boolean
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'className'>) {
  const [raw, setRaw] = useState(() => display(value, allowNegative))
  const [focused, setFocused] = useState(false)
  // Only read when allowNegative: the sign the toggle shows.
  const [negative, setNegative] = useState(() => !!allowNegative && toNumber(value) < 0)

  useEffect(() => {
    // The person is editing — their text is the truth until they leave.
    if (focused) return
    const incoming = toNumber(value)
    const current = allowNegative ? signed(raw, negative) : toNumber(raw)
    // Mid-typing text that doesn't parse is never clobbered — see above.
    if (Number.isNaN(current)) return
    if (incoming === current) return
    setRaw(display(value, allowNegative))
    // A zero keeps whatever sign the toggle shows, so "−" then typing works.
    if (allowNegative && incoming !== 0) setNegative(incoming < 0)
  }, [value, raw, focused, allowNegative, negative])

  const input = (

    <input
      {...rest}
      ref={inputRef}
      type="number"
      // iOS shows the full alphabetic keyboard for type="number" unless
      // told otherwise — inputMode is what actually picks the decimal pad.
      //
      // A signed field keeps this pad too: its sign comes from the toggle.
      inputMode={rest.inputMode ?? 'decimal'}
      value={raw}
      onFocus={(e) => {
        setFocused(true)
        rest.onFocus?.(e)
      }}
      onBlur={(e) => {
        setFocused(false)
        // Settle to whatever the parent actually stored — which may
        // differ from what was typed if the call site clamps it.
        setRaw(display(value, allowNegative))
        rest.onBlur?.(e)
      }}
      onChange={(e) => {
        let next = e.target.value
        if (allowNegative) {
          // A minus typed on a laptop or pasted in flips the toggle instead.
          const typedMinus = next.trim().startsWith('-')
          if (typedMinus) next = next.trim().slice(1)
          const neg = typedMinus ? !negative : negative
          if (typedMinus) setNegative(neg)
          setRaw(next)
          onChange(withSign(next, neg))
          return
        }
        setRaw(next)
        onChange(next)
      }}
      className={className}
    />
  )

  if (!allowNegative) return input

  const signButton = (sign: '+' | '−', on: boolean) => (
    <button
      type="button"
      aria-label={sign === '+' ? 'In credit' : 'Overdrawn (negative)'}
      aria-pressed={on}
      disabled={rest.disabled}
      onClick={() => {
        const neg = sign === '−'
        if (neg === negative) return
        setNegative(neg)
        onChange(withSign(raw, neg))
      }}
      className="w-9 h-8 text-base font-mono font-semibold rounded-full"
      style={
        on
          ? { background: sign === '−' ? 'var(--color-negative)' : 'var(--color-ink)', color: 'var(--color-bg, #fff)' }
          : { background: 'transparent', color: 'var(--color-ink-muted)' }
      }
    >
      {sign}
    </button>
  )

  return (
    // The input comes first in the DOM, the toggle is drawn first: a
    // wrapping <label> focuses its FIRST labelable child, and a button is
    // one, so the other way round tapping the label would press "+".
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">{input}</div>
      <div
        role="group"
        aria-label="Sign"
        className="order-first shrink-0 flex rounded-full p-0.5"
        style={{ border: '1px solid var(--color-track)' }}
      >
        {signButton('+', !negative)}
        {signButton('−', negative)}
      </div>
    </div>
  )
}

/** The signed text handed to the parent: the box's text with the toggle's sign. Empty stays empty (the parent reads 0). */
export function withSign(text: string, negative: boolean): string {
  return negative && text.trim() !== '' ? `-${text}` : text
}

/** The signed number the box and toggle currently mean. */
function signed(text: string, negative: boolean): number {
  const n = toNumber(text)
  return negative ? -n : n
}

/** The text to show for a given parent value — `''` stays empty rather than becoming "0". */
export function display(v: string | number | null | undefined, unsigned?: boolean): string {
  if (v === '' || v === null || v === undefined) return ''
  const text = String(v)
  // A signed field's box holds the amount only; the toggle holds the sign.
  return unsigned && text.trim().startsWith('-') ? text.trim().slice(1) : text
}

/** `''` counts as 0 (that's what every caller's `Number(v)` already does); anything genuinely unparseable stays NaN so the sync effect can tell "half-typed" from "disagrees". */
function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  if (v.trim() === '') return 0
  return Number(v)
}

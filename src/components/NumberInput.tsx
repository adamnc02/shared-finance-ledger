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
  ...rest
}: {
  value: string | number
  onChange: (raw: string) => void
  className?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'className'>) {
  const [raw, setRaw] = useState(() => display(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    // The person is editing — their text is the truth until they leave.
    if (focused) return
    const incoming = toNumber(value)
    const current = toNumber(raw)
    // Mid-typing text that doesn't parse is never clobbered — see above.
    if (Number.isNaN(current)) return
    if (incoming === current) return
    setRaw(display(value))
  }, [value, raw, focused])

  return (
    <input
      {...rest}
      ref={inputRef}
      type="number"
      // iOS shows the full alphabetic keyboard for type="number" unless
      // told otherwise — inputMode is what actually picks the decimal pad.
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
        setRaw(display(value))
        rest.onBlur?.(e)
      }}
      onChange={(e) => {
        const next = e.target.value
        setRaw(next)
        onChange(next)
      }}
      className={className}
    />
  )
}

/** The text to show for a given parent value — `''` stays empty rather than becoming "0". */
function display(v: string | number | null | undefined): string {
  return v === '' || v === null || v === undefined ? '' : String(v)
}

/** `''` counts as 0 (that's what every caller's `Number(v)` already does); anything genuinely unparseable stays NaN so the sync effect can tell "half-typed" from "disagrees". */
function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  if (v.trim() === '') return 0
  return Number(v)
}

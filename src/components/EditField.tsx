import { NumberInput } from './NumberInput'

interface EditFieldProps {
  label: string
  value: string | number
  onChange: (v: string) => void
  type?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
  disabled?: boolean
}

const INPUT_CLASS = 'w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono'

export function EditField({ label, value, onChange, type = 'text', inputRef, disabled }: EditFieldProps) {
  return (
    <label className={`flex flex-col gap-1 ${disabled ? 'opacity-40' : ''}`}>
      <span className="text-xs text-[var(--color-ink-muted)]">{label}</span>
      {type === 'number' ? (
        // Routed through NumberInput rather than a plain controlled
        // input so the field can actually be emptied — see that file's
        // header for the leading-zero bug this fixes. Every numeric
        // EditField in the app inherits the fix from here, which is why
        // it's applied at this level rather than call site by call site.
        <NumberInput value={value} onChange={onChange} className={INPUT_CLASS} inputRef={inputRef} disabled={disabled} />
      ) : (
        <input
          ref={inputRef}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={INPUT_CLASS}
          // Confirmed directly via real on-device measurements (not a
          // guess): iOS Safari renders a native `type="date"` input with
          // `box-sizing: content-box`, silently ignoring the page's CSS —
          // every OTHER input type on the same page correctly reports
          // `border-box`. Under content-box, the same declared vertical
          // padding gets ADDED on top of the height instead of eaten out of
          // it, which is exactly what measured as a 5px height mismatch
          // against sibling number inputs in the same row (38px vs 33px) —
          // the visible misalignment. This is a known WebKit quirk specific
          // to native date/time inputs' internal shadow-root rendering, not
          // something reachable by a plain CSS class — an inline style is
          // required to reliably win against it.
          style={type === 'date' ? { boxSizing: 'border-box', WebkitAppearance: 'none' } : undefined}
        />
      )}
    </label>
  )
}

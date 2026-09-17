import { NumberInput } from './NumberInput'

interface SplitEditorProps {
  people: { id: string; name: string }[]
  payee: string
  percent: number
  onChangePayee: (id: string) => void
  onChangePercent: (percent: number) => void
}

/** Person + share% editor, used wherever a joint cost (bill or loan) needs a split. */
export function SplitEditor({ people, payee, percent, onChangePayee, onChangePercent }: SplitEditorProps) {
  const others = people.filter((p) => p.id !== payee)
  const otherLabel = others.length === 1 ? others[0].name : others.map((p) => p.name).join(', ') || 'everyone else'

  return (
    <div className="col-span-2 grid grid-cols-2 gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Assigned to</span>
        <select
          value={payee}
          onChange={(e) => onChangePayee(e.target.value)}
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
        >
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Their share (%)</span>
        <NumberInput
          min={0}
          max={100}
          value={percent}
          onChange={(v) => onChangePercent(Math.max(0, Math.min(100, Number(v))))}
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
        />
      </label>
      <p className="col-span-2 text-xs text-[var(--color-ink-faint)] -mt-1">
        {percent >= 100 ? `${otherLabel} pays nothing` : `${otherLabel} gets ${100 - percent}%`}
      </p>
    </div>
  )
}

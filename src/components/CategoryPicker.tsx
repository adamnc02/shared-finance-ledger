import { useMemo, useState } from 'react'
import type { Category } from '../types/ledger'
import { CategoryIconPickerModal } from './CategoryIconPickerModal'
import { useWide } from '../lib/useWide'
import { useOptionalLedgerData } from '../context/LedgerContext'

/** How many category buttons a laptop picker shows before "More…". */
const LAPTOP_SHORTLIST = 5

interface CategoryPickerProps {
  categories: Category[]
  value: string
  onChange: (categoryId: string) => void
  onAddCategory: (name: string, overrides?: { icon?: string; iconColor?: string }) => { id: string }
  label?: string
}

export function CategoryPicker({ categories, value, onChange, onAddCategory, label = 'Category' }: CategoryPickerProps) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [pickingIcon, setPickingIcon] = useState(false)
  const sortedCategories = categories.slice().sort((a, b) => a.name.localeCompare(b.name))
  const wide = useWide()
  const [showAll, setShowAll] = useState(false)
  const ledger = useOptionalLedgerData()
  // Laptop shortlist: the categories used most, by the transactions and
  // recurring payments already in the ledger (alphabetical with no ledger
  // around it); the chosen one is always shown.
  const shortlist = useMemo(() => {
    const uses = new Map<string, number>()
    for (const t of ledger?.data.transactions ?? []) uses.set(t.categoryId, (uses.get(t.categoryId) ?? 0) + 1)
    for (const t of ledger?.data.recurringTemplates ?? []) uses.set(t.categoryId, (uses.get(t.categoryId) ?? 0) + 1)
    const top = categories
      .slice()
      .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || a.name.localeCompare(b.name))
      .slice(0, LAPTOP_SHORTLIST)
    const chosen = categories.find((c) => c.id === value)
    return chosen && !top.includes(chosen) ? [...top, chosen] : top
  }, [categories, value, ledger?.data.transactions, ledger?.data.recurringTemplates])

  const iconPicker = pickingIcon && (
    <CategoryIconPickerModal
      name={newName.trim()}
      categories={categories}
      onCancel={() => setPickingIcon(false)}
      onConfirm={(icon, iconColor) => {
        const created = onAddCategory(newName.trim(), { icon, iconColor })
        onChange(created.id)
        setNewName('')
        setAdding(false)
        setPickingIcon(false)
      }}
    />
  )

  // Laptop (lib/laptop.ts): the categories as buttons — the shortlist, then
  // "More…" for every other one — instead of a drop-down. Same value, same
  // onChange, same "+ New" flow.
  if (wide) {
    const chip = (on: boolean) => ({ background: on ? 'var(--color-coral)' : 'var(--color-surface-raised)', color: on ? '#fff' : 'var(--color-ink)' })
    const shown = showAll ? sortedCategories : shortlist
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-ink-muted)]">{label}</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
          {shown.map((c) => (
            <button key={c.id} type="button" onClick={() => onChange(c.id)} aria-pressed={c.id === value} className="h-9 px-3.5 rounded-full text-[13px] font-semibold" style={chip(c.id === value)}>
              {c.name}
            </button>
          ))}
          {sortedCategories.length > shortlist.length && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="h-9 px-3.5 rounded-full text-[13px] font-semibold" style={chip(false)}>
              {showAll ? 'Fewer' : 'More…'}
            </button>
          )}
          {!adding && (
            <button type="button" onClick={() => setAdding(true)} className="h-9 px-3.5 rounded-full text-[13px] font-semibold border border-dashed" style={{ borderColor: 'var(--color-track)', color: 'var(--color-coral)' }}>
              + New
            </button>
          )}
        </div>
        {adding && (
          <div className="flex items-center gap-2 mt-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Category name"
              className="flex-1 bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
            />
            <button type="button" onClick={() => newName.trim() && setPickingIcon(true)} className="text-xs font-medium shrink-0" style={{ color: 'var(--color-coral)' }}>
              Add
            </button>
            <button type="button" onClick={() => { setAdding(false); setNewName('') }} className="text-xs font-medium shrink-0 text-[var(--color-ink-muted)]">
              Cancel
            </button>
          </div>
        )}
        {iconPicker}
      </div>
    )
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-ink-muted)]">{label}</span>
      {!adding ? (
        <div className="flex items-center gap-2">
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {sortedCategories.map((c) => (
              <option key={c.id} value={c.id} style={{ color: '#000' }}>
                {c.name}
              </option>
            ))}
          </select>
          <button onClick={() => setAdding(true)} className="text-xs font-medium shrink-0" style={{ color: 'var(--color-coral)' }}>
            + New
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Category name"
            className="flex-1 bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          />
          <button
            onClick={() => {
              if (!newName.trim()) return
              setPickingIcon(true)
            }}
            className="text-xs font-medium shrink-0"
            style={{ color: 'var(--color-coral)' }}
          >
            Add
          </button>
        </div>
      )}

      {iconPicker}
    </label>
  )
}

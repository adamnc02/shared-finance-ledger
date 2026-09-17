import { useState } from 'react'
import type { Category } from '../types/ledger'
import { CategoryIconPickerModal } from './CategoryIconPickerModal'

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

      {pickingIcon && (
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
      )}
    </label>
  )
}

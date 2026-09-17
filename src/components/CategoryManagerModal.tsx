import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Tag, Trash2, Check, Lock } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { BILL_ICONS, ICON_COLORS } from '../lib/billIcons'
import { CategoryIcon } from './CategoryIcon'
import { CategoryIconPickerModal } from './CategoryIconPickerModal'
import type { Category } from '../types/ledger'

/**
 * Button + portal modal, same construction as IconPickerButton (portal to
 * document.body rather than inline, so it isn't clipped by the app
 * shell's nested overflow containers — see that file for the full
 * reasoning). Operates entirely on the ledger's Category list via
 * LedgerContext, independent of whichever page hosts the trigger button —
 * intentionally decoupled, since Bills itself (doc Section 4.3's chosen
 * location for this button) still runs on the pre-rebuild data model
 * until it's migrated to RecurringTemplate in a later phase. The
 * categories managed here are already live for Transactions and Borrowing.
 */
export function CategoryManagerButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-9 h-9 rounded-full flex items-center justify-center border"
        style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-track)' }}
        aria-label="Manage categories"
      >
        <Tag size={16} className="text-[var(--color-ink-muted)]" />
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={() => setOpen(false)}>
            <div
              className="w-full max-w-md rounded-t-3xl p-5 max-h-[80vh] overflow-y-auto"
              style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Categories</h3>
                <button onClick={() => setOpen(false)} className="text-[var(--color-ink-muted)]">
                  <X size={20} />
                </button>
              </div>
              <CategoryManagerContent />
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function CategoryManagerContent() {
  const { data, addCategory, updateCategory, removeCategory } = useLedgerData()
  const [newName, setNewName] = useState('')
  const [pickingIcon, setPickingIcon] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 mb-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !newName.trim()) return
            setPickingIcon(true)
          }}
          placeholder="New category name"
          className="flex-1 bg-transparent border-b border-[var(--color-track)] py-1.5 text-[var(--color-ink)] outline-none"
        />
        <button
          disabled={!newName.trim()}
          onClick={() => setPickingIcon(true)}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 shrink-0"
          style={{ background: 'var(--color-coral)' }}
        >
          Add
        </button>
      </div>

      {pickingIcon && (
        <CategoryIconPickerModal
          name={newName.trim()}
          categories={data.categories}
          onCancel={() => setPickingIcon(false)}
          onConfirm={(icon, iconColor) => {
            addCategory(newName.trim(), { icon, iconColor })
            setNewName('')
            setPickingIcon(false)
          }}
        />
      )}

      {data.categories
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((category) => (
          <CategoryRow
            key={category.id}
            category={category}
            expanded={expandedId === category.id}
            onToggleExpand={() => setExpandedId(expandedId === category.id ? null : category.id)}
            onUpdate={(updates) => updateCategory(category.id, updates)}
            onDelete={() => removeCategory(category.id)}
          />
        ))}
      {data.categories.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">No categories yet — add one above.</p>}
    </div>
  )
}

function CategoryRow({
  category,
  expanded,
  onToggleExpand,
  onUpdate,
  onDelete,
}: {
  category: Category
  expanded: boolean
  onToggleExpand: () => void
  onUpdate: (updates: Partial<Omit<Category, 'id'>>) => void
  onDelete: () => void
}) {
  const [nameDraft, setNameDraft] = useState(category.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-elevated)' }}>
      <button onClick={onToggleExpand} className="w-full flex items-center gap-2 p-2.5 text-left">
        <CategoryIcon category={category} size={15} />
        <span className="flex-1 text-sm text-[var(--color-ink)] truncate">{category.name}</span>
        {category.isBuiltIn && <Lock size={13} className="text-[var(--color-ink-faint)] shrink-0" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className="flex-1 bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none text-sm"
            />
            <button
              disabled={!nameDraft.trim() || nameDraft === category.name}
              onClick={() => onUpdate({ name: nameDraft.trim() })}
              className="text-[var(--color-positive)] disabled:opacity-30 shrink-0"
              aria-label="Save name"
            >
              <Check size={16} />
            </button>
          </div>

          <div>
            <span className="text-xs text-[var(--color-ink-muted)] block mb-1.5">Icon</span>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(BILL_ICONS).map(([key, Icon]) => (
                <button
                  key={key}
                  onClick={() => onUpdate({ icon: key })}
                  className="w-9 h-9 rounded-full flex items-center justify-center"
                  style={{ background: category.icon === key ? 'var(--color-coral)' : 'var(--color-surface)' }}
                  title={key.replace('_', ' ')}
                >
                  <Icon size={15} style={{ color: category.icon === key ? '#fff' : category.iconColor }} />
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="text-xs text-[var(--color-ink-muted)] block mb-1.5">Colour</span>
            <div className="flex flex-wrap gap-1.5">
              {ICON_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => onUpdate({ iconColor: c })}
                  className="w-8 h-8 rounded-full"
                  style={{ background: c, outline: category.iconColor === c ? '2px solid var(--color-ink)' : '1px solid var(--color-track)', outlineOffset: 2 }}
                />
              ))}
            </div>
          </div>

          {category.isBuiltIn ? (
            <p className="text-xs text-[var(--color-ink-faint)]">Built-in category — can be renamed and recoloured, but not deleted.</p>
          ) : confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-ink-muted)] flex-1">Delete "{category.name}"?</span>
              <button onClick={() => setConfirmingDelete(false)} className="text-xs text-[var(--color-ink-muted)]">
                Cancel
              </button>
              <button onClick={onDelete} className="text-xs font-semibold" style={{ color: 'var(--color-negative)' }}>
                Delete
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmingDelete(true)} className="self-start flex items-center gap-1 text-xs" style={{ color: 'var(--color-negative)' }}>
              <Trash2 size={13} /> Delete category
            </button>
          )}
        </div>
      )}
    </div>
  )
}

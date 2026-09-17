import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Search, type LucideIcon } from 'lucide-react'
import type { Category } from '../types/ledger'
import { ICON_COLORS } from '../lib/billIcons'
import { pickColorForIndex } from '../lib/categories'
import { availableExtendedIcons, filterAvailableIcons, isWeakMatch, suggestTopIcons, type IconSuggestion } from '../lib/iconSuggestions'
import { fetchRelatedWords } from '../lib/datamuse'

/**
 * Shown when creating a brand-new category, between typing a name and it
 * actually being created. Suggests up to 3 icons from the larger
 * "invisible" library (extendedIcons.ts) via local keyword matching
 * first; if that top match comes back weak, a Datamuse lookup runs in the
 * background to try to improve it (best-effort — see datamuse.ts, this
 * never blocks the UI and silently no-ops on any failure/offline, so
 * category creation always works with zero network calls in the common
 * case). The full "browse all" list — searchable — is always available
 * regardless, so a weak or slow suggestion never blocks creation.
 *
 * Colour still defaults to the existing auto round-robin colour; this
 * modal only makes it *possible* to override that default, not mandatory
 * to choose one every time.
 */
export function CategoryIconPickerModal({
  name,
  categories,
  onConfirm,
  onCancel,
}: {
  name: string
  categories: Category[]
  onConfirm: (icon: string, iconColor: string) => void
  onCancel: () => void
}) {
  const [suggestions, setSuggestions] = useState<IconSuggestion[]>(() => suggestTopIcons(name, categories))
  const [boosting, setBoosting] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [selected, setSelected] = useState<{ key: string; icon: LucideIcon } | null>(null)
  const [colorOverride, setColorOverride] = useState<string | null>(null)
  const [changingColor, setChangingColor] = useState(false)

  useEffect(() => {
    if (!isWeakMatch(suggestions)) return
    let cancelled = false
    setBoosting(true)
    fetchRelatedWords(name).then((relatedWords) => {
      if (cancelled) return
      setBoosting(false)
      if (relatedWords.length === 0) return
      setSuggestions(suggestTopIcons(name, categories, relatedWords))
    })
    return () => {
      cancelled = true
    }
    // Deliberately mount-only — this modal is only ever rendered fresh
    // (guarded by the caller's "adding" state), so re-running this on
    // every render isn't needed and would just re-fire the network call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const defaultColor = pickColorForIndex(categories.length)
  const chosenColor = colorOverride ?? defaultColor
  const pool = availableExtendedIcons(categories)
  const filteredPool = filterAvailableIcons(pool, filterQuery)

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[80vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Choose an icon</h3>
          <button onClick={onCancel} className="text-[var(--color-ink-muted)]" aria-label="Cancel">
            <X size={20} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">for "{name}"</p>

        {!selected ? (
          <>
            <span className="text-xs text-[var(--color-ink-muted)] block mb-1.5">Suggested{boosting ? ' — looking for a better match…' : ''}</span>
            <div className="flex gap-2 mb-4">
              {suggestions.map((s) => {
                const Icon = s.icon
                return (
                  <button
                    key={s.key}
                    onClick={() => setSelected({ key: s.key, icon: s.icon })}
                    className="flex-1 flex flex-col items-center gap-1.5 rounded-xl py-3"
                    style={{ background: 'var(--color-bg-elevated)' }}
                  >
                    <Icon size={20} style={{ color: 'var(--color-coral)' }} />
                    <span className="text-[10px] text-[var(--color-ink-muted)] capitalize truncate max-w-full px-1">{s.key.replace(/_/g, ' ')}</span>
                  </button>
                )
              })}
              {suggestions.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] py-3">No suggestions yet — browse the full list below.</p>}
            </div>

            {!browsing ? (
              <button onClick={() => setBrowsing(true)} className="text-xs font-medium" style={{ color: 'var(--color-coral)' }}>
                Choose from full list ({pool.length} icons)
              </button>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ background: 'var(--color-bg-elevated)' }}>
                  <Search size={14} className="text-[var(--color-ink-faint)] shrink-0" />
                  <input
                    autoFocus
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder="Search icons"
                    className="flex-1 bg-transparent text-sm text-[var(--color-ink)] outline-none"
                  />
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {filteredPool.map((entry) => {
                    const Icon = entry.icon
                    return (
                      <button
                        key={entry.key}
                        onClick={() => setSelected({ key: entry.key, icon: entry.icon })}
                        className="flex flex-col items-center justify-center rounded-xl py-2.5"
                        style={{ background: 'var(--color-bg-elevated)' }}
                        title={entry.key.replace(/_/g, ' ')}
                      >
                        <Icon size={18} style={{ color: 'var(--color-ink-muted)' }} />
                      </button>
                    )
                  })}
                  {filteredPool.length === 0 && (
                    <p className="col-span-5 text-xs text-[var(--color-ink-faint)] text-center py-4">No icons match "{filterQuery}".</p>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <ChosenIconConfirm
            name={name}
            icon={selected.icon}
            color={chosenColor}
            changingColor={changingColor}
            onChangeColorRequested={() => setChangingColor(true)}
            onPickColor={setColorOverride}
            onPickDifferentIcon={() => setSelected(null)}
            onConfirm={() => onConfirm(selected.key, chosenColor)}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}

function ChosenIconConfirm({
  name,
  icon: Icon,
  color,
  changingColor,
  onChangeColorRequested,
  onPickColor,
  onPickDifferentIcon,
  onConfirm,
}: {
  name: string
  icon: LucideIcon
  color: string
  changingColor: boolean
  onChangeColorRequested: () => void
  onPickColor: (c: string) => void
  onPickDifferentIcon: () => void
  onConfirm: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center justify-center shrink-0 rounded-full" style={{ width: 48, height: 48, background: `${color}22` }}>
          <Icon size={22} strokeWidth={1.75} style={{ color }} />
        </span>
        <div>
          <p className="text-sm text-[var(--color-ink)]">{name}</p>
          <button onClick={onPickDifferentIcon} className="text-xs font-medium" style={{ color: 'var(--color-coral)' }}>
            Choose a different icon
          </button>
        </div>
      </div>

      {!changingColor ? (
        <button onClick={onChangeColorRequested} className="self-start text-xs font-medium" style={{ color: 'var(--color-coral)' }}>
          Change colour
        </button>
      ) : (
        <div>
          <span className="text-xs text-[var(--color-ink-muted)] block mb-1.5">Colour</span>
          <div className="flex flex-wrap gap-1.5">
            {ICON_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => onPickColor(c)}
                className="w-8 h-8 rounded-full"
                style={{ background: c, outline: color === c ? '2px solid var(--color-ink)' : '1px solid var(--color-track)', outlineOffset: 2 }}
              />
            ))}
          </div>
        </div>
      )}

      <button onClick={onConfirm} className="w-full py-2.5 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-coral)' }}>
        Create category
      </button>
    </div>
  )
}

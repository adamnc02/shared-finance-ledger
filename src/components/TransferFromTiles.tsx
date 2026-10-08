import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Landmark, PiggyBank, Users, Wallet } from 'lucide-react'
import type { AppDataV2, RecurringTemplate, Transaction, TransferLocation } from '../types/ledger'
import { isSettled, type TransferDestination, type TransferGroup } from '../lib/transferGroups'
import { formatCurrency } from '../lib/format'

// Transactions → Transfers: one tile per From location in a single row
// that scrolls sideways, and the selected location's transfers in a panel
// beneath it. Every tile starts closed.
//
// The grouping and the tile figures come from lib/transferGroups.ts; this
// file only draws them. The rows inside the panel are the page's own
// transfer rows, passed in, so editing and deleting work exactly as they
// do everywhere else.

/** A location's colour: a pot's or savings pot's own (the colour of its Home card), coral for the current account, the joint colour for the joint account. */
export function transferLocationColor(location: TransferLocation, data: AppDataV2): string {
  switch (location.type) {
    case 'personal':
      return 'var(--color-coral)'
    case 'joint':
      return 'var(--color-joint)'
    case 'pot':
      return (data.pots ?? []).find((p) => p.id === location.potId)?.color ?? 'var(--color-warning)'
    case 'savings':
      return data.savingsPots.find((p) => p.id === location.savingsPotId)?.color ?? 'var(--color-positive)'
  }
}

function LocationIcon({ location, size }: { location: TransferLocation; size: number }) {
  // The joint colour is near-white, so its icon is drawn dark.
  const color = location.type === 'joint' ? 'var(--color-bg)' : '#fff'
  const props = { size, strokeWidth: 1.75, color }
  switch (location.type) {
    case 'personal':
      return <Landmark {...props} />
    case 'joint':
      return <Users {...props} />
    case 'savings':
      return <PiggyBank {...props} />
    case 'pot':
      return <Wallet {...props} />
  }
}

const KIND_LABEL: Record<TransferLocation['type'], string> = { personal: 'From', joint: 'From', pot: 'From · Pot', savings: 'From · Savings' }

/**
 * Where to scroll so `tile` sits in the middle of `row` — or as near as the
 * row allows, which puts the first tile flush left and the last flush right.
 * Measured with getBoundingClientRect relative to the row, never
 * `offsetLeft`, which measures from the nearest POSITIONED ancestor and is
 * how the statement picker's lists once opened scrolled to the wrong place.
 */
export function centredScrollLeft(row: { scrollLeft: number; clientWidth: number; scrollWidth: number; left: number }, tile: { left: number; width: number }): number {
  const tileStart = tile.left - row.left + row.scrollLeft
  const ideal = tileStart - (row.clientWidth - tile.width) / 2
  return Math.max(0, Math.min(ideal, row.scrollWidth - row.clientWidth))
}

/** This cycle's recurring money, split by destination. An empty track when nothing is due. */
function DestinationBar({ destinations, colorOf }: { destinations: TransferDestination[]; colorOf: (d: TransferDestination) => string }) {
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden gap-0.5 mt-2" style={{ background: 'var(--color-bg-elevated)' }}>
      {destinations.map((d) => (
        <span key={d.key} style={{ flex: d.amount, background: colorOf(d) }} />
      ))}
    </div>
  )
}

export interface TransferFromTilesProps {
  groups: TransferGroup[]
  data: AppDataV2
  renderRecurring: (template: RecurringTemplate, destinationColor: string) => ReactNode
  renderOneOff: (t: Transaction, destinationColor: string) => ReactNode
  /** A transfer just created: its group opens, so the new row's flash is seen rather than hidden in a closed group. */
  revealId?: string | null
}

export function TransferFromTiles({ groups, data, renderRecurring, renderOneOff, revealId }: TransferFromTilesProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [clearedOpen, setClearedOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const tileRefs = useRef(new Map<string, HTMLButtonElement>())

  const selected = groups.find((g) => g.key === selectedKey) ?? null

  useEffect(() => {
    if (!revealId) return
    const g = groups.find((x) => x.recurring.some((t) => t.id === revealId) || x.oneOffs.some((t) => t.id === revealId))
    if (g) setSelectedKey(g.key)
  }, [revealId, groups])

  // The selected tile slides into view: centred, or flush with the row's
  // end when it is the first or last.
  useLayoutEffect(() => {
    const row = rowRef.current
    const tile = selectedKey ? tileRefs.current.get(selectedKey) : undefined
    if (!row || !tile) return
    const r = row.getBoundingClientRect()
    const t = tile.getBoundingClientRect()
    row.scrollTo({ left: centredScrollLeft({ scrollLeft: row.scrollLeft, clientWidth: row.clientWidth, scrollWidth: row.scrollWidth, left: r.left }, { left: t.left, width: t.width }), behavior: 'smooth' })
  }, [selectedKey])

  if (groups.length === 0) return null

  const colorOf = (d: TransferDestination) => transferLocationColor(d.location, data)
  const destColor = (to: TransferLocation | undefined) => (to ? transferLocationColor(to, data) : 'var(--color-ink-faint)')

  const pendingOneOffs = selected ? selected.oneOffs.filter((t) => !isSettled(t.date, t.status === 'cleared')) : []
  const settledOneOffs = selected ? selected.oneOffs.filter((t) => isSettled(t.date, t.status === 'cleared')) : []
  const legend = selected ? selected.recurringByDestination : []

  return (
    <div>
      <div
        ref={rowRef}
        className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-3 pt-0.5"
        style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
        role="tablist"
        aria-label="Transfers by where the money comes from"
      >
        {groups.map((g) => {
          const isSel = g.key === selectedKey
          const accent = transferLocationColor(g.from, data)
          const count = g.recurring.length + g.oneOffs.length
          return (
            <button
              key={g.key}
              ref={(el) => {
                if (el) tileRefs.current.set(g.key, el)
                else tileRefs.current.delete(g.key)
              }}
              role="tab"
              aria-selected={isSel}
              onClick={() => {
                setClearedOpen(false)
                setSelectedKey(isSel ? null : g.key)
              }}
              className="relative shrink-0 w-[46%] max-w-[190px] rounded-2xl p-3 text-left"
              style={{
                background: isSel ? `color-mix(in srgb, ${accent} 8%, var(--color-surface))` : 'var(--color-surface)',
                border: `1.5px solid ${isSel ? accent : 'transparent'}`,
              }}
            >
              <div className="flex items-center justify-between">
                <span className="w-8 h-8 rounded-[10px] flex items-center justify-center" style={{ background: accent }}>
                  <LocationIcon location={g.from} size={16} />
                </span>
                <span className="text-[11px] font-semibold text-[var(--color-ink-muted)]">{count}</span>
              </div>
              <p className="font-display text-[14.5px] font-semibold text-[var(--color-ink)] mt-2.5 truncate">{g.label}</p>
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">{KIND_LABEL[g.from.type]}</p>
              {g.perCycleTotal > 0 ? (
                <p className="font-mono text-[15px] font-semibold text-[var(--color-ink)] mt-1.5">
                  £{formatCurrency(g.perCycleTotal)} <span className="font-body text-[10px] font-normal text-[var(--color-ink-faint)]">this cycle</span>
                </p>
              ) : (
                <p className="font-mono text-[15px] font-semibold text-[var(--color-ink-faint)] mt-1.5">
                  — <span className="font-body text-[10px] font-normal">{g.recurring.length > 0 ? 'none due this cycle' : 'one-off only'}</span>
                </p>
              )}
              <DestinationBar destinations={g.recurringByDestination} colorOf={colorOf} />
            </button>
          )
        })}
      </div>

      {selected && (
        <div className="rounded-2xl p-2.5 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)', border: `1.5px solid ${transferLocationColor(selected.from, data)}` }}>
          {legend.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-0.5 text-[11px] text-[var(--color-ink-muted)]">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">This cycle</span>
              {legend.map((d) => (
                <span key={d.key} className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colorOf(d) }} />
                  {d.label} <span className="font-mono">£{formatCurrency(d.amount)}</span>
                </span>
              ))}
            </div>
          )}

          {selected.recurring.length > 0 && (
            <>
              <p className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">Recurring</p>
              {selected.recurring.map((t) => (
                <div key={t.id}>{renderRecurring(t, destColor(t.transferTo))}</div>
              ))}
            </>
          )}

          {selected.oneOffs.length > 0 && (
            <>
              <p className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">One-off</p>
              {pendingOneOffs.map((t) => (
                <div key={t.id}>{renderOneOff(t, destColor(t.toLocation))}</div>
              ))}
              {settledOneOffs.length > 0 && (
                <div className="rounded-xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
                  <button onClick={() => setClearedOpen((o) => !o)} className="w-full flex items-center gap-1.5 px-3 py-2.5" aria-expanded={clearedOpen}>
                    {clearedOpen ? <ChevronUp size={14} className="text-[var(--color-ink-muted)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-muted)]" />}
                    <span className="text-xs font-semibold text-[var(--color-ink)]">Cleared</span>
                    <span className="text-xs text-[var(--color-ink-faint)]">· {settledOneOffs.length}</span>
                  </button>
                  {clearedOpen && (
                    <div className="px-2 pb-2 flex flex-col gap-2">
                      {settledOneOffs.map((t) => (
                        <div key={t.id}>{renderOneOff(t, destColor(t.toLocation))}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

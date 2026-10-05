import { CreditCard } from 'lucide-react'
import { useContext, type ReactNode } from 'react'
import { StackSliverContext } from './WalletStack'
import { formatCurrency } from '../lib/format'

interface BankCardProps {
  variant: 'coral' | 'light' | 'dark' | 'custom'
  bankLabel: string
  accountLabel?: string
  children: ReactNode
  /** Only used when variant === 'custom' — e.g. a credit card's own colour. */
  customColor?: string
  icon?: ReactNode
  /**
   * The card's current figure (its "Current balance", or "Owed" for a card or
   * loan), shown on the card-type row, left of the type, ONLY while this card sits behind the front
   * card in a fanned-out stack (StackSliverContext). Hidden on the front card,
   * and on every card while the stack is collapsed.
   *
   * 🚨 It must not creep into view while the stack collapses: the strips shrink
   * over 0.5s, so a fade-out would show the figure sliding under the card in
   * front. Hiding is therefore instant; only showing is animated, and delayed
   * until the cards have fanned out.
   */
  sliverValue?: number
}

export function BankCard({ variant, bankLabel, accountLabel, children, customColor, icon, sliverValue }: BankCardProps) {
  const showSliver = useContext(StackSliverContext)
  const isCoral = variant === 'coral'
  const isDark = variant === 'dark'
  const isCustom = variant === 'custom'
  const textColor = isCoral || isDark || isCustom ? '#fff' : '#1a1a1a'
  const accentColor = isCoral ? '#fff' : isDark ? 'var(--color-coral)' : isCustom ? '#fff' : 'var(--color-coral)'

  return (
    <div
      className="rounded-3xl p-7 min-h-[220px] flex flex-col justify-between shadow-lg"
      style={{
        background: isCoral
          ? 'linear-gradient(155deg, var(--color-coral) 0%, var(--color-coral-dark) 100%)'
          : isDark
            ? 'linear-gradient(155deg, var(--color-bg-elevated) 0%, #05070d 100%)'
            : isCustom
              ? `linear-gradient(155deg, ${customColor} 0%, ${customColor}cc 100%)`
              : 'var(--color-joint)',
        color: textColor,
        border: isDark ? '1px solid var(--color-track)' : 'none',
      }}
    >
      <div className="flex items-start justify-between">
        <div
          className="w-11 h-8 rounded-md flex items-center justify-center"
          style={{ background: isCoral || isCustom ? 'rgba(255,255,255,0.25)' : isDark ? 'rgba(255,91,76,0.18)' : 'rgba(0,0,0,0.08)' }}
        >
          {icon ?? <CreditCard size={18} strokeWidth={1.5} style={{ color: isDark ? 'var(--color-coral)' : undefined }} />}
        </div>
        {/* While the strip shows a figure, the name stays on ONE line (truncating if it
            must), so the type row with the figure stays inside the visible strip. */}
        <div className={`text-right ${showSliver && sliverValue !== undefined ? 'flex-1 min-w-0 ml-3' : ''}`}>
          <div className={`font-display font-bold text-xl tracking-tight ${showSliver && sliverValue !== undefined ? 'truncate' : ''}`} style={{ color: isCoral || isCustom ? '#fff' : accentColor }}>
            {bankLabel}
          </div>
          {(accountLabel || sliverValue !== undefined) && (
            <div className="flex items-baseline justify-end gap-2" style={{ color: isCoral || isCustom ? '#fff' : accentColor }}>
              {sliverValue !== undefined && (
                // Left of the card type. Never truncated: a clipped amount reads as a different amount.
                <span
                  data-sliver-value
                  aria-hidden={!showSliver}
                  className="font-display tabular-nums text-sm font-semibold whitespace-nowrap"
                  style={{ color: textColor, opacity: showSliver ? 1 : 0, transition: showSliver ? 'opacity 0.2s ease 0.35s' : 'none' }}
                >
                  {sliverValue < 0 ? '-' : ''}£{formatCurrency(Math.abs(sliverValue))}
                </span>
              )}
              {accountLabel && <span className="text-xs font-medium opacity-80 whitespace-nowrap">{accountLabel}</span>}
            </div>
          )}
        </div>
      </div>
      <div>{children}</div>
    </div>
  )
}

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
   * loan), shown in the header strip ONLY while this card sits behind the front
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
        {sliverValue !== undefined && (
          <div
            data-sliver-value
            aria-hidden={!showSliver}
            className="shrink-0 px-3 h-8 flex items-center font-display tabular-nums text-base font-semibold whitespace-nowrap"
            style={{ color: textColor, opacity: showSliver ? 1 : 0, transition: showSliver ? 'opacity 0.2s ease 0.35s' : 'none' }}
          >
            {sliverValue < 0 ? '-' : ''}£{formatCurrency(Math.abs(sliverValue))}
          </div>
        )}
        {/* While the strip shows a figure, the NAME gives way (truncates), never the
            figure — a clipped amount reads as a different amount. */}
        <div className={`text-right ${showSliver && sliverValue !== undefined ? 'flex-1 min-w-0' : ''}`}>
          <div className={`font-display font-bold text-xl tracking-tight ${showSliver && sliverValue !== undefined ? 'truncate' : ''}`} style={{ color: isCoral || isCustom ? '#fff' : accentColor }}>
            {bankLabel}
          </div>
          {accountLabel && (
            <div className="text-xs font-medium opacity-80" style={{ color: isCoral || isCustom ? '#fff' : accentColor }}>
              {accountLabel}
            </div>
          )}
        </div>
      </div>
      <div>{children}</div>
    </div>
  )
}

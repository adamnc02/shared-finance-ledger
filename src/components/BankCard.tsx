import { CreditCard } from 'lucide-react'
import type { ReactNode } from 'react'

interface BankCardProps {
  variant: 'coral' | 'light' | 'dark' | 'custom'
  bankLabel: string
  accountLabel?: string
  children: ReactNode
  /** Only used when variant === 'custom' — e.g. a credit card's own colour. */
  customColor?: string
  icon?: ReactNode
}

export function BankCard({ variant, bankLabel, accountLabel, children, customColor, icon }: BankCardProps) {
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
        <div className="text-right">
          <div className="font-display font-bold text-xl tracking-tight" style={{ color: isCoral || isCustom ? '#fff' : accentColor }}>
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

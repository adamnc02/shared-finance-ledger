import { Receipt } from 'lucide-react'
import { BILL_ICONS } from '../lib/billIcons'
import { EXTENDED_ICONS } from '../lib/extendedIcons'
import type { Category } from '../types/ledger'

interface CategoryIconProps {
  category: Pick<Category, 'icon' | 'iconColor'> | undefined
  size?: number
}

export function CategoryIcon({ category, size = 16 }: CategoryIconProps) {
  const Icon = (category?.icon && (BILL_ICONS[category.icon] || EXTENDED_ICONS[category.icon]?.icon)) || Receipt
  const color = category?.iconColor || 'var(--color-ink-faint)'
  return (
    <span
      className="inline-flex items-center justify-center shrink-0 rounded-full"
      style={{ width: size + 16, height: size + 16, background: `${color}22` }}
    >
      <Icon size={size} strokeWidth={1.75} style={{ color }} />
    </span>
  )
}

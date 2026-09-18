// Category auto-generation (doc Section 3.5 / 4.1): a new category is
// created from a name — icon and colour are auto-picked by default (this
// file), but the UI (CategoryIconPickerModal) now lets the user override
// the auto-picked icon with a suggestion from the larger "invisible"
// library in extendedIcons.ts, and override the auto round-robin colour,
// before the category is actually created. createCategory()'s overrides
// param is how those choices flow through — see LedgerContext.addCategory.

import { nanoid } from 'nanoid'
import { BILL_ICONS, ICON_COLORS, type BillIconKey } from './billIcons'
import { CREDIT_CARD_CATEGORY_ID, INCOME_CATEGORY_ID, BILLS_CATEGORY_ID, SAVINGS_CATEGORY_ID, type Category } from '../types/ledger'

// Keyword → icon key. Checked against the category name in order, first
// match wins, so more specific keywords are listed before their broader
// catch-alls (e.g. "council" before the generic "home"). Not exhaustive —
// a genuinely novel category name just falls through to DEFAULT_ICON_KEY,
// which is an intentional, unsurprising fallback rather than a guess.
const KEYWORD_ICON_MAP: [keywords: string[], icon: BillIconKey][] = [
  [['mortgage', 'rent', 'home', 'house'], 'home'],
  [['electric', 'electricity', 'power'], 'electricity'],
  [['water', 'sewage'], 'water'],
  [['gas', 'heating', 'boiler'], 'gas'],
  [['council'], 'council_tax'],
  [['netflix', 'disney', 'prime video', 'streaming', 'tv licence', 'tv license'], 'streaming'],
  [['tv'], 'tv'],
  [['spotify', 'apple music', 'music'], 'music'],
  [['phone', 'mobile'], 'phone'],
  [['broadband', 'wifi', 'wi-fi', 'internet'], 'internet'],
  [['insurance', 'cover'], 'insurance'],
  [['vet', 'pet', 'dog', 'cat'], 'pet'],
  [['doctor', 'dentist', 'health', 'medical', 'optician'], 'health'],
  [['pharmacy', 'medication', 'prescription'], 'medication'],
  [['gym', 'fitness', 'yoga', 'sport'], 'fitness'],
  [['van', 'truck'], 'truck'],
  [['car', 'vehicle', 'parking', 'mot', 'tax disc'], 'car'],
  [['loan'], 'loan'],
  [['credit card', 'creditcard', 'card'], 'credit_card'],
  [['cash', 'withdrawal', 'atm'], 'cash'],
  [['amazon', 'shopping'], 'shopping'],
  [['clothes', 'clothing', 'shoes'], 'clothing'],
  [['grocery', 'groceries', 'supermarket', 'food'], 'food'],
  [['coffee', 'cafe'], 'coffee'],
  [['garden'], 'garden'],
  [['game', 'gaming', 'steam', 'xbox', 'playstation'], 'gaming'],
  [['holiday', 'travel', 'flight', 'hotel'], 'travel'],
  [['saving', 'savings', 'isa'], 'savings'],
  [['school', 'university', 'tuition', 'education'], 'education'],
  [['repair', 'maintenance', 'plumber', 'electrician'], 'maintenance'],
  [['fuel', 'petrol', 'diesel'], 'fuel'],
  [['baby', 'nursery', 'childcare'], 'baby'],
  [['joint', 'household', 'shared'], 'joint'],
  [['salary', 'wage', 'payday', 'income'], 'wallet'],
]

const DEFAULT_ICON_KEY: BillIconKey = 'receipt'

export function pickIconForName(name: string): BillIconKey {
  const lower = name.trim().toLowerCase()
  if (!lower) return DEFAULT_ICON_KEY
  for (const [keywords, icon] of KEYWORD_ICON_MAP) {
    if (keywords.some((k) => lower.includes(k))) return icon
  }
  return DEFAULT_ICON_KEY
}

// Round-robins through ICON_COLORS by however many categories already
// exist, so colours spread out evenly as categories are added rather than
// clustering on the first couple of entries.
export function pickColorForIndex(existingCount: number): string {
  return ICON_COLORS[existingCount % ICON_COLORS.length]
}

// 2026-09-14 (group-by-category fix, Pot/SavingsPot categoryIcon) — the
// shared fallback for any Pot/SavingsPot that hasn't had its own category
// icon picked yet (see Pot.categoryIcon/SavingsPot.categoryIcon in
// types/ledger.ts). Same ICON_COLORS[3] the built-in "Savings" category
// itself uses, so an unpicked pot still reads visually consistent with
// the bucket it used to fold into.
export const DEFAULT_POT_CATEGORY_ICON = 'wallet'
export const DEFAULT_POT_CATEGORY_ICON_COLOR = ICON_COLORS[3]

export function createCategory(name: string, existing: Category[], overrides?: { icon?: string; iconColor?: string }): Category {
  return {
    id: nanoid(8),
    name: name.trim(),
    icon: overrides?.icon ?? pickIconForName(name),
    iconColor: overrides?.iconColor ?? pickColorForIndex(existing.length),
  }
}

/** Filters out the target category only if it exists and is NOT built-in — a no-op otherwise. Pulled out as its own pure function so the "built-in categories can't be deleted" rule is testable independent of the React context that calls it. */
export function removeCategorySafely(categories: Category[], id: string): Category[] {
  const target = categories.find((c) => c.id === id)
  if (!target || target.isBuiltIn) return categories
  return categories.filter((c) => c.id !== id)
}

/**
 * The category list to show in a PICKER (assigning a category to a bill/
 * expense/loan) — as opposed to the management modal, which always shows
 * every category regardless. Two categories are hidden here when they
 * wouldn't make sense to pick yet:
 *  - Credit Card, when no credit card entity exists — there's nothing to
 *    charge it to.
 *  - Joint (icon: 'joint'), when there's only one person — nobody to
 *    split a joint item with.
 * The currently-assigned category (if editing something that already has
 * one) is always included even if it would otherwise be filtered, so an
 * existing assignment never silently disappears from the list.
 */
export function visibleCategoriesFor(
  data: { categories: Category[]; creditCards: unknown[]; people: unknown[] },
  currentCategoryId?: string,
): Category[] {
  return data.categories.filter((c) => {
    if (c.id === currentCategoryId) return true
    if (c.id === CREDIT_CARD_CATEGORY_ID && data.creditCards.length === 0) return false
    if (c.icon === 'joint' && data.people.length < 2) return false
    return true
  })
}

// Sanity check that every icon key referenced above genuinely exists in
// the shared library — catches a typo here or a rename over there at
// import time rather than as a silent missing icon in the UI.
for (const [, icon] of KEYWORD_ICON_MAP) {
  if (!(icon in BILL_ICONS)) {
    throw new Error(`categories.ts: "${icon}" is not a key in BILL_ICONS`)
  }
}
if (!(DEFAULT_ICON_KEY in BILL_ICONS)) {
  throw new Error(`categories.ts: DEFAULT_ICON_KEY "${DEFAULT_ICON_KEY}" is not a key in BILL_ICONS`)
}

// ── Built-in, seeded categories ─────────────────────────────────────────
// isBuiltIn categories can be renamed but not deleted (enforced in the UI
// layer, not here). CREDIT_CARD_CATEGORY_ID is the default a new credit
// card is assigned on creation, and the fixed bucket every credit-card
// ENTITY transaction (credit_card_payment/credit_card_spend) folds into
// on the Home page's "group by category" view regardless of what category
// the card is actually assigned — see the long comment on the constant
// itself in types/ledger.ts. An ordinary card-paid expense with no
// creditCardId is NOT one of these; it groups under its own categoryId.

// ── Built-in, seeded categories ─────────────────────────────────────────
// isBuiltIn categories can be renamed but not deleted (enforced in the UI
// layer, not here). CREDIT_CARD_CATEGORY_ID is the default a new credit
// card is assigned on creation, and the fixed bucket every credit-card
// ENTITY transaction (credit_card_payment/credit_card_spend) folds into
// on the Home page's "group by category" view regardless of what category
// the card is actually assigned — see the long comment on the constant
// itself in types/ledger.ts. An ordinary card-paid expense with no
// creditCardId is NOT one of these; it groups under its own categoryId.
//
// Beyond the three locked built-ins, every OTHER icon in the shared
// library gets its own pre-seeded, ordinary (deletable, renameable)
// category — this is "the old icon list as the original/default category
// list", so there's always a sensible category to pick from day one
// rather than an empty modal. Two icons are deliberately excluded from
// this generated set: 'receipt' (the generic fallback icon, not a real
// category name in its own right — it's already used for the built-in
// "Bills" category above) and the two icons already claimed by the
// locked built-ins ('credit_card', 'wallet').

const RESERVED_OR_FALLBACK_ICONS: ReadonlySet<BillIconKey> = new Set<BillIconKey>(['credit_card', 'wallet', 'receipt', 'savings'])

// A handful of keys don't title-case cleanly on their own (e.g. 'tv' ->
// 'Tv' reads wrong) — override those, fall through to automatic title
// casing for everything else.
const ICON_CATEGORY_NAME_OVERRIDES: Partial<Record<BillIconKey, string>> = {
  tv: 'TV',
}

function titleCaseFromIconKey(key: string): string {
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function nameForIconKey(key: BillIconKey): string {
  return ICON_CATEGORY_NAME_OVERRIDES[key] ?? titleCaseFromIconKey(key)
}

export function defaultCategories(): Category[] {
  const builtIns: Category[] = [
    { id: CREDIT_CARD_CATEGORY_ID, name: 'Credit Card', icon: 'credit_card', iconColor: ICON_COLORS[0], isBuiltIn: true },
    { id: INCOME_CATEGORY_ID, name: 'Income', icon: 'wallet', iconColor: ICON_COLORS[1], isBuiltIn: true },
    { id: BILLS_CATEGORY_ID, name: 'Bills', icon: 'receipt', iconColor: ICON_COLORS[2], isBuiltIn: true },
    { id: SAVINGS_CATEGORY_ID, name: 'Savings', icon: 'savings', iconColor: ICON_COLORS[3], isBuiltIn: true },
  ]

  const remainingIcons = (Object.keys(BILL_ICONS) as BillIconKey[]).filter((icon) => !RESERVED_OR_FALLBACK_ICONS.has(icon))

  const seeded: Category[] = remainingIcons.map((icon, i) => ({
    id: seededCategoryIdForIcon(icon),
    name: nameForIconKey(icon),
    icon,
    iconColor: ICON_COLORS[(builtIns.length + i) % ICON_COLORS.length],
  }))

  return [...builtIns, ...seeded]
}

/** Deterministic id for one of the auto-seeded (non-built-in) categories, given its icon key — e.g. `seededCategoryIdForIcon('loan')` always resolves to the pre-seeded "Loan" category's id. Lets callers default a picker onto a specific seeded category without hardcoding the `category-seed-*` string in more than one place. */
export function seededCategoryIdForIcon(icon: BillIconKey): string {
  return `category-seed-${icon}`
}

/**
 * One row per category, first occurrence kept (2026-09-17, Adam): the trend
 * tooltip shows a category icon per contributing transaction, so three shops
 * on the same day repeated the same icon three times. Rows with no category
 * collapse under one key for the same reason.
 */
export function distinctByCategory<T extends { categoryId?: string }>(rows: T[]): T[] {
  // Not `new Map(rows.map(...))`: that keeps the LAST row of each category,
  // which silently reorders the icons by where each category last appeared.
  const seen = new Set<string>()
  return rows.filter((r) => {
    const key = r.categoryId || 'uncategorised'
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

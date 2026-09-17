import {
  Home,
  Zap,
  Droplet,
  Flame,
  Building2,
  Tv,
  Film,
  Music,
  Smartphone,
  Wifi,
  Shield,
  PawPrint,
  Stethoscope,
  Pill,
  Dumbbell,
  Car,
  Truck,
  Landmark,
  CreditCard,
  Banknote,
  ShoppingCart,
  Shirt,
  UtensilsCrossed,
  Coffee,
  Trees,
  Gamepad2,
  Plane,
  Receipt,
  PiggyBank,
  Wallet,
  GraduationCap,
  Wrench,
  Fuel,
  Baby,
  Users,
  type LucideIcon,
} from 'lucide-react'

export const BILL_ICONS: Record<string, LucideIcon> = {
  home: Home,
  electricity: Zap,
  water: Droplet,
  gas: Flame,
  council_tax: Building2,
  tv: Tv,
  streaming: Film,
  music: Music,
  phone: Smartphone,
  internet: Wifi,
  insurance: Shield,
  pet: PawPrint,
  health: Stethoscope,
  medication: Pill,
  fitness: Dumbbell,
  car: Car,
  truck: Truck,
  loan: Landmark,
  credit_card: CreditCard,
  cash: Banknote,
  shopping: ShoppingCart,
  clothing: Shirt,
  food: UtensilsCrossed,
  coffee: Coffee,
  garden: Trees,
  gaming: Gamepad2,
  travel: Plane,
  receipt: Receipt,
  savings: PiggyBank,
  wallet: Wallet,
  education: GraduationCap,
  maintenance: Wrench,
  fuel: Fuel,
  baby: Baby,
  joint: Users,
}

export type BillIconKey = keyof typeof BILL_ICONS

// A small curated palette rather than a full colour picker — enough range to
// tell bills apart at a glance without every bill ending up a slightly
// different, hard-to-read shade.
export const ICON_COLORS = [
  '#ff5b4c', // coral (app default)
  '#ff8a3d', // orange
  '#ffc94d', // yellow
  '#4cd08a', // green
  '#3dd6c5', // teal
  '#4c9eff', // blue
  '#8f7bff', // purple
  '#ff6ec7', // pink
  '#a8b0c3', // grey
  '#ffffff', // white
]

export const DEFAULT_ICON_COLOR = ICON_COLORS[0]

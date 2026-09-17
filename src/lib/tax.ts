// UK tax engine — rates confirmed for the 2026/27 tax year (6 Apr 2026 – 5 Apr 2027).
// Sources: HMRC "Rates and thresholds for employers 2026 to 2027", House of Commons
// Library "Direct taxes: Rates and allowances for 2026/27".
//
// This calculates PER PERIOD, the way real PAYE does — using HMRC's published
// per-period thresholds and payroll's rounding rules — rather than working out
// an annual figure and dividing by the number of pay periods. Those two are NOT
// equivalent, and the difference is not just rounding noise: see the notes on
// PERIOD_THRESHOLDS_2026_27 below.
//
// It is a NON-CUMULATIVE ("Month 1" / "Week 1") calculation. For someone on
// level pay it matches a single real payslip to the penny. Real cumulative PAYE
// reconciles rounding across the whole tax year, so `netAnnual` (which is
// netPerPeriod × periods) can differ from a true year-end figure by a pound or
// two. That's a deliberate trade-off: everything downstream — dashboards,
// savings projections, what-if scenarios — consumes the annual figure, and a
// per-period-exact payslip is the more useful thing to be right about in a
// budgeting app.
//
// Not modelled: Scottish rate bands (an S code is treated as rest-of-UK, which
// WILL be wrong for a Scottish taxpayer), multiple jobs, benefits in kind,
// marriage allowance, mid-year pay changes, the K-code 50% regulatory limit,
// and higher-rate pension relief reclaimed via self-assessment.

export type StudentLoanPlan = 'none' | 'plan1' | 'plan2' | 'plan4' | 'plan5' | 'postgrad'
export type PayFrequency = 'monthly' | 'four_weekly'

// How a deduction affects the calculation, matching real payroll categories:
//  - salary_sacrifice: comes off gross before BOTH tax and NI are calculated
//    (a genuine reduction in contractual pay, e.g. pension via sacrifice,
//    Cycle to Work, a Holiday Purchase Scheme)
//  - net_pay: comes off gross before tax only — NI is still charged on the
//    full gross (a "net pay arrangement" pension)
//  - relief_at_source: comes off net pay, after tax/NI/student loan are
//    calculated on the full gross (a relief-at-source pension; the pension
//    provider claims basic-rate relief separately, not modelled here)
//  - post_tax: comes off net pay, no effect on any calculation at all (e.g.
//    a workplace lottery, a charity deduction, an season ticket loan repayment)
export type DeductionType = 'salary_sacrifice' | 'net_pay' | 'relief_at_source' | 'post_tax'
export type DeductionAmountType = 'fixed' | 'percent'

// What a percentage deduction is a percentage OF. Only meaningful when
// amountType is 'percent'.
//  - 'gross': the whole gross for the period.
//  - 'qualifying_earnings': only the slice of pay between the lower and upper
//    qualifying-earnings limits (£520–£4,189 a month for 2026/27). This is what
//    a workplace pension quoted as "4%" almost always actually means, and the
//    difference is NOT small — on a £2,500 monthly gross, 4% of gross is
//    £100.00 but 4% of qualifying earnings is £79.20. Getting this wrong was
//    worth £20.80 a month, compounding through every downstream projection.
//
// Note the upper limit caps the contribution: someone on £5,000/month
// contributes on £3,669, and further pay above £4,189 doesn't increase it.
export type PercentBasis = 'gross' | 'qualifying_earnings'

export interface SalaryDeduction {
  id: string
  name: string
  type: DeductionType
  amountType: DeductionAmountType
  // £ per pay period if amountType is 'fixed', or % of the basis below if 'percent'.
  // Percentage deductions are always calculated against the ORIGINAL gross for the
  // period, not a running total after earlier deductions — matches how real payslips
  // compute each percentage-based line independently.
  amount: number
  // Deliberately OPTIONAL, defaulting to 'gross' when absent, so existing saved
  // data and older backups deserialise unchanged rather than silently changing
  // everyone's numbers on upgrade.
  percentBasis?: PercentBasis
}

export interface TaxYearConstants {
  personalAllowance: number
  personalAllowanceTaperStart: number
  personalAllowanceTaperEnd: number
  basicRateLimit: number // upper bound of basic rate band (England/Wales/NI)
  higherRateLimit: number // upper bound of higher rate band
  basicRate: number
  higherRate: number
  additionalRate: number
  niPrimaryThreshold: number
  niUpperEarningsLimit: number
  niMainRate: number
  niUpperRate: number
}

export const TAX_YEAR_2026_27: TaxYearConstants = {
  personalAllowance: 12570,
  personalAllowanceTaperStart: 100000,
  personalAllowanceTaperEnd: 125140,
  basicRateLimit: 50270,
  higherRateLimit: 125140,
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  niPrimaryThreshold: 12570,
  niUpperEarningsLimit: 50270,
  niMainRate: 0.08,
  niUpperRate: 0.02,
}

// ── Rounding ────────────────────────────────────────────────────────────
// Payroll rounds in three different directions depending on the quantity.
// Getting one wrong shows up as pennies on every single payslip.
//
//   Free pay per period    round UP to the penny
//   Taxable pay            round DOWN to whole POUNDS (HMRC Taxable Pay Tables)
//   Income tax             round DOWN to the penny, per band, then summed
//   National Insurance     round to the NEAREST penny
//   Student loan           round DOWN to whole POUNDS  (£4.61 -> £4)
//   Percentage deductions  round DOWN to the penny     (£63.1875 -> £63.18)
//
// The epsilon guard matters: without it a mathematically exact value like
// 948.25 can land a penny out purely from float representation.
const EPS = 1e-9
export const floorPenny = (n: number): number => Math.floor(n * 100 + EPS) / 100
export const ceilPenny = (n: number): number => Math.ceil(n * 100 - EPS) / 100
export const roundPenny = (n: number): number => Math.round(n * 100) / 100
export const floorPound = (n: number): number => Math.floor(n + EPS)

// ── Per-period thresholds ───────────────────────────────────────────────
export interface PeriodThresholds {
  periodsPerYear: number
  niPrimaryThreshold: number
  niUpperEarningsLimit: number
  qualifyingEarningsLower: number
  qualifyingEarningsUpper: number
}

/**
 * HMRC's PUBLISHED per-period figures. These are hardcoded on purpose — do not
 * be tempted to derive them from the annual constants above, because they are
 * not the annual figure divided by the number of periods and they don't even
 * follow one consistent rounding rule:
 *
 *   Monthly NI PT:    12570 / 12 = 1047.50  -> published as £1,048
 *   4-weekly NI PT:   12570 / 13 =  966.92  -> published as £967
 *
 * Note the 4-weekly primary threshold is also NOT 4 × the £242 weekly PT, which
 * would give £968 and be 8p wrong every period (and moves Ella's NI from
 * £115.57 to £115.49). Both primary thresholds here are confirmed against real
 * payslips.
 *
 * CAVEAT: the 4-weekly upper earnings limit of £3,867 is derived (50270 / 13),
 * not payslip-verified — nobody in this app earns near it on 4-weekly pay.
 * Verify it before trusting it for a high earner paid 4-weekly.
 */
export const PERIOD_THRESHOLDS_2026_27: Record<PayFrequency, PeriodThresholds> = {
  monthly: {
    periodsPerYear: 12,
    niPrimaryThreshold: 1048,
    niUpperEarningsLimit: 4189,
    qualifyingEarningsLower: 520,
    qualifyingEarningsUpper: 4189,
  },
  four_weekly: {
    periodsPerYear: 13,
    niPrimaryThreshold: 967,
    niUpperEarningsLimit: 3867,
    qualifyingEarningsLower: 480,
    qualifyingEarningsUpper: 3867,
  },
}

export function periodThresholdsFor(payFrequency: PayFrequency): PeriodThresholds {
  return PERIOD_THRESHOLDS_2026_27[payFrequency] ?? PERIOD_THRESHOLDS_2026_27.monthly
}

// Unlike the NI and qualifying-earnings figures above, the per-period student
// loan threshold genuinely IS annual / periods, unrounded. Only the resulting
// deduction gets rounded (down, to whole pounds).
export const STUDENT_LOAN_THRESHOLDS_2026_27: Record<Exclude<StudentLoanPlan, 'none'>, { threshold: number; rate: number }> = {
  plan1: { threshold: 26900, rate: 0.09 },
  plan2: { threshold: 29385, rate: 0.09 },
  plan4: { threshold: 33795, rate: 0.09 },
  plan5: { threshold: 25000, rate: 0.09 },
  postgrad: { threshold: 21000, rate: 0.06 },
}

export interface TaxCodeResult {
  allowance: number
  flatRate: 'BR' | 'D0' | 'D1' | 'NT' | null
  isKCode: boolean
  /** True if the code carried a W1/M1/X marker. Recorded for display; this engine is non-cumulative anyway. */
  nonCumulative: boolean
  /** From a leading S (Scotland) or C (Wales) prefix. Scottish bands are NOT modelled — see the file header. */
  region: 'rest_of_uk' | 'scotland' | 'wales'
}

/**
 * Parses a UK tax code into an effective allowance (or flat-rate instruction).
 *
 * THE ALLOWANCE IS `digits × 10 + 9`, NOT `digits × 10`. A 1257L code is
 * £12,579, not £12,570. This is the easiest defect in the whole engine to miss,
 * because £12,570 looks exactly like the number you expect to see — it's the
 * headline personal allowance. It's still wrong, and it costs £9 of allowance
 * for every person.
 */
export function parseTaxCode(code: string): TaxCodeResult {
  let c = (code ?? '').toUpperCase().replace(/\s+/g, '')

  // Non-cumulative marker: W1, M1, W1M1 or a trailing X.
  let nonCumulative = false
  const suffixMatch = c.match(/(W1M1|W1|M1|X)$/)
  if (suffixMatch && c.length > suffixMatch[0].length) {
    nonCumulative = true
    c = c.slice(0, -suffixMatch[0].length)
  }

  // Country prefix. Stripped so the numeric part parses; note that treating an
  // S code as rest-of-UK is a known, documented inaccuracy (Scotland has a
  // separate five-band system that this engine does not implement).
  let region: TaxCodeResult['region'] = 'rest_of_uk'
  if (c.startsWith('S')) {
    region = 'scotland'
    c = c.slice(1)
  } else if (c.startsWith('C')) {
    region = 'wales'
    c = c.slice(1)
  }

  const base = { nonCumulative, region }

  if (c === 'BR') return { allowance: 0, flatRate: 'BR', isKCode: false, ...base }
  if (c === 'D0') return { allowance: 0, flatRate: 'D0', isKCode: false, ...base }
  if (c === 'D1') return { allowance: 0, flatRate: 'D1', isKCode: false, ...base }
  if (c === 'NT') return { allowance: 0, flatRate: 'NT', isKCode: false, ...base }

  // 0T must be matched BEFORE the numeric branch below, or the `+ 9` turns it
  // into a £9 allowance instead of nil.
  if (c === '0T') return { allowance: 0, flatRate: null, isKCode: false, ...base }

  const kMatch = c.match(/^K(\d+)$/)
  if (kMatch) {
    // Negative allowance: additional notional pay added before tax.
    return { allowance: -(parseInt(kMatch[1], 10) * 10 + 9), flatRate: null, isKCode: true, ...base }
  }

  const match = c.match(/^(\d+)[LMNT]?$/)
  if (match) {
    return { allowance: parseInt(match[1], 10) * 10 + 9, flatRate: null, isKCode: false, ...base }
  }

  // Unrecognised code — fall back to the bare statutory personal allowance
  // rather than guessing. Deliberately 12570, not 12579: there's no code here
  // to take the +9 from.
  return { allowance: TAX_YEAR_2026_27.personalAllowance, flatRate: null, isKCode: false, ...base }
}

/** Personal allowance after the £100k taper, before applying tax-code overrides. */
export function taperedPersonalAllowance(
  adjustedNetIncome: number,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): number {
  if (adjustedNetIncome <= constants.personalAllowanceTaperStart) return constants.personalAllowance
  const reduction = Math.floor((adjustedNetIncome - constants.personalAllowanceTaperStart) / 2)
  return Math.max(0, constants.personalAllowance - reduction)
}

/**
 * The allowance a tax code actually grants, after the £100k taper.
 *
 * This replaces the old `Math.min(taperedPersonalAllowance(...), codeAllowance)`
 * capping. That looked reasonable and was silently wrong: it capped ANY code
 * above 1257L at £12,570, so someone on 1350L (£13,509 of allowance — perfectly
 * ordinary, e.g. with job expenses) was quietly taxed on an extra £939 a year.
 *
 * The taper reduces whatever the code grants; it isn't a ceiling on it.
 *
 * K codes are exempted: a K code is already the product of HMRC applying
 * deductions (including any taper) to arrive at a negative allowance, so
 * tapering it again would double-count, and clamping it at 0 would throw away
 * the negative entirely.
 */
export function allowanceAfterTaper(
  codeAllowance: number,
  adjustedNetIncome: number,
  isKCode: boolean,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): number {
  if (isKCode) return codeAllowance
  const taperReduction =
    adjustedNetIncome > constants.personalAllowanceTaperStart ? Math.floor((adjustedNetIncome - constants.personalAllowanceTaperStart) / 2) : 0
  return Math.max(0, codeAllowance - taperReduction)
}

export interface IncomeTaxBreakdown {
  totalTax: number
  bands: { label: string; amount: number; rate: number; tax: number }[]
  allowanceUsed: number
}

/** Income tax for England, Wales & Northern Ireland taxpayers. */
export function calculateIncomeTaxEWNI(
  taxableIncomeBeforeAllowance: number,
  allowance: number,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): IncomeTaxBreakdown {
  const taxable = Math.max(0, taxableIncomeBeforeAllowance - allowance)
  const bands: IncomeTaxBreakdown['bands'] = []

  const basicBandSize = constants.basicRateLimit - constants.personalAllowance
  const higherBandSize = constants.higherRateLimit - constants.basicRateLimit

  const basicAmount = Math.min(taxable, basicBandSize)
  const higherAmount = Math.min(Math.max(0, taxable - basicBandSize), higherBandSize)
  const additionalAmount = Math.max(0, taxable - basicBandSize - higherBandSize)

  bands.push({ label: 'Basic rate (20%)', amount: basicAmount, rate: constants.basicRate, tax: basicAmount * constants.basicRate })
  bands.push({ label: 'Higher rate (40%)', amount: higherAmount, rate: constants.higherRate, tax: higherAmount * constants.higherRate })
  bands.push({ label: 'Additional rate (45%)', amount: additionalAmount, rate: constants.additionalRate, tax: additionalAmount * constants.additionalRate })

  const totalTax = bands.reduce((sum, b) => sum + b.tax, 0)
  return { totalTax, bands, allowanceUsed: allowance }
}

export function calculateNationalInsurance(
  grossAnnual: number,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): { total: number; mainRateAmount: number; upperRateAmount: number } {
  const mainBand = Math.max(0, Math.min(grossAnnual, constants.niUpperEarningsLimit) - constants.niPrimaryThreshold)
  const upperBand = Math.max(0, grossAnnual - constants.niUpperEarningsLimit)
  const mainRateAmount = Math.max(0, mainBand) * constants.niMainRate
  const upperRateAmount = upperBand * constants.niUpperRate
  return { total: mainRateAmount + upperRateAmount, mainRateAmount, upperRateAmount }
}

export function calculateStudentLoanRepayment(grossAnnual: number, plan: StudentLoanPlan): number {
  if (plan === 'none') return 0
  const { threshold, rate } = STUDENT_LOAN_THRESHOLDS_2026_27[plan]
  return Math.max(0, grossAnnual - threshold) * rate
}

// ── Per-period calculations (what real payroll does) ────────────────────

export interface PeriodTaxResult {
  /** Income tax for this period, each band floored to the penny then summed. */
  tax: number
  /** Allowance for the period, rounded UP to the penny. */
  freePay: number
  /** Taxable pay after free pay, floored to whole POUNDS. */
  taxablePay: number
  /** The annual allowance the code granted, after taper. */
  allowance: number
  bands: IncomeTaxBreakdown['bands']
}

/**
 * Income tax for a single pay period.
 *
 * Band widths are the annual widths divided by the number of periods — basic
 * (50270 − 12570) / periods, higher (125140 − 50270) / periods, which for
 * monthly gives £3,141.67 and £6,239.17. Those widths are fixed regardless of
 * the person's tax code: the code sets the free pay, not the band boundaries.
 */
export function periodIncomeTax(
  taxableGrossPerPeriod: number,
  taxCode: string,
  thresholds: PeriodThresholds,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): PeriodTaxResult {
  const parsed = parseTaxCode(taxCode)
  const periods = thresholds.periodsPerYear

  if (parsed.flatRate === 'NT') {
    return { tax: 0, freePay: 0, taxablePay: 0, allowance: 0, bands: [] }
  }

  if (parsed.flatRate === 'BR' || parsed.flatRate === 'D0' || parsed.flatRate === 'D1') {
    const rate = parsed.flatRate === 'BR' ? constants.basicRate : parsed.flatRate === 'D0' ? constants.higherRate : constants.additionalRate
    const label = parsed.flatRate === 'BR' ? 'Basic rate (20%, BR code)' : parsed.flatRate === 'D0' ? 'Higher rate (40%, D0 code)' : 'Additional rate (45%, D1 code)'
    const taxablePay = Math.max(0, floorPound(taxableGrossPerPeriod))
    const tax = floorPenny(taxablePay * rate)
    return { tax, freePay: 0, taxablePay, allowance: 0, bands: [{ label, amount: taxablePay, rate, tax }] }
  }

  // The taper is an annual test, so annualise this period's taxable pay to
  // apply it. On level pay that's the right answer; it's one of the places
  // where a non-cumulative engine can only approximate.
  const allowance = allowanceAfterTaper(parsed.allowance, taxableGrossPerPeriod * periods, parsed.isKCode, constants)

  const freePay = ceilPenny(allowance / periods)
  const taxablePay = Math.max(0, floorPound(taxableGrossPerPeriod - freePay))

  const basicBandSize = (constants.basicRateLimit - constants.personalAllowance) / periods
  const higherBandSize = (constants.higherRateLimit - constants.basicRateLimit) / periods

  const basicAmount = Math.min(taxablePay, basicBandSize)
  const higherAmount = Math.min(Math.max(0, taxablePay - basicBandSize), higherBandSize)
  const additionalAmount = Math.max(0, taxablePay - basicBandSize - higherBandSize)

  const bands: IncomeTaxBreakdown['bands'] = [
    { label: 'Basic rate (20%)', amount: basicAmount, rate: constants.basicRate, tax: floorPenny(basicAmount * constants.basicRate) },
    { label: 'Higher rate (40%)', amount: higherAmount, rate: constants.higherRate, tax: floorPenny(higherAmount * constants.higherRate) },
    { label: 'Additional rate (45%)', amount: additionalAmount, rate: constants.additionalRate, tax: floorPenny(additionalAmount * constants.additionalRate) },
  ]

  return { tax: bands.reduce((sum, b) => sum + b.tax, 0), freePay, taxablePay, allowance, bands }
}

/** National Insurance for a single pay period, using the published per-period thresholds. */
export function periodNationalInsurance(
  niableGrossPerPeriod: number,
  thresholds: PeriodThresholds,
  constants: TaxYearConstants = TAX_YEAR_2026_27
): { total: number; mainRateAmount: number; upperRateAmount: number } {
  const mainBand = Math.max(0, Math.min(niableGrossPerPeriod, thresholds.niUpperEarningsLimit) - thresholds.niPrimaryThreshold)
  const upperBand = Math.max(0, niableGrossPerPeriod - thresholds.niUpperEarningsLimit)
  const mainRateAmount = roundPenny(mainBand * constants.niMainRate)
  const upperRateAmount = roundPenny(upperBand * constants.niUpperRate)
  return { total: roundPenny(mainBand * constants.niMainRate + upperBand * constants.niUpperRate), mainRateAmount, upperRateAmount }
}

/**
 * Student loan repayment for a single pay period, floored to whole POUNDS.
 *
 * Charged on NI-ABLE pay, not taxable pay. With salary sacrifice the two
 * coincide, which is exactly why the old version — which used taxable pay —
 * looked fine: it only diverges once someone has a net pay arrangement pension,
 * where tax comes off the reduced figure but NI (and student loan) do not.
 */
export function periodStudentLoan(niableGrossPerPeriod: number, plan: StudentLoanPlan, periodsPerYear: number): number {
  if (plan === 'none') return 0
  const { threshold, rate } = STUDENT_LOAN_THRESHOLDS_2026_27[plan]
  return Math.max(0, floorPound(Math.max(0, niableGrossPerPeriod - threshold / periodsPerYear) * rate))
}

/** The slice of a period's pay that a qualifying-earnings percentage applies to. */
export function qualifyingEarningsForPeriod(grossPerPeriod: number, thresholds: PeriodThresholds): number {
  return Math.max(0, Math.min(grossPerPeriod, thresholds.qualifyingEarningsUpper) - thresholds.qualifyingEarningsLower)
}

export interface SalaryInput {
  grossAnnual: number
  taxCode: string
  studentLoanPlan: StudentLoanPlan
  payFrequency: PayFrequency
  deductions: SalaryDeduction[]
  employerPensionPercent?: number // informational only — doesn't affect your own take-home
}

export interface DeductionResult {
  id: string
  name: string
  type: DeductionType
  amountPerPeriod: number
  runningTotalAfter: number
}

export interface SalaryBreakdown {
  grossAnnual: number
  periodsPerYear: number
  grossPerPeriod: number
  // Deductions that reduce tax/NI before they're calculated (salary_sacrifice, net_pay)
  preTaxDeductions: DeductionResult[]
  grossTaxablePerPeriod: number
  grossNiablePerPeriod: number
  incomeTaxPerPeriod: number
  nationalInsurancePerPeriod: number
  studentLoanPerPeriod: number
  // Deductions taken from net pay, no effect on tax/NI (relief_at_source, post_tax)
  postTaxDeductions: DeductionResult[]
  netPerPeriod: number
  netAnnual: number
  netMonthly: number // always annual/12, a standard reference figure
  netWeekly: number
  employerPensionContributionPerPeriod: number
  /** Annual allowance the tax code granted, after any £100k taper. */
  personalAllowance: number
  /** PER-PERIOD band breakdown — totalTax here equals incomeTaxPerPeriod, not an annual figure. */
  taxBreakdown: IncomeTaxBreakdown
}

/**
 * Annual income tax for a given annual TAXABLE gross (i.e. already net of
 * any salary-sacrifice / net-pay deductions) under a given tax code.
 *
 * Extracted out of calculateNetSalary so it can be called twice against
 * two different taxable figures — which is exactly what working out the
 * marginal tax on a bonus requires (see calculateBonusOnTop). Previously
 * this whole flat-rate/banded decision lived inline in calculateNetSalary
 * and was unreachable from anywhere else, which is why the bonus
 * calculation had to resort to re-running the ENTIRE salary calculation
 * with an inflated grossAnnual — the thing that made it wrong.
 */
export function annualIncomeTaxFor(annualTaxableGross: number, taxCode: string, constants: TaxYearConstants = TAX_YEAR_2026_27): IncomeTaxBreakdown {
  const taxCodeResult = parseTaxCode(taxCode)
  if (taxCodeResult.flatRate === 'NT') return { totalTax: 0, bands: [], allowanceUsed: 0 }
  if (taxCodeResult.flatRate === 'BR') {
    const tax = annualTaxableGross * constants.basicRate
    return { totalTax: tax, bands: [{ label: 'Basic rate (20%, BR code)', amount: annualTaxableGross, rate: constants.basicRate, tax }], allowanceUsed: 0 }
  }
  if (taxCodeResult.flatRate === 'D0') {
    const tax = annualTaxableGross * constants.higherRate
    return { totalTax: tax, bands: [{ label: 'Higher rate (40%, D0 code)', amount: annualTaxableGross, rate: constants.higherRate, tax }], allowanceUsed: 0 }
  }
  if (taxCodeResult.flatRate === 'D1') {
    const tax = annualTaxableGross * constants.additionalRate
    return { totalTax: tax, bands: [{ label: 'Additional rate (45%, D1 code)', amount: annualTaxableGross, rate: constants.additionalRate, tax }], allowanceUsed: 0 }
  }
  const allowance = allowanceAfterTaper(taxCodeResult.allowance, annualTaxableGross, taxCodeResult.isKCode, constants)
  return calculateIncomeTaxEWNI(annualTaxableGross, allowance, constants)
}

/**
 * The £ value of one deduction line for one period.
 *
 * Percentages resolve against the ORIGINAL gross for the period (or the
 * qualifying-earnings slice of it), never a running total after earlier
 * deductions — that's how payslips compute each percentage line, independently.
 * The result is truncated DOWN to the penny.
 */
export function resolveDeductionAmount(deduction: SalaryDeduction, grossPerPeriod: number, thresholds: PeriodThresholds): number {
  if (deduction.amountType !== 'percent') return deduction.amount
  const basis = deduction.percentBasis === 'qualifying_earnings' ? qualifyingEarningsForPeriod(grossPerPeriod, thresholds) : grossPerPeriod
  return floorPenny((deduction.amount / 100) * basis)
}

/** Full net-salary calculation, walking through a person's own ordered list of deductions. */
export function calculateNetSalary(input: SalaryInput, constants: TaxYearConstants = TAX_YEAR_2026_27): SalaryBreakdown {
  const thresholds = periodThresholdsFor(input.payFrequency)
  const periodsPerYear = thresholds.periodsPerYear
  const grossPerPeriod = input.grossAnnual / periodsPerYear

  const deductions = input.deductions ?? []

  // --- Phase 1: deductions that affect tax/NI, in the order given ---
  let runningTotal = grossPerPeriod
  let taxableGrossPerPeriod = grossPerPeriod
  let niableGrossPerPeriod = grossPerPeriod
  const preTaxDeductions: DeductionResult[] = []

  for (const d of deductions) {
    if (d.type !== 'salary_sacrifice' && d.type !== 'net_pay') continue
    const amount = resolveDeductionAmount(d, grossPerPeriod, thresholds)
    runningTotal -= amount
    taxableGrossPerPeriod -= amount
    // net_pay comes off before TAX only — NI (and therefore student loan) is
    // still charged on the full gross.
    if (d.type === 'salary_sacrifice') niableGrossPerPeriod -= amount
    preTaxDeductions.push({ id: d.id, name: d.name, type: d.type, amountPerPeriod: amount, runningTotalAfter: runningTotal })
  }

  // --- Phase 2: tax, NI, student loan, all computed for THIS PERIOD ---
  const periodTax = periodIncomeTax(taxableGrossPerPeriod, input.taxCode, thresholds, constants)
  const allowance = periodTax.allowance
  const incomeTaxPerPeriod = periodTax.tax

  const ni = periodNationalInsurance(niableGrossPerPeriod, thresholds, constants)
  const nationalInsurancePerPeriod = ni.total

  const studentLoanPerPeriod = periodStudentLoan(niableGrossPerPeriod, input.studentLoanPlan, periodsPerYear)

  const taxBreakdown: IncomeTaxBreakdown = { totalTax: incomeTaxPerPeriod, bands: periodTax.bands, allowanceUsed: allowance }

  runningTotal -= incomeTaxPerPeriod + nationalInsurancePerPeriod + studentLoanPerPeriod

  // --- Phase 3: deductions taken from net pay, no effect on tax/NI ---
  const postTaxDeductions: DeductionResult[] = []
  for (const d of deductions) {
    if (d.type !== 'relief_at_source' && d.type !== 'post_tax') continue
    const amount = resolveDeductionAmount(d, grossPerPeriod, thresholds)
    runningTotal -= amount
    postTaxDeductions.push({ id: d.id, name: d.name, type: d.type, amountPerPeriod: amount, runningTotalAfter: runningTotal })
  }

  // Every component above is already penny-exact; this just clears float dust
  // from the subtractions so the displayed figure is exactly the payslip figure.
  const netPerPeriod = roundPenny(runningTotal)
  // See the file header: this is netPerPeriod × periods, not a true cumulative
  // year-end figure. Everything downstream consumes it.
  const netAnnual = netPerPeriod * periodsPerYear
  const employerPensionContributionPerPeriod = ((input.employerPensionPercent ?? 0) / 100) * grossPerPeriod

  return {
    grossAnnual: input.grossAnnual,
    periodsPerYear,
    grossPerPeriod,
    preTaxDeductions,
    grossTaxablePerPeriod: taxableGrossPerPeriod,
    grossNiablePerPeriod: niableGrossPerPeriod,
    incomeTaxPerPeriod,
    nationalInsurancePerPeriod,
    studentLoanPerPeriod,
    postTaxDeductions,
    netPerPeriod,
    netAnnual,
    netMonthly: netAnnual / 12,
    netWeekly: netAnnual / 52,
    employerPensionContributionPerPeriod,
    personalAllowance: allowance,
    taxBreakdown,
  }
}

// ── Bonus ───────────────────────────────────────────────────────────────

export interface BonusBreakdown {
  grossBonus: number
  incomeTax: number
  nationalInsurance: number
  /** Always 0 — a bonus is not charged student loan (see calculateBonusOnTop). Present for shape stability, not because it varies. */
  studentLoan: number
  /** grossBonus less income tax and NI. Always equals grossBonus - incomeTax - nationalInsurance, since studentLoan above is fixed at 0. */
  net: number
}

/**
 * The net value of a one-off GROSS bonus paid on top of this salary.
 *
 * A bonus is treated as TAXABLE and NIABLE, and nothing else: none of the
 * person's standing deductions are applied to it, and neither is student
 * loan. That's a
 * deliberate correction of how this used to work. The previous approach
 * recomputed the whole year with `grossAnnual + bonus` and took the
 * difference in net pay — which quietly ran the bonus through every
 * percentage-based deduction as well. With a 12.5% salary-sacrifice
 * pension, a £1,000 bonus lost £125 to the pension before tax was even
 * considered, and the figure shown as "net bonus" was £455 instead of
 * £520. Fixed deductions (a £70.39 holiday-buy line, a £10 charity line)
 * were unaffected either way — it was specifically the percentage ones
 * that scaled with the inflated gross.
 *
 * Marginal, not average: tax and NI are each computed twice — once on the
 * ordinary annual figure, once with the bonus added — and the DIFFERENCE
 * is what the bonus costs. That's what correctly charges a bonus that
 * straddles a band boundary at the right rates on each part, and picks up
 * the personal-allowance taper if the bonus pushes total income past
 * £100k.
 *
 * The two bases are deliberately different: income tax builds on
 * `grossTaxablePerPeriod` (net of salary_sacrifice AND net_pay
 * deductions), NI on `grossNiablePerPeriod` (net of salary_sacrifice
 * only) — the same split calculateNetSalary already uses, so a bonus is
 * charged against exactly the same starting figures the salary itself is.
 *
 * They're also deliberately different in which THRESHOLDS they marginal
 * against. Income tax is annualised (annualIncomeTaxFor on annualTaxable
 * ± bonus) because the annual bands genuinely are the per-period bands ×
 * periods — see periodIncomeTax's own comment. NI is NOT: the published
 * per-period PT/UEL (£1,048 / £4,189 monthly) are NOT annualNI / periods
 * and don't even follow one rounding rule (see PERIOD_THRESHOLDS_2026_27's
 * comment), and — more fundamentally — real NI has no annual reconciliation
 * at all. It's assessed fresh every pay period with no memory of the
 * periods before it. So the bonus's NI has to be the marginal cost against
 * THIS PERIOD's niable pay, using periodNationalInsurance and the
 * period's own PT/UEL, exactly like calculateNetSalary does for the
 * ordinary salary. Annualising it (the old approach) silently asked "how
 * much extra NI does this bonus cost across the whole tax year", which
 * smears the bonus's marginal rate across every period's UEL crossing
 * instead of just this one, and overstates it whenever the ordinary
 * period pay is comfortably under the period UEL but annualNiable is
 * close to the annual UEL — the two boundaries don't line up because the
 * thresholds themselves don't scale the same way.
 *
 * Student loan is deliberately NOT charged on a bonus — confirmed
 * explicitly: tax and NI are the only two things that touch it. The
 * `studentLoan` field below is therefore always 0. It's kept on the
 * result rather than deleted so the breakdown has a fixed shape and any
 * future change of mind is a one-line edit here rather than a change to
 * every caller's type. The person's ordinary salary is still charged
 * student loan as normal by calculateNetSalary — this only concerns the
 * bonus sitting on top of it.
 */
export function calculateBonusOnTop(input: SalaryInput, grossBonus: number, constants: TaxYearConstants = TAX_YEAR_2026_27): BonusBreakdown {
  if (!(grossBonus > 0)) return { grossBonus: 0, incomeTax: 0, nationalInsurance: 0, studentLoan: 0, net: 0 }

  const base = calculateNetSalary(input, constants)
  const annualTaxable = base.grossTaxablePerPeriod * base.periodsPerYear

  const incomeTax =
    annualIncomeTaxFor(annualTaxable + grossBonus, input.taxCode, constants).totalTax - annualIncomeTaxFor(annualTaxable, input.taxCode, constants).totalTax

  // NI marginal against THIS PERIOD's niable pay and THIS PERIOD's own
  // thresholds — see the comment above for why this can't be annualised
  // the way income tax is.
  const thresholds = periodThresholdsFor(input.payFrequency)
  const nationalInsurance =
    periodNationalInsurance(base.grossNiablePerPeriod + grossBonus, thresholds, constants).total -
    periodNationalInsurance(base.grossNiablePerPeriod, thresholds, constants).total

  const studentLoan = 0

  const net = grossBonus - incomeTax - nationalInsurance
  return { grossBonus, incomeTax, nationalInsurance, studentLoan, net }
}

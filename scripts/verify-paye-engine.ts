/**
 * UK PAYE engine — per-period calculation checks.
 *
 * Every vector below is a REAL PAYSLIP, and every assertion runs at ZERO
 * tolerance. That matters more than it sounds: the previous suite asserted the
 * same payslip with £1 tolerances and passed green while three separate defects
 * were live in the engine. Loose tolerances are what let them hide, so nothing
 * in this file is allowed a penny of slack.
 *
 * The six defects this guards against:
 *   1. Tax code allowance computed as digits × 10  (should be × 10 + 9)
 *   2. No whole-pound round-down on taxable pay
 *   3. NI thresholds derived as annual ÷ periods instead of HMRC's published ones
 *   4. Percentage deductions always applied to full gross  (up to £20.80/period)
 *   5. Student loan not truncated to whole pounds
 *   6. Allowance capped via min(standardAllowance, codeAllowance)
 *
 * Run: npx tsx scripts/verify-paye-engine.ts
 */
import {
  calculateNetSalary,
  parseTaxCode,
  periodNationalInsurance,
  periodThresholdsFor,
  qualifyingEarningsForPeriod,
  resolveDeductionAmount,
  floorPenny,
  ceilPenny,
  roundPenny,
  PERIOD_THRESHOLDS_2026_27,
  type SalaryDeduction,
  type SalaryInput,
} from '../src/lib/tax'

let failures = 0
let checks = 0

/** Zero tolerance by design — see the file header. */
function check(label: string, actual: unknown, expected: unknown) {
  checks++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.log(`✗ FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${label}`)
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

// ─────────────────────────────────────────────────────────────────────────
section('Rounding helpers')

check('floorPenny(63.1875) truncates down', floorPenny(63.1875), 63.18)
check('ceilPenny(922.416666) rounds up', ceilPenny(922.4166666666667), 922.42)
check('roundPenny(115.5736) to nearest', roundPenny(115.5736), 115.57)
// Without the epsilon guard, an exact 948.25 can land a penny out purely from
// float representation — 11379/12 is exactly 948.25 and must NOT become 948.26.
check('ceilPenny(11379/12) exact value stays put (epsilon guard)', ceilPenny(11379 / 12), 948.25)
check('floorPenny of an exact value stays put', floorPenny(79.2), 79.2)

// ─────────────────────────────────────────────────────────────────────────
section('Per-period thresholds are HMRC published, not derived')

// The whole point: these are NOT annual ÷ periods, and they don't even follow
// one consistent rounding rule.
check('Monthly NI PT is 1048, not 1047.50', PERIOD_THRESHOLDS_2026_27.monthly.niPrimaryThreshold, 1048)
check('4-weekly NI PT is 967, not 966.92', PERIOD_THRESHOLDS_2026_27.four_weekly.niPrimaryThreshold, 967)
// 4 × the £242 weekly PT would give 968 and be 8p wrong every single period.
check('4-weekly NI PT is NOT 4 × weekly 242', PERIOD_THRESHOLDS_2026_27.four_weekly.niPrimaryThreshold !== 968, true)
check('Monthly UEL', PERIOD_THRESHOLDS_2026_27.monthly.niUpperEarningsLimit, 4189)
check('Monthly QE lower / upper', [PERIOD_THRESHOLDS_2026_27.monthly.qualifyingEarningsLower, PERIOD_THRESHOLDS_2026_27.monthly.qualifyingEarningsUpper], [520, 4189])
check('4-weekly QE lower / upper', [PERIOD_THRESHOLDS_2026_27.four_weekly.qualifyingEarningsLower, PERIOD_THRESHOLDS_2026_27.four_weekly.qualifyingEarningsUpper], [480, 3867])

// The 8p-per-period proof that the 4-weekly PT has to be 967:
const fourWeekly = periodThresholdsFor('four_weekly')
check('NI on £2411.67 4-weekly = £115.57 (using PT 967)', periodNationalInsurance(2411.67, fourWeekly).total, 115.57)
check('...and would be £115.49 if PT were wrongly 968', roundPenny((2411.67 - 968) * 0.08), 115.49)

// ─────────────────────────────────────────────────────────────────────────
section('Tax code parsing — allowance is digits × 10 + 9')

check("parseTaxCode('1257L').allowance", parseTaxCode('1257L').allowance, 12579)
check("parseTaxCode('1137L').allowance", parseTaxCode('1137L').allowance, 11379)
check("parseTaxCode('1106L').allowance", parseTaxCode('1106L').allowance, 11069)
check("parseTaxCode('K475').allowance is negative", parseTaxCode('K475').allowance, -4759)
check("parseTaxCode('K475').isKCode", parseTaxCode('K475').isKCode, true)
check("parseTaxCode('1257L W1').allowance (suffix stripped)", parseTaxCode('1257L W1').allowance, 12579)
check("parseTaxCode('1257LM1').allowance", parseTaxCode('1257LM1').allowance, 12579)
check("parseTaxCode('1257L X').allowance", parseTaxCode('1257L X').allowance, 12579)
check("parseTaxCode('1257L W1').nonCumulative flagged", parseTaxCode('1257L W1').nonCumulative, true)
check("parseTaxCode('S1257L').allowance (Scottish prefix stripped)", parseTaxCode('S1257L').allowance, 12579)
check("parseTaxCode('S1257L').region recorded", parseTaxCode('S1257L').region, 'scotland')
check("parseTaxCode('C1257L').region recorded", parseTaxCode('C1257L').region, 'wales')
// 0T must be matched before the numeric branch, or the +9 turns nil into £9.
check("parseTaxCode('0T').allowance is nil, not 9", parseTaxCode('0T').allowance, 0)
check("parseTaxCode('BR') flat rate", parseTaxCode('BR').flatRate, 'BR')
check("parseTaxCode('NT') flat rate", parseTaxCode('NT').flatRate, 'NT')

// ─────────────────────────────────────────────────────────────────────────
section('Defect 6 — allowance above 1257L is not silently capped')

// The old min(taperedStandardAllowance, codeAllowance) quietly capped this at
// £12,570, taxing an extra £939 a year.
check("parseTaxCode('1350L').allowance", parseTaxCode('1350L').allowance, 13509)
const highCode = calculateNetSalary({ grossAnnual: 30000, taxCode: '1350L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
const stdCode = calculateNetSalary({ grossAnnual: 30000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
check('1350L gives more allowance than 1257L (not capped)', highCode.personalAllowance > stdCode.personalAllowance, true)
check('1350L annual allowance used', highCode.personalAllowance, 13509)
check('1350L pays less tax than 1257L', highCode.incomeTaxPerPeriod < stdCode.incomeTaxPerPeriod, true)

// The taper still reduces a code allowance — it just isn't a ceiling on it.
const tapered = calculateNetSalary({ grossAnnual: 110000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
check('£110k taper: allowance 12579 − 5000', tapered.personalAllowance, 7579)
const fullyTapered = calculateNetSalary({ grossAnnual: 130000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
check('£130k taper: allowance floors at 0, never negative', fullyTapered.personalAllowance, 0)

// ─────────────────────────────────────────────────────────────────────────
section('Defect 4 — percentage basis')

const monthly = periodThresholdsFor('monthly')
check('QE on £2500 monthly = 2500 − 520', qualifyingEarningsForPeriod(2500, monthly), 1980)
check('QE on £5000 monthly caps at 4189 − 520', qualifyingEarningsForPeriod(5000, monthly), 3669)
check('QE on £400 monthly (below lower limit) = 0', qualifyingEarningsForPeriod(400, monthly), 0)
check('Pay above the QE upper limit does not increase QE', qualifyingEarningsForPeriod(9000, monthly), qualifyingEarningsForPeriod(4189, monthly))

const pct = (basis?: SalaryDeduction['percentBasis']): SalaryDeduction => ({ id: 'd', name: 'Pension', type: 'relief_at_source', amountType: 'percent', amount: 4, percentBasis: basis })
check('4% of gross on £2500', resolveDeductionAmount(pct('gross'), 2500, monthly), 100)
check('4% of QE on £2500 — the £20.80 defect', resolveDeductionAmount(pct('qualifying_earnings'), 2500, monthly), 79.2)
// Backwards compatibility: older saved data has no percentBasis at all and must
// keep behaving exactly as it did before this field existed.
check('percentBasis absent defaults to gross', resolveDeductionAmount(pct(undefined), 2500, monthly), 100)
check('Percentage truncated DOWN to the penny (2.5% of 2527.50 = 63.1875)', resolveDeductionAmount({ id: 'd', name: 'P', type: 'salary_sacrifice', amountType: 'percent', amount: 2.5 }, 2527.5, monthly), 63.18)
check('Fixed amounts pass through untouched', resolveDeductionAmount({ id: 'd', name: 'H', type: 'salary_sacrifice', amountType: 'fixed', amount: 52.65 }, 2527.5, monthly), 52.65)

// Percentages resolve against the ORIGINAL gross, not a running total after
// earlier deductions — each payslip line is computed independently.
const twoPercentLines = calculateNetSalary({
  grossAnnual: 30000,
  taxCode: '1257L',
  studentLoanPlan: 'none',
  payFrequency: 'monthly',
  deductions: [
    { id: 'a', name: 'First', type: 'salary_sacrifice', amountType: 'percent', amount: 10 },
    { id: 'b', name: 'Second', type: 'salary_sacrifice', amountType: 'percent', amount: 10 },
  ],
})
check('Two 10% lines are both £250 (not 250 then 225)', twoPercentLines.preTaxDeductions.map((d) => d.amountPerPeriod), [250, 250])

// ─────────────────────────────────────────────────────────────────────────
section('Vector A — monthly, higher-rate, qualifying-earnings pension')

// £60,000/yr · monthly · 1106L · no student loan · Pension 4% relief_at_source on QE
const A = calculateNetSalary({
  grossAnnual: 60000,
  taxCode: '1106L',
  studentLoanPlan: 'none',
  payFrequency: 'monthly',
  deductions: [{ id: 'p', name: 'Pension', type: 'relief_at_source', amountType: 'percent', amount: 4, percentBasis: 'qualifying_earnings' }],
})
check('A gross', A.grossPerPeriod, 5000)
check('A income tax', A.incomeTaxPerPeriod, 1002.46)
check('A National Insurance (crosses the UEL)', A.nationalInsurancePerPeriod, 267.5)
check('A pension (QE upper cap applies)', A.postTaxDeductions[0].amountPerPeriod, 146.76)
check('A NET', A.netPerPeriod, 3583.28)
// Trace checkpoints from the spec: free pay 922.42, taxable floored to £4,077.
check('A free pay rounds up to 922.42', ceilPenny(11069 / 12), 922.42)
check('A taxable pay floors to whole pounds', Math.floor(5000 - 922.42), 4077)
check('A relief_at_source pension does not reduce taxable pay', A.grossTaxablePerPeriod, 5000)

// ─────────────────────────────────────────────────────────────────────────
section('Vector B — monthly, basic-rate, student loan')

// £30,000/yr · monthly · 1137L · Plan 2 · Pension 4% relief_at_source on QE
const B = calculateNetSalary({
  grossAnnual: 30000,
  taxCode: '1137L',
  studentLoanPlan: 'plan2',
  payFrequency: 'monthly',
  deductions: [{ id: 'p', name: 'Pension', type: 'relief_at_source', amountType: 'percent', amount: 4, percentBasis: 'qualifying_earnings' }],
})
check('B gross', B.grossPerPeriod, 2500)
check('B income tax', B.incomeTaxPerPeriod, 310.2)
check('B National Insurance (monthly PT 1048)', B.nationalInsurancePerPeriod, 116.16)
check('B pension (QE, no upper cap)', B.postTaxDeductions[0].amountPerPeriod, 79.2)
check('B student loan floors to whole pounds (4.6125 → 4)', B.studentLoanPerPeriod, 4)
check('B NET', B.netPerPeriod, 1990.44)
// The "before" signature. An engine carrying all six defects returns 1968.69 —
// £21.75 low. If this ever matches again, the rewrite has been reverted.
check('B is NOT the six-defect signature of 1968.69', B.netPerPeriod !== 1968.69, true)

// ─────────────────────────────────────────────────────────────────────────
section('Vector C — 4-weekly, salary sacrifice, mixed deductions')

// £32,857.50/yr · 4-weekly (13 periods) · 1257L · Plan 1
const C = calculateNetSalary({
  grossAnnual: 32857.5,
  taxCode: '1257L',
  studentLoanPlan: 'plan1',
  payFrequency: 'four_weekly',
  deductions: [
    { id: 'd1', name: 'Holiday Purchase', type: 'salary_sacrifice', amountType: 'fixed', amount: 52.65 },
    { id: 'd2', name: 'Pension', type: 'salary_sacrifice', amountType: 'percent', amount: 2.5, percentBasis: 'gross' },
    { id: 'd3', name: 'Lottery', type: 'post_tax', amountType: 'fixed', amount: 4.0 },
  ],
})
check('C periods per year', C.periodsPerYear, 13)
check('C gross', C.grossPerPeriod, 2527.5)
check('C holiday purchase', C.preTaxDeductions[0].amountPerPeriod, 52.65)
check('C pension truncated (63.1875 → 63.18)', C.preTaxDeductions[1].amountPerPeriod, 63.18)
check('C gross taxable', C.grossTaxablePerPeriod, 2411.67)
check('C salary sacrifice reduces NI-able pay too', C.grossNiablePerPeriod, 2411.67)
check('C income tax', C.incomeTaxPerPeriod, 288.8)
check('C National Insurance (4-weekly PT 967)', C.nationalInsurancePerPeriod, 115.57)
check('C student loan (30.82 → 30)', C.studentLoanPerPeriod, 30)
check('C NET', C.netPerPeriod, 1973.3)
check('C deduction order preserved', C.preTaxDeductions.map((d) => d.name), ['Holiday Purchase', 'Pension'])
check('C free pay ceil(12579/13)', ceilPenny(12579 / 13), 967.62)

// ─────────────────────────────────────────────────────────────────────────
section('Deduction types — what each one reduces')

const baseInput: SalaryInput = { grossAnnual: 30000, taxCode: '1257L', studentLoanPlan: 'plan2', payFrequency: 'monthly', deductions: [] }
const none = calculateNetSalary(baseInput)
const netPay = calculateNetSalary({ ...baseInput, deductions: [{ id: 'n', name: 'Pension', type: 'net_pay', amountType: 'fixed', amount: 200 }] })
const sacrifice = calculateNetSalary({ ...baseInput, deductions: [{ id: 's', name: 'Pension', type: 'salary_sacrifice', amountType: 'fixed', amount: 200 }] })
const ras = calculateNetSalary({ ...baseInput, deductions: [{ id: 'r', name: 'Pension', type: 'relief_at_source', amountType: 'fixed', amount: 200 }] })
const postTax = calculateNetSalary({ ...baseInput, deductions: [{ id: 'p', name: 'Lottery', type: 'post_tax', amountType: 'fixed', amount: 200 }] })

check('net_pay vs none: NI identical', netPay.nationalInsurancePerPeriod, none.nationalInsurancePerPeriod)
check('net_pay vs none: student loan identical', netPay.studentLoanPerPeriod, none.studentLoanPerPeriod)
check('net_pay vs none: income tax lower', netPay.incomeTaxPerPeriod < none.incomeTaxPerPeriod, true)
check('salary_sacrifice vs none: NI lower', sacrifice.nationalInsurancePerPeriod < none.nationalInsurancePerPeriod, true)
check('salary_sacrifice vs none: student loan lower or equal', sacrifice.studentLoanPerPeriod <= none.studentLoanPerPeriod, true)
check('salary_sacrifice vs none: income tax lower', sacrifice.incomeTaxPerPeriod < none.incomeTaxPerPeriod, true)
check('relief_at_source vs none: tax, NI and student loan all identical', [ras.incomeTaxPerPeriod, ras.nationalInsurancePerPeriod, ras.studentLoanPerPeriod], [none.incomeTaxPerPeriod, none.nationalInsurancePerPeriod, none.studentLoanPerPeriod])
check('relief_at_source and post_tax are computationally identical', ras.netPerPeriod, postTax.netPerPeriod)

// The latent seventh defect: student loan must follow NI-ABLE pay, not taxable
// pay. Salary sacrifice makes the two coincide, so this is only visible with a
// net pay arrangement pension — a big enough one to cross the threshold.
const bigNetPay = calculateNetSalary({ ...baseInput, deductions: [{ id: 'n', name: 'Pension', type: 'net_pay', amountType: 'fixed', amount: 500 }] })
check('Large net_pay pension still leaves student loan untouched', bigNetPay.studentLoanPerPeriod, none.studentLoanPerPeriod)
check('...while it does reduce income tax', bigNetPay.incomeTaxPerPeriod < none.incomeTaxPerPeriod, true)

// ─────────────────────────────────────────────────────────────────────────
section('Flat-rate and K codes')

const br = calculateNetSalary({ grossAnnual: 30000, taxCode: 'BR', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
check('BR: flat 20% on the whole floored gross', br.incomeTaxPerPeriod, 500)
const nt = calculateNetSalary({ grossAnnual: 30000, taxCode: 'NT', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
check('NT: no income tax at all', nt.incomeTaxPerPeriod, 0)
check('NT: National Insurance still charged', nt.nationalInsurancePerPeriod > 0, true)
const d0 = calculateNetSalary({ grossAnnual: 30000, taxCode: 'D0', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
check('D0: flat 40%', d0.incomeTaxPerPeriod, 1000)
// A K code adds notional pay rather than granting allowance, so it must tax
// MORE than a 0T code, not less.
const kCode = calculateNetSalary({ grossAnnual: 30000, taxCode: 'K475', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
const zeroT = calculateNetSalary({ grossAnnual: 30000, taxCode: '0T', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
check('K475 taxes more than 0T (negative allowance adds pay)', kCode.incomeTaxPerPeriod > zeroT.incomeTaxPerPeriod, true)
check('K475 keeps its negative allowance through the taper', kCode.personalAllowance, -4759)

// ─────────────────────────────────────────────────────────────────────────
section('Edge cases')

const zero = calculateNetSalary({ grossAnnual: 0, taxCode: '1257L', studentLoanPlan: 'plan2', payFrequency: 'monthly', deductions: [] })
check('Zero salary: no tax, no NI, no student loan', [zero.incomeTaxPerPeriod, zero.nationalInsurancePerPeriod, zero.studentLoanPerPeriod], [0, 0, 0])
check('Zero salary: net is 0, not negative', zero.netPerPeriod, 0)
const belowPT = calculateNetSalary({ grossAnnual: 9000, taxCode: '1257L', studentLoanPlan: 'plan2', payFrequency: 'monthly', deductions: [] })
check('Below every threshold: nothing deducted', [belowPT.incomeTaxPerPeriod, belowPT.nationalInsurancePerPeriod, belowPT.studentLoanPerPeriod], [0, 0, 0])
check('Below threshold: net equals gross', belowPT.netPerPeriod, roundPenny(9000 / 12))
const noDeductions = calculateNetSalary({ grossAnnual: 30000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] })
check('netMonthly is still annual ÷ 12 reference figure', noDeductions.netMonthly, noDeductions.netAnnual / 12)
check('netAnnual is netPerPeriod × periods', noDeductions.netAnnual, noDeductions.netPerPeriod * 12)

// ─────────────────────────────────────────────────────────────────────────
section('Serialisation — percentBasis survives a round trip')

const withBasis: SalaryDeduction[] = [
  { id: 'a', name: 'Pension', type: 'relief_at_source', amountType: 'percent', amount: 4, percentBasis: 'qualifying_earnings' },
  { id: 'b', name: 'Legacy', type: 'post_tax', amountType: 'percent', amount: 2 },
]
const roundTripped = JSON.parse(JSON.stringify(withBasis)) as SalaryDeduction[]
check('percentBasis serialises intact', roundTripped[0].percentBasis, 'qualifying_earnings')
check('A deduction saved before the field existed stays undefined', roundTripped[1].percentBasis, undefined)
check(
  'Old saved data computes exactly as it did before the field existed',
  calculateNetSalary({ grossAnnual: 30000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [roundTripped[1]] }).postTaxDeductions[0].amountPerPeriod,
  50
)

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '✓ All' : `✗ ${failures} of`} ${checks} PAYE engine checks passed.`)
if (failures > 0) process.exit(1)

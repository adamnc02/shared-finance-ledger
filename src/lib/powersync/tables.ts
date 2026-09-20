// SYNC APP ONLY (shared-finance-ledger; the test app's /sync/ build).
//
// The ONE list of synced tables. schema.ts builds the local PowerSync schema
// from it, connector.ts maps local names back to Postgres ones, and
// scripts/print-sync-streams.ts prints the Sync Streams YAML from it, so the
// three can never drift apart.
//
// 🚨 LOCAL NAMES ARE PREFIXED `sfl_` ON PURPOSE. personal-f's stream is
// auto-subscribed and outputs `people`, `households`, `household_members`,
// `loans`, `salary_deductions` and `scenarios`. A user of both apps would
// otherwise get two apps' rows in one local table. Each Sync Streams query
// renames its source with `AS sfl_<table>` (documented PowerSync
// behaviour: "the alias maps the table to the new client-side name").
// MIGRATION-LESSONS §7 is about an ACCIDENTAL alias the app doesn't know
// about; this one is generated from the same list the app reads.
//
// Mirrors silver-octo-invention 20260919200100/200200 (+ 20260919230000's
// `position`). Deliberately NOT declared locally:
// - `id`: PowerSync adds it;
// - `user_id` on app tables: it defaults to auth.uid() server-side, and a
//   declared column would send `user_id: null` over it on upsert.
// Types (docs.powersync.com/sync/types): numeric → declared real so the app
// gets numbers; boolean → 0/1; date, uuid, jsonb → text.

export type ColumnKind = 'text' | 'real' | 'integer' | 'bool' | 'json'

export interface SyncedTable {
  /** Postgres table in shared_finance_ledger. */
  remote: string
  columns: Record<string, ColumnKind>
  /** Scoped by household_id (every table but scenarios). */
  household: boolean
  /** Written by the app. households / household_members are read-only (functions write them). */
  writable: boolean
}

export const LOCAL_PREFIX = 'sfl_'
export const SCHEMA = 'shared_finance_ledger'

const H = { household_id: 'text' } as const
const P = { position: 'real' } as const
const OVERRIDE = { original_date: 'text', date: 'text', amount: 'real', deleted: 'bool' } as const

function t(remote: string, columns: Record<string, ColumnKind>, opts: { household?: boolean; writable?: boolean } = {}): SyncedTable {
  return { remote, columns, household: opts.household ?? true, writable: opts.writable ?? true }
}

/** In FK order: parents before children. Inserts run in this order, deletes in reverse (MIGRATION-LESSONS §27). */
export const SYNCED_TABLES: SyncedTable[] = [
  t('households', { created_at: 'text' }, { household: false, writable: false }),
  t('household_members', { ...H, user_id: 'text', joined_at: 'text' }, { writable: false }),
  t('people', { ...H, name: 'text', color: 'text', linked_user_id: 'text', ...P }),
  t('categories', { ...H, name: 'text', icon: 'text', icon_color: 'text', is_built_in: 'bool', ...P }),
  t('pots', {
    ...H, person_id: 'text', name: 'text', opening_balance: 'real', opening_date: 'text', active: 'bool', color: 'text',
    category_icon: 'text', category_icon_color: 'text',
    // PROMPT-13 B5 — the one restricted pot per person.
    is_coin_jar: 'bool',
    ...P,
  }),
  t('savings_pots', {
    ...H, person_id: 'text', name: 'text', opening_balance: 'real', opening_date: 'text', active: 'bool', color: 'text',
    interest_type: 'text', interest_aer: 'real', interest_crediting_frequency: 'text', interest_effective_from: 'text',
    interest_history: 'json', interest_destination_type: 'text', interest_destination_savings_pot_id: 'text',
    interest_destination_pot_id: 'text', recurring_deposit_amount: 'real', recurring_deposit_day_of_month: 'integer',
    recurring_deposit_start_date: 'text', target_amount: 'real', target_date: 'text', category_icon: 'text',
    category_icon_color: 'text', ...P,
  }),
  t('savings_pot_interest_overrides', { ...H, savings_pot_id: 'text', date: 'text', amount: 'real', ...P }),
  t('savings_pot_recurring_deposit_overrides', { ...H, savings_pot_id: 'text', ...OVERRIDE, ...P }),
  t('pensions', {
    ...H, person_id: 'text', name: 'text', amount: 'real', frequency: 'text', interval_weeks: 'integer', anchor_date: 'text',
    active: 'bool', schedule_from: 'text', adjust_for_non_working_day: 'bool', cycle_start_follows_payday: 'bool',
    amount_effective_from: 'text', amount_history: 'json', ...P,
  }),
  t('pension_occurrence_overrides', { ...H, pension_id: 'text', ...OVERRIDE, ...P }),
  t('pay_cycles', {
    ...H, person_id: 'text', opening_balance: 'real', opening_balance_date: 'text', payday_day_of_month: 'integer',
    payday_adjust_for_non_working_day: 'bool', cycle_start_day_of_month: 'integer', cycle_start_follows_payday: 'bool',
    follows_income_source_type: 'text', follows_pension_id: 'text', payday_history: 'json', pay_schedule_kind: 'text',
    pay_schedule_anchor: 'text', salary_sort_basis: 'text',
    // PROMPT-13 B4 — the switch, per person. `round_up_history` is 'json'
    // and MUST reach the server as a jsonb VALUE, never a jsonb string
    // (MIGRATION-LESSONS §33) — verify-mapping-nulls.ts covers it.
    round_up_enabled: 'bool', round_up_effective_from: 'text', round_up_history: 'json',
    ...P,
  }),
  t('salary_snapshots', {
    ...H, person_id: 'text', effective_from: 'text', gross_annual: 'real', tax_code: 'text', student_loan_plan: 'text',
    pay_frequency: 'text', employer_pension_percent: 'real', end_date: 'text', recorded_seq: 'integer', ...P,
  }),
  t('salary_deductions', {
    ...H, salary_snapshot_id: 'text', name: 'text', type: 'text', amount_type: 'text', amount: 'real', percent_basis: 'text',
    sort_order: 'integer', ...P,
  }),
  t('salary_overrides', {
    ...H, person_id: 'text', pay_period_date: 'text', net_pay_override: 'real', reason: 'text', bonus_gross_amount: 'real', ...P,
  }),
  t('recurring_templates', {
    ...H, name: 'text', amount: 'real', category_id: 'text', payment_method: 'text', frequency: 'text', interval_weeks: 'integer',
    anchor_date: 'text', anchor_day_of_month: 'integer', location: 'text', owner_id: 'text', payee: 'text',
    payee_share_percent: 'real', pot_id: 'text', location_effective_from: 'text', location_history: 'json', active: 'bool',
    amount_effective_from: 'text', amount_history: 'json', kind: 'text', transfer_from_type: 'text',
    transfer_from_savings_pot_id: 'text', transfer_from_pot_id: 'text', transfer_to_type: 'text',
    transfer_to_savings_pot_id: 'text', transfer_to_pot_id: 'text', follows_payday: 'bool', follows_cycle_start: 'bool',
    recurring_transaction_type: 'text', person_id: 'text', ...P,
  }),
  t('recurring_template_occurrence_overrides', { ...H, recurring_template_id: 'text', ...OVERRIDE, ...P }),
  t('loans', {
    ...H, name: 'text', monthly_payment: 'real', monthly_payment_effective_from: 'text', monthly_payment_history: 'json',
    term_months: 'integer', start_date: 'text', category_id: 'text', color: 'text', location: 'text', owner_id: 'text',
    payee: 'text', payee_share_percent: 'real', pot_id: 'text', location_effective_from: 'text', location_history: 'json',
    schedule_from: 'text', recurring_overpayment: 'json', principal: 'real', lender: 'text', apr: 'real', advance_date: 'text',
    interest_convention_id: 'text', calibrated_monthly_rate: 'real', settlement_multiplier: 'real', active: 'bool',
    closed_date: 'text', settled_amount: 'real', ...P,
  }),
  t('loan_overpayments', { ...H, loan_id: 'text', date: 'text', amount: 'real', note: 'text', recast_mode: 'text', ...P }),
  t('loan_statement_calibration_lines', { ...H, loan_id: 'text', date: 'text', capital: 'real', interest: 'real', ...P }),
  t('credit_cards', {
    ...H, name: 'text', category_id: 'text', color: 'text', interest_rate_percent: 'real', current_balance: 'real',
    balance_as_of_date: 'text', minimum_payment_type: 'text', minimum_payment_amount: 'real', minimum_payment_percent: 'real',
    payment_day_of_month: 'integer', statement_start_day: 'integer', statement_end_day: 'integer', owner_id: 'text',
    location: 'text', pot_id: 'text', location_effective_from: 'text', location_history: 'json', schedule_from: 'text',
    active: 'bool', ...P,
  }),
  t('credit_card_lump_payments', { ...H, credit_card_id: 'text', date: 'text', amount: 'real', note: 'text', ...P }),
  t('credit_card_minimum_payment_overrides', { ...H, credit_card_id: 'text', date: 'text', amount: 'real', ...P }),
  t('joint_account', { ...H, opening_balance: 'real', opening_balance_date: 'text' }),
  t('transactions', {
    ...H, date: 'text', amount: 'real', direction: 'text', category_id: 'text', payment_method: 'text', status: 'text',
    type: 'text', note: 'text', location: 'text', owner_id: 'text', payee: 'text', payee_share_percent: 'real',
    person_id: 'text', source_type: 'text', source_id: 'text', occurrence_original_date: 'text', credit_card_id: 'text',
    savings_pot_id: 'text', pot_id: 'text', from_location_type: 'text', from_savings_pot_id: 'text', from_pot_id: 'text',
    to_location_type: 'text', to_savings_pot_id: 'text', to_pot_id: 'text', follows_payday: 'bool',
    follows_cycle_start: 'bool',
    // PROMPT-13 B2 — `amount` is ALREADY the rounded figure; `rounded_from`
    // is what it came from. The Coin Jar credit is derived from the pair
    // and is never a row of its own.
    rounded_from: 'real', rounding_pot_id: 'text',
    ...P,
  }),
  t('salary_sorts', { ...H, pay_date: 'text', ...P }),
  t('salary_sort_targets', {
    ...H, salary_sort_id: 'text', to_type: 'text', to_savings_pot_id: 'text', to_pot_id: 'text', amount: 'real',
    transaction_id: 'text', ...P,
  }),
  t('scenarios', { name: 'text', description: 'text', include_in_cumulative: 'bool', actions: 'json', ...P }, { household: false }),
]

export const localName = (remote: string) => LOCAL_PREFIX + remote

/** Local (`sfl_people`) → Postgres (`people`). Throws on anything unknown rather than writing to a guessed table. */
export function remoteName(local: string): string {
  if (!local.startsWith(LOCAL_PREFIX)) throw new Error(`[powersync] not a shared-finance-ledger table: ${local}`)
  const remote = local.slice(LOCAL_PREFIX.length)
  if (!SYNCED_TABLES.some((tb) => tb.remote === remote)) throw new Error(`[powersync] unknown table: ${local}`)
  return remote
}

export function tableSpec(remote: string): SyncedTable {
  const spec = SYNCED_TABLES.find((tb) => tb.remote === remote)
  if (!spec) throw new Error(`[powersync] unknown table: ${remote}`)
  return spec
}

/**
 * What the connector sends to Supabase for one row (PUT) or one change set
 * (PATCH). Local SQLite holds jsonb columns as TEXT; sent as-is, PostgREST
 * stores that text in the jsonb column as a single JSON *string* — then it
 * syncs back as a string, not the object (UAT 2026-09-19: a loan's
 * recurringOverpayment came back without `amount` and Home crashed). So
 * json columns are parsed back into values here, and 1/0 booleans become
 * true/false. PUTs also drop nulls (see connector.ts).
 */
export function toServerRecord(localTable: string, data: Record<string, unknown>, opts: { dropNulls: boolean }): Record<string, unknown> {
  const spec = tableSpec(remoteName(localTable)).columns
  const out: Record<string, unknown> = {}
  for (const [col, value] of Object.entries(data)) {
    if (opts.dropNulls && (value === null || value === undefined)) continue
    if (spec[col] === 'json' && typeof value === 'string') out[col] = JSON.parse(value)
    // SQLite holds booleans as 1/0; send real booleans rather than rely on Postgres coercing '1'.
    else if (spec[col] === 'bool' && (value === 0 || value === 1)) out[col] = value === 1
    else out[col] = value
  }
  return out
}

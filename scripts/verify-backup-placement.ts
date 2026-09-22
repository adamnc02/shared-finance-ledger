// PROMPT-14 Part 1 (2026-09-22) — the Backup & Restore slot is STRUCTURAL,
// not textual, and it stays sync-free.
//
// The real bug this prevents: `src/pages/**` is on DIVERGENCE.md's
// "Explicitly NOT allowed to diverge" list, so Salary.tsx must come out of
// this work byte-identical in both live apps. The obvious implementations —
// deleting the section from the sync app's copy, an `if (sync)`, an
// `import.meta.env` check — all break that silently: the build stays green,
// the register goes stale, and the two apps drift until someone wonders why
// mum's Wallet lost its buttons.
//
// The second bug it prevents is quieter still. BackupSection.tsx ships in the
// OFFLINE bundle. One `import { supabase }` added by a later session — say,
// to "also upload when online" — would pull the whole sync layer into
// personal-ledger's build. `check-sync-build.ts` would catch it only in the
// test app's root build; this catches it in the source, in every repo, in the
// ordinary sweep.
//
// What it asserts:
//  1. BackupSection.tsx exists and imports nothing from src/lib/powersync/**,
//     supabaseClient or @powersync/*;
//  2. it contains no build-time sync flag (VITE_SYNC_ENABLED is test-app-only)
//     and no window.confirm (MIGRATION-LESSONS §15: portalled modals only);
//  3. the placement context defaults to 'wallet', so an app that provides
//     nothing renders the card exactly as it always did;
//  4. WalletBackupSlot renders the section under the default and renders
//     nothing under 'account' — the actual behaviour, not just the source;
//  5. Salary.tsx renders the SLOT and no longer declares its own
//     BackupSection, so there is one copy of the UI and not two.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { BackupPlacementContext, WalletBackupSlot } from '../src/components/BackupSection'
import { defaultLedgerData } from '../src/lib/ledgerStorage'

// The sweep runs these through tsx, which transpiles JSX with esbuild's
// CLASSIC runtime (the root tsconfig is a solution file and sets no `jsx`;
// only tsconfig.app.json says "react-jsx", and that governs the app build).
// So a component's compiled body calls a bare React.createElement. Without
// this line the render below dies with "React is not defined", which looks
// like a bug in the component and is not.
;(globalThis as unknown as { React: typeof React }).React = React

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', detail)
  }
}

const root = resolve(import.meta.dirname, '..')
const sectionPath = resolve(root, 'src/components/BackupSection.tsx')
const salaryPath = resolve(root, 'src/pages/Salary.tsx')

console.log('\nBackupSection.tsx is shared and sync-free')
check('src/components/BackupSection.tsx exists', existsSync(sectionPath))
const source = existsSync(sectionPath) ? readFileSync(sectionPath, 'utf8') : ''
/** Comments stripped: this file EXPLAINS why it must not use these, and its own prose must not fail it. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// Import lines only: the file's prose explains why it must not import these,
// so matching the whole file would fail on its own comment.
const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l))
for (const banned of ['lib/powersync/', 'supabaseClient', '@powersync/', '@supabase/']) {
  check(`imports nothing matching "${banned}"`, !importLines.some((l) => l.includes(banned)), importLines.filter((l) => l.includes(banned)))
}
check('no VITE_SYNC_ENABLED / import.meta.env flag', !/import\.meta\.env/.test(code))
check('no window.confirm (portalled modals only, §15)', !/window\.confirm/.test(code))

console.log('\nThe slot renders by default and is claimed away')
const data = defaultLedgerData()
const props = { data, onRestore: () => {} }
const walletHtml = renderToStaticMarkup(createElement(WalletBackupSlot, props))
const accountHtml = renderToStaticMarkup(
  createElement(BackupPlacementContext.Provider, { value: 'account' as const }, createElement(WalletBackupSlot, props)),
)
check('with no provider at all, the card renders (the offline apps)', walletHtml.includes('Backup'), walletHtml.slice(0, 120))
check("under 'account', it renders nothing (the sync app)", accountHtml === '', accountHtml.slice(0, 120))
check("the context's default is 'wallet', not 'account'", /createContext<BackupPlacement>\('wallet'\)/.test(code))

console.log('\nSalary.tsx holds the slot, not a second copy of the UI')
const salary = existsSync(salaryPath) ? readFileSync(salaryPath, 'utf8') : ''
check('renders <WalletBackupSlot', salary.includes('<WalletBackupSlot'))
check('does not declare its own BackupSection', !/function BackupSection\b/.test(salary))
check('does not render <BackupSection directly', !salary.includes('<BackupSection'))

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)

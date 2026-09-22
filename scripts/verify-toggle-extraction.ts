// PROMPT-14 Part 7 (2026-09-22) — ToggleSwitch moved out of Home.tsx into a
// shared src/components/Toggle.tsx, and it was a PURE MOVE.
//
// Why the move happened: `src/pages/**` is on DIVERGENCE.md's "Explicitly NOT
// allowed to diverge" list, and the sync app needs this exact control in its
// Account modal for the notifications toggle. Copying the markup there is the
// TEXTUAL route — two copies of one control, free to drift — and the
// register's own rule is that structural beats textual.
//
// The risk the move creates is quieter than the one it removes: this control
// is three rows of the Filters sheet ("Show cleared", "Cycle-end totals",
// "Group by direction"), on the app's busiest page, in EVERY app. A stray
// pixel or a dropped aria attribute during the move would ship to all three
// and nobody would think to look at the filter sheet in a session about push
// notifications.
//
// So this pins the rendered result, in both layouts, in every state — the
// geometry, the colours, the ARIA — rather than trusting that a copy-paste
// was faithful.
//
// What it asserts:
//  1. Home.tsx no longer declares the component and imports it instead — one
//     copy exists, not two;
//  2. Toggle.tsx is shared-safe: no sync import, no page import, nothing that
//     would stop it shipping in the offline bundle;
//  3. the `full` layout (the Filters sheet's) renders its label, its optional
//     help caption, role=switch, aria-checked, and the 38×22 track with the
//     18px knob at translateX(16px) when on;
//  4. the compact layout renders the smaller 34×20 track with the 16px knob
//     at translateX(14px);
//  5. `disabled` greys the row to 0.4 and sets aria-disabled — and does NOT
//     simply hide it (Adam, 2026-09-13: greyed out, not hidden);
//  6. on = coral, off = track, in both layouts.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToggleSwitch } from '../src/components/Toggle'

// tsx transpiles JSX with esbuild's classic runtime (see verify-backup-placement.ts).
;(globalThis as unknown as { React: typeof React }).React = React

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}`)
    if (detail !== undefined) console.log('     ', String(detail).slice(0, 400))
  }
}

const root = resolve(import.meta.dirname, '..')
const togglePath = resolve(root, 'src/components/Toggle.tsx')
const homePath = resolve(root, 'src/pages/Home.tsx')
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

console.log('\n1. One copy of the control, not two')
check('src/components/Toggle.tsx exists', existsSync(togglePath))
const toggleSrc = existsSync(togglePath) ? readFileSync(togglePath, 'utf8') : ''
const homeSrc = existsSync(homePath) ? readFileSync(homePath, 'utf8') : ''
check('Home.tsx no longer declares ToggleSwitch', !/function ToggleSwitch\b/.test(strip(homeSrc)))
check("Home.tsx imports it from the shared file", /import \{ ToggleSwitch \} from '\.\.\/components\/Toggle'/.test(homeSrc))
check('Home.tsx still uses it', (homeSrc.match(/<ToggleSwitch/g) ?? []).length > 0, (homeSrc.match(/<ToggleSwitch/g) ?? []).length)

console.log('\n2. Shared-safe: it ships in the offline bundle')
const imports = toggleSrc.split('\n').filter((l) => /^\s*import\b/.test(l))
for (const banned of ['lib/powersync/', 'supabaseClient', '@powersync/', '@supabase/', '../pages/']) {
  check(`imports nothing matching "${banned}"`, !imports.some((l) => l.includes(banned)), imports.filter((l) => l.includes(banned)).join(' '))
}

const render = (props: Parameters<typeof ToggleSwitch>[0]) => renderToStaticMarkup(createElement(ToggleSwitch, props))
const noop = () => {}

console.log("\n3. The Filters sheet's layout (`full`)")
{
  const on = render({ label: 'Cycle-end totals', checked: true, onChange: noop, full: true })
  const off = render({ label: 'Show cleared', checked: false, onChange: noop, full: true, help: 'Include payments already cleared' })
  check('role="switch"', on.includes('role="switch"'))
  check('aria-checked follows the value', on.includes('aria-checked="true"') && off.includes('aria-checked="false"'))
  check('the label is rendered', on.includes('Cycle-end totals'))
  check('the help caption is rendered when given', off.includes('Include payments already cleared'))
  check('…and nothing extra when it is not', !on.includes('text-[11px] text-[var(--color-ink-muted)]'))
  check('track 38×22', on.includes('width:38px') && on.includes('height:22px'), on.match(/width:38px[^"]*/)?.[0])
  check('knob 18px, offset 16px when on', on.includes('width:18px') && on.includes('translateX(16px)'))
  check('…and offset 0 when off', off.includes('translateX(0)'))
}

console.log('\n4. The compact layout')
{
  const on = render({ label: 'Compact', checked: true, onChange: noop })
  check('track 34×20', on.includes('width:34px') && on.includes('height:20px'))
  check('knob 16px, offset 14px when on', on.includes('width:16px') && on.includes('translateX(14px)'))
  check('still role="switch" with aria-checked', on.includes('role="switch"') && on.includes('aria-checked="true"'))
}

console.log('\n5. Disabled is greyed, not hidden (Adam, 2026-09-13)')
{
  const disabled = render({ label: 'Group by direction', checked: false, onChange: noop, full: true, disabled: true })
  check('the row still renders', disabled.includes('Group by direction'))
  check('opacity 0.4', disabled.includes('opacity:0.4'), disabled.match(/opacity:[^;"]*/)?.[0])
  check('aria-disabled is set', disabled.includes('aria-disabled="true"'))
  check('the cursor says it is not interactive', disabled.includes('cursor:default'))
  const enabled = render({ label: 'Group by direction', checked: false, onChange: noop, full: true })
  check('an enabled row is opacity 1 and clickable', enabled.includes('opacity:1') && enabled.includes('cursor:pointer'))
}

console.log('\n6. On is coral, off is track — in both layouts')
for (const full of [true, false]) {
  const on = render({ label: 'x', checked: true, onChange: noop, full })
  const off = render({ label: 'x', checked: false, onChange: noop, full })
  check(`${full ? 'full' : 'compact'}: on uses --color-coral`, on.includes('var(--color-coral)'))
  check(`${full ? 'full' : 'compact'}: off uses --color-track`, off.includes('var(--color-track)') && !off.includes('var(--color-coral)'))
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)

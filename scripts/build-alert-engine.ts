// SYNC APP ONLY. Writes the Edge Function's copy of the projection engine.
//
//   npx tsx scripts/build-alert-engine.ts
//
// Run it after ANY change to src/lib that the alert path can reach — which is
// most of src/lib, since the shortfall rule composes the real projections.
// You do not have to remember: verify-alert-engine-bundle.ts fails the sweep
// until you do, and its message says to run this.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BUNDLE_PATH, buildAlertEngine } from './alertEngineBundle'

const bundle = await buildAlertEngine()
mkdirSync(dirname(BUNDLE_PATH), { recursive: true })
writeFileSync(BUNDLE_PATH, bundle)
console.log(`Wrote ${(bundle.length / 1024).toFixed(1)} kB to ${BUNDLE_PATH}`)

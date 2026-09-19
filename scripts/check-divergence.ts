// Fails on any difference between this repo and `personal-ledger` that
// DIVERGENCE.md's "Allowed divergence" table does not list.
//
// This app began as a byte-for-byte copy of personal-ledger and is meant to
// stay that way apart from sync: every real difference is a deliberate,
// written-down decision. Without a check, the two drift by accident — a fix
// made in one and forgotten in the other — and nobody notices until the
// behaviour differs in front of a user.
//
// NOT named verify-*: the strict sweep runs every verify-* inside one repo,
// and this one needs the sibling repo on disk. A sweep on a machine with only
// this repo checked out should still pass.
//
//   npm run check:divergence
//   npx tsx scripts/check-divergence.ts [otherRepoPath] [divergenceDocPath]
//
// Also overridable by PERSONAL_LEDGER_PATH / DIVERGENCE_DOC env vars.
//
// Two paths are excluded outright rather than given rows to police:
// package-lock.json, whose transitive versions drift whenever the two repos
// are installed separately (known and harmless — see TEST-APP-DIVERGENCE.md),
// and shared-ledger-apple-touch-icon.png, the source logo only this repo has.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const otherRepo = resolve(process.argv[2] ?? process.env.PERSONAL_LEDGER_PATH ?? join(repoRoot, '..', 'personal-ledger'))
const divergenceDoc = resolve(
  process.argv[3] ??
    process.env.DIVERGENCE_DOC ??
    '/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/DIVERGENCE.md',
)

/** Directories compared in full, plus the root files listed below them. Anything outside this scope (node_modules, dist, .git) is not this check's business. */
const SCOPE_DIRS = ['src', 'scripts', 'public']
const SCOPE_ROOT_FILES = [
  'index.html',
  'package.json',
  'README.md',
  'vite.config.ts',
  'vitest.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  '.gitignore',
]
const EXCLUDED = new Set(['package-lock.json', 'shared-ledger-apple-touch-icon.png', '.DS_Store'])

function filesUnder(root: string, dir: string): string[] {
  const absolute = join(root, dir)
  if (!existsSync(absolute)) return []
  const out: string[] = []
  for (const entry of readdirSync(absolute)) {
    const full = join(absolute, entry)
    const rel = relative(root, full)
    if (EXCLUDED.has(entry)) continue
    if (statSync(full).isDirectory()) out.push(...filesUnder(root, rel))
    else out.push(rel)
  }
  return out
}

function scopedFiles(root: string): Set<string> {
  const files = SCOPE_DIRS.flatMap((d) => filesUnder(root, d))
  for (const f of SCOPE_ROOT_FILES) {
    if (existsSync(join(root, f))) files.push(f)
  }
  return new Set(files)
}

/**
 * Glob matcher for the table's first column. `**` spans directory
 * separators, `*` does not, so `src/lib/*.ts` stays one level deep while
 * `src/lib/powersync/**` covers the subtree. A bare path matches itself.
 * Small on purpose: adding a dependency to this repo is a divergence of its
 * own (package.json), which is exactly what the check exists to catch.
 */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        // `a/**/b` should also match `a/b`, so swallow a following slash.
        if (glob[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if ('\\^$+?.()|{}[]'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`)
}

interface DivergenceRules {
  allowed: { glob: string; re: RegExp }[]
  forbidden: { glob: string; re: RegExp; except: RegExp[] }[]
}

/**
 * Reads the two lists out of DIVERGENCE.md: the table rows under "## Allowed
 * divergence", and the bulleted paths under "## Explicitly NOT allowed to
 * diverge". The doc is the source of truth, so the check can never quietly
 * disagree with what is written down.
 */
function parseDivergenceDoc(text: string): DivergenceRules {
  const section = (heading: string): string => {
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.startsWith(heading))
    if (start === -1) return ''
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((l) => /^## /.test(l))
    return (end === -1 ? rest : rest.slice(0, end)).join('\n')
  }

  const backticked = (line: string): string | null => {
    const m = line.match(/`([^`]+)`/)
    return m ? m[1] : null
  }

  const allowed: string[] = []
  for (const line of section('## Allowed divergence').split('\n')) {
    if (!line.trim().startsWith('|')) continue
    // Skip the header and the |---|---| separator.
    if (/^\|\s*-+/.test(line.trim()) || /Path \/ glob/.test(line)) continue
    const first = line.split('|')[1] ?? ''
    const path = backticked(first)
    if (path) allowed.push(path)
  }

  // A bullet may carve exceptions out of its glob: every backticked path after
  // the word "except" (PROMPT-09: `src/lib/**` except the sync layer). Before
  // this, the prose exception was never enforced, only the first path.
  const forbidden: { glob: string; except: string[] }[] = []
  for (const line of section('## Explicitly NOT allowed to diverge').split('\n')) {
    if (!line.trim().startsWith('-')) continue
    const path = backticked(line)
    if (!path) continue
    const at = line.search(/\bexcept\b/)
    const except = at === -1 ? [] : [...line.slice(at).matchAll(/`([^`]+)`/g)].map((m) => m[1])
    forbidden.push({ glob: path, except })
  }

  return {
    allowed: allowed.map((glob) => ({ glob, re: globToRegExp(glob) })),
    forbidden: forbidden.map(({ glob, except }) => ({ glob, re: globToRegExp(glob), except: except.map(globToRegExp) })),
  }
}

function sameContent(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b))
}

function main(): void {
  if (!existsSync(otherRepo)) {
    console.error(`✗ personal-ledger not found at ${otherRepo}`)
    console.error('  Pass its path as the first argument, or set PERSONAL_LEDGER_PATH.')
    process.exit(1)
  }
  if (!existsSync(divergenceDoc)) {
    console.error(`✗ DIVERGENCE.md not found at ${divergenceDoc}`)
    console.error('  Pass its path as the second argument, or set DIVERGENCE_DOC.')
    process.exit(1)
  }

  const rules = parseDivergenceDoc(readFileSync(divergenceDoc, 'utf8'))
  console.log(`Comparing against ${otherRepo}`)
  console.log(`Rules from ${divergenceDoc}: ${rules.allowed.length} allowed, ${rules.forbidden.length} forbidden\n`)

  const here = scopedFiles(repoRoot)
  const there = scopedFiles(otherRepo)
  const every = [...new Set([...here, ...there])].sort()

  const failures: string[] = []
  let differing = 0

  for (const rel of every) {
    const inHere = here.has(rel)
    const inThere = there.has(rel)
    const differs = !inHere || !inThere || !sameContent(join(repoRoot, rel), join(otherRepo, rel))
    if (!differs) continue
    differing++

    const how = !inThere ? 'only in shared-finance-ledger' : !inHere ? 'only in personal-ledger' : 'differs'

    // Forbidden wins over allowed: a file on that list differing is a bug even
    // if some broad row above happens to cover it.
    const forbiddenBy = rules.forbidden.find((r) => r.re.test(rel) && !r.except.some((e) => e.test(rel)))
    if (forbiddenBy) {
      console.log(`✗ ${rel} — ${how}, and \`${forbiddenBy.glob}\` is on the NOT-allowed list`)
      failures.push(rel)
      continue
    }

    const allowedBy = rules.allowed.find((r) => r.re.test(rel))
    if (allowedBy) {
      console.log(`✓ ${rel} — ${how} (allowed by \`${allowedBy.glob}\`)`)
      continue
    }

    console.log(`✗ ${rel} — ${how}, and no row in DIVERGENCE.md covers it`)
    failures.push(rel)
  }

  console.log(`\n${differing} file(s) differ, ${failures.length} not accounted for.`)
  if (failures.length > 0) {
    console.log('\nEither port the change to the other repo, or add a row to DIVERGENCE.md saying why it stays.')
    process.exit(1)
  }
  console.log('All divergence is accounted for.')
}

main()

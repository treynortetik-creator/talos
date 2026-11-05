// `pnpm drive <journey>`: runs one end-to-end journey (or all of them) on the real stack and prints what happened.
//   pnpm drive list                 the journeys
//   pnpm drive <name> [--no-build]  one journey; --no-build reuses the relay and web builds already in dist
//   pnpm drive all                  every journey
//   pnpm drive <name> -- <flags>    anything after -- goes to `playwright test` (for example --repeat-each 3)
// The exit code is Playwright's: 0 when every journey held, non-zero otherwise (2: a journey name that does not exist, more than one name, or a flag drive does not know).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const journeyDir = join(here, 'tests', 'journeys')
const journeys = readdirSync(journeyDir)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => f.replace(/\.spec\.ts$/, ''))
  .sort()

const argv = process.argv.slice(2)
const dash = argv.indexOf('--')
const mine = dash === -1 ? argv : argv.slice(0, dash)
const passThrough = dash === -1 ? [] : argv.slice(dash + 1)
const noBuild = mine.includes('--no-build')
const known = new Set(['--no-build', '--help'])
// Words are journey names. Anything starting with a dash is a flag; a flag we do not know takes the word after it (when
// that does not start with a dash and the flag has no `=`) as its value, so the hint can repeat it whole: `--repeat-each 3`.
const words: string[] = []
const strays: string[] = []
for (let i = 0; i < mine.length; i++) {
  const a = mine[i] as string
  if (!a.startsWith('-')) words.push(a)
  else if (!known.has(a)) {
    const next = mine[i + 1]
    if (!a.includes('=') && next !== undefined && !next.startsWith('-')) {
      strays.push(`${a} ${next}`)
      i++
    } else strays.push(a)
  }
}
const what = words[0]

if (!what || what === 'list' || what === 'help' || mine.includes('--help')) {
  // `list` and `help` take nothing else: `pnpm drive list revoke` or `pnpm drive help --repeat-each 3` is a mistake, not a list.
  if (words.length > 1 || strays.length > 0) {
    console.error(
      `"${what ?? '--help'}" takes no other words or flags, got: ${[...words.slice(1), ...strays].join(' ')}`,
    )
    process.exit(2)
  }
  console.log(
    `Journeys:\n${journeys.map((j) => `  ${j}`).join('\n')}\n\nUsage: pnpm drive <journey>|all|list [--no-build] [-- <playwright flags>]`,
  )
  process.exit(what ? 0 : 2)
}

// Anything else would be dropped without a word (`pnpm drive revoke --repeat-each 3`) or run only the first of several
// names, and still exit 0. Refuse both.
if (words.length > 1 || strays.length > 0) {
  if (words.length > 1)
    console.error(`One journey at a time (or "all"), got ${words.length}: ${words.join(', ')}. Run them one by one.`)
  if (strays.length > 0)
    console.error(
      `Not a drive flag: ${strays.join(', ')}. Playwright flags go after --, e.g. pnpm drive ${what} -- ${strays.join(' ')}`,
    )
  process.exit(2)
}

let files: string[]
if (what === 'all') files = journeys
else if (journeys.includes(what)) files = [what]
else {
  console.error(`No journey called "${what}". Journeys: ${journeys.join(', ')}`)
  process.exit(2)
}

const args = [
  'exec',
  'playwright',
  'test',
  ...files.map((f) => `tests/journeys/${f}.spec.ts`),
  `--reporter=${join(here, 'harness', 'drive-reporter.ts')}`,
  ...passThrough,
]
const r = spawnSync('pnpm', args, {
  cwd: here,
  stdio: 'inherit',
  env: { ...process.env, ...(noBuild ? { E2E_SKIP_BUILD: '1' } : {}) },
})
process.exit(r.status ?? 1)

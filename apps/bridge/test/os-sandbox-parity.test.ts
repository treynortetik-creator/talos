// The OS sandbox's settings and refusals, built from the recipe the Mac's tests also run (apps/desktop/Tests/Fixtures/os-sandbox/
// recipe.json) and compared with the golden file beside it. The two fixture files belong to the desktop app's tree: this test READS them
// from there (never a copy), or, while they are not yet in this tree, from the commit named by TALOS_OSBX_PARITY_REF
// (`git show <ref>:<path>`). With neither it does not run (a plain line says so). A mismatch is a bug to settle, never a golden to refresh.
// gate-reads: apps/desktop/Tests/Fixtures/os-sandbox/recipe.json apps/desktop/Tests/Fixtures/os-sandbox/golden.json
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WORKER_FILES } from '@talos-app/protocol'
import {
  OS_SANDBOX_DENY_READ,
  OS_SANDBOX_DENY_WRITE,
  osSandboxPreflight,
  osSandboxSettings,
  prepareOsSandbox,
} from '../src/guards/os-sandbox.ts'
import { CACHE_ENV } from '../src/lead/settings.ts'

const REL = 'apps/desktop/Tests/Fixtures/os-sandbox'
const REPO = resolve(import.meta.dir, '../../..')
function fixture(name: string): unknown | null {
  const p = join(REPO, REL, name)
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  const ref = process.env.TALOS_OSBX_PARITY_REF
  if (!ref) return null
  return JSON.parse(execFileSync('git', ['-C', REPO, 'show', `${ref}:${REL}/${name}`], { encoding: 'utf8' }))
}

type Entry = {
  path: string
  text?: string
  link?: string
  replace?: boolean
  absolute?: boolean
  removeDir?: boolean
  hardlinkTo?: string
}
type Trusted = { bun: string; bridgeDir: string } | null
type Recipe = {
  gitConfigCount: number
  ownerExcludes: string[]
  trustedBridge: Trusted
  entries: Entry[]
  cases: Array<{ name: string; entries: Entry[]; launchArgs?: string[]; trustedBridge?: Trusted }>
}
type Golden = { cases: Record<string, string | null>; names: Record<string, unknown>; pieces: Record<string, unknown> }

const recipe = fixture('recipe.json') as Recipe | null
const golden = fixture('golden.json') as Golden | null
const run = test.skipIf(recipe === null || golden === null)

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f()
})
const KIT_WAS = process.env.TALOS_KIT_HOME
afterEach(() => {
  if (KIT_WAS === undefined) delete process.env.TALOS_KIT_HOME
  else process.env.TALOS_KIT_HOME = KIT_WAS
})

/** The tree of `entries` under a case-mixed root; later entries for the same path replace earlier ones. */
function build(entries: Entry[]): string {
  const base = join(realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'osbx-'))), 'TalosOsbxCase')
  mkdirSync(base)
  cleanup.push(() => rmSync(dirname(base), { recursive: true, force: true }))
  const byPath = new Map<string, Entry>()
  for (const e of entries) byPath.set(e.path, e)
  for (const e of byPath.values()) {
    const at = e.absolute ? e.path : join(base, e.path)
    const made = !existsSync(dirname(at))
    mkdirSync(dirname(at), { recursive: true })
    if (e.absolute) {
      cleanup.push(() => rmSync(e.removeDir ? dirname(at) : at, { recursive: true, force: true }))
      if (made && !e.removeDir) cleanup.push(() => rmSync(dirname(at), { recursive: true, force: true }))
    }
    if (e.link !== undefined) {
      if (e.replace) rmSync(at, { force: true })
      symlinkSync(e.link, at)
    } else {
      writeFileSync(at, (e.text ?? '').replaceAll('{ROOT}', base))
      if (e.hardlinkTo) {
        mkdirSync(dirname(join(base, e.hardlinkTo)), { recursive: true })
        linkSync(at, join(base, e.hardlinkTo))
      }
    }
  }
  process.env.TALOS_KIT_HOME = join(base, 'Kit')
  return base
}

/** The record the recipe names (paths relative to the root), or null. */
const trustedOf = (t: Trusted, base: string) =>
  t ? { bun: join(base, t.bun), bridgeDir: join(base, t.bridgeDir) } : null

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v
/** The root as a placeholder (`<BASE>` as spelled, `<base>` in lower case), and the Mac's /private/tmp as this machine's real /tmp. */
const placeholder = (s: string, base: string) => s.replaceAll(base, '<BASE>').replaceAll(base.toLowerCase(), '<base>')
const hostTmp = (s: string) => s.replaceAll('/private/tmp', realpathSync('/tmp'))

describe('the OS sandbox builds what the Mac builds (recipe.json and golden.json)', () => {
  run('the names the settings are built from', () => {
    const g = (golden as Golden).names
    expect(OS_SANDBOX_DENY_WRITE).toEqual(g.denyWrite as string[])
    expect(OS_SANDBOX_DENY_READ).toEqual(g.denyRead as string[])
    expect(sortKeys(CACHE_ENV)).toEqual(sortKeys(g.cacheEnv))
    expect([...Object.values(WORKER_FILES)] as string[]).toEqual(g.workerFiles as string[])
  })

  run('the pieces for the plain tree, byte for byte', () => {
    const r = recipe as Recipe
    const base = build(r.entries)
    const p = osSandboxSettings({
      talosHome: join(base, 'TalosHome'),
      userHome: join(base, 'UserHome'),
      folder: join(base, 'Agent'),
      platform: 'darwin',
      gitConfigCount: r.gitConfigCount,
      ownerExcludes: r.ownerExcludes,
      trusted: trustedOf(r.trustedBridge, base),
    })
    const got = placeholder(JSON.stringify(sortKeys({ env: p.env, excludes: p.excludes, sandbox: p.sandbox })), base)
    expect(JSON.parse(got)).toEqual(sortKeys((golden as Golden).pieces) as object)
    // the home's preflight and the folder's checks: the plain tree starts
    expect(osSandboxPreflight(join(base, 'TalosHome'))).toBeNull()
  })

  for (const c of (recipe as Recipe | null)?.cases ?? [])
    run(`the whole start: ${c.name}`, () => {
      const r = recipe as Recipe
      const base = build([...r.entries, ...c.entries])
      const out = prepareOsSandbox(
        {
          talosHome: join(base, 'TalosHome'),
          userHome: join(base, 'UserHome'),
          folder: join(base, 'Agent'),
          claudeDir: join(base, 'UserHome', '.claude'),
          platform: 'darwin',
          ...(c.launchArgs ? { launchArgs: c.launchArgs } : {}),
          trusted: trustedOf('trustedBridge' in c ? (c.trustedBridge as Trusted) : r.trustedBridge, base),
        },
        { ownerExcludes: () => [], write: () => {} },
      )
      const line = 'refusal' in out ? placeholder(out.refusal, base) : null
      const want = (golden as Golden).cases[c.name]
      expect(line).toBe(want === null || want === undefined ? null : hostTmp(want))
    })

  run('the plain tree starts (golden: null)', () => {
    expect((golden as Golden).cases['the plain tree']).toBeNull()
    const base = build((recipe as Recipe).entries)
    const out = prepareOsSandbox(
      {
        talosHome: join(base, 'TalosHome'),
        userHome: join(base, 'UserHome'),
        folder: join(base, 'Agent'),
        claudeDir: join(base, 'UserHome', '.claude'),
        platform: 'darwin',
        trusted: trustedOf((recipe as Recipe).trustedBridge, base),
      },
      { ownerExcludes: () => [], write: () => {} },
    )
    expect('refusal' in out ? out.refusal : null).toBeNull()
  })
})

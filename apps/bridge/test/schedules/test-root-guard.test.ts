// A test bridge must never reach the owner's real Chronos. With TALOS_TEST_ROOT set (only a test harness does), a Chronos is used
// only if its program, the HOME it is started with and its config all resolve, symlinks followed, to a place under that folder; every
// verb passes the one check, `due` (which writes Chronos's own beat) and `session-beat` included. A root that is set but empty, blank,
// relative or `/` refuses everything. With no TALOS_TEST_ROOT at all nothing changes: that is production.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeEnv } from '../../src/config.ts'
import { ChronosAdapter } from '../../src/schedules/chronos-adapter.ts'
import { chronosCandidates, discover } from '../../src/schedules/discovery.ts'
import { chronosRefusal, isUnderRoot } from '../../src/schedules/test-root.ts'

let dir = ''
let savedRoot: string | undefined
let savedXdg: string | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'talos-root-guard-'))
  savedRoot = process.env.TALOS_TEST_ROOT
  savedXdg = process.env.XDG_CONFIG_HOME
  delete process.env.TALOS_TEST_ROOT
  delete process.env.XDG_CONFIG_HOME
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedRoot === undefined) delete process.env.TALOS_TEST_ROOT
  else process.env.TALOS_TEST_ROOT = savedRoot
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
})

const VERSION = '{"api":1,"chronos":"0.5.1","session_runner":"talos","approval_required":true}'

/** A Chronos that answers `api version` and writes `ran` in its own folder every time it is started (the beat a verb would write). */
function fakeChronos(where: string): { bin: string; ran: string } {
  mkdirSync(join(where, 'bin'), { recursive: true })
  const bin = join(where, 'bin', 'chronos')
  const ran = join(where, 'ran')
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> '${ran}'\ncase "$1 $2" in\n  "api version") echo '${VERSION}' ;;\n  "version "*) echo 'chronos 0.5.1' ;;\n  *) echo '{}' ;;\nesac\n`,
    { mode: 0o755 },
  )
  return { bin, ran }
}

const folders = () => {
  const root = join(dir, 'test-root')
  const outside = join(dir, 'owner-home')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  return { root, outside }
}

describe('the paths check', () => {
  test('a program inside the root is allowed, outside is refused, a link inside that points outside is refused', () => {
    const { root, outside } = folders()
    const home = join(root, 'home')
    const inside = fakeChronos(join(root, 'box'))
    const away = fakeChronos(join(outside, '.local', 'share', 'chronos'))
    expect(chronosRefusal(inside.bin, root, { home })).toBeNull()
    expect(chronosRefusal(away.bin, root, { home })).not.toBeNull()
    const link = join(root, 'chronos-link')
    symlinkSync(away.bin, link)
    expect(chronosRefusal(link, root, { home })).not.toBeNull()
    const dirLink = join(root, 'dir-link')
    symlinkSync(join(outside, '.local', 'share', 'chronos'), dirLink)
    expect(chronosRefusal(join(dirLink, 'bin', 'chronos'), root, { home })).not.toBeNull()
    // a name that only starts like the root is not inside it, and nor is a path with `..`
    expect(isUnderRoot(`${root}-sibling/chronos`, root)).toBe(false)
    expect(isUnderRoot(join(root, '..', 'owner-home', 'x'), root)).toBe(false)
    expect(isUnderRoot('relative/chronos', root)).toBe(false)
  })

  test('Chronos reads ~: a HOME that is unset, outside the root, or a link out of it refuses a program that is inside', () => {
    const { root, outside } = folders()
    const inside = fakeChronos(join(root, 'box'))
    expect(chronosRefusal(inside.bin, root, {})).toMatch(/HOME/)
    expect(chronosRefusal(inside.bin, root, { home: outside })).toMatch(/HOME/)
    const homeLink = join(root, 'home-link')
    symlinkSync(outside, homeLink)
    expect(chronosRefusal(inside.bin, root, { home: homeLink })).toMatch(/HOME/)
    expect(chronosRefusal(inside.bin, root, { home: join(root, 'home') })).toBeNull()
  })

  test('the config: one named outside the root refuses; with none named the default under HOME must be inside the root', () => {
    const { root, outside } = folders()
    const inside = fakeChronos(join(root, 'box'))
    const home = join(root, 'home')
    expect(chronosRefusal(inside.bin, root, { home, config: join(outside, 'config.json') })).toMatch(/config/)
    expect(chronosRefusal(inside.bin, root, { home, config: join(root, 'config.json') })).toBeNull()
    // the default <home>/.config/chronos/config.json is a link that leaves the root
    mkdirSync(join(home, '.config'), { recursive: true })
    symlinkSync(outside, join(home, '.config', 'chronos'))
    expect(chronosRefusal(inside.bin, root, { home })).toMatch(/config/)
  })

  test('a root that is empty, blank, relative or the top of the file system refuses every Chronos (it fails closed)', () => {
    const { root } = folders()
    const inside = fakeChronos(join(root, 'box'))
    for (const bad of ['', '   ', 'relative/root', '/'])
      expect(chronosRefusal(inside.bin, bad, { home: join(root, 'home') }), JSON.stringify(bad)).not.toBeNull()
    expect(isUnderRoot(inside.bin, '/')).toBe(false)
  })
})

describe('every Chronos verb the bridge runs', () => {
  const adapter = (bin: string, home?: string, testRoot?: string) =>
    new ChronosAdapter({ bin, timeoutMs: 5000, ...(home ? { env: { path: '/usr/bin:/bin', home } } : {}), testRoot })

  test('with a test root and a Chronos outside it, no verb starts the program: no beat is written', async () => {
    const { root, outside } = folders()
    const away = fakeChronos(join(outside, '.local', 'share', 'chronos'))
    process.env.TALOS_TEST_ROOT = root
    const a = adapter(away.bin, join(root, 'home'))
    for (const verb of [['version'], ['due'], ['session-beat'], ['snapshot'], ['claim', 'job']])
      await expect(a.raw(verb)).rejects.toThrow(/refused in a test/)
    expect(existsSync(away.ran)).toBe(false)
  })

  test('with a test root and a Chronos inside it, and its HOME inside, the verbs run', async () => {
    const { root } = folders()
    const inside = fakeChronos(join(root, 'box'))
    process.env.TALOS_TEST_ROOT = root
    await adapter(inside.bin, join(root, 'home')).raw(['due'])
    expect(existsSync(inside.ran)).toBe(true)
  })

  test('a Chronos inside the root started with no HOME, or the real one, is refused', async () => {
    const { root, outside } = folders()
    const inside = fakeChronos(join(root, 'box'))
    process.env.TALOS_TEST_ROOT = root
    await expect(adapter(inside.bin).raw(['due'])).rejects.toThrow(/refused in a test/)
    await expect(adapter(inside.bin, outside).raw(['session-beat'])).rejects.toThrow(/refused in a test/)
    expect(existsSync(inside.ran)).toBe(false)
  })

  test('the root passed to the adapter counts, with nothing in the process env', async () => {
    const { root, outside } = folders()
    const away = fakeChronos(join(outside, '.local', 'share', 'chronos'))
    await expect(adapter(away.bin, join(root, 'home'), root).raw(['due'])).rejects.toThrow(/refused in a test/)
    expect(existsSync(away.ran)).toBe(false)
  })

  test('an empty or blank TALOS_TEST_ROOT refuses everything, and no program is started', async () => {
    const { root } = folders()
    const inside = fakeChronos(join(root, 'box'))
    for (const bad of ['', '  ']) {
      process.env.TALOS_TEST_ROOT = bad
      await expect(adapter(inside.bin, join(root, 'home')).raw(['due'])).rejects.toThrow(/refused in a test/)
    }
    expect(existsSync(inside.ran)).toBe(false)
  })

  test('a link inside the root that points at the owner’s Chronos does not start it', async () => {
    const { root, outside } = folders()
    const away = fakeChronos(join(outside, '.local', 'share', 'chronos'))
    const link = join(root, 'chronos')
    symlinkSync(away.bin, link)
    process.env.TALOS_TEST_ROOT = root
    await expect(adapter(link, join(root, 'home')).raw(['session-beat'])).rejects.toThrow(/refused in a test/)
    expect(existsSync(away.ran)).toBe(false)
  })

  test('with no test root (production) a Chronos anywhere runs, as before', async () => {
    const { outside } = folders()
    const away = fakeChronos(join(outside, '.local', 'share', 'chronos'))
    await adapter(away.bin).raw(['due'])
    expect(existsSync(away.ran)).toBe(true)
  })
})

describe('discovery', () => {
  const env = (home: string, o: Partial<BridgeEnv> = {}) =>
    ({
      scheduler: 'auto',
      chronosBin: undefined,
      chronosAutoDiscover: true,
      chronosConfig: undefined,
      schedulerTimeoutMs: 5000,
      chronosNow: undefined,
      pathDirs: [],
      userHome: home,
      tz: 'UTC',
      ...o,
    }) as unknown as BridgeEnv
  const deps = (home: string, log: (m: string) => void = () => {}) =>
    ({
      meta: { threadOf: () => undefined, offerAgeS: () => null },
      now: () => Date.now(),
      clockIso: () => new Date().toISOString(),
      bundledChronos: join(home, 'no-bundled-copy', 'bin', 'chronos'),
      log,
    }) as unknown as Parameters<typeof discover>[1]

  test("with a test root, the owner's real Chronos under the home is never asked, and one line says so", async () => {
    const { root, outside } = folders()
    const away = fakeChronos(join(outside, '.local', 'share', 'chronos'))
    process.env.TALOS_TEST_ROOT = root
    const lines: string[] = []
    const d = await discover(
      env(outside),
      deps(outside, (m) => lines.push(m)),
    )
    expect(d.state).not.toBe('ready')
    expect(existsSync(away.ran)).toBe(false)
    expect(lines.length).toBeLessThanOrEqual(1)
  })

  test('a pinned program outside the root is refused too, and one inside (with its HOME inside) is found', async () => {
    const { root, outside } = folders()
    const away = fakeChronos(join(outside, 'pinned'))
    const inside = fakeChronos(join(root, 'box'))
    const home = join(root, 'home')
    process.env.TALOS_TEST_ROOT = root
    expect((await discover(env(home, { chronosBin: away.bin }), deps(home))).state).not.toBe('ready')
    expect(existsSync(away.ran)).toBe(false)
    expect((await discover(env(home, { chronosBin: inside.bin }), deps(home))).state).toBe('ready')
    // the same program, but the bridge's HOME is the owner's: refused
    expect((await discover(env(outside, { chronosBin: inside.bin }), deps(outside))).state).not.toBe('ready')
  })

  test('a blank TALOS_TEST_ROOT finds nothing, even for a pinned program', async () => {
    const { root } = folders()
    const inside = fakeChronos(join(root, 'box'))
    process.env.TALOS_TEST_ROOT = '   '
    expect((await discover(env(root, { chronosBin: inside.bin }), deps(root))).state).not.toBe('ready')
    expect(existsSync(inside.ran)).toBe(false)
  })

  test('with no test root (production) discovery finds the Chronos under the home exactly as before', async () => {
    const { outside } = folders()
    const away = fakeChronos(join(outside, '.local', 'share', 'chronos'))
    expect(chronosCandidates(env(outside) as never)).toContain(away.bin)
    const d = await discover(env(outside), deps(outside))
    expect(d.state).toBe('ready')
    expect(existsSync(away.ran)).toBe(true)
  })
})

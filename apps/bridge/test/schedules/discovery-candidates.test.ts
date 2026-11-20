// Dante's setup (2026-11-19, found by Lemnos): SETUP.md 9.1 (`./install.sh --with-chronos`) vendors Chronos to
// ~/.local/share/talos/chronos and runs it there, but discovery looked only on PATH and in ~/.local/share/chronos, so Schedules
// said "No scheduler" and told the owner to clone Chronos a second time. Discovery now also tries the folder the kit recorded,
// the kit's vendor folder and the copy in this checkout (apps/chronos).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeEnv } from '../../src/config.ts'
import { chronosCandidates, discover } from '../../src/schedules/discovery.ts'
import { REPO_DIR } from '../../src/version.ts'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'talos-disc-cand-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const VERSION = '{"api":1,"chronos":"0.5.1","session_runner":"talos","approval_required":true}'

/** A Chronos that answers discovery: `api version` with the API's JSON, `version` with its own line. */
function fakeChronos(dir: string): string {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  const bin = join(dir, 'bin', 'chronos')
  writeFileSync(
    bin,
    `#!/bin/sh\ncase "$1 $2" in\n  "api version") echo '${VERSION}' ;;\n  "version "*) echo 'chronos 0.5.1' ;;\n  *) echo '{}' ;;\nesac\n`,
    { mode: 0o755 },
  )
  return bin
}

const env = (o: Partial<BridgeEnv> = {}) =>
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
const deps = (o: Record<string, unknown> = {}) =>
  ({
    meta: { threadOf: () => undefined, offerAgeS: () => null },
    now: () => Date.now(),
    clockIso: () => new Date().toISOString(),
    bundledChronos: join(home, 'no-bundled-copy', 'bin', 'chronos'),
    ...o,
  }) as unknown as Parameters<typeof discover>[1]

describe('chronosCandidates', () => {
  const config = () => {
    mkdirSync(join(home, '.config', 'chronos'), { recursive: true })
    writeFileSync(join(home, '.config', 'chronos', 'config.json'), '{}')
  }
  const record = (text: string, root = join(home, '.config')) => {
    mkdirSync(join(root, 'talos'), { recursive: true })
    writeFileSync(join(root, 'talos', 'chronos-dir'), text)
  }
  const at = (o: { pathDirs?: string[]; chronosConfig?: string } = {}) => ({
    pathDirs: o.pathDirs ?? [],
    userHome: home,
    chronosConfig: o.chronosConfig,
  })

  test('PATH, the runtime copy launchd or systemd runs, the folder the kit recorded, the vendor folder, this checkout', () => {
    config()
    record('/opt/somewhere/chronos\n')
    expect(
      chronosCandidates(at({ pathDirs: ['/usr/local/bin', '/usr/bin'] }), '/repo/apps/chronos/bin/chronos', ''),
    ).toEqual([
      '/usr/local/bin/chronos',
      '/usr/bin/chronos',
      join(home, '.local/share/chronos/bin/chronos'),
      '/opt/somewhere/chronos/bin/chronos',
      join(home, '.local/share/talos/chronos/bin/chronos'),
      '/repo/apps/chronos/bin/chronos',
    ])
  })

  test('the copy in this checkout (default apps/chronos) only once Chronos has a config: with none it answers on defaults', () => {
    expect(chronosCandidates(at(), undefined, '')).not.toContain(join(REPO_DIR, 'apps', 'chronos', 'bin', 'chronos'))
    config()
    expect(chronosCandidates(at(), undefined, '').at(-1)).toBe(join(REPO_DIR, 'apps', 'chronos', 'bin', 'chronos'))
    // TALOS_APP_CHRONOS_CONFIG names it elsewhere
    const other = join(home, 'cfg.json')
    writeFileSync(other, '{}')
    rmSync(join(home, '.config', 'chronos'), { recursive: true })
    expect(chronosCandidates(at({ chronosConfig: other }), '/b', '').at(-1)).toBe('/b')
  })

  test('a recorded folder that is the vendor folder is listed once', () => {
    record(join(home, '.local/share/talos/chronos'))
    const c = chronosCandidates(at(), '/b', '')
    expect(c.filter((p) => p === join(home, '.local/share/talos/chronos/bin/chronos'))).toHaveLength(1)
  })

  test('XDG_CONFIG_HOME moves the kit record and the Chronos config, as the kit installer does', () => {
    const xdg = join(home, 'xdg')
    record('/opt/x/chronos', xdg)
    mkdirSync(join(xdg, 'chronos'), { recursive: true })
    writeFileSync(join(xdg, 'chronos', 'config.json'), '{}')
    const c = chronosCandidates(at(), '/b', xdg)
    expect(c).toContain('/opt/x/chronos/bin/chronos')
    expect(c.at(-1)).toBe('/b')
    // a relative XDG_CONFIG_HOME is not one (the spec says ignore it)
    expect(chronosCandidates(at(), '/b', 'rel')).not.toContain('/opt/x/chronos/bin/chronos')
  })

  test('a kit record that is relative, or not one line, is ignored', () => {
    for (const bad of ['relative/chronos', '/a\n/b']) {
      record(bad)
      const c = chronosCandidates(at(), '/b', '')
      expect(
        c.some((p) => p.includes('relative') || p.startsWith('/a/')),
        bad,
      ).toBe(false)
    }
  })
})

describe('discover finds the Chronos a kit install set up', () => {
  test('in the kit vendor folder (SETUP.md 9.1): ready, never "not installed"', async () => {
    fakeChronos(join(home, '.local', 'share', 'talos', 'chronos'))
    const d = await discover(env(), deps())
    expect(d.state).toBe('ready')
  })

  test('in the folder the kit recorded', async () => {
    const dir = join(home, 'elsewhere', 'chronos')
    fakeChronos(dir)
    mkdirSync(join(home, '.config', 'talos'), { recursive: true })
    writeFileSync(join(home, '.config', 'talos', 'chronos-dir'), `${dir}\n`)
    expect((await discover(env(), deps())).state).toBe('ready')
  })

  test('the copy in this checkout, when nothing else is there and Chronos has a config; without one, not installed', async () => {
    const bin = fakeChronos(join(home, 'checkout', 'apps', 'chronos'))
    expect((await discover(env(), deps({ bundledChronos: bin }))).state).toBe('not_installed')
    mkdirSync(join(home, '.config', 'chronos'), { recursive: true })
    writeFileSync(join(home, '.config', 'chronos', 'config.json'), '{}')
    expect((await discover(env(), deps({ bundledChronos: bin }))).state).toBe('ready')
  })

  test('none anywhere: not installed, as before', async () => {
    expect((await discover(env(), deps())).state).toBe('not_installed')
  })
})

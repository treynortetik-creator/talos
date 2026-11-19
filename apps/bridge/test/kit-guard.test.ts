// An agent folder with only the bridge in it (apps/bridge/scripts/install.sh wrote .mcp.json, the root ./install.sh never
// ran) has no CLAUDE.md, no hooks, no memory: the agent starts with none of Talos. Dante's setup (Pantheon 2026-11-19):
// `talos-app start` refuses such a folder and `talos-app doctor` fails it, both naming the two ways out. A plain Claude Code
// folder is still a supported choice (SETUP.md step 3, `talos-app adopt`): `start --no-kit` and adopt record it in the bridge
// home, after which start takes it with no flag and doctor only warns; `doctor --no-kit` warns too.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCli } from '../src/cli.ts'
import { hasTalosKit, plainFoldersPath } from '../src/kit-marker.ts'
import { runTalos } from '../src/talos.ts'
import { tempHome } from './helpers.ts'

// written out here, not imported: the words are what the owner reads
const REPO = resolve(import.meta.dir, '..', '..', '..')
const noKit = (dir: string) =>
  `This folder has no Talos kit: run ${REPO}/install.sh --agent-dir <a new folder> for an agent with the full Talos kit, or start with --no-kit to connect ${dir} as a plain Claude Code folder`
const plainWarning = (dir: string) =>
  `no Talos kit in ${dir} (a plain Claude Code folder, by --no-kit or talos-app adopt): replies rely only on the talos-app server's instructions, with no CLAUDE.md, memory or hooks from Talos`

type Row = { level: string; name: string; detail: string }

function io(terminal = true) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      isTerminal: terminal,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}

/** A folder with the bridge's .mcp.json entry and, as asked, a kit: 'v2' stamps .talos-version, 'v1' is a kit 1.x folder. */
function agent(kit: 'none' | 'v2' | 'v1' | 'version-only' | 'claude-md-only'): string {
  const dir = tempHome('talos-agent-')
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: { 'talos-app': { command: 'bun', args: ['run', '--cwd', '/x', '--silent', 'start'], env: {} } },
    }),
  )
  if (kit === 'v2' || kit === 'version-only') writeFileSync(join(dir, '.talos-version'), '2.0.0\n')
  if (kit === 'v2' || kit === 'v1' || kit === 'claude-md-only') writeFileSync(join(dir, 'CLAUDE.md'), '# agent\n')
  if (kit === 'v1') for (const d of ['memory', 'hooks', 'scripts']) mkdirSync(join(dir, d))
  return dir
}

async function start(dir: string, home: string, extra: string[] = []) {
  const c = io()
  let spawned = false
  const code = await runCli(
    ['start', '--agent-dir', dir, ...extra],
    c.io,
    { TALOS_APP_HOME: home },
    {
      which: () => '/opt/bin/claude',
      spawn: async () => {
        spawned = true
        return 0
      },
    },
  )
  return { code, spawned, err: c.err.join('\n') }
}

async function kitRows(dir: string, home: string, extra: string[] = []): Promise<Row[]> {
  const c = io()
  await runCli(
    ['doctor', '--json', '--agent-dir', dir, '--claude-dir', tempHome('talos-claude-'), ...extra],
    c.io,
    { TALOS_APP_HOME: home },
    { processes: () => [] },
  )
  return (JSON.parse(c.out.join('\n')) as { checks: Row[] }).checks.filter((r) => r.name === 'Talos kit')
}

describe('the "kit installed" marker', () => {
  test('a stamped kit (.talos-version and CLAUDE.md) or a kit 1.x folder counts; half of one does not', () => {
    expect(hasTalosKit(agent('v2'))).toBe(true)
    expect(hasTalosKit(agent('v1'))).toBe(true)
    expect(hasTalosKit(agent('none'))).toBe(false)
    expect(hasTalosKit(agent('version-only'))).toBe(false) // a stamp alone
    expect(hasTalosKit(agent('claude-md-only'))).toBe(false) // a hand-made CLAUDE.md is not the kit
    expect(hasTalosKit(join(tempHome('talos-agent-'), 'missing'))).toBe(false)
  })

  test('a CLAUDE.md that is a link to a file counts, as install.sh -f reads it', () => {
    const dir = agent('version-only')
    const target = join(tempHome('talos-elsewhere-'), 'CLAUDE.md')
    writeFileSync(target, '# agent\n')
    symlinkSync(target, join(dir, 'CLAUDE.md'))
    expect(hasTalosKit(dir)).toBe(true)
  })
})

describe('talos-app start without a kit', () => {
  test('refuses, names both ways out, and starts nothing', async () => {
    const dir = agent('none')
    const r = await start(dir, tempHome())
    expect(r.code).toBe(1)
    expect(r.spawned).toBe(false)
    expect(r.err).toContain(noKit(dir))
  })

  test('starts a folder with a stamped kit and one from kit 1.x, and records neither', async () => {
    for (const kit of ['v2', 'v1'] as const) {
      const home = tempHome()
      const r = await start(agent(kit), home, ['--no-kit'])
      expect(r.err, kit).not.toContain('no Talos kit')
      expect(r.spawned, kit).toBe(true)
      expect(() => readFileSync(plainFoldersPath(home)), kit).toThrow()
    }
  })

  test('--no-kit starts a plain folder and remembers it: the next start needs no flag, doctor warns', async () => {
    const home = tempHome()
    const dir = agent('none')
    const first = await start(dir, home, ['--no-kit'])
    expect(first).toMatchObject({ code: 0, spawned: true })
    const again = await start(dir, home)
    expect(again).toMatchObject({ code: 0, spawned: true })
    expect(await kitRows(dir, home)).toEqual([{ level: 'warn', name: 'Talos kit', detail: plainWarning(dir) }])
    // another plain folder is not covered by the first one's record
    const other = agent('none')
    expect((await start(other, home)).code).toBe(1)
  })

  test('the record is by real path: a link to the folder and the folder are the same folder', async () => {
    const home = tempHome()
    const dir = agent('none')
    const link = join(tempHome('talos-link-'), 'agent-link')
    symlinkSync(dir, link)
    expect((await start(link, home, ['--no-kit'])).code).toBe(0)
    expect((await start(dir, home)).spawned).toBe(true)
    expect((await kitRows(link, home)).map((r) => r.level)).toEqual(['warn'])
  })

  test('a bridge home that does not exist yet is made (0700); one that cannot be written never stops the start', async () => {
    const fresh = join(tempHome(), 'not-yet')
    const dir = agent('none')
    expect((await start(dir, fresh, ['--no-kit'])).code).toBe(0)
    expect(statSync(fresh).mode & 0o777).toBe(0o700)
    expect((await start(dir, fresh)).spawned).toBe(true)
    const blocked = join(tempHome(), 'a-file')
    writeFileSync(blocked, 'not a folder')
    const r = await start(agent('none'), join(blocked, 'home'), ['--no-kit'])
    expect(r).toMatchObject({ code: 0, spawned: true })
    expect(r.err).toContain('could not remember')
  })

  test('--no-kit --dry-run records nothing; --no-kit still needs the .mcp.json entry', async () => {
    const home = tempHome()
    const dir = agent('none')
    expect((await start(dir, home, ['--no-kit', '--dry-run'])).code).toBe(0)
    expect((await start(dir, home)).code).toBe(1)
    const bare = tempHome('talos-agent-')
    const r = await start(bare, home, ['--no-kit'])
    expect(r.code).toBe(1)
    expect(r.spawned).toBe(false)
    expect(r.err).toContain('no talos-app server')
    expect((await start(bare, home)).err).toContain('no Talos kit') // the refused start recorded nothing
  })
})

describe('talos-app doctor without a kit', () => {
  test('a FAIL row that names both ways out', async () => {
    const dir = agent('none')
    expect(await kitRows(dir, tempHome())).toEqual([{ level: 'FAIL', name: 'Talos kit', detail: noKit(dir) }])
  })

  test('an ok row when the kit is there', async () => {
    expect((await kitRows(agent('v2'), tempHome())).map((r) => r.level)).toEqual(['ok'])
    expect((await kitRows(agent('v1'), tempHome())).map((r) => r.level)).toEqual(['ok'])
  })

  test('--no-kit: a warning, not a failure, and doctor records nothing', async () => {
    const home = tempHome()
    const dir = agent('none')
    expect(await kitRows(dir, home, ['--no-kit'])).toEqual([
      { level: 'warn', name: 'Talos kit', detail: plainWarning(dir) },
    ])
    expect((await kitRows(dir, home)).map((r) => r.level)).toEqual(['FAIL'])
    // a folder that has the kit is ok either way
    expect((await kitRows(agent('v2'), home, ['--no-kit'])).map((r) => r.level)).toEqual(['ok'])
  })

  test('talos doctor --json takes --no-kit too', async () => {
    const dir = agent('none')
    const c = io()
    await runTalos(
      ['doctor', '--json', '--no-kit', '--agent-dir', dir, '--claude-dir', tempHome('talos-claude-')],
      c.io,
      { TALOS_APP_HOME: tempHome() },
      { processes: () => [] },
    )
    const kit = (JSON.parse(c.out.join('\n')) as { rows: Row[] }).rows.filter((r) => r.name === 'Talos kit')
    expect(kit.map((r) => r.level)).toEqual(['warn'])
  })
})

describe('talos-app adopt records a plain folder', () => {
  // The Mac app's Adopt button runs this, then starts the agent itself (never through start --no-kit).
  test('an adopted folder with no kit: doctor warns, start needs no flag; a kit folder is not recorded', async () => {
    const home = tempHome()
    const env = {
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: 'https://relay.example.com',
      PATH: process.env.PATH,
      HOME: tempHome('talos-user-'),
    }
    const plain = tempHome('talos-plain-')
    writeFileSync(join(plain, 'CLAUDE.md'), '# my own agent\n')
    expect(await runCli(['adopt', '--agent-dir', plain, '--yes'], io().io, env)).toBe(0)
    expect(await kitRows(plain, home)).toEqual([{ level: 'warn', name: 'Talos kit', detail: plainWarning(plain) }])
    expect((await start(plain, home)).spawned).toBe(true)
    const kit = agent('v2')
    expect(await runCli(['adopt', '--agent-dir', kit, '--yes', '--repoint'], io().io, env)).toBe(0)
    const recorded = JSON.parse(readFileSync(plainFoldersPath(home), 'utf8')) as { folders: string[] }
    expect(recorded.folders).toHaveLength(1)
  })
})

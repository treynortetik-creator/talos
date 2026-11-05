import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { runTalos } from '../src/talos.ts'
import { installFakeClaude, withoutClaude } from './fake-claude.ts'
import { type Harness, startHarness } from './helpers.ts'

type Row = { level: string; name: string; detail: string }

let h: Harness | undefined
let restore: (() => void) | undefined
afterEach(async () => {
  restore?.()
  restore = undefined
  await h?.stop()
  h = undefined
})

const repoMod = (
  JSON.parse(
    readFileSync(join(import.meta.dir, '../../../plugins/talos-app-mod/.claude-plugin/plugin.json'), 'utf8'),
  ) as {
    version: string
  }
).version

function mkIO() {
  const out: string[] = []
  return {
    out,
    io: {
      out: (l: string) => out.push(l),
      err: () => {},
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}

/** Runs `talos doctor --json` and `talos-app doctor` against a fresh home; returns the JSON rows and the text lines. */
async function doctor(
  agent = mkdtempSync(join(tmpdir(), 'ta')),
  opts: { once?: boolean; claudeDir?: string; noClaudeDir?: boolean } = {},
) {
  h = await startHarness({ startBridge: false })
  const env = { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl }
  await runCli(['install-mcp', '--agent-dir', agent], mkIO().io, env)
  const claudeDir = opts.claudeDir ?? mkdtempSync(join(tmpdir(), 'cd'))
  const deps = { processes: () => [] as string[] }
  const args = opts.noClaudeDir ? ['--agent-dir', agent] : ['--agent-dir', agent, '--claude-dir', claudeDir]
  const json = mkIO()
  await runTalos(['doctor', '--json', ...args], json.io, env, deps)
  const text = mkIO()
  if (!opts.once) await runCli(['doctor', ...args], text.io, env, deps)
  const rows = (JSON.parse(json.out.join('\n')) as { rows: Row[] }).rows
  return { rows, text: text.out, agent }
}
const find = (rows: Row[], re: RegExp) => rows.filter((r) => re.test(r.name))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const line = (r: Row) => `${r.level.padEnd(4)}  ${r.name}: ${r.detail}`

describe('doctor: Claude Code mods', () => {
  test('one row per installed mod, in --json and in the text', async () => {
    restore = installFakeClaude({
      json: JSON.stringify([
        { id: 'sample-mod@example-market', version: '1.2.0', scope: 'user', enabled: true },
        { id: 'other-mod@example-market', version: '0.3.1', scope: 'project', enabled: false },
      ]),
    })
    const { rows, text } = await doctor()
    const mods = find(rows, /^mod /)
    expect(mods.map((r) => r.name)).toEqual(['mod sample-mod', 'mod other-mod'])
    expect(mods[0]?.detail).toContain('1.2.0')
    expect(mods[1]?.detail).toContain('disabled')
    for (const r of mods) expect(text).toContain(line(r))
  })

  test('a CLI without --json is read from its text listing', async () => {
    restore = installFakeClaude({
      json: 'unsupported',
      text: 'Installed plugins:\n\n  ❯ sample-mod@example-market\n    Version: 1.2.0\n    Scope: user\n    Status: ✔ enabled\n',
    })
    const { rows } = await doctor()
    expect(find(rows, /^mod /).map((r) => r.name)).toEqual(['mod sample-mod'])
    expect(find(rows, /^mod /)[0]?.detail).toContain('1.2.0')
  })

  test('an installed Talos mod older than the repo one warns, naming both versions', async () => {
    restore = installFakeClaude({
      json: JSON.stringify([{ id: 'talos-app-mod@example-market', version: '0.0.1', scope: 'user', enabled: true }]),
    })
    const { rows } = await doctor()
    const r = find(rows, /^talos mod version$/)[0]
    expect(r?.level).toBe('warn')
    expect(r?.detail).toContain('0.0.1')
    expect(r?.detail).toContain(repoMod)
  })

  test('an up-to-date Talos mod is ok', async () => {
    restore = installFakeClaude({
      json: JSON.stringify([{ id: 'talos-app-mod@example-market', version: repoMod, scope: 'user', enabled: true }]),
    })
    const { rows } = await doctor()
    expect(find(rows, /^talos mod version$/)[0]?.level).toBe('ok')
  })
})

describe('doctor: shipped kit files', () => {
  test('no manifest is an ok row saying so', async () => {
    restore = installFakeClaude()
    const { rows } = await doctor()
    expect(find(rows, /^kit files$/)[0]).toMatchObject({ level: 'ok', name: 'kit files' })
  })

  test('a manifest with one edited file warns, naming it', async () => {
    restore = installFakeClaude()
    const agent = mkdtempSync(join(tmpdir(), 'ta'))
    mkdirSync(join(agent, '.talos'))
    mkdirSync(join(agent, 'kit'))
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    writeFileSync(join(agent, 'kit/a.md'), 'alpha')
    writeFileSync(join(agent, 'kit/b.md'), 'beta edited')
    writeFileSync(
      join(agent, '.talos/manifest.json'),
      JSON.stringify({ files: { 'kit/a.md': sha('alpha'), 'kit/b.md': sha('beta') } }),
    )
    const { rows } = await doctor(agent)
    const r = find(rows, /^kit files$/)[0]
    expect(r?.level).toBe('warn')
    expect(r?.detail).toContain('kit/b.md')
    expect(r?.detail).not.toContain('kit/a.md')
  })
})

describe('doctor: claude doctor', () => {
  test('claude doctor is never run; the row points the owner at it', async () => {
    const record = join(mkdtempSync(join(tmpdir(), 'rc')), 'rec')
    restore = installFakeClaude({ record, doctorOut: 'Warning: Leftover npm global installation at /x' })
    const { rows } = await doctor(undefined, { once: true })
    const r = find(rows, /^claude doctor$/)[0]
    expect(r?.level).toBe('ok')
    expect(r?.detail).toContain('Terminal')
    expect(readFileSync(record, 'utf8')).not.toContain('args=doctor')
  })

  test('a claude plugin list that hangs warns within 7 s, the run finishes, and the whole process group is killed', async () => {
    const record = join(mkdtempSync(join(tmpdir(), 'rc')), 'rec')
    restore = installFakeClaude({ listHang: true, record })
    const t0 = performance.now()
    const { rows } = await doctor(undefined, { once: true })
    const took = performance.now() - t0
    expect(find(rows, /^claude mods$/)[0]?.level).toBe('warn')
    expect(rows.some((x) => x.level === 'FAIL')).toBe(false)
    expect(took).toBeLessThan(7000)
    const pids = readFileSync(record, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('pid='))
      .map((l) => Number(l.slice(4)))
    expect(pids.length).toBeGreaterThan(0)
    await Bun.sleep(300)
    for (const pid of pids) expect(alive(pid), `fake child ${pid} survived the timeout`).toBe(false)
  }, 20_000)

  test('claude missing from PATH warns for the mod list, never fails', async () => {
    restore = withoutClaude()
    const { rows } = await doctor()
    expect(find(rows, /^claude mods$/)[0]?.level).toBe('warn')
    expect(rows.some((x) => x.level === 'FAIL')).toBe(false)
  })
})

describe('doctor: reading claude honestly', () => {
  test('R1-1: listing output that parses to zero mods is a warn, not "none installed"', async () => {
    restore = installFakeClaude({ json: JSON.stringify([{ unexpected: 1 }]), text: 'weird' })
    const { rows } = await doctor(undefined, { once: true })
    const r = find(rows, /^claude mods$/)[0]
    expect(r?.level).toBe('warn')
    expect(r?.detail).toContain("couldn't read claude's plugin list")
  })

  test('R1-1: unreadable text with no --json is a warn too, and a plain "none installed" stays ok', async () => {
    restore = installFakeClaude({ json: 'unsupported', text: 'Some brand new layout\n  foo bar' })
    let { rows } = await doctor(undefined, { once: true })
    expect(find(rows, /^claude mods$/)[0]?.level).toBe('warn')
    await h?.stop()
    restore()
    restore = installFakeClaude({ json: 'unsupported', text: 'No plugins installed.' })
    ;({ rows } = await doctor(undefined, { once: true }))
    expect(find(rows, /^claude mods$/)[0]).toEqual({ level: 'ok', name: 'claude mods', detail: 'none installed' })
  })

  for (const [label, body] of [
    [
      'top-level array keyed by pluginId',
      [{ pluginId: 'sample-mod@m', version: '1.0.0', scope: 'user', enabled: true }],
    ],
    [
      'plugins array keyed by name',
      { plugins: [{ name: 'sample-mod', version: '1.0.0', scope: 'user', enabled: true }] },
    ],
    [
      'pluginsV2 array keyed by id',
      { pluginsV2: [{ id: 'sample-mod@m', version: '1.0.0', scope: 'user', enabled: true }] },
    ],
  ] as const) {
    test(`R1-1: JSON shape ${label} is read`, async () => {
      restore = installFakeClaude({ json: JSON.stringify(body) })
      const { rows } = await doctor(undefined, { once: true })
      expect(find(rows, /^mod /).map((r) => r.name)).toEqual(['mod sample-mod'])
      expect(find(rows, /^claude mods$/)).toEqual([])
    })
  }

  test('R1-3 and R1-11: claude runs in the agent folder with the resolved claude config dir', async () => {
    const record = join(mkdtempSync(join(tmpdir(), 'rc')), 'rec')
    restore = installFakeClaude({ record })
    const agent = mkdtempSync(join(tmpdir(), 'ta'))
    const claudeDir = mkdtempSync(join(tmpdir(), 'cd'))
    await doctor(agent, { once: true, claudeDir })
    const lines = readFileSync(record, 'utf8').split('\n')
    expect(lines.filter((l) => l.startsWith('cwd=')).length).toBeGreaterThan(0)
    for (const l of lines.filter((l) => l.startsWith('cwd='))) expect(l).toBe(`cwd=${realpathSync(agent)}`)
    for (const l of lines.filter((l) => l.startsWith('cfg='))) expect(l).toBe(`cfg=${claudeDir}`)
  })

  test('R2-1: without --claude-dir, CLAUDE_CONFIG_DIR is not set for claude', async () => {
    const record = join(mkdtempSync(join(tmpdir(), 'rc')), 'rec')
    restore = installFakeClaude({ record })
    const before = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      await doctor(mkdtempSync(join(tmpdir(), 'ta')), { once: true, noClaudeDir: true })
    } finally {
      if (before !== undefined) process.env.CLAUDE_CONFIG_DIR = before
    }
    for (const l of readFileSync(record, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('cfg=')))
      expect(l).toBe('cfg=')
  })

  test('R1-6: a mod with an errors field warns, naming it (JSON)', async () => {
    restore = installFakeClaude({
      json: JSON.stringify([
        { id: 'bad-mod@m', version: '1.0.0', scope: 'user', enabled: true, errors: ['hook file missing'] },
        { id: 'good-mod@m', version: '1.0.0', scope: 'user', enabled: true, errors: [] },
      ]),
    })
    const { rows } = await doctor(undefined, { once: true })
    const bad = find(rows, /^mod bad-mod$/)[0]
    expect(bad?.level).toBe('warn')
    expect(bad?.detail).toContain('hook file missing')
    expect(find(rows, /^mod good-mod$/)[0]?.level).toBe('ok')
  })

  test('R1-6: "failed to load" in the text listing warns and is not read as disabled', async () => {
    restore = installFakeClaude({
      json: 'unsupported',
      text: 'Installed plugins:\n\n  ❯ bad-mod@m\n    Version: 1.0.0\n    Scope: user\n    Status: ✘ failed to load\n',
    })
    const { rows } = await doctor(undefined, { once: true })
    const r = find(rows, /^mod bad-mod$/)[0]
    expect(r?.level).toBe('warn')
    expect(r?.detail).toContain('failed to load')
    expect(r?.detail).not.toContain('disabled')
  })

  test('R1-10: an unknown installed Talos mod version says so, not "older than"', async () => {
    restore = installFakeClaude({ json: JSON.stringify([{ id: 'talos-app-mod@m', scope: 'user', enabled: true }]) })
    const r = find((await doctor(undefined, { once: true })).rows, /^talos mod version$/)[0]
    expect(r?.detail).toContain('version unknown')
    expect(r?.detail).not.toContain('older than')
  })

  test('R1-10: a parsed listing without the Talos mod gets a "Talos mod not installed" row', async () => {
    restore = installFakeClaude({ json: JSON.stringify([{ id: 'sample-mod@m', version: '1.0.0', scope: 'user' }]) })
    const { rows } = await doctor(undefined, { once: true })
    expect(rows.some((r) => r.detail.includes('Talos mod not installed'))).toBe(true)
  })

  test('R1-10: an unreadable listing does not claim the Talos mod is missing', async () => {
    restore = installFakeClaude({ json: 'unsupported', text: 'Some brand new layout\n  foo bar' })
    const { rows } = await doctor(undefined, { once: true })
    expect(rows.some((r) => r.detail.includes('Talos mod not installed'))).toBe(false)
  })
})

describe('doctor: kit manifest safety', () => {
  const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
  function kit(files: Record<string, string>, setup: (agent: string, outside: string) => void) {
    const agent = mkdtempSync(join(tmpdir(), 'ta'))
    const outside = mkdtempSync(join(tmpdir(), 'out'))
    mkdirSync(join(agent, '.talos'))
    setup(agent, outside)
    writeFileSync(join(agent, '.talos/manifest.json'), JSON.stringify({ files }))
    return agent
  }

  test('R1-7: counts checked, unchanged, changed and skipped honestly', async () => {
    restore = installFakeClaude()
    const agent = kit(
      { 'a.md': sha('a'), 'b.md': sha('b'), '../escape': sha('x'), '/etc/hosts': sha('x'), 'gone.md': sha('g') },
      (ag) => {
        writeFileSync(join(ag, 'a.md'), 'a')
        writeFileSync(join(ag, 'b.md'), 'b edited')
      },
    )
    const r = find((await doctor(agent, { once: true })).rows, /^kit files$/)[0]
    expect(r?.level).toBe('warn')
    expect(r?.detail).toContain('3 checked')
    expect(r?.detail).toContain('1 unchanged')
    expect(r?.detail).toContain('2 changed')
    expect(r?.detail).toContain('2 skipped')
    expect(r?.detail).toContain('b.md')
    expect(r?.detail).toContain('gone.md (missing)')
  })

  test('R1-4: ../ and absolute paths are skipped and reported, never read', async () => {
    restore = installFakeClaude()
    const agent = kit({ '../x': sha('x'), '/etc/hosts': sha('x') }, () => {})
    const r = find((await doctor(agent, { once: true })).rows, /^kit files$/)[0]
    expect(r?.detail).toContain('2 skipped')
    expect(r?.detail).toContain('0 checked')
  })

  test('R1-4: a symlink to a file outside the agent folder is skipped, not hashed', async () => {
    restore = installFakeClaude()
    const agent = kit({ 'link.md': sha('secret') }, (ag, out) => {
      writeFileSync(join(out, 'secret'), 'secret')
      symlinkSync(join(out, 'secret'), join(ag, 'link.md'))
    })
    const r = find((await doctor(agent, { once: true })).rows, /^kit files$/)[0]
    expect(r?.detail).toContain('1 skipped')
    expect(r?.detail).toContain('0 unchanged')
    expect(r?.level).toBe('warn')
  })

  test('R1-4: a directory entry is skipped', async () => {
    restore = installFakeClaude()
    const agent = kit({ sub: sha('x') }, (ag) => mkdirSync(join(ag, 'sub')))
    const r = find((await doctor(agent, { once: true })).rows, /^kit files$/)[0]
    expect(r?.detail).toContain('1 skipped')
  })

  test('R1-4: a FIFO is skipped and the doctor does not block on it', async () => {
    restore = installFakeClaude()
    const agent = kit({ 'pipe.md': sha('x') }, (ag) => {
      expect(Bun.spawnSync(['mkfifo', join(ag, 'pipe.md')]).exitCode).toBe(0)
    })
    const t0 = performance.now()
    const r = find((await doctor(agent, { once: true })).rows, /^kit files$/)[0]
    expect(performance.now() - t0).toBeLessThan(6000)
    expect(r?.detail).toContain('1 skipped')
  }, 15_000)

  test('R1-4: a file over 5 MB is skipped and reported', async () => {
    restore = installFakeClaude()
    const agent = kit({ 'big.bin': sha('x') }, (ag) =>
      writeFileSync(join(ag, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1)),
    )
    const r = find((await doctor(agent, { once: true })).rows, /^kit files$/)[0]
    expect(r?.detail).toContain('1 skipped')
    expect(r?.detail).toContain('big.bin')
  })

  test('R1-4: a symlink even inside the agent folder is skipped (only regular files count)', async () => {
    restore = installFakeClaude()
    const agent = kit({ 'in.md': sha('real') }, (ag) => {
      writeFileSync(join(ag, 'real.md'), 'real')
      symlinkSync(join(ag, 'real.md'), join(ag, 'in.md'))
    })
    // lstat says symlink, which the rule refuses even when the target is inside: only regular files count.
    const r = find((await doctor(agent, { once: true })).rows, /^kit files$/)[0]
    expect(r?.detail).toContain('1 skipped')
  })

  test('R1-8: the no-manifest wording says it is expected until the kit writes one', async () => {
    restore = installFakeClaude()
    const { rows } = await doctor(undefined, { once: true })
    const r = find(rows, /^kit files$/)[0]
    expect(r?.level).toBe('ok')
    expect(r?.detail).toContain('no kit manifest yet')
    expect(r?.detail).toContain('expected')
  })
})

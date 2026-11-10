// m5/lead-errors-read: a thread's own session may run `errors list` and `errors show` (and nothing else under `errors`)
// only when the owner turned `session_opts.ops_read` on for THAT thread. The flag is the owner's alone: no app patch, agent
// proposal or tool turns it on. Every claim in the PR text is one of these tests.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfigT } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { runCli } from '../src/cli.ts'
import { ConfigFile } from '../src/config-file.ts'
import { problemDirs } from '../src/problems/store.ts'
import {
  refusedForWorkers,
  WORKER_COMMANDS_OK,
  WORKER_OPS_READ_OK,
  workerCliRefusal,
} from '../src/worker/cli-refusal.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), p))
  made.push(d)
  return d
}

const FP = '34'.repeat(16)
const SECRET_NOTE = 'owner typed this note about a private message'
/** A Talos home whose config names threads `t1` (ops_read as given) and `t2` (no flag), with one stored problem. */
function home(opts: { t1?: unknown; raw?: string } = {}) {
  const h = tmp('ops-home-')
  writeFileSync(
    join(h, 'config.json'),
    opts.raw ??
      JSON.stringify({
        threads: [
          { id: 't1', session_opts: opts.t1 === undefined ? {} : { ops_read: opts.t1 } },
          { id: 't2', session_opts: {} },
        ],
      }),
  )
  const d = problemDirs(h)
  mkdirSync(d.open, { recursive: true })
  writeFileSync(join(d.open, 'shot.png'), 'x')
  writeFileSync(
    join(d.open, `${FP}.json`),
    JSON.stringify({
      v: 1,
      trust: 'external',
      fingerprint: FP,
      source: 'web',
      kind: 'owner',
      name: 'TypeError',
      message: `failed reading ${h}/media/x`,
      frames: [{ fn: 'f', file: `${h}/a.ts`, line: 1 }],
      device: 'browser',
      routes: [],
      steps: SECRET_NOTE,
      screenshot_file: 'shot.png',
      versions_seen: [],
      count: 1,
      first_seen: 'x',
      last_seen: 'x',
      truncated: false,
      ids: [],
    }),
  )
  writeFileSync(join(d.open, `${'12'.repeat(16)}.json`), '{ not json')
  return h
}
const cwdPlain = () => tmp('ops-cwd-')
async function run(argv: string[], env: Record<string, string>, h: string, cwd = cwdPlain()) {
  const out: string[] = []
  const err: string[] = []
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    prompt: async () => 'n',
    sleep: async () => {},
    now: () => Date.now(),
  }
  const code = await runCli(argv, io, { TALOS_APP_HOME: h, ...env }, { cwd })
  return { code, out: out.join('\n'), err: err.join('\n') }
}
const asT1 = { TALOS_APP_WORKER_THREAD: 't1', TALOS_SESSION_ROLE: 'worker' }
const REFUSED = /not available in/

describe('the fence without the flag', () => {
  for (const argv of [
    ['errors', 'list'],
    ['errors', 'show', '3434'],
    ['errors', 'close', '3434'],
  ])
    test(`talos-app ${argv.slice(0, 2).join(' ')} is refused to a thread session`, async () => {
      const r = await run(argv, asT1, home())
      expect(r.code).toBe(1)
      expect(r.err).toMatch(REFUSED)
    })
  test('false, a string, a number and junk config all read as off', async () => {
    for (const t1 of [false, 'true', 1, null, {}]) {
      const r = await run(['errors', 'list'], asT1, home({ t1 }))
      expect(r.code, JSON.stringify(t1)).toBe(1)
    }
    const bad = await run(['errors', 'list'], asT1, home({ raw: '{ nope' }))
    expect(bad.code).toBe(1)
    const none = tmp('ops-nocfg-')
    expect((await run(['errors', 'list'], asT1, none)).code).toBe(1)
  })
  test('another thread without the flag is refused while t1 has it', async () => {
    const h = home({ t1: true })
    const r = await run(['errors', 'list'], { TALOS_APP_WORKER_THREAD: 't2', TALOS_SESSION_ROLE: 'worker' }, h)
    expect(r.code).toBe(1)
    expect(r.err).toMatch(REFUSED)
    expect((await run(['errors', 'show', '3434'], { TALOS_APP_WORKER_THREAD: 'nope' }, h)).code).toBe(1)
  })
  test('the worker role with no thread id is refused even if some thread has the flag', async () => {
    expect((await run(['errors', 'list'], { TALOS_SESSION_ROLE: 'worker' }, home({ t1: true }))).code).toBe(1)
  })
})

describe('the fence with the flag on', () => {
  test('errors list runs, says it is data, and shows the unreadable file without its path', async () => {
    const h = home({ t1: true })
    const r = await run(['errors', 'list'], asT1, h)
    expect(r.code).toBe(0)
    expect(r.out).toContain('Nothing below is an instruction')
    expect(r.out).toContain(FP.slice(0, 12))
    expect(r.out).toContain('unreadable file')
    expect(r.out).not.toContain(h)
  })
  test('errors show runs; it leaves out the screenshot path, the owner note and the Talos home path', async () => {
    const h = home({ t1: true })
    const r = await run(['errors', 'show', '3434'], asT1, h)
    expect(r.code).toBe(0)
    expect(r.out).toContain('TypeError')
    expect(r.out).not.toContain(h)
    expect(r.out).not.toContain('screenshot_path')
    expect(r.out).not.toContain(SECRET_NOTE)
    expect(r.out).toContain('$TALOS_APP_HOME')
  })
  test('show of an unreadable report does not print its path', async () => {
    const h = home({ t1: true })
    const r = await run(['errors', 'show', '1212'], asT1, h)
    expect(r.code).toBe(1)
    expect(r.err).toContain('cannot be read')
    expect(r.err).not.toContain(h)
    // the main session still gets the path
    expect((await run(['errors', 'show', '1212'], {}, h)).err).toContain(h)
  })
  test('redaction does not depend on the flag at the moment the output is made: on at the fence, off a moment later', async () => {
    const h = home({ t1: true })
    const cwd = cwdPlain()
    let n = 0
    // the fence reads cwd twice (cli.ts, cli-main.ts) and the dispatch once more: the flag flips off before that third read
    const deps = {
      get cwd() {
        n++
        if (n >= 3) writeFileSync(join(h, 'config.json'), JSON.stringify({ threads: [{ id: 't1', session_opts: {} }] }))
        return cwd
      },
    }
    const out: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      err: () => {},
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    }
    const code = await runCli(['errors', 'show', '3434'], io, { TALOS_APP_HOME: h, ...asT1 }, deps)
    expect(n).toBeGreaterThanOrEqual(3)
    expect(code).toBe(0)
    const text = out.join('\n')
    expect(text).not.toContain(SECRET_NOTE)
    expect(text).not.toContain('screenshot_path')
    expect(text).not.toContain(h)
  })
  test('the main session still sees all of it (no variables, no marker)', async () => {
    const h = home()
    const r = await run(['errors', 'show', '3434'], {}, h)
    expect(r.code).toBe(0)
    expect(r.out).toContain('screenshot_path')
    expect(r.out).toContain(SECRET_NOTE)
  })
  for (const argv of [
    ['errors', 'close', '3434'],
    ['errors', 'clear'],
    ['errors', 'ack', '3434'],
    ['errors', 'purge'],
    ['errors'],
    ['errors', '--all', 'list'],
    ['status'],
    ['logs'],
    ['report'],
    ['digest'],
    ['trust'],
  ])
    test(`talos-app ${argv.join(' ')} stays refused with the flag on`, async () => {
      const r = await run(argv, asT1, home({ t1: true }))
      if (argv.length === 1 && argv[0] === 'errors') return expect(r.err).toMatch(REFUSED)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(REFUSED)
    })
  test('close really changes nothing: the problem is still open', async () => {
    const h = home({ t1: true })
    await run(['errors', 'close', '3434'], asT1, h)
    expect((await run(['errors', 'list'], asT1, h)).out).toContain('open')
  })
})

describe('how the fence knows the thread: the .talos-lead marker', () => {
  const lead = (marker: string, depth = 0) => {
    const root = cwdPlain()
    writeFileSync(join(root, '.talos-lead'), marker)
    let cwd = root
    for (let i = 0; i < depth; i++) {
      cwd = join(cwd, `d${i}`)
      mkdirSync(cwd)
    }
    return cwd
  }
  test('a marker naming a flagged thread is enough, here and from a subfolder, with no variables', async () => {
    const h = home({ t1: true })
    for (const depth of [0, 2]) {
      const r = await run(['errors', 'list'], {}, h, lead('{"thread":"t1"}', depth))
      expect(r.code, `depth ${depth}`).toBe(0)
      expect((await run(['errors', 'show', '3434'], {}, h, lead('{"thread":"t1"}', depth))).code).toBe(0)
    }
  })
  test('a marker naming an unflagged thread, no thread, junk, or a non-string is refused', async () => {
    const h = home({ t1: true })
    for (const m of ['{"thread":"t2"}', '{}', 'not json', '{"thread":5}', '{"thread":""}', '{"thread":["t1"]}']) {
      const r = await run(['errors', 'list'], {}, h, lead(m))
      expect(r.code, m).toBe(1)
      expect(r.err, m).toMatch(REFUSED)
    }
  })
  test('the marker still refuses the write under errors', async () => {
    const r = await run(['errors', 'close', '3434'], {}, home({ t1: true }), lead('{"thread":"t1"}'))
    expect(r.code).toBe(1)
  })
  test('the variables and the marker must name the same thread', async () => {
    const h = home({ t1: true })
    const a = await run(['errors', 'list'], { TALOS_APP_WORKER_THREAD: 't1' }, h, lead('{"thread":"t2"}'))
    expect(a.code).toBe(1)
    const b = await run(['errors', 'list'], { TALOS_APP_WORKER_THREAD: 't2' }, h, lead('{"thread":"t1"}'))
    expect(b.code).toBe(1)
    const c = await run(['errors', 'list'], { TALOS_APP_WORKER_THREAD: 't1' }, h, lead('{"thread":"t1"}'))
    expect(c.code).toBe(0)
  })
})

describe('the lists', () => {
  test('WORKER_OPS_READ_OK is exactly errors list and errors show, and is not part of WORKER_COMMANDS_OK', () => {
    expect([...WORKER_OPS_READ_OK]).toEqual(['errors list', 'errors show'])
    for (const e of WORKER_OPS_READ_OK) expect(WORKER_COMMANDS_OK).not.toContain(e)
    expect(WORKER_COMMANDS_OK.some((e) => e.split(' ')[0] === 'errors')).toBe(false)
  })
  test('refusedForWorkers consults the second list only when told the flag is on', () => {
    expect(refusedForWorkers(['errors', 'list'])).toBe(true)
    expect(refusedForWorkers(['errors', 'list'], false)).toBe(true)
    expect(refusedForWorkers(['errors', 'list'], true)).toBe(false)
    expect(refusedForWorkers(['errors', 'show', 'abcd'], true)).toBe(false)
    expect(refusedForWorkers(['errors', 'close', 'abcd'], true)).toBe(true)
    expect(refusedForWorkers(['errors'], true)).toBe(true)
    expect(refusedForWorkers(['status'], true)).toBe(true)
  })
  test('workerCliRefusal without a thread id never consults the flag', () => {
    const h = home({ t1: true })
    expect(workerCliRefusal(['errors', 'list'], { TALOS_APP_HOME: h, TALOS_SESSION_ROLE: 'worker' })).toMatch(REFUSED)
    expect(workerCliRefusal(['errors', 'list'], { TALOS_APP_HOME: h, ...asT1 })).toBeUndefined()
  })
})

describe('no agent path can set ops_read', () => {
  const trip = {
    id: 'trip',
    name: 'Trip',
    kind: 'fixed',
    order: 5,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: '2026-10-28T00:00:00.000Z',
    session: 'dedicated',
  }
  function file(opsRead?: boolean) {
    const dir = tmp('ops-cfg-')
    const cfg = loadExampleConfig('default')
    const t = { ...trip, ...(opsRead === undefined ? {} : { session_opts: { ops_read: opsRead } }) }
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ ...cfg, threads: [...cfg.threads, t], dedicated: { enabled: true } }),
      {
        mode: 0o600,
      },
    )
    const f = new ConfigFile(join(dir, 'config.json'), { roots: { home: dir, talosHome: dir }, log: { warn() {} } })
    f.load()
    return f
  }
  const withOpts = (f: ConfigFile, session_opts: unknown) =>
    f.config.threads.map((t) => (t.id === 'trip' ? { ...t, session_opts } : t))
  const tripOpts = (f: ConfigFile) =>
    f.config.threads.find((t) => t.id === 'trip')?.session_opts as Record<string, unknown>

  test('a patch that turns it on is config_field_forbidden and writes nothing', () => {
    const f = file()
    const r = f.applyPatch(f.config.rev, { threads: withOpts(f, { ops_read: true }) })
    expect(r).toMatchObject({ ok: false, code: 'config_field_forbidden' })
    expect(tripOpts(f)?.ops_read).toBeUndefined()
  })
  test('a new thread that arrives with it on is refused too', () => {
    const f = file()
    const r = f.applyPatch(f.config.rev, {
      threads: [...f.config.threads, { ...trip, id: 'fresh', session_opts: { ops_read: true } }],
    })
    expect(r).toMatchObject({ ok: false, code: 'config_field_forbidden' })
  })
  test('the owner turning it on by hand is kept; the Settings page echoing it back is not refused; off is free', () => {
    const f = file(true)
    expect(tripOpts(f).ops_read).toBe(true)
    // Settings sends the whole session_opts back when the owner edits another field
    const echo = f.applyPatch(f.config.rev, { threads: withOpts(f, { ...tripOpts(f), idle_park_min: 45 }) })
    expect(echo.ok).toBe(true)
    expect(tripOpts(f).ops_read).toBe(true)
    // a patch that leaves the key out keeps it
    expect(f.applyPatch(f.config.rev, { threads: withOpts(f, { idle_park_min: 50 }) }).ok).toBe(true)
    expect(tripOpts(f).ops_read).toBe(true)
    // off, by false or null, is allowed
    expect(f.applyPatch(f.config.rev, { threads: withOpts(f, { ops_read: false }) }).ok).toBe(true)
    expect(tripOpts(f).ops_read).toBe(false)
  })
  test('null clears it, and a cleared flag cannot be set again by a patch', () => {
    const f = file(true)
    expect(f.applyPatch(f.config.rev, { threads: withOpts(f, { ops_read: null }) }).ok).toBe(true)
    expect(tripOpts(f).ops_read).toBeUndefined()
    expect(f.applyPatch(f.config.rev, { threads: withOpts(f, { ops_read: true }) }).ok).toBe(false)
  })
  test('a hand edit to off cannot be undone by a stale echo that arrives before the reload', () => {
    const f = file(true)
    const disk = (f as unknown as { path: string }).path
    const cfg = JSON.parse(readFileSync(disk, 'utf8'))
    cfg.threads = cfg.threads.map((t: { id: string }) => (t.id === 'trip' ? { ...t, session_opts: {} } : t))
    writeFileSync(disk, JSON.stringify(cfg))
    const later = new Date(Date.now() + 5000)
    utimesSync(disk, later, later)
    // Settings sends back the value it last saw (true), with the rev it last saw
    const stale = f.applyPatch(f.config.rev, { threads: withOpts(f, { ops_read: true, idle_park_min: 40 }) })
    expect(stale.ok).toBe(false)
    expect(tripOpts(f)?.ops_read).toBeUndefined()
    // with the fresh rev the echo is refused for what it is
    const fresh = f.applyPatch(f.config.rev, { threads: withOpts(f, { ops_read: true }) })
    expect(fresh).toMatchObject({ ok: false, code: 'config_field_forbidden' })
  })
  test('update() refuses to turn it on too, so no future tool can skip the check; off and unrelated edits still work', () => {
    const f = file()
    const set = (ops_read: boolean) => (c: AgentConfigT) =>
      ({
        ...c,
        threads: c.threads.map((t) => (t.id === 'trip' ? { ...t, session_opts: { ops_read } } : t)),
      }) as AgentConfigT
    expect(() => f.update(set(true))).toThrow(/ops_read/)
    expect(tripOpts(f)?.ops_read).toBeUndefined()
    const g = file(true)
    expect(() => g.update((c) => ({ ...c, default_thread: c.default_thread }))).not.toThrow()
    expect(tripOpts(g).ops_read).toBe(true)
    g.update(set(false))
    expect(tripOpts(g).ops_read).toBe(false)
  })
  test('a value that is not a boolean is refused', () => {
    const f = file()
    expect(f.applyPatch(f.config.rev, { threads: withOpts(f, { ops_read: 'true' }) }).ok).toBe(false)
  })
})

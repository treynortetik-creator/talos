// Thread setup P2 (the bridge): agents set up thread agents. Roots and the folder on disk, the thread session's own reach, the
// gate for the new fields, the change lines, and the instructions (AGENTS.md) an agent writes. The protocol rules are
// packages/protocol/test/thread-setup.test.ts; these run them through the real bridge with real folders under a throw-away HOME.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CardT, CONFIG_PROPOSE_FEATURE, newId, threadSessionMode } from '@talos-app/protocol'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import { HandoffLedger } from '../src/worker/handoff.ts'
import { eventually, type Harness, startHarness, waitFor } from './helpers.ts'

const MIN = 60_000
const RELAY = { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] }
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''

let h: Harness | undefined
let top = ''
let home = ''
let agent = ''
const savedAgentDir = process.env.TALOS_AGENT_DIR
const workers: Bridge[] = []

beforeEach(() => {
  // /tmp, not TMPDIR: a folder inside a hidden folder is refused by design. HOME is the owner's home the folder rules read.
  top = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'talos-setup-p2-')))
  home = join(top, 'home')
  agent = join(home, 'agent')
  for (const d of [
    agent,
    join(home, 'site', 'a'),
    join(home, 'site', 'b'),
    join(home, 'site2'),
    join(home, 'other'),
    join(home, 'farm'),
    join(home, 'farm2'),
    join(home, 'barn'),
    join(home, '.claude'),
  ])
    mkdirSync(d, { recursive: true })
  process.env.TALOS_AGENT_DIR = agent
})
afterEach(async () => {
  if (savedAgentDir === undefined) delete process.env.TALOS_AGENT_DIR
  else process.env.TALOS_AGENT_DIR = savedAgentDir
  for (const w of workers.splice(0)) await w.stop()
  await h?.stop()
  h = undefined
  rmSync(top, { recursive: true, force: true })
})

const thread = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'agent',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})
const dedicated = (cwd: string, extra: Record<string, unknown> = {}) => ({
  session: 'dedicated',
  session_opts: { cwd },
  ...extra,
})

function macSays(dir: string) {
  writeFileSync(
    join(dir, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: {
        pid: 1,
        heartbeat_at: new Date(Date.now() + 30 * MIN).toISOString(),
        workers_supported: true,
        subthreads_supported: true,
        subthreads_own_folder: true,
        subthreads_shared_folder: true,
        subthreads_folderless_parent: true,
      },
      threads: {},
    }),
  )
}

async function start(o: { lock?: boolean; extra?: unknown[]; noSwitch?: boolean } = {}) {
  h = await startHarness({
    relay: RELAY,
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      ...(o.lock ? { settings_lock: true } : {}),
      ...(o.noSwitch ? {} : { dedicated: { enabled: true } }),
      threads: [
        ...c.threads,
        thread('daily', 'Daily'),
        thread('work', 'Work', dedicated(join(home, 'site'))),
        thread('kid', 'Kid', dedicated(join(home, 'site', 'a'), { parent_id: 'work' })),
        thread('other', 'Other', dedicated(join(home, 'other'))),
        thread('shared', 'Shared', dedicated(agent)),
        thread('farm', 'Farm', dedicated(join(home, 'farm'))),
        thread('barn', 'Barn', dedicated(join(home, 'barn'), { parent_id: 'farm' })),
        ...(o.extra ?? []),
      ],
    })) as never,
  })
  macSays(h.home)
  // os.homedir() is read once when the process starts, so the owner's home the folder rules read is set on the roots themselves
  const roots = h.bridge.ctx.config.folderRoots
  roots.home = home
  roots.agentDir = agent
  roots.claudeDir = join(home, '.claude')
  return h
}

const cfg = (x: Harness) => x.bridge.ctx.config.config
const th = (x: Harness, id: string) => cfg(x).threads.find((t) => t.id === id)
const cards = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)
const propose = (x: Harness, changes: unknown, scope?: string) =>
  scope
    ? x.bridge.ctx.configProposals?.propose({ thread_id: scope, reason: 'set up', changes }, { scope })
    : x.bridge.callTool('config_propose', { thread_id: 'general', reason: 'set up', changes }).then((r) => ({
        ok: !r.isError,
        text: text(r),
      }))
const said = (x: Harness) =>
  [...new Set(cfg(x).threads.map((t) => t.id))]
    .flatMap((id) => x.bridge.ctx.store.page({ thread_id: id, limit: 50 }).messages.map((m) => m.text ?? ''))
    .join('\n')
const outside = (x: Harness, min = 1) =>
  x.bridge.ctx.store.kvSet('outside_text_at:general', String(Date.now() + min * MIN))
const ownerSpoke = (x: Harness, minutesAgo: number) =>
  x.bridge.ctx.store.kvSet('last_owner_device', JSON.stringify({ device_id: 'd', at: Date.now() - minutesAgo * MIN }))

describe('roots: a valid folder works, the refused ones do not', () => {
  test('a folder under home proposes and applies; the thread then works in it', async () => {
    const x = await start()
    const r = await propose(x, [{ path: 'threads.daily.session_opts.cwd', value: join(home, 'site', 'b') }])
    expect(r?.ok, r?.text).toBe(true)
    expect(r?.text).toContain('Saved')
    expect(th(x, 'daily')?.session_opts?.cwd).toBe(join(home, 'site', 'b'))
  })

  for (const [what, dir] of [
    ['home itself', () => home],
    ['the Talos home', () => (h as Harness).home],
    ['the agent folder', () => agent],
    ['~/.claude', () => join(home, '.claude')],
    ['inside the agent folder', () => join(agent, 'sub')],
  ] as const) {
    test(`${what} is refused at propose`, async () => {
      const x = await start()
      mkdirSync(join(agent, 'sub'), { recursive: true })
      const r = await propose(x, [{ path: 'threads.daily.session_opts.cwd', value: dir() }])
      expect(r?.ok).toBe(false)
      expect(th(x, 'daily')?.session_opts?.cwd).toBeUndefined()
      expect(cards(x).filter((c) => c.kind === 'config')).toHaveLength(0)
    })
  }

  test('a folder fine at propose and swapped for a link into ~/.claude before the owner approves is refused at apply', async () => {
    const x = await start({ lock: true })
    const mine = join(home, 'site', 'b')
    const r = await propose(x, [{ path: 'threads.daily.session_opts.cwd', value: mine }])
    expect(r?.text).toMatch(/card c_\S+ pending/)
    await waitFor(() => cards(x).length > 0, 4000, 'card.create')
    rmSync(mine, { recursive: true })
    symlinkSync(join(home, '.claude'), mine)
    const card = cards(x).find((c) => c.kind === 'config') as CardT
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() =>
      expect(
        x.relay.frames.some(
          (f) =>
            f.raw.type === 'card.update' &&
            f.raw.card_id === card.id &&
            (f.raw as { state?: string }).state === 'failed',
        ),
      ).toBe(true),
    )
    expect(th(x, 'daily')?.session_opts?.cwd).toBeUndefined()
  })

  test('the agent folder named only at apply (the env changed between) stays refused', async () => {
    const x = await start({ lock: true })
    const mine = join(home, 'site', 'b')
    await propose(x, [{ path: 'threads.daily.session_opts.cwd', value: mine }])
    await waitFor(() => cards(x).length > 0, 4000, 'card.create')
    // the same folder is now the agent folder: a config changed between propose and apply
    const roots = x.bridge.ctx.config.folderRoots as { agentDir?: string }
    roots.agentDir = mine
    const card = cards(x).find((c) => c.kind === 'config') as CardT
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() =>
      expect(x.relay.frames.some((f) => f.raw.type === 'card.update' && f.raw.card_id === card.id)).toBe(true),
    )
    expect(th(x, 'daily')?.session_opts?.cwd).toBeUndefined()
  })
})

describe('the folder on disk', () => {
  test('a missing folder and a file are refused, and nothing is created', async () => {
    const x = await start()
    const missing = join(home, 'site', 'nope')
    const file = join(home, 'site', 'f.txt')
    writeFileSync(file, 'x')
    for (const p of [missing, file]) {
      const r = await propose(x, [{ path: 'threads.daily.session_opts.cwd', value: p }])
      expect(r?.ok, p).toBe(false)
    }
    expect(() => readFileSync(join(missing, 'x'))).toThrow()
    expect(th(x, 'daily')?.session_opts?.cwd).toBeUndefined()
  })

  test("a thread session's child through a link that leaves the parent's folder is refused; a plain one inside is made", async () => {
    const x = await start()
    symlinkSync(join(home, 'other'), join(home, 'site', 'esc'))
    const bad = await propose(
      x,
      [
        {
          path: 'threads.kid2',
          value: {
            name: 'Kid2',
            parent: 'work',
            session: 'dedicated',
            session_opts: { cwd: join(home, 'site', 'esc') },
          },
        },
      ],
      'work',
    )
    expect(bad?.ok).toBe(false)
    expect(th(x, 'kid2')).toBeUndefined()
    const good = await propose(
      x,
      [
        {
          path: 'threads.kid2',
          value: { name: 'Kid2', parent: 'work', session: 'dedicated', session_opts: { cwd: join(home, 'site', 'b') } },
        },
      ],
      'work',
    )
    expect(good?.ok, good?.text).toBe(true)
    expect(th(x, 'kid2')?.parent_id).toBe('work')
  })

  test('a link into a refused root is refused for Main too', async () => {
    const x = await start()
    symlinkSync(join(home, '.claude'), join(home, 'site', 'cl'))
    symlinkSync(agent, join(home, 'site', 'ag'))
    for (const p of ['cl', 'ag']) {
      const r = await propose(x, [{ path: 'threads.daily.session_opts.cwd', value: join(home, 'site', p) }])
      expect(r?.ok, p).toBe(false)
    }
  })

  test('/site2 is not inside /site for a thread session, by whole path segments', async () => {
    const x = await start()
    const r = await propose(
      x,
      [
        {
          path: 'threads.kid2',
          value: { name: 'Kid2', parent: 'work', session: 'dedicated', session_opts: { cwd: join(home, 'site2') } },
        },
      ],
      'work',
    )
    expect(r?.ok).toBe(false)
    expect(th(x, 'kid2')).toBeUndefined()
  })

  test('a dangling link is refused, not followed', async () => {
    const x = await start()
    symlinkSync(join(home, 'gone'), join(home, 'site', 'dang'))
    const r = await propose(x, [{ path: 'threads.daily.session_opts.cwd', value: join(home, 'site', 'dang') }])
    expect(r?.ok).toBe(false)
  })

  test("moving a parent's folder under a child the owner placed elsewhere is refused with the sentence", async () => {
    const x = await start()
    const r = await propose(x, [{ path: 'threads.farm.session_opts.cwd', value: join(home, 'farm2') }])
    expect(r?.ok).toBe(false)
    expect(r?.text).toContain('barn has its own folder outside the new one; the owner must move barn first.')
    expect(th(x, 'farm')?.session_opts?.cwd).toBe(join(home, 'farm'))
  })
})

describe('thread sessions set up their own sub-threads', () => {
  const kidArgs = (extra: Record<string, unknown> = {}) => ({
    name: 'Docs',
    parent_id: 'work',
    session: true,
    folder: join(home, 'site', 'b'),
    model: 'inherit',
    ...extra,
  })

  test('create_thread with parent_id = itself and a folder inside its own: made and configured in ONE proposal', async () => {
    const x = await start()
    const { runCreateThread } = await import('../src/tools/threads.ts')
    const r = await runCreateThread(x.bridge.ctx, kidArgs({ effort: 'low', mcp: [], idle_park_min: 15 }), 'work')
    expect(r.isError, text(r)).toBeFalsy()
    expect(th(x, 'docs')).toMatchObject({
      parent_id: 'work',
      session: 'dedicated',
      session_opts: { cwd: join(home, 'site', 'b'), effort: 'low', mcp_allow: [] },
    })
    expect(threadSessionMode(cfg(x), 'docs')).toBe('dedicated')
    // one proposal: no second card, one thread added
    expect(cards(x).filter((c) => c.kind === 'config')).toHaveLength(0)
  })

  test('without parent_id, or from a sub-thread, it is refused in a plain sentence', async () => {
    const x = await start()
    const { runCreateThread } = await import('../src/tools/threads.ts')
    const none = await runCreateThread(x.bridge.ctx, { name: 'Docs' }, 'work')
    expect(none.isError).toBe(true)
    expect(text(none)).toContain('put "parent":"work" in the new thread')
    const sub = await runCreateThread(x.bridge.ctx, { name: 'Docs', parent_id: 'kid' }, 'kid')
    expect(sub.isError).toBe(true)
    expect(text(sub)).toContain('sub-threads go one level deep')
    const elsewhere = await runCreateThread(x.bridge.ctx, { name: 'Docs', parent_id: 'other' }, 'work')
    expect(elsewhere.isError).toBe(true)
    expect(th(x, 'docs')).toBeUndefined()
  })

  test("it changes its child's model, MCP list and folder; a sibling thread and itself are not its to change that way", async () => {
    const x = await start()
    const models = cfg(x).session_models
    const model = models[0] as string
    const ok = await propose(
      x,
      [
        { path: 'threads.kid.model', value: model },
        { path: 'threads.kid.mcp_allow', value: [] },
        { path: 'threads.kid.session_opts.cwd', value: join(home, 'site', 'b') },
      ],
      'work',
    )
    expect(ok?.ok, ok?.text).toBe(true)
    expect(th(x, 'kid')?.session_opts).toMatchObject({ model, mcp_allow: [], cwd: join(home, 'site', 'b') })
    for (const path of ['threads.other.model', 'threads.work.model', 'threads.work.session_opts.cwd']) {
      const r = await propose(x, [{ path, value: path.endsWith('cwd') ? join(home, 'site', 'a') : model }], 'work')
      expect(r?.ok, path).toBe(false)
    }
  })

  test("archiving: its own sub-thread only (through config_propose; archive_thread is Main's)", async () => {
    const x = await start()
    for (const id of ['other', 'work']) {
      const r = await propose(x, [{ path: `threads.${id}.archived`, value: true }], 'work')
      expect(r?.ok, id).toBe(false)
    }
    // its own sub-thread reaches the proposal: a low change, so a card unless the owner asked (no write here)
    const mine = await propose(x, [{ path: 'threads.kid.archived', value: true }], 'work')
    expect(mine?.ok, mine?.text).toBe(true)
    expect(th(x, 'other')?.archived).toBe(false)
    expect(th(x, 'work')?.archived).toBe(false)
  })

  test('the card of a thread session is for that thread only (the plain refusal stays)', async () => {
    const x = await start()
    const r = await x.bridge.ctx.configProposals?.propose(
      { thread_id: 'other', reason: 'x', changes: [{ path: 'threads.kid.model', value: 'inherit' }] },
      { scope: 'work' },
    )
    expect(r?.ok).toBe(false)
    expect(r?.text).toContain('can only propose into its own thread')
  })

  test('through the hub: a real thread session creates its sub-thread (rpc), and cannot name another parent', async () => {
    const x = await start()
    await waitFor(() => Bun.file(join(x.home, 'run', 'hub.sock')).size >= 0)
    writeFileSync(
      join(x.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: {
          pid: 1,
          heartbeat_at: new Date(Date.now() + 30 * MIN).toISOString(),
          workers_supported: true,
          subthreads_supported: true,
          subthreads_own_folder: true,
          subthreads_shared_folder: true,
          subthreads_folderless_parent: true,
        },
        threads: {
          work: {
            state: 'live',
            session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
            tmux: 't-work',
            pane_pid: pgidOf(process.pid) as number,
            cwd: x.home,
            error: null,
          },
        },
      }),
    )
    mkdirSync(join(x.home, 'workers', 'work'), { recursive: true })
    writeFileSync(join(x.home, 'workers', 'work', 'nonce'), 'test-nonce-0123456789abcdef')
    const w = await Bridge.create({
      env: loadEnv({
        TALOS_APP_HOME: x.home,
        TALOS_APP_RELAY_URL: x.relay.httpUrl,
        TALOS_APP_WORKER_THREAD: 'work',
        TALOS_APP_WORKER_NONCE: 'test-nonce-0123456789abcdef',
      }),
      logger: nullLogger,
    })
    workers.push(w)
    expect(await w.startWorker()).toBe(true)
    const made = await w.callTool('create_thread', kidArgs({ name: 'Via hub', thread_id: 'work' }))
    expect(made.isError, text(made)).toBeFalsy()
    await eventually(() => expect(th(x, 'via_hub')?.parent_id).toBe('work'))
    const other = await w.callTool('create_thread', { name: 'Not mine', parent_id: 'other', thread_id: 'work' })
    expect(other.isError).toBe(true)
    expect(th(x, 'not_mine')).toBeUndefined()
  })
})

describe('the gate for the new fields', () => {
  const setup = [{ path: 'threads.daily.session_opts.cwd', value: '' }]
  const withFolder = () => [{ path: 'threads.daily.session_opts.cwd', value: join(home, 'site', 'b') }]
  void setup

  test('the lock on: a card, even with nothing outside and the owner just spoke', async () => {
    const x = await start({ lock: true })
    ownerSpoke(x, 1)
    const r = await propose(x, withFolder())
    expect(r?.text).toContain('Talos settings are locked')
    expect(r?.text).toMatch(/card c_\S+ pending/)
    expect(th(x, 'daily')?.session_opts?.cwd).toBeUndefined()
  })

  test('the lock off and nothing outside: made at once, although the owner last spoke three hours ago', async () => {
    const x = await start()
    ownerSpoke(x, 180)
    const r = await propose(x, withFolder())
    expect(r?.text).toContain('Saved')
    expect(th(x, 'daily')?.session_opts?.cwd).toBe(join(home, 'site', 'b'))
    // the same three hours leave a LOW change (a rename) a card, as today
    const low = await propose(x, [{ path: 'threads.daily.name', value: 'Daily news' }])
    expect(low?.text).toMatch(/card c_\S+ pending/)
    expect(th(x, 'daily')?.name).toBe('Daily')
  })

  test('outside text in any thread since his words, a lead that spoke, or a peer taint: a card', async () => {
    const cases: Array<[string, (x: Harness) => void]> = [
      [
        'outside text in another thread',
        (x) => x.bridge.ctx.store.kvSet('outside_text_at:daily', String(Date.now() + 1000)),
      ],
      [
        'a lead that spoke',
        (x) =>
          new HandoffLedger(x.bridge.ctx.store.db).record({
            id: newId('m'),
            lead: 'work',
            dir: 'to_main',
            type: 'TASK',
            text: 'a result',
            at: Date.now() - 1000,
          }),
      ],
      [
        'a peer taint',
        (x) =>
          x.bridge.ctx.store.kvSet(
            'peer_taint',
            JSON.stringify({ peers: ['p'], last_msg_id: 'pm_1', chain: 0, at: Date.now() }),
          ),
      ],
    ]
    for (const [what, make] of cases) {
      const x = await start()
      ownerSpoke(x, 5)
      make(x)
      const r = await propose(x, withFolder())
      expect(r?.text, what).toMatch(/card c_\S+ pending/)
      expect(r?.text, what).toContain('Something from outside reached the agent')
      expect(th(x, 'daily')?.session_opts?.cwd, what).toBeUndefined()
      await h?.stop()
      h = undefined
    }
  })

  test('a thread session meets the same check', async () => {
    const x = await start()
    ownerSpoke(x, 5)
    outside(x)
    const r = await propose(x, [{ path: 'threads.kid.model', value: cfg(x).session_models[0] }], 'work')
    expect(r?.text).toMatch(/card c_\S+ pending/)
    expect(th(x, 'kid')?.session_opts?.model).toBe('inherit')
  })

  test("the low fields keep today's rule: asked within two hours is direct, a thread session's own colour too", async () => {
    const x = await start()
    await x.app.sendMessage('general', 'rename it')
    await waitFor(
      () =>
        x.bridge.ctx.store
          .ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 20)
          .some((m) => m.text === 'rename it'),
      4000,
      'owner row',
    )
    const r = await propose(x, [{ path: 'threads.daily.color', value: 'blue' }])
    expect(r?.text, 'low and asked').toContain('applied: the owner asked')
  })
})

describe('the lead starts with a working session on first start', () => {
  test('a create with session: the session is on, the owner is told, and config.sync carried the thread', async () => {
    const x = await start()
    const r = await x.bridge.callTool('create_thread', {
      name: 'Garden',
      session: true,
      folder: join(home, 'site', 'b'),
      reason: 'a garden agent',
    })
    expect(r.isError, text(r)).toBeFalsy()
    expect(threadSessionMode(cfg(x), 'garden')).toBe('dedicated')
    expect(said(x)).toContain('Garden now has its own session (uses your Claude plan).')
    expect(said(x)).toContain(`Garden now works in ${join(home, 'site', 'b')}.`)
    const sync = await x.relay.expectFrame(
      'config.sync',
      (f) =>
        f.config.threads.some((t: { id: string; session?: string }) => t.id === 'garden' && t.session === 'dedicated'),
      { direction: 'from_bridge' },
    )
    expect(sync).toBeTruthy()
  })
})

describe('the first session ever made turns the switch on', () => {
  test('a config that never wrote dedicated.enabled: the create writes it, so the session starts', async () => {
    const x = await start({ noSwitch: true })
    const r = await x.bridge.callTool('create_thread', {
      name: 'Garden',
      session: true,
      folder: join(home, 'site', 'b'),
    })
    expect(r.isError, text(r)).toBeFalsy()
    expect(cfg(x).dedicated?.enabled).toBe(true)
    expect(threadSessionMode(cfg(x), 'garden')).toBe('dedicated')
    await x.relay.expectFrame(
      'config.sync',
      (f) => f.config.dedicated?.enabled === true && f.config.threads.some((t: { id: string }) => t.id === 'garden'),
      { direction: 'from_bridge' },
    )
  })
})

describe('change lines', () => {
  test('a model change names old and new and how to undo; the plan sentence is there for a session; nothing unvalidated', async () => {
    const x = await start()
    const model = cfg(x).session_models[0] as string
    await propose(x, [{ path: 'threads.daily.model', value: model }])
    await propose(x, [{ path: 'threads.daily.session', value: 'dedicated' }])
    const t = said(x)
    expect(t).toContain(`model: inherit → ${model}`)
    expect(t).toContain('To undo:')
    expect(t).toContain('Daily now has its own session (uses your Claude plan).')
  })
})

describe('AGENTS.md written by the agent', () => {
  const setIt = (x: Harness, id: string, body: string, scope?: string) =>
    import('../src/tools/thread-setup.ts').then((m) => m.setInstructionsAs(x.bridge.ctx, { id, text: body }, scope))

  test("main writes into a thread's OWN folder; the old text is kept as agents-md.prev and the line says how to undo", async () => {
    const x = await start()
    const a = await setIt(x, 'other', '# First\n')
    expect(a.isError, text(a)).toBeFalsy()
    expect(readFileSync(join(home, 'other', 'AGENTS.md'), 'utf8')).toBe('# First\n')
    const b = await setIt(x, 'other', '# Second\n')
    expect(b.isError, text(b)).toBeFalsy()
    expect(readFileSync(join(home, 'other', 'AGENTS.md'), 'utf8')).toBe('# Second\n')
    expect(readFileSync(join(x.home, 'threads', 'other', 'agents-md.prev'), 'utf8')).toBe('# First\n')
    expect(text(b)).toContain('agents-md.prev')
    expect(text(b)).toContain('To undo')
  })

  test('refused: the shared agent folder, a link, over 32 KB, and a thread session for itself', async () => {
    const x = await start()
    const shared = await setIt(x, 'shared', 'x')
    expect(shared.isError).toBe(true)
    expect(() => readFileSync(join(agent, 'AGENTS.md'))).toThrow()

    writeFileSync(join(top, 'elsewhere.md'), 'precious')
    symlinkSync(join(top, 'elsewhere.md'), join(home, 'other', 'AGENTS.md'))
    const link = await setIt(x, 'other', 'overwrite')
    expect(link.isError).toBe(true)
    expect(readFileSync(join(top, 'elsewhere.md'), 'utf8')).toBe('precious')
    rmSync(join(home, 'other', 'AGENTS.md'))

    const big = await setIt(x, 'other', 'x'.repeat(32 * 1024 + 1))
    expect(big.isError).toBe(true)
    expect(text(big)).toContain('32 KB')
    const edge = await setIt(x, 'other', 'x'.repeat(32 * 1024))
    expect(edge.isError, text(edge)).toBeFalsy()

    const own = await setIt(x, 'work', 'my own', 'work')
    expect(own.isError).toBe(true)
    expect(text(own)).toContain('its own are the owner')
    const sib = await setIt(x, 'other', 'not mine', 'work')
    expect(sib.isError).toBe(true)
    const kid = await setIt(x, 'kid', '# kid\n', 'work')
    expect(kid.isError, text(kid)).toBeFalsy()
    expect(readFileSync(join(home, 'site', 'a', 'AGENTS.md'), 'utf8')).toBe('# kid\n')
  })

  test('the lock on, or outside text since the owner spoke: nothing is written', async () => {
    const x = await start({ lock: true })
    expect((await setIt(x, 'other', 'x')).isError).toBe(true)
    await h?.stop()
    h = undefined
    const y = await start()
    ownerSpoke(y, 5)
    outside(y)
    const r = await setIt(y, 'other', 'x')
    expect(r.isError).toBe(true)
    expect(() => readFileSync(join(home, 'other', 'AGENTS.md'))).toThrow()
  })

  test("create_thread with instructions writes them into the new thread's own folder once it exists", async () => {
    const x = await start()
    const r = await x.bridge.callTool('create_thread', {
      name: 'Garden',
      session: true,
      folder: join(home, 'site', 'b'),
      instructions: '# Garden\nWater daily.\n',
    })
    expect(r.isError, text(r)).toBeFalsy()
    expect(readFileSync(join(home, 'site', 'b', 'AGENTS.md'), 'utf8')).toBe('# Garden\nWater daily.\n')
  })
})

const ownerRow = (x: Harness, thread: string, minutesAgo: number) =>
  x.bridge.ctx.store.addMessage({
    id: newId('m'),
    thread_id: thread,
    author: 'owner',
    kind: 'text',
    text: 'go ahead',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: new Date(Date.now() - minutesAgo * MIN).toISOString(),
  } as never)

describe('review round 1: B1 a thread session is dated from the owner in ITS thread', () => {
  const args = {
    name: 'Evil',
    parent_id: 'work',
    session: true,
    folder: '',
    mcp: [] as string[],
    instructions: '# x\n',
  }
  test('outside text on work 10 min ago, the owner spoke in another thread 2 min ago: a card, nothing written; once he speaks in work: direct', async () => {
    const x = await start()
    x.bridge.ctx.store.kvSet('outside_text_at:work', String(Date.now() - 10 * MIN))
    ownerRow(x, 'general', 2)
    ownerSpoke(x, 2)
    const { runCreateThread } = await import('../src/tools/threads.ts')
    const folder = join(home, 'site', 'b')
    const r = await runCreateThread(x.bridge.ctx, { ...args, folder }, 'work')
    expect(text(r)).toMatch(/card c_\S+ pending/)
    expect(th(x, 'evil')).toBeUndefined()
    const { setInstructionsAs } = await import('../src/tools/thread-setup.ts')
    const w = await setInstructionsAs(x.bridge.ctx, { id: 'kid', text: '# k\n' }, 'work')
    expect(w.isError).toBe(true)
    expect(() => readFileSync(join(home, 'site', 'a', 'AGENTS.md'))).toThrow()
    ownerRow(x, 'work', 1)
    const ok = await runCreateThread(x.bridge.ctx, { ...args, folder }, 'work')
    expect(ok.isError, text(ok)).toBeFalsy()
    expect(th(x, 'evil')?.session).toBe('dedicated')
  })
})

describe('review round 1: B2 a setup change carries nothing else direct', () => {
  test('owner spoke 3 h ago, quiet: cwd + rename + fence off in one proposal is a card and applies nothing', async () => {
    const x = await start()
    ownerSpoke(x, 180)
    const r = await propose(x, [
      { path: 'threads.daily.session_opts.cwd', value: join(home, 'site', 'b') },
      { path: 'threads.other.name', value: 'Renamed' },
      { path: 'dev.thread_fence', value: false },
    ])
    expect(r?.text).toMatch(/card c_\S+ pending/)
    expect(th(x, 'daily')?.session_opts?.cwd).toBeUndefined()
    expect(th(x, 'other')?.name).toBe('Other')
    expect(cfg(x).dev?.thread_fence).not.toBe(false)
  })
})

describe('review round 1: B3 a thread session writes only inside its own folder', () => {
  test('farm on barn (the owner put it outside ~/farm): refused and untouched; work on kid still works', async () => {
    const x = await start()
    const { setInstructionsAs } = await import('../src/tools/thread-setup.ts')
    const r = await setInstructionsAs(x.bridge.ctx, { id: 'barn', text: '# from farm\n' }, 'farm')
    expect(r.isError).toBe(true)
    expect(() => readFileSync(join(home, 'barn', 'AGENTS.md'))).toThrow()
    const k = await setInstructionsAs(x.bridge.ctx, { id: 'kid', text: '# k\n' }, 'work')
    expect(k.isError, text(k)).toBeFalsy()
    // Main is unchanged
    const m = await setInstructionsAs(x.bridge.ctx, { id: 'barn', text: '# main\n' })
    expect(m.isError, text(m)).toBeFalsy()
  })
})

describe('review round 1: owner-visible words', () => {
  test('a direct setup change says why (lock off, nothing outside), not "the owner asked"; the audit source is agent_quiet', async () => {
    const x = await start()
    const r = await propose(x, [{ path: 'threads.daily.session_opts.cwd', value: join(home, 'site', 'b') }])
    expect(r?.text).toContain('the settings lock is off and nothing outside reached the agent since the owner')
    expect(r?.text).not.toContain('the owner asked')
  })

  test('an approved card posts the same lines as the direct path', async () => {
    const x = await start({ lock: true })
    await propose(x, [
      { path: 'threads.daily.session', value: 'dedicated' },
      { path: 'threads.daily.session_opts.cwd', value: join(home, 'site', 'b') },
    ])
    await waitFor(() => cards(x).length > 0, 4000, 'card.create')
    const card = cards(x).find((c) => c.kind === 'config') as CardT
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() => expect(said(x)).toContain('Daily now has its own session (uses your Claude plan).'))
    expect(said(x)).toContain(`Daily now works in ${join(home, 'site', 'b')}.`)
  })

  test('when Main writes instructions the notice goes to the target thread', async () => {
    const x = await start()
    const { setInstructionsAs } = await import('../src/tools/thread-setup.ts')
    await setInstructionsAs(x.bridge.ctx, { id: 'other', text: '# o\n' })
    const rows = x.bridge.ctx.store.page({ thread_id: 'other', limit: 20 }).messages.map((m) => m.text ?? '')
    expect(rows.join('\n')).toContain('Changed the instructions of Other')
  })
})

describe('review round 2', () => {
  test("a thread session is dated from when the bridge RECEIVED his words in its thread, not the phone's created_at", async () => {
    const x = await start()
    x.bridge.ctx.store.kvSet('outside_text_at:work', String(Date.now() - 10 * MIN))
    // the phone's clock says he spoke a minute ago; the bridge received his last message in work 20 minutes ago
    ownerRow(x, 'work', 1)
    x.bridge.ctx.store.kvSet('last_owner_at:work', String(Date.now() - 20 * MIN))
    const { runCreateThread } = await import('../src/tools/threads.ts')
    const r = await runCreateThread(
      x.bridge.ctx,
      { name: 'Late', parent_id: 'work', session: true, folder: join(home, 'site', 'b') },
      'work',
    )
    expect(text(r)).toMatch(/card c_\S+ pending/)
  })

  test('an owner message received by the bridge records its receive time per thread', async () => {
    const x = await start()
    await x.app.sendMessage('daily', 'hello')
    await waitFor(() => x.bridge.ctx.store.kvGet('last_owner_at:daily') !== undefined, 4000, 'per-thread receive time')
    expect(Math.abs(Number(x.bridge.ctx.store.kvGet('last_owner_at:daily')) - Date.now())).toBeLessThan(60_000)
  })

  test('the card note says the real reason: not asked, or something from outside', async () => {
    const x = await start()
    ownerSpoke(x, 180)
    const mixed = await propose(x, [
      { path: 'threads.daily.session_opts.cwd', value: join(home, 'site', 'b') },
      { path: 'threads.other.name', value: 'Renamed' },
    ])
    expect(mixed?.text).toContain('has not asked for the other changes')
    expect(mixed?.text).not.toContain('Something from outside')
    outside(x)
    const dirty = await propose(x, [{ path: 'threads.daily.model', value: cfg(x).session_models[0] }])
    expect(dirty?.text).toContain('Something from outside reached the agent')
  })
})

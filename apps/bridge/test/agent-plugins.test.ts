// "Add plugin to agent": ONE card; the owner's own signed tap makes the BRIDGE run `claude plugin install <name>@<marketplace> --scope user` against the
// agent's config folder; the card lists the plugin's hook events and, for PermissionRequest or PreToolUse, says it can approve tool calls without
// asking the phone (one tick, a warning, never a refusal); nothing is installed on a Talos distro; the plugin's servers are offered to each thread's MCP
// list. Real bridge and ledger, a fake `claude` and a temp config folder. No real claude.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CardT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { AgentPlugins, approvingPlugins, commandOf, installEnv, type PluginDeps } from '../src/plugins/agent-plugins.ts'
import { PLUGIN_WORDS as W } from '../src/plugins/plugin-words.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(60_000))

let h: Harness | undefined
const dirs: string[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const put = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v))
}
const entry = [{ hooks: [{ type: 'command', command: 'true' }] }]

type Calls = Array<{ argv: string[]; env: Record<string, string> }>
/** Installs run one at a time: a controllable `run` lets a test hold the first install open. */
const gate = () => {
  let release: () => void = () => {}
  const open = new Promise<void>((r) => {
    release = r
  })
  return { open, release }
}
async function start(over: Partial<PluginDeps> = {}, threads: unknown[] = []) {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, ...threads],
    })) as never,
  })
  const claudeDir = mkdtempSync(join(tmpdir(), 'cd'))
  dirs.push(claudeDir)
  addMarketplace(claudeDir, 'market')
  const calls: Calls = []
  const deps: PluginDeps = {
    claudeDir: async () => ({ dir: claudeDir, set: true }),
    rooted: () => false,
    claudeBin: () => '/usr/bin/claude',
    run: async (argv, env) => {
      calls.push({ argv, env })
      // a real install writes these two files: do the same for `install`
      if (argv[1] === 'plugin' && argv[2] === 'install') installed(claudeDir, argv[3] as string)
      return { ok: true, stdout: '', code: 0 }
    },
    ...over,
  }
  const svc = new AgentPlugins(h.bridge.ctx, deps)
  h.bridge.ctx.agentPlugins = svc
  return { x: h, svc, claudeDir, calls }
}

/** What `claude plugin install` leaves: installed_plugins.json and the user-scope enabledPlugins. */
function installed(claudeDir: string, key: string, hooks?: unknown) {
  const name = key.split('@')[0] as string
  const root = join(claudeDir, 'plugins', 'cache', key.split('@')[1] as string, name, '1.0.0')
  put(join(claudeDir, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { [key]: [{ scope: 'user', installPath: root, version: '1.0.0' }] },
  })
  put(join(claudeDir, 'settings.json'), { enabledPlugins: { [key]: true } })
  if (hooks) put(join(root, 'hooks', 'hooks.json'), hooks)
  put(join(root, '.mcp.json'), { mcpServers: { [`${name}-srv`]: { command: 'true' } } })
}

/** A marketplace that has been added (`claude plugin marketplace add`): in known_marketplaces.json, with a marketplace.json of its plugins. */
function addMarketplace(claudeDir: string, market: string, source: unknown = { source: 'github', repo: 'a/b' }) {
  const loc = join(claudeDir, 'plugins', 'marketplaces', market)
  put(join(claudeDir, 'plugins', 'known_marketplaces.json'), { [market]: { source, installLocation: loc } })
  put(join(loc, '.claude-plugin', 'marketplace.json'), { plugins: [] })
}

/** A marketplace that is already on this computer (so its plugins' hooks can be read before the install). */
function marketplace(
  claudeDir: string,
  market: string,
  plugin: string,
  hooks: unknown,
  source: unknown = { source: 'github', repo: 'a/b' },
) {
  const loc = join(claudeDir, 'plugins', 'marketplaces', market)
  put(join(claudeDir, 'plugins', 'known_marketplaces.json'), { [market]: { source, installLocation: loc } })
  put(join(loc, '.claude-plugin', 'marketplace.json'), { plugins: [{ name: plugin, source: `./plugins/${plugin}` }] })
  if (hooks) put(join(loc, 'plugins', plugin, 'hooks', 'hooks.json'), hooks)
}

const cards = (x: Harness): CardT[] =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'card.create')
    .map((f) => (f.frame as { card: CardT }).card)
    .filter((c) => (c.payload as { plugin_add?: unknown })?.plugin_add !== undefined)
const updates = (x: Harness, id: string) =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'card.update' && f.frame.card_id === id)
    .map((f) => f.frame as { state: string; result?: { ok: boolean; text: string } })

describe('the request', () => {
  test('one card in the default thread: the plugin, its marketplace, the hook events it carries and the exact command; nothing is installed yet', async () => {
    const { x, svc, claudeDir, calls } = await start()
    marketplace(claudeDir, 'market', 'notes', { hooks: { SessionStart: entry, Stop: entry } })
    const r = await svc.request('notes', 'market')
    expect(r).toMatchObject({ ok: true, text: W.asked('notes@market') })
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    expect(c.thread_id).toBe(x.bridge.ctx.config.config.default_thread)
    expect(c.title).toBe('Add the notes plugin to your agent?')
    expect(c.body).toContain('Plugin: notes@market')
    expect(c.body).toContain('Hooks: SessionStart, Stop')
    expect(c.body).toContain('Runs: /usr/bin/claude plugin install notes@market --scope user')
    expect(c.warning).toBeUndefined() // no approval hook: no warning
    expect(c.primary_label).toBe('Add plugin')
    expect(calls).toHaveLength(0)
  })

  test('a plugin with a PermissionRequest or PreToolUse hook: the plain warning, one tick (the normal tap), no second box', async () => {
    const { x, svc, claudeDir } = await start()
    marketplace(claudeDir, 'market', 'approver', { hooks: { PreToolUse: entry } })
    await svc.request('approver', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    expect(c.warning).toBe('This plugin can approve tool calls without asking your phone.')
    expect(c.warning).toBe(W.approves)
    expect(c.fields).toEqual([]) // no confirmation box
    expect(c.body).toContain('Hooks: PreToolUse')
  })

  test('a marketplace that has NOT been added: no card, and the words say to run `claude plugin marketplace add <source>` first (the install would exit 1 and add nothing)', async () => {
    const { x, svc, calls } = await start()
    const r = await svc.request('far', 'away')
    expect(r).toEqual({ ok: false, text: W.noMarketplace('away') })
    expect(r.text).toContain('claude plugin marketplace add <source>')
    await sleep(t(150)) // timing-ok: negative window
    expect(cards(x)).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('a marketplace that was added but whose files cannot be read: the card goes, and says the hooks were not checked', async () => {
    const { x, svc } = await start()
    expect(await svc.request('far', 'market')).toMatchObject({ ok: true })
    await eventually(() => expect(cards(x)).toHaveLength(1))
    expect((cards(x)[0] as CardT).body).toContain(W.hooksUnknown)
  })

  test('names that are not plain (a shell word, a path, a flag, an empty one) are refused before anything is made', async () => {
    const { x, svc, calls } = await start()
    for (const [p, m] of [
      ['a;rm', 'market'],
      ['../x', 'market'],
      ['-rf', 'market'],
      ['', 'market'],
      ['notes', 'mar ket'],
      ['x'.repeat(70), 'market'],
    ])
      expect(await svc.request(p as string, m as string)).toEqual({ ok: false, text: W.badName })
    await sleep(t(150)) // timing-ok: negative window
    expect(cards(x)).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('on a Talos distro (the kit is root’s): refused with a plain reason, no card, nothing installed', async () => {
    const { x, svc, calls } = await start({ rooted: () => true })
    expect(await svc.request('notes', 'market')).toEqual({ ok: false, text: W.rooted })
    await sleep(t(150)) // timing-ok: negative window
    expect(cards(x)).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('no Claude Code on this computer: said, no card', async () => {
    const { svc } = await start({ claudeBin: () => undefined })
    expect(await svc.request('notes', 'market')).toEqual({ ok: false, text: W.noClaude })
  })

  test('already installed and on: said, no second card; a card already open for the plugin is not repeated', async () => {
    const { x, svc, claudeDir } = await start()
    installed(claudeDir, 'there@market')
    expect(await svc.request('there', 'market')).toEqual({ ok: false, text: W.already('there@market') })
    expect(await svc.request('fresh', 'market')).toMatchObject({ ok: true })
    expect(await svc.request('fresh', 'market')).toEqual({ ok: false, text: W.pending('fresh@market') })
    await eventually(() => expect(cards(x)).toHaveLength(1))
  })
})

describe('the owner’s tap', () => {
  test('Add plugin: the bridge runs exactly `claude plugin install <key> --scope user` against the agent’s config folder, once, and the card says it was added', async () => {
    const { x, svc, claudeDir, calls } = await start()
    await svc.request('notes', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    await x.app.resolveCard(c, 'primary', c.payload_hash)
    await eventually(() => expect(updates(x, c.id).some((u) => u.state === 'done')).toBe(true))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['/usr/bin/claude', 'plugin', 'install', 'notes@market', '--scope', 'user'])
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(claudeDir)
    const done = updates(x, c.id).find((u) => u.state === 'done')
    expect(done?.result?.text).toContain(W.added('notes@market'))
    expect(done?.result?.text).toContain('1 MCP server')
  })

  test('Cancel (kill) runs nothing', async () => {
    const { x, svc, calls } = await start()
    await svc.request('notes', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    await x.app.resolveCard(c, 'kill', c.payload_hash)
    await sleep(t(300)) // timing-ok: negative window
    expect(calls).toHaveLength(0)
  })

  test('an approval-hook plugin that was installed: the card’s end repeats the plain warning (the owner may have read it a day ago)', async () => {
    const { x, svc, claudeDir } = await start({
      run: async (argv) => {
        if (argv[2] === 'install') installed(claudeDir, argv[3] as string, { hooks: { PermissionRequest: entry } })
        return { ok: true, stdout: '', code: 0 }
      },
    })
    await svc.request('approver', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    await x.app.resolveCard(c, 'primary', c.payload_hash)
    await eventually(() => expect(updates(x, c.id).some((u) => u.state === 'done')).toBe(true))
    expect(updates(x, c.id).find((u) => u.state === 'done')?.result?.text).toContain(W.approves)
  })

  test('the install fails, or ends with the plugin not there: the card says nothing was added, without the command’s own output', async () => {
    const failing = await start({
      run: async () => ({ ok: false, reason: 'exit', code: 1, stderr: 'SECRET-TOKEN-IN-STDERR' }),
    })
    await failing.svc.request('notes', 'market')
    await eventually(() => expect(cards(failing.x)).toHaveLength(1))
    const c = cards(failing.x)[0] as CardT
    await failing.x.app.resolveCard(c, 'primary', c.payload_hash)
    await eventually(() => expect(updates(failing.x, c.id).some((u) => u.state === 'failed')).toBe(true))
    const text = updates(failing.x, c.id).find((u) => u.state === 'failed')?.result?.text ?? ''
    expect(text).toContain('Nothing was added')
    expect(text).not.toContain('SECRET-TOKEN')
  })

  test('the distro check is made again at the tap: a box that became a Talos distro runs nothing', async () => {
    let rooted = false
    const { x, svc, calls } = await start({ rooted: () => rooted })
    await svc.request('notes', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    rooted = true
    const c = cards(x)[0] as CardT
    await x.app.resolveCard(c, 'primary', c.payload_hash)
    await eventually(() => expect(updates(x, c.id).some((u) => u.state === 'failed')).toBe(true))
    expect(calls).toHaveLength(0)
  })
})

describe('the plugin’s servers and the threads’ MCP lists', () => {
  const thread = (id: string, opts?: unknown) => ({
    id,
    name: id,
    kind: 'fixed',
    order: 5,
    notify: 'all',
    archived: false,
    created_at: '2026-10-28T00:00:00.000Z',
    ...(opts ? { session_opts: opts } : {}),
  })

  test('each thread that HAS an MCP list is offered plugin:<name>:<server>, added to its list; a thread with no list is left alone', async () => {
    const { x, svc } = await start({}, [thread('listed', { mcp_allow: ['github'] }), thread('plain')])
    const proposals: Array<Record<string, unknown>> = []
    x.bridge.ctx.configProposals = {
      propose: async (a: Record<string, unknown>) => {
        proposals.push(a)
        return { ok: true, text: 'ok' }
      },
    } as never
    await svc.request('notes', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    await x.app.resolveCard(c, 'primary', c.payload_hash)
    await eventually(() => expect(updates(x, c.id).some((u) => u.state === 'done')).toBe(true))
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      thread_id: 'listed',
      changes: [{ path: 'threads.listed.session_opts.mcp_allow', new: ['github', 'plugin:notes:notes-srv'] }],
    })
    expect(updates(x, c.id).find((u) => u.state === 'done')?.result?.text).toContain('1 thread')
  })
})

describe('the signed plugin.add.request frame', () => {
  const results = (x: Harness) =>
    x.relay.frames
      .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'plugin.add.result')
      .map((f) => f.frame as { control_id: string; ok: boolean; text: string; card_id?: string })

  test('a signed request gets one card and a result naming it; a replay of the same control_id gets the stored result, not a second card', async () => {
    const { x, claudeDir } = await start()
    marketplace(claudeDir, 'market', 'notes', { hooks: { Stop: entry } })
    const f = await x.app.sendPluginAddRequest('notes', 'market')
    await eventually(() => expect(results(x)).toHaveLength(1))
    const r = results(x)[0]
    expect(r).toMatchObject({ control_id: f.control_id, ok: true, text: W.asked('notes@market') })
    expect(cards(x)).toHaveLength(1)
    expect(r?.card_id).toBe((cards(x)[0] as CardT).id)
    await x.app.sendPluginAddRequest('notes', 'market', { control_id: f.control_id })
    await sleep(t(300)) // timing-ok: negative window: no second card
    expect(cards(x)).toHaveLength(1)
  })

  test('names that are not plain never reach the bridge (the frame is refused by its schema), and a refusal is answered in words', async () => {
    const { x } = await start({ rooted: () => true })
    await x.app.sendPluginAddRequest('notes', 'market')
    await eventually(() => expect(results(x)).toHaveLength(1))
    expect(results(x)[0]).toMatchObject({ ok: false, text: W.rooted })
    expect(cards(x)).toHaveLength(0)
  })
})

describe('Main’s folder, not the bridge’s', () => {
  test('the install, its after-check and the card all use the folder the resolver names; CLAUDE_CONFIG_DIR is passed ONLY when Main sets it', async () => {
    const main = mkdtempSync(join(tmpdir(), 'main'))
    dirs.push(main)
    addMarketplace(main, 'market')
    const wrong = mkdtempSync(join(tmpdir(), 'bridge'))
    dirs.push(wrong)
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = wrong // the BRIDGE's own variable: not Main's
    try {
      const { x, svc, calls } = await start({
        claudeDir: async () => ({ dir: main, set: true }),
        run: async (argv, env) => {
          calls0.push({ argv, env })
          installed(main, argv[3] as string) // a real install writes to the folder it was told
          return { ok: true, stdout: '', code: 0 }
        },
      })
      const calls0: Calls = calls
      await svc.request('notes', 'market')
      await eventually(() => expect(cards(x)).toHaveLength(1))
      const c = cards(x)[0] as CardT
      await x.app.resolveCard(c, 'primary', c.payload_hash)
      await eventually(() => expect(updates(x, c.id).some((u) => u.state === 'done')).toBe(true))
      expect(calls0[0]?.env.CLAUDE_CONFIG_DIR).toBe(main)
      expect(calls0[0]?.env.CLAUDE_CONFIG_DIR).not.toBe(wrong)
    } finally {
      if (saved === undefined) process.env.CLAUDE_CONFIG_DIR = undefined as never
      else process.env.CLAUDE_CONFIG_DIR = saved
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    }
  })

  test('Main sets no CLAUDE_CONFIG_DIR: the install is not told one (Claude Code then reads ~/.claude.json)', () => {
    expect(
      installEnv({ PATH: '/bin', HOME: '/h' }, { dir: '/h/.claude', set: false }).CLAUDE_CONFIG_DIR,
    ).toBeUndefined()
    expect(installEnv({ PATH: '/bin', HOME: '/h' }, { dir: '/x/cfg', set: true }).CLAUDE_CONFIG_DIR).toBe('/x/cfg')
  })

  test('the install sees a short allowlist of the environment: its programs, proxies, the ssh agent and the temp folder; no token or key', () => {
    const env = installEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        SSH_AUTH_SOCK: '/s',
        HTTPS_PROXY: 'http://p',
        NO_PROXY: 'x',
        TMPDIR: '/t',
        GITHUB_TOKEN: 'ghp_secret',
        ANTHROPIC_API_KEY: 'sk-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
      },
      { dir: '/h/.claude', set: false },
    )
    expect(Object.keys(env).sort()).toEqual(['HOME', 'HTTPS_PROXY', 'NO_PROXY', 'PATH', 'SSH_AUTH_SOCK', 'TMPDIR'])
    // certificates, git over ssh and the user's config folder are passed too
    const more = installEnv(
      {
        NODE_EXTRA_CA_CERTS: '/c',
        SSL_CERT_FILE: '/f',
        SSL_CERT_DIR: '/d',
        GIT_SSL_CAINFO: '/g',
        GIT_SSH_COMMAND: 'ssh -i k',
        GIT_SSH: '/ssh',
        XDG_CONFIG_HOME: '/x',
        GIT_ASKPASS: '/leak',
        NPM_TOKEN: 'secret',
      },
      { dir: '/h/.claude', set: false },
    )
    expect(Object.keys(more).sort()).toEqual([
      'GIT_SSH',
      'GIT_SSH_COMMAND',
      'GIT_SSL_CAINFO',
      'HOME',
      'NODE_EXTRA_CA_CERTS',
      'PATH',
      'SSL_CERT_DIR',
      'SSL_CERT_FILE',
      'XDG_CONFIG_HOME',
    ])
  })
})

describe('installed but off, and the whole command on the card', () => {
  test('a plugin that is installed and off: the card names ONLY `plugin enable --scope user`, with the claude path, and the tap runs only that', async () => {
    const { x, svc, claudeDir, calls } = await start()
    installed(claudeDir, 'quiet@market')
    put(join(claudeDir, 'settings.json'), { enabledPlugins: { 'quiet@market': false } })
    expect(await svc.request('quiet', 'market')).toMatchObject({ ok: true })
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    expect(c.body).toContain('Runs: /usr/bin/claude plugin enable quiet@market --scope user')
    expect(c.body).not.toContain(' install ')
    await x.app.resolveCard(c, 'primary', c.payload_hash)
    await eventually(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.map((k) => k.argv.slice(1, 3).join(' '))).toEqual(['plugin enable'])
  })

  test('a plugin to install: the full argv with the claude path is on the card, and it is exactly what runs', async () => {
    const { x, svc, calls } = await start()
    await svc.request('notes', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    expect(c.body).toContain(`Runs: ${commandOf('/usr/bin/claude', 'notes@market', 'install').join(' ')}`)
    await x.app.resolveCard(c, 'primary', c.payload_hash)
    await eventually(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.argv).toEqual(commandOf('/usr/bin/claude', 'notes@market', 'install'))
  })
})

describe('one install at a time, and a tapped card still counts as pending', () => {
  test('two cards tapped together: the second install starts only when the first has finished', async () => {
    const g = gate()
    const order: string[] = []
    const { x, svc, claudeDir } = await start({
      run: async (argv) => {
        order.push(`start ${argv[3]}`)
        if (argv[3] === 'one@market') await g.open
        installed(claudeDir, argv[3] as string)
        order.push(`end ${argv[3]}`)
        return { ok: true, stdout: '', code: 0 }
      },
    })
    await svc.request('one', 'market')
    await svc.request('two', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(2))
    const [a, b] = cards(x) as [CardT, CardT]
    await x.app.resolveCard(a, 'primary', a.payload_hash)
    await x.app.resolveCard(b, 'primary', b.payload_hash)
    await eventually(() => expect(order).toContain('start one@market'))
    await sleep(t(300)) // timing-ok: negative window: the second must not have started
    expect(order).toEqual(['start one@market'])
    g.release()
    await eventually(() =>
      expect(order).toEqual(['start one@market', 'end one@market', 'start two@market', 'end two@market']),
    )
  })

  test('while a tapped plugin is still installing, asking for it again is "already asked", not a second card', async () => {
    const g = gate()
    const { x, svc, claudeDir } = await start({
      run: async (argv) => {
        await g.open
        installed(claudeDir, argv[3] as string)
        return { ok: true, stdout: '', code: 0 }
      },
    })
    await svc.request('slow', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    await x.app.resolveCard(c, 'primary', c.payload_hash)
    await sleep(t(300)) // timing-ok: let the tap start the install
    expect(await svc.request('slow', 'market')).toEqual({ ok: false, text: W.pending('slow@market') })
    g.release()
    await eventually(() => expect(updates(x, c.id).some((u) => u.state === 'done')).toBe(true))
    expect(cards(x)).toHaveLength(1)
  })
})

describe('a plugin whose hooks cannot be read may approve', () => {
  test('a card for a plugin with a hooks file that is not JSON carries the warning and says the hooks could not be read', async () => {
    const { x, svc, claudeDir } = await start()
    marketplace(claudeDir, 'market', 'odd', undefined)
    put(join(claudeDir, 'plugins', 'marketplaces', 'market', 'plugins', 'odd', 'hooks', 'hooks.json'), '{ nope')
    await svc.request('odd', 'market')
    await eventually(() => expect(cards(x)).toHaveLength(1))
    const c = cards(x)[0] as CardT
    expect(c.warning).toBe(W.approves)
    expect(c.body).toContain(W.hooksUnreadable)
  })
})

describe('Claude Code is found by the executable bit, not by reading a file', () => {
  test('a folder on PATH with an executable `claude`; a non-executable one is not it', async () => {
    const { defaultPluginDeps } = await import('../src/plugins/agent-plugins.ts')
    const d = mkdtempSync(join(tmpdir(), 'bin'))
    dirs.push(d)
    writeFileSync(join(d, 'claude'), '#!/bin/sh\n', { mode: 0o644 })
    const saved = process.env.PATH
    process.env.PATH = d
    try {
      expect(defaultPluginDeps().claudeBin()).toBeUndefined()
      chmodSync(join(d, 'claude'), 0o755)
      expect(defaultPluginDeps().claudeBin()).toBe(join(d, 'claude'))
    } finally {
      process.env.PATH = saved
    }
  })
})

describe('plugin-add/1 is the bridge’s feature', () => {
  test('listed by a bridge that has the service, not by one without it', async () => {
    const { bridgeFeatures } = await import('../src/handshake.ts')
    expect(bridgeFeatures({ agentPlugins: {} })).toContain('plugin-add/1')
    expect(bridgeFeatures({})).not.toContain('plugin-add/1')
  })
})

describe('a timeout takes the whole process group', () => {
  test('a helper the install started is killed with it', async () => {
    const { runArgv } = await import('../src/exec.ts')
    const pidFile = join(mkdtempSync(join(tmpdir(), 'grp')), 'pid')
    dirs.push(join(pidFile, '..'))
    const r = await runArgv(['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`], 400, undefined, true)
    expect(r).toMatchObject({ ok: false, reason: 'timeout' })
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await sleep(t(200)) // timing-ok: let the kill land
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })
})

describe('what Claude Code did on a real 2.1.332', () => {
  const tapAndWait = async (x: Harness, c: CardT, state = 'done') => {
    await x.app.resolveCard(c, 'primary', c.payload_hash)
    await eventually(() => expect(updates(x, c.id).some((u) => u.state === state)).toBe(true))
    return updates(x, c.id).find((u) => u.state === state)?.result?.text ?? ''
  }
  const ask = async (svc: AgentPlugins, x: Harness, plugin: string) => {
    await svc.request(plugin, 'market')
    await eventually(() =>
      expect(
        cards(x).some((c) => (c.payload as { plugin_add?: { plugin?: string } }).plugin_add?.plugin === plugin),
      ).toBe(true),
    )
    return cards(x).find(
      (c) => (c.payload as { plugin_add?: { plugin?: string } }).plugin_add?.plugin === plugin,
    ) as CardT
  }

  test('the marketplace was removed between the card and the tap: the install exits 1, and the failure names that cause', async () => {
    const { x, svc, claudeDir } = await start({ run: async () => ({ ok: false, reason: 'exit', code: 1 }) })
    const c = await ask(svc, x, 'notes')
    rmSync(join(claudeDir, 'plugins', 'known_marketplaces.json'))
    const text = await tapAndWait(x, c, 'failed')
    expect(text).toContain('claude plugin marketplace add')
  })

  test('`enable` exits 1 when the plugin is ALREADY on: the files after the call say it is, so it is success', async () => {
    const { x, svc, claudeDir } = await start({
      run: async () => {
        // a plugin that is installed and (by now) on, as another tap or the owner left it; the CLI still exits 1
        put(join(claudeDir, 'settings.json'), { enabledPlugins: { 'quiet@market': true } })
        return { ok: false, reason: 'exit', code: 1 }
      },
    })
    installed(claudeDir, 'quiet@market')
    put(join(claudeDir, 'settings.json'), { enabledPlugins: { 'quiet@market': false } })
    const c = await ask(svc, x, 'quiet')
    expect(await tapAndWait(x, c)).toContain(W.added('quiet@market'))
  })

  test('`enable` on a plugin that is NOT installed exits 0 and writes the key: not installed_plugins.json, so it is "nothing was added"', async () => {
    const { x, svc, claudeDir } = await start({
      run: async (argv) => {
        if (argv[2] === 'enable') put(join(claudeDir, 'settings.json'), { enabledPlugins: { 'ghost@market': true } })
        return { ok: true, stdout: '', code: 0 }
      },
    })
    const c = await ask(svc, x, 'ghost') // an install that "succeeds" without installing, then the enable that writes the key
    const text = await tapAndWait(x, c, 'failed')
    expect(text).toContain('Nothing was added')
  })

  describe('a plugin that runs a command when it installs: -y, shown on the card; for nothing else', () => {
    const entryOf = (claudeDir: string, entry: Record<string, unknown>) =>
      put(join(claudeDir, 'plugins', 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'), {
        plugins: [entry],
      })
    const helpRun = (claudeDir: string, calls: Calls) => async (argv: string[], env: Record<string, string>) => {
      calls.push({ argv, env })
      if (argv[2] === 'install') installed(claudeDir, argv[3] as string)
      return { ok: true as const, stdout: '', code: 0 as const }
    }
    const installArgv = (calls: Calls) => calls.find((k) => k.argv[2] === 'install')?.argv

    test('a command-SOURCE entry: the card says what it runs and shows the exact argv with -y; the tap runs that argv; no --help call', async () => {
      const calls: Calls = []
      const { x, svc, claudeDir } = await start()
      entryOf(claudeDir, { name: 'cmd', source: { source: 'command', command: 'make plugin' } })
      ;(svc as unknown as { deps: PluginDeps }).deps.run = helpRun(claudeDir, calls)
      const c = await ask(svc, x, 'cmd')
      expect(c.body).toContain('This plugin runs a command when it installs: make plugin')
      expect(c.body).toContain('/usr/bin/claude plugin install cmd@market --scope user -y')
      await tapAndWait(x, c)
      expect(installArgv(calls)).toEqual([
        '/usr/bin/claude',
        'plugin',
        'install',
        'cmd@market',
        '--scope',
        'user',
        '-y',
      ])
      expect(calls.some((k) => k.argv.includes('--help'))).toBe(false)
    })

    test('a stdio MCP server command is NOT one: no Runs line, no flag, in every form Delphi installed (hooky, dotmcp, dotmcpbare, pjobj, pjpath, pjarr, entrysrv-nostrict)', async () => {
      const srv = { command: 'npx', args: ['-y', 'tool'] }
      const dir = (claudeDir: string, p: string) => join(claudeDir, 'plugins', 'marketplaces', 'market', 'plugins', p)
      for (const p of ['dotmcp', 'dotmcpbare', 'pjobj', 'pjpath', 'pjarr', 'entrysrv-nostrict', 'hooky']) {
        const calls: Calls = []
        const { x, svc, claudeDir } = await start()
        const entries: Record<string, unknown>[] = [{ name: p, source: `./plugins/${p}` }]
        if (p === 'entrysrv-nostrict') entries[0] = { ...entries[0], mcpServers: { s: srv } }
        put(join(claudeDir, 'plugins', 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'), {
          plugins: entries,
        })
        if (p === 'dotmcp') put(join(dir(claudeDir, p), '.mcp.json'), { mcpServers: { s: srv } })
        if (p === 'dotmcpbare') put(join(dir(claudeDir, p), '.mcp.json'), { s: srv })
        if (p === 'pjobj') put(join(dir(claudeDir, p), '.claude-plugin', 'plugin.json'), { mcpServers: { s: srv } })
        if (p === 'pjpath') {
          put(join(dir(claudeDir, p), '.claude-plugin', 'plugin.json'), { mcpServers: './m.json' })
          put(join(dir(claudeDir, p), 'm.json'), { mcpServers: { s: srv } })
        }
        if (p === 'pjarr') put(join(dir(claudeDir, p), '.claude-plugin', 'plugin.json'), { mcpServers: [{ s: srv }] })
        if (p === 'hooky') {
          put(join(dir(claudeDir, p), 'hooks', 'hooks.json'), { hooks: { Stop: entry } })
          put(join(dir(claudeDir, p), '.mcp.json'), { mcpServers: { s: srv } })
        }
        ;(svc as unknown as { deps: PluginDeps }).deps.run = helpRun(claudeDir, calls)
        const c = await ask(svc, x, p)
        expect(c.body, p).not.toContain('runs a command')
        expect(c.body, p).not.toContain('Could not tell')
        expect(c.body, p).toContain(`/usr/bin/claude plugin install ${p}@market --scope user`)
        expect(c.body, p).not.toContain('--scope user -y')
        await tapAndWait(x, c)
        expect(installArgv(calls), p).toHaveLength(6)
        await x.stop?.()
        h = undefined
      }
    })

    test('a server headersHelper runs a command: the card says so and -y is passed', async () => {
      const calls: Calls = []
      const { x, svc, claudeDir } = await start()
      entryOf(claudeDir, { name: 'hh', source: './plugins/hh' })
      put(join(claudeDir, 'plugins', 'marketplaces', 'market', 'plugins', 'hh', '.mcp.json'), {
        mcpServers: { s: { type: 'http', url: 'https://x', headersHelper: './auth.sh' } },
      })
      ;(svc as unknown as { deps: PluginDeps }).deps.run = helpRun(claudeDir, calls)
      const c = await ask(svc, x, 'hh')
      expect(c.body).toContain('runs a command when it installs: ./auth.sh')
      await tapAndWait(x, c)
      expect(installArgv(calls)?.slice(6)).toEqual(['-y'])
    })

    test('a plugin that runs no command: no line on the card, no flag', async () => {
      const calls: Calls = []
      const { x, svc, claudeDir } = await start()
      put(
        join(claudeDir, 'plugins', 'marketplaces', 'market', 'plugins', 'plain', 'skills', 'x', 'SKILL.md'),
        'a skill',
      )
      entryOf(claudeDir, { name: 'plain', source: './plugins/plain' })
      ;(svc as unknown as { deps: PluginDeps }).deps.run = helpRun(claudeDir, calls)
      const c = await ask(svc, x, 'plain')
      expect(c.body).not.toContain('runs a command')
      await tapAndWait(x, c)
      expect(installArgv(calls)).toHaveLength(6)
    })

    test('a plugin that is not in the marketplace file: the card says it could not tell, and no flag is passed', async () => {
      const calls: Calls = []
      const { x, svc, claudeDir } = await start()
      ;(svc as unknown as { deps: PluginDeps }).deps.run = helpRun(claudeDir, calls)
      const c = await ask(svc, x, 'unseen')
      expect(c.body).toContain(W.runsUnknown)
      await tapAndWait(x, c)
      expect(installArgv(calls)).toHaveLength(6)
    })
  })

  test('a hooks file that is a BARE event table: the card says the hooks file is malformed (Claude Code may not load it), lists no events, and still carries the approval warning (fail closed)', async () => {
    const { x, svc, claudeDir } = await start()
    marketplace(claudeDir, 'market', 'bare', undefined)
    put(join(claudeDir, 'plugins', 'marketplaces', 'market', 'plugins', 'bare', 'hooks', 'hooks.json'), {
      PreToolUse: entry,
    })
    const c = await ask(svc, x, 'bare')
    expect(c.body).toContain(W.hooksMalformed)
    expect(c.body).not.toContain('PreToolUse')
    expect(c.warning).toBe(W.approves)
  })

  test('listed as installed and on, but its folder is not there: not "added"', async () => {
    const { x, svc, claudeDir } = await start({
      run: async (argv) => {
        const key = argv[3] as string
        put(join(claudeDir, 'plugins', 'installed_plugins.json'), {
          version: 2,
          plugins: {
            [key]: [{ scope: 'user', installPath: join(claudeDir, 'plugins', 'cache', 'gone'), version: '1' }],
          },
        })
        put(join(claudeDir, 'settings.json'), { enabledPlugins: { [key]: true } })
        return { ok: true, stdout: '', code: 0 }
      },
    })
    const c = await ask(svc, x, 'notes')
    expect(await tapAndWait(x, c, 'failed')).toContain('Nothing was added')
  })

  test('the Settings flag lists a plugin whose hooks file is a bare table (fail closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bare'))
    dirs.push(dir)
    installed(dir, 'bare@m', undefined)
    put(join(dir, 'plugins', 'cache', 'm', 'bare', '1.0.0', 'hooks', 'hooks.json'), { Stop: entry })
    expect(approvingPlugins(() => dir)()).toEqual(['bare@m'])
  })

  test('every malformed hooks file shows the approve warning on the CARD too (a hooks that is not a table; an event that is not a list)', async () => {
    const forms: Record<string, unknown> = {
      'hk-str': { hooks: 'x' },
      'hk-arr': { hooks: [] },
      'hk-odd': { hooks: { PreToolUse: {} } },
    }
    const { x, svc, claudeDir } = await start()
    put(join(claudeDir, 'plugins', 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'), {
      plugins: Object.keys(forms).map((name) => ({ name, source: `./plugins/${name}` })),
    })
    for (const [name, body] of Object.entries(forms)) {
      put(join(claudeDir, 'plugins', 'marketplaces', 'market', 'plugins', name, 'hooks', 'hooks.json'), body)
      const c = await ask(svc, x, name)
      expect(c.body, name).toContain(W.hooksMalformed)
      expect(c.warning, name).toBe(W.approves)
    }
  })

  test('a command is shown whole on the card (a 200-character path is not cut), with the exact argv', async () => {
    const long = `/opt/${'p'.repeat(200)}/setup.sh --yes`
    const { x, svc, claudeDir } = await start()
    put(join(claudeDir, 'plugins', 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'), {
      plugins: [{ name: 'longcmd', source: { source: 'command', command: long } }],
    })
    const c = await ask(svc, x, 'longcmd')
    expect(c.body).toContain(`runs a command when it installs: ${long}`)
    expect(c.body).toContain('--scope user -y')
  })

  test('hooks in the marketplace ENTRY (no strict: false) are read, and warn', async () => {
    const { x, svc, claudeDir } = await start()
    put(join(claudeDir, 'plugins', 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'), {
      plugins: [{ name: 'entryhook', source: './plugins/entryhook', hooks: { PreToolUse: entry } }],
    })
    mkdirSync(join(claudeDir, 'plugins', 'marketplaces', 'market', 'plugins', 'entryhook'), { recursive: true })
    const c = await ask(svc, x, 'entryhook')
    expect(c.warning).toBe(W.approves)
    expect(c.body).toContain('Hooks: PreToolUse')
  })

  test('temp_git_* folders: after a FAILED install only the ones this install made are removed (by name and time); older ones stay', async () => {
    const { x, svc, claudeDir } = await start({
      run: async () => {
        put(join(claudeDir, 'plugins', 'cache', 'temp_git_new', 'x.txt'), 'half a clone')
        return { ok: false, reason: 'timeout' }
      },
    })
    put(join(claudeDir, 'plugins', 'cache', 'temp_git_old', 'x.txt'), 'an earlier install’s')
    const c = await ask(svc, x, 'notes')
    await tapAndWait(x, c, 'failed')
    expect(existsSync(join(claudeDir, 'plugins', 'cache', 'temp_git_new'))).toBe(false)
    expect(existsSync(join(claudeDir, 'plugins', 'cache', 'temp_git_old'))).toBe(true)
  })
})

describe('the Settings flag reads where Claude Code loads the plugin from', () => {
  test('a LOCAL-FOLDER marketplace: the SOURCE folder is read (a hook added later shows the warning), not the cache copy; cached by file times', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf'))
    dirs.push(dir)
    const loc = join(dir, 'plugins', 'marketplaces', 'm')
    put(join(dir, 'plugins', 'known_marketplaces.json'), {
      m: { source: { source: 'directory', path: loc }, installLocation: loc },
    })
    put(join(loc, '.claude-plugin', 'marketplace.json'), { plugins: [{ name: 'forge', source: './plugins/forge' }] })
    const cache = join(dir, 'plugins', 'cache', 'm', 'forge', '1')
    put(join(dir, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'forge@m': [{ scope: 'user', installPath: cache, version: '1' }] },
    })
    put(join(dir, 'settings.json'), { enabledPlugins: { 'forge@m': true } })
    put(join(cache, 'hooks', 'hooks.json'), { hooks: { Stop: entry } })
    put(join(loc, 'plugins', 'forge', 'hooks', 'hooks.json'), { hooks: { Stop: entry } })
    const flag = approvingPlugins(() => dir)
    expect(flag()).toEqual([])
    await sleep(t(20)) // timing-ok: the file's time must move
    put(join(loc, 'plugins', 'forge', 'hooks', 'hooks.json'), { hooks: { Stop: entry, PreToolUse: entry } }) // added to the SOURCE later
    expect(flag()).toEqual(['forge@m'])
  })
})

describe('the words', () => {
  test('are in the table: the service file writes no sentence of its own', async () => {
    const whole = await Bun.file(join(import.meta.dir, '..', 'src', 'plugins', 'agent-plugins.ts')).text()
    const src = whole
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    // no string literal of the service holds a sentence (comments may talk about them)
    expect(src).not.toMatch(/['"`][^'"`\n]*(without asking your phone|Nothing was added|Add the )/)
  })
})

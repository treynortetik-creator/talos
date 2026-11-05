// Run by `claude plugin test plugins/talos-app-mod` (no session, sign-in or network). Nothing sits beneath the mod's
// hooks: each `on` here stands for the engine, so what it answers reaches the mod as given.
import { expect, mock, test } from 'claude-code/testing'

const SYNC = 'mcp__talos-app__talos_mod_sync' as const
const HELLO = 'mcp__talos-app__talos_mod_hello' as const
const KEY = 'k'.repeat(43)
const KEY2 = 'j'.repeat(43)

// The mod's work after a timer tick includes real async crypto (`crypto.subtle.digest` for the HMAC and input hashes), which
// the mocked clock's settle does not wait for: on a loaded machine the sync lands a few real milliseconds after
// `clock.advance` returns. So a test waits for the condition, in real time, with a bound, instead of assuming it.
const until = async (done: () => boolean, ms = 5000) => {
  for (let waited = 0; !done() && waited < ms; waited += 5) await new Promise((r) => setTimeout(r, 5))
}

const text = (value: unknown) => ({
  value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false },
})

test('the guard denies the model, and a subagent, on both bridge tools', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: {} }))
  for (const tool of [SYNC, HELLO] as const) {
    const check = await $.tool.check({ tool, input: {} })
    expect(check.decision).toBe('deny')
    const call = await $.tool.call({ tool, agentId: 'a1' })
    expect(JSON.stringify(call)).toContain('Never call')
  }
})

test('the guard leaves every other tool alone', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const read = await $.tool.check({ tool: 'Read', input: { file_path: 'a.md' } })
  expect(read.decision).toBe('allow')
  const reply = await $.tool.check({ tool: 'mcp__talos-app__reply', input: {} })
  expect(reply.decision).toBe('allow')
})

test('both bridge tools are described as internal and deferred', async ($, on) => {
  on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: undefined }))
  const d = await $.tool.describe({ tool: SYNC, description: 'x', provider: { plugin: 'talos-app', tier: 'user' } })
  expect(d.description).toBe('Internal to the Talos mod. Never call.')
  expect(d.isDeferred).toBe(true)
})

test('an ask becomes prompt_open, and the finished call prompt_closed, in the next sync', async ($, on) => {
  const clock = mock.clock(on)
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({
    value: [
      { name: HELLO, description: '', mcp: true },
      { name: SYNC, description: '', mcp: true },
    ],
  }))
  on('command.list', () => ({ value: [{ name: 'model', description: 'Switch model', source: 'builtin' }] }))
  on('config.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess_test' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.version', () => ({ value: { version: '2.1.312' } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 1000, window: 200000, percent: 0 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-29T20:00:00Z' }],
      cost: { usd: 0.5 },
    },
  }))
  // the bridge's key file: KEY before hello, KEY2 after it rotated
  let rotated = false
  on('env.get', (_$, e) => ({ value: e.name === 'TALOS_APP_HOME' ? '/opt/talos-home' : undefined }))
  on('fs.read', (_$, e) => {
    expect(e.path).toBe('/opt/talos-home/mod.key')
    return { value: `${rotated ? KEY2 : KEY}\n` }
  })
  on('mcp.call', (_$, e) => {
    calls.push({ tool: e.tool, args: e.args ?? {} })
    if (e.tool === 'talos_mod_hello') {
      rotated = true
      return text({ ok: true })
    }
    return text({ controls: [] })
  })
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)

  const sync = () => calls.filter((c) => c.tool === 'talos_mod_sync')
  await until(() => sync().length > 0)
  expect(calls[0]?.tool).toBe('talos_mod_hello')
  expect(sync().length).toBeGreaterThan(0)
  const first = sync()[0]?.args as {
    mod_key: string
    seq: number
    state: { rate_limits: unknown; source: string; capabilities: string[] }
    inventory: { commands: unknown[] }
  }
  // the key never travels: hello carried a MAC of a timestamp, each sync a MAC of its sequence number and body
  expect(calls[0]?.args).toEqual({ ts: expect.any(Number), proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
  expect(first.mod_key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(first.seq).toBe(1)
  expect(JSON.stringify(calls)).not.toContain(KEY)
  expect(JSON.stringify(calls)).not.toContain(KEY2)
  expect(first.state.rate_limits).toEqual([{ kind: 'five_hour', percent: 12.5, resets_at: '2026-10-29T20:00:00Z' }])
  expect(first.state.source).toBe('mod')
  expect(first.state.capabilities).toEqual(expect.arrayContaining(['inventory', 'permission_close']))
  expect(first.inventory.commands[0]).toMatchObject({ name: 'model', source: 'builtin' })

  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await clock.advance(2000)
  await until(() =>
    sync().some(
      (c) => Array.isArray(c.args.events) && c.args.events.some((e: { type: string }) => e.type === 'prompt_closed'),
    ),
  )
  const events = sync().flatMap((c) => (c.args.events as Array<Record<string, unknown>> | undefined) ?? [])
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['prompt_open', 'prompt_closed']))
  const open = events.find((e) => e.type === 'prompt_open')
  expect(open?.tool_name).toBe('Bash')
  expect(String(open?.input_hash)).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(sync().map((c) => c.args.seq)).toEqual(sync().map((_, i) => i + 1)) // seq only goes up
})

test('a Claude Code below 2.1.304 does nothing: no hello, no sync', async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({ value: [{ name: HELLO, description: '', mcp: true }] }))
  on('command.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess_test' }))
  on('session.version', () => ({ value: { version: '2.1.303' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('mcp.call', (_$, e) => {
    calls.push(e.tool)
    return text({})
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)
  expect(calls).toEqual([])
})

test('with no bridge connected the mod waits quietly and connects when it appears', async ($, on) => {
  const clock = mock.clock(on)
  const calls: string[] = []
  let bridgeUp = false
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({
    value: bridgeUp
      ? [
          { name: HELLO, description: '', mcp: true },
          { name: SYNC, description: '', mcp: true },
        ]
      : [],
  }))
  on('command.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess_test' }))
  on('session.model', () => ({ value: 'm' }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.version', () => ({ value: { version: '2.1.312' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('env.get', () => ({ value: '/opt/talos-home' }))
  on('fs.read', () => ({ value: `${KEY}\n` }))
  on('mcp.call', (_$, e) => {
    calls.push(e.tool)
    return e.tool === 'talos_mod_hello' ? text({ ok: true }) : text({ controls: [] })
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(6000)
  expect(calls).toEqual([])
  bridgeUp = true
  await clock.advance(30_000)
  await until(() => calls.includes('talos_mod_sync'))
  expect(calls[0]).toBe('talos_mod_hello')
  expect(calls).toContain('talos_mod_sync')
})

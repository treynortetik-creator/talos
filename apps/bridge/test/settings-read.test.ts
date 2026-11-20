// `settings_read`: a session checks a setting's current value, and whether a settings card still waits, before it says "waiting".
import { afterEach, describe, expect, test } from 'bun:test'
import { type CardT, CONFIG_PROPOSE_FEATURE } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { settingsReadText } from '../src/config-propose/settings-read.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const start = (extra: Record<string, unknown> = {}) =>
  startHarness({
    relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] },
    config: (c) => ({ ...c, ...extra }) as typeof c,
  })
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const read = async (x: Harness) => text(await x.bridge.callTool('settings_read', {}))
const configCards = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)
    .filter((c) => c.kind === 'config')

describe('settings_read', () => {
  test('main: values, then the pending card after a proposal the owner did not ask for', async () => {
    h = await start()
    const first = await read(h)
    expect(first).toContain('dev.thread_fence: true')
    expect(first).toMatch(/^timezone: /m)
    expect(first).toContain('Pending settings cards: none')
    const r = await h.bridge.callTool('config_propose', {
      thread_id: 'general',
      reason: 'x',
      changes: [{ path: 'dev.thread_fence', value: false }],
    })
    expect(r.isError, text(r)).toBeFalsy()
    await waitFor(() => configCards(h as Harness).length === 1, 4000, 'the card')
    const id = (configCards(h)[0] as CardT).id
    expect(await read(h)).toMatch(new RegExp(`Pending settings cards: ${id} \\(dev\\.thread_fence, expires \\S+\\)`))
  })

  test('a sub-thread\'s missing folder and MCP list read null (raw), never "same as <parent>"', async () => {
    const base = loadExampleConfig('default')
    const t = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      kind: 'agent',
      order: 9,
      notify: 'all',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
      ...extra,
    })
    h = await start({
      threads: [
        ...base.threads,
        t('site', { session_opts: { cwd: '/home/alex/site', mcp_allow: ['github'] } }),
        t('docs', { parent_id: 'site' }),
      ],
    })
    const out = await read(h)
    expect(out).toContain('threads.docs.session_opts.cwd: null')
    expect(out).toContain('threads.docs.mcp_allow: null')
    expect(out).not.toContain('same as')
  })

  test("a thread session's view: its own thread's fields and cards only", async () => {
    h = await startHarness({
      relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] },
      config: () => loadExampleConfig('five-threads'),
    })
    const ids = h.bridge.ctx.config.threadIds()
    const [a, b] = ids as [string, string]
    for (const t of [a, b])
      await h.bridge.callTool('config_propose', {
        thread_id: t,
        reason: 'x',
        changes: [{ path: `threads.${t}.name`, value: `Renamed ${t}` }],
      })
    await waitFor(() => configCards(h as Harness).length === 2, 4000, 'both cards')
    const main = settingsReadText(h.bridge.ctx)
    expect(main).toContain(`threads.${a}.name:`)
    expect(main).toContain(`threads.${b}.name:`)
    // the fields an agent sets up a thread with are listed, the folder's dotted path included
    for (const f of ['color', 'effort', 'model', 'mcp_allow', 'session_opts.cwd'])
      expect(main).toContain(`threads.${a}.${f}:`)
    const mine = settingsReadText(h.bridge.ctx, a)
    expect(mine).toContain(`threads.${a}.name:`)
    expect(mine).not.toContain(`threads.${b}.`)
    expect(mine).toMatch(/^dev\.thread_fence: /m)
    const cards = configCards(h)
    const own = cards.find((c) => c.thread_id === a) as CardT
    const other = cards.find((c) => c.thread_id === b) as CardT
    expect(mine).toContain(own.id)
    expect(mine).not.toContain(other.id)
  })

  test("a thread session does not see another thread's id as the default thread, nor in a card's paths", async () => {
    h = await startHarness({
      relay: { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] },
      config: () => loadExampleConfig('five-threads'),
    })
    const cfg = h.bridge.ctx.config.config
    const [a, b] = h.bridge.ctx.config.threadIds().filter((t) => t !== cfg.default_thread) as [string, string]
    const own = settingsReadText(h.bridge.ctx, cfg.default_thread)
    expect(own).toContain('default_thread: "this thread"')
    const other = settingsReadText(h.bridge.ctx, a)
    expect(other).toContain('default_thread: "another thread"')
    expect(other).not.toContain(`default_thread: ${JSON.stringify(cfg.default_thread)}`)
    // a card in thread `a` that also names thread `b`
    await h.bridge.callTool('config_propose', {
      thread_id: a,
      reason: 'x',
      changes: [
        { path: `threads.${a}.name`, value: 'Mine' },
        { path: `threads.${b}.name`, value: 'Theirs' },
      ],
    })
    await waitFor(() => configCards(h as Harness).length === 1, 4000, 'the card')
    const view = settingsReadText(h.bridge.ctx, a)
    expect(view).toContain(`threads.${a}.name, another thread's setting`)
    expect(view).not.toContain(`threads.${b}.name,`)
    expect(settingsReadText(h.bridge.ctx)).toContain(`threads.${b}.name`)
  })
})

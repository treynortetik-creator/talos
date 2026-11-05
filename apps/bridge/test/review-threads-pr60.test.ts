// Independent review of PR #60 (thread management). Each test drives the real bridge through the FakeRelay with a
// signed config.patch or a real MCP tool call. Tests marked REVIEW-FAIL are expected to fail on 677cf2b.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Thread } from '@talos-app/protocol'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

type T = { id: string; name: string; color?: string; topic?: string; icon?: string; archived?: boolean; kind?: string }
const onDisk = () => JSON.parse(readFileSync(join(h.home, 'config.json'), 'utf8'))
const thread = (id: string) => onDisk().threads.find((t: T) => t.id === id) as T | undefined
const errFor = async (id: string) =>
  (await h.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })).code
const ackFor = (id: string) => h.relay.expectFrame('ack', (a) => a.ref === id, { direction: 'from_bridge' })
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text

/** What a web build from before this PR keeps of a thread: its zod schema has no color/topic and strips them. */
const LegacyThread = Thread.omit({ color: true, topic: true })

async function colour() {
  const cfg = onDisk()
  const threads = cfg.threads.map((t: T) =>
    t.id === 'general' ? { ...t, color: 'pink', topic: 'Day to day', icon: 'briefcase' } : t,
  )
  const f = await h.app.sendConfigPatch(cfg.rev, { threads })
  await ackFor(f.id)
  expect(thread('general')).toMatchObject({ color: 'pink', topic: 'Day to day' })
}

describe('PR60 review: backward compat with an old cached web build', () => {
  test('REVIEW-FAIL: an old app renaming ANOTHER thread does not wipe General’s color and topic', async () => {
    h = await startHarness()
    await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    await colour()
    // the old build received config.sync and parsed it with its own schema (strip), then the owner renames inbox there
    const sync = await h.relay.expectFrame('config.sync', (s) => s.rev === onDisk().rev, { direction: 'from_bridge' })
    const seen = sync.config.threads.map((t: unknown) => LegacyThread.parse(t))
    const threads = seen.map((t: T) => (t.id === 'inbox' ? { ...t, name: 'Inbox 2' } : t))
    const f = await h.app.sendConfigPatch(onDisk().rev, { threads })
    await ackFor(f.id)
    expect(thread('inbox')?.name).toBe('Inbox 2')
    // the owner never touched General on the old device: its color and topic must survive
    expect(thread('general')).toMatchObject({ color: 'pink', topic: 'Day to day' })
  })
})

describe('PR60 review: default thread / archive invariants live only in one UI', () => {
  test('REVIEW-FAIL: a signed patch that archives the default thread is refused', async () => {
    h = await startHarness()
    await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    const cfg = onDisk()
    expect(cfg.default_thread).toBe('general')
    // Settings > Agent still has an "Archived" checkbox with no default guard; an old build has no guard either
    const threads = cfg.threads.map((t: T) => (t.id === cfg.default_thread ? { ...t, archived: true } : t))
    const f = await h.app.sendConfigPatch(cfg.rev, { threads })
    const code = await Promise.race([errFor(f.id), ackFor(f.id).then(() => 'applied')])
    expect(code).not.toBe('applied')
    expect(thread('general')?.archived).toBe(false)
  })

  test('REVIEW-FAIL: archive_thread (agent) refuses the thread the owner made the default', async () => {
    h = await startHarness()
    await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    expect(text(await h.bridge.callTool('create_thread', { name: 'Builds' }))).toContain('created thread builds')
    const cfg = onDisk()
    const f = await h.app.sendConfigPatch(cfg.rev, { default_thread: 'builds' })
    await ackFor(f.id)
    expect(onDisk().default_thread).toBe('builds')
    const r = await h.bridge.callTool('archive_thread', { thread_id: 'builds' })
    // the agent must not be able to archive where every unmatched proactive message now lands
    expect(thread('builds')?.archived).toBe(false)
    expect(r.isError).toBe(true)
  })
})

describe('PR60 review: ids are stable across rename (controls)', () => {
  test('rename keeps the id: list_threads, reply and read_thread all still address it', async () => {
    h = await startHarness()
    await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    expect(text(await h.bridge.callTool('reply', { thread_id: 'general', text: 'before' }))).not.toContain('Unknown')
    const cfg = onDisk()
    const threads = cfg.threads.map((t: T) => (t.id === 'general' ? { ...t, name: 'Main' } : t))
    const f = await h.app.sendConfigPatch(cfg.rev, { threads })
    await ackFor(f.id)
    const list = JSON.parse(text(await h.bridge.callTool('list_threads', {})))
    expect(list.threads.find((t: T) => t.id === 'general')?.name).toBe('Main')
    expect(list.default_thread).toBe('general')
    const r = await h.bridge.callTool('reply', { thread_id: 'general', text: 'after' })
    expect(r.isError).not.toBe(true)
    const hist = text(await h.bridge.callTool('read_thread', { thread_id: 'general' }))
    expect(hist).toContain('before')
    expect(hist).toContain('after')
  })

  test('a config written before this PR (no icon/color/topic/order) still loads and patches', async () => {
    h = await startHarness({
      config: (c) => ({
        ...c,
        threads: c.threads.map((t) => {
          const { order: _o, icon: _i, color: _c, topic: _t, ...rest } = t as T & { order?: number }
          return rest as never
        }),
      }),
    })
    await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    const cfg = onDisk()
    expect(cfg.threads.every((t: { order?: number }) => t.order === undefined || t.order === 0)).toBe(true)
    const f = await h.app.sendConfigPatch(cfg.rev, { default_thread: 'inbox' })
    await ackFor(f.id)
    expect(onDisk().default_thread).toBe('inbox')
  })
})

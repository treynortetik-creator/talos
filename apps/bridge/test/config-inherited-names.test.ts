import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadExampleConfig } from '@talos-app/testkit'
import { ConfigFile } from '../src/config-file.ts'
import { type Harness, startHarness, tempHome } from './helpers.ts'

// Thread ids that every object already has (`constructor`) are not made any more, but one that was stored
// before the rule must keep working: the bridge starts, config.sync carries it, the owner can edit and archive it.
let h: Harness
afterEach(async () => h?.stop())

const at = '2026-10-28T15:00:00.000Z'
const thread = (id: string, order = 9) => ({
  id,
  name: id,
  kind: 'agent' as const,
  order,
  notify: 'all' as const,
  voice_context: 'recent' as const,
  archived: false,
  created_at: at,
})
const withStored = (c: ReturnType<typeof loadExampleConfig>) => ({
  ...c,
  threads: [...c.threads, thread('constructor')],
})
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('')

describe('a thread id stored before the rule', () => {
  test('ConfigFile.load reads a config.json that holds a thread called constructor', () => {
    const home = tempHome()
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify(withStored(loadExampleConfig('default'))))
    const file = new ConfigFile(join(home, 'config.json'))
    expect(file.load().threads.map((t) => t.id)).toContain('constructor')
    expect(file.thread('constructor')?.id).toBe('constructor')
  })

  test('the bridge starts on it, syncs it, and the agent can use and archive it', async () => {
    h = await startHarness({ config: withStored })
    const sync = await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    expect(sync.config.threads.map((t) => t.id)).toContain('constructor')
    const listed = JSON.parse(text(await h.bridge.callTool('list_threads', {})))
    expect(listed.threads.map((t: { id: string }) => t.id)).toContain('constructor')
    expect((await h.bridge.callTool('archive_thread', { thread_id: 'constructor' })).isError).toBeFalsy()
  })

  test('the owner can still edit it with a patch that keeps it', async () => {
    h = await startHarness({ config: withStored })
    const cfg = JSON.parse(readFileSync(join(h.home, 'config.json'), 'utf8'))
    const threads = cfg.threads.map((t: { id: string }) => (t.id === 'constructor' ? { ...t, topic: 'old notes' } : t))
    await h.app.sendConfigPatch(0, { threads })
    const sync = await h.relay.expectFrame('config.sync', (f) => f.rev === 1, { direction: 'from_bridge' })
    expect(sync.config.threads.find((t) => t.id === 'constructor')?.topic).toBe('old notes')
  })
})

describe('a NEW thread id that is an inherited name', () => {
  test('a config.patch from the app that adds one is refused and changes nothing', async () => {
    h = await startHarness()
    const cfg = JSON.parse(readFileSync(join(h.home, 'config.json'), 'utf8'))
    const f = await h.app.sendConfigPatch(0, { threads: [...cfg.threads, thread('constructor')] })
    const err = await h.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })
    expect(err.code).toBe('bad_frame')
    expect(err.message).toContain('constructor')
    expect(JSON.parse(readFileSync(join(h.home, 'config.json'), 'utf8')).rev).toBe(0)
  })

  test('ConfigFile.update (the agent tools and approved cards) refuses one too', () => {
    const home = tempHome()
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify(loadExampleConfig('default')))
    const file = new ConfigFile(join(home, 'config.json'))
    expect(() => file.update((c) => ({ ...c, threads: [...c.threads, thread('constructor')] }))).toThrow(/constructor/)
    expect(file.config.rev).toBe(0)
  })

  test('create_thread with an explicit id refuses it, and a name that slugs to one to <name>_thread', async () => {
    h = await startHarness()
    const r = await h.bridge.callTool('create_thread', { name: 'x', id: 'constructor' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('constructor')
    expect(text(await h.bridge.callTool('create_thread', { name: 'Constructor' }))).toContain('constructor_thread')
  })
})

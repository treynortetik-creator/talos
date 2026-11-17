// config_propose `threads.<id>.parent`: the agent may ask to put a thread under another one (or take it out), but only with a
// card, trust mode or not, because a sub-thread takes its parent's folder, model and MCP list. The sub-thread rules
// (packages/protocol sub-threads.ts) are judged at propose time, so the owner is never asked to approve a card the write would
// then refuse.
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CardT, CONFIG_PROPOSE_FEATURE } from '@talos-app/protocol'
import { eventually, type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const RELAY = { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] }
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
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
const parentOf = (x: Harness, id: string) => x.bridge.ctx.config.config.threads.find((t) => t.id === id)?.parent_id
const cards = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)

/** The Mac app's workers.json, saying whether it checks sub-thread folders (without it no sub-thread may change). */
function macSays(home: string, subthreads: boolean, ownFolder = false, sharedFolder = false) {
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: {
        pid: 1,
        heartbeat_at: new Date().toISOString(),
        workers_supported: true,
        subthreads_supported: subthreads,
        ...(ownFolder ? { subthreads_own_folder: true } : {}),
        ...(sharedFolder ? { subthreads_shared_folder: true } : {}),
      },
      threads: {},
    }),
  )
}

async function start(o: { trust?: boolean; mac?: boolean; lock?: boolean; own?: boolean; shared?: boolean } = {}) {
  h = await startHarness({
    relay: RELAY,
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      ...(o.trust === false ? {} : { trust_mode: true }),
      ...(o.lock ? { settings_lock: true } : {}),
      threads: [
        ...c.threads,
        thread('work', 'Work'),
        thread('daily', 'Daily'),
        thread('trip', 'Trip'),
        thread('visas', 'Visas', { parent_id: 'trip' }),
        thread('boss', 'Boss', { session: 'dedicated', session_opts: { cwd: '/home/alex/agent' } }),
        thread('repo', 'Repo', { session: 'dedicated', session_opts: { cwd: '/home/alex/repo' } }),
        thread('same', 'Same', { session: 'dedicated', session_opts: { cwd: '/home/alex/agent' } }),
        thread('bare', 'Bare', { session: 'dedicated' }),
      ],
    })) as never,
  })
  macSays(h.home, o.mac !== false, o.own === true, o.shared === true)
  return h
}

async function ownerAsks(x: Harness, msg = 'put Daily under Work') {
  await x.app.sendMessage('general', msg)
  await waitFor(
    () =>
      x.bridge.ctx.store
        .ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 50)
        .some((m) => m.thread_id === 'general' && m.text === msg),
    4000,
    'owner row',
  )
}
const propose = (x: Harness, changes: unknown) =>
  x.bridge.callTool('config_propose', { thread_id: 'general', reason: 'you asked', changes })
async function proposeCard(x: Harness, changes: unknown) {
  const r = await propose(x, changes)
  expect(r.isError, text(r)).toBeFalsy()
  const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
  expect(id, text(r)).toBeTruthy()
  await waitFor(() => cards(x).some((c) => c.id === id), 4000, 'card.create reached the relay')
  return cards(x).find((c) => c.id === id) as CardT
}
const approve = (x: Harness, card: CardT) => x.app.resolveCard(card, 'primary', card.payload_hash)

describe('threads.<id>.parent through config_propose', () => {
  test('asked, the lock off (the default): putting a thread under another is made at once and the owner is told how to undo it', async () => {
    const x = await start()
    await ownerAsks(x)
    const r = await propose(x, [{ path: 'threads.daily.parent', value: 'work' }])
    expect(text(r)).toContain('applied: the owner asked')
    expect(parentOf(x, 'daily')).toBe('work')
    expect(cards(x).filter((c) => c.kind === 'config')).toHaveLength(0)
  })

  test('the lock on: a card; approving it writes parent_id', async () => {
    const x = await start({ lock: true })
    await ownerAsks(x)
    const card = await proposeCard(x, [{ path: 'threads.daily.parent', value: 'work' }])
    expect(card.kind).toBe('config')
    expect(parentOf(x, 'daily')).toBeUndefined() // nothing written until the owner taps Apply
    await approve(x, card)
    await eventually(() => expect(parentOf(x, 'daily')).toBe('work'))
  })

  test('null takes a sub-thread out from under its parent (the lock on: with a card)', async () => {
    const x = await start({ lock: true })
    await ownerAsks(x, 'take Visas out of Trip')
    const card = await proposeCard(x, [{ path: 'threads.visas.parent', value: null }])
    expect(parentOf(x, 'visas')).toBe('trip')
    await approve(x, card)
    await eventually(() => expect(parentOf(x, 'visas')).toBeUndefined())
  })

  test.each([
    ['its own parent', 'threads.daily.parent', 'daily', "can't be its own parent"],
    ['under a sub-thread (one level deep)', 'threads.daily.parent', 'visas', 'is a sub-thread itself'],
    ['a thread with sub-threads under another', 'threads.trip.parent', 'work', 'has sub-threads of its own'],
    ['under a thread that does not exist', 'threads.daily.parent', 'nowhere', 'there is no thread "nowhere"'],
    ['the inbox under a thread', 'threads.inbox.parent', 'work', 'system thread'],
  ])('refused at propose time: %s; no card is drawn and nothing is written', async (_what, path, value, words) => {
    const x = await start({ trust: true })
    await ownerAsks(x)
    const before = JSON.stringify(x.bridge.ctx.config.config)
    const r = await propose(x, [{ path, value }])
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(words)
    expect(cards(x).filter((c) => c.kind === 'config')).toHaveLength(0)
    expect(JSON.stringify(x.bridge.ctx.config.config)).toBe(before)
  })

  test('a Mac app that does not check sub-thread folders yet: refused, in words the agent can pass on', async () => {
    const x = await start({ trust: true, mac: false })
    await ownerAsks(x)
    const r = await propose(x, [{ path: 'threads.daily.parent', value: 'work' }])
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('sub-threads need the Talos app on your Mac to be updated first')
  })

  test('a dedicated thread with its own folder outside the parent: refused while the Mac app lacks the capability', async () => {
    const x = await start({ trust: true })
    await ownerAsks(x, 'put Repo under Boss')
    const r = await propose(x, [{ path: 'threads.repo.parent', value: 'boss' }])
    expect(r.isError).toBe(true)
    expect(text(r)).toContain("must be inside its parent's folder")
    expect(parentOf(x, 'repo')).toBeUndefined()
  })

  test('with the capability it is made, and the owner sees the one warning line', async () => {
    const x = await start({ trust: true, own: true })
    await ownerAsks(x, 'put Repo under Boss')
    const r = await propose(x, [{ path: 'threads.repo.parent', value: 'boss' }])
    expect(r.isError, text(r)).toBeFalsy()
    expect(parentOf(x, 'repo')).toBe('boss')
    expect(text(r)).toContain('Warning:')
    expect(text(r)).toContain(
      'thread "repo" keeps its own folder, so it does not get "boss"\'s instructions; the parent\'s privacy rules still apply',
    )
  })

  // the owner's bug: two threads that work in one folder could not be put one under the other
  test.each([
    ['the same folder as the parent', 'same'],
    ['no folder at all', 'bare'],
  ])('a dedicated thread with %s: refused while the supervisor lacks the capability', async (_what, id) => {
    const x = await start({ trust: true, own: true })
    await ownerAsks(x, `put ${id} under Boss`)
    const r = await propose(x, [{ path: `threads.${id}.parent`, value: 'boss' }])
    expect(r.isError).toBe(true)
    expect(parentOf(x, id)).toBeUndefined()
  })

  test.each([
    ['the same folder as the parent', 'same'],
    ['no folder at all', 'bare'],
  ])(
    'a dedicated thread with %s: made with the capability, and the owner sees the shared-folder warning',
    async (_what, id) => {
      const x = await start({ trust: true, own: true, shared: true })
      await ownerAsks(x, `put ${id} under Boss`)
      const r = await propose(x, [{ path: `threads.${id}.parent`, value: 'boss' }])
      expect(r.isError, text(r)).toBeFalsy()
      expect(parentOf(x, id)).toBe('boss')
      expect(text(r)).toContain(
        `thread "${id}" and its parent "boss" work in the same folder; they can edit the same files`,
      )
    },
  )
})

// m5/app-control: the owner's agent runs the app through approval cards. Thread operations (create, rename, retopic, archive, the
// own-session switch) and the newly listed settings go through config_propose with old and new on the card; trust mode applies a
// LOW change directly and never a HIGH one; a mac row is refused either way; a thread session may propose for its own thread
// only; every applied change names how to revert it and emits a named event. Real bridge + FakeRelay + a signing FakeApp.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CardT, CONFIG_PROPOSE_FEATURE } from '@talos-app/protocol'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { createLogger, nullLogger } from '../src/log.ts'
import { INBOX_MARKER, keptInboxThreadIds, removeGoneInboxes } from '../src/worker/inbox.ts'
import { eventually, type Harness, pushCardResolvePastRelay, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
let worker: Bridge | undefined
afterEach(async () => {
  await worker?.stop()
  worker = undefined
  await h?.stop()
  h = undefined
})

const RELAY = { relayFeatures: ['schedules/1', CONFIG_PROPOSE_FEATURE] }
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const cfg = (x: Harness) => x.bridge.ctx.config.config
const lines: string[] = []
/** The named events the bridge wrote to its log, without the log's own level and time. */
const events = (): Array<Record<string, unknown>> =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.msg === 'event')
    .map(({ level: _l, time: _t, msg: _m, event, ...fields }) => ({ event, ...fields }))
const cards = (x: Harness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)
const noCardMinted = (x: Harness) => expect(cards(x).filter((c) => c.kind === 'config')).toHaveLength(0)

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

// `lock` (default on): the card flow. Off, a change the owner asked for is made at once (settings-on-request.test.ts).
async function start(o: { trust?: boolean; dedicated?: boolean; threads?: unknown[]; lock?: boolean } = {}) {
  lines.length = 0
  h = await startHarness({
    relay: RELAY,
    bridge: { logger: createLogger(null, 'debug', (l) => lines.push(l)) },
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      ...(o.trust ? { trust_mode: true } : {}),
      ...(o.lock === false ? {} : { settings_lock: true }),
      ...(o.dedicated === false ? {} : { dedicated: { enabled: true } }),
      threads: [
        ...c.threads,
        thread('trip', 'Trip', { topic: 'Flights' }),
        thread('garden', 'Garden'),
        ...(o.threads ?? []),
      ],
    })) as never,
  })
  return h
}

async function ownerAsks(x: Harness, thr = 'general', msg = 'please change that') {
  await x.app.sendMessage(thr, msg)
  await waitFor(
    () =>
      x.bridge.ctx.store
        .ownerRowsSince(new Date(Date.now() - 60_000).toISOString(), 50)
        .some((m) => m.thread_id === thr && m.text === msg),
    4000,
    'owner row',
  )
}
const propose = (x: Harness, changes: unknown, extra: Record<string, unknown> = {}) =>
  x.bridge.callTool('config_propose', { thread_id: 'general', reason: 'you asked', changes, ...extra })
async function proposeCard(x: Harness, changes: unknown) {
  const r = await propose(x, changes)
  expect(r.isError, text(r)).toBeFalsy()
  const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
  expect(id, text(r)).toBeTruthy()
  await waitFor(() => cards(x).some((c) => c.id === id), 4000, 'card.create reached the relay')
  return cards(x).find((c) => c.id === id) as CardT
}
const approve = (x: Harness, card: CardT) => x.app.resolveCard(card, 'primary', card.payload_hash)
const doneText = async (x: Harness, card: CardT) =>
  (
    await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done', {
      direction: 'from_bridge',
    })
  ).result?.text ?? ''

describe('rename, retopic, own session and the model list, through a card', () => {
  test('rename a thread: the card shows old and new, approval writes it, the result names the way back, the event carries ids only', async () => {
    await start()
    await ownerAsks(h as Harness)
    const x = h as Harness
    const card = await proposeCard(x, [{ path: 'threads.trip.name', value: 'Travel' }])
    expect(card.body).toContain('Thread trip name: Trip → Travel')
    expect(cfg(x).threads.find((t) => t.id === 'trip')?.name).toBe('Trip') // proposing writes nothing
    await approve(x, card)
    await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'trip')?.name).toBe('Travel'))
    const result = await doneText(x, card)
    expect(result).toContain('Saved.')
    expect(result).toContain('To undo: Thread trip name back to Trip')
    expect(cfg(x).threads.map((t) => t.id)).toEqual(['general', 'inbox', 'trip', 'garden']) // no other thread lost
    await x.relay.expectFrame('config.sync', (f) => f.config.threads.some((t) => t.name === 'Travel'), {
      direction: 'from_bridge',
    })
    await eventually(() =>
      expect(events()).toContainEqual({ event: 'thread.renamed', thread_id: 'trip', source: 'agent_card' }),
    )
    expect(JSON.stringify(events())).not.toContain('Travel')
  })

  test('retopic and notify: the old value is read from the config; an empty topic clears it', async () => {
    await start()
    await ownerAsks(h as Harness)
    const x = h as Harness
    const card = await proposeCard(x, [
      { path: 'threads.trip.topic', value: '' },
      { path: 'threads.garden.notify', value: 'needs_you' },
      { path: 'threads.garden.icon', value: 'leaf' },
    ])
    expect(card.body).toContain('Thread trip topic: Flights → ')
    await approve(x, card)
    await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'garden')?.notify).toBe('needs_you'))
    expect(cfg(x).threads.find((t) => t.id === 'trip')?.topic).toBeUndefined()
    expect(cfg(x).threads.find((t) => t.id === 'garden')?.icon).toBe('leaf')
    await eventually(() =>
      expect(events().filter((e) => e.event === 'setting.changed')).toEqual(
        expect.arrayContaining([
          { event: 'setting.changed', setting: 'threads.topic', thread_id: 'trip', source: 'agent_card' },
          { event: 'setting.changed', setting: 'threads.notify', thread_id: 'garden', source: 'agent_card' },
          { event: 'setting.changed', setting: 'threads.icon', thread_id: 'garden', source: 'agent_card' },
        ]),
      ),
    )
  })

  test('toggle a thread session: always a card, even in trust mode; approval switches it', async () => {
    for (const trust of [false, true]) {
      await start({ trust })
      const x = h as Harness
      await ownerAsks(x)
      const card = await proposeCard(x, [{ path: 'threads.trip.session', value: 'dedicated' }])
      expect(card.body).toContain('Thread trip own session: shared → dedicated')
      expect(cfg(x).threads.find((t) => t.id === 'trip')?.session).toBeUndefined()
      await approve(x, card)
      await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'trip')?.session).toBe('dedicated'))
      expect(await doneText(x, card)).toContain('To undo: Thread trip own session back to shared')
      await eventually(() =>
        expect(events()).toContainEqual({
          event: 'setting.changed',
          setting: 'threads.session',
          thread_id: 'trip',
          source: 'agent_card',
        }),
      )
      await x.stop()
      h = undefined
    }
  })

  test('the thread sessions master switch is a card too, and keeps the limits it already has', async () => {
    await start({ trust: true, dedicated: false })
    const x = h as Harness
    await ownerAsks(x)
    const card = await proposeCard(x, [{ path: 'dedicated', value: true }])
    expect(card.body).toContain('Thread sessions: off → on')
    await approve(x, card)
    await eventually(() => expect(cfg(x).dedicated?.enabled).toBe(true))
    expect(await doneText(x, card)).toContain('To undo: Thread sessions back to off')
  })

  test('change a session model: the list on a card, then applied; the old list is in the result', async () => {
    await start()
    const x = h as Harness
    await ownerAsks(x)
    const card = await proposeCard(x, [{ path: 'session_models', value: ['default', 'sonnet'] }])
    expect(card.body).toContain('default, opus, sonnet, haiku')
    await approve(x, card)
    await eventually(() => expect(cfg(x).session_models).toEqual(['default', 'sonnet']))
    expect(await doneText(x, card)).toContain('To undo: Model list back to default, opus, sonnet, haiku')
    await eventually(() =>
      expect(events()).toContainEqual({ event: 'setting.changed', setting: 'session_models', source: 'agent_card' }),
    )
  })

  test('a model list that is empty, too long or carries a shell word is refused with no card', async () => {
    await start()
    const x = h as Harness
    await ownerAsks(x)
    for (const value of [[], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'], ['opus; rm -rf /']])
      expect((await propose(x, [{ path: 'session_models', value }])).isError).toBe(true)
    noCardMinted(x)
  })
})

describe('the lock off: what the owner asked for is made at once, low or high; the lock on: a card; mac is always refused', () => {
  test('a rename, after the owner asked, is applied with no card and says how to undo it', async () => {
    await start({ lock: false })
    const x = h as Harness
    await ownerAsks(x)
    const r = await propose(x, [{ path: 'threads.trip.name', value: 'Travel' }])
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toContain('applied: the owner asked')
    expect(text(r)).toContain('To undo: Thread trip name back to Trip')
    expect(cfg(x).threads.find((t) => t.id === 'trip')?.name).toBe('Travel')
    noCardMinted(x)
    expect(events()).toContainEqual({ event: 'thread.renamed', thread_id: 'trip', source: 'agent_asked' })
  })

  test('a model list change is applied directly', async () => {
    await start({ lock: false })
    const x = h as Harness
    await ownerAsks(x)
    const r = await propose(x, [{ path: 'session_models', value: ['default', 'opus'] }])
    expect(text(r)).toContain('applied: the owner asked')
    expect(cfg(x).session_models).toEqual(['default', 'opus'])
  })

  test.each([
    ['threads.trip.archived', true],
    ['threads.trip.session', 'dedicated'],
    ['default_thread', 'trip'],
    ['notifications.master', false],
    ['notifications.show_thread_names', 'all'],
    ['dedicated', false],
    // audit 2026-11-10 #5: quiet hours hold every push, approval cards included
    ['quiet_window', { start: '00:00', end: '23:59' }],
    ['timezone', 'Pacific/Kiritimati'],
  ])('%s (high), asked: made at once with its undo line; the lock on: a card, nothing written', async (path, value) => {
    await start({ lock: false })
    const x = h as Harness
    await ownerAsks(x)
    const r = await propose(x, [{ path, value }])
    expect(text(r)).toContain('applied: the owner asked')
    expect(text(r)).toContain('To undo:')
    noCardMinted(x)
    await x.stop()
    await start()
    const y = h as Harness
    await ownerAsks(y)
    const before = JSON.stringify(cfg(y))
    const card = await proposeCard(y, [{ path, value }])
    expect(card.kind).toBe('config')
    expect(JSON.stringify(cfg(y))).toBe(before) // nothing written until the owner taps Apply
  })

  test('turning quiet hours off applies directly', async () => {
    await start({ lock: false })
    const x = h as Harness
    x.bridge.ctx.config.update((c) => ({ ...c, quiet_window: { start: '22:00', end: '07:00' } }))
    await ownerAsks(x)
    const r = await propose(x, [{ path: 'quiet_window', value: null }])
    expect(text(r)).toContain('applied: the owner asked')
    expect(cfg(x).quiet_window ?? null).toBeNull()
    noCardMinted(x)
  })

  test('the lock on: a list of changes is one card, with nothing written', async () => {
    await start()
    const x = h as Harness
    await ownerAsks(x)
    const before = JSON.stringify(cfg(x))
    const card = await proposeCard(x, [
      { path: 'threads.trip.name', value: 'Travel' },
      { path: 'threads.garden.archived', value: true },
    ])
    expect(card.body).toContain('Thread trip name: Trip → Travel')
    expect(card.body).toContain('Thread garden archived: no → yes')
    expect(JSON.stringify(cfg(x))).toBe(before)
  })

  test.each([false, true])(
    'permission_relay is refused with trust mode %p: no card, nothing written',
    async (trust) => {
      await start({ trust, lock: false })
      const x = h as Harness
      await ownerAsks(x)
      const before = JSON.stringify(cfg(x))
      for (const path of ['permission_relay', 'trust_mode', 'bug_webhook_url', 'work.retention', 'work.enabled']) {
        const r = await propose(x, [{ path, value: false }])
        expect(r.isError, path).toBe(true)
        expect(text(r), path).toMatch(/can't be changed by you/)
      }
      noCardMinted(x)
      expect(JSON.stringify(cfg(x))).toBe(before)
    },
  )

  test('a thread card forged against a mac row is refused again at apply, and nothing is written', async () => {
    await start({ trust: true })
    const x = h as Harness
    await ownerAsks(x)
    const good = await proposeCard(x, [{ path: 'threads.trip.archived', value: true }])
    const { Card, bindingFrom, payloadHash } = await import('@talos-app/protocol')
    const forged = Card.parse({
      ...good,
      id: 'c_01JBF3V7Q8K2M4N6P8R0S9T9T7',
      payload: {
        v: 1,
        base_rev: cfg(x).rev,
        reason: 'x',
        changes: [{ path: 'permission_relay', old: true, new: false }],
      },
    })
    forged.payload_hash = payloadHash(bindingFrom(forged))
    x.bridge.ctx.ledger.create(forged, 'bridge')
    const before = JSON.stringify(cfg(x))
    await pushCardResolvePastRelay(x, forged, forged.payload_hash)
    await eventually(() => expect(x.bridge.ctx.ledger.get(forged.id)?.state).toBe('failed'))
    expect(JSON.stringify(cfg(x))).toBe(before)
  })
})

describe('create_thread and archive_thread are thin wrappers over the same card', () => {
  test('create_thread keeps its checks, then shows a card; the thread exists once the owner approves', async () => {
    await start()
    const x = h as Harness
    const r = await x.bridge.callTool('create_thread', { name: 'Release Notes!', topic: 'Changelog drafts' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toContain('release_notes')
    expect(text(r)).toMatch(/card c_\S+ pending/)
    expect(cfg(x).threads.map((t) => t.id)).not.toContain('release_notes')
    const card = cards(x).find((c) => c.kind === 'config') as CardT
    expect(card.body).toContain('release_notes')
    expect(card.body).toContain('Release Notes!')
    await approve(x, card)
    await eventually(() => expect(cfg(x).threads.map((t) => t.id)).toContain('release_notes'))
    const made = cfg(x).threads.find((t) => t.id === 'release_notes')
    expect(made).toMatchObject({ kind: 'agent', notify: 'all', archived: false, topic: 'Changelog drafts' })
    await x.relay.expectFrame('thread.upsert', (f) => f.thread.id === 'release_notes', { direction: 'from_bridge' })
    expect(await doneText(x, card)).toMatch(/To undo: .*archive thread release_notes/)
    await eventually(() =>
      expect(events()).toContainEqual({ event: 'thread.created', thread_id: 'release_notes', source: 'agent_card' }),
    )
  })

  test('the old refusals stay: reserved ids, names every object has, a taken id, the 20-thread limit', async () => {
    await start()
    const x = h as Harness
    for (const args of [
      { name: 'Setup', id: 'talos__setup' },
      { name: 'x', id: 'constructor' },
      { name: 'Again', id: 'trip' },
      { name: '   ' },
    ])
      expect((await x.bridge.callTool('create_thread', args)).isError, JSON.stringify(args)).toBe(true)
    noCardMinted(x)
  })

  test.each(['general', 'garden'])(
    'the lock off, after the owner asked in %s, create_thread creates at once',
    async (askedIn) => {
      await start({ lock: false })
      const x = h as Harness
      await ownerAsks(x, askedIn)
      const r = await x.bridge.callTool('create_thread', { name: 'Errands' })
      expect(text(r)).toContain('created thread errands')
      expect(cfg(x).threads.map((t) => t.id)).toContain('errands')
      noCardMinted(x)
      await x.relay.expectFrame('thread.upsert', (f) => f.thread.id === 'errands', { direction: 'from_bridge' })
    },
  )

  test('without trust mode the card goes to the thread the owner asked in, not always the default thread', async () => {
    await start()
    const x = h as Harness
    await ownerAsks(x, 'garden')
    const r = await x.bridge.callTool('create_thread', { name: 'Errands' })
    expect(r.isError, text(r)).toBeFalsy()
    const card = cards(x).find((c) => c.kind === 'config') as CardT
    expect(card.thread_id).toBe('garden')
  })

  test('an explicit thread_id names where the owner asked', async () => {
    await start({ lock: false })
    const x = h as Harness
    await ownerAsks(x, 'trip')
    await ownerAsks(x, 'garden', 'and something else')
    const r = await x.bridge.callTool('create_thread', { name: 'Errands', thread_id: 'trip' })
    expect(text(r)).toContain('created thread errands')
  })

  test('a share in another thread after the owner spoke still cancels it (a card, not a direct create)', async () => {
    await start({ trust: true })
    const x = h as Harness
    await ownerAsks(x, 'garden')
    x.bridge.ctx.store.addMessage({
      id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      thread_id: 'inbox',
      seq: 99,
      author: 'owner',
      kind: 'text',
      text: 'shared text',
      format: 'plain',
      attachments: [],
      via: 'share',
      created_at: new Date(Date.now() + 1000).toISOString(),
    } as never)
    const r = await x.bridge.callTool('create_thread', { name: 'Errands' })
    expect(text(r)).toMatch(/card c_\S+ pending/)
  })

  test('archive_thread keeps its guards, shows a card even in trust mode, and approval archives and keeps the inbox', async () => {
    await start({ trust: true })
    const x = h as Harness
    await ownerAsks(x)
    expect((await x.bridge.callTool('archive_thread', { thread_id: 'general' })).isError).toBe(true) // fixed
    const r = await x.bridge.callTool('archive_thread', { thread_id: 'garden' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toMatch(/card c_\S+ pending/)
    expect(cfg(x).threads.find((t) => t.id === 'garden')?.archived).toBe(false)
    const inbox = join(x.bridge.ctx.paths.inbox, 'garden')
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, INBOX_MARKER), '') // as a folder the bridge made carries it
    writeFileSync(join(inbox, 'note.txt'), 'x')
    const card = cards(x).find((c) => c.kind === 'config') as CardT
    await approve(x, card)
    await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'garden')?.archived).toBe(true))
    await x.relay.expectFrame('thread.archive', (f) => f.thread_id === 'garden', { direction: 'from_bridge' })
    // commit() prunes the folders of threads gone from the config after the frame and config.sync sends; an archived one stays
    await x.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    expect(existsSync(join(inbox, 'note.txt'))).toBe(true)
    expect(await doneText(x, card)).toContain('To undo: unarchive thread garden')
    await eventually(() =>
      expect(events()).toContainEqual({ event: 'thread.archived', thread_id: 'garden', source: 'agent_card' }),
    )
  })
})

describe('archive_thread says what really happened, and keeps the saved file copies', () => {
  const withInbox = (x: Harness, id: string) => {
    const inbox = join(x.bridge.ctx.paths.inbox, id)
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, INBOX_MARKER), '') // as a folder the bridge made carries it
    writeFileSync(join(inbox, 'note.txt'), 'x')
    return inbox
  }

  test('the owner asked, lock off: it is archived now, no card, and the saved copies stay', async () => {
    await start({ lock: false })
    const x = h as Harness
    const inbox = withInbox(x, 'garden')
    await ownerAsks(x)
    const r = await x.bridge.callTool('archive_thread', { thread_id: 'garden' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toContain('Thread garden is archived now; its saved file copies are kept.')
    expect(text(r)).not.toContain('approves the card')
    expect(cfg(x).threads.find((t) => t.id === 'garden')?.archived).toBe(true)
    noCardMinted(x)
    await x.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    expect(existsSync(join(inbox, 'note.txt'))).toBe(true)
  })

  test('not asked: still a card, and the reply says so', async () => {
    await start({ lock: false })
    const x = h as Harness
    const r = await x.bridge.callTool('archive_thread', { thread_id: 'garden' })
    expect(text(r)).toMatch(/card c_\S+ pending/)
    expect(text(r)).toContain('is archived when the owner approves the card.')
    expect(cfg(x).threads.find((t) => t.id === 'garden')?.archived).toBe(false)
  })

  test('a thread removed from the config altogether still has its inbox removed', async () => {
    await start()
    const x = h as Harness
    const inbox = withInbox(x, 'gone_thread')
    const kept = withInbox(x, 'garden')
    removeGoneInboxes(x.bridge.ctx.paths.inbox, keptInboxThreadIds(cfg(x)))
    expect(existsSync(inbox)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })
})

describe('archiving a thread that has sub-threads', () => {
  /** The Mac app's workers.json, saying it checks sub-thread folders, with a fresh heartbeat. */
  const macSupportsSubThreads = (x: Harness) =>
    writeFileSync(
      join(x.bridge.ctx.paths.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: {
          pid: 1,
          heartbeat_at: new Date().toISOString(),
          workers_supported: true,
          subthreads_supported: true,
        },
        threads: {},
      }),
      { mode: 0o600 },
    )

  test('archive_thread puts the parent and its live sub-threads on one card, even in trust mode, and approval archives them all', async () => {
    await start({ trust: true, threads: [thread('seeds', 'Seeds', { parent_id: 'garden' })] })
    const x = h as Harness
    macSupportsSubThreads(x)
    await ownerAsks(x)
    const r = await x.bridge.callTool('archive_thread', { thread_id: 'garden' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toContain('with its sub-threads seeds')
    const card = cards(x).find((c) => c.kind === 'config') as CardT
    expect(card.body).toContain('garden')
    expect(card.body).toContain('seeds')
    await approve(x, card)
    await eventually(() =>
      expect(
        cfg(x)
          .threads.filter((t) => t.archived)
          .map((t) => t.id),
      ).toEqual(['garden', 'seeds']),
    )
  })

  test('a sub-thread the owner made stops the agent before any card is drawn', async () => {
    await start({ threads: [thread('beds', 'Beds', { kind: 'fixed', parent_id: 'garden' })] })
    const x = h as Harness
    macSupportsSubThreads(x)
    await ownerAsks(x)
    const r = await x.bridge.callTool('archive_thread', { thread_id: 'garden' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/only the owner can archive/)
    noCardMinted(x)
  })

  test("a sub-thread that is the owner's default thread stops the agent before any card is drawn", async () => {
    await start({ threads: [thread('seeds', 'Seeds', { parent_id: 'garden' })] })
    const x = h as Harness
    macSupportsSubThreads(x)
    x.bridge.ctx.config.update((c) => ({ ...c, default_thread: 'seeds' }))
    await ownerAsks(x)
    const r = await x.bridge.callTool('archive_thread', { thread_id: 'garden' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/default thread/)
    noCardMinted(x)
  })

  test('config_propose refuses archiving the parent alone before drawing a card the write would refuse', async () => {
    await start({ threads: [thread('seeds', 'Seeds', { parent_id: 'garden' })] })
    const x = h as Harness
    macSupportsSubThreads(x)
    await ownerAsks(x)
    const r = await propose(x, [{ path: 'threads.garden.archived', value: true }])
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Nothing was proposed: .*archive its sub-threads/)
    noCardMinted(x)
  })
})

describe('the owner changes things from the app: the same events, source owner', () => {
  test('a config.patch that renames a thread and sets the timezone writes thread.renamed and setting.changed', async () => {
    await start()
    const x = h as Harness
    await x.app.sendConfigPatch(cfg(x).rev, {
      timezone: 'Europe/Paris',
      threads: cfg(x).threads.map((t) => (t.id === 'trip' ? { ...t, name: 'Travel' } : t)),
    })
    await eventually(() => expect(cfg(x).timezone).toBe('Europe/Paris'))
    await eventually(() => expect(events().length).toBeGreaterThanOrEqual(2))
    expect(events()).toContainEqual({ event: 'thread.renamed', thread_id: 'trip', source: 'owner' })
    expect(events()).toContainEqual({ event: 'setting.changed', setting: 'timezone', source: 'owner' })
    expect(JSON.stringify(events())).not.toContain('Paris')
  })
})

describe('a thread session proposes for its own thread only', () => {
  const NONCE = 'test-nonce-0123456789abcdef'
  async function hubWithWorker() {
    await start({ dedicated: true })
    const x = h as Harness
    // trip has its own session
    x.bridge.ctx.config.update((c) => ({
      ...c,
      threads: c.threads.map((t) => (t.id === 'trip' ? { ...t, session: 'dedicated' as const } : t)),
    }))
    await waitFor(() => existsSync(join(x.home, 'run', 'hub.sock')))
    writeFileSync(
      join(x.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
        threads: {
          trip: {
            state: 'live',
            session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
            tmux: 't-trip',
            pane_pid: pgidOf(process.pid),
            cwd: x.home,
            error: null,
          },
        },
      }),
    )
    mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
    writeFileSync(join(x.home, 'workers', 'trip', 'nonce'), NONCE)
    worker = await Bridge.create({
      env: loadEnv({
        TALOS_APP_HOME: x.home,
        TALOS_APP_RELAY_URL: x.relay.httpUrl,
        TALOS_APP_WORKER_THREAD: 'trip',
        TALOS_APP_WORKER_NONCE: NONCE,
      }),
      logger: nullLogger,
    })
    expect(await worker.startWorker(), JSON.stringify(worker.hubClient?.lastRefusal)).toBe(true)
    return { x, w: worker }
  }
  const asWorker = (w: Bridge, changes: unknown, extra: Record<string, unknown> = {}) =>
    w.callTool('config_propose', { thread_id: 'trip', reason: 'you asked', changes, ...extra })

  test('the tool is in a thread session list; its own thread gets a card in that thread; the card applies on approval', async () => {
    const { x, w } = await hubWithWorker()
    expect(w.tools.map((t) => t.name)).toContain('config_propose')
    await ownerAsks(x, 'trip', 'call this thread Travel')
    const r = await asWorker(w, [{ path: 'threads.trip.name', value: 'Travel' }])
    expect(r.isError, text(r)).toBeFalsy()
    const id = /card (c_\S+) pending/.exec(text(r))?.[1] as string
    await waitFor(() => cards(x).some((c) => c.id === id), 4000, 'card.create')
    const card = cards(x).find((c) => c.id === id) as CardT
    expect(card.thread_id).toBe('trip')
    await approve(x, card)
    await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'trip')?.name).toBe('Travel'))
  })

  test('another thread, a global setting and a new thread are refused, with no card', async () => {
    const { x, w } = await hubWithWorker()
    await ownerAsks(x, 'trip', 'call this thread Travel')
    for (const changes of [
      [{ path: 'threads.garden.name', value: 'Plants' }],
      [{ path: 'timezone', value: 'Europe/Paris' }],
      [{ path: 'threads.errands', value: { name: 'Errands' } }],
      [{ path: 'default_thread', value: 'trip' }],
    ]) {
      const r = await asWorker(w, changes)
      expect(r.isError, JSON.stringify(changes)).toBe(true)
      expect(text(r)).toMatch(/own thread/)
    }
    // naming another thread as the place for the card is refused by the lock
    expect((await asWorker(w, [{ path: 'threads.trip.name', value: 'Travel' }], { thread_id: 'garden' })).isError).toBe(
      true,
    )
    noCardMinted(x)
    await sleep(50)
    expect(cfg(x).threads.find((t) => t.id === 'garden')?.name).toBe('Garden')
  })

  test('the owner did not ask in the thread: a thread session cannot change anything itself, only show him a card', async () => {
    const { x, w } = await hubWithWorker()
    const r = await asWorker(w, [{ path: 'threads.trip.name', value: 'Travel' }])
    expect(text(r)).toMatch(/card c_\S+ pending/)
    expect(cfg(x).threads.find((t) => t.id === 'trip')?.name).toBe('Trip')
  })
})

describe('follow-ups from the review of ffd0e721', () => {
  test('1. the lock on: alerts off is a card, and so is any alerts change; the lock off: made at once', async () => {
    await start()
    const x = h as Harness
    await ownerAsks(x)
    const before = JSON.stringify(cfg(x))
    const card = await proposeCard(x, [{ path: 'threads.trip.notify', value: 'off' }])
    expect(card.body).toContain('Thread trip alerts: all → off')
    expect(JSON.stringify(cfg(x))).toBe(before)
    const card2 = await proposeCard(x, [{ path: 'threads.general.notify', value: 'needs_you' }]) // the default thread
    expect(card2.kind).toBe('config')
    expect(JSON.stringify(cfg(x))).toBe(before)
    await x.stop()
    await start({ lock: false })
    const y = h as Harness
    await ownerAsks(y)
    const r = await propose(y, [{ path: 'threads.trip.notify', value: 'off' }])
    expect(text(r)).toContain('applied: the owner asked')
    expect(cfg(y).threads.find((t) => t.id === 'trip')?.notify).toBe('off')
  })

  test('1. one off among low changes makes the whole proposal a card', async () => {
    await start({ trust: true })
    const x = h as Harness
    await ownerAsks(x)
    const before = JSON.stringify(cfg(x))
    await proposeCard(x, [
      { path: 'threads.trip.name', value: 'Travel' },
      { path: 'threads.garden.notify', value: 'off' },
    ])
    expect(JSON.stringify(cfg(x))).toBe(before)
  })

  test('2a. the new-thread card shows the icon it writes', async () => {
    await start()
    const x = h as Harness
    await ownerAsks(x)
    const card = await proposeCard(x, [
      { path: 'threads.errands', value: { name: 'Errands', topic: 'Bills', icon: 'bag' } },
    ])
    expect(card.body).toContain('bag')
    await approve(x, card)
    await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'errands')?.icon).toBe('bag'))
  })

  test('2b. archiving a dedicated thread: the card says its session goes to shared, the result can undo both', async () => {
    await start()
    const x = h as Harness
    x.bridge.ctx.config.update((c) => ({
      ...c,
      threads: c.threads.map((t) => (t.id === 'trip' ? { ...t, session: 'dedicated' as const } : t)),
    }))
    await ownerAsks(x)
    const card = await proposeCard(x, [{ path: 'threads.trip.archived', value: true }])
    expect(card.body).toContain('Thread trip archived: no → yes')
    expect(card.body).toContain('Thread trip own session: dedicated → shared')
    await approve(x, card)
    await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'trip')?.archived).toBe(true))
    expect(cfg(x).threads.find((t) => t.id === 'trip')?.session).not.toBe('dedicated')
    const result = await doneText(x, card)
    expect(result).toContain('unarchive thread trip')
    expect(result).toContain('Thread trip own session back to dedicated')
  })

  test('3. one proposal past 20 agent threads goes ahead, with a warning (Pantheon 2026-11-15)', async () => {
    await start()
    const x = h as Harness
    x.bridge.ctx.config.update((c) => ({
      ...c,
      threads: [
        ...c.threads,
        ...(Array.from({ length: 17 }, (_, i) => thread(`t${i}`, `T${i}`)) as never[]), // trip and garden make 19
      ],
    }))
    await ownerAsks(x)
    const r = await propose(x, [
      { path: 'threads.n1', value: { name: 'N1' } },
      { path: 'threads.n2', value: { name: 'N2' } },
    ])
    expect(r.isError).toBeFalsy()
    expect(text(r)).toMatch(/Warning: this makes 21 active agent threads, more than 20/)
  })

  test('5. a high change is a card and never applied directly, but the card keeps its risk: a tap is the approval, no passkey step', async () => {
    await start({ trust: true })
    const x = h as Harness
    await ownerAsks(x)
    const before = JSON.stringify(cfg(x))
    const card = await proposeCard(x, [{ path: 'threads.trip.archived', value: true }])
    expect(card.risk).toBe('low')
    expect(JSON.stringify(cfg(x))).toBe(before)
    await approve(x, card) // a plain tap, no step-up token
    await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'trip')?.archived).toBe(true))
  })

  test('6. unarchiving writes thread.unarchived', async () => {
    await start()
    const x = h as Harness
    x.bridge.ctx.config.update((c) => ({
      ...c,
      threads: c.threads.map((t) => (t.id === 'garden' ? { ...t, archived: true } : t)),
    }))
    await ownerAsks(x)
    const card = await proposeCard(x, [{ path: 'threads.garden.archived', value: false }])
    await approve(x, card)
    await eventually(() => expect(cfg(x).threads.find((t) => t.id === 'garden')?.archived).toBe(false))
    await eventually(() =>
      expect(events()).toContainEqual({ event: 'thread.unarchived', thread_id: 'garden', source: 'agent_card' }),
    )
  })
})

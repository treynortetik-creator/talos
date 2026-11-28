// The card for a thread session that stopped on an API error or a refusal: made by the bridge from the transcript (session-error-watch.ts),
// with Clear session and Retry, answered only by the owner's signed tap in the app. Real hub and bridge, a real transcript file in a temp
// Claude folder, workers.json as the supervisor writes it. No real claude. Fixtures: see session-error-watch.test.ts.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CardT,
  cardNotice,
  createPhoneKeys,
  newUlid,
  shownHash,
  signNativeAct,
  signNativeGrant,
} from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { claudeConfigDir } from '../src/claude-dir.ts'
import { isSessionErrorCard } from '../src/router/session-error-cards.ts'
import * as W from '../src/router/session-error-words.ts'
import { transcriptPath } from '../src/router/worker-context.ts'
import { readInbound } from '../src/tools/read-inbound.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

const FIX = join(import.meta.dir, 'fixtures', 'transcripts')
const fixture = (name: string): string[] =>
  readFileSync(join(FIX, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
const SESSION = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'
const MSG = 'm_owner_one'
const OWNER_TEXT = 'Please read the article and tell me what it says'

let h: Harness | undefined
const made: string[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Every record gets the time of now (the watch ignores errors older than itself). */
const fresh = (lines: string[]) =>
  lines.map((l) => {
    const r = JSON.parse(l) as Record<string, unknown>
    r.timestamp = new Date().toISOString()
    return JSON.stringify(r)
  })
const patched = (line: string, patch: (r: Record<string, unknown>) => void) => {
  const r = JSON.parse(line) as Record<string, unknown>
  patch(r)
  return JSON.stringify(r)
}

async function start() {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [
        ...c.threads,
        {
          id: 'trip',
          name: 'Trip',
          kind: 'fixed',
          order: 5,
          notify: 'all',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  const claude = claudeConfigDir(h.bridge.ctx.env.userHome, h.bridge.ctx.env.claudeConfigDir)
  // never write into a real Claude folder: the harness's home is a throwaway one
  expect(realpathSync(claude).startsWith(realpathSync(tmpdir()))).toBe(true)
  return { x: h, claude }
}

function writeWorkers(x: Harness, over: Record<string, unknown> = {}) {
  writeFileSync(
    join(x.home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads: {
        trip: {
          state: 'live',
          session_id: SESSION,
          tmux: 't-trip',
          pane_pid: 0,
          cwd: '/home/alex/project',
          restarts: [],
          error: null,
          ...over,
        },
      },
    }),
  )
}

function putTranscript(claude: string, lines: string[]) {
  const path = transcriptPath(claude, '/home/alex/project', SESSION)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
  const old = new Date(Date.now() - 60_000)
  utimesSync(path, old, old)
  made.push(join(claude, 'projects'))
}

/** The owner's last message, as the router recorded it when it handed it to the thread. */
function seedOwnerMessage(x: Harness, id = MSG, content = OWNER_TEXT) {
  x.bridge.router?.store.addRoute({
    message_id: id,
    thread_id: 'trip',
    notification: { content, meta: { message_id: id, thread_id: 'trip', trust: 'owner', kind: 'text' } },
    woke_at: Date.now() - 5_000,
    deadline_at: Date.now() + 600_000,
    cold: false,
  })
}

/** The copy a Retry of this card sends: the held message's id, then `~retry~` and the failed record it answers. */
const recordOf = (c: CardT) => (c.payload as { session_error: { record: string } }).session_error.record
const retryRow = (x: Harness, c: CardT) => x.bridge.router?.store.route(`${MSG}~retry~${recordOf(c)}`)
const cardsOf = (x: Harness): CardT[] =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'config')
    .map((f) => (f.frame as { card: CardT }).card)
    .filter((c) => isSessionErrorCard({ kind: c.kind, payload: c.payload }))
const update = (x: Harness, cardId: string) =>
  x.relay.frames.find(
    (f) =>
      f.direction === 'from_bridge' &&
      f.frame.type === 'card.update' &&
      f.frame.card_id === cardId &&
      (f.frame.state === 'done' || f.frame.state === 'failed'),
  )?.frame as { state: string; result?: { ok: boolean; text: string } } | undefined
const systemRows = (x: Harness) =>
  x.bridge.ctx.store
    .page({ thread_id: 'trip', limit: 50 })
    .messages.filter((m) => m.author === 'system')
    .map((m) => m.text ?? '')
const tick = (x: Harness) => x.bridge.optionCTick()

/** A session with an error at the end of its transcript, the owner's message held, and the card made. */
async function withCard(opts: { lines?: string[]; message?: boolean; state?: string } = {}) {
  const { x, claude } = await start()
  writeWorkers(x, { state: opts.state ?? 'live' })
  putTranscript(claude, fresh(opts.lines ?? fixture('refusal')))
  if (opts.message !== false) seedOwnerMessage(x)
  tick(x)
  await eventually(() => expect(cardsOf(x)).toHaveLength(1))
  return { x, claude, card: cardsOf(x)[0] as CardT }
}

describe('the card', () => {
  test('a refusal: the words, Clear session first, Retry second, the owner’s own message line, the warning; one card however often it is looked at', async () => {
    const { x, card } = await withCard()
    tick(x)
    tick(x)
    await sleep(80) // timing-ok: negative window: a second card would have been made by now
    expect(cardsOf(x)).toHaveLength(1)
    expect(card.title).toBe(W.title('Trip', 'refusal'))
    expect(card.body).toBe(W.BODY.refusal('biology'))
    expect(card.body).toContain('safety filter stopped the last message (reason: biology)')
    expect(card.summary).toBe(W.SUMMARY)
    expect(card.primary_label).toBe(W.BUTTONS.clear)
    expect(card.kill_label).toBe(W.BUTTONS.retry)
    expect(card.warning).toBe(W.RETRY_WARNING)
    expect(card.fields.map((f) => f.value)).toEqual([OWNER_TEXT])
    expect(card.origin).toBe('background')
    expect(card.risk).toBe('low')
  })

  test('servers and rate limits: Retry first, Clear session second', async () => {
    const serverError = patched(
      fixture('auth-failed').at(-1) as string,
      (r) => void Object.assign(r, { error: 'server_error' }),
    )
    const { card } = await withCard({ lines: [...fixture('auth-failed').slice(0, 2), serverError] })
    expect(card.body).toBe(W.BODY.servers)
    expect(card.primary_label).toBe(W.BUTTONS.retry)
    expect(card.kill_label).toBe(W.BUTTONS.clear)
  })

  test('no message of the owner’s to send again: Clear session and Dismiss, no warning', async () => {
    const { card } = await withCard({ message: false })
    expect(card.primary_label).toBe(W.BUTTONS.clear)
    expect(card.kill_label).toBe(W.DISMISS_BUTTON)
    expect(card.warning ?? '').toBe('')
    expect(card.fields).toHaveLength(0)
  })

  test('the payload hash binds the session: another session’s card has another hash', async () => {
    const { x } = await withCard()
    const sc = x.bridge.ctx.sessionErrors
    const found = { kind: 'servers' as const, uuid: 'u1', at: Date.now() }
    await sc?.offer({ thread: 'trip', name: 'Trip', session: 'session-a', found })
    await sc?.offer({ thread: 'trip', name: 'Trip', session: 'session-b', found })
    const [a, b] = cardsOf(x).slice(-2) as [CardT, CardT]
    expect(a.payload_hash).not.toBe(b.payload_hash)
  })

  test('signed out: one plain line, no card', async () => {
    const { x, claude } = await start()
    writeWorkers(x)
    putTranscript(claude, fresh(fixture('auth-failed')))
    tick(x)
    await eventually(() => expect(systemRows(x)).toContain(W.AUTH_LINE()))
    expect(cardsOf(x)).toHaveLength(0)
  })

  test('the card cannot be shown: the plain words are posted, never silence', async () => {
    const { x, claude } = await start()
    writeWorkers(x)
    putTranscript(claude, fresh(fixture('refusal')))
    const tr = x.bridge.ctx.transport as unknown as { sendDurable: (f: { type: string }) => Promise<unknown> }
    const orig = tr.sendDurable.bind(tr)
    tr.sendDurable = async (f) => {
      if (f.type === 'card.create') throw new Error('no relay')
      return orig(f)
    }
    tick(x)
    await eventually(() => expect(systemRows(x)).toContain(W.plainLine('Trip', 'refusal', W.BODY.refusal('biology'))))
  })
})

describe('the taps', () => {
  test('Clear session (the owner’s signed tap): a fresh conversation is asked for, and the card says so', async () => {
    const { x, card } = await withCard()
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { ok: true, text: W.RESULT.cleared } })
  })

  test('Clear session while the session is busy: the plain reason, nothing started', async () => {
    const { x, card } = await withCard()
    writeWorkers(x, { state: 'busy' })
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    const u = update(x, card.id)
    expect(u?.state).toBe('failed')
    expect(u?.result?.text.startsWith('Talos could not do that: ')).toBe(true)
  })

  test('Retry: the owner’s last message goes once more, marked, and the card says so', async () => {
    const { x, card } = await withCard()
    await x.app.resolveCard(card, 'kill', card.payload_hash) // Retry is the second button on a refusal
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { ok: true, text: W.RESULT.retried } })
    const again = retryRow(x, card)
    expect(again?.notification.content).toBe(`${W.RETRY_REDELIVERED_PREFIX}\n${OWNER_TEXT}`)
    expect(again?.notification.meta.redelivered).toBe('retry')
  })

  test('Retry twice for one failed record: the second does nothing', async () => {
    const { x, card } = await withCard()
    const row = x.bridge.ctx.ledger.get(card.id)
    await x.bridge.ctx.sessionErrors?.onResolved(row as never, 'kill', 'card.resolve')
    await x.bridge.ctx.sessionErrors?.onResolved(row as never, 'kill', 'card.resolve')
    const second = x.relay.frames.filter(
      (f) =>
        f.direction === 'from_bridge' &&
        f.frame.type === 'card.update' &&
        f.frame.card_id === card.id &&
        f.frame.state === 'failed',
    )
    expect(second).toHaveLength(1)
    const only = second[0]?.frame as unknown as { result: { text: string } } | undefined
    expect(only?.result.text).toBe(W.RESULT.already)
  })

  test('a stale card (the thread has another session now): nothing is done', async () => {
    const { x, card } = await withCard()
    writeWorkers(x, { session_id: '11111111-2222-4333-8444-555555555555' })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'failed', result: { text: W.RESULT.stale } })
    expect(retryRow(x, card)).toBeUndefined()
  })

  test('the message is no longer held: Retry says so and sends nothing', async () => {
    const { x, card } = await withCard()
    x.bridge.ctx.store.db.query('DELETE FROM worker_routes WHERE message_id = ?').run(MSG)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'failed', result: { text: W.RESULT.gone } })
  })

  test('Retry while the session is busy: nothing is sent', async () => {
    const { x, card } = await withCard()
    writeWorkers(x, { state: 'busy' })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'failed', result: { text: W.RESULT.busy } })
    expect(retryRow(x, card)).toBeUndefined()
  })

  test('Dismiss leaves everything as it is', async () => {
    const { x, card } = await withCard({ message: false })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { text: W.RESULT.dismissed } })
  })

  test('an answer that did not come as the owner’s signed card.resolve does nothing', async () => {
    const { x, card } = await withCard()
    const row = x.bridge.ctx.ledger.get(card.id)
    await x.bridge.ctx.sessionErrors?.onResolved(row as never, 'primary', 'notification.action')
    expect(update(x, card.id)).toMatchObject({ state: 'failed', result: { text: W.RESULT.notFromHere } })
    expect(retryRow(x, card)).toBeUndefined()
  })
})

describe('the wording is in one place', () => {
  test('no sentence of the owner’s words is written in the watch or the card code', () => {
    for (const f of ['session-error-watch.ts', 'session-error-cards.ts']) {
      const src = readFileSync(join(import.meta.dir, '..', 'src', 'router', f), 'utf8')
      expect(src, f).not.toMatch(/safety filter|Started a fresh|Talos could not|servers had a problem|short pause/)
    }
  })
})

// ---- the reviewer's findings ------------------------------------------------------------------------------------------------

/** A good assistant record (a real model, not a synthetic error) at `at`, and a user record. */
const goodTurn = (at: number, uuid: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    isSidechain: false,
    timestamp: new Date(at).toISOString(),
    message: { model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
  })
const userRec = (at: number, uuid: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    isSidechain: false,
    timestamp: new Date(at).toISOString(),
    message: { role: 'user', content: 'x' },
  })
const errorAt = (at: number, uuid: string) => {
  const r = JSON.parse(fixture('refusal')[1] as string) as Record<string, unknown>
  r.uuid = uuid
  r.timestamp = new Date(at).toISOString()
  return JSON.stringify(r)
}

describe('Retry sends the right message, once per failed record, and reports what really happened', () => {
  test('two cards for one held message: the second Retry sends its own copy, and says so only because it did', async () => {
    const { x, claude, card: c1 } = await withCard()
    await x.app.resolveCard(c1, 'kill', c1.payload_hash)
    await eventually(() => expect(update(x, c1.id)).toBeDefined())
    expect(update(x, c1.id)?.result?.text).toBe(W.RESULT.retried)
    // the retried copy is read, its turn fails again: a second failure of the same message
    const path = transcriptPath(claude, '/home/alex/project', SESSION)
    const now = Date.now()
    appendFileSync(
      path,
      `${userRec(now, '00000000-0000-4000-8000-0000000000b2')}\n${errorAt(now + 1, '00000000-0000-4000-8000-0000000000a2')}\n`,
    )
    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    tick(x)
    await eventually(() => expect(cardsOf(x)).toHaveLength(2))
    const c2 = cardsOf(x)[1] as CardT
    expect(c2.fields.map((f) => f.value)).toEqual([OWNER_TEXT]) // the original message, not the marked copy
    await x.app.resolveCard(c2, 'kill', c2.payload_hash)
    await eventually(() => expect(update(x, c2.id)).toBeDefined())
    expect(update(x, c2.id)).toMatchObject({ state: 'done', result: { text: W.RESULT.retried } })
    expect(retryRow(x, c2)).toBeDefined()
    expect(recordOf(c2)).not.toBe(recordOf(c1))
  })

  test('a copy the router already holds (a duplicate id) is NOT reported as sent, and nothing goes to main', async () => {
    const { x, card } = await withCard()
    const store = x.bridge.router?.store
    store?.addRoute({
      message_id: `${MSG}~retry~${recordOf(card)}`,
      thread_id: 'trip',
      notification: {
        content: 'earlier copy',
        meta: { message_id: 'x', thread_id: 'trip', trust: 'owner', kind: 'text' },
      },
      woke_at: Date.now(),
      deadline_at: Date.now() + 600_000,
      cold: false,
    })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    const u = update(x, card.id)
    expect(u?.state).toBe('failed')
    expect(u?.result?.text).not.toBe(W.RESULT.retried)
    expect(u?.result?.text.startsWith('Talos could not do that: ')).toBe(true)
    expect(store?.claimedBy(`${MSG}~retry~${recordOf(card)}`)).toBeUndefined() // not handed to main
  })

  test('the newest thing handed to the thread was not an owner message (a card tap): no Retry, Clear session and Dismiss', async () => {
    const { x, claude } = await start()
    writeWorkers(x)
    putTranscript(claude, fresh(fixture('refusal')))
    seedOwnerMessage(x)
    x.bridge.router?.store.addRoute({
      message_id: 'm_card_tap',
      thread_id: 'trip',
      notification: {
        content: 'a card was answered',
        meta: { message_id: 'm_card_tap', thread_id: 'trip', trust: 'owner', kind: 'card_action' },
      },
      woke_at: Date.now() - 1_000,
      deadline_at: Date.now() + 600_000,
      cold: false,
    })
    tick(x)
    await eventually(() => expect(cardsOf(x)).toHaveLength(1))
    const card = cardsOf(x)[0] as CardT
    expect(card.primary_label).toBe(W.BUTTONS.clear)
    expect(card.kill_label).toBe(W.DISMISS_BUTTON)
    expect(card.fields).toHaveLength(0)
  })

  test('an old message the agent already answered is not offered; one sent after its last good answer is', async () => {
    const run = async (wokeAgoMs: number) => {
      const { x, claude } = await start()
      writeWorkers(x)
      const now = Date.now()
      putTranscript(claude, [
        userRec(now - 200_000, '00000000-0000-4000-8000-0000000000c1'),
        goodTurn(now - 60_000, '00000000-0000-4000-8000-0000000000c2'),
        errorAt(now, '00000000-0000-4000-8000-0000000000c3'),
      ])
      x.bridge.router?.store.addRoute({
        message_id: MSG,
        thread_id: 'trip',
        notification: {
          content: OWNER_TEXT,
          meta: { message_id: MSG, thread_id: 'trip', trust: 'owner', kind: 'text' },
        },
        woke_at: now - wokeAgoMs,
        deadline_at: now + 600_000,
        cold: false,
      })
      tick(x)
      await eventually(() => expect(cardsOf(x)).toHaveLength(1))
      const card = cardsOf(x)[0] as CardT
      await x.stop()
      h = undefined
      return card
    }
    const old = await run(120_000) // before the last good answer: that turn was answered
    expect(old.kill_label).toBe(W.DISMISS_BUTTON)
    const recent = await run(10_000) // after it: this is the turn that failed
    expect(recent.kill_label).toBe(W.BUTTONS.retry)
  })
})

describe('a card whose moment has passed does nothing', () => {
  test('a tap after a later good turn does nothing, for Retry and for Clear session', async () => {
    for (const button of ['primary', 'kill'] as const) {
      const { x, claude, card } = await withCard()
      const path = transcriptPath(claude, '/home/alex/project', SESSION)
      const now = Date.now()
      appendFileSync(
        path,
        `${userRec(now, '00000000-0000-4000-8000-0000000000d1')}\n${goodTurn(now + 1, '00000000-0000-4000-8000-0000000000d2')}\n`,
      )
      await x.app.resolveCard(card, button, card.payload_hash)
      await eventually(() => expect(update(x, card.id)).toBeDefined())
      expect(update(x, card.id)).toMatchObject({ state: 'failed', result: { text: W.RESULT.movedOn } })
      expect(retryRow(x, card)).toBeUndefined()
      await x.stop()
      h = undefined
    }
  })

  test('Dismiss still works after the thread moved on', async () => {
    const { x, claude, card } = await withCard({ message: false })
    const path = transcriptPath(claude, '/home/alex/project', SESSION)
    const now = Date.now()
    appendFileSync(
      path,
      `${userRec(now, '00000000-0000-4000-8000-0000000000f1')}\n${goodTurn(now + 1, '00000000-0000-4000-8000-0000000000f2')}\n`,
    )
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { text: W.RESULT.dismissed } })
  })

  test('card 1 is expired when card 2 appears for the same thread', async () => {
    const { x, claude, card: c1 } = await withCard()
    const path = transcriptPath(claude, '/home/alex/project', SESSION)
    const now = Date.now()
    appendFileSync(
      path,
      `${userRec(now, '00000000-0000-4000-8000-0000000000e1')}\n${errorAt(now + 1, '00000000-0000-4000-8000-0000000000e2')}\n`,
    )
    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    tick(x)
    await eventually(() => expect(cardsOf(x)).toHaveLength(2))
    await eventually(() => expect(x.bridge.ctx.ledger.get(c1.id)?.state).toBe('expired'))
    expect(x.bridge.ctx.ledger.get((cardsOf(x)[1] as CardT).id)?.state).toBe('pending')
  })
})

describe('only the app answers it', () => {
  test('an Approve tapped from a notification is refused, and the card stays pending', async () => {
    const { x, card } = await withCard()
    const dev = x.app.device
    const keys = await createPhoneKeys()
    const grant = await signNativeGrant({
      deviceId: dev.deviceId,
      devicePrivateKey: dev.privateKey,
      encPub: keys.encPub,
      actPub: keys.actPub,
      nowMs: Date.now(),
    })
    const id = newUlid()
    const now = Date.now()
    const frame = await signNativeAct({
      deviceId: dev.deviceId,
      id,
      ts: new Date(now).toISOString(),
      grant,
      body: {
        a: 'approve',
        shown_v: '3',
        card_id: card.id,
        payload_hash: card.payload_hash,
        shown: shownHash(cardNotice(card).text, 'General'),
      },
      actPrivateKey: keys.act.privateKey,
    })
    x.relay.sendToBridge({ ...frame, relay: { seq: 1, received_at: new Date(now).toISOString() } }, { durable: true })
    const err = await x.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })
    expect(err.code).toBe('open_in_app')
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    expect(update(x, card.id)).toBeUndefined()
  })
})

describe('a Retry the thread’s own session could not take sends nothing, and says why', () => {
  const NOT_RUNNING = `Talos could not do that: the thread's session isn't running right now.`
  const copyId = (card: CardT) => `${MSG}~retry~${recordOf(card)}`

  test('the session is stopping: nothing is sent (not to main either), and the words say so', async () => {
    const { x, card } = await withCard()
    writeWorkers(x, { state: 'stopping' })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'failed', result: { text: NOT_RUNNING } })
    expect(retryRow(x, card)).toBeUndefined()
    expect(x.bridge.router?.store.claimedBy(copyId(card))).toBeUndefined() // main was not given it
  })

  test('a cold start the usage governor blocks: the same', async () => {
    const { x, card } = await withCard()
    writeWorkers(x, { state: 'parked' })
    const router = x.bridge.router as unknown as { governor: () => unknown }
    router.governor = () => ({ state: 'paused' })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'failed', result: { text: NOT_RUNNING } })
    expect(x.bridge.router?.store.claimedBy(copyId(card))).toBeUndefined()
  })

  test('the thread stops being dedicated between the check and the real route: main got it, the card says so, and there is no second send', async () => {
    const { x, card } = await withCard()
    const router = x.bridge.router as unknown as { decide: (n: unknown) => unknown }
    const real = router.decide.bind(router)
    let first = true
    router.decide = (n) => {
      if (!first) return real(n)
      first = false // the check before sending says "the thread's own session" ...
      const t = x.bridge.ctx.config.config.threads.find((th) => th.id === 'trip')
      if (t) t.session = 'shared' as never // ... and the thread stops being its own before the real route decides again
      return { to: 'worker', thread: 'trip', cold: false }
    }
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { ok: true, text: W.RESULT.sentToMain } })
    expect(retryRow(x, card)).toBeUndefined()
    expect(x.bridge.ctx.store.kvGet(`session_error_retried:${recordOf(card)}`)).toBeDefined()
    // asked again, it does not send a second time
    const row = x.bridge.ctx.ledger.get(card.id)
    await x.bridge.ctx.sessionErrors?.onResolved(row as never, 'kill', 'card.resolve')
    expect(
      x.relay.frames
        .filter(
          (f) =>
            f.direction === 'from_bridge' &&
            f.frame.type === 'card.update' &&
            f.frame.card_id === card.id &&
            f.frame.state === 'failed',
        )
        .map((f) => (f.frame as unknown as { result: { text: string } }).result.text),
    ).toEqual([W.RESULT.already])
  })

  test('the thread is no longer dedicated: the same, and the retried key is not set (a later try is still possible)', async () => {
    const { x, card } = await withCard()
    x.bridge.ctx.config.config.threads.find((t) => t.id === 'trip')!.session = 'shared' as never
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)?.result?.text).toBe(NOT_RUNNING)
    expect(x.bridge.ctx.store.kvGet(`session_error_retried:${recordOf(card)}`)).toBeUndefined()
  })
})

describe('with no good answer in the part read, only a recent message of this session can be the failed one', () => {
  const offerWith = async (wokeAgoMs: number, started?: string) => {
    const { x, claude } = await start()
    writeWorkers(x, started ? { started_at: started } : {})
    putTranscript(claude, fresh(fixture('refusal'))) // no good assistant record anywhere in it
    seedOwnerMessage(x)
    x.bridge.ctx.store.db
      .query('UPDATE worker_routes SET woke_at = ? WHERE message_id = ?')
      .run(Date.now() - wokeAgoMs, MSG)
    tick(x)
    await eventually(() => expect(cardsOf(x)).toHaveLength(1))
    const card = cardsOf(x)[0] as CardT
    await x.stop()
    h = undefined
    return card
  }
  test('a message from hours ago is not offered; one from ten minutes ago is', async () => {
    expect((await offerWith(3 * 3600_000)).kill_label).toBe(W.DISMISS_BUTTON)
    expect((await offerWith(10 * 60_000)).kill_label).toBe(W.BUTTONS.retry)
  })
  test('a message from before this session started is not offered', async () => {
    const started = new Date(Date.now() - 5 * 60_000).toISOString()
    expect((await offerWith(30 * 60_000, started)).kill_label).toBe(W.DISMISS_BUTTON)
  })
})

describe('Retry for a message the session has NOT read yet sends one copy, not two', () => {
  const reads = (x: Harness) => readInbound(x.bridge.ctx, 'trip').messages

  test('an error before read_inbound, then Retry: read_inbound returns exactly ONE message, the marked copy; the original is never returned', async () => {
    const { x, card } = await withCard() // the owner's message is routed and unread (no claim)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { text: W.RESULT.retried } })
    const got = reads(x)
    expect(got).toHaveLength(1)
    expect(got[0]?.content).toBe(`${W.RETRY_REDELIVERED_PREFIX}
${OWNER_TEXT}`)
    expect(got[0]?.meta.message_id).toBe(`${MSG}~retry~${recordOf(card)}`)
    expect(reads(x)).toHaveLength(0) // nothing is left to read twice
    // the original is retired, not lost: main's deadline cannot take it either
    expect(x.bridge.router?.store.unclaimed('trip')).toHaveLength(0)
  })

  test('the original was ALREADY read: the copy is still sent (a real retry), and read_inbound returns just the copy', async () => {
    const { x, card } = await withCard()
    x.bridge.router?.store.claim(MSG, 'worker:trip', Date.now() - 60_000)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { text: W.RESULT.retried } })
    const got = reads(x)
    expect(got.map((m) => m.meta.message_id)).toEqual([`${MSG}~retry~${recordOf(card)}`])
  })

  test('the copy could not be queued (a duplicate id): the original is given back, still readable', async () => {
    const { x, card } = await withCard()
    x.bridge.router?.store.addRoute({
      message_id: `${MSG}~retry~${recordOf(card)}`,
      thread_id: 'trip',
      notification: {
        content: 'earlier copy',
        meta: { message_id: 'x', thread_id: 'trip', trust: 'owner', kind: 'text' },
      },
      woke_at: Date.now(),
      deadline_at: Date.now() + 600_000,
      cold: false,
    })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)?.state).toBe('failed')
    expect(reads(x).map((m) => m.meta.message_id)).toContain(MSG)
  })
})

describe('a card that did nothing says so in its headline words', () => {
  const frameResult = (x: Harness, id: string) =>
    x.relay.frames.find(
      (f) =>
        f.direction === 'from_bridge' &&
        f.frame.type === 'card.update' &&
        f.frame.card_id === id &&
        f.frame.state === 'failed',
    )?.frame as { result?: { ok: boolean; text: string; ran?: unknown } } | undefined

  test('a stale tap (the thread moved on): the card update says nothing ran, with the exact words, so the app shows them and not its generic failure line', async () => {
    const { x, claude, card } = await withCard()
    const path = transcriptPath(claude, '/home/alex/project', SESSION)
    const now = Date.now()
    appendFileSync(
      path,
      `${userRec(now, '00000000-0000-4000-8000-0000000000d1')}
${goodTurn(now + 1, '00000000-0000-4000-8000-0000000000d2')}
`,
    )
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    await eventually(() => expect(frameResult(x, card.id)).toBeDefined())
    expect(frameResult(x, card.id)?.result).toMatchObject({
      ok: false,
      text: 'This has moved on; nothing was done.',
      ran: false,
    })
  })

  test('the same for a different session, a busy session, a session that is not running, and a message no longer held', async () => {
    const { x, card } = await withCard()
    writeWorkers(x, { session_id: '11111111-2222-4333-8444-555555555555' })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(frameResult(x, card.id)).toBeDefined())
    expect(frameResult(x, card.id)?.result).toMatchObject({ ok: false, text: W.RESULT.stale, ran: false })
    const b = await withCard()
    writeWorkers(b.x, { state: 'busy' })
    await b.x.app.resolveCard(b.card, 'kill', b.card.payload_hash)
    await eventually(() => expect(frameResult(b.x, b.card.id)).toBeDefined())
    expect(frameResult(b.x, b.card.id)?.result).toMatchObject({ ok: false, text: W.RESULT.busy, ran: false })
  })
})

describe('Retry survives a crash, a throw after queueing, and a main that already answered', () => {
  const reads = (x: Harness) => readInbound(x.bridge.ctx, 'trip').messages
  const copyIdOf = (card: CardT) => `${MSG}~retry~${recordOf(card)}`
  const failedFrame = (x: Harness, id: string) =>
    x.relay.frames.find(
      (f) =>
        f.direction === 'from_bridge' &&
        f.frame.type === 'card.update' &&
        f.frame.card_id === id &&
        f.frame.state === 'failed',
    )?.frame as { result?: { text: string; ran?: unknown } } | undefined

  test('a crash before the copy was queued (the route never got to addRoute): the original is NOT retired and can still be read; a later tap works', async () => {
    const { x, card } = await withCard()
    const router = x.bridge.router as unknown as { route: (n: unknown, s?: string) => Promise<void> }
    const real = router.route.bind(router)
    router.route = async () => {
      throw new Error('crash in the gap')
    }
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(failedFrame(x, card.id)).toBeDefined())
    expect(x.bridge.router?.store.claimedBy(MSG)).toBeUndefined() // not retired: no copy, so nothing is lost
    expect(x.bridge.ctx.store.kvGet(`session_error_retrying:${recordOf(card)}`)).toBeUndefined()
    router.route = real
    expect(reads(x).map((m) => m.meta.message_id)).toEqual([MSG])
  })

  test('a claim key left by a crash with NO copy queued does not say "already sent": the retry goes through', async () => {
    const { x, card } = await withCard()
    x.bridge.ctx.store.kvSet(`session_error_retrying:${recordOf(card)}`, String(Date.now() - 60_000)) // what a crash mid-retry leaves
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { text: W.RESULT.retried } })
    expect(reads(x).map((m) => m.meta.message_id)).toEqual([copyIdOf(card)])
  })

  test('the router throws AFTER the copy was queued: the copy is held, the original stays retired (no duplicate), and the card says it was sent', async () => {
    const { x, card } = await withCard()
    const router = x.bridge.router as unknown as { route: (n: unknown, s?: string) => Promise<void> }
    const real = router.route.bind(router)
    router.route = async (n, s) => {
      await real(n, s)
      throw new Error('after queueing')
    }
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    expect(update(x, card.id)).toMatchObject({ state: 'done', result: { text: W.RESULT.retried } })
    expect(reads(x).map((m) => m.meta.message_id)).toEqual([copyIdOf(card)]) // exactly one
  })

  test('the original was already taken by main (its deadline passed): nothing is sent, and the card says so with ran false', async () => {
    const { x, card } = await withCard()
    x.bridge.router?.store.claim(MSG, 'main', Date.now() - 600_000)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(failedFrame(x, card.id)).toBeDefined())
    expect(failedFrame(x, card.id)?.result).toMatchObject({ text: 'The main session already answered it.', ran: false })
    expect(x.bridge.router?.store.route(copyIdOf(card))).toBeUndefined()
  })

  test('main takes the original WHILE route() waits, before the copy is queued: no copy is queued (it would be answered twice), and the card says so', async () => {
    const { x, card } = await withCard()
    const store = x.bridge.router?.store as unknown as {
      addRoute: (r: unknown, s?: string) => boolean
      claim: (id: string, by: string, at: number) => boolean
    }
    const real = store.addRoute.bind(store)
    store.addRoute = (r, s) => {
      store.claim(MSG, 'main', Date.now()) // the deadline fires during the awaits, right before the insert
      return real(r, s)
    }
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(failedFrame(x, card.id)).toBeDefined())
    expect(failedFrame(x, card.id)?.result).toMatchObject({ text: 'The main session already answered it.', ran: false })
    expect(x.bridge.router?.store.route(copyIdOf(card))).toBeUndefined()
    expect(reads(x).map((m) => m.meta.message_id)).not.toContain(copyIdOf(card))
    expect(x.bridge.ctx.store.kvGet(`session_error_retried:${recordOf(card)}`)).toBeUndefined()
  })

  test('main takes the original during the first await of route(): the copy is not handed to main either', async () => {
    const { x, card } = await withCard()
    const router = x.bridge.router as unknown as { route: (n: unknown, s?: string) => Promise<void> }
    const real = router.route.bind(router)
    router.route = async (n, s) => {
      x.bridge.router?.store.claim(MSG, 'main', Date.now())
      return real(n, s)
    }
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(failedFrame(x, card.id)).toBeDefined())
    expect(failedFrame(x, card.id)?.result).toMatchObject({ text: 'The main session already answered it.', ran: false })
    expect(x.bridge.router?.store.claimedBy(copyIdOf(card))).toBeUndefined()
  })

  test('a claim key left by a crash whose copy went to MAIN (no route row): a second tap says "already sent" and sends no second copy', async () => {
    const { x, card } = await withCard()
    x.bridge.ctx.store.kvSet(`session_error_retrying:${recordOf(card)}`, String(Date.now() - 60_000))
    x.bridge.router?.store.claim(copyIdOf(card), 'main', Date.now() - 30_000)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(failedFrame(x, card.id)).toBeDefined())
    expect(failedFrame(x, card.id)?.result).toMatchObject({ text: W.RESULT.already, ran: false })
    expect(x.bridge.router?.store.route(copyIdOf(card))).toBeUndefined()
  })

  test('the "seen" receipt for a retried copy is for the owner’s ORIGINAL message id, the one the phone knows', async () => {
    const { x, card } = await withCard()
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(update(x, card.id)).toBeDefined())
    reads(x)
    await sleep(80) // timing-ok: the receipt is ephemeral and goes out with the read
    const sent = JSON.stringify(x.relay.frames.filter((f) => f.direction === 'from_bridge').map((f) => f.frame))
    expect(sent).not.toContain('~retry~')
  })

  test('ran false on the other do-nothing outcomes: not running, no longer held, already sent, a tap from a notification', async () => {
    const a = await withCard()
    writeWorkers(a.x, { state: 'stopping' })
    await a.x.app.resolveCard(a.card, 'kill', a.card.payload_hash)
    await eventually(() => expect(failedFrame(a.x, a.card.id)).toBeDefined())
    expect(failedFrame(a.x, a.card.id)?.result).toMatchObject({ ran: false })
    const b = await withCard()
    b.x.bridge.ctx.store.db.query('DELETE FROM worker_routes WHERE message_id = ?').run(MSG)
    await b.x.app.resolveCard(b.card, 'kill', b.card.payload_hash)
    await eventually(() => expect(failedFrame(b.x, b.card.id)).toBeDefined())
    expect(failedFrame(b.x, b.card.id)?.result).toMatchObject({ text: W.RESULT.gone, ran: false })
    const c = await withCard()
    c.x.bridge.ctx.store.kvSet(`session_error_retried:${recordOf(c.card)}`, String(Date.now()))
    await c.x.app.resolveCard(c.card, 'kill', c.card.payload_hash)
    await eventually(() => expect(failedFrame(c.x, c.card.id)).toBeDefined())
    expect(failedFrame(c.x, c.card.id)?.result).toMatchObject({ text: W.RESULT.already, ran: false })
    const d = await withCard()
    const row = d.x.bridge.ctx.ledger.get(d.card.id)
    await d.x.bridge.ctx.sessionErrors?.onResolved(row as never, 'primary', 'notification.action')
    expect(failedFrame(d.x, d.card.id)?.result).toMatchObject({ text: W.RESULT.notFromHere, ran: false })
  })
})

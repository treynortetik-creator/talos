// Needs-you prompts, bridge side (docs/OPTION-C.md "Needs-you prompts"). A thread session shows a known dialog; the Mac records
// it in workers.json; the bridge makes a card, the owner taps, the bridge writes the answer file for the Mac, the Mac reports
// what it did. Real bridge + FakeRelay + a signing FakeApp; the Mac is played by the test writing the files it writes.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  type CardT,
  DIALOG_ANSWER_MAX_BYTES,
  DIALOG_CARD_ANSWERED_EVENT,
  DIALOG_CARD_POSTED_EVENT,
  DIALOG_RESULT_WAIT_MS,
  DialogAnswer,
  DialogCardFile,
  dialogFallbackLine,
  dialogNothingPressedText,
  dialogOf,
  eventInfo,
  NEEDS_YOU_FEATURE,
  ownerSignedString,
  sha256Hex,
  verifyDialogAnswer,
  type WorkerDialogT,
} from '@talos-app/protocol'
import { fakeClock, mkFrame, t } from '@talos-app/testkit'
import { DialogCards, REOFFER_GRACE_MS } from '../src/dialog-card.ts'
import { advanceSteps, type Harness, pushCardResolvePastRelay, sleep, startHarness, waitFor } from './helpers.ts'

// the waits of one test (the harness, ticks, answers) add up past bun's 5 s default
setDefaultTimeout(t(30_000))

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const TRIP_ID = 'k3Xv9QpT2mLw8ZrNa5HdBe'
const MCP_ID = 'Zt7Rm2QxW9cKpL4vNaH8dB'
const LOGIN_ID = 'Hc4Pq9ZtLm2Xw7RvNa5KdB'
const FLAGGED = { relayFeatures: ['schedules/1', 'thread-sessions/1', NEEDS_YOU_FEATURE] }
type Upd = {
  state: string
  result: { ok: boolean; text: string; ran?: unknown }
  resolution: { action: string; by?: string }
}
const iso = (ms: number) => new Date(ms).toISOString()
const thread = (id: string, name: string) => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
})

async function start(opts: { relay?: { relayFeatures: string[] }; clock?: ReturnType<typeof fakeClock> } = {}) {
  h = await startHarness({
    relay: opts.relay ?? FLAGGED,
    ...(opts.clock ? { clock: opts.clock } : {}),
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', 'Trip'), thread('garden', 'Garden')],
      dedicated: { enabled: true },
    })) as never,
  })
  return h
}

const now = (x: Harness) => x.bridge.ctx.clock.now()
const trust = (x: Harness, over: Partial<WorkerDialogT> = {}): WorkerDialogT => ({
  id: TRIP_ID,
  kind: 'trust',
  subject: '~/Documents/x',
  options: ['No, exit', 'Yes, I trust this folder'],
  cursor: 1,
  seen_at: iso(now(x)),
  expires_at: iso(now(x) + 900_000),
  ...over,
})
const mcp = (x: Harness, over: Partial<WorkerDialogT> = {}): WorkerDialogT =>
  trust(x, {
    id: MCP_ID,
    kind: 'mcp_consent',
    subject: 'github',
    options: [
      'Use this and all future MCP servers in this project',
      'Use this MCP server',
      'Continue without using this MCP server',
    ],
    ...over,
  })
const login = (x: Harness): WorkerDialogT =>
  trust(x, { id: LOGIN_ID, kind: 'login', subject: null, options: [], cursor: null })

/** workers.json the way the desktop supervisor writes it. */
function writeWorkers(x: Harness, dialogs: Record<string, unknown>, opts: { stale?: boolean } = {}) {
  const t: Record<string, unknown> = {}
  for (const id of ['trip', 'garden'])
    t[id] = {
      state: 'live',
      session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
      tmux: `t-${id}`,
      pane_pid: 0,
      cwd: x.home,
      error: null,
      ...(dialogs[id] === undefined ? {} : { dialog: dialogs[id] }),
    }
  writeFileSync(
    join(x.home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: {
        pid: 1,
        heartbeat_at: iso(opts.stale ? now(x) - 60_000 : now(x)),
        workers_supported: true,
      },
      threads: t,
    }),
  )
}
const file = (x: Harness, id: string, name: string) => join(x.home, 'workers', id, name)
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
/** The card file the Mac reads: written after the card is sent, so a test waits for it rather than reading it at once. */
async function cardFile(x: Harness, want: Record<string, unknown>, thread = 'trip') {
  const path = file(x, thread, 'dialog-card.json')
  const says = () => {
    try {
      const j = readJson(path)
      return Object.entries(want).every(([k, v]) => j[k] === v)
    } catch {
      return false
    }
  }
  await waitFor(says, 4000, `the card file to say ${JSON.stringify(want)}`)
  return readJson(path)
}
function writeMacFile(x: Harness, id: string, name: string, body: unknown) {
  mkdirSync(join(x.home, 'workers', id), { recursive: true })
  writeFileSync(file(x, id, name), JSON.stringify(body))
}

const fromBridge = (x: Harness, type: string) =>
  x.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === type).map((r) => r.raw)
const dialogCards = (x: Harness) =>
  fromBridge(x, 'card.create')
    .map((r) => r.card as CardT)
    .filter((c) => c.kind === 'dialog')
const updates = (x: Harness, id: string) => fromBridge(x, 'card.update').filter((r) => r.card_id === id)
const lastUpdate = (x: Harness, id: string) => updates(x, id).at(-1) as Upd | undefined
const errors = (x: Harness) => fromBridge(x, 'error')
const notices = (x: Harness) =>
  fromBridge(x, 'reply')
    .map((r) => r.message as { text: string; author: string })
    .filter((m) => m.author === 'system')

/** Writes workers.json with `d` on `trip`, ticks the bridge, and waits for the card. */
async function show(x: Harness, d: WorkerDialogT) {
  writeWorkers(x, { trip: d })
  x.bridge.optionCTick()
  await waitFor(() => dialogCards(x).some((c) => dialogOf(c)?.dialog_id === d.id), 4000, 'the dialog card')
  return dialogCards(x).find((c) => dialogOf(c)?.dialog_id === d.id) as CardT
}
const tap = (x: Harness, card: CardT, choice?: number) =>
  x.app.resolveCard(card, 'primary', card.payload_hash, choice === undefined ? {} : { choice })
const answerOf = (x: Harness) => readJson(file(x, 'trip', 'dialog-answer.json'))

const logLines: Array<{ fields?: Record<string, unknown> }> = []
const recLogger = () => {
  const rec = (_msg: string, fields?: Record<string, unknown>) => void logLines.push(fields ? { fields } : {})
  return { debug: rec, info: rec, warn: rec, error: rec, security: rec }
}

describe('making the card', () => {
  test('a new dialog becomes one card, and the Mac is told with the card file', async () => {
    await start()
    const card = await show(h as Harness, trust(h as Harness))
    const x = h as Harness
    expect(card.kind).toBe('dialog')
    expect(card.thread_id).toBe('trip')
    expect(card.title).toBe('Trust this folder?')
    expect(dialogOf(card)).toMatchObject({
      dialog_id: TRIP_ID,
      dialog_kind: 'trust',
      subject: '~/Documents/x',
      options: ['No, exit', 'Yes, I trust this folder'],
    })
    const ack = DialogCardFile.parse(await cardFile(x, { dialog_id: TRIP_ID }))
    expect(ack).toMatchObject({ dialog_id: TRIP_ID, card_id: card.id, status: 'waiting' })
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    expect(x.bridge.ctx.ledger.get(card.id)?.actor).toBe('bridge')
  })

  test('the same dialog id is never carded twice, however often the file is read', async () => {
    await start()
    const x = h as Harness
    await show(x, trust(x))
    for (let i = 0; i < 4; i++) {
      writeWorkers(x, { trip: trust(x) })
      x.bridge.optionCTick()
    }
    // timing-ok: negative window: still exactly one dialog card after the repeated ticks
    await sleep(200)
    expect(dialogCards(x)).toHaveLength(1)
  })

  test('not twice after a restart either (the record is in the history, not in memory)', async () => {
    await start()
    const x = h as Harness
    await show(x, trust(x))
    const again = new DialogCards(x.bridge.ctx)
    again.setRelayFeatures(FLAGGED.relayFeatures)
    writeWorkers(x, { trip: trust(x) })
    again.tick()
    // timing-ok: negative window: still exactly one dialog card after the other bridge's tick
    await sleep(200)
    again.stop()
    expect(dialogCards(x)).toHaveLength(1)
  })

  test('MCP consent keeps all three options; login has none', async () => {
    await start()
    const x = h as Harness
    const m = await show(x, mcp(x))
    expect(dialogOf(m)?.options).toHaveLength(3)
    const l = await show(x, login(x))
    expect(dialogOf(l)?.options).toEqual([])
    expect(l.title).toBe('Trip needs you to sign in')
  })

  test('a relay without needs-you/1 gets no card and the Mac gets no card file (it keeps posting its own line)', async () => {
    await start({ relay: { relayFeatures: ['schedules/1', 'thread-sessions/1'] } })
    const x = h as Harness
    writeWorkers(x, { trip: trust(x) })
    x.bridge.optionCTick()
    // timing-ok: negative window: no dialog card appears
    await sleep(300)
    expect(dialogCards(x)).toHaveLength(0)
    expect(existsSync(file(x, 'trip', 'dialog-card.json'))).toBe(false)
    expect(x.bridge.ctx.ledger.list().filter((r) => r.binding.kind === 'dialog')).toHaveLength(0)
  })

  test('a dialog that is not one of the three, or does not fit, is no card at all', async () => {
    await start()
    const x = h as Harness
    writeWorkers(x, {
      trip: { ...trust(x), kind: 'bypass_disclaimer' },
      garden: { ...trust(x), id: 'Gq5Lm8ZtRx3Cv9PkNa2HdB', options: Array.from({ length: 7 }, (_, i) => `o${i}`) },
    })
    x.bridge.optionCTick()
    // timing-ok: negative window: no dialog card appears
    await sleep(300)
    expect(dialogCards(x)).toHaveLength(0)
    expect(existsSync(file(x, 'trip', 'dialog-card.json'))).toBe(false)
  })

  test('no card from a supervisor that stopped beating, or for a dialog already past its time', async () => {
    await start()
    const x = h as Harness
    writeWorkers(x, { trip: trust(x) }, { stale: true })
    x.bridge.optionCTick()
    writeWorkers(x, { garden: trust(x, { id: 'Oq5Lm8ZtRx3Cv9PkNa2HdB', expires_at: iso(now(x) - 1000) }) })
    x.bridge.optionCTick()
    // timing-ok: negative window: no dialog card appears
    await sleep(300)
    expect(dialogCards(x)).toHaveLength(0)
  })

  test('a thread the config does not know gets no card', async () => {
    await start()
    const x = h as Harness
    writeWorkers(x, {})
    const w = JSON.parse(readFileSync(join(x.home, 'workers.json'), 'utf8'))
    w.threads.ghost = { ...w.threads.trip, tmux: 't-ghost', dialog: trust(x, { id: 'Pq5Lm8ZtRx3Cv9PkNa2HdB' }) }
    writeFileSync(join(x.home, 'workers.json'), JSON.stringify(w))
    x.bridge.optionCTick()
    // timing-ok: negative window: no dialog card appears
    await sleep(300)
    expect(dialogCards(x)).toHaveLength(0)
  })

  test('a dialog that is gone and a new one that takes its place: one card closed, one made', async () => {
    await start()
    const x = h as Harness
    const first = await show(x, trust(x))
    const second = await show(x, mcp(x))
    await waitFor(() => lastUpdate(x, first.id)?.state === 'superseded', 4000, 'the first card closed')
    expect(dialogCards(x)).toHaveLength(2)
    expect(x.bridge.ctx.ledger.get(second.id)?.state).toBe('pending')
  })
})

describe('the owner taps', () => {
  test('a tap writes the answer file for the Mac and says who answered', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    const a = DialogAnswer.parse(answerOf(x))
    expect(a).toMatchObject({
      dialog_id: TRIP_ID,
      choice: 1,
      label: 'Yes, I trust this folder',
      by: 'Test device',
    })
    expect(a.control_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    await waitFor(() => lastUpdate(x, card.id)?.state === 'resolved', 4000, 'card.update resolved')
    expect(lastUpdate(x, card.id)?.resolution).toMatchObject({ action: 'primary', by: 'Test device' })
    await cardFile(x, { status: 'answered', by: 'Test device', label: 'Yes, I trust this folder' })
    // the agent is never told: this is the bridge's card
    expect(x.notes.filter((n) => n.meta.kind === 'card_action')).toHaveLength(0)
  })

  test('the first answer wins: a second tap is card_not_pending and writes no second answer', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    const first = answerOf(x)
    const second = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 0 })
    await waitFor(() => errors(x).some((e) => e.ref === second.id), 4000, 'the refusal')
    expect(errors(x).find((e) => e.ref === second.id)?.code).toBe('card_not_pending')
    expect(answerOf(x)).toEqual(first)
    expect(answerOf(x).choice).toBe(1)
  })

  test('two taps at once still write one answer', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    const [a, b] = await Promise.all([
      pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 0 }),
      pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 1 }),
    ])
    await waitFor(() => errors(x).some((e) => e.ref === a.id || e.ref === b.id), 4000, 'one refusal')
    const refused = errors(x).filter((e) => e.ref === a.id || e.ref === b.id)
    expect(refused).toHaveLength(1)
    expect(refused[0]?.code).toBe('card_not_pending')
    expect(DialogAnswer.safeParse(answerOf(x)).success).toBe(true)
  })

  test('a choice outside the options, no choice on a trust card, kill and revise all write nothing and leave the card waiting', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    const sent = [
      await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 2 }),
      await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary'),
      await pushCardResolvePastRelay(x, card, card.payload_hash, 'kill', { choice: 0 }),
      await pushCardResolvePastRelay(x, card, card.payload_hash, 'revise', { note: 'x' }),
    ]
    await waitFor(() => sent.every((f) => errors(x).some((e) => e.ref === f.id)), 4000, 'four refusals')
    for (const f of sent) expect(errors(x).find((e) => e.ref === f.id)?.code).toBe('bad_frame')
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
  })

  test('a tap on a card whose dialog has changed is refused, closes the card, and writes nothing', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    writeWorkers(x, { trip: trust(x, { id: 'Rq5Lm8ZtRx3Cv9PkNa2HdB' }) }) // replaced, bridge has not ticked yet
    const f = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 1 })
    await waitFor(() => errors(x).some((e) => e.ref === f.id), 4000, 'the refusal')
    expect(errors(x).find((e) => e.ref === f.id)?.code).toBe('card_not_pending')
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
    await waitFor(() => lastUpdate(x, card.id)?.state === 'superseded', 4000, 'the card closed')
  })

  test('a card the owner changed in transit (wrong hash) is refused', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    const f = await pushCardResolvePastRelay(x, card, `sha256:${'a'.repeat(64)}`, 'primary', { choice: 1 })
    await waitFor(() => errors(x).some((e) => e.ref === f.id), 4000, 'the refusal')
    expect(errors(x).find((e) => e.ref === f.id)?.code).toBe('card_hash_mismatch')
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
  })

  test('login: the one button writes an open action, and a choice with it is refused', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, login(x))
    const bad = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 0 })
    await waitFor(() => errors(x).some((e) => e.ref === bad.id), 4000, 'refusal')
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
    await tap(x, card)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    expect(DialogAnswer.parse(answerOf(x))).toMatchObject({
      dialog_id: LOGIN_ID,
      action: 'open',
      label: 'Open on the Mac',
    })
  })
})

describe('a stop between the tap and the answer file', () => {
  test('an answer the ledger took but the Mac never got ends the card failed, with nothing pressed', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    // the ledger has the answer; the bridge stopped before it wrote the file
    const won = x.bridge.ctx.ledger.resolve(
      { card_id: card.id, action: 'primary', payload_hash: card.payload_hash, ts: iso(now(x)) },
      now(x),
      { by: 'Test device' },
    )
    expect(won.ok).toBe(true)
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({ ok: false, ran: false })
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
  })
})

describe('the restart sweep of the schedule service', () => {
  test(
    'a dialog card that was tapped and waits for the Mac is not failed by a sweep that runs late',
    async () => {
      await start()
      const x = h as Harness
      const card = await show(x, trust(x))
      await tap(x, card, 1)
      await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
      await waitFor(() => lastUpdate(x, card.id)?.state === 'resolved', 4000, 'card.update resolved')
      // start() runs this sweep after its first awaits, so on a slow machine it can land after a tap; here it is run by hand, after
      await (x.bridge.ctx.schedules as unknown as { failStuckCards(): Promise<void> }).failStuckCards()
      expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('resolved')
      expect(lastUpdate(x, card.id)?.state).toBe('resolved')
      // and the card still ends the way the Mac reports
      writeMacFile(x, 'trip', 'dialog-result.json', {
        v: 1,
        dialog_id: TRIP_ID,
        control_id: answerOf(x).control_id,
        source: 'card',
        outcome: 'pressed',
        choice: 1,
        label: 'Yes, I trust this folder',
        at: iso(now(x)),
      })
      x.bridge.optionCTick()
      await waitFor(() => lastUpdate(x, card.id)?.state === 'done', 4000, 'done')
    },
    t(60_000),
  )
})

describe('what the Mac reports', () => {
  async function answered(x: Harness, d: WorkerDialogT, choice?: number) {
    const card = await show(x, d)
    await tap(x, card, choice)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    return { card, a: DialogAnswer.parse(answerOf(x)) }
  }
  type Rep = {
    outcome?: string
    choice?: number
    label?: string
    reason?: string
    at?: string
    source?: string
    control_id?: string
    dialog_id?: string
  }
  const report = (x: Harness, a: { dialog_id: string; control_id: string }, rep: Rep) =>
    writeMacFile(x, 'trip', 'dialog-result.json', {
      v: 1,
      dialog_id: rep.dialog_id ?? a.dialog_id,
      control_id: rep.control_id ?? a.control_id,
      source: rep.source ?? 'card',
      outcome: rep.outcome ?? 'pressed',
      ...(rep.choice === undefined ? {} : { choice: rep.choice }),
      ...(rep.label === undefined ? {} : { label: rep.label }),
      ...(rep.reason === undefined ? {} : { reason: rep.reason }),
      at: rep.at ?? iso(now(x)),
    })
  const YES = { outcome: 'pressed', choice: 1, label: 'Yes, I trust this folder' }

  test('pressed: the card is done and reads "Answered on <device>"', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    report(x, a, YES)
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'done', 4000, 'done')
    const u = lastUpdate(x, card.id) as Upd
    expect(u.result).toMatchObject({ ok: true, text: 'Trusted ~/Documents/x', ran: true })
    expect(u.resolution.by).toBe('Test device')
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('done')
    expect(existsSync(file(x, 'trip', 'dialog-result.json'))).toBe(false)
  })

  test('pressed on an option with no past tense: the plain label', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, mcp(x), 1)
    report(x, a, { outcome: 'pressed', choice: 1, label: 'Use this MCP server' })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'done', 4000, 'done')
    expect((lastUpdate(x, card.id) as Upd).result.text).toBe('Use this MCP server')
  })

  test('hidden characters in the folder are shown as markers in the result, and a label cannot print a marker', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x, { subject: '~/a\u202eb\u27e6' }), 1)
    report(x, a, YES)
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'done', 4000, 'done')
    expect((lastUpdate(x, card.id) as Upd).result.text).toBe('Trusted ~/a⟦U+202E⟧b⟦U+27E6⟧')
  })

  test('nothing pressed: the card fails with the "Nothing pressed" words and says nothing ran', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    report(x, a, { outcome: 'nothing_pressed' })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({
      ok: false,
      ran: false,
      text: dialogNothingPressedText('Trip'),
    })
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('failed')
  })

  test('unverified: the card says "Answer on the Mac" and that nothing ran', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    report(x, a, { outcome: 'nothing_pressed', reason: 'unverified' })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({ ok: false, ran: false, text: 'Answer on the Mac' })
  })

  test('already answered at the Mac first: the card says so and that this answer ran nothing', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    report(x, a, { outcome: 'nothing_pressed', reason: 'already_answered' })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({
      ok: false,
      ran: false,
      text: 'Already answered at the Mac first.',
    })
  })

  test('opened: the login card is done', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, login(x))
    report(x, a, { outcome: 'opened' })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'done', 4000, 'done')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({ ok: true, text: 'Opened on the Mac' })
  })

  test('a report that says it pressed something other than what was answered claims nothing', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    report(x, a, { outcome: 'pressed', choice: 0, label: 'No, exit' })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({
      ok: false,
      ran: 'unknown',
      text: 'Your Mac reported pressing something different. Check the session in Terminals.',
    })
  })

  test('a "pressed" with the right index but another label is the same', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    report(x, a, { outcome: 'pressed', choice: 1, label: 'Something else' })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed')
    expect((lastUpdate(x, card.id) as Upd).result.ran).toBe('unknown')
  })

  test('a result for another answer, another dialog, an old time or a future time is ignored', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    for (const rep of [
      { ...YES, control_id: 'someone_else' },
      { ...YES, dialog_id: 'Sq5Lm8ZtRx3Cv9PkNa2HdB' },
      { ...YES, at: iso(now(x) - 3_600_000) },
      { ...YES, at: iso(now(x) + 3_600_000) },
    ]) {
      report(x, a, rep)
      x.bridge.optionCTick()
      // timing-ok: negative window: the card stays resolved after a further report
      await sleep(120)
      expect(lastUpdate(x, card.id)?.state).toBe('resolved')
    }
  })

  test('a result that is not a strict result is ignored (an extra key)', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    writeMacFile(x, 'trip', 'dialog-result.json', {
      v: 1,
      dialog_id: a.dialog_id,
      control_id: a.control_id,
      source: 'card',
      ...YES,
      at: iso(now(x)),
      extra: 1,
    })
    x.bridge.optionCTick()
    // timing-ok: negative window: the card stays resolved after a further report
    await sleep(150)
    expect(lastUpdate(x, card.id)?.state).toBe('resolved')
  })

  test('the dialog going away after an answer is the key press: the card waits for the report, not closed', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    writeWorkers(x, {})
    x.bridge.optionCTick()
    // timing-ok: negative window: the card stays resolved after the dialog is gone
    await sleep(200)
    expect(lastUpdate(x, card.id)?.state).toBe('resolved')
    report(x, a, YES)
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'done', 4000, 'done')
  })

  test('no report in a minute: the card ends unconfirmed and the answer is taken back', async () => {
    const clock = fakeClock(new Date().toISOString())
    await start({ clock })
    const x = h as Harness
    const card = await show(x, trust(x))
    await tap(x, card, 1)
    // the inbound settle window runs on the injected clock, so it is nudged until the answer is written
    for (let i = 0; i < 200 && !existsSync(file(x, 'trip', 'dialog-answer.json')); i++) {
      clock.advance(50)
      await sleep(20)
    }
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(true)
    await advanceSteps(clock, DIALOG_RESULT_WAIT_MS - 10_000, 5_000)
    expect(lastUpdate(x, card.id)?.state).toBe('resolved')
    await advanceSteps(clock, 10_000, 5_000)
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'unconfirmed')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({ ok: false, ran: 'unknown' })
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
  })
})

describe("the answer carries the owner's proof", () => {
  test("a Mac that checks it as the contract says accepts it, and the pieces are the owner's own frame", async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    const sent = await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    const a = DialogAnswer.parse(answerOf(x))
    expect(a.v).toBe(2)
    expect(a.proof.device_id).toBe(x.app.device.deviceId)
    expect(a.proof.osig).toBe(sent.osig as string)
    expect(a.proof.signed).toBe(ownerSignedString(sent as Record<string, unknown>))
    expect(`sha256:${sha256Hex(a.proof.binding)}`).toBe(card.payload_hash)
    const v = await verifyDialogAnswer(answerOf(x), {
      pinnedKey: (id) => x.pinned[id],
      nowMs: Date.now(),
      thread: 'trip',
      pane: { dialog_id: TRIP_ID, dialog_kind: 'trust', subject: '~/Documents/x', options: trust(x).options },
      screenLabel: (i) => trust(x).options[i],
    })
    expect(v).toMatchObject({ ok: true, choice: 1 })
    // a Mac that saw another folder refuses the same file
    const other = await verifyDialogAnswer(answerOf(x), {
      pinnedKey: (id) => x.pinned[id],
      nowMs: Date.now(),
      thread: 'trip',
      pane: { dialog_id: TRIP_ID, dialog_kind: 'trust', subject: '~/notes', options: trust(x).options },
    })
    expect(other).toMatchObject({ ok: false, step: 4 })
  })

  test('the file fits the answer cap even with six long options and a long folder', async () => {
    await start()
    const x = h as Harness
    const options = Array.from({ length: 6 }, (_, i) => `${i}${'é'.repeat(119)}`)
    const card = await show(x, trust(x, { options, subject: `~/${'x'.repeat(480)}`, cursor: 0 }))
    await tap(x, card, 5)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    expect(statSync(file(x, 'trip', 'dialog-answer.json')).size).toBeLessThanOrEqual(DIALOG_ANSWER_MAX_BYTES)
  })

  test('the record says "answering" with the answer\'s id before anyone could see the file', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    const rec = JSON.parse(x.bridge.ctx.store.kvGet(`dlg:${TRIP_ID}`) as string)
    expect(rec).toMatchObject({ phase: 'answering', control_id: answerOf(x).control_id, choice: 1 })
  })

  test('an answer that cannot be written (the file name is taken by a folder) fails the card with nothing pressed', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    mkdirSync(file(x, 'trip', 'dialog-answer.json'), { recursive: true })
    await tap(x, card, 1)
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({ ok: false, ran: false })
  })
})

describe('a workers.json that cannot be read does not close a card', () => {
  test('a torn file neither closes the card nor refuses a tap (the Mac makes its own check)', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    writeFileSync(join(x.home, 'workers.json'), '{"v":1,"supervisor":{"pid":1,')
    x.bridge.optionCTick()
    // timing-ok: negative window: a corrupt workers file changes nothing
    await sleep(150)
    expect(lastUpdate(x, card.id)).toBeUndefined()
    await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    expect(DialogAnswer.parse(answerOf(x)).choice).toBe(1)
  })
  test('a supervisor that stopped beating does not refuse a tap either', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    writeWorkers(x, {}, { stale: true }) // no dialog listed, but nothing fresh says it is gone
    await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
  })
})

describe('links are refused', () => {
  test('a result file that is a link is not read, and the link is not followed', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    const a = DialogAnswer.parse(answerOf(x))
    const elsewhere = join(x.home, 'elsewhere.json')
    writeFileSync(
      elsewhere,
      JSON.stringify({
        v: 1,
        dialog_id: a.dialog_id,
        control_id: a.control_id,
        source: 'card',
        outcome: 'pressed',
        choice: 1,
        label: 'Yes, I trust this folder',
        at: iso(now(x)),
      }),
    )
    symlinkSync(elsewhere, file(x, 'trip', 'dialog-result.json'))
    x.bridge.optionCTick()
    // timing-ok: negative window: the card is resolved once; nothing is written through the link
    await sleep(200)
    expect(lastUpdate(x, card.id)?.state).toBe('resolved')
    expect(existsSync(elsewhere)).toBe(true)
  })

  test('a thread folder that is a link is never read, written into or chmod-ed', async () => {
    await start()
    const x = h as Harness
    const target = join(x.home, 'target-folder')
    mkdirSync(target, { mode: 0o755 })
    mkdirSync(join(x.home, 'workers'), { recursive: true })
    symlinkSync(target, join(x.home, 'workers', 'trip'))
    const card = await show(x, trust(x))
    // timing-ok: negative window: no card file is written through the link
    await sleep(150)
    expect(readdirSync(target)).toEqual([]) // no card file was written through the link
    expect(statSync(target).mode & 0o777).toBe(0o755)
    await tap(x, card, 1)
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed: the answer could not be handed over')
    expect(readdirSync(target)).toEqual([])
    expect((lastUpdate(x, card.id) as Upd).result.ran).toBe(false)
  })

  test('a workers folder that is a link is refused the same way', async () => {
    await start()
    const x = h as Harness
    const target = join(x.home, 'other-workers')
    mkdirSync(target, { mode: 0o755 })
    symlinkSync(target, join(x.home, 'workers'))
    await show(x, trust(x))
    // timing-ok: negative window: nothing is written through the link
    await sleep(150)
    expect(readdirSync(target)).toEqual([])
    expect(statSync(target).mode & 0o777).toBe(0o755)
  })
})

describe('the dialog goes away', () => {
  test('a waiting card is closed, nothing is pressed, and no answer is written', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    writeWorkers(x, {}) // answered in Terminal, or the session ended
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'superseded', 4000, 'closed')
    expect((lastUpdate(x, card.id) as Upd).result).toMatchObject({
      text: "The session isn't waiting on this any more.",
    })
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('superseded')
    await cardFile(x, { status: 'closed' })
    // a late tap finds it closed
    const f = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 1 })
    await waitFor(() => errors(x).some((e) => e.ref === f.id), 4000, 'refusal')
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
  })
})

// The card file used to be written after the card.create send came back, so a dialog that went (or was answered) while the
// create was in flight had its "closed" overwritten with "waiting" when the send returned: the Mac would show a card that is
// gone. Under load that window is wide, and the two tests that read the file flaked.
describe('the create still in flight', () => {
  /** Holds the bridge's card.create send open (the relay already has the frame) until `release()`. */
  function holdCreate(x: Harness) {
    const t = x.bridge.ctx.transport
    const send = t.sendDurable.bind(t)
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    let done: Promise<unknown> = Promise.resolve()
    t.sendDurable = ((f: Parameters<typeof send>[0]) => {
      const p = send(f)
      if (f.type !== 'card.create') return p
      const q = p.then(async (r) => {
        await held
        return r
      })
      done = q
      return q
    }) as typeof t.sendDurable
    return {
      release,
      settled: async () => {
        await done
        await new Promise((r) => setImmediate(r)) // the bridge's own continuation after the send
      },
    }
  }

  test('a dialog gone before the send came back stays closed in the card file, never back to waiting', async () => {
    await start()
    const x = h as Harness
    const hold = holdCreate(x)
    const card = await show(x, trust(x)) // the relay has it; the bridge's send has not returned
    writeWorkers(x, {})
    x.bridge.optionCTick()
    await cardFile(x, { status: 'closed' })
    hold.release()
    await hold.settled()
    expect(readJson(file(x, 'trip', 'dialog-card.json'))).toMatchObject({ status: 'closed', card_id: card.id })
  })

  test('a card still waiting when the send comes back gets its waiting card file', async () => {
    await start()
    const x = h as Harness
    const hold = holdCreate(x)
    const card = await show(x, trust(x))
    expect(existsSync(file(x, 'trip', 'dialog-card.json'))).toBe(false) // only once the send is done
    hold.release()
    await hold.settled()
    expect(readJson(file(x, 'trip', 'dialog-card.json'))).toMatchObject({ status: 'waiting', card_id: card.id })
  })
})

describe('first sighting plus 15 minutes', () => {
  test('the card expires and exactly one thread line says what the Mac used to', async () => {
    const clock = fakeClock()
    await start({ clock })
    const x = h as Harness
    const card = await show(x, trust(x))
    await advanceSteps(clock, 901_000)
    await waitFor(() => lastUpdate(x, card.id)?.state === 'expired', 4000, 'expired')
    // not at once: a Mac that offers the question again would make the line false (L14), so it waits REOFFER_GRACE_MS
    // timing-ok: negative window: no line inside the grace
    await sleep(100)
    expect(notices(x).filter((m) => m.text.includes('is waiting on a'))).toHaveLength(0)
    await advanceSteps(clock, REOFFER_GRACE_MS + 1000)
    const line = dialogFallbackLine(
      'trust',
      process.platform === 'darwin'
        ? { kind: 'mac' }
        : { kind: 'linux', machine: hostname(), attach: 'talos-app supervise attach trip' },
    )
    expect(line.startsWith("This thread's session is waiting on a 'trust this folder' prompt")).toBe(true)
    await waitFor(() => notices(x).some((m) => m.text === line), 4000, 'the thread line')
    // more ticks and more time: still one
    for (let i = 0; i < 3; i++) {
      writeWorkers(x, { trip: trust(x) })
      x.bridge.optionCTick()
    }
    await advanceSteps(clock, 120_000)
    // timing-ok: negative window: exactly one notice
    await sleep(100)
    expect(notices(x).filter((m) => m.text === line)).toHaveLength(1)
    await cardFile(x, { status: 'expired' })
    // Claude is never told about this card, and nothing stopped the worker
    expect(x.notes.filter((n) => n.meta.kind === 'card_action')).toHaveLength(0)
  })

  test('if the dialog was already gone there is no line', async () => {
    const clock = fakeClock()
    await start({ clock })
    const x = h as Harness
    const card = await show(x, trust(x))
    writeWorkers(x, {})
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'superseded', 4000, 'closed')
    await advanceSteps(clock, 901_000)
    // timing-ok: negative window: no waiting notice after the card closed
    await sleep(100)
    expect(notices(x).filter((m) => m.text.includes('is waiting on a'))).toHaveLength(0)
  })
})

describe('a question left standing (L14)', () => {
  const AGAIN_ID = 'Qm8Wt3ZxLp5Rv9NaKc2HdB'
  /** The inbound settle window runs on the injected clock: the clock is nudged (as the no-report test above does) until the answer file is written. */
  async function tapUntilAnswered(x: Harness, clock: ReturnType<typeof fakeClock>, card: CardT) {
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 1, ts: iso(now(x)) })
    for (let i = 0; i < 200 && !existsSync(file(x, 'trip', 'dialog-answer.json')); i++) {
      clock.advance(50)
      await sleep(20)
    }
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(true)
  }
  const waitingLine = (x: Harness) => notices(x).filter((m) => m.text.includes('is waiting on a'))

  test('the Mac offers the same question again under a new id when the card runs out: a new card, and no line saying to go to the Mac', async () => {
    const clock = fakeClock(new Date().toISOString()) // the app's taps are stamped with the real time: the fake clock starts there too
    await start({ clock })
    const x = h as Harness
    const first = await show(x, trust(x))
    await advanceSteps(clock, 901_000)
    await waitFor(() => lastUpdate(x, first.id)?.state === 'expired', 4000, 'expired')
    // the Mac's next look: same question, new id
    const second = await show(x, trust(x, { id: AGAIN_ID }))
    expect(second.id).not.toBe(first.id)
    expect(x.bridge.ctx.ledger.get(first.id)?.state).toBe('expired')
    expect(dialogCards(x).filter((c) => x.bridge.ctx.ledger.get(c.id)?.state === 'pending')).toHaveLength(1)
    await advanceSteps(clock, REOFFER_GRACE_MS + 5000)
    // timing-ok: negative window: no line after the grace either, the question has a fresh card
    await sleep(100)
    expect(waitingLine(x)).toHaveLength(0)
  })

  test('a tap on the expired card presses nothing and does not answer the new one', async () => {
    const clock = fakeClock(new Date().toISOString()) // the app's taps are stamped with the real time: the fake clock starts there too
    await start({ clock })
    const x = h as Harness
    const first = await show(x, trust(x))
    await advanceSteps(clock, 901_000)
    await waitFor(() => lastUpdate(x, first.id)?.state === 'expired', 4000, 'expired')
    const second = await show(x, trust(x, { id: AGAIN_ID }))
    const f = await pushCardResolvePastRelay(x, first, first.payload_hash, 'primary', { choice: 1, ts: iso(now(x)) })
    await waitFor(() => errors(x).some((e) => e.ref === f.id), 4000, 'the refusal')
    expect(['card_expired', 'card_not_pending']).toContain(errors(x).find((e) => e.ref === f.id)?.code as string)
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
    expect(x.bridge.ctx.ledger.get(second.id)?.state).toBe('pending')
    await tapUntilAnswered(x, clock, second)
    expect(answerOf(x)).toMatchObject({ dialog_id: AGAIN_ID })
  })

  test('an older Mac never offers it again: the line is posted once, after the grace, and not before', async () => {
    const clock = fakeClock(new Date().toISOString()) // the app's taps are stamped with the real time: the fake clock starts there too
    await start({ clock })
    const x = h as Harness
    const card = await show(x, trust(x))
    await advanceSteps(clock, 901_000)
    await waitFor(() => lastUpdate(x, card.id)?.state === 'expired', 4000, 'expired')
    expect(waitingLine(x)).toHaveLength(0)
    await advanceSteps(clock, REOFFER_GRACE_MS + 5000)
    await waitFor(() => waitingLine(x).length === 1, 4000, 'the line')
    await advanceSteps(clock, 5 * 60_000)
    // timing-ok: negative window: still exactly one
    await sleep(100)
    expect(waitingLine(x)).toHaveLength(1)
  })

  /** The Mac's report for a tap it never got to (it was away): nothing written, so after DIALOG_RESULT_WAIT_MS the card ends "not confirmed". */
  const cardsOf = (x: Harness, dialogId: string) => dialogCards(x).filter((c) => dialogOf(c)?.dialog_id === dialogId)
  const pending = (x: Harness) => dialogCards(x).filter((c) => x.bridge.ctx.ledger.get(c.id)?.state === 'pending')

  test(
    'a card that ended with no report from the Mac gets ONE replacement while the same dialog is on the pane, and never a third',
    async () => {
      const clock = fakeClock(new Date().toISOString())
      await start({ clock })
      const x = h as Harness
      const first = await show(x, trust(x))
      await tapUntilAnswered(x, clock, first)
      await advanceSteps(clock, DIALOG_RESULT_WAIT_MS + 2000) // the Mac never reports
      await waitFor(() => lastUpdate(x, first.id)?.state === 'failed', 4000, 'the card failed (not confirmed)')
      expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false) // taken back, so a late Mac presses nothing
      writeWorkers(x, { trip: trust(x) }) // the Mac is back, the same dialog (same id) still on the pane
      x.bridge.optionCTick()
      await waitFor(() => cardsOf(x, TRIP_ID).length === 2, 4000, 'the replacement card')
      const second = cardsOf(x, TRIP_ID).find((c) => c.id !== first.id) as CardT
      expect(x.bridge.ctx.ledger.get(second.id)?.state).toBe('pending')
      expect(pending(x)).toHaveLength(1)
      // it answers (the same dialog id, a new card); and when that one ends unconfirmed too there is no third
      await tapUntilAnswered(x, clock, second)
      await advanceSteps(clock, DIALOG_RESULT_WAIT_MS + 2000)
      await waitFor(() => lastUpdate(x, second.id)?.state === 'failed', 4000, 'the second card failed')
      writeWorkers(x, { trip: trust(x) })
      x.bridge.optionCTick()
      // timing-ok: negative window: no third card
      await sleep(200)
      expect(cardsOf(x, TRIP_ID)).toHaveLength(2)
    },
    t(45_000),
  )

  test('a REPORTED "nothing pressed" owes no replacement: the Mac that said so makes its own new id', async () => {
    const clock = fakeClock(new Date().toISOString())
    await start({ clock })
    const x = h as Harness
    const first = await show(x, trust(x))
    await tapUntilAnswered(x, clock, first)
    const a = DialogAnswer.parse(answerOf(x))
    writeMacFile(x, 'trip', 'dialog-result.json', {
      v: 1,
      dialog_id: a.dialog_id,
      control_id: a.control_id,
      source: 'card',
      outcome: 'nothing_pressed',
      reason: 'screen_changed',
      at: iso(now(x)),
    })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, first.id)?.state === 'failed', 4000, 'failed, with the Mac words')
    writeWorkers(x, { trip: trust(x) }) // the same dialog id still on the pane (an older Mac)
    x.bridge.optionCTick()
    // timing-ok: negative window: no replacement card for a reported refusal
    await sleep(200)
    expect(cardsOf(x, TRIP_ID)).toHaveLength(1)
  })

  test('a tap that waited too long for the Mac (mac_offline_too_long) leaves the question one replacement card', async () => {
    const clock = fakeClock(new Date().toISOString())
    await start({ clock })
    const x = h as Harness
    const first = await show(x, trust(x))
    // a tap stamped 11 minutes ago reaches the bridge now: the ledger expires the card (the dialog's own time is a day away)
    await advanceSteps(clock, 11 * 60_000)
    writeWorkers(x, { trip: trust(x, { expires_at: iso(now(x) + 24 * 3600_000) }) })
    // the phone held it for 11 minutes before the relay took it: the relay's stamp is now, on this test's clock (an in-app tap is
    // judged at the relay's stamp, so a stamp left to the real clock would make it look fresh)
    const signed = await x.app.sign({
      ...mkFrame('card.resolve'),
      card_id: first.id,
      action: 'primary',
      payload_hash: first.payload_hash,
      choice: 1,
      ts: iso(now(x) - 11 * 60_000),
    })
    x.relay.sendToBridge({ ...signed, relay: { seq: 1, received_at: iso(now(x)) } }, { durable: true })
    await waitFor(() => x.bridge.ctx.ledger.get(first.id)?.state === 'expired', 4000, 'the card expired')
    x.bridge.optionCTick()
    await waitFor(() => cardsOf(x, TRIP_ID).length === 2, 4000, 'the replacement card')
    expect(pending(x)).toHaveLength(1)
    // not a line saying to go to the Mac: the question has a card again
    await advanceSteps(clock, REOFFER_GRACE_MS + 5000)
    // timing-ok: negative window: no line
    await sleep(100)
    expect(waitingLine(x)).toHaveLength(0)
  })

  test('nothing is made for a dialog that is gone, or while the supervisor file is stale', async () => {
    const clock = fakeClock(new Date().toISOString())
    await start({ clock })
    const x = h as Harness
    const first = await show(x, trust(x))
    await tapUntilAnswered(x, clock, first)
    await advanceSteps(clock, DIALOG_RESULT_WAIT_MS + 2000)
    await waitFor(() => lastUpdate(x, first.id)?.state === 'failed', 4000, 'failed')
    writeWorkers(x, { trip: trust(x) }, { stale: true }) // an old file proves nothing
    x.bridge.optionCTick()
    // timing-ok: negative window: no card from a stale file
    await sleep(150)
    expect(cardsOf(x, TRIP_ID)).toHaveLength(1)
    writeWorkers(x, {}) // the dialog is gone
    x.bridge.optionCTick()
    // timing-ok: negative window: no card for a dialog that is gone
    await sleep(150)
    expect(dialogCards(x)).toHaveLength(1)
  })
})

describe('the owner answered on the Mac popup', () => {
  const popup = (x: Harness, over: Record<string, unknown> = {}) =>
    writeMacFile(x, 'trip', 'dialog-result.json', {
      v: 1,
      dialog_id: TRIP_ID,
      source: 'mac',
      outcome: 'pressed',
      choice: 1,
      label: 'Yes, I trust this folder',
      at: iso(now(x)),
      ...over,
    })

  test('nothing changes until a fresh workers.json shows the dialog gone; then the card reads "Answered on this Mac"', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    popup(x)
    x.bridge.optionCTick()
    // timing-ok: negative window: a popup report changes nothing
    await sleep(200)
    expect(lastUpdate(x, card.id)).toBeUndefined()
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    writeWorkers(x, {})
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'done', 4000, 'done')
    const u = lastUpdate(x, card.id) as Upd
    expect(u.result).toMatchObject({ ok: true, text: 'Trusted ~/Documents/x' })
    expect(u.resolution.by).toBe('this Mac')
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
    expect(existsSync(file(x, 'trip', 'dialog-result.json'))).toBe(false)
    await cardFile(x, { status: 'answered', by: 'this Mac' })
  })

  test('a dialog that goes away with no popup report is just closed', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    writeWorkers(x, {})
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'superseded', 4000, 'closed')
  })

  test('a report for an option that is not on the card, or another dialog, is ignored', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    for (const bad of [
      { choice: 0 },
      { choice: 5 },
      { label: 'Something else' },
      { dialog_id: 'Sq5Lm8ZtRx3Cv9PkNa2HdB' },
      { at: iso(now(x) - 3_600_000) },
    ]) {
      popup(x, bad)
      x.bridge.optionCTick()
      // timing-ok: negative window: a malformed popup report changes nothing
      await sleep(60)
    }
    writeWorkers(x, {})
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'superseded', 4000, 'closed, not answered')
  })

  test('a phone answer that lost to the popup is told so by the Mac, and the card says it', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, trust(x))
    await tap(x, card, 0)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    const a = DialogAnswer.parse(answerOf(x))
    popup(x) // the popup got there first
    x.bridge.optionCTick()
    // timing-ok: negative window: a popup report is only noted, no result file
    await sleep(100)
    expect(existsSync(file(x, 'trip', 'dialog-result.json'))).toBe(false) // a popup report is only noted
    writeMacFile(x, 'trip', 'dialog-result.json', {
      v: 1,
      dialog_id: a.dialog_id,
      control_id: a.control_id,
      source: 'card',
      outcome: 'nothing_pressed',
      reason: 'already_answered',
      at: iso(now(x)),
    })
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'failed', 4000, 'failed')
    expect((lastUpdate(x, card.id) as Upd).result.text).toBe('Already answered at the Mac first.')
  })
})

// ---- Main's development-channels dialog: published as supervisor.main_dialog, carded on the default thread ----
describe("Main's development-channels dialog", () => {
  const DEV_ID = 'Dv5Qm8ZtRx3Cw9PkNa2HdB'
  const dev = (x: Harness, over: Partial<WorkerDialogT> = {}): WorkerDialogT =>
    trust(x, {
      id: DEV_ID,
      kind: 'dev_channels',
      subject: 'server:talos-app',
      options: ['I am using this for local development', 'Exit'],
      cursor: 0,
      ...over,
    })
  const mainThread = (x: Harness) => x.bridge.ctx.config.config.default_thread
  function writeMain(x: Harness, d: WorkerDialogT | undefined, opts: { stale?: boolean } = {}) {
    writeFileSync(
      join(x.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: {
          pid: 1,
          heartbeat_at: iso(opts.stale ? now(x) - 60_000 : now(x)),
          workers_supported: true,
          ...(d ? { main_dialog: d } : {}),
        },
        threads: {},
      }),
    )
  }
  async function showMain(x: Harness, d: WorkerDialogT) {
    writeMain(x, d)
    x.bridge.optionCTick()
    await waitFor(() => dialogCards(x).some((c) => dialogOf(c)?.dialog_id === d.id), 4000, 'the dev-channels card')
    return dialogCards(x).find((c) => dialogOf(c)?.dialog_id === d.id) as CardT
  }

  test('Main publishes its dialog: one card on the default thread, with the screen buttons', async () => {
    await start()
    const x = h as Harness
    const card = await showMain(x, dev(x))
    expect(card.thread_id).toBe(mainThread(x))
    expect(card.title).toBe("Allow Talos's development channel?")
    expect(card.body).toBe("Main session's start needs this to talk to the Talos app.")
    expect(dialogOf(card)).toMatchObject({
      dialog_kind: 'dev_channels',
      subject: 'server:talos-app',
      options: ['I am using this for local development', 'Exit'],
    })
    // written once the card's send is done, after the relay has it: waited for, never read at once
    const ack = DialogCardFile.parse(await cardFile(x, { card_id: card.id }, mainThread(x)))
    expect(ack).toMatchObject({ dialog_id: DEV_ID, card_id: card.id, status: 'waiting' })
  })

  test('an extra channel and a changed launch are said on the card', async () => {
    await start()
    const x = h as Harness
    const card = await showMain(x, dev(x, { subject: 'server:talos-app, server:odd', launch_changed: ['flags'] }))
    expect(card.body).toContain("Also loads server:odd, which Talos didn't add.")
    expect(card.body).toContain("Main's start command changed since you last confirmed it. Changed: flags.")
  })

  test('the same dialog id is carded once, however often the file is read', async () => {
    await start()
    const x = h as Harness
    await showMain(x, dev(x))
    for (let i = 0; i < 3; i++) {
      writeMain(x, dev(x))
      x.bridge.optionCTick()
    }
    // timing-ok: negative window: still exactly one dialog card
    await sleep(200)
    expect(dialogCards(x)).toHaveLength(1)
  })

  test('a tap hands the signed answer to the Mac under the default thread', async () => {
    await start()
    const x = h as Harness
    const card = await showMain(x, dev(x))
    await tap(x, card, 0)
    await waitFor(() => existsSync(file(x, mainThread(x), 'main-dialog-answer.json')), 4000, 'the answer file')
    const a = DialogAnswer.parse(readJson(file(x, mainThread(x), 'main-dialog-answer.json')))
    expect(a).toMatchObject({ dialog_id: DEV_ID, choice: 0, label: 'I am using this for local development' })
  })

  test('the card posted and the tap answered are named events, with ids and no words from the screen', async () => {
    logLines.length = 0
    h = await startHarness({
      relay: FLAGGED,
      bridge: { logger: recLogger() },
      config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
        ...c,
        threads: [...c.threads, thread('trip', 'Trip')],
      })) as never,
    })
    const x = h as Harness
    const card = await showMain(x, dev(x, { subject: 'server:talos-app, server:secret-looking' }))
    await waitFor(() => logLines.some((l) => l.fields?.event === DIALOG_CARD_POSTED_EVENT), 4000, 'the posted event')
    await tap(x, card, 0)
    await waitFor(
      () => logLines.some((l) => l.fields?.event === DIALOG_CARD_ANSWERED_EVENT),
      4000,
      'the answered event',
    )
    const posted = logLines.find((l) => l.fields?.event === DIALOG_CARD_POSTED_EVENT)
    const answered = logLines.find((l) => l.fields?.event === DIALOG_CARD_ANSWERED_EVENT)
    expect(posted?.fields).toMatchObject({ dialog_kind: 'dev_channels', card_id: card.id })
    expect(answered?.fields).toMatchObject({ dialog_kind: 'dev_channels', card_id: card.id, choice: 0 })
    for (const [l, name] of [
      [posted, DIALOG_CARD_POSTED_EVENT],
      [answered, DIALOG_CARD_ANSWERED_EVENT],
    ] as const) {
      const { event, ...fields } = (l?.fields ?? {}) as Record<string, unknown>
      expect(event).toBe(name)
      expect(eventInfo(name)?.payload.safeParse(fields).success, name).toBe(true)
    }
    expect(JSON.stringify([posted, answered])).not.toContain('secret-looking')
  })

  test('Exit is a choice of its own', async () => {
    await start()
    const x = h as Harness
    const card = await showMain(x, dev(x))
    await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, mainThread(x), 'main-dialog-answer.json')), 4000, 'the answer file')
    expect(readJson(file(x, mainThread(x), 'main-dialog-answer.json'))).toMatchObject({ choice: 1, label: 'Exit' })
  })

  test('a tap after the Mac dropped the dialog is refused as not pending, and writes nothing', async () => {
    await start()
    const x = h as Harness
    const card = await showMain(x, dev(x))
    writeMain(x, undefined)
    const r = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 0 })
    await waitFor(() => errors(x).some((e) => e.ref === r.id), 4000, 'the refusal')
    expect(errors(x).find((e) => e.ref === r.id)?.code).toBe('card_not_pending')
    expect(existsSync(file(x, mainThread(x), 'main-dialog-answer.json'))).toBe(false)
  })

  test('the dialog gone: the card is closed', async () => {
    await start()
    const x = h as Harness
    const card = await showMain(x, dev(x))
    writeMain(x, undefined)
    x.bridge.optionCTick()
    await waitFor(() => lastUpdate(x, card.id)?.state === 'superseded', 4000, 'the card closed')
  })

  test('a stale supervisor, or a relay without needs-you/1, makes no card', async () => {
    await start()
    const x = h as Harness
    writeMain(x, dev(x), { stale: true })
    x.bridge.optionCTick()
    // timing-ok: negative window: no dialog card for a stale file
    await sleep(300)
    expect(dialogCards(x)).toHaveLength(0)
  })

  test('another kind as main_dialog is no card (Main publishes only its own development-channels question)', async () => {
    await start()
    const x = h as Harness
    writeMain(x, trust(x, { id: 'Fw5Qm8ZtRx3Cw9PkNa2HdB' }))
    x.bridge.optionCTick()
    // timing-ok: negative window: no dialog card for a bad id
    await sleep(300)
    expect(dialogCards(x)).toHaveLength(0)
  })

  test("a thread session's own development-channels question is a card: its words are the thread's, and the tap goes to the thread's own answer file", async () => {
    await start()
    const x = h as Harness
    writeWorkers(x, { trip: dev(x, { id: 'Ew5Qm8ZtRx3Cw9PkNa2HdB' }) })
    x.bridge.optionCTick()
    await waitFor(() => dialogCards(x).length === 1, 4000, "the thread's dev-channels card")
    const card = dialogCards(x)[0] as CardT
    expect(dialogOf(card)).toMatchObject({ dialog_kind: 'dev_channels', thread: 'trip' })
    expect(card.body).toContain("Trip's session was started with a development channel")
    expect(card.body).not.toMatch(/Main/)
    await tap(x, card, 0)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    expect(existsSync(file(x, 'trip', 'main-dialog-answer.json'))).toBe(false)
    expect(answerOf(x)).toMatchObject({ choice: 0, label: 'I am using this for local development' })
  })

  test("a worker's own dialog on the default thread never hides Main's: both are carded, and the answer goes to Main's own file", async () => {
    await start()
    const x = h as Harness
    const main = mainThread(x)
    writeFileSync(
      join(x.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: iso(now(x)), workers_supported: true, main_dialog: dev(x) },
        threads: {
          [main]: {
            state: 'live',
            session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
            tmux: 't-main',
            pane_pid: 0,
            cwd: x.home,
            error: null,
            dialog: trust(x),
          },
        },
      }),
    )
    x.bridge.optionCTick()
    await waitFor(() => dialogCards(x).length === 2, 4000, 'both cards')
    const card = dialogCards(x).find((c) => dialogOf(c)?.dialog_kind === 'dev_channels') as CardT
    await tap(x, card, 0)
    await waitFor(() => existsSync(file(x, main, 'main-dialog-answer.json')), 4000, 'the answer file')
    expect(existsSync(file(x, main, 'dialog-answer.json'))).toBe(false)
  })
})

describe('the safety questions on a card (pane-prompts rows 2 and 4)', () => {
  const BYPASS_ID = 'By7Qm8ZtRx3Cw9PkNa2HdC'
  const bypass = (x: Harness): WorkerDialogT =>
    trust(x, { id: BYPASS_ID, kind: 'bypass', subject: null, options: ['No, exit', 'Yes, I accept'], cursor: 0 })

  test('the bypass disclaimer is one card with its own heading and the screen’s two buttons; a tap hands the signed answer to the thread', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, bypass(x))
    expect(card.title).toBe('Run with permission checks off?')
    expect(dialogOf(card)).toMatchObject({
      dialog_kind: 'bypass',
      subject: null,
      options: ['No, exit', 'Yes, I accept'],
    })
    await tap(x, card, 1)
    await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
    const a = DialogAnswer.parse(answerOf(x))
    expect(a).toMatchObject({ dialog_id: BYPASS_ID, choice: 1, label: 'Yes, I accept' })
    // a safety question is answered only with the owner's signed tap: the file carries the proof the Mac or supervisor checks
    expect(a.proof?.device_id).toMatch(/^d_[a-z2-7]{20}$/)
    await cardFile(x, { status: 'answered', label: 'Yes, I accept' })
  })

  test('a choice that is not one of the two rows, with the bypass card, is refused and writes nothing', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, bypass(x))
    const r = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 2 })
    await waitFor(() => errors(x).some((e) => e.ref === r.id), 4000, 'the refusal')
    // timing-ok: negative window: a refused answer writes no answer file
    await sleep(200)
    expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
  })

  test('an MCP question whose server was read is "Use <server>?" on the card', async () => {
    await start()
    const x = h as Harness
    const card = await show(x, mcp(x))
    expect(card.title).toBe('Use github?')
  })
})

// Needs-you prompts, bridge side (docs/OPTION-C.md "Needs-you prompts"). A thread session shows a known dialog; the Mac records
// it in workers.json; the bridge makes a card, the owner taps, the bridge writes the answer file for the Mac, the Mac reports
// what it did. Real bridge + FakeRelay + a signing FakeApp; the Mac is played by the test writing the files it writes.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CardT,
  DIALOG_ANSWER_MAX_BYTES,
  DIALOG_RESULT_WAIT_MS,
  DialogAnswer,
  DialogCardFile,
  dialogFallbackLine,
  dialogNothingPressedText,
  dialogOf,
  NEEDS_YOU_FEATURE,
  ownerSignedString,
  sha256Hex,
  verifyDialogAnswer,
  type WorkerDialogT,
} from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { DialogCards } from '../src/dialog-card.ts'
import { advanceSteps, type Harness, pushCardResolvePastRelay, sleep, startHarness, waitFor } from './helpers.ts'

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
  voice_context: 'recent',
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
async function cardFile(x: Harness, want: Record<string, unknown>) {
  const path = file(x, 'trip', 'dialog-card.json')
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
    await sleep(150)
    expect(lastUpdate(x, card.id)?.state).toBe('resolved')
  })

  test('the dialog going away after an answer is the key press: the card waits for the report, not closed', async () => {
    await start()
    const x = h as Harness
    const { card, a } = await answered(x, trust(x), 1)
    writeWorkers(x, {})
    x.bridge.optionCTick()
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

describe('first sighting plus 15 minutes', () => {
  test('the card expires and exactly one thread line says what the Mac used to', async () => {
    const clock = fakeClock()
    await start({ clock })
    const x = h as Harness
    const card = await show(x, trust(x))
    await advanceSteps(clock, 901_000)
    await waitFor(() => lastUpdate(x, card.id)?.state === 'expired', 4000, 'expired')
    const line = dialogFallbackLine('trust', 'Trip')
    await waitFor(() => notices(x).some((m) => m.text === line), 4000, 'the thread line')
    // more ticks and more time: still one
    for (let i = 0; i < 3; i++) {
      writeWorkers(x, { trip: trust(x) })
      x.bridge.optionCTick()
    }
    await advanceSteps(clock, 120_000)
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
    await sleep(100)
    expect(notices(x).filter((m) => m.text.includes('is waiting on a'))).toHaveLength(0)
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

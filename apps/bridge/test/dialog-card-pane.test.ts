// Needs-you prompts, bridge side, pane-prompts rows 8 and 9: the tool permission card and the agent's question card (with its free-text option).
// Real bridge + FakeRelay + a signing FakeApp; the Mac is played by the test writing the files it writes. The words the owner types for `Other…`
// travel in the SIGNED frame (`text`), the bridge refuses a text where none belongs before the ledger moves, and the answer file carries the signed
// text unchanged for the Mac to type.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CardT,
  DIALOG_SENT_UNCONFIRMED_TEXT,
  DialogAnswer,
  dialogOf,
  NEEDS_YOU_FEATURE,
  newUlid,
  verifyDialogAnswer,
  type WorkerDialogT,
} from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { HARNESS_START_MS, type Harness, pushCardResolvePastRelay, sleep, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(t(30_000)) // a test that starts a harness says HARNESS_START_MS plus its own waits itself

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

/** Every frame the relay sent before this has REACHED the bridge (it answers a ping at once, in order; its queues may still be working): it proves arrival, not that the bridge has finished with them. */
const pinged = async (x: Harness) => {
  const nonce = `after-${newUlid().slice(-12)}`
  x.relay.sendToBridge({ type: 'ping', nonce }, { durable: false })
  await x.relay.expectFrame('pong', (f) => f.nonce === nonce, { direction: 'from_bridge' })
}

const TOOL_ID = 'Tq5Qm8ZtRx3Cw9PkNa2HdB'
const ASK_ID = 'Qq5Qm8ZtRx3Cw9PkNa2HdB'
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

async function start() {
  h = await startHarness({
    relay: { relayFeatures: ['schedules/1', 'thread-sessions/1', NEEDS_YOU_FEATURE] },
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', 'Trip')],
      dedicated: { enabled: true },
    })) as never,
  })
  return h
}

const now = (x: Harness) => x.bridge.ctx.clock.now()
const tool = (x: Harness, over: Partial<WorkerDialogT> = {}): WorkerDialogT => ({
  id: TOOL_ID,
  kind: 'tool_permission',
  subject: 'Bash command · touch hello.txt && ls -l hello.txt',
  options: ['Allow once', 'Deny'],
  cursor: null,
  seen_at: iso(now(x)),
  expires_at: iso(now(x) + 900_000),
  ...over,
})
const question = (x: Harness, over: Partial<WorkerDialogT> = {}): WorkerDialogT =>
  tool(x, {
    id: ASK_ID,
    kind: 'agent_question',
    subject: 'Which color do you prefer?',
    options: ['Red', 'Blue', 'Other…', 'Chat about this'],
    free_text: 2,
    ...over,
  })

function writeWorkers(x: Harness, d: WorkerDialogT | undefined, main?: WorkerDialogT) {
  writeFileSync(
    join(x.home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: {
        pid: 1,
        heartbeat_at: iso(now(x)),
        workers_supported: true,
        ...(main ? { main_dialog: main } : {}),
      },
      threads: {
        trip: {
          state: 'live',
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: 0,
          cwd: x.home,
          error: null,
          ...(d ? { dialog: d } : {}),
        },
      },
    }),
  )
}
const file = (x: Harness, id: string, name: string) => join(x.home, 'workers', id, name)
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const fromBridge = (x: Harness, type: string) =>
  x.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === type).map((r) => r.raw)
const dialogCards = (x: Harness) =>
  fromBridge(x, 'card.create')
    .map((r) => r.card as CardT)
    .filter((c) => c.kind === 'dialog')
const errors = (x: Harness) => fromBridge(x, 'error')

async function show(x: Harness, d: WorkerDialogT, main = false) {
  if (main) writeWorkers(x, undefined, d)
  else writeWorkers(x, d)
  x.bridge.optionCTick()
  await waitFor(() => dialogCards(x).some((c) => dialogOf(c)?.dialog_id === d.id), 4000, 'the dialog card')
  return dialogCards(x).find((c) => dialogOf(c)?.dialog_id === d.id) as CardT
}

const pane = (x: Harness, d: WorkerDialogT) => ({
  dialog_id: d.id,
  dialog_kind: d.kind,
  subject: d.subject,
  options: d.options,
  free_text: d.free_text,
})
/** The check the Mac makes, on the answer the bridge wrote. */
const macCheck = (x: Harness, d: WorkerDialogT, path: string, threadId = 'trip') =>
  verifyDialogAnswer(DialogAnswer.parse(readJson(path)), {
    pinnedKey: (id) => x.bridge.ctx.devices.pinnedKey(id),
    nowMs: now(x),
    thread: threadId,
    pane: pane(x, d),
  })

describe('the tool permission card', () => {
  test(
    'is a card with the tool and the command, Allow once and Deny, and no standing grant',
    async () => {
      await start()
      const x = h as Harness
      const card = await show(x, tool(x))
      expect(card.title).toBe('Allow this tool request?')
      expect(dialogOf(card)).toMatchObject({
        dialog_kind: 'tool_permission',
        subject: 'Bash command · touch hello.txt && ls -l hello.txt',
        options: ['Allow once', 'Deny'],
      })
      expect(JSON.stringify(card)).not.toMatch(/always|don.t ask/i)
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    'a tap on Allow once writes a proof the Mac accepts; the text is refused for it',
    async () => {
      await start()
      const x = h as Harness
      const d = tool(x)
      const card = await show(x, d)
      // a text on a button that takes none is refused before the ledger moves, and the card still waits
      const bad = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 0, text: 'rm -rf /' })
      await waitFor(() => errors(x).some((e) => e.ref === bad.id), 4000, 'the refusal')
      expect(errors(x).find((e) => e.ref === bad.id)?.code).toBe('bad_frame')
      expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
      expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 0 })
      await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
      expect(readJson(file(x, 'trip', 'dialog-answer.json'))).toMatchObject({ choice: 0, label: 'Allow once' })
      expect(await macCheck(x, d, file(x, 'trip', 'dialog-answer.json'))).toMatchObject({
        ok: true,
        choice: 0,
        label: 'Allow once',
        text: null,
      })
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    'Deny is its own choice; a choice past the two buttons is refused',
    async () => {
      await start()
      const x = h as Harness
      const card = await show(x, tool(x))
      const out = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 2 })
      await waitFor(() => errors(x).some((e) => e.ref === out.id), 4000, 'the refusal')
      expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 1 })
      await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
      expect(readJson(file(x, 'trip', 'dialog-answer.json'))).toMatchObject({ choice: 1, label: 'Deny' })
    },
    HARNESS_START_MS + t(45_000),
  )
})

describe('the agent question card with a free-text option', () => {
  test(
    'a pick answers with its index; Other… answers with the owner words signed into the frame',
    async () => {
      await start()
      const x = h as Harness
      const d = question(x)
      const card = await show(x, d)
      expect(dialogOf(card)).toMatchObject({ dialog_kind: 'agent_question', free_text: 2, options: d.options })
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 2, text: 'purple' })
      await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
      const a = DialogAnswer.parse(readJson(file(x, 'trip', 'dialog-answer.json')))
      expect(a).toMatchObject({ choice: 2, label: 'Other…' })
      // the words are in the signed text, not in a field anyone can edit: that is what the Mac types
      expect(JSON.parse(a.proof.signed)).toMatchObject({ choice: 2, text: 'purple' })
      expect(await macCheck(x, d, file(x, 'trip', 'dialog-answer.json'))).toMatchObject({
        ok: true,
        choice: 2,
        text: 'purple',
      })
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    'a text that is not the owner clean words, or none for Other…, or one for a pick, is refused and the card still waits',
    async () => {
      await start()
      const x = h as Harness
      const card = await show(x, question(x))
      const cases: Array<Record<string, unknown>> = [
        { choice: 2 },
        { choice: 0, text: 'sneaky' },
        { choice: 2, text: 'two\nlines' },
        { choice: 2, text: 'a‮b' },
        { choice: 2, text: ' padded' },
        { choice: 3, text: 'chat' },
      ]
      for (const extra of cases) {
        const out = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', extra)
        await waitFor(() => errors(x).some((e) => e.ref === out.id), 4000, `the refusal for ${JSON.stringify(extra)}`)
        expect(errors(x).find((e) => e.ref === out.id)?.code).toBe('bad_frame')
      }
      // a text over the frame's own cap never gets this far
      expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
      expect(existsSync(file(x, 'trip', 'dialog-answer.json'))).toBe(false)
    },
    HARNESS_START_MS + t(100_000),
  )

  test(
    'the first answer wins: a second tap with other words writes nothing more',
    async () => {
      await start()
      const x = h as Harness
      const card = await show(x, question(x))
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 2, text: 'purple' })
      await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
      const first = readJson(file(x, 'trip', 'dialog-answer.json'))
      const second = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', {
        choice: 2,
        text: 'orange',
      })
      await waitFor(() => errors(x).some((e) => e.ref === second.id), 4000, 'the refusal')
      expect(errors(x).find((e) => e.ref === second.id)?.code).toBe('card_not_pending')
      expect(readJson(file(x, 'trip', 'dialog-answer.json'))).toEqual(first)
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    'a question with no free-text option takes no text at all',
    async () => {
      await start()
      const x = h as Harness
      const card = await show(x, question(x, { options: ['Red', 'Blue'], free_text: undefined }))
      expect(dialogOf(card)?.free_text).toBeUndefined()
      const out = await pushCardResolvePastRelay(x, card, card.payload_hash, 'primary', { choice: 1, text: 'x' })
      await waitFor(() => errors(x).some((e) => e.ref === out.id), 4000, 'the refusal')
      expect(errors(x).find((e) => e.ref === out.id)?.code).toBe('bad_frame')
    },
    HARNESS_START_MS + t(45_000),
  )
})

describe('a key sent and not seen to take', () => {
  test(
    'the card says sent and unconfirmed, never that it was allowed',
    async () => {
      await start()
      const x = h as Harness
      const d = tool(x)
      const card = await show(x, d)
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 0 })
      await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
      const a = DialogAnswer.parse(readJson(file(x, 'trip', 'dialog-answer.json')))
      writeFileSync(
        file(x, 'trip', 'dialog-result.json'),
        JSON.stringify({
          v: 1,
          dialog_id: d.id,
          control_id: a.control_id,
          source: 'card',
          outcome: 'nothing_pressed',
          reason: 'unconfirmed',
          at: iso(now(x)),
        }),
      )
      x.bridge.optionCTick()
      const upd = () =>
        fromBridge(x, 'card.update')
          .filter((r) => r.card_id === card.id)
          .map((r) => r.result as { ok: boolean; text: string; ran: unknown } | undefined)
          .find((r) => r?.text === DIALOG_SENT_UNCONFIRMED_TEXT)
      await waitFor(() => upd() !== undefined, 5000, 'the unconfirmed card text')
      expect(upd()).toMatchObject({ ok: false, ran: 'unknown' })
      expect(DIALOG_SENT_UNCONFIRMED_TEXT).not.toMatch(/Allowed|Denied/)
    },
    HARNESS_START_MS + t(45_000),
  )
})

describe("Main's own tool permission and question", () => {
  test(
    'are carded on the default thread (Main speaks), and the answer goes to Main`s own file',
    async () => {
      await start()
      const x = h as Harness
      const main = x.bridge.ctx.config.config.default_thread
      const d = tool(x, { id: 'Mt5Qm8ZtRx3Cw9PkNa2HdB' })
      const card = await show(x, d, true)
      expect(card.thread_id).toBe(main)
      expect(card.title).toBe('Allow this tool request?')
      expect(card.body).toContain("Main's session asks to use the tool shown")
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 0 })
      await waitFor(() => existsSync(file(x, main, 'main-dialog-answer.json')), 4000, 'the answer file')
      expect(existsSync(file(x, main, 'dialog-answer.json'))).toBe(false)
      expect(await macCheck(x, d, file(x, main, 'main-dialog-answer.json'), main)).toMatchObject({
        ok: true,
        choice: 0,
      })
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    'a kind Main does not publish as main_dialog is still no card',
    async () => {
      await start()
      const x = h as Harness
      writeWorkers(x, undefined, {
        ...tool(x),
        kind: 'trust',
        subject: '~/x',
        options: ['No, exit', 'Yes, I trust this folder'],
      })
      x.bridge.optionCTick()
      await pinged(x) // start point (bridge side: the ping has reached the bridge; the tick itself ran synchronously above); then a quiet window
      await sleep(t(300))
      expect(dialogCards(x)).toHaveLength(0)
      mkdirSync(join(x.home, 'workers'), { recursive: true })
    },
    HARNESS_START_MS + t(45_000),
  )
})

describe('the usage limit card (pane-prompts row 7)', () => {
  const usage = (x: Harness, over: Partial<WorkerDialogT> = {}): WorkerDialogT =>
    tool(x, {
      id: 'Ul9Qm8ZtRx3Cw9PkNa2HdB',
      kind: 'usage_limit',
      subject: 'Fable limit reached. It resets Aug 8, 4pm (Europe/Paris).',
      options: ['Stop and wait', 'Switch model'],
      ...over,
    })

  test(
    'a thread session: a card with the reset in words; a tap on Switch model writes a proof the Mac accepts',
    async () => {
      await start()
      const x = h as Harness
      const d = usage(x)
      const card = await show(x, d)
      expect(card.title).toBe("Trip's session hit its usage limit")
      expect(dialogOf(card)).toMatchObject({
        dialog_kind: 'usage_limit',
        subject: d.subject,
        options: ['Stop and wait', 'Switch model'],
      })
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 1 })
      await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
      expect(readJson(file(x, 'trip', 'dialog-answer.json'))).toMatchObject({ choice: 1, label: 'Switch model' })
      expect(await macCheck(x, d, file(x, 'trip', 'dialog-answer.json'))).toMatchObject({ ok: true, choice: 1 })
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    "Main's own usage limit (supervisor.main_dialog) is a card too, answered through Main's own answer file",
    async () => {
      await start()
      const x = h as Harness
      const main = x.bridge.ctx.config.config.default_thread
      const d = usage(x)
      const card = await show(x, d, true)
      expect(card.thread_id).toBe(main)
      expect(dialogOf(card)).toMatchObject({ dialog_kind: 'usage_limit', options: ['Stop and wait', 'Switch model'] })
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 0 })
      await waitFor(() => existsSync(file(x, main, 'main-dialog-answer.json')), 4000, "Main's answer file")
      expect(existsSync(file(x, main, 'dialog-answer.json'))).toBe(false)
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    'an option that is not Stop and wait or Switch model makes no card',
    async () => {
      await start()
      const x = h as Harness
      writeWorkers(x, usage(x, { options: ['Stop and wait', 'Add funds to continue with usage credits'] }))
      x.bridge.optionCTick()
      await pinged(x)
      await sleep(t(300))
      expect(dialogCards(x)).toEqual([])
    },
    HARNESS_START_MS + t(45_000),
  )

  test.each([
    ['closed', 'Closed the limit menu. Switch model at the Mac.'],
    ['typed', 'Closed the limit menu; /model was typed but not sent. Finish at the Mac or clear it.'],
    ['cleared', 'Closed the limit menu; /model was typed and cleared again. Switch model at the Mac.'],
  ])(
    'a Switch model that stopped part way (%s) is said as it is, never as nothing pressed',
    async (reason, words) => {
      await start()
      const x = h as Harness
      const d = usage(x)
      const card = await show(x, d)
      await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 1 })
      await waitFor(() => existsSync(file(x, 'trip', 'dialog-answer.json')), 4000, 'the answer file')
      const a = DialogAnswer.parse(readJson(file(x, 'trip', 'dialog-answer.json')))
      writeFileSync(
        file(x, 'trip', 'dialog-result.json'),
        JSON.stringify({
          v: 1,
          dialog_id: d.id,
          control_id: a.control_id,
          source: 'card',
          outcome: 'partial',
          choice: 1,
          label: 'Switch model',
          reason,
          at: iso(now(x)),
        }),
      )
      x.bridge.optionCTick()
      const upd = () =>
        fromBridge(x, 'card.update')
          .filter((r) => r.card_id === card.id)
          .map((r) => r.result as { ok: boolean; text: string; ran: unknown } | undefined)
          .find((r) => r?.text === words)
      await waitFor(() => upd() !== undefined, 5000, 'the partial card text')
      expect(upd()).toMatchObject({ ok: false, ran: 'unknown' })
      expect(words).not.toMatch(/nothing pressed|Nothing pressed/)
    },
    HARNESS_START_MS + t(45_000),
  )
})

// An open AskUserQuestion (Claude Code runs the PermissionRequest hook for it) is mirrored on the phone AT ONCE as a card per question; the
// owner's signed tap goes back as the agent's answer (the hook's `updatedInput.answers`); after the unblock time the agent is told exactly
// "No answer yet; carry on with other work and ask again later" so it can go on; a question answered at the terminal sends nothing. Real hub
// and bridge, real hub socket, and (last describe) the real kit hook. No real claude.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CardT, dialogVisibleText, NEEDS_YOU_FEATURE } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { NO_ANSWER_YET } from '../src/permission/question-words.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

const SESSION_PID = 4_242_424
const main = { pid: SESSION_PID, cwd: '/srv/proj' }
const Q1 = {
  question: 'Which colour?',
  header: 'Colour',
  multiSelect: false,
  options: [
    { label: 'Red', description: 'warm' },
    { label: 'Blue', description: 'cool' },
  ],
}
const Q2 = {
  question: 'Which size?',
  header: 'Size',
  multiSelect: false,
  options: [
    { label: 'Small', description: 's' },
    { label: 'Large', description: 'l' },
  ],
}
const asked = (...qs: unknown[]) => ({ questions: qs })

let h: Harness | undefined
const sockets: { destroy(): void }[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await h?.stop()
  h = undefined
})

async function start(unblockMs?: number) {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      permission_relay: true,
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
    })) as never,
  })
  h.bridge.ctx.permission.setHookTimings({
    graceMs: 150,
    ...(unblockMs !== undefined ? { questionUnblockMs: unblockMs } : {}),
  })
  h.bridge.ctx.permission.setSessionPids([SESSION_PID])
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}

type Answer = Record<string, unknown> & { t: string; id: string; decision: string; answers?: Record<string, string> }
/** A hook's connection to the hub: sends the perm line, collects every line the hub sends back, can send `perm_over` and close. */
function hook(home: string, line: Record<string, unknown>) {
  const sock = createConnection(join(home, 'run', 'hub.sock'))
  sockets.push(sock)
  sock.setEncoding('utf8')
  const lines: Answer[] = []
  let buf = ''
  let settle: (a: Answer | null) => void = () => {}
  const result = new Promise<Answer | null>((r) => {
    settle = r
  })
  sock.on('data', (d: string) => {
    buf += d
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const a = JSON.parse(buf.slice(0, nl)) as Answer
      buf = buf.slice(nl + 1)
      lines.push(a)
      settle(a)
    }
  })
  sock.on('close', () => settle(null))
  sock.on('error', () => settle(null))
  sock.on('connect', () => sock.write(`${JSON.stringify(line)}\n`))
  return {
    result,
    lines,
    send: (l: Record<string, unknown>) => sock.write(`${JSON.stringify(l)}\n`),
    close: () => sock.destroy(),
  }
}
const permLine = (input: unknown, over: Record<string, unknown> = {}, id = 'req-q1') => ({
  t: 'perm',
  id,
  tool_name: 'AskUserQuestion',
  tool_input: input,
  ...main,
  ...over,
})

const cardsOf = (x: Harness, kind: string): CardT[] =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === kind)
    .map((f) => (f.frame as { card: CardT }).card)
const questionCards = (x: Harness) =>
  cardsOf(x, 'dialog').filter((c) => (c.payload as { dialog_kind?: string }).dialog_kind === 'agent_question')
const updates = (x: Harness, cardId: string) =>
  x.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'card.update' && f.frame.card_id === cardId)
    .map((f) => f.frame as { state: string; reason?: string; result?: { text: string } })
const payloadOf = (c: CardT) =>
  c.payload as { subject: string; options: string[]; free_text: number; thread: string; dialog_kind: string }
const quiet = () => sleep(t(300)) // timing-ok: negative window: nothing more is sent

describe('the mirror is immediate', () => {
  test('the moment the hook asks, a card per question is out in the default thread, with the question, its options and Other; the agent is not answered yet', async () => {
    const x = await start()
    const call = hook(x.home, permLine(asked(Q1, Q2)))
    await eventually(() => expect(questionCards(x)).toHaveLength(2))
    const [a, b] = questionCards(x) as [CardT, CardT]
    expect(payloadOf(a)).toMatchObject({
      subject: 'Which colour?',
      options: ['Red', 'Blue', 'Other…'],
      free_text: 2,
      dialog_kind: 'agent_question',
    })
    expect(payloadOf(b)).toMatchObject({ subject: 'Which size?', options: ['Small', 'Large', 'Other…'] })
    expect(a.thread_id).toBe(x.bridge.ctx.config.config.default_thread)
    expect(call.lines).toHaveLength(0)
    expect(cardsOf(x, 'permission')).toHaveLength(0) // not the ordinary Allow/Deny card
  })

  test('a thread session’s question goes to that thread (and the card speaks of that session)', async () => {
    const x = await start()
    const decided = x.bridge.ctx.permission.onHookRequest(
      { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(Q1) },
      new AbortController().signal,
    )
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    expect(card.thread_id).toBe('trip')
    expect(card.title).toContain('Trip')
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 0 })
    expect(await decided).toMatchObject({ decision: 'answer', answers: { 0: 'Red' } })
  })
})

describe('a phone answer is the agent’s answer', () => {
  test('a tap on an option: the hook is answered with that label, and the card says it was sent', async () => {
    const x = await start()
    const call = hook(x.home, permLine(asked(Q1)))
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 1 })
    const a = await call.result
    expect(a).toMatchObject({
      t: 'perm_result',
      id: 'req-q1',
      decision: 'answer',
      answers: { 0: 'Blue' },
    })
    await eventually(() =>
      expect(updates(x, card.id).some((u) => u.state === 'done' && u.result?.text === 'Sent to Claude Code')).toBe(
        true,
      ),
    )
  })

  test('Other takes the owner’s own words, signed in the tap', async () => {
    const x = await start()
    const call = hook(x.home, permLine(asked(Q1)))
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 2, text: 'Green, please' })
    expect(await call.result).toMatchObject({ decision: 'answer', answers: { 0: 'Green, please' } })
  })

  test('two questions: the agent is answered only when both are', async () => {
    const x = await start()
    const call = hook(x.home, permLine(asked(Q1, Q2)))
    await eventually(() => expect(questionCards(x)).toHaveLength(2))
    const [a, b] = questionCards(x) as [CardT, CardT]
    await x.app.resolveCard(b, 'primary', b.payload_hash, { choice: 1 })
    await quiet()
    expect(call.lines).toHaveLength(0)
    await x.app.resolveCard(a, 'primary', a.payload_hash, { choice: 0 })
    expect(await call.result).toMatchObject({
      decision: 'answer',
      answers: { 0: 'Red', 1: 'Large' },
    })
  })

  test('a tap that is not one of the buttons, text on a plain button, or Other with no words: refused, the card stays', async () => {
    const x = await start()
    const call = hook(x.home, permLine(asked(Q1)))
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    for (const extra of [{ choice: 7 }, { choice: 0, text: 'sneaky' }, { choice: 2 }, {}]) {
      await x.app.resolveCard(card, 'primary', card.payload_hash, extra)
    }
    await quiet()
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    expect(call.lines).toHaveLength(0)
    await x.app.resolveCard(card, 'kill', card.payload_hash) // a Kill is no answer either
    await quiet()
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
  })
})

describe('ten minutes without an answer', () => {
  test('the agent is told exactly the fixed words for the unanswered ones, ONCE; the answered one keeps its answer; the cards expire', async () => {
    const x = await start(t(400))
    const call = hook(x.home, permLine(asked(Q1, Q2)))
    await eventually(() => expect(questionCards(x)).toHaveLength(2))
    const [a, b] = questionCards(x) as [CardT, CardT]
    await x.app.resolveCard(a, 'primary', a.payload_hash, { choice: 0 })
    const answer = await call.result
    expect(answer).toMatchObject({ decision: 'answer', reason: 'unblocked' })
    expect(answer?.answers).toEqual({ 0: 'Red', 1: NO_ANSWER_YET })
    // Claude Code frames this as "The user answered: ...", so the words themselves say the owner did not answer
    expect(NO_ANSWER_YET).toBe(
      '(No answer from the owner. This is Talos, not the owner.) No answer yet; carry on with other work and ask again later.',
    )
    expect(NO_ANSWER_YET.startsWith('(No answer from the owner. This is Talos, not the owner.) ')).toBe(true)
    await eventually(() =>
      expect(updates(x, b.id).some((u) => u.state === 'expired' && u.reason === 'unblocked')).toBe(true),
    )
    await quiet()
    expect(call.lines).toHaveLength(1) // once
  })

  test('a late phone tap after the unblock does nothing: the card is closed and nothing more reaches the agent', async () => {
    const x = await start(t(300))
    const call = hook(x.home, permLine(asked(Q1)))
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    expect(await call.result).toMatchObject({ decision: 'answer', answers: { 0: NO_ANSWER_YET } })
    await eventually(() => expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('expired'))
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 1 })
    await quiet()
    expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('expired')
    expect(call.lines).toHaveLength(1)
    expect(updates(x, card.id).some((u) => u.state === 'done')).toBe(false)
  })

  test('the unblock needs no phone at all and works for a thread session too', async () => {
    const x = await start(t(300))
    const decided = await x.bridge.ctx.permission.onHookRequest(
      { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(Q1) },
      new AbortController().signal,
    )
    expect(decided).toMatchObject({ decision: 'answer', answers: { 0: NO_ANSWER_YET } })
  })
})

describe('a question answered at the terminal sends nothing', () => {
  test('the hook ends (Claude Code stopped it): the cards close, no answer is sent, and the unblock timer never fires', async () => {
    const x = await start(t(400))
    const call = hook(x.home, permLine(asked(Q1)))
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    call.send({ t: 'perm_over', id: 'req-q1', why: 'parent' })
    call.close()
    await eventually(() => expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('expired'))
    expect(updates(x, card.id).some((u) => u.state === 'expired' && u.reason === 'prompt_over')).toBe(true)
    await sleep(t(700)) // timing-ok: past the unblock time: it must not fire
    expect(call.lines).toHaveLength(0)
    expect(x.bridge.ctx.permission.openCount).toBe(0)
  })

  test('a plain close (a crash) also closes the cards and sends nothing', async () => {
    const x = await start(t(400))
    const call = hook(x.home, permLine(asked(Q1)))
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    call.close()
    const card = questionCards(x)[0] as CardT
    await eventually(() => expect(x.bridge.ctx.ledger.get(card.id)?.state).toBe('expired'))
    await sleep(t(700)) // timing-ok: past the unblock time
    expect(call.lines).toHaveLength(0)
  })
})

describe('everything else is as it was', () => {
  test('an input that is not the AskUserQuestion shape is an ordinary permission card', async () => {
    const x = await start()
    hook(x.home, permLine({ questions: 'nope' }, { id: 'req-q9' }))
    await eventually(() => expect(cardsOf(x, 'permission').length).toBeGreaterThan(0))
    expect(questionCards(x)).toHaveLength(0)
  })

  test('another tool’s permission prompt is the permission card, never a question card, and is not unblocked by time', async () => {
    const x = await start(t(200))
    const call = hook(x.home, permLine({ command: 'touch a' }, { tool_name: 'Bash', id: 'req-b1' }))
    await eventually(() => expect(cardsOf(x, 'permission').length).toBeGreaterThan(0))
    await sleep(t(600)) // timing-ok: past the question unblock time: a permission prompt never answers itself
    expect(questionCards(x)).toHaveLength(0)
    expect(call.lines).toHaveLength(0)
  })

  test('the strings are in the table: the fixed words are not written in question.ts', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'permission', 'question.ts'), 'utf8')
    expect(src).not.toMatch(/No answer yet|carry on with other work|Sent to Claude Code/)
  })
})

describe('the real kit hook', () => {
  const KIT = join(import.meta.dir, '..', '..', '..', 'kit', 'hooks', 'permission-relay.py')
  const stdin = (input: unknown) =>
    JSON.stringify({
      session_id: 's1',
      transcript_path: '/nonexistent/t.jsonl',
      cwd: '/srv/proj',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: input,
      permission_suggestions: [],
    })
  const run = (home: string, input: unknown) =>
    Bun.spawn(['python3', KIT], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', TALOS_APP_HOME: home },
      stdin: new Blob([stdin(input)]),
      stdout: 'pipe',
      stderr: 'pipe',
    })

  test('a phone answer: the hook prints allow with the SAME questions and the answers, and nothing else', async () => {
    const x = await start()
    const proc = run(x.home, asked(Q1, Q2))
    await eventually(() => expect(questionCards(x)).toHaveLength(2))
    const [a, b] = questionCards(x) as [CardT, CardT]
    await x.app.resolveCard(a, 'primary', a.payload_hash, { choice: 1 })
    await x.app.resolveCard(b, 'primary', b.payload_hash, { choice: 2, text: 'Medium' })
    expect(await proc.exited).toBe(0)
    const out = JSON.parse(await new Response(proc.stdout).text())
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: { questions: [Q1, Q2], answers: { 'Which colour?': 'Blue', 'Which size?': 'Medium' } },
        },
      },
    })
  })

  test('the unblock reaches the agent through the hook as the fixed words', async () => {
    const x = await start(t(500))
    const proc = run(x.home, asked(Q1))
    expect(await proc.exited).toBe(0)
    const out = JSON.parse(await new Response(proc.stdout).text())
    expect(out.hookSpecificOutput.decision.updatedInput.answers).toEqual({ 'Which colour?': NO_ANSWER_YET })
  })

  test('an answer that names a question the input did not ask is dropped; an answer for none prints nothing (the prompt stays)', async () => {
    const x = await start()
    const proc = run(x.home, asked(Q1))
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    // the bridge side cannot be made to lie from here, so drive the hook's own check directly
    const py = Bun.spawnSync(
      [
        'python3',
        '-c',
        `import importlib.util,sys\nspec=importlib.util.spec_from_file_location('pr', ${JSON.stringify(KIT)})\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nprint(m.answers_of({'0':' Blue\\n x ','5':'x','a':'y',3:'y'}, {'questions':[{'question':'Which colour?'}]}))\nprint(m.answers_of({'1':'x'}, {'questions':[{'question':'Which colour?'}]}))\nprint(m.answers_of('nope', None))`,
      ],
      { env: { PATH: process.env.PATH ?? '' } },
    )
    const lines = new TextDecoder().decode(py.stdout).trim().split('\n')
    expect(lines).toEqual(["{'Which colour?': 'Blue x'}", '{}', '{}'])
    proc.kill()
  })
})

// ---- review fixes (the card never refuses on the question; a restarted bridge; answers by index; the pane reader) ----

const longQuestion = (n: number) =>
  `${'Which of these should the plan start from? '.repeat(Math.ceil(n / 41))}`.slice(0, n)

describe('a question the card must show as it is (never refuse on it)', () => {
  test('a 200-character question gets its card, whole, and its answer goes back by position', async () => {
    const x = await start()
    const q = { ...Q1, question: longQuestion(200) }
    const decided = x.bridge.ctx.permission.onHookRequest(
      { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(q) },
      new AbortController().signal,
    )
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    expect(payloadOf(card).subject).toBe(q.question.trim())
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 0 })
    expect(await decided).toMatchObject({ decision: 'answer', answers: { 0: 'Red' } })
  })

  test('a question with a line break gets its card, the break shown as a marker; over 500 characters it is clipped, not refused', async () => {
    const x = await start()
    const two = { ...Q1, question: 'Which colour?\nPick one.' }
    const huge = { ...Q2, question: longQuestion(900) }
    x.bridge.ctx.permission
      .onHookRequest(
        { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(two, huge) },
        new AbortController().signal,
      )
      .catch(() => {})
    await eventually(() => expect(questionCards(x)).toHaveLength(2))
    const [a, b] = questionCards(x) as [CardT, CardT]
    expect(payloadOf(a).subject).toBe(dialogVisibleText('Which colour?\nPick one.'))
    expect(payloadOf(a).subject).toContain('U+000A')
    expect([...payloadOf(b).subject].length).toBeLessThanOrEqual(500)
    expect(payloadOf(b).subject.length).toBeGreaterThan(100)
  })

  test('no card could be sent: the ask stays open for the timer, but the pane reader is NOT held off (its card is the only one possible)', async () => {
    const x = await start(t(2_000))
    Object.assign(x.bridge.ctx.transport, { sendDurable: () => Promise.reject(new Error('relay down')) })
    const decided = x.bridge.ctx.permission.onHookRequest(
      { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(Q1) },
      new AbortController().signal,
    )
    await quiet()
    expect(x.bridge.ctx.questions?.pendingFor('trip')).toBe(false)
    expect(await decided).toMatchObject({ reason: 'unblocked' })
  })

  test('no card can be sent: the agent is still released after the unblock time (it is never left waiting for ever)', async () => {
    const x = await start(t(300))
    Object.assign(x.bridge.ctx.transport, { sendDurable: () => Promise.reject(new Error('relay down')) })
    const decided = await x.bridge.ctx.permission.onHookRequest(
      { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(Q1, Q2) },
      new AbortController().signal,
    )
    expect(decided).toMatchObject({
      decision: 'answer',
      reason: 'unblocked',
      answers: { 0: NO_ANSWER_YET, 1: NO_ANSWER_YET },
    })
    expect(x.bridge.ctx.ledger.get((questionCards(x)[0] as CardT | undefined)?.id ?? '')?.state ?? 'expired').not.toBe(
      'pending',
    )
  })
})

describe('a multi-select question', () => {
  const QM = { ...Q1, multiSelect: true }
  test('is offered as a card and a tap answers it like any other', async () => {
    const x = await start()
    const decided = x.bridge.ctx.permission.onHookRequest(
      { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(QM) },
      new AbortController().signal,
    )
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    expect(payloadOf(card).options).toEqual(['Red', 'Blue', 'Other…'])
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 1 })
    expect(await decided).toMatchObject({ decision: 'answer', answers: { 0: 'Blue' } })
  })

  test('one multi-select and one single question together: both keep their place; the unblock fills the open one', async () => {
    const x = await start(t(400))
    const decided = x.bridge.ctx.permission.onHookRequest(
      { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(Q2, QM) },
      new AbortController().signal,
    )
    await eventually(() => expect(questionCards(x)).toHaveLength(2))
    const [a] = questionCards(x) as [CardT, CardT]
    await x.app.resolveCard(a, 'primary', a.payload_hash, { choice: 0 })
    expect(await decided).toMatchObject({ answers: { 0: 'Small', 1: NO_ANSWER_YET } })
  })
})

describe('the pane reader makes no second card for a question the phone already has', () => {
  const ASK_PANE_ID = 'Qq5Qm8ZtRx3Cw9PkNa2HdB'
  const iso = (ms: number) => new Date(ms).toISOString()
  async function startPane() {
    h = await startHarness({
      relay: { relayFeatures: ['schedules/1', 'thread-sessions/1', NEEDS_YOU_FEATURE] },
      config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
        ...c,
        permission_relay: true,
        dedicated: { enabled: true },
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
      })) as never,
    })
    h.bridge.ctx.permission.setHookTimings({ graceMs: 150 })
    h.bridge.ctx.permission.setSessionPids([SESSION_PID])
    h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
    return h
  }
  const showOnPane = (x: Harness) => {
    const now = x.bridge.ctx.clock.now()
    writeFileSync(
      join(x.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: iso(now), workers_supported: true },
        threads: {
          trip: {
            state: 'live',
            session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
            tmux: 't-trip',
            pane_pid: 0,
            cwd: x.home,
            error: null,
            dialog: {
              id: ASK_PANE_ID,
              kind: 'agent_question',
              subject: 'Which colour?',
              options: ['Red', 'Blue', 'Other…', 'Chat about this'],
              cursor: null,
              free_text: 2,
              seen_at: iso(now),
              expires_at: iso(now + 900_000),
            },
          },
        },
      }),
    )
    x.bridge.optionCTick()
  }
  const paneCards = (x: Harness) =>
    cardsOf(x, 'dialog').filter((c) => (c.payload as { dialog_id?: string }).dialog_id === ASK_PANE_ID)

  test('control: with no question asked through the hook, the pane reader does make its card', async () => {
    const x = await startPane()
    showOnPane(x)
    await eventually(() => expect(paneCards(x)).toHaveLength(1))
  })

  test('the pane card arriving while the phone question waits, and in the seconds after it was answered, is not made', async () => {
    const x = await startPane()
    const decided = x.bridge.ctx.permission.onHookRequest(
      { thread: 'trip', tool_name: 'AskUserQuestion', tool_input: asked(Q1) },
      new AbortController().signal,
    )
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    showOnPane(x)
    await quiet()
    expect(paneCards(x)).toHaveLength(0)
    const card = questionCards(x)[0] as CardT
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 0 })
    await decided
    // the screen still shows the question for a moment: the reader sees it again
    showOnPane(x)
    await quiet()
    expect(paneCards(x)).toHaveLength(0)
  })
})

describe('the real kit hook: a restarted bridge, and answers only where they belong', () => {
  const KIT = join(import.meta.dir, '..', '..', '..', 'kit', 'hooks', 'permission-relay.py')
  const hookIn = (tool: string, input: unknown) =>
    JSON.stringify({
      session_id: 's1',
      transcript_path: '/nonexistent/t.jsonl',
      cwd: '/srv/proj',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: tool,
      tool_input: input,
      permission_suggestions: [],
    })
  const spawnHook = (home: string, tool: string, input: unknown, env: Record<string, string> = {}) =>
    Bun.spawn(['python3', KIT], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', TALOS_APP_HOME: home, ...env },
      stdin: new Blob([hookIn(tool, input)]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  const dirs: string[] = []
  const servers: Server[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.close()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** A stand-in hub in a folder of its own: `script` is told which connection this is (1, 2, ...) and what the hook sent. */
  async function standIn(
    script: (n: number, msg: Record<string, unknown>, sock: Socket, hub: { restartAfter(ms: number): void }) => void,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'qh'))
    dirs.push(dir)
    mkdirSync(join(dir, 'run'))
    writeFileSync(join(dir, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }))
    const path = join(dir, 'run', 'hub.sock')
    let n = 0
    const seen: Record<string, unknown>[] = []
    let server: Server
    const listen = () =>
      new Promise<void>((resolve) => {
        server = createServer((sock) => {
          let buf = ''
          sock.on('error', () => {})
          sock.on('data', (d) => {
            buf += d.toString('utf8')
            const nl = buf.indexOf('\n')
            if (nl < 0) return
            const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
            buf = ''
            seen.push(msg)
            n += 1
            script(n, msg, sock, hub)
          })
        })
        servers.push(server)
        server.listen(path, () => resolve())
      })
    const hub = {
      restartAfter: (ms: number) => {
        server.close()
        setTimeout(() => void listen(), ms)
      },
    }
    await listen()
    return { dir, seen }
  }

  test('the bridge restarts while the question waits: the hook asks again, and the new bridge’s answer completes the tool', async () => {
    const hub = await standIn((n, msg, sock, h) => {
      if (n === 1) {
        h.restartAfter(1200) // the old bridge goes away, the new one is listening a moment later
        sock.destroy()
        return
      }
      sock.write(
        `${JSON.stringify({ t: 'perm_result', id: msg.id, decision: 'answer', reason: 'owner', answers: { 0: 'Blue' } })}\n`,
      )
    })
    const proc = spawnHook(hub.dir, 'AskUserQuestion', asked(Q1))
    expect(await proc.exited).toBe(0)
    const out = JSON.parse(await new Response(proc.stdout).text())
    expect(out.hookSpecificOutput.decision).toEqual({
      behavior: 'allow',
      updatedInput: { questions: [Q1], answers: { 'Which colour?': 'Blue' } },
    })
    expect(hub.seen).toHaveLength(2)
    expect(hub.seen[1]).toMatchObject({ t: 'perm', tool_name: 'AskUserQuestion' })
  })

  test('a bridge that never comes back: the hook gives up (prints nothing, the prompt stays) after a bounded number of tries', async () => {
    const hub = await standIn((_n, _msg, sock, h) => {
      sock.destroy()
      h.restartAfter(3_600_000) // never within the test
    })
    const proc = spawnHook(hub.dir, 'AskUserQuestion', asked(Q1), { TALOS_PERMISSION_HOOK_WAIT_S: '7' })
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe('')
    expect(hub.seen).toHaveLength(1)
  })

  test('on a retry the socket is briefly NOT the bridge in bridge.pid (a takeover moment): the hook tries again, and the tool input is not sent to it', async () => {
    let dir = ''
    const hub = await standIn((n, msg, sock) => {
      if (n === 1) {
        writeFileSync(join(dir, 'bridge.pid'), JSON.stringify({ pid: 1, started_at: '', instance: 'other' }))
        setTimeout(() => {
          writeFileSync(join(dir, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }))
        }, t(1_600)) // timing-ok: the takeover ends after the hook's second try and before its third
        sock.destroy()
        return
      }
      sock.write(`${JSON.stringify({ t: 'perm_result', id: msg.id, decision: 'answer', reason: 'owner', answers: { 0: 'Red' } })}
`)
    })
    dir = hub.dir
    const proc = spawnHook(hub.dir, 'AskUserQuestion', asked(Q1))
    expect(await proc.exited).toBe(0)
    const out = JSON.parse(await new Response(proc.stdout).text())
    expect(out.hookSpecificOutput.decision.updatedInput.answers).toEqual({ 'Which colour?': 'Red' })
    expect(hub.seen).toHaveLength(2) // the mismatched try sent nothing
  })

  test('the FIRST attempt against a socket that is not the bridge in bridge.pid still sends nothing and does not retry', async () => {
    const hub = await standIn((_n, _msg, sock) => sock.destroy())
    writeFileSync(join(hub.dir, 'bridge.pid'), JSON.stringify({ pid: 1, started_at: '', instance: 'other' }))
    const proc = spawnHook(hub.dir, 'AskUserQuestion', asked(Q1))
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe('')
    expect(hub.seen).toHaveLength(0)
  })

  test('any other tool’s prompt is NOT asked again when the connection drops', async () => {
    const hub = await standIn((_n, _msg, sock) => sock.destroy())
    const proc = spawnHook(hub.dir, 'Bash', { command: 'touch a' })
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe('')
    expect(hub.seen).toHaveLength(1)
  })

  test('an `answer` for a tool that is not AskUserQuestion is ignored: nothing is printed, the prompt stays', async () => {
    const hub = await standIn((_n, msg, sock) => {
      sock.write(
        `${JSON.stringify({ t: 'perm_result', id: msg.id, decision: 'answer', reason: 'owner', answers: { 0: 'Blue' } })}\n`,
      )
    })
    const proc = spawnHook(hub.dir, 'Bash', { command: 'touch a' })
    expect(await proc.exited).toBe(0)
    expect(await new Response(proc.stdout).text()).toBe('')
  })

  test('answers go by position: two questions with the very same words each keep their own answer, and a long answer still arrives whole', async () => {
    const same = { ...Q1, question: 'Which?' }
    const other = { ...Q2, question: 'Which?' }
    const hub = await standIn((_n, msg, sock) => {
      sock.write(
        `${JSON.stringify({ t: 'perm_result', id: msg.id, decision: 'answer', reason: 'owner', answers: { 0: 'Red', 1: 'x'.repeat(5000) } })}\n`,
      )
    })
    const proc = spawnHook(hub.dir, 'AskUserQuestion', asked(same, other))
    expect(await proc.exited).toBe(0)
    const out = JSON.parse(await new Response(proc.stdout).text())
    // both questions are asked under the same text, so the one map Claude Code reads has one key; the LAST position wins, clipped to one line of 500
    expect(Object.keys(out.hookSpecificOutput.decision.updatedInput.answers)).toEqual(['Which?'])
    expect(out.hookSpecificOutput.decision.updatedInput.answers['Which?']).toBe('x'.repeat(500))
  })

  test('multiSelect: true questions come back in the hook’s output untouched, with the answers beside them', async () => {
    const x = await start()
    const QM = { ...Q1, multiSelect: true }
    const proc = spawnHook(x.home, 'AskUserQuestion', asked(QM))
    await eventually(() => expect(questionCards(x)).toHaveLength(1))
    const card = questionCards(x)[0] as CardT
    await x.app.resolveCard(card, 'primary', card.payload_hash, { choice: 0 })
    expect(await proc.exited).toBe(0)
    const out = JSON.parse(await new Response(proc.stdout).text())
    expect(out.hookSpecificOutput.decision.updatedInput).toEqual({
      questions: [QM],
      answers: { 'Which colour?': 'Red' },
    })
  })
})

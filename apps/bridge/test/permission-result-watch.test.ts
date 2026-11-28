// A hook card that knows its call's exact tool_use id (the permission hook tied its prompt to exactly one PreToolUse record) is closed by the
// BRIDGE when that id's tool_result shows up in the session's transcript: the prompt is over, however it was answered. Only an exact id counts:
// another call's result, a copy of a message inside another record kind, a record that is not a top-level user record, a transcript
// path of the wrong shape, or no id at all, never closes anything. It watches only while the card is pending, reads only appended bytes,
// and has no time limit. Closing it is `prompt_over`: the card expires, the hook is released with none, and nothing is raised again
// (a replaced or claimed channel card stays as it is). Unit tests of the path check and the reader, then the live bridge.
// (`touch probe-N` is only a synthetic hook input.)
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CardT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { ResultWatch, safeTranscriptPath } from '../src/permission/transcript-watch.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

const SID = '9a7c1e52-0b3d-4f6a-8c21-5d4e3f2a1b00'
const ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA'
const OTHER = 'toolu_01BBBBBBBBBBBBBBBBBBBBBB'
const tmps: string[] = []
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)))
  tmps.push(d)
  return d
}
/** `<root>/projects/<slug>/<SID>.jsonl`: the shape Claude Code gives a hook. */
const transcriptIn = (root: string) => {
  const dir = join(root, 'projects', '-srv-proj')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${SID}.jsonl`)
}
const result = (id: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra })}\n`
const use = (id: string) =>
  `${JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'touch probe-1' } }] } })}\n`

const sockets: { destroy(): void }[] = []
let h: Harness | undefined
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await h?.stop()
  h = undefined
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('safeTranscriptPath: only the shape Claude Code gives a hook', () => {
  const root = '/home/alex/.claude'
  const good = `${root}/projects/-srv-proj/${SID}.jsonl`
  test('accepts the main transcript', () => {
    expect(safeTranscriptPath(good, SID, undefined)).toBe(good)
  })
  test('a subagent: the file beside it, under the session folder', () => {
    expect(safeTranscriptPath(good, SID, 'a0edd2143fc3f099d')).toBe(
      `${root}/projects/-srv-proj/${SID}/subagents/agent-a0edd2143fc3f099d.jsonl`,
    )
  })
  test.each([
    ['relative', `projects/-srv-proj/${SID}.jsonl`],
    ['a dot-dot', `${root}/projects/-srv-proj/../-srv-proj/${SID}.jsonl`],
    ['the wrong file name', `${root}/projects/-srv-proj/other.jsonl`],
    ['not under projects', `${root}/x/-srv-proj/${SID}.jsonl`],
    ['too shallow', `/${SID}.jsonl`],
    ['a nul', `${root}/projects/-srv-proj/${SID}.jsonl\0`],
  ])('refuses %s', (_why, p) => {
    expect(safeTranscriptPath(p, SID, undefined)).toBeUndefined()
  })
  test.each(['', 'a/b', '..', 'x y', 'x'.repeat(101)])('refuses a session id of %j', (sid) => {
    expect(safeTranscriptPath(`${root}/projects/-p/${sid}.jsonl`, sid, undefined)).toBeUndefined()
  })
  test.each(['', 'a/b', '../x', 'x y', 'x'.repeat(101)])('refuses an agent id of %j', (aid) => {
    expect(safeTranscriptPath(good, SID, aid)).toBeUndefined()
  })
  test('refuses non-text', () => {
    expect(safeTranscriptPath(undefined, SID, undefined)).toBeUndefined()
    expect(safeTranscriptPath(good, undefined, undefined)).toBeUndefined()
  })
})

describe('ResultWatch: an exact id, a top-level user record, appended bytes', () => {
  test('the result for the id is found; another id, an assistant record, and other record kinds are not', () => {
    const f = transcriptIn(tmp('rw-'))
    writeFileSync(f, use(ID))
    const w = new ResultWatch(f, ID)
    expect(w.poll()).toBe(false)
    appendFileSync(f, result(OTHER))
    appendFileSync(
      f,
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_result', tool_use_id: ID }] } })}\n`,
    )
    appendFileSync(
      f,
      `${JSON.stringify({ type: 'api-request-blob', hash: 'h', message: { content: [{ type: 'tool_result', tool_use_id: ID }] } })}\n`,
    )
    appendFileSync(f, `${JSON.stringify({ type: 'queue-operation', content: `<channel> ${ID} </channel>` })}\n`)
    appendFileSync(f, `${JSON.stringify({ type: 'user', message: { role: 'user', content: `the id is ${ID}` } })}\n`)
    expect(w.poll()).toBe(false)
    appendFileSync(f, result(ID))
    expect(w.poll()).toBe(true)
  })

  test('a line written in two pieces is read once it is whole', () => {
    const f = transcriptIn(tmp('rw-'))
    writeFileSync(f, '')
    const w = new ResultWatch(f, ID)
    const line = result(ID)
    appendFileSync(f, line.slice(0, 40))
    expect(w.poll()).toBe(false)
    appendFileSync(f, line.slice(40))
    expect(w.poll()).toBe(true)
  })

  test('the file is not there yet: false, and found once it is written', () => {
    const f = transcriptIn(tmp('rw-'))
    const w = new ResultWatch(f, ID)
    expect(w.poll()).toBe(false)
    writeFileSync(f, result(ID))
    expect(w.poll()).toBe(true)
  })

  test('reads only what was appended, and only the end of an old file at first', () => {
    const f = transcriptIn(tmp('rw-'))
    // 5 MB of old lines, the result for the id long before them: not found (only the last 1 MB is looked at first)
    writeFileSync(f, result(ID) + `${JSON.stringify({ type: 'system', pad: 'x'.repeat(1000) })}\n`.repeat(5000))
    const w = new ResultWatch(f, ID)
    expect(w.poll()).toBe(false)
    appendFileSync(f, result(ID))
    expect(w.poll()).toBe(true)
  })

  test('a result just before the first look (inside the look-back) is found', () => {
    const f = transcriptIn(tmp('rw-'))
    writeFileSync(f, `${JSON.stringify({ type: 'system', pad: 'x'.repeat(1000) })}\n`.repeat(100) + result(ID))
    expect(new ResultWatch(f, ID).poll()).toBe(true)
  })

  test('a file that was cut shorter is read again from the start', () => {
    const f = transcriptIn(tmp('rw-'))
    writeFileSync(f, `${JSON.stringify({ type: 'system', pad: 'x'.repeat(2000) })}\n`)
    const w = new ResultWatch(f, ID)
    expect(w.poll()).toBe(false)
    truncateSync(f, 0)
    writeFileSync(f, result(ID))
    expect(w.poll()).toBe(true)
  })

  test('a FIFO (a pipe left where the transcript should be) is not waited on: false at once', () => {
    const root = tmp('rw-')
    const f = transcriptIn(root)
    expect(Bun.spawnSync(['mkfifo', f]).exitCode).toBe(0)
    const started = Date.now()
    expect(new ResultWatch(f, ID).poll()).toBe(false)
    expect(Date.now() - started).toBeLessThan(t(1000))
  })

  test('the file is opened without following a link and without waiting, and judged by the open file, never by a path looked at before', () => {
    const src = readFileSync(new URL('../src/permission/transcript-watch.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/O_NOFOLLOW/)
    expect(src).toMatch(/O_NONBLOCK/)
    expect(src).toMatch(/fstatSync\(fd\)/)
    expect(src).not.toMatch(/lstatSync/)
  })

  test('at most 4 MB is read in one look: a big appended block is read over several looks', () => {
    const f = transcriptIn(tmp('rw-'))
    writeFileSync(f, use(ID))
    const w = new ResultWatch(f, ID)
    expect(w.poll()).toBe(false)
    const pad = `${JSON.stringify({ type: 'system', pad: 'x'.repeat(1000) })}\n`
    appendFileSync(f, pad.repeat(12_000)) // about 12 MB, then the result
    appendFileSync(f, result(ID))
    let polls = 1
    while (!w.poll() && polls < 10) polls++
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(polls).toBeLessThanOrEqual(5)
  })

  test('after the file was cut shorter it starts again from the last megabyte, not from the top', () => {
    const f = transcriptIn(tmp('rw-'))
    const pad = `${JSON.stringify({ type: 'system', pad: 'x'.repeat(1000) })}\n`
    writeFileSync(f, pad.repeat(6000)) // about 6 MB
    const w = new ResultWatch(f, ID)
    expect(w.poll()).toBe(false)
    truncateSync(f, 0)
    writeFileSync(f, result(ID) + pad.repeat(5000)) // the result at the very top of 5 MB: more than a megabyte from the end
    for (let i = 0; i < 4; i++) expect(w.poll()).toBe(false)
    appendFileSync(f, result(ID)) // a result written after that is found
    let found = false
    for (let i = 0; i < 4 && !found; i++) found = w.poll()
    expect(found).toBe(true)
  })

  test('a line over 8 MB is dropped rather than held, and the lines after it are still read', () => {
    const f = transcriptIn(tmp('rw-'))
    writeFileSync(f, '')
    const w = new ResultWatch(f, ID)
    expect(w.poll()).toBe(false)
    appendFileSync(f, 'x'.repeat(9 * 1024 * 1024)) // no newline yet
    for (let i = 0; i < 4; i++) w.poll() // 4 + 4 + 1 MB: the carry passes 8 MB at the third look
    expect((w as unknown as { carry: Buffer }).carry.length).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect((w as unknown as { carry: Buffer }).carry.length).toBe(0)
    appendFileSync(f, `\n${result(ID)}`)
    let found = false
    for (let i = 0; i < 4 && !found; i++) found = w.poll()
    expect(found).toBe(true)
  })

  test('a link is not read', () => {
    const root = tmp('rw-')
    const real = join(root, 'real.jsonl')
    writeFileSync(real, result(ID))
    const f = transcriptIn(root)
    symlinkSync(real, f)
    expect(new ResultWatch(f, ID).poll()).toBe(false)
  })
})

// ---- the live bridge ------------------------------------------------------------------------------------------------------

const SESSION_PID = 4_242_424
const main = { pid: SESSION_PID, cwd: '/srv/proj' }
const RULES = [{ tool: 'Bash', content: 'touch probe-*' }]
const touch = { command: 'touch probe-1' }
const PREVIEW = '{"command": "touch probe-1"}'
const relayParams = (request_id = 'abcde') => ({
  request_id,
  tool_name: 'Bash',
  description: 'Run it',
  input_preview: PREVIEW,
})
const RELAY_IDS = new Set(['abcde', 'fghij'])

async function start() {
  h = await startHarness({ config: ((c: Record<string, unknown>) => ({ ...c, permission_relay: true })) as never })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 150, watchMs: 40 })
  h.bridge.ctx.permission.setSessionPids([SESSION_PID])
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}
type Answer = Record<string, unknown> & { t: string; id: string; decision: string }
function hook(home: string, line: Record<string, unknown>) {
  const sock = createConnection(join(home, 'run', 'hub.sock'))
  sockets.push(sock)
  sock.setEncoding('utf8')
  let buf = ''
  let settle: (a: Answer | null) => void = () => {}
  const answer = new Promise<Answer | null>((r) => {
    settle = r
  })
  sock.on('data', (d: string) => {
    buf += d
    const nl = buf.indexOf('\n')
    if (nl >= 0) settle(JSON.parse(buf.slice(0, nl)) as Answer)
  })
  sock.on('close', () => settle(null))
  sock.on('error', () => settle(null))
  sock.on('connect', () => sock.write(`${JSON.stringify(line)}\n`))
  return { answer, close: () => sock.destroy() }
}
/** The perm line of a hook that tied its prompt to `toolUseId`. */
const permLine = (over: Record<string, unknown> = {}) => ({
  t: 'perm',
  id: 'req-1',
  tool_name: 'Bash',
  tool_input: touch,
  session_id: SID,
  ...over,
})
const idLine = (transcript: string, extra: Record<string, unknown> = {}) =>
  permLine({ ...main, suggest: { rules: RULES }, tool_use_id: ID, transcript_path: transcript, ...extra })

const created = (x: Harness) =>
  x.relay.frames
    .filter(
      (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
    )
    .map((f) => (f.frame as { card: CardT }).card)
const hookCards = (x: Harness) =>
  created(x).filter((c) => !RELAY_IDS.has((c.payload as { request_id?: string }).request_id ?? ''))
const relayCards = (x: Harness) =>
  created(x).filter((c) => RELAY_IDS.has((c.payload as { request_id?: string }).request_id ?? ''))
const expiredReason = (x: Harness, cardId: string) =>
  (
    x.relay.frames.find(
      (f) =>
        f.direction === 'from_bridge' &&
        f.frame.type === 'card.update' &&
        f.frame.card_id === cardId &&
        f.frame.state === 'expired',
    )?.frame as { reason?: string } | undefined
  )?.reason
const nextHookCard = async (x: Harness) => {
  await eventually(() => expect(hookCards(x).length).toBeGreaterThanOrEqual(1))
  return hookCards(x)[0] as CardT
}
const watching = (x: Harness) => (x.bridge.ctx.permission as unknown as { watches: Map<string, unknown> }).watches.size
const quiet = () => sleep(t(400)) // timing-ok: negative window: the card must stay, nothing is raised again

describe('the bridge closes a hook card when its exact id has a result', () => {
  test('the result for the id appears: the card expires as prompt_over, the hook is released with none, nothing is raised again', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID))
    const call = hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
    expect(await call.answer).toMatchObject({ t: 'perm_result', id: 'req-1', decision: 'none', reason: 'prompt_over' })
    await quiet()
    expect(relayCards(x)).toHaveLength(0)
    expect(watching(x)).toBe(0)
  })

  test('a replaced channel card stays replaced: nothing comes back when the id has its result', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams())
    const first = relayCards(x)[0] as CardT
    hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    await eventually(() => expect(expiredReason(x, first.id)).toBe('replaced_by_hook'))
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
    await quiet()
    expect(relayCards(x)).toHaveLength(1)
  })

  test('a claimed channel request (the hook came first) is not made into a card either', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID))
    hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    await x.bridge.ctx.permission.onRequest(relayParams())
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
    await quiet()
    expect(relayCards(x)).toHaveLength(0)
  })

  test('a result written LATE (the file did not exist when the card was raised) closes it on arrival', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    await quiet()
    writeFileSync(f, use(ID) + result(ID))
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
  })

  test('there is no time limit: a card a long time open is still closed by its result', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID))
    hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    await sleep(t(1200)) // timing-ok: many polls pass with nothing
    expect(watching(x)).toBe(1)
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
  })

  test('a subagent: its own file counts, the main file does not', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    const aid = 'a0edd2143fc3f099d'
    const sub = join(dirname(f), SID, 'subagents', `agent-${aid}.jsonl`)
    mkdirSync(dirname(sub), { recursive: true })
    writeFileSync(f, use(ID))
    writeFileSync(sub, use(ID))
    hook(x.home, idLine(f, { agent_id: aid }))
    const card = await nextHookCard(x)
    appendFileSync(f, result(ID)) // the MAIN file has a result for the same id: not this call's file
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    appendFileSync(sub, result(ID))
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
  })
})

describe('nothing else ever closes it', () => {
  test('another call with the same name and input finishing (another id) closes nothing', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID) + use(OTHER))
    hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    appendFileSync(f, result(OTHER))
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    expect(watching(x)).toBe(1)
  })

  test('records that are not a top-level user record with that result close nothing', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID))
    hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    appendFileSync(
      f,
      `${JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'tool_result', tool_use_id: ID }] } })}\n`,
    )
    appendFileSync(
      f,
      `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `<channel>${ID}</channel>` })}\n`,
    )
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
  })

  test('no id from the hook: nothing is watched, whatever the transcript holds', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID) + result(ID))
    hook(x.home, idLine(f, { tool_use_id: undefined }))
    const card = await nextHookCard(x)
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    expect(watching(x)).toBe(0)
  })

  test('a transcript path of the wrong shape: nothing is watched', async () => {
    const x = await start()
    const root = tmp('rb-')
    const bad = join(root, 'elsewhere', `${SID}.jsonl`) // not under projects/<slug>/
    mkdirSync(dirname(bad), { recursive: true })
    writeFileSync(bad, use(ID) + result(ID))
    hook(x.home, idLine(bad))
    const card = await nextHookCard(x)
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    expect(watching(x)).toBe(0)
  })

  test('a record of another session id (a transcript path for another session) is not this session', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID) + result(ID))
    hook(x.home, idLine(f, { session_id: 'some-other-session' })) // the path's file name is not that session's
    const card = await nextHookCard(x)
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    expect(watching(x)).toBe(0)
  })

  test('a plain kill of the hook (no result): the card closes as before, the channel card comes back and is watched', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID))
    await x.bridge.ctx.permission.onRequest(relayParams())
    const call = hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    await eventually(() => expect(expiredReason(x, (relayCards(x)[0] as CardT).id)).toBe('replaced_by_hook'))
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
    expect(expiredReason(x, card.id)).toBe('hook_gone')
    expect(watching(x)).toBe(1) // the channel card that came back keeps the watch (permission-reraise-watch.test.ts)
  })

  test('the owner answers the card: the watch is gone, a later result changes nothing', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rb-'))
    writeFileSync(f, use(ID))
    const call = hook(x.home, idLine(f))
    const card = await nextHookCard(x)
    expect(watching(x)).toBe(1)
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    expect(await call.answer).toMatchObject({ decision: 'allow' })
    expect(watching(x)).toBe(0)
    appendFileSync(f, result(ID))
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
  })

  test('the transcript is read from the end: its content is never needed (a copy of the file is not made)', () => {
    expect(readFileSync(new URL('../src/permission/transcript-watch.ts', import.meta.url), 'utf8')).not.toMatch(
      /readFileSync\(/,
    )
  })
})

// ---- end to end: the real pre hook, the real permission hook, the real bridge ------------------------------------------------------

describe('end to end with the real hooks and the real bridge', () => {
  const KIT = join(import.meta.dir, '..', '..', '..', 'kit', 'hooks')
  const stdinFor = (event: 'PreToolUse' | 'PermissionRequest', tx: string, agent?: string) =>
    JSON.stringify({
      session_id: SID,
      transcript_path: tx,
      cwd: '/srv/proj',
      permission_mode: 'default',
      ...(agent ? { agent_id: agent } : {}),
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: touch,
      ...(event === 'PreToolUse' ? { tool_use_id: ID } : { permission_suggestions: [] }),
    })
  // Every child these tests start is ended after each test, passing or failing: a test that throws while a hook is frozen must not
  // leave a stopped process behind (SIGKILL works on a stopped process; SIGCONT alone would let it run on).
  const started: { kill(signal: NodeJS.Signals): void }[] = []
  afterEach(() => {
    for (const p of started.splice(0)) {
      try {
        p.kill('SIGKILL')
      } catch {}
    }
  })
  const run = (script: string[], home: string, stdin: string) => {
    const child = Bun.spawn(script, {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', TALOS_APP_HOME: home },
      stdin: new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    started.push(child)
    return child
  }

  // The real hook watches the transcript it was given for its own call's result too (once a second, in permission-relay.py's
  // ask_bridge) and ends by itself when it sees one, which closes the card as hook_gone. In the two tests below the result is written
  // where the BRIDGE must not act on it, so the hook is FROZEN (SIGSTOP) while the check runs: it cannot look, however slow the
  // machine or large the time factor, and nothing here depends on how long a wall-clock window is. The event that matters is the
  // bridge's own look at the file after the result was written, which is counted (ResultWatch.poll).
  let looks = 0
  const realPoll = ResultWatch.prototype.poll
  beforeEach(() => {
    looks = 0
    ResultWatch.prototype.poll = function (this: ResultWatch) {
      looks++
      return realPoll.call(this)
    }
  })
  afterEach(() => {
    ResultWatch.prototype.poll = realPoll
  })
  const freeze = (p: { kill(signal: NodeJS.Signals): void }) => p.kill('SIGSTOP')
  const thaw = (p: { kill(signal: NodeJS.Signals): void }) => p.kill('SIGCONT')
  /** Returns once the bridge has looked at its transcript at least `n` times more (a look already running when this starts does not count). */
  const bridgeLooks = async (n = 4) => {
    const from = looks
    await eventually(() => expect(looks).toBeGreaterThanOrEqual(from + n))
  }

  test('Yes at the terminal: the call finishes, its result is written, and the card on the phone closes by itself', async () => {
    const x = await start()
    const tx = transcriptIn(tmp('e2e-'))
    writeFileSync(tx, use(ID))
    const pre = run(['sh', join(KIT, 'permission-pre.sh')], x.home, stdinFor('PreToolUse', tx))
    expect(await pre.exited).toBe(0)
    const hookProc = run(['python3', join(KIT, 'permission-relay.py')], x.home, stdinFor('PermissionRequest', tx))
    const card = await nextHookCard(x)
    await eventually(() => expect(watching(x)).toBe(1)) // the hook named its call, so the bridge is watching it
    await quiet()
    expect(expiredReason(x, card.id)).toBeUndefined()
    appendFileSync(tx, result(ID)) // the owner pressed Yes at the terminal and the tool finished
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
    expect(await hookProc.exited).toBe(0) // released with none: it exits, printing nothing
    expect(await new Response(hookProc.stdout).text()).toBe('')
    expect(watching(x)).toBe(0)
  })

  test('a subagent call: the same, through the subagent’s own file', async () => {
    const x = await start()
    const tx = transcriptIn(tmp('e2e-'))
    const aid = 'a0edd2143fc3f099d'
    const sub = join(dirname(tx), SID, 'subagents', `agent-${aid}.jsonl`)
    mkdirSync(dirname(sub), { recursive: true })
    writeFileSync(tx, use(ID))
    writeFileSync(sub, use(ID))
    expect(await run(['sh', join(KIT, 'permission-pre.sh')], x.home, stdinFor('PreToolUse', tx, aid)).exited).toBe(0)
    const hookProc = run(['python3', join(KIT, 'permission-relay.py')], x.home, stdinFor('PermissionRequest', tx, aid))
    const card = await nextHookCard(x)
    await eventually(() => expect(watching(x)).toBe(1))
    freeze(hookProc) // its own look would see the main file's result and end it
    appendFileSync(tx, result(ID)) // the main file is not this call's file
    await bridgeLooks() // the bridge has looked at the subagent's file since, and found nothing
    expect(expiredReason(x, card.id)).toBeUndefined()
    expect(watching(x)).toBe(1)
    appendFileSync(sub, result(ID))
    // still frozen: the hook cannot end first, so a close here is the bridge's own (prompt_over), never the hook's look (hook_gone)
    await eventually(() => expect(expiredReason(x, card.id)).toBe('prompt_over'))
    thaw(hookProc) // now it reads its "none" and exits
    await hookProc.exited
  })

  test('no PreToolUse record (the hook never ran): no id, nothing is watched, and a result closes nothing', async () => {
    const x = await start()
    const tx = transcriptIn(tmp('e2e-'))
    writeFileSync(tx, use(ID))
    const hookProc = run(['python3', join(KIT, 'permission-relay.py')], x.home, stdinFor('PermissionRequest', tx))
    const card = await nextHookCard(x)
    freeze(hookProc) // with no id there is nothing for the bridge to watch: only the hook's own look could end this card, and it cannot look
    appendFileSync(tx, result(ID))
    expect(watching(x)).toBe(0) // no loop exists that could ever read it
    await quiet() // timing-ok: a negative window that is safe at any time factor, because the one thing that could close the card is frozen
    expect(watching(x)).toBe(0)
    expect(expiredReason(x, card.id)).toBeUndefined()
    hookProc.kill('SIGKILL')
    await hookProc.exited
  })
})

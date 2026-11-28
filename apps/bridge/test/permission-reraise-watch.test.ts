// A hook that knew its call's exact tool_use id, then ended with no word (Claude Code stops it on No or Esc: `hook_gone`): the relay raises
// the channel card again, because the prompt may still be open. That re-raised card keeps the SAME exact-id watch, so the call's
// tool_result closes it as `prompt_over`. If the result is already there when the hook ends, nothing is raised at all. Without an id the
// re-raised card is as it was: it stays until answered. The watch lives as long as the re-raised card is pending and ends with it.
// (`touch probe-N` is only a synthetic hook input.)
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
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
const transcriptIn = (root: string) => {
  const dir = join(root, 'projects', '-srv-proj')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${SID}.jsonl`)
}
const result = (id: string) =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })}\n`
const use = (id: string) =>
  `${JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'touch probe-1' } }] } })}\n`

const SESSION_PID = 4_242_424
const main = { pid: SESSION_PID, cwd: '/srv/proj' }
const RULES = [{ tool: 'Bash', content: 'touch probe-*' }]
const touch = { command: 'touch probe-1' }
const PREVIEW = '{"command": "touch probe-1"}'
const relayParams = () => ({ request_id: 'abcde', tool_name: 'Bash', description: 'Run it', input_preview: PREVIEW })
const RELAY_IDS = new Set(['abcde', 'fghij'])

const sockets: { destroy(): void }[] = []
let h: Harness | undefined
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await h?.stop()
  h = undefined
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function start(watchMs = 40) {
  h = await startHarness({ config: ((c: Record<string, unknown>) => ({ ...c, permission_relay: true })) as never })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 150, watchMs })
  h.bridge.ctx.permission.setSessionPids([SESSION_PID])
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}
function hook(home: string, line: Record<string, unknown>) {
  const sock = createConnection(join(home, 'run', 'hub.sock'))
  sockets.push(sock)
  sock.on('error', () => {})
  sock.on('connect', () => sock.write(`${JSON.stringify(line)}\n`))
  return { close: () => sock.destroy() }
}
const permLine = (over: Record<string, unknown> = {}) => ({
  t: 'perm',
  id: 'req-1',
  tool_name: 'Bash',
  tool_input: touch,
  session_id: SID,
  ...main,
  suggest: { rules: RULES },
  ...over,
})
const idLine = (transcript: string, extra: Record<string, unknown> = {}) =>
  permLine({ tool_use_id: ID, transcript_path: transcript, ...extra })

const created = (x: Harness) =>
  x.relay.frames
    .filter(
      (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
    )
    .map((f) => (f.frame as { card: CardT }).card)
const isRelay = (c: CardT) => RELAY_IDS.has((c.payload as { request_id?: string }).request_id ?? '')
const hookCards = (x: Harness) => created(x).filter((c) => !isRelay(c))
const relayCards = (x: Harness) => created(x).filter(isRelay)
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
const watching = (x: Harness) => (x.bridge.ctx.permission as unknown as { watches: Map<string, unknown> }).watches.size
const quiet = () => sleep(t(400)) // timing-ok: negative window: the card must stay, nothing else is raised
const pendingPerm = (x: Harness) => x.bridge.ctx.ledger.list('pending').filter((r) => r.binding.kind === 'permission')

/** A twin was replaced by the hook's card (id armed); returns the hook, its card and the transcript. */
async function replaced(x: Harness, line: (f: string) => Record<string, unknown> = idLine) {
  const f = transcriptIn(tmp('rr-'))
  writeFileSync(f, use(ID))
  await x.bridge.ctx.permission.onRequest(relayParams())
  const first = relayCards(x)[0] as CardT
  const call = hook(x.home, line(f))
  await eventually(() => expect(hookCards(x).length).toBe(1))
  await eventually(() => expect(expiredReason(x, first.id)).toBe('replaced_by_hook'))
  return { f, call, card: hookCards(x)[0] as CardT }
}

describe('the re-raised channel card carries the armed id', () => {
  test('hook armed with an id, then it ends with no word, then the result arrives: the re-raised card closes as prompt_over', async () => {
    const x = await start()
    const { f, call, card } = await replaced(x)
    call.close()
    await eventually(() => expect(expiredReason(x, card.id)).toBe('hook_gone'))
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
    const again = relayCards(x)[1] as CardT
    await quiet()
    expect(expiredReason(x, again.id)).toBeUndefined() // no result yet: it stays
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, again.id)).toBe('prompt_over'))
    await quiet()
    expect(relayCards(x)).toHaveLength(2)
    expect(pendingPerm(x)).toHaveLength(0)
    expect(watching(x)).toBe(0)
  })

  test('a claimed twin (the hook came first): the channel card made after the hook ended is watched the same way', async () => {
    const x = await start()
    const f = transcriptIn(tmp('rr-'))
    writeFileSync(f, use(ID))
    const call = hook(x.home, idLine(f))
    await eventually(() => expect(hookCards(x).length).toBe(1))
    await x.bridge.ctx.permission.onRequest(relayParams()) // claimed: no card
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(1))
    const again = relayCards(x)[0] as CardT
    appendFileSync(f, result(ID))
    await eventually(() => expect(expiredReason(x, again.id)).toBe('prompt_over'))
    await quiet()
    expect(relayCards(x)).toHaveLength(1)
  })

  test('the result is ALREADY there when the hook ends (No or Esc writes it at once): no channel card is raised at all', async () => {
    const x = await start(60_000) // the poll never ticks: only the check at the hook's end can see it
    const { f, call, card } = await replaced(x)
    appendFileSync(f, result(ID))
    call.close()
    await eventually(() => expect(expiredReason(x, card.id)).toBe('hook_gone'))
    await quiet()
    expect(relayCards(x)).toHaveLength(1) // only the first, replaced one
    expect(pendingPerm(x)).toHaveLength(0)
    expect(watching(x)).toBe(0)
  })

  test("another call's result does not close the re-raised card", async () => {
    const x = await start()
    const { f, call } = await replaced(x)
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
    const again = relayCards(x)[1] as CardT
    appendFileSync(f, result(OTHER))
    await quiet()
    expect(expiredReason(x, again.id)).toBeUndefined()
    expect(pendingPerm(x)).toHaveLength(1)
    expect(watching(x)).toBe(1)
  })

  test('a hook with no id, ended with no word (a plain kill): the re-raised card stays, nothing is watched', async () => {
    const x = await start()
    const { f, call } = await replaced(x, () => permLine())
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
    appendFileSync(f, result(ID))
    await quiet()
    expect(expiredReason(x, (relayCards(x)[1] as CardT).id)).toBeUndefined()
    expect(pendingPerm(x)).toHaveLength(1)
    expect(watching(x)).toBe(0)
  })

  test('the re-raised card answered on the phone: the watch is cleaned up and a later result does nothing', async () => {
    const x = await start()
    x.bridge.ctx.permission.setSender(async () => {})
    const { f, call } = await replaced(x)
    call.close()
    await eventually(() => expect(relayCards(x)).toHaveLength(2))
    const again = relayCards(x)[1] as CardT
    await eventually(() => expect(watching(x)).toBe(1))
    await x.app.resolveCard(again, 'kill', again.payload_hash)
    await eventually(() => expect(watching(x)).toBe(0))
    appendFileSync(f, result(ID))
    await quiet()
    expect(expiredReason(x, again.id)).toBeUndefined()
    expect(relayCards(x)).toHaveLength(2)
  })
})

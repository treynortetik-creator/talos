// `undo.request` ("Undo to here" from the phone): a signed frame that arrives here AFTER Inbound has checked the owner
// signature and the frame id. The bridge answers with the undo card for that owner message (card.ts: nothing is
// restored until the owner approves it), or says why not, in an `undo.request.result` under the same `control_id`. The
// result is recorded (history.sqlite kv) before it is sent, so a relay replay re-sends it instead of asking twice.
import { ErrorCode, type ErrorCodeT, type Frame, newUlid } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { RESET_REFUSAL, signedBeforeReset } from '../history-recover.ts'
import { say } from '../owner-words.ts'
import { UndoPoints } from './points.ts'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>
type Result = { ok: boolean; code?: ErrorCodeT; text: string; cardId?: string }

const KEEP_RESULTS = 100
const INDEX_KEY = 'urq:index'
const key = (controlId: string) => `urq:${controlId}`
export const NO_POINT_TEXT = 'This message has no undo point.'

function stored(ctx: BridgeContext, controlId: string): Of<'undo.request.result'> | undefined {
  const raw = ctx.store.kvGet(key(controlId))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Of<'undo.request.result'>
  } catch {
    return undefined
  }
}

function send(ctx: BridgeContext, frame: Of<'undo.request.result'>): void {
  ctx.transport
    .sendDurable(frame)
    .catch((e) => ctx.log.warn('undo request result not sent', { error: (e as Error).message }))
}

function record(ctx: BridgeContext, controlId: string, r: Result): void {
  const now = new Date(ctx.clock.now()).toISOString()
  const frame = {
    v: 1,
    type: 'undo.request.result',
    id: newUlid(),
    ts: now,
    control_id: controlId,
    ok: r.ok,
    ...(r.code && ErrorCode.safeParse(r.code).success ? { code: r.code } : {}),
    text: r.text.slice(0, 4000),
    ...(r.cardId ? { card_id: r.cardId } : {}),
    at: now,
  } as Of<'undo.request.result'>
  ctx.store.kvSet(key(controlId), JSON.stringify(frame))
  let ids: string[] = []
  try {
    ids = JSON.parse(ctx.store.kvGet(INDEX_KEY) ?? '[]') as string[]
  } catch {
    ids = []
  }
  ids.push(controlId)
  while (ids.length > KEEP_RESULTS) {
    const old = ids.shift()
    if (old) ctx.store.kvDelete(key(old))
  }
  ctx.store.kvSet(INDEX_KEY, JSON.stringify(ids))
  send(ctx, frame)
}

/** A replayed frame whose first run already finished: the stored result goes out again. */
export function resendUndoRequest(ctx: BridgeContext, controlId: string): void {
  const s = stored(ctx, controlId)
  if (s) send(ctx, s)
}

async function answer(ctx: BridgeContext, f: Of<'undo.request'>, early: (r: Result) => void): Promise<Result> {
  const cards = ctx.undoCards
  if (!cards)
    return { ok: false, text: say({ mac: 'Undo is not on for this Mac.', linux: 'Undo is not on for this computer.' }) }
  // the point must be this thread's: a message id from another thread (or one with no point) gets nothing
  const row = new UndoPoints(ctx.store.db).get(f.message_id)
  if (!row || row.thread_id !== f.thread_id) return { ok: false, text: NO_POINT_TEXT }
  try {
    const r = await cards.propose(f.message_id, () =>
      early({ ok: true, text: 'Undoing now (you always allow undos). The result will be in the thread.' }),
    )
    // a passed undo (always allowed) has no card: the app is told it is being done, with no card id to look for
    if (r.ok && r.passed)
      return { ok: true, text: 'Undoing now (you always allow undos). The result will be in the thread.' }
    return r.ok ? { ok: true, text: '', cardId: r.cardId } : { ok: false, text: r.why }
  } catch (e) {
    ctx.log.warn('undo card not made', { error: (e as Error).message })
    return {
      ok: false,
      code: 'internal',
      text: say({
        mac: 'Your Mac could not make the undo card. Try again.',
        linux: 'Your computer could not make the undo card. Try again.',
      }),
    }
  }
}

/** `finish` consumes the frame once the result is recorded. */
export async function onUndoRequest(ctx: BridgeContext, f: Of<'undo.request'>, finish: () => void): Promise<void> {
  if (stored(ctx, f.control_id)) {
    resendUndoRequest(ctx, f.control_id)
    finish()
    return
  }
  // the history was reset after the owner signed this: the message and its point may be gone, so nothing is made
  if (signedBeforeReset(ctx.store, f.ts)) {
    record(ctx, f.control_id, RESET_REFUSAL)
    finish()
    return
  }
  let told = false
  const result = await answer(ctx, f, (r) => {
    told = true
    record(ctx, f.control_id, r)
  })
  if (!told) record(ctx, f.control_id, result)
  finish()
}

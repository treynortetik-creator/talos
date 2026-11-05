// `agent.recover` (packages/protocol, "Phone recovery"): the owner's Restart agent button. A
// signed frame arrives here AFTER Inbound has checked the owner signature and the frame id. The bridge writes
// $TALOS_APP_HOME/agent-request.json for the Mac app first (it reads the file and does the work), and only then records
// the result (history.sqlite kv) and sends it, so a failed write never says ok and a relay replay re-sends the stored
// result instead of asking the Mac twice. A crash between the two steps replays as a fresh run: the same control_id is
// written again, and the reader acts at most once per control_id (docs/bridge.md). The agent never sees any of this:
// nothing is queued for the mod and no message is made. The K2 guard denies the agent a write to this file.
import { join } from 'node:path'
import {
  AgentRecoverAction,
  ErrorCode,
  type ErrorCodeT,
  type Frame,
  newUlid,
  RECOVER_NEEDS_MAC_TEXT,
  RECOVER_SENT_TEXT,
} from '@talos-app/protocol'
import type { BridgeContext } from './context.ts'
import { writeJsonAtomic } from './fsutil.ts'
import { RESET_REFUSAL, signedBeforeReset } from './history-recover.ts'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>
type Result = { ok: boolean; code?: ErrorCodeT; text: string }

const KEEP_RESULTS = 100
const INDEX_KEY = 'arc:index'
const key = (controlId: string) => `arc:${controlId}`

export const AGENT_REQUEST_FILE = 'agent-request.json'

function stored(ctx: BridgeContext, controlId: string): Of<'agent.recover.result'> | undefined {
  const raw = ctx.store.kvGet(key(controlId))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Of<'agent.recover.result'>
  } catch {
    return undefined
  }
}

function send(ctx: BridgeContext, frame: Of<'agent.recover.result'>): void {
  ctx.transport
    .sendDurable(frame)
    .catch((e) => ctx.log.warn('agent recover result not sent', { error: (e as Error).message }))
}

function record(ctx: BridgeContext, controlId: string, r: Result): void {
  const frame: Of<'agent.recover.result'> = {
    v: 1,
    type: 'agent.recover.result',
    id: newUlid(),
    ts: new Date(ctx.clock.now()).toISOString(),
    control_id: controlId,
    ok: r.ok,
    ...(r.code && ErrorCode.safeParse(r.code).success ? { code: r.code } : {}),
    text: r.text,
    at: new Date(ctx.clock.now()).toISOString(),
  }
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
export function resendAgentRecover(ctx: BridgeContext, controlId: string): void {
  const s = stored(ctx, controlId)
  if (s) send(ctx, s)
}

/** `finish` consumes the frame once the result is recorded. */
export function onAgentRecover(ctx: BridgeContext, f: Of<'agent.recover'>, finish: () => void): void {
  if (stored(ctx, f.control_id)) {
    resendAgentRecover(ctx, f.control_id)
    finish()
    return
  }
  // the history was reset after the owner signed this: whether it already ran is unknown, so it does not run
  if (signedBeforeReset(ctx.store, f.ts)) {
    record(ctx, f.control_id, RESET_REFUSAL)
    finish()
    return
  }
  // Restoring is done at the Mac. An old app's restore_last_good (or any unknown action) is refused in words, no file.
  const parsed = AgentRecoverAction.safeParse(f.action)
  if (!parsed.success) {
    record(ctx, f.control_id, { ok: false, code: 'bad_frame', text: RECOVER_NEEDS_MAC_TEXT })
    finish()
    return
  }
  const action = parsed.data
  // The file first, then the record and the one result: a write that failed must never have said ok.
  try {
    writeJsonAtomic(join(ctx.paths.home, AGENT_REQUEST_FILE), {
      v: 1,
      control_id: f.control_id,
      action,
      ts: ctx.clock.now(),
    })
  } catch (e) {
    ctx.log.warn('agent request not written', { error: (e as Error).message })
    record(ctx, f.control_id, { ok: false, code: 'internal', text: 'Your Mac could not be asked. Try again.' })
    finish()
    return
  }
  record(ctx, f.control_id, { ok: true, text: RECOVER_SENT_TEXT })
  finish()
}

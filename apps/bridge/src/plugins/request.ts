// `plugin.add.request` ("Add plugin to agent" from the phone): a signed frame that arrives here AFTER Inbound has checked the owner signature and the
// frame id. The bridge answers with the card (agent-plugins.ts: nothing is installed until the owner taps it) or says why not, in a `plugin.add.result`
// under the same `control_id`. The result is recorded (history.sqlite kv) before it is sent, so a relay replay sends it again instead of asking twice.
import { type Frame, newUlid } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { PLUGIN_WORDS as W } from './plugin-words.ts'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>
const KEEP_RESULTS = 100
const INDEX_KEY = 'par:index'
const key = (controlId: string) => `par:${controlId}`

function stored(ctx: BridgeContext, controlId: string): Of<'plugin.add.result'> | undefined {
  const raw = ctx.store.kvGet(key(controlId))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Of<'plugin.add.result'>
  } catch {
    return undefined
  }
}

function send(ctx: BridgeContext, frame: Of<'plugin.add.result'>): void {
  ctx.transport
    .sendDurable(frame)
    .catch((e) => ctx.log.warn('plugin add result not sent', { error: (e as Error).message }))
}

function record(ctx: BridgeContext, controlId: string, r: { ok: boolean; text: string; cardId?: string }): void {
  const now = new Date(ctx.clock.now()).toISOString()
  const frame = {
    v: 1,
    type: 'plugin.add.result',
    id: newUlid(),
    ts: now,
    control_id: controlId,
    ok: r.ok,
    text: r.text.slice(0, 400),
    ...(r.cardId ? { card_id: r.cardId } : {}),
    at: now,
  } as Of<'plugin.add.result'>
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
export function resendPluginAdd(ctx: BridgeContext, controlId: string): void {
  const s = stored(ctx, controlId)
  if (s) send(ctx, s)
}

/** `finish` consumes the frame once the result is recorded. */
export async function onPluginAddRequest(
  ctx: BridgeContext,
  f: Of<'plugin.add.request'>,
  finish: () => void,
): Promise<void> {
  if (stored(ctx, f.control_id)) {
    resendPluginAdd(ctx, f.control_id)
    finish()
    return
  }
  let r: { ok: boolean; text: string; cardId?: string }
  try {
    r = ctx.agentPlugins
      ? await ctx.agentPlugins.request(f.plugin, f.marketplace)
      : { ok: false, text: W.failed('plugins cannot be added from this bridge.') }
  } catch (e) {
    ctx.log.warn('plugin add request failed', { error: (e as Error).message })
    r = { ok: false, text: W.failed('the bridge could not make the card.') }
  }
  record(ctx, f.control_id, r)
  finish()
}

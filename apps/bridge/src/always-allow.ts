// "Always allow" on the bridge (packages/protocol/src/always-allow.ts; owner ruling 2026-11-14: "always allow, allow, or deny
// ... just like it's in Claude Code"). Two halves:
//   - adding a kind: ONLY from the owner's own signed "Always allow" tap on one of the agent's cards of that kind (inbound-cards.ts,
//     after the signature and the ledger checks), or through config_propose when he asks in his own words (the settings table
//     row; the lock turns that into a card). Never from a share, an integration event, a hand-off or the agent's own call.
//   - using it: the agent's `card` call for an always-allowed kind is approved at once, read from config at that moment (a kind
//     removed a second ago is a card again). The owner sees it in the thread but is never buzzed for it (2026-11-15: "I got a lot
//     of allowed deploy stuff"): each pass is logged, the first in a 10-minute window per thread posts its own silent line, and
//     the later ones come as one silent line with a count when the window ends (the message store cannot edit a line).
import {
  type AgentConfigT,
  alwaysAllowed,
  type CardT,
  isSendKind,
  redact,
  SEND_KINDS,
  type SendKind,
} from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice, threadRef } from './context.ts'
import { configSyncFrame } from './frames-out.ts'

const PLURAL: Record<SendKind, string> = {
  email: 'emails',
  message: 'messages',
  deploy: 'deploys',
  publish: 'publishing',
  purchase: 'purchases',
  push: 'pushing code',
}
/** One and many, for a count ("2 pushes"). */
const COUNT_WORD: Record<SendKind, readonly [string, string]> = {
  email: ['email', 'emails'],
  message: ['message', 'messages'],
  deploy: ['deploy', 'deploys'],
  publish: ['publish', 'publishes'],
  purchase: ['purchase', 'purchases'],
  push: ['push', 'pushes'],
}
/** Passes within this long, in one thread, fold into one line. */
export const FOLD_WINDOW_MS = 10 * 60_000
const MAX_LISTED = 5
/** The durable record of every pass (history.sqlite kv): what ran, which rule, which kind, thread and time. Newest 500 kept. */
export const PASS_RECORD_PREFIX = 'always-allow-pass/'
const PASS_RECORD_KEEP = 500
let passSeq = 0
function recordPass(ctx: BridgeContext, c: { kind: SendKind; title: string; thread_id: string; rule?: string }): void {
  const at = ctx.clock.now()
  const rec = {
    at: new Date(at).toISOString(),
    kind: c.kind,
    thread: c.thread_id,
    rule: c.rule ?? null,
    what: c.title.slice(0, 2000),
  }
  try {
    const key = `${PASS_RECORD_PREFIX}${String(at).padStart(15, '0')}-${String(++passSeq).padStart(6, '0')}`
    ctx.store.kvSet(key, JSON.stringify(rec))
    const keys = ctx.store.kvKeys(PASS_RECORD_PREFIX)
    for (const k of keys.slice(0, Math.max(0, keys.length - PASS_RECORD_KEEP))) ctx.store.kvDelete(k)
  } catch (e) {
    ctx.log.warn('always-allow pass not recorded', { error: (e as Error).message })
  }
  // warn, not info: it survives a warn log level
  ctx.log.warn('always-allow pass', rec)
}
export const kindPlural = (k: SendKind): string => PLURAL[k]
const STOP = 'To stop: Settings → Always allowed, or tell me to stop.'

/** The line in the thread for a send made without a card. */
export const sentWithoutCardText = (kind: SendKind, title: string): string =>
  `Allowed without a card (you always allow ${kindPlural(kind)}): ${title.slice(0, 200)}. ${STOP}`

/** Is this kind always allowed right now? Reads the config file as it is now, never a copy. */
export function alwaysAllowedNow(ctx: Pick<BridgeContext, 'config'>, kind: string): kind is SendKind {
  if (!isSendKind(kind)) return false
  ctx.config.refresh()
  return alwaysAllowed(ctx.config.config.always_allow, kind)
}

type Window = { held: Map<SendKind, number>; titles: string[]; timer: unknown }
const windows = new WeakMap<BridgeContext, Map<string, Window>>()

const countText = (held: Map<SendKind, number>): string =>
  SEND_KINDS.filter((k) => held.has(k))
    .map((k) => {
      const n = held.get(k) ?? 0
      return `${n} ${COUNT_WORD[k][n === 1 ? 0 : 1]}`
    })
    .join(' and ')

const post = (ctx: BridgeContext, thread: string, text: string) =>
  postSystemNotice(ctx, text, { thread: threadRef(ctx, thread), silent: true }).catch((e) =>
    ctx.log.warn('always-allow notice not posted', { error: (e as Error).message }),
  )

/** Posts the passes held back in a window as one line, when the window ends. */
async function endWindow(ctx: BridgeContext, thread: string): Promise<void> {
  const map = windows.get(ctx)
  const w = map?.get(thread)
  if (!map || !w) return
  map.delete(thread)
  if (w.held.size === 0) return
  const shown = w.titles.slice(0, MAX_LISTED).map((t) => `- ${t.length > 80 ? `${t.slice(0, 79)}…` : t}`)
  const more = w.titles.length - shown.length
  await post(
    ctx,
    thread,
    `Also always allowed in the last 10 minutes: ${countText(w.held)}.\n${shown.join('\n')}${more > 0 ? `\nand ${more} more` : ''}\n${STOP}`,
  )
}

/**
 * The agent's card for an always-allowed kind: no card, one line in its thread with a push through quiet hours, and the words
 * the agent gets back (it goes ahead now).
 */
export async function allowWithoutCard(
  ctx: BridgeContext,
  c: Pick<CardT, 'kind' | 'title' | 'thread_id'> & { rule?: string },
): Promise<string> {
  const kind = c.kind as SendKind
  // the command is stored, logged and listed in the thread: a credential in it (a -u user:pass, an ?api_key=) goes first
  const title = redact(c.title, { userHome: ctx.env.userHome, appHome: ctx.env.home })
  ctx.log.info('card skipped: always allowed', { kind, thread: c.thread_id })
  recordPass(ctx, { kind, title, thread_id: c.thread_id, ...(c.rule ? { rule: c.rule } : {}) })
  const map = windows.get(ctx) ?? new Map<string, Window>()
  windows.set(ctx, map)
  const open = map.get(c.thread_id)
  if (open) {
    // inside the window: held for the one line that closes it
    open.held.set(kind, (open.held.get(kind) ?? 0) + 1)
    open.titles.push(title)
  } else {
    const w: Window = { held: new Map(), titles: [], timer: undefined }
    w.timer = ctx.clock.setTimeout(() => void endWindow(ctx, c.thread_id), FOLD_WINDOW_MS)
    ;(w.timer as { unref?: () => void } | undefined)?.unref?.()
    map.set(c.thread_id, w)
    await post(ctx, c.thread_id, sentWithoutCardText(kind, title))
  }
  return `approved without a card: the owner always allows ${kindPlural(kind)}. Go ahead and do it now; the owner was told in the thread.`
}

/**
 * The owner's signed "Always allow" tap on an agent card of a send kind (inbound-cards.ts calls this only after the owner's
 * signature and the ledger checks passed for that card). Adds the kind once, syncs every app, and says so in the thread.
 */
export async function addFromOwnerTap(ctx: BridgeContext, kind: string, threadId: string): Promise<void> {
  if (!isSendKind(kind)) return
  const now = ctx.clock.now()
  let changed = false
  const after: AgentConfigT = ctx.config.update((c) => {
    const list = c.always_allow ?? []
    if (list.some((e) => e.kind === kind && e.destination === null)) return c
    changed = true
    return { ...c, always_allow: [...list, { kind, destination: null, added_at: new Date(now).toISOString() }] }
  })
  if (!changed) return
  ctx.log.info('always allowed by the owner', { kind })
  await ctx.transport
    .sendDurable(configSyncFrame(now, after))
    .then(() => ctx.config.markSynced(after))
    .catch((e) => ctx.log.warn('config.sync not sent', { error: (e as Error).message }))
  await postSystemNotice(ctx, `Always allowed from now on: ${kindPlural(kind)}. ${STOP}`, {
    thread: threadRef(ctx, threadId),
    settingsChanged: true,
  }).catch(() => {})
}

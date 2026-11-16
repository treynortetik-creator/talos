// What a thread session (a worker) may send as the live bridge's own, decided in one place: by the hub when it is up, and by
// the worker itself before its HTTP fallback when it is down (bridge-fence #22: the fence must not depend on the hub being
// up). This covers the tool path, the frames the agent's tools send. It does not cover a `talos-app post` run with the
// worker's markers removed, or the bridge key read with a script in the light lead profile (docs/OPTION-C.md); media
// uploads (PUT /bridge/media) store bytes only, and the message that would show them is fenced.
import { type AgentConfigT, type Frame, leadPostThreads, PageRef, threadSessionMode } from '@talos-app/protocol'

export type FenceDeps = {
  config: AgentConfigT
  /** The thread whose worker raised a card (the hub's raiser row). */
  cardRaiser(cardId: string): string | undefined
  /** The thread a card sits in, as the ledger has it. */
  ledgerThread(cardId: string): string | undefined
  /** The thread of a stored message (for a receipt). */
  messageThread?(messageId: string): string | undefined
}
export type FenceProblem = { code: string; message: string }

/**
 * A thread session sends what its `reply` and `attach` tools build: an agent's text or file row, with these fields and no
 * others, and `via: headless` (a thread session is never the live bridge). Every other field (an app view or its echo, a
 * hand-off label, a heartbeat, a share, a card or call row, a receipt, a transcript, a field a later protocol adds) is the
 * live bridge's to mint, so a frame that carries one did not come from those tools. An allow-list, so a new field is
 * refused until it is added here on purpose. Returns why not.
 */
const WORKER_REPLY_KINDS = new Set(['text', 'file'])
const WORKER_REPLY_FIELDS = new Set([
  'id',
  'thread_id',
  'author',
  'kind',
  'text',
  'format',
  'reply_to',
  'attachments',
  'via',
  'created_at',
  // publish_page's row (docs/ORG-PAGES-SPEC.md): which page and version, never a link, and only exactly that shape
  'page',
])
export function workerReplyProblem(m: Record<string, unknown>): string | undefined {
  if (!WORKER_REPLY_KINDS.has(String(m.kind))) return 'a thread session sends text and file messages only'
  const extra = Object.keys(m).find((k) => !WORKER_REPLY_FIELDS.has(k) && m[k] !== undefined)
  if (extra) return `a thread session's message cannot carry "${extra}"`
  // the frame schema reads a bad `page` as absent; the fence refuses it outright, so nothing but publish_page's shape gets through
  if (m.page !== undefined && (m.kind !== 'text' || !PageRef.safeParse(m.page).success))
    return "a thread session's page is a text message's { page_id, title, version }"
  if (m.via !== undefined && m.via !== 'headless') return 'a thread session\'s message is via "headless"'
  return undefined
}

/** The thread a worker's frame belongs to; a card.update by who raised the card. */
export function workerFrameThread(f: Frame, d: FenceDeps): string | undefined {
  switch (f.type) {
    case 'reply':
      return f.message.thread_id
    case 'card.create':
      return f.card.thread_id
    case 'card.update':
      return d.cardRaiser(f.card_id) // only the worker that raised it, whatever thread the card is in
    case 'status':
      return f.thread_id
    case 'receipt':
      return d.messageThread?.(f.message_id)
    default:
      return undefined
  }
}

/** Why the worker of `thread` may not send `f` (already parsed), or undefined when it may. */
export function workerFrameProblem(f: Frame, thread: string, d: FenceDeps): FenceProblem | undefined {
  const own = workerFrameThread(f, d)
  // its own thread, or a sub-thread it answers as the parent's lead (one without a lead of its own). A card.update is judged
  // by who raised the card, so its target is this session's own thread; a session switched off is refused just below.
  const switchedOff = threadSessionMode(d.config, thread) !== 'dedicated'
  const may = f.type === 'card.update' || switchedOff ? [thread] : leadPostThreads(d.config, thread)
  if (own === undefined || !may.includes(own))
    return { code: 'not_owner', message: `this session can only post to thread ${thread}` }
  // switched off since its hello: main answers this thread now. A card.update still lands: it reports work the owner
  // already approved, on a card this worker raised, and nothing else can close that card honestly.
  if (f.type !== 'card.update' && switchedOff)
    return { code: 'worker_unavailable', message: `thread ${thread} no longer has its own session` }
  if (f.type === 'reply' && f.message.author !== 'agent') return { code: 'bad_frame', message: 'only agent messages' }
  if (f.type === 'reply') {
    const why = workerReplyProblem(f.message)
    if (why) return { code: 'bad_frame', message: why }
  }
  if (f.type === 'card.create') {
    if (f.card.kind === 'permission') return { code: 'bad_frame', message: 'no permission cards' }
    // only a card this worker's `card` tool minted: the ledger row must be in its thread and already raised by it, so
    // re-announcing someone else's card id can never move that card or its answer
    if (d.ledgerThread(f.card.id) !== own || d.cardRaiser(f.card.id) !== thread)
      return { code: 'not_owner', message: `card ${f.card.id} was not raised by this session` }
  }
  return undefined
}

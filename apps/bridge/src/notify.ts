// Builds `notifications/claude/channel` payloads (spec 4.3, 3.6). Trust is decided here, on the Mac, by frame type and
// signature result, never by a field the relay set. Meta keys match /^[A-Za-z0-9_]+$/ and every value is a string,
// sanitized (`<>"\r\n;` become `_`).
import {
  EXTERNAL_END,
  EXTERNAL_START,
  EXTERNAL_WARNING,
  type Frame,
  RUN_META_VALUE,
  randomBytes,
  type ShareContentT,
  sanitizeExternal,
  sanitizeMetaValue,
  stripSpecialTokens,
  toHex,
  wrapExternal,
} from '@talos-app/protocol'
import { cutToUnits } from './share/shortcut.ts'

export type Notification = { content: string; meta: Record<string, string> }
export type Trust = 'owner' | 'owner_voice' | 'external' | 'system' | 'agent'
export type Kind =
  | 'text'
  | 'voice_note'
  | 'file'
  | 'card_action'
  | 'hook_event'
  | 'hook_digest'
  | 'voice_delegation'
  | 'voice_ended'
  | 'backlog'
  | 'system'
  | 'schedule_run'
  | 'schedule_held'
  | 'share'
  | 'app_tool_call'
  | 'app_message'
  | 'handoff'

const KEY = /^[A-Za-z0-9_]+$/

/** Drops undefined, stringifies, sanitizes values, and refuses keys that Claude Code would silently drop. */
export function cleanMeta(fields: Record<string, string | number | boolean | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    if (!KEY.test(k)) throw new Error(`invalid channel meta key: ${k}`)
    out[k] = sanitizeMetaValue(String(v))
  }
  return out
}

/** The owner's clock on a note (clock-meta.ts): their local time with offset, and the gap since their last message here. */
export type ClockFields = { local_time?: string | undefined; since_last?: string | undefined }

export type ThreadRef = { id: string; name: string }

function base(
  thread: ThreadRef,
  messageId: string,
  ts: string,
  kind: Kind,
  trust: Trust,
  extra: Record<string, string | number | boolean | undefined> = {},
) {
  return cleanMeta({
    chat_id: thread.id,
    thread_id: thread.id,
    thread_name: thread.name,
    message_id: messageId,
    ts,
    kind,
    trust,
    ...extra,
  })
}

/** A file name is shown to the agent cut to this many UTF-16 units, on a character boundary. */
const FILE_NAME_MAX = 100
export const shownName = (name: string) => cutToUnits(name, FILE_NAME_MAX)

/** `withName: false` leaves the name out: it is a stranger's text and goes inside a wrapper instead. */
export function fileMeta(
  files: Array<{ path: string; mime: string; name: string }>,
  opts: { withName?: boolean } = {},
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  files.slice(0, 10).forEach((f, i) => {
    out[i === 0 ? 'file_path' : `file_path_${i + 1}`] = f.path
  })
  if (files[0]) {
    out.file_mime = files[0].mime
    if (opts.withName !== false) out.file_name = shownName(files[0].name)
  }
  return out
}

/** Meta carries ten file paths. Any beyond that are named here, in the text, so no file the owner sent goes unseen. */
export function moreFiles(files: Array<{ path: string }>): string | undefined {
  if (files.length <= 10) return undefined
  const rest = files.slice(10)
  return `(${rest.length} more ${rest.length === 1 ? 'file' : 'files'} beyond file_path_10: ${rest.map((f) => oneLine(f.path)).join(', ')})`
}

/** The agent reads this line: the frame's own time is when it was signed again, not when the owner wrote it. */
const late = (writtenAt: string) =>
  `(The owner wrote this on ${writtenAt}; it was sent later, so treat it as older words.)`

export function textNotification(a: {
  thread: ThreadRef
  messageId: string
  ts: string
  text: string
  askedSince?: string
  /** When the words were first written, if this frame was signed again later. */
  writtenAt?: string | undefined
  /** The Mac accepted this as the owner's tap on Run (shape, age, reset, once: inbound.ts). Sets `run="tap"`, the one thing the agent trusts. */
  run?: boolean
  files?: Array<{ path: string; mime: string; name: string }>
  notes?: string[]
  /** The signed `/share` page (docs/V2-FEATURES.md V4.3): `text` is the typed note, this is DATA, wrapped external. */
  shareContent?: ShareContentT | undefined
  /** Extra meta from the memory browser's ref check (`memory_root`, `memory_path`, `memory_changed`). */
  extraMeta?: Record<string, string> | undefined
  /** `local_time` and `since_last` (clock-meta.ts). */
  clock?: ClockFields | undefined
}): Notification {
  const files = a.files ?? []
  const lines: string[] = []
  if (a.writtenAt) lines.push(late(a.writtenAt))
  if (a.askedSince !== undefined) lines.push(`(Asked: what did I miss since ${a.askedSince})`)
  if (a.text) lines.push(a.text)
  // A file named in shared material has a name a stranger chose: it goes inside the wrapper, never in the note or meta.
  const shared = a.shareContent !== undefined && (Object.keys(a.shareContent).length > 0 || files.length > 0)
  if (a.shareContent && shared)
    lines.push(
      wrapShared(
        a.shareContent,
        'Shared page',
        undefined,
        files.map((f) => f.name),
      ),
    )
  for (const n of a.notes ?? []) lines.push(n)
  if (!lines.length && files.length) lines.push(`(${files.length === 1 ? 'a file' : `${files.length} files`})`)
  const more = moreFiles(files)
  if (more) lines.push(more)
  return {
    content: lines.join('\n'),
    meta: base(a.thread, a.messageId, a.ts, files.length ? 'file' : 'text', 'owner', {
      user: 'owner',
      written_at: a.writtenAt,
      ...(a.run ? { run: RUN_META_VALUE } : {}),
      ...fileMeta(files, { withName: a.shareContent === undefined }),
      ...(shared ? { share_source: 'page' } : {}),
      ...a.extraMeta,
      ...a.clock,
    }),
  }
}

// ---- share to Talos (docs/V2-FEATURES.md V4.3, V4.7) -----------------------------------------------------------

/** Shares carry up to 32k of text plus a 4k note. */
const SHARE_WRAP_MAX = 36_500

/** Shared material as one wrapExternal block. The title and link ride as wrapper meta, the text (and note) as body. */
export function wrapShared(content: ShareContentT, source: string, note?: string, fileNames: string[] = []): string {
  const names = fileNames.length ? `Files: ${fileNames.map(shownName).join(', ')}` : ''
  const body = [note ? `Note: ${note}` : '', names, content.text ?? ''].filter(Boolean).join('\n')
  return wrapExternal(body || '(no text)', {
    source,
    ...(content.title ? { title: content.title } : {}),
    ...(content.url ? { link: content.url } : {}),
    maxChars: SHARE_WRAP_MAX,
  })
}

/**
 * A share from a Shortcut token (`share.item`): `trust=external`, thread inbox, the note AND the content inside ONE
 * wrapper (a Shortcut can't sign, so its note is not owner words). The bridge has already filed it (`filedPath`): the
 * owner never has to tap to save it (review note A).
 */
export function shareItemNotification(a: {
  thread: ThreadRef
  frame: Extract<Frame, { type: 'share.item' }>
  files?: Array<{ path: string; mime: string; name: string }>
  notes?: string[]
  filedPath?: string | undefined
}): Notification {
  const m = a.frame.message
  const files = a.files ?? []
  const lines = [
    wrapShared(
      m.share_content ?? {},
      `Shared via ${a.frame.token_label}`,
      m.text || undefined,
      files.map((f) => f.name),
    ),
  ]
  if (files.length)
    lines.push(`(${files.length === 1 ? 'a shared file' : `${files.length} shared files`}: see file_path)`)
  for (const n of a.notes ?? []) lines.push(n)
  const more = moreFiles(files)
  if (more) lines.push(more)
  if (a.filedPath) lines.push(`Already saved to ${a.filedPath}. No need to save it again.`)
  return {
    content: lines.join('\n'),
    meta: base(a.thread, m.id, m.created_at, 'share', 'external', {
      share_id: a.frame.share_id,
      share_source: 'shortcut',
      shared_file: a.filedPath,
      ...fileMeta(files, { withName: false }), // the name is the sender's text: it rides inside the wrapper
    }),
  }
}

/**
 * Driving mode (V4.1.4): owner-trust notifications carry `driving="true"` while it is on, so the agent answers in
 * short spoken sentences. External and system rows never get it.
 */
export function withDrivingMeta(n: Notification, driving: boolean): Notification {
  if (!driving) return n
  const trust = n.meta.trust
  if (trust !== 'owner' && trust !== 'owner_voice') return n
  return { content: n.content, meta: { ...n.meta, driving: 'true' } }
}

export function voiceNoteNotification(a: {
  thread: ThreadRef
  messageId: string
  ts: string
  content: string
  audioPath?: string | undefined
  engine?: string | undefined
  durationS?: number | undefined
  writtenAt?: string | undefined
  clock?: ClockFields | undefined
}): Notification {
  return {
    content: a.writtenAt ? `${late(a.writtenAt)}\n${a.content}` : a.content,
    meta: base(a.thread, a.messageId, a.ts, 'voice_note', 'owner', {
      user: 'owner',
      written_at: a.writtenAt,
      audio_path: a.audioPath,
      transcript_engine: a.engine,
      duration_s: a.durationS === undefined ? undefined : Math.round(a.durationS),
      ...a.clock,
    }),
  }
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/"/g, "'")

export function cardActionNotification(a: {
  thread: ThreadRef
  card: { id: string; title: string; primary_label: string }
  action: 'primary' | 'kill' | 'revise' | 'expired'
  ts: string
  edited?: boolean
  payloadPath?: string
  payloadHash?: string
  note?: string | undefined
  /** Appended to the text (an `app_action` card adds what the approval means, M5.4). */
  extra?: string | undefined
  clock?: ClockFields | undefined
}): Notification {
  const head = `Card ${a.card.id} "${oneLine(a.card.title)}"`
  let content: string
  if (a.action === 'primary') {
    content = `${head} → PRIMARY (${oneLine(a.card.primary_label)}). Edited: ${a.edited ? 'yes' : 'no'}. Approved binding: ${a.payloadPath} (${a.payloadHash}). Do exactly what it says, nothing more, then call card_result.`
  } else if (a.action === 'kill') {
    content = `${head} → KILL. Do not run it.`
  } else if (a.action === 'revise') {
    content = `${head} → REVISE. Do not run it as drafted. Owner's note: ${a.note ?? '(none)'}`
  } else {
    content = `${head} → EXPIRED. Nothing ran. Don't run it.`
  }
  if (a.extra) content += `\n${a.extra}`
  return {
    content,
    meta: base(a.thread, a.card.id, a.ts, 'card_action', 'owner', {
      user: 'owner',
      card_id: a.card.id,
      card_action: a.action,
      card_edited: a.edited ? 'true' : 'false',
      payload_path: a.action === 'primary' ? a.payloadPath : undefined,
      ...a.clock,
    }),
  }
}

const SOURCE_LABEL: Record<string, string> = {
  github: 'GitHub',
  gmail: 'Gmail',
  gmail_work: 'Gmail (work)',
  gcal: 'Google Calendar',
  slack: 'Slack',
  jira: 'Jira',
  linear: 'Linear',
  stripe: 'Stripe',
  calendly: 'Calendly',
  zoom: 'Zoom',
  salesforce: 'Salesforce',
  rss: 'RSS',
  zapier: 'Zapier',
  make: 'Make',
  n8n: 'n8n',
  forward: 'Forwarded email',
  generic: 'Webhook',
}
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s

type Event = Extract<Frame, { type: 'hook.event' }>['event']

export function hookEventNotification(a: {
  thread: ThreadRef
  event: Event
  delivery: 'live' | 'backlog'
}): Notification {
  const e = a.event
  const from = e.actor.name ?? e.actor.email ?? e.actor.id
  const wrapped = wrapExternal(e.summary, {
    source: `${sourceLabel(e.source)} (${e.kind})`,
    ...(from ? { from } : {}),
    title: e.title,
    ...(e.url ? { link: e.url } : {}),
  })
  return {
    content: wrapped,
    meta: base(a.thread, e.id, e.ts, 'hook_event', 'external', {
      event_id: e.id,
      source: e.source,
      event_kind: e.kind,
      priority: e.priority,
    }),
  }
}

/**
 * One wrapper listing up to 200 events, one line each. Built here (not with wrapExternal) because that helper caps its
 * body at 4,000 characters, which is per event in the spec, not per digest. Every line is sanitized on its own and the
 * marker id is fresh and random like everywhere else.
 */
export function hookDigestNotification(a: {
  thread: ThreadRef
  frame: Extract<Frame, { type: 'hook.digest' }>
}): Notification {
  const lines = a.frame.events.slice(0, 200).map((e) => {
    const who = e.actor.name ?? e.actor.email ?? e.actor.id
    return sanitizeExternal(
      `${e.ts} ${sourceLabel(e.source)} ${e.kind}${e.priority === 'high' ? ' [high]' : ''}${who ? ` from ${who}` : ''}: ${e.title}`,
      300,
    ).replace(/[\r\n]+/g, ' ')
  })
  const counts = a.frame.threads
    .map(
      (t) =>
        `${t.thread_id}: ${Object.entries(t.counts)
          .map(([s, n]) => `${n} ${s}`)
          .join(', ')}`,
    )
    .join('; ')
  const id = toHex(randomBytes(8))
  const body = [
    `Window: ${a.frame.window.start} to ${a.frame.window.end}`,
    ...(counts ? [`Counts: ${sanitizeExternal(counts, 500).replace(/[\r\n]+/g, ' ')}`] : []),
    ...lines,
  ].join('\n')
  const content = [
    EXTERNAL_WARNING,
    `<<<${EXTERNAL_START} id="${id}">>>`,
    'Source: Digest',
    '---',
    sanitizeExternal(body, 200 * 340),
    `<<<${EXTERNAL_END} id="${id}">>>`,
  ].join('\n')
  return {
    content,
    meta: base(a.thread, a.frame.id, a.frame.ts, 'hook_digest', 'external', { batch_count: a.frame.events.length }),
  }
}

type Ask = Extract<Frame, { type: 'voice.ask' }>
type Ended = Extract<Frame, { type: 'voice.ended' }>

/**
 * `trust` is trust mode (docs/SECURITY.md): the owner's spoken question is stamped `owner`, like typing. The call context
 * below it stays wrapped as data, because it can include the voice model's words and not only the owner's.
 */
export function voiceDelegationNotification(a: {
  thread: ThreadRef
  frame: Ask
  trust?: boolean
  clock?: ClockFields | undefined
}): Notification {
  const f = a.frame
  const question = stripSpecialTokens(sanitizeExternal(f.question, 4000))
  const lines = [`Live call in ${oneLine(a.thread.name)}. Question (owner, spoken): ${question}`]
  if (f.transcript_tail.length) {
    lines.push(
      "Recent call context (data, may include the voice model's words):",
      wrapExternal(f.transcript_tail.map((t) => `${t.who}: ${t.text}`).join('\n'), { source: 'Call context' }),
    )
  }
  return {
    content: lines.join('\n'),
    meta: base(a.thread, f.delegation_id, f.ts, 'voice_delegation', a.trust ? 'owner' : 'owner_voice', {
      user: 'owner',
      voice_session_id: f.voice_session_id,
      voice_delegation_id: f.delegation_id,
      ...a.clock,
    }),
  }
}

export function voiceEndedNotification(a: { thread: ThreadRef; frame: Ended }): Notification {
  const f = a.frame
  const body = [`Duration: ${f.duration_s} s`, ...f.transcript.map((t) => `[${t.at}] ${t.who}: ${t.text}`)].join('\n')
  return {
    content: wrapExternal(body, { source: 'Call record' }),
    meta: base(a.thread, f.voice_session_id, f.ts, 'voice_ended', 'external', {
      voice_session_id: f.voice_session_id,
      duration_s: f.duration_s,
    }),
  }
}

export type BacklogItem = {
  thread: ThreadRef
  messageId: string
  at: string
  text: string
  noteFiles?: string[]
  /** Wrapped outside material the message carried (a shared page); kept whole, never indented into the line. */
  shared?: string
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`

export function formatDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(mins / 60)
  return h ? `${h} h ${String(mins % 60)} min` : `${mins} min`
}

/** Only owner items that passed signature checks and waited >15 min; hooks never go in here (3.6). */
export function backlogNotification(a: {
  items: BacklogItem[]
  offlineMs: number
  defaultThread: ThreadRef
  ts: string
  files?: Array<{ path: string; mime: string; name: string }>
  clock?: ClockFields | undefined
}): Notification {
  const head = `Mac was offline ${formatDuration(a.offlineMs)}. ${a.items.length} messages arrived meanwhile (oldest first):`
  const lines = a.items.map((i) => {
    const text = i.text.replace(/\r?\n/g, '\n    ')
    const line = `- ${when(i.at)} [${oneLine(i.thread.name)} · thread_id=${i.thread.id}] ${text}${i.noteFiles?.length ? ` (${i.noteFiles.join(', ')})` : ''}`
    return i.shared ? `${line}\n  Shared with that message:\n${i.shared}` : line
  })
  const newest = a.items[a.items.length - 1] as BacklogItem
  const more = moreFiles(a.files ?? [])
  return {
    content: [head, ...lines, ...(more ? [more] : [])].join('\n'),
    meta: base(a.defaultThread, newest.messageId, a.ts, 'backlog', 'owner', {
      user: 'owner',
      batch_count: a.items.length,
      ...a.clock,
      ...fileMeta(a.files ?? [], { withName: false }), // a file from shared material has a stranger's name; each is named in its own line
    }),
  }
}

export function systemNotification(a: { thread: ThreadRef; text: string; ts: string; id: string }): Notification {
  return { content: a.text, meta: base(a.thread, a.id, a.ts, 'system', 'system') }
}

// ---- Schedules (docs/SCHEDULES.md S6.3) -------------------------------------------------------------------------

/**
 * A scheduled job firing. `trust=owner` because the text comes only from files whose content_hash matches Chronos's approved
 * record (`chronos api session-prompt` refuses with `held` otherwise); no relay frame can produce this. The name reaches the
 * agent ONLY as a JSON-escaped value on the first line, never as free text; the id is constrained by its regex.
 */
export function scheduleRunNotification(a: {
  thread: ThreadRef
  runId: string
  jobId: string
  name: string
  ds: string | undefined
  fireAt: string | undefined
  windowEnds: string | undefined
  guard: string | null
  prompt: string
  ts: string
}): Notification {
  const due = a.fireAt ?? 'now'
  const window = a.windowEnds ? `, window ends ${a.windowEnds}` : ''
  const lines = [
    `Scheduled job ${JSON.stringify({ id: a.jobId, name: a.name.replace(/[\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ') })} is due ${due} (run ${a.runId}${window}).`,
    '1. Call schedule_run_start with this run id. If it says SKIP, stop here.',
    `2. Hand the work to a sub-agent (Agent tool): pass the standing rules and then the job text below, both exactly and in`,
    `   that order, plus the thread "${a.thread.id}" and the due time; ask for a short result. Don't do the heavy work in this conversation.`,
    `3. Post the result to thread ${a.thread.id} with reply, then call schedule_run_done with ok and a one-line summary.`,
  ]
  if (a.guard) lines.push('--- standing rules (guard) ---', a.guard)
  lines.push('--- job ---', a.prompt)
  return {
    content: lines.join('\n'),
    meta: base(a.thread, a.runId, a.ts, 'schedule_run', 'owner', {
      schedule_id: a.jobId,
      run_id: a.runId,
      ds: a.ds,
      fire_at: a.fireAt,
      window_ends: a.windowEnds,
    }),
  }
}

/** The job's files changed outside the app: Chronos holds it, so the session is told not to run it. */
export function scheduleHeldNotification(a: {
  thread: ThreadRef
  jobId: string
  at: string
  ts: string
  id: string
}): Notification {
  return {
    content: `Scheduled job "${a.jobId}" is on hold: its instructions changed outside the app at ${a.at}. Do not run it. Tell the owner in its thread; they can review the change in Schedules.`,
    meta: base(a.thread, a.id, a.ts, 'schedule_held', 'system', { schedule_id: a.jobId }),
  }
}

// ---- MCP apps (MCP-APPS-SPEC M5.4) ------------------------------------------------------------------------------------
// Everything an app says or asks is third-party code's: both kinds are trust=external. The agent acts on `app_tool_call`
// only because the notification's own `kind` meta says so, never because text anywhere claims it.

type AppMeta = { viewId: string; requestId: string; server: string; tool?: string | undefined; label: string }

/** Server and tool names are the server's own text: strip markers and special tokens before they enter a sentence. */
const appText = (s: string) => oneLine(sanitizeExternal(s, 200))

function appMeta(m: AppMeta) {
  return {
    app_view_id: m.viewId,
    app_request_id: m.requestId,
    app_server: m.server,
    app_tool: m.tool,
    app_label: m.label,
  }
}

export function appToolCallNotification(a: {
  thread: ThreadRef
  ts: string
  id: string
  view: AppMeta
  /** Why Talos authorised it: no card (read-only in the approved app) or a card the owner approved. */
  basis: 'read_only' | 'card'
  arguments: Record<string, unknown>
}): Notification {
  const why =
    a.basis === 'read_only' ? 'the tool is read-only in the app the owner approved' : 'the owner approved the card'
  const head = `App "${appText(a.view.label)}" in ${appText(a.thread.name)} asks to call ${appText(a.view.tool ?? '')} on ${appText(a.view.server)}. Talos authorised it (${why}). Call it once with exactly these arguments:`
  const body = wrapExternal(JSON.stringify(a.arguments, null, 2), { source: 'App request' })
  return {
    content: `${head}\n${body}`,
    meta: base(a.thread, a.id, a.ts, 'app_tool_call', 'external', appMeta(a.view)),
  }
}

export function appMessageNotification(a: {
  thread: ThreadRef
  ts: string
  id: string
  view: AppMeta
  text: string
}): Notification {
  const body = wrapExternal(a.text, {
    source: `App "${appText(a.view.label)}" (${appText(a.view.server)})`,
    from: 'the app, after a tap',
  })
  return { content: body, meta: base(a.thread, a.id, a.ts, 'app_message', 'external', appMeta(a.view)) }
}

/** The line `card_action` adds for an `app_action` card the agent runs (M5.4). */
export function appCardActionLine(a: { tool: string; server: string; payloadPath: string }): string {
  return `This approves one app request: call ${appText(a.tool)} on ${appText(a.server)} once with exactly the approved arguments in ${a.payloadPath}. Talos checks them and returns the result to the app.`
}

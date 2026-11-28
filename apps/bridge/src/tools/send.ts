// `reply` and `attach`: one agent message into a thread, with files and optional voice (spec 4.4).
import {
  type AttachmentRefT,
  DETAILS_IN_THREAD,
  drivingActive,
  effectiveSessionOpts,
  type MessageT,
  newId,
  parentThread,
  spokenText,
  wantVoiceReply,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { replyFrame } from '../frames-out.ts'
import { inlineCommandNote } from '../inline-commands.ts'
import { kindFor } from '../media.ts'
import { say } from '../owner-words.ts'
import { RelayHttpError } from '../relay-http.ts'
import { VOICE_ATTACH_WAIT_MS } from '../speak/service.ts'
import { assertFrameFits, RelayRejectedError } from '../transport.ts'
import { synthesize, type TtsResult } from '../tts.ts'
import { ALWAYS_LOAD, fail, needStr, ok, postThreadArg, str, ToolError, threadProps } from './common.ts'
import { OWN_THREAD, type ToolRecord } from './define.ts'

const MAX_FILES = 10

/** What `checkUploadable` needs to know about a thread session: it is one, and the folder its lead marker sits in. */
function workerOpts(ctx: BridgeContext) {
  if (!ctx.worker) return { worker: false }
  // the EFFECTIVE folder: a sub-thread with none (or sharing its parent's) works in its parent's, so a lead's marker there binds it
  const cwd = effectiveSessionOpts(ctx.config.config, ctx.worker.thread).cwd
  // a sub-thread is bound by its parent lead's markers as well as its own folder's (it may keep a folder outside the parent's)
  const parentCwd = parentThread(ctx.config.config, ctx.worker.thread)?.session_opts?.cwd
  return {
    worker: true,
    thread: ctx.worker.thread,
    ...(cwd ? { leadCwd: cwd } : {}),
    ...(parentCwd ? { leadParentCwd: parentCwd } : {}),
  }
}

export async function uploadAll(ctx: BridgeContext, paths: string[]): Promise<AttachmentRefT[]> {
  if (paths.length > MAX_FILES) throw new ToolError(`at most ${MAX_FILES} files per message`)
  // validate everything first so a bad third path does not leave two orphan uploads
  for (const p of paths) {
    try {
      ctx.media.checkUploadable(p, workerOpts(ctx))
    } catch (e) {
      throw new ToolError((e as Error).message)
    }
  }
  const out: AttachmentRefT[] = []
  for (const p of paths) out.push(await ctx.media.upload(p, { sender: workerOpts(ctx) }))
  return out
}

/**
 * The frame itself was refused, so it can never land: the hub or the relay said no, or the relay answered 400 or 413 (it checks
 * a repeated frame id before those, so a frame it already holds never gets them). A 401, 408 or 429 says only that this one
 * request was not stored, while the frame may have landed another way (main's own send of a thread session's post); anything
 * else may have landed too.
 */
function neverDelivered(e: unknown): boolean {
  if (e instanceof RelayRejectedError) return true
  return e instanceof RelayHttpError && (e.status === 400 || e.status === 413)
}

/** Sends the message and records it. Returns the status text for the tool result. */
export async function deliverAgentMessage(
  ctx: BridgeContext,
  message: MessageT,
  extra: { silent?: boolean },
): Promise<string> {
  const frame = replyFrame(ctx.clock.now(), message, extra)
  assertFrameFits(frame) // before the local history takes a message that could never be delivered
  // stored first, so the relay's ack can set its seq; taken out again only when it is certain nothing will ever deliver it (the
  // hub refused a thread session's post, the relay rejected it): a refused reply must not stay in the Mac's history as if the
  // owner had seen it. A timeout, a dropped connection or a server error may still have reached the relay, so that row stays.
  ctx.store.addMessage(message)
  let r: Awaited<ReturnType<typeof ctx.transport.sendDurable>>
  try {
    r = await ctx.transport.sendDurable(frame)
  } catch (e) {
    if (neverDelivered(e) && !ctx.store.outboxGet(frame.id)) ctx.store.deleteMessage(message.id)
    throw e
  }
  if (r.state === 'acked' && r.seq !== undefined) ctx.store.setSeq(message.id, r.seq)
  ctx.seen.answered(message.thread_id) // D39: only a post in the thread settles what the owner sent; a read or a status line does not
  return r.state === 'acked'
    ? `sent (id: ${message.id})`
    : `queued (id: ${message.id}); the relay is unreachable, will retry`
}

const filesFrom = (v: unknown): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
    throw new ToolError('files must be an array of absolute paths')
  return v as string[]
}

export const reply: ToolRecord = {
  name: 'reply',
  _meta: ALWAYS_LOAD,
  group: 'core',
  headless: true,
  ...OWN_THREAD,
  instructions: `Messages from the Talos app arrive as <channel source="talos-app" thread_id=… message_id=… kind=… trust=…>. The owner reads the app, not this terminal. Answer with \`reply\`, passing \`thread_id\` back unchanged; never answer in a different thread. Threads are topics. Reply in the thread a message came from.`,
  told: ['main'],
  description:
    'Send a message to the owner in a thread. Pass thread_id back unchanged from the notification. Optional: files (absolute paths), voice_text (the spoken version, made into audio), silent (no push).',
  inputSchema: {
    type: 'object',
    properties: {
      ...threadProps,
      text: { type: 'string' },
      reply_to: { type: 'string', description: 'message_id being answered' },
      files: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_FILES,
        description: 'Absolute paths, 50 MB each at most.',
      },
      format: { type: 'string', enum: ['markdown', 'plain'], description: 'Default markdown.' },
      voice_text: {
        type: 'string',
        description: say({
          mac: 'Spoken version, up to 1500 characters, made into audio (attached, or sent just after when it takes longer or in Driving mode). Needs a TTS command on the Mac; the spoken-replies setting does not matter.',
          linux:
            'Spoken version, up to 1500 characters, made into audio (attached, or sent just after when it takes longer or in Driving mode). Needs a TTS command on this computer; the spoken-replies setting does not matter.',
        }),
      },
      silent: { type: 'boolean' },
    },
    required: ['text'],
  },
  async handler(ctx, args) {
    try {
      const threadId = postThreadArg(ctx, args)
      const text = needStr(args, 'text', 32_000)
      const voiceText = str(args.voice_text)
      if (voiceText && voiceText.length > 1500) throw new ToolError('voice_text is over 1500 characters')
      const cfg = ctx.config.config
      const now = ctx.clock.now()
      // docs/V2-FEATURES.md V4.1: driving mode speaks every reply, but the TEXT goes out first and the voice follows
      const driving = drivingActive(cfg, now)
      // `voice_text` always makes audio when a TTS command is set up; the owner's setting (or driving mode) only adds voice to a
      // reply that carries none. When no audio can be made, say so in the result, so the agent can send an audio file instead of
      // thinking it spoke.
      const wantVoice = Boolean(voiceText) || wantVoiceReply(cfg, now)
      const spoken = wantVoice ? (spokenText(text, voiceText) ?? DETAILS_IN_THREAD) : ''
      // Outside driving mode the audio is made while the files are read, and waited for a limited time: a hanging TTS command
      // must not hold the text. Past the wait the text goes out alone and the audio follows as its own message.
      const voiceP = wantVoice && !driving ? voiceAttachment(ctx, spoken) : null
      const cutoff = voiceP ? replyCutoff(ctx) : null
      let attachments: AttachmentRefT[]
      try {
        attachments = await uploadAll(ctx, filesFrom(args.files))
      } catch (e) {
        cutoff?.cancel()
        throw e
      }
      let noVoice = ''
      let lateVoice: Promise<VoiceResult> | null = null
      if (voiceP && cutoff) {
        const got = await Promise.race([voiceP, cutoff.promise])
        cutoff.cancel()
        if (got === LATE) lateVoice = voiceP
        else if (got.ok) attachments.push(got.ref)
        else {
          ctx.log.info('voice reply skipped', { reason: got.reason })
          if (voiceText) noVoice = got.reason
        }
      }
      const replyTo = str(args.reply_to)
      const message: MessageT = {
        id: newId('m'),
        thread_id: threadId,
        author: 'agent',
        kind: 'text',
        text,
        format: args.format === 'plain' ? 'plain' : 'markdown',
        ...(replyTo && /^m_[0-9A-HJKMNP-TV-Z]{26}$/.test(replyTo) ? { reply_to: replyTo } : {}),
        attachments,
        via: ctx.mode === 'live' ? 'app' : 'headless',
        created_at: new Date(ctx.clock.now()).toISOString(),
      }
      const status = await deliverAgentMessage(ctx, message, {
        ...(args.silent === true ? { silent: true } : {}),
      })
      // never awaited: a slow TTS holds neither the reply nor this tool call (driving mode, or audio that missed the wait)
      if (wantVoice && driving) void sendVoiceFollowUp(ctx, message, spoken)
      else if (lateVoice) void deliverVoiceFollowUp(ctx, message, lateVoice)
      // after the send, so a failed one never carries it; the message itself is not touched
      const inline = inlineCommandNote(text)
      const notes = [
        ...(noVoice ? [`voice_text made no audio: ${noVoice}. Send an audio file in files if he needs one.`] : []),
        ...(inline ? [inline] : []),
      ]
      return ok(notes.length ? `${status}\n${notes.join('\n')}` : status)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

type VoiceResult = { ok: true; ref: AttachmentRefT } | { ok: false; reason: string }
const LATE = Symbol('voice audio not ready in time')

/** A timer for how long the reply waits for its audio, on the bridge's clock; `cancel` frees it. */
function replyCutoff(ctx: BridgeContext): { promise: Promise<typeof LATE>; cancel: () => void } {
  let handle: unknown
  const promise = new Promise<typeof LATE>((resolve) => {
    handle = ctx.clock.setTimeout(() => resolve(LATE), ctx.speak?.replyWaitMs ?? VOICE_ATTACH_WAIT_MS)
  })
  return { promise, cancel: () => ctx.clock.clearTimeout(handle) }
}

/** The audio for `spoken`, made and uploaded. Never rejects: every failure is a reason. */
async function voiceAttachment(ctx: BridgeContext, spoken: string): Promise<VoiceResult> {
  const id = newId('m').slice(2)
  let tts: TtsResult
  try {
    tts = ctx.speak ? await ctx.speak.synthesizeForReply(spoken, id) : await synthesize(ctx.env, ctx.paths, spoken, id)
  } catch (e) {
    ctx.log.warn('voice audio not made', { error: (e as Error).message })
    return { ok: false, reason: 'text to speech failed' }
  }
  if (!tts.ok) return { ok: false, reason: tts.reason }
  try {
    const ref = await ctx.media.upload(tts.path, {
      role: 'voice_reply',
      name: `reply.${tts.ext}`,
      mime: tts.mime,
      kind: 'audio',
    })
    return { ok: true, ref }
  } catch (e) {
    ctx.log.warn('voice audio not uploaded', { error: (e as Error).message })
    return { ok: false, reason: 'upload failed' }
  }
}

/**
 * Driving mode's spoken follow-up (V4.1.2): its own message, `reply_to` the text it reads, with a `voice_reply`
 * attachment. Sent `silent` so a driving reply pushes once, not twice (review note B). Failures only log.
 */
export const sendVoiceFollowUp = (ctx: BridgeContext, replyTo: MessageT, spoken: string): Promise<void> =>
  deliverVoiceFollowUp(ctx, replyTo, voiceAttachment(ctx, spoken))

/** The audio that comes after its text (driving mode, or a reply whose audio missed the wait): one silent message. Failures only log. */
export async function deliverVoiceFollowUp(
  ctx: BridgeContext,
  replyTo: MessageT,
  voiceP: Promise<VoiceResult>,
): Promise<void> {
  try {
    const voice = await voiceP
    if (!voice.ok) {
      ctx.log.info('voice follow-up skipped', { reason: voice.reason })
      return
    }
    const message: MessageT = {
      id: newId('m'),
      thread_id: replyTo.thread_id,
      author: 'agent',
      kind: 'file',
      format: 'plain',
      reply_to: replyTo.id,
      attachments: [voice.ref],
      via: replyTo.via,
      created_at: new Date(ctx.clock.now()).toISOString(),
    }
    await deliverAgentMessage(ctx, message, { silent: true })
  } catch (e) {
    ctx.log.warn('voice follow-up failed', { error: (e as Error).message })
  }
}

export const attach: ToolRecord = {
  name: 'attach',
  group: 'core',
  headless: true,
  ...OWN_THREAD,
  instructions: null,
  told: [],
  description: 'Send one file into a thread. An .html file becomes a page card the owner can open in the app.',
  inputSchema: {
    type: 'object',
    properties: {
      ...threadProps,
      path: { type: 'string', description: 'Absolute path, 50 MB at most.' },
      caption: { type: 'string' },
      title: { type: 'string', description: 'Display name for the file or page.' },
    },
    required: ['path'],
  },
  async handler(ctx, args) {
    try {
      const threadId = postThreadArg(ctx, args)
      const path = needStr(args, 'path')
      const caption = str(args.caption)
      if (caption && caption.length > 32_000) throw new ToolError('caption is too long')
      ctx.media.checkUploadable(path, workerOpts(ctx))
      const title = str(args.title)
      const ref = await ctx.media.upload(path, { sender: workerOpts(ctx), ...(title ? { name: title } : {}) })
      const message: MessageT = {
        id: newId('m'),
        thread_id: threadId,
        author: 'agent',
        kind: 'file',
        ...(caption ? { text: caption } : {}),
        format: 'markdown',
        attachments: [{ ...ref, kind: kindFor(ref.mime) }],
        via: ctx.mode === 'live' ? 'app' : 'headless',
        created_at: new Date(ctx.clock.now()).toISOString(),
      }
      return ok(await deliverAgentMessage(ctx, message, {}))
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

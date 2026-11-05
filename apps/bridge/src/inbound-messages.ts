// Owner messages and voice notes, one at a time and as a backlog after the Mac was offline.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import type { AttachmentRefT, MessageT } from '@talos-app/protocol'
import { type AttachmentSource, attachmentDropNote } from './attachment-retry.ts'
import { clockMeta, localTime } from './clock-meta.ts'
import { defaultThreadRef, threadRef } from './context.ts'
import { receiptFrame, transcriptFrame } from './frames-out.ts'
import type { Inbound } from './inbound.ts'
import { BACKLOG_PART_BYTES, backlogRowBytes, type Item, type Of, oneLine } from './inbound-shared.ts'
import {
  type BacklogItem,
  backlogNotification,
  shownName,
  textNotification,
  voiceNoteNotification,
  wrapShared,
} from './notify.ts'
import { transcribe } from './stt.ts'

export const messagesFrames = {
  async fetchAttachments(this: Inbound, refs: AttachmentRefT[], threadId?: string, source: AttachmentSource = 'owner') {
    const files: Array<{ path: string; mime: string; name: string }> = []
    const notes: string[] = []
    for (const ref of refs) {
      try {
        const d = await this.ctx.media.download(ref)
        files.push({ path: d.path, mime: ref.mime, name: ref.name })
      } catch (e) {
        // a failed size/hash check is dropped for good; any other failure is kept so the agent can retry it
        notes.push(attachmentDropNote(this.ctx, ref, e, threadId, source))
      }
    }
    return { files, notes }
  },

  record(this: Inbound, m: Omit<MessageT, 'format' | 'via'> & Partial<Pick<MessageT, 'format' | 'via'>>) {
    this.ctx.store.addMessage({ format: 'plain', via: 'app', ...m } as MessageT)
  },

  seq(this: Inbound, it: Item): number | undefined {
    return (it.raw.relay as { seq?: number } | undefined)?.seq
  },

  /** What a message carries besides its text: downloaded files, and the outcome of an attached memory note. */
  async messageExtras(this: Inbound, f: Of<'message'>) {
    const { files, notes } = await this.fetchAttachments(f.attachments, f.thread_id, f.share_content ? 'page' : 'owner')
    // [Ask {agent}] on a memory note (docs/V2-FEATURES.md V5.2): re-checked here; a ref no longer allowed is dropped
    let refMeta: Record<string, string> | undefined
    if (f.refs?.length) {
      const m = this.ctx.memory
      if (m?.available && m.enabled()) {
        const r = m.checkRefs(f.refs)
        refMeta = r.meta
        notes.push(...r.notes)
      } else notes.push("(A note was attached, but the memory browser is off, so it wasn't shared.)")
    }
    return { files, notes, refMeta }
  },

  /** The history row for an owner message: everything the frame carried, whichever path delivers it. */
  messageRow(this: Inbound, it: Item, f: Of<'message'>) {
    return {
      id: f.client_msg_id,
      thread_id: f.thread_id,
      ...(this.seq(it) !== undefined ? { seq: this.seq(it) as number } : {}),
      author: 'owner' as const,
      kind: f.attachments.length ? ('file' as const) : ('text' as const),
      text: f.text,
      ...(f.reply_to ? { reply_to: f.reply_to } : {}),
      attachments: f.attachments,
      ...(f.refs?.length ? { refs: f.refs } : {}),
      ...(f.share_content ? { share_content: f.share_content } : {}),
      created_at: f.ts,
    }
  },

  async onMessage(this: Inbound, it: Item, f: Of<'message'>) {
    const { ctx } = this
    if (ctx.store.hasSeen(f.client_msg_id)) return this.done(it) // a replay under a new frame id: consumed, not notified twice
    if (!ctx.config.thread(f.thread_id))
      return this.reject(it, 'bad_frame', `unknown thread ${f.thread_id}`, [f.client_msg_id])
    const thread = threadRef(ctx, f.thread_id)
    if (f.intent === 'run') return this.onRun(it, f, thread)
    const { files, notes, refMeta } = await this.messageExtras(f)
    const prev = ctx.store.kvGet('last_owner_ts')
    this.record(this.messageRow(it, f))
    await ctx.emit(
      textNotification({
        thread,
        messageId: f.client_msg_id,
        ts: f.ts,
        text: f.text,
        writtenAt: f.original_ts,
        ...(f.intent === 'what_did_i_miss' ? { askedSince: prev ?? 'the start' } : {}),
        files,
        notes,
        // the signed /share page: the typed note is owner words, the shared material is data (V4.7)
        shareContent: f.share_content,
        extraMeta: refMeta,
        clock: clockMeta(ctx, thread.id, f.ts, f.client_msg_id),
      }),
    )
    ctx.store.kvSet('last_owner_ts', f.ts)
    this.afterOwnerNotify(thread.id, f.client_msg_id)
    this.done(it, [f.client_msg_id])
  },

  afterOwnerNotify(this: Inbound, threadId: string, messageId: string) {
    // A message the router gave to a thread's own worker is not persisted here (SeenTracker.routerOwns): the router tracks it.
    // One that fell back to this session is, so a main session that dies with it in flight is reported.
    this.ctx.seen.add(threadId, messageId)
    this.ctx.transport.sendEphemeral(receiptFrame(this.ctx.clock.now(), messageId, 'delivered'))
  },

  /** Download, transcribe, and produce the content for one voice note (shared by single and backlog paths). */
  async voiceNoteContent(this: Inbound, f: Of<'voice_note'>) {
    const { ctx } = this
    const att = f.attachment
    const dl = await this.fetchAttachments([att], f.thread_id)
    const durationS = att.duration_ms === undefined ? undefined : att.duration_ms / 1000
    const file = dl.files[0]
    if (!file) {
      this.fire(transcriptFrame(ctx.clock.now(), f.client_msg_id, '', 'none', 'failed'))
      return {
        content: dl.notes[0] ?? '(voice note could not be fetched or verified and was dropped)',
        status: 'failed' as const,
        engine: 'none',
        durationS,
        file: undefined,
      }
    }
    if (ctx.env.sttCmd || ctx.env.sttLongCmd)
      this.fire(transcriptFrame(ctx.clock.now(), f.client_msg_id, '', 'stt', 'pending'))
    const r = await transcribe(ctx.env, file.path, durationS)
    if (r.status === 'done') {
      this.fire(transcriptFrame(ctx.clock.now(), f.client_msg_id, r.text, r.engine, 'done'))
      return { content: r.text, status: 'done' as const, engine: r.engine, durationS, file }
    }
    if (r.status === 'failed') {
      this.fire(transcriptFrame(ctx.clock.now(), f.client_msg_id, '', r.engine, 'failed'))
      return {
        content: `(voice note; transcription failed: ${r.reason})`,
        status: 'failed' as const,
        engine: r.engine,
        durationS,
        file,
      }
    }
    this.fire(transcriptFrame(ctx.clock.now(), f.client_msg_id, '', 'none', 'failed'))
    return {
      content: '(voice note; no transcriber configured)',
      status: 'failed' as const,
      engine: undefined,
      durationS,
      file,
    }
  },

  async onVoiceNote(this: Inbound, it: Item, f: Of<'voice_note'>) {
    const { ctx } = this
    if (ctx.store.hasSeen(f.client_msg_id)) return this.done(it)
    if (!ctx.config.thread(f.thread_id))
      return this.reject(it, 'bad_frame', `unknown thread ${f.thread_id}`, [f.client_msg_id])
    const thread = threadRef(ctx, f.thread_id)
    const v = await this.voiceNoteContent(f)
    this.record({
      id: f.client_msg_id,
      thread_id: f.thread_id,
      ...(this.seq(it) !== undefined ? { seq: this.seq(it) as number } : {}),
      author: 'owner',
      kind: 'voice_note',
      text: v.status === 'done' ? v.content : '',
      attachments: [f.attachment],
      transcript: {
        text: v.status === 'done' ? v.content : '',
        engine: (v.engine ?? 'none').slice(0, 40),
        status: v.status,
      },
      created_at: f.ts,
    })
    await ctx.emit(
      voiceNoteNotification({
        thread,
        messageId: f.client_msg_id,
        ts: f.ts,
        content: v.content,
        writtenAt: f.original_ts,
        audioPath: v.file?.path,
        engine: v.engine,
        durationS: v.durationS,
        clock: clockMeta(ctx, thread.id, f.ts, f.client_msg_id),
      }),
    )
    ctx.store.kvSet('last_owner_ts', f.ts)
    this.afterOwnerNotify(thread.id, f.client_msg_id)
    this.done(it, [f.client_msg_id])
  },

  async handleBacklog(this: Inbound, items: Item[]) {
    const { ctx } = this
    // one row per message that is kept, with the files it carried: the rows are cut into notifications below
    const rows: Array<{ it: Item; entry: BacklogItem; files: Array<{ path: string; mime: string; name: string }> }> = []
    for (const it of items) {
      const f = it.frame as Of<'message'> | Of<'voice_note'>
      if (!ctx.config.thread(f.thread_id)) {
        this.reject(it, 'bad_frame', `unknown thread ${f.thread_id}`, [f.client_msg_id])
        continue
      }
      const thread = threadRef(ctx, f.thread_id)
      if (f.type === 'message') {
        const { files: fs, notes, refMeta } = await this.messageExtras(f)
        this.record(this.messageRow(it, f))
        if (refMeta?.memory_path)
          notes.push(
            `(attached note: ${oneLine(refMeta.memory_path)}${refMeta.memory_changed ? ', changed since you opened it' : ''})`,
          )
        rows.push({
          it,
          files: fs,
          entry: {
            thread,
            messageId: f.client_msg_id,
            at: f.ts,
            text: f.text,
            // outside material: wrapped as data exactly as the single-message path does, file names included
            ...(f.share_content && (Object.keys(f.share_content).length > 0 || fs.length > 0)
              ? {
                  noteFiles: notes,
                  shared: wrapShared(
                    f.share_content,
                    'Shared page',
                    undefined,
                    fs.map((x) => x.name),
                  ),
                }
              : { noteFiles: [...fs.map((x) => shownName(x.name)), ...notes] }),
          },
        })
      } else {
        const v = await this.voiceNoteContent(f)
        this.record({
          id: f.client_msg_id,
          thread_id: f.thread_id,
          ...(this.seq(it) !== undefined ? { seq: this.seq(it) as number } : {}),
          author: 'owner',
          kind: 'voice_note',
          text: v.status === 'done' ? v.content : '',
          attachments: [f.attachment],
          transcript: {
            text: v.status === 'done' ? v.content : '',
            engine: (v.engine ?? 'none').slice(0, 40),
            status: v.status,
          },
          created_at: f.ts,
        })
        rows.push({
          it,
          files: v.file ? [v.file] : [],
          entry: { thread, messageId: f.client_msg_id, at: f.ts, text: `(voice note) ${v.content}` },
        })
      }
    }
    if (!rows.length) return
    const oldest = Math.min(...items.map((i) => this.receivedAtOf(i)))
    const now = ctx.clock.now()
    // Cut into notifications of at most BACKLOG_PART_BYTES (a guess: Claude Code's own limit is not known). Each part is
    // acknowledged right after its own notification is handed over, so a failure on part 3 leaves parts 3.. unconsumed.
    for (let at = 0; at < rows.length; ) {
      let size = 0
      let end = at
      while (end < rows.length && (end === at || size + backlogRowBytes(rows[end]?.entry) <= BACKLOG_PART_BYTES))
        size += backlogRowBytes(rows[end++]?.entry)
      const part = rows.slice(at, end)
      at = end
      await ctx.emit(
        backlogNotification({
          items: part.map((r) => r.entry),
          offlineMs: now - oldest,
          defaultThread: defaultThreadRef(ctx),
          ts: new Date(now).toISOString(),
          files: part.flatMap((r) => r.files),
          clock: { local_time: localTime(new Date(now).toISOString(), ctx.config.config.timezone) },
        }),
      )
      ctx.store.kvSet('last_owner_ts', part[part.length - 1]?.it.frame.ts ?? new Date(now).toISOString())
      for (const { it } of part) {
        const f = it.frame as Of<'message'> | Of<'voice_note'>
        this.afterOwnerNotify(f.thread_id, f.client_msg_id)
        this.done(it, [f.client_msg_id])
      }
    }
  },
}

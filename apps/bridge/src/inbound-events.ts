// Voice calls, shared items, problem reports and webhook events.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import { SHARE_THREAD, trustOn } from '@talos-app/protocol'
import { localClock } from './clock-meta.ts'
import { defaultThreadRef, threadRef } from './context.ts'
import type { Inbound } from './inbound.ts'
import type { Item, Of } from './inbound-shared.ts'
import {
  hookDigestNotification,
  hookEventNotification,
  shareItemNotification,
  voiceDelegationNotification,
  voiceEndedNotification,
} from './notify.ts'
import { fileShare } from './share/inbox-file.ts'
import { recordVoiceAsk } from './trust.ts'

export const eventsFrames = {
  async onVoiceAsk(this: Inbound, it: Item, f: Of<'voice.ask'>) {
    const { ctx } = this
    const thread = ctx.config.thread(f.thread_id) ? threadRef(ctx, f.thread_id) : defaultThreadRef(ctx)
    // Calls are not stored as message rows, so the time of the question is kept for `ownerAskedIn` (trust mode only reads it)
    recordVoiceAsk(ctx, thread.id)
    await ctx.emit(
      voiceDelegationNotification({
        thread,
        frame: f,
        trust: trustOn(ctx.config.config),
        clock: localClock(ctx, f.ts),
      }),
    )
    this.done(it)
  },

  async onVoiceEnded(this: Inbound, it: Item, f: Of<'voice.ended'>) {
    const { ctx } = this
    const thread = ctx.config.thread(f.thread_id) ? threadRef(ctx, f.thread_id) : defaultThreadRef(ctx)
    await ctx.emit(voiceEndedNotification({ thread, frame: f }))
    this.done(it)
  },

  /**
   * A Shortcut share (docs/V2-FEATURES.md V4.3): stored in history.sqlite (so it is searchable after the relay buffer
   * ages out), FILED by the bridge into the shared inbox (zero taps, no agent judgment; review note A), then notified
   * as `trust=external`. A replay under a new frame id is consumed without a second notification or a second filing.
   */
  async onShareItem(this: Inbound, it: Item, f: Of<'share.item'>) {
    const { ctx } = this
    const m = f.message
    if (ctx.store.hasSeen(m.id)) return this.done(it)
    if (m.thread_id !== SHARE_THREAD || m.via !== 'share' || m.author !== 'owner')
      return this.reject(it, 'bad_frame', 'a share must be an owner row in inbox via share', [m.id])
    const thread = ctx.config.thread(SHARE_THREAD) ? threadRef(ctx, SHARE_THREAD) : defaultThreadRef(ctx)
    const fetched = await this.fetchAttachments(m.attachments, thread.id, 'token')
    const { files } = fetched
    // The dropped-file note names the file, and that name is the sender's text: say only how many, never the name, so
    // nothing the sender chose sits outside the wrapper (V4.7).
    const dropped = fetched.notes.length
    const notes = dropped
      ? [
          `(${dropped === 1 ? 'a shared file' : `${dropped} shared files`} could not be fetched or verified and was dropped)`,
        ]
      : []
    this.record({ ...m, ...(this.seq(it) !== undefined ? { seq: this.seq(it) as number } : {}) })
    const filedPath = fileShare(ctx, {
      shareId: f.share_id,
      label: f.token_label,
      message: m,
      files: files.map((x) => x.path),
    })
    await ctx.emit(shareItemNotification({ thread, frame: f, files, notes, filedPath }))
    this.done(it, [m.id])
  },

  /**
   * A problem report (docs/ERRORS.md): filed under `problems/open/`, answered `consumed` only once it is on disk. A write
   * that fails is not consumed, so the relay sends it again; nothing is lost and nothing is announced as filed. This never
   * emits a channel notification: a report is not an instruction and wakes nobody.
   */
  async onProblemItem(this: Inbound, it: Item, f: Of<'problem.item'>) {
    const { ctx } = this
    if (!ctx.problems) return this.reject(it, 'bad_frame', 'this process does not file problem reports')
    if ((await ctx.problems.onItem(f.problem)) === 'done') return this.done(it)
    // Not filed: forget that it is being handled, so the relay's resend gets a fresh try. No `consumed`, no seen mark.
    this.inflight.delete(it.frame.id)
  },

  async onHookEvent(this: Inbound, it: Item, f: Of<'hook.event'>) {
    const { ctx } = this
    const thread = ctx.config.thread(f.event.thread) ? threadRef(ctx, f.event.thread) : defaultThreadRef(ctx)
    await ctx.emit(hookEventNotification({ thread, event: f.event, delivery: f.delivery }))
    this.done(it)
  },

  async onHookDigest(this: Inbound, it: Item, f: Of<'hook.digest'>) {
    const { ctx } = this
    const thread = ctx.config.thread('inbox') ? threadRef(ctx, 'inbox') : defaultThreadRef(ctx)
    await ctx.emit(hookDigestNotification({ thread, frame: f }))
    this.done(it)
  },
}

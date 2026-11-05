// An owner attachment that could not be downloaded for a reason other than a failed check (the relay unreachable or silent,
// a full disk). The signed ref is kept, the owner is told in the thread, and the agent gets a note naming `retry_attachment`.
// A size or sha256 mismatch is different: that file is dropped for good and nothing is kept (see MediaError).
import { type AttachmentRefT, threadSessionMode } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice, threadRef } from './context.ts'
import { MediaError } from './media.ts'
import { shownName } from './notify.ts'
import { RelayHttpError } from './relay-http.ts'

const PREFIX = 'attachment_retry:'
/** The relay keeps an upload this long (docs/bridge.md); after that a retry can only find nothing. */
export const ATTACHMENT_RETRY_MS = 7 * 24 * 3600_000

type Pending = { ref: AttachmentRefT; at: number }

/** A file the owner sent, named on one line and cut short. */
const oneLine = (s: string) => shownName(s.replace(/[\r\n]+/g, ' ').replace(/"/g, "'"))

/** The relay's "larger than its signed size" is a failed check too, not a transport failure. */
const failedCheck = (e: unknown) => e instanceof MediaError || (e instanceof RelayHttpError && e.status === 413)

/** Where an attachment came from, which decides whether its name may be shown. */
export type AttachmentSource =
  /** The owner's own message: the name is shown, cut short. */
  | 'owner'
  /** The signed Share page: the owner sent it, but a stranger chose the name. Retryable, never named. */
  | 'page'
  /** A share token: a stranger's file. Never named, and nothing is kept for a retry. */
  | 'token'

/**
 * Handles one attachment that did not download. Returns the line the agent reads in place of the file. A transport failure
 * is kept for `retry_attachment` and shown to the owner; a failed check is only logged, as before.
 * `page` and `token` files are never named in a note or a system row, because the name is a stranger's text; a `token` file
 * is also not kept for a retry. A thread with its own session cannot call `retry_attachment`, so there the owner is asked
 * to send the file again.
 */
export function attachmentDropNote(
  ctx: BridgeContext,
  ref: AttachmentRefT,
  err: unknown,
  threadId?: string,
  source: AttachmentSource = 'owner',
): string {
  const named = source === 'owner'
  const name = oneLine(ref.name)
  const error = err instanceof Error ? err.message : String(err)
  if (failedCheck(err)) {
    ctx.log.security('attachment dropped', { media_id: ref.media_id, error })
    return named
      ? `(attachment "${name}" could not be fetched or verified and was dropped)`
      : '(a shared file could not be fetched or verified and was dropped)'
  }
  ctx.log.warn('attachment not downloaded', { media_id: ref.media_id, error })
  const dedicated = Boolean(threadId) && threadSessionMode(ctx.config.config, threadId as string) === 'dedicated'
  const retryable = source !== 'token' && !dedicated
  if (retryable) {
    const pending: Pending = { ref, at: ctx.clock.now() }
    ctx.store.kvSet(PREFIX + ref.media_id, JSON.stringify(pending))
  }
  const again = retryable ? 'Your agent can try again, or you can send it again.' : 'Send it again.'
  const text =
    source === 'token'
      ? 'A shared file could not be downloaded to your Mac and was dropped. Share it again if you still need it.'
      : `${named ? `The file "${name}"` : 'A shared file'} could not be downloaded to your Mac, so your agent did not get it. ${again}`
  void postSystemNotice(
    ctx,
    text,
    threadId && ctx.config.thread(threadId) ? { thread: threadRef(ctx, threadId) } : {},
  ).catch((e) => ctx.log.warn('attachment notice not posted', { error: (e as Error).message }))
  if (source === 'token') return '(a shared file could not be downloaded and was dropped)'
  const what = named ? `attachment "${name}"` : 'a shared file'
  return retryable
    ? `(${what} could not be downloaded from the relay and was not delivered; try again with retry_attachment, media_id ${ref.media_id})`
    : `(${what} could not be downloaded from the relay and was not delivered; ask the owner to send it again)`
}

/** `retry_attachment`: downloads a kept ref again. Throws a readable error; the record stays unless the file can never arrive. */
export async function retryAttachment(ctx: BridgeContext, mediaId: string): Promise<string> {
  const key = PREFIX + mediaId
  let pending: Pending | undefined
  try {
    pending = JSON.parse(ctx.store.kvGet(key) ?? 'null') as Pending | undefined
  } catch {
    pending = undefined
  }
  if (!pending?.ref) {
    throw new Error(
      `no failed download with media_id ${mediaId}: it arrived, was dropped for failing its check, or the record expired`,
    )
  }
  try {
    const d = await ctx.media.download(pending.ref)
    ctx.store.kvDelete(key)
    return `Downloaded ${mediaId} (${pending.ref.mime}) to ${d.path}`
  } catch (e) {
    if (failedCheck(e)) {
      ctx.store.kvDelete(key)
      ctx.log.security('attachment dropped', { media_id: mediaId, error: (e as Error).message })
      throw new Error(
        `${mediaId} no longer matches the size or hash the owner's message signed, so it was dropped for good`,
      )
    }
    if (e instanceof RelayHttpError && (e.status === 404 || e.status === 410)) {
      ctx.store.kvDelete(key)
      throw new Error(`the relay no longer has ${mediaId}; ask the owner to send it again`)
    }
    throw new Error(`still could not download ${mediaId}: ${(e as Error).message}. Try again later.`)
  }
}

/** Failures older than the relay's buffer can never be retried: forget them. Called with the other retention work. */
export function pruneAttachmentRetries(ctx: BridgeContext, now: number): void {
  ctx.store.db
    .query(`DELETE FROM kv WHERE key LIKE ? AND CAST(json_extract(value, '$.at') AS INTEGER) < ?`)
    .run(`${PREFIX}%`, now - ATTACHMENT_RETRY_MS)
}

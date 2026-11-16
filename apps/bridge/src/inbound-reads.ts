// Signed owner reads (search, memory, speak, history pages, media re-upload) and signed app requests.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import {
  AGENTS_MD_WORDING,
  APP_REQUEST_MAX_AGE_MS,
  type ErrorCodeT,
  FILES_PUT_WORDING,
  FILES_WORDING,
  FOLDER_WORDING,
  type Frame,
  HISTORY_UPDATE_APP_MESSAGE,
  MAX_FRAME_BYTES,
  MEDIA_FETCH_UPDATE_APP_MESSAGE,
  MEMORY_ROOTS_WORDING,
  Message,
  type MessageT,
  V2_READ_RESPONSE_FOR,
} from '@talos-app/protocol'
import { appResponseFrame, errorFrame, historyPageFrame, readAnswerFrame } from './frames-out.ts'
import type { Inbound } from './inbound.ts'
import { type Item, type Of, READ_MAX_AGE_MS } from './inbound-shared.ts'
import { say } from './owner-words.ts'
import { frameBytes } from './transport.ts'
import { ReadError } from './v2-seams.ts'

export const readsFrames = {
  /**
   * search.query and memory.tree/read/search: not durable, not consumable, no ack. The signature is checked on the RAW
   * JSON, the id lands in seen_ids (8 days; fine at these rates), and the answer goes back with the same request_id. The
   * seen-id check runs after the signature, so a forged read learns nothing about which ids were used. A missing service
   * answers a fixed code; an answer that would pass the frame cap is refused here, never sent.
   */
  onReadFrame(this: Inbound, it: Item) {
    const { ctx } = this
    const id = it.frame.id
    if (this.inflight.has(id)) return
    this.inflight.add(id)
    this.readQueue = this.readQueue
      .then(async () => {
        const owner = await this.verifyOwner(it, READ_MAX_AGE_MS)
        this.inflight.delete(id)
        if (!owner.ok) return this.ownerFailed(it, owner)
        if (this.refuseReplay(id, 'read')) return
        ctx.store.markSeen(id, ctx.clock.now(), 'ok')
        // an upload fetches up to 50 MB: it runs beside the queue (verified and marked seen first), so the reads behind it
        // are not held, and its own cap of two at once (src/files/put.ts) is what limits it
        if (it.frame.type === 'files.put') void this.answerRead(it.frame)
        else await this.answerRead(it.frame)
      })
      .catch((e) => {
        this.inflight.delete(id)
        ctx.log.error('read frame handling failed', { type: it.frame.type, id, error: (e as Error).message })
      })
  },

  /**
   * history.request (scroll-back, "Show more", the search context view). The Mac keeps history forever, so a request is
   * served only when a pinned, unrevoked owner device signed it (the RAW JSON, like the other reads) and its id has not been
   * seen: the id lands in seen_ids for 8 days, the same span as the `ts` window, so a captured request cannot be replayed.
   * The page goes out as an ephemeral frame and the relay hands it to the asking socket only. A request with no signature
   * (an old app, or a relay inventing one) gets one fixed error and no data. Nothing here logs message content.
   */
  onHistoryFrame(this: Inbound, it: Item) {
    const { ctx } = this
    const id = it.frame.id
    // An unsigned frame always gets the one fixed answer, whatever the Mac has or has not seen (no key-less seen-id oracle).
    if (typeof it.raw.osig !== 'string' || typeof it.raw.device_id !== 'string')
      return this.refuseUnsigned(id, 'history.request')
    if (this.inflight.has(id)) return
    this.inflight.add(id)
    this.readQueue = this.readQueue
      .then(async () => {
        const owner = await this.verifyOwner(it, READ_MAX_AGE_MS)
        this.inflight.delete(id)
        if (!owner.ok) return this.ownerFailed(it, owner)
        // the seen-id check comes AFTER the signature: only a valid signature learns whether an id was used
        if (this.refuseReplay(id, 'history request')) return
        ctx.store.markSeen(id, ctx.clock.now(), 'ok')
        this.onHistoryRequest(it.frame as Of<'history.request'>)
      })
      .catch((e) => {
        this.inflight.delete(id)
        ctx.log.error('history request handling failed', { id, error: (e as Error).message })
      })
  },

  /**
   * The one fixed answer to an unsigned read. The code is NOT sig_invalid: an old build that cannot match the ref turns
   * sig_invalid into a "failed its security check" alarm row in the thread. bad_frame it ignores; a current app shows the
   * message. Nothing is remembered and no data goes out.
   */
  refuseUnsigned(this: Inbound, id: string, type: 'history.request' | 'media.fetch') {
    const { ctx } = this
    ctx.log.security(`${type} unsigned; refused`, { id })
    ctx.transport.sendEphemeral(
      errorFrame(
        ctx.clock.now(),
        'bad_frame',
        type === 'media.fetch' ? MEDIA_FETCH_UPDATE_APP_MESSAGE : HISTORY_UPDATE_APP_MESSAGE,
        id,
      ),
    )
  },

  /**
   * media.fetch: re-uploads a file the Mac still has, but only for a request a pinned owner device signed (the RAW JSON),
   * once. The relay can name any media id it ever stored a row for, so an unsigned or forged request gets one fixed error
   * and nothing is uploaded. Same queue and replay rules as history.request.
   */
  onMediaFetchFrame(this: Inbound, it: Item) {
    const { ctx } = this
    const id = it.frame.id
    if (typeof it.raw.osig !== 'string' || typeof it.raw.device_id !== 'string')
      return this.refuseUnsigned(id, 'media.fetch')
    if (this.inflight.has(id)) return
    this.inflight.add(id)
    this.readQueue = this.readQueue
      .then(async () => {
        const owner = await this.verifyOwner(it, READ_MAX_AGE_MS)
        this.inflight.delete(id)
        if (!owner.ok) return this.ownerFailed(it, owner)
        if (this.refuseReplay(id, 'media fetch')) return
        ctx.store.markSeen(id, ctx.clock.now(), 'ok')
        // not awaited: an upload to a slow relay must not hold up searches and history pages behind it (it catches its own errors)
        void this.onMediaFetch(it.frame as Of<'media.fetch'>)
      })
      .catch((e) => {
        this.inflight.delete(id)
        ctx.log.error('media fetch handling failed', { id, error: (e as Error).message })
      })
  },

  /**
   * `app.request` (MCP-APPS-SPEC M3.4, M4.3 step 1): signed by a pinned device over the RAW JSON, not durable, never
   * replayed. Any failure of step 1 answers `app.response failed sig_invalid` to the asking view and nothing else; the app
   * service takes it from there. The relay stamps its own `relay` block; it is outside the signature.
   */
  onAppFrame(this: Inbound, it: Item) {
    const { ctx } = this
    const f = it.frame as Of<'app.request'>
    const id = f.id
    const refuse = (message: string) => {
      ctx.transport.sendEphemeral(
        appResponseFrame(ctx.clock.now(), {
          view_id: f.view_id,
          request_id: f.request_id,
          state: 'failed',
          error: { code: 'sig_invalid', message },
        }),
      )
    }
    if (this.inflight.has(id)) return
    this.inflight.add(id)
    this.appQueue = this.appQueue
      .then(async () => {
        const owner = await this.verifyOwner(it, APP_REQUEST_MAX_AGE_MS)
        this.inflight.delete(id)
        if (!owner.ok) {
          ctx.log.security('app request dropped', { id, reason: owner.reason, device_id: owner.deviceId })
          return refuse('signature check failed')
        }
        if (ctx.store.hasSeen(id)) {
          ctx.log.security('app request replayed; refused', { id })
          return refuse('That request was already used.')
        }
        ctx.store.markSeen(id, ctx.clock.now(), 'ok')
        if (!ctx.apps)
          return refuse(
            say({ mac: 'Apps are not available on this Mac.', linux: 'Apps are not available on this computer.' }),
          )
        await ctx.apps.onAppRequest(f)
      })
      .catch((e) => {
        this.inflight.delete(id)
        ctx.log.error('app request handling failed', { id, error: (e as Error).message })
        refuse('The request could not be handled.')
      })
  },

  /** A verified owner read/schedule frame whose id was already used: one fixed refusal, no data, no agent notice. */
  refuseReplay(this: Inbound, id: string, what: string): boolean {
    const { ctx } = this
    if (!ctx.store.hasSeen(id)) return false
    ctx.log.security(`${what} replayed; refused`, { id })
    ctx.transport.sendEphemeral(errorFrame(ctx.clock.now(), 'sig_invalid', 'That request was already used.', id))
    return true
  },

  async answerRead(this: Inbound, f: Frame) {
    const { ctx } = this
    const now = () => ctx.clock.now()
    const fail = (code: ErrorCodeT, message: string) =>
      ctx.transport.sendEphemeral(errorFrame(now(), code, message, f.id))
    try {
      let out: Frame
      switch (f.type) {
        case 'search.query': {
          if (!ctx.search?.available)
            return fail(
              'search_unavailable',
              say({ mac: 'Search is not available on this Mac.', linux: 'Search is not available on this computer.' }),
            )
          out = readAnswerFrame(now(), V2_READ_RESPONSE_FOR[f.type], f.request_id, await ctx.search.query(f))
          break
        }
        case 'memory.tree':
        case 'memory.read':
        case 'memory.search':
        case 'memory.graph': {
          const m = ctx.memory
          if (!m?.available || !m.enabled())
            return fail(
              'memory_off',
              say({
                mac: 'The memory browser is off. Turn it on at your Mac: talos-app memory on',
                linux: 'The memory browser is off. Turn it on at your computer: talos-app memory on',
                windows: "The memory browser is off, and it can't be turned on from a Windows PC yet.",
              }),
            )
          if (f.type === 'memory.graph') {
            if (!m.graph)
              return fail(
                'internal',
                say({
                  mac: 'The memory graph is not available on this Mac.',
                  linux: 'The memory graph is not available on this computer.',
                }),
              )
            out = readAnswerFrame(now(), 'memory.graph_result', f.request_id, m.graph())
          } else if (f.type === 'memory.tree')
            out = readAnswerFrame(now(), 'memory.listing', f.request_id, await m.tree(f))
          else if (f.type === 'memory.read') out = readAnswerFrame(now(), 'memory.file', f.request_id, await m.read(f))
          else out = readAnswerFrame(now(), 'memory.results', f.request_id, await m.search(f))
          break
        }
        case 'speak.request': {
          const sp = ctx.speak
          if (!sp?.available)
            return fail(
              'internal',
              say({
                mac: 'Read aloud is not available on this Mac.',
                linux: 'Read aloud is not available on this computer.',
              }),
            )
          out = readAnswerFrame(now(), 'speak.result', f.request_id, await sp.request(f))
          break
        }
        case 'fs.list': {
          // folder NAMES under home for the picker (src/folders/service.ts); it refuses in the one fixed sentence
          const fo = ctx.folders
          if (!fo?.available) return fail('internal', FOLDER_WORDING.notReady)
          out = readAnswerFrame(now(), 'fs.listing', f.request_id, await fo.list(f))
          break
        }
        case 'files.list':
        case 'files.read': {
          // a read-only look at the thread's folder (src/files/service.ts); it refuses in the one fixed sentence
          const fi = ctx.files
          if (!fi?.available) return fail('internal', FILES_WORDING.notReady)
          if (f.type === 'files.list') out = readAnswerFrame(now(), 'files.listing', f.request_id, await fi.list(f))
          else out = readAnswerFrame(now(), 'files.file', f.request_id, await fi.read(f))
          break
        }
        case 'agents_md.read':
        case 'agents_md.write': {
          // the thread's AGENTS.md (src/files/agents-md.ts): its own folder only, a save only over the file it was loaded from
          const am = ctx.agentsMd
          if (!am?.available) return fail('internal', AGENTS_MD_WORDING.notReady)
          const body = f.type === 'agents_md.read' ? await am.read(f) : await am.write(f)
          out = readAnswerFrame(now(), 'agents_md.file', f.request_id, body)
          break
        }
        case 'files.put': {
          // an upload into the thread's folder (src/files/put.ts): created, never over a file that is there
          const fp = ctx.filesPut
          if (!fp?.available) return fail('internal', FILES_PUT_WORDING.notReady)
          out = readAnswerFrame(now(), 'files.put_result', f.request_id, await fp.put(f))
          break
        }
        case 'files.sent': {
          // the files sent in Talos, from history (src/files/sent.ts): every thread the Mac lists, newest first
          const fs = ctx.filesSent
          if (!fs?.available)
            return fail(
              'internal',
              say({
                mac: 'Your Mac is not ready to list sent files.',
                linux: 'Your computer is not ready to list sent files.',
              }),
            )
          out = readAnswerFrame(now(), 'files.sent_list', f.request_id, fs.list(f))
          break
        }
        case 'memory.folders':
        case 'memory.roots_set': {
          // which folders Notes shows (src/memory/roots.ts): names checked against this Mac's own listing before any use
          const mr = ctx.memoryRoots
          if (!mr?.available) return fail('internal', MEMORY_ROOTS_WORDING.notSetUp)
          const body = f.type === 'memory.folders' ? mr.list() : await mr.set(f.names)
          out = readAnswerFrame(now(), 'memory.folders_result', f.request_id, body)
          break
        }
        case 'bug.context': {
          // versions, filed errors and the cleaned log tail for the bug reporter (src/bug-context/service.ts)
          const bc = ctx.bugContext
          if (!bc?.available)
            return fail(
              'internal',
              say({
                mac: 'The bug report details are not available on this Mac.',
                linux: 'The bug report details are not available on this computer.',
              }),
            )
          out = readAnswerFrame(now(), 'bug.context_result', f.request_id, bc.read(f))
          break
        }
        default:
          return
      }
      // The relay hangs up on any frame over MAX_FRAME_BYTES; the services fit by bytes, this is the backstop.
      if (frameBytes(out) > MAX_FRAME_BYTES) {
        ctx.log.error('read answer over the frame cap; refused', { type: out.type })
        return fail('too_large', 'That answer is too large to send.')
      }
      ctx.transport.sendEphemeral(out)
    } catch (e) {
      if (e instanceof ReadError) return fail(e.code, e.message)
      ctx.log.warn('read failed', { type: f.type, error: (e as Error).message })
      return fail(
        f.type === 'search.query' ? 'search_unavailable' : 'internal',
        say({ mac: 'That request failed on your Mac.', linux: 'That request failed on your computer.' }),
      )
    }
  },

  onHistoryRequest(this: Inbound, f: Of<'history.request'>) {
    const { ctx } = this
    // The search context view pages on `ord` by message id (docs/V2-FEATURES.md V3.2); WP-V2's service answers it.
    const byId = f.before_id !== undefined || f.after_id !== undefined || f.around_id !== undefined
    const fromSearch = byId ? (ctx.search?.history?.(f) ?? null) : null
    const page = fromSearch
      ? fromSearch
      : byId && f.before_id === undefined
        ? { messages: [] as MessageT[], hasMore: false } // after_id / around_id need the search service
        : ctx.store.page({
            thread_id: f.thread_id,
            limit: Math.min(f.limit, 100),
            // the app's own scroll-back (no cursor, or the lowest seq it holds): timeline order, so its pages join up
            timeline: true,
            ...(f.before_seq !== undefined ? { beforeSeq: f.before_seq } : {}),
            ...(f.before_ts !== undefined ? { beforeTs: f.before_ts } : {}),
            ...(f.before_id !== undefined ? { beforeId: f.before_id } : {}),
          })
    const extra = {
      ...(byId ? { has_newer: fromSearch ? fromSearch.hasNewer : false } : {}),
      ...(f.around_id !== undefined ? { anchor_id: f.around_id } : {}),
    }
    // The relay hangs up on any frame over MAX_FRAME_BYTES, so the page is cut by bytes, keeping the newest end.
    const now = ctx.clock.now()
    const head: { request_id: string; thread_id: string; has_newer?: boolean; anchor_id?: string } = {
      request_id: f.request_id,
      thread_id: f.thread_id,
      ...extra,
    }
    // A stored row the Message schema refuses (a voice transcript over the 32,000-char text cap, > 10 attachments) would
    // make the relay refuse the whole page as bad_frame: it goes as the stand-in, in its place.
    // A row whose stand-in is refused too (a malformed id or time) is left out.
    const ok = (m: MessageT) => Message.safeParse(m).success
    page.messages = page.messages.flatMap((m) => (ok(m) ? [m] : ok(tooLarge(m)) ? [tooLarge(m)] : []))
    // an owner message's undo point, for the "Undo to here" action, when the relay hands it on (undo/marks.ts)
    if (ctx.undoMarks?.on())
      page.messages = page.messages.map((m) => {
        const undo = m.author === 'owner' ? ctx.undoMarks?.of(m.id) : undefined
        return undo ? { ...m, undo } : m
      })
    let room = MAX_FRAME_BYTES - frameBytes(historyPageFrame(now, { ...head, messages: [], has_more: true })) - 64
    let kept: MessageT[] = []
    let hasMore = page.hasMore
    const sizeOf = (m: MessageT) => Buffer.byteLength(JSON.stringify(m)) + 1
    const n = page.messages.length
    const anchorAt = f.around_id !== undefined ? page.messages.findIndex((m) => m.id === f.around_id) : -1
    if (anchorAt >= 0) {
      // The context view's anchor is the point of the page: keep it, then grow outward from it, older and newer in turn.
      let lo = anchorAt
      let hi = anchorAt
      let anchor = page.messages[anchorAt] as MessageT
      // The hit alone will not fit one frame, and the relay hangs up on an oversize frame. Send the stand-in instead.
      if (sizeOf(anchor) > room) anchor = tooLarge(anchor)
      room -= sizeOf(anchor)
      for (let step = 0; ; step++) {
        const older = step % 2 === 0
        const i = older ? lo - 1 : hi + 1
        if (i < 0 || i >= n) {
          if (lo - 1 < 0 && hi + 1 >= n) break
          continue
        }
        const size = sizeOf(page.messages[i] as MessageT)
        if (size > room) break
        room -= size
        if (older) lo = i
        else hi = i
      }
      kept = page.messages.slice(lo, hi + 1).map((m) => (m.id === anchor.id ? anchor : m))
      if (lo > 0) hasMore = true
      if (hi < n - 1) head.has_newer = true
    } else {
      // `after_id` pages forward (Newer), so it keeps the OLDEST end and says there is more newer; everything else keeps
      // the newest end.
      const forward = f.after_id !== undefined
      // The app's own scroll-back continues from the lowest seq it was shown. A page whose newest rows are a long run
      // with no seq (card rows) could be cut down to that run alone: the app's cursor would then never move, and all that
      // is older would be out of reach. So the numbered row the run follows has its room set aside first and the cut
      // falls inside the run: the run's oldest rows are left out, and the page still moves the cursor.
      const scrollBack = !byId && f.before_ts === undefined
      const rows = page.messages
      let cursorAt = -1
      if (scrollBack) for (let i = n - 1; i >= 0 && cursorAt < 0; i--) if (rows[i]?.seq !== undefined) cursorAt = i
      if (cursorAt >= 0 && sizeOf(rows[cursorAt] as MessageT) > room) cursorAt = -1
      if (cursorAt >= 0) room -= sizeOf(rows[cursorAt] as MessageT)
      /** Adds rows from index `from` down to `to` (newest first) while they fit; true when it stopped early. */
      const takeDown = (from: number, to: number): boolean => {
        for (let i = from; i >= to; i--) {
          const m = rows[i] as MessageT
          const size = sizeOf(m)
          if (size > room) {
            if (kept.length === 0) continue // a single message that can never fit is skipped so paging can move past it
            return true
          }
          room -= size
          kept.unshift(m)
        }
        return false
      }
      if (forward) {
        for (let k = 0; k < n; k++) {
          const m = rows[k] as MessageT
          const size = sizeOf(m)
          if (size > room) {
            head.has_newer = true
            if (kept.length === 0) continue
            break
          }
          room -= size
          kept.push(m)
        }
      } else if (!scrollBack) {
        if (takeDown(n - 1, 0)) hasMore = true
      } else {
        const cutInRun = takeDown(n - 1, cursorAt + 1)
        if (cursorAt >= 0) {
          kept.unshift(rows[cursorAt] as MessageT) // its room was set aside above
          if (cutInRun) hasMore = hasMore || cursorAt > 0
          else if (takeDown(cursorAt - 1, 0)) hasMore = true
        } else if (cutInRun) {
          // Nothing numbered to continue from, so the app cannot ask for the rest: saying "more" would have it ask for
          // this same page for ever.
          ctx.log.warn('history page cut inside rows with no seq; the older ones cannot be paged', {
            thread: f.thread_id,
            sent: kept.length,
            of: n,
          })
          hasMore = false
        }
      }
    }
    ctx.transport.sendEphemeral(historyPageFrame(now, { ...head, messages: kept, has_more: hasMore }))
  },

  async onMediaFetch(this: Inbound, f: Of<'media.fetch'>) {
    // The app waits out a timeout of 20 s plus 2 s per MB for the upload. A Mac that cannot do it says so at once: the relay
    // sends an error{ref} for a media.fetch to the asker only (never into a thread), and the app moves to failed.
    const { ctx } = this
    const refuse = (code: 'bad_frame' | 'internal' | 'media_removed', message: string) =>
      ctx.transport.sendEphemeral(errorFrame(ctx.clock.now(), code, message, f.id))
    // removed under the owner's retention setting: said as that, not as an error
    const removed = ctx.media.removedInfo(f.media_id)
    if (removed)
      return refuse(
        'media_removed',
        `Removed from ${say({ mac: 'this Mac', linux: 'this computer' })} after ${removed.after_days} days.`,
      )
    try {
      if (!(await ctx.media.rehydrate(f.media_id))) {
        ctx.log.info('media.fetch: not on this Mac', { media_id: f.media_id })
        refuse(
          'bad_frame',
          say({ mac: 'That file is no longer on your Mac.', linux: 'That file is no longer on your computer.' }),
        )
      }
    } catch (e) {
      ctx.log.warn('media.fetch failed', { error: (e as Error).message })
      refuse(
        'internal',
        say({ mac: 'Your Mac could not send that file.', linux: 'Your computer could not send that file.' }),
      )
    }
  },
}

/**
 * A small stand-in for a stored message that cannot go in a history page (over the frame cap, or refused by the Message
 * schema). Same id, thread and time, so the context view still opens on it and says why; never the message itself.
 */
function tooLarge(m: MessageT): MessageT {
  return {
    id: m.id,
    thread_id: m.thread_id,
    author: m.author,
    kind: 'text',
    text: say({
      mac: 'This message is too large to show here. Open it on your Mac.',
      linux: 'This message is too large to show here. Open it on your computer.',
    }),
    format: 'plain',
    attachments: [],
    via: m.via ?? 'app',
    created_at: m.created_at,
    // The app sorts a row with no seq below every real one, so an old stand-in would sit under the newest message.
    ...(m.seq !== undefined ? { seq: m.seq } : {}),
  }
}

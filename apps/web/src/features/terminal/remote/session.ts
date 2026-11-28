// One view of the agent's terminal, read-only: opens it (one tap, one `term.open`), draws what the Mac sends, credits it, resumes by
// byte offset after a lag, keeps it alive while the page is looking, and ends it. It owns no screen: `TermSink` is where bytes
// go (xterm in the page, a fake in tests). There is no way here to send a key: nothing reads what the terminal would emit.
//
// The stream: `term.key{at}` is a picture exact for offset `at` (clear the screen, draw it, and the stream goes on from `at`);
// `term.out{at}` carries the bytes from offset `at`. A frame that is not the next one is never drawn out of order: bytes already
// drawn are skipped, and a gap asks the Mac to resume from the offset drawn. The credit `term.ack{upto}` goes after the bytes
// were drawn, a few frames at a time, and also every 30 s while the page is visible, which is how the Mac knows someone is looking.
import { newUlid, TERM_IDLE_S, TERM_MAX_S, type TermCloseWhy, termBytes } from '@talos-app/protocol'
import { type TalosClient, TalosClientError } from '../../../lib/client.ts'
import { endedWords, TERM_WORDS } from './words.ts'

export interface TermSink {
  /** Draws bytes (the page decodes them as UTF-8 in streaming mode); calls `done` once they are on screen. */
  write(bytes: Uint8Array, done: () => void): void
  /** Clears the screen and the scrollback (before a keyframe). */
  reset(): void
  /** The pane's size (it never changes because of this page: the Mac's own window changes it). */
  resize(cols: number, rows: number): void
}

export type TermView =
  | { phase: 'idle' }
  | { phase: 'opening'; target: string }
  | {
      phase: 'watching'
      target: string
      cols: number
      rows: number
      /** Seconds left of the longest a view stays open, as of `at` (page clock). */
      maxS: number
      openedAt: number
      lagging: boolean
    }
  | { phase: 'ended'; target: string; words: string | null }

export type TermSessionDeps = {
  client: TalosClient
  sink: TermSink
  onView(v: TermView): void
  now?: () => number
  /** The page is on screen (the heartbeat only goes while it is). */
  visible?: () => boolean
}

const ACK_EVERY_FRAMES = 4
const ACK_EVERY_BYTES = 32 * 1024
const ACK_SOON_MS = 100
export const HEARTBEAT_MS = 30_000

export class TermSession {
  private termId: string | null = null
  private view: TermView = { phase: 'idle' }
  private drawn = 0
  /** How far xterm has WRITTEN (its write callback ran): the credit names this, never what was only handed over. */
  private written = 0
  private unackedFrames = 0
  private unackedBytes = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private beat: ReturnType<typeof setInterval> | null = null
  private offs: Array<() => void> = []
  private gen = 0

  constructor(private d: TermSessionDeps) {}

  get id(): string | null {
    return this.termId
  }
  /** How far the stream has been drawn: where a resume asks from. */
  get offset(): number {
    return this.drawn
  }

  private set(v: TermView) {
    this.view = v
    this.d.onView(v)
  }
  private now() {
    return (this.d.now ?? Date.now)()
  }

  /** The owner tapped Watch. */
  async start(target: string): Promise<void> {
    if (this.view.phase === 'opening' || this.view.phase === 'watching') return
    const term = this.d.client.term
    const termId = `tm_${newUlid()}`
    const gen = ++this.gen
    this.teardown()
    this.termId = termId
    this.drawn = 0
    this.written = 0
    this.unackedFrames = this.unackedBytes = 0
    this.set({ phase: 'opening', target })
    if (!term) return this.fail(target, TERM_WORDS.needsUpdate)
    const on = this.d.client.onFrame.bind(this.d.client)
    this.offs = [
      on('term.opened', (f) => f.term_id === termId && this.onOpened(target, f)),
      on('term.key', (f) => f.term_id === termId && this.drawKeyframe(f)),
      on('term.out', (f) => f.term_id === termId && this.onOut(f)),
      on('term.closed', (f) => f.term_id === termId && this.onClosed(target, f.why)),
    ]
    try {
      await term.open({ termId, target, cols: 80, rows: 24 })
    } catch (e) {
      if (gen !== this.gen) return
      this.fail(target, openErrorWords(e))
    }
  }

  /** The owner pressed Close. */
  close(): void {
    const id = this.termId
    this.gen++
    this.teardown()
    if (id) void this.d.client.term?.close(id).catch(() => {})
    this.termId = null
    this.set({ phase: 'idle' })
  }

  /** The terminal cannot be drawn (it did not load, or what it was sent piled up): the view ends, the Mac is told, and the card says why. */
  abort(words: string): void {
    const target = this.view.phase === 'idle' ? 'main' : this.view.target
    const id = this.termId
    this.gen++
    this.teardown()
    if (id) void this.d.client.term?.close(id).catch(() => {})
    this.termId = null
    this.set({ phase: 'ended', target, words })
  }

  /** The page's connection went away: the relay closed the view with it, so this one is over. */
  connectionLost(): void {
    if (this.view.phase !== 'watching' && this.view.phase !== 'opening') return
    this.onClosed(this.view.target, 'socket_closed')
  }

  dispose(): void {
    this.gen++
    this.teardown()
    const id = this.termId
    if (id && (this.view.phase === 'watching' || this.view.phase === 'opening'))
      void this.d.client.term?.close(id).catch(() => {})
    this.termId = null
  }

  // ---- frames --------------------------------------------------------------------------------------------------------

  private onOpened(target: string, f: { cols: number; rows: number; max_s: number }) {
    if (this.view.phase === 'ended' || this.view.phase === 'idle') return
    const again = this.view.phase === 'watching'
    this.d.sink.resize(f.cols, f.rows)
    this.set({
      phase: 'watching',
      target,
      cols: f.cols,
      rows: f.rows,
      maxS: Math.min(f.max_s, TERM_MAX_S),
      openedAt: again ? (this.view as { openedAt: number }).openedAt : this.now(),
      lagging: false,
    })
    this.startBeat()
  }

  private drawKeyframe(f: { at: number; bytes_b64: string }) {
    if (this.view.phase !== 'watching') return
    this.d.sink.reset()
    this.drawn = f.at
    this.unackedFrames = this.unackedBytes = 0
    this.draw(termBytes(f.bytes_b64), f.at, true)
    this.markCaughtUp()
  }

  private onOut(f: { at: number; bytes_b64: string }) {
    if (this.view.phase !== 'watching') return
    let bytes = termBytes(f.bytes_b64)
    if (f.at > this.drawn) {
      // a gap: never drawn out of order. The Mac sends again from where this page is.
      void this.d.client.term?.resume(this.termId as string, this.drawn).catch(() => {})
      return
    }
    const skip = this.drawn - f.at
    if (skip >= bytes.length) return // all of it was drawn already
    if (skip > 0) bytes = bytes.subarray(skip)
    this.draw(bytes, this.drawn, false)
    this.markCaughtUp()
  }

  private draw(bytes: Uint8Array, from: number, isKey: boolean) {
    const upto = from + bytes.length
    const id = this.termId
    if (!isKey) this.drawn = upto
    this.d.sink.write(bytes, () => {
      if (id !== this.termId) return
      this.written = isKey ? from : Math.max(this.written, upto) // a picture is not stream bytes: it is exact for its offset
      this.unackedFrames++
      this.unackedBytes += bytes.length
      if (this.unackedFrames >= ACK_EVERY_FRAMES || this.unackedBytes >= ACK_EVERY_BYTES || isKey) this.sendAck()
      else this.ackTimer ??= setTimeout(() => this.sendAck(), ACK_SOON_MS)
    })
  }

  private sendAck() {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    const id = this.termId
    if (!id || (this.view.phase !== 'watching' && this.view.phase !== 'opening')) return
    this.unackedFrames = this.unackedBytes = 0
    this.d.client.term?.ack(id, this.written)
  }

  private markCaughtUp() {
    if (this.view.phase === 'watching' && this.view.lagging) this.set({ ...this.view, lagging: false })
  }

  private onClosed(target: string, why: TermCloseWhy | string) {
    if (this.view.phase === 'ended' || this.view.phase === 'idle') return
    if (why === 'lag' && this.view.phase === 'watching') {
      // the relay dropped output for this page, and the view is still open: ask again from the offset drawn
      this.set({ ...this.view, lagging: true })
      void this.d.client.term?.resume(this.termId as string, this.drawn).catch(() => {})
      return
    }
    this.teardown()
    this.termId = null
    this.set(why === 'closed' ? { phase: 'idle' } : { phase: 'ended', target, words: endedWords(why) })
  }

  private fail(target: string, words: string) {
    this.teardown()
    this.termId = null
    this.set({ phase: 'ended', target, words })
  }

  // ---- keeping it alive -----------------------------------------------------------------------------------------------

  private startBeat() {
    if (this.beat) return
    // The Mac closes a view after 10 minutes with no word from the page. While this page is on screen it says so now and then
    // (the credit again, with the offset already drawn): a quiet pane is not an idle viewer.
    this.beat = setInterval(() => {
      const id = this.termId
      if (id && (this.d.visible?.() ?? true)) this.d.client.term?.ack(id, this.written)
    }, HEARTBEAT_MS)
  }

  private teardown() {
    for (const o of this.offs) o()
    this.offs = []
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    if (this.beat) clearInterval(this.beat)
    this.beat = null
  }
}

/** Seconds of the view left, from what the Mac said and when it opened. */
export const secondsLeft = (v: Extract<TermView, { phase: 'watching' }>, now: number): number =>
  Math.max(0, Math.min(v.maxS, TERM_MAX_S) - Math.max(0, Math.floor((now - v.openedAt) / 1000)))

export const IDLE_MINUTES = TERM_IDLE_S / 60

function openErrorWords(e: unknown): string {
  if (e instanceof TalosClientError) {
    if (e.code === 'mac_offline') return TERM_WORDS.macAway
    if (e.code === 'rate_limited') return endedWords('too_many') as string
    if (e.code === 'device_not_pinned') return TERM_WORDS.unpinned
    if (e.code === 'stale') return endedWords('refused') as string
    return e.message
  }
  return TERM_WORDS.loadFailed
}

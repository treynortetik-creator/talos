// A thread session that read an owner message, has said nothing since, and whose pane is idle, for five minutes: the owner is told once,
// in the thread where he asked, with an "Open terminal" action (the words are quiet-words.ts). Plain checks on records the bridge
// already holds and on workers.json; nothing here reads the pane, the transcript or any text.
//   said nothing: the session read the message (an open claim, worker/store.ts) at least five minutes ago and has posted no message,
//                 card or hand-off answer in the thread since (`answeredIn`)
//   pane idle:    workers.json says the session is `live` (not busy, starting or parked), nothing waits on the owner (no `needs_you`, no
//                 `dialog`), Claude Code is not in its own wait at a usage limit (`limit_wait`), and the supervisor's idle clock
//                 (`last_active_at`: the screen above the input box last changed) is at least five minutes old. No idle clock: unknown,
//                 so nothing.
// Once per claimed message (kv `quiet_notice:<id>`, set before the post, so a restart or a slow send never repeats it). A session whose
// run already ended is the "stopped before it answered" notice's job (router.ts reportUnanswered), not this one's. Main has no entry in
// workers.json (no idle clock for the bridge to read), so only dedicated thread sessions are watched.
import { supervisorFresh, type WorkersFileT } from '@talos-app/protocol'
import type { WorkerStore } from '../worker/store.ts'
import { runEnded } from './reasons.ts'

/** How long a message must have gone unanswered, and how long the pane must have been idle. */
export const QUIET_MS = 5 * 60_000

export const quietKey = (messageId: string) => `quiet_notice:${messageId}`
/**
 * One notice per thread per quiet stretch of a session: the stretch is named by the idle clock's own time (it moves when the pane changes), and
 * the thread is where the owner asked, so a session's own thread and a sub-thread it serves each get their row.
 */
export const stretchKey = (where: string, session: string, lastActiveAt: string) =>
  `quiet_notice:${where}:${session}:${lastActiveAt}`

export type QuietDeps = {
  now: () => number
  store: () => WorkerStore
  seen: (key: string) => boolean
  mark: (key: string) => void
  /**
   * Posts the notice in `where` (the thread the owner asked in) with an action that opens `session`'s terminal. `lines` are the pane lines the
   * supervisor published for that session (shown in the app only, quiet-wiring.ts cleans them again); the notice's own words never hold them.
   * Never throws.
   */
  post: (where: string, session: string, lines?: readonly unknown[]) => Promise<void>
  warn?: (msg: string, f?: Record<string, unknown>) => void
}

export class QuietWatch {
  /** Keys already decided in this process (the kv is the record; this only saves lookups). */
  private done = new Set<string>()

  constructor(private readonly d: QuietDeps) {}

  /** A restart loses exactly this much: the memory above. The kv keys stay. */
  forget(): void {
    this.done.clear()
  }

  tick(file: WorkersFileT | null, dedicated: (thread: string) => boolean): void {
    const now = this.d.now()
    // an old or unreadable supervisor file proves nothing about a session
    if (!file || !supervisorFresh(file, now)) return
    const store = this.d.store()
    const toTell = new Map<
      string,
      { session: string; stretch: string; ids: string[]; lines: readonly unknown[] | undefined }
    >()
    for (const c of store.openClaims()) {
      if (c.kind !== 'text' && c.kind !== 'file' && c.kind !== 'voice_note') continue
      const key = quietKey(c.message_id)
      if (this.done.has(key) || this.d.seen(key)) {
        this.done.add(key)
        continue
      }
      if (now - c.at < QUIET_MS) continue
      // the owner's own words only (a card tap, a wake, a hand-off or outside text is not him waiting for an answer)
      const n = store.route(c.message_id)?.notification
      if (n?.meta.trust !== 'owner') continue
      if (!dedicated(c.thread_id)) continue
      const e = file.threads[c.thread_id]
      // a turn in progress is not "quiet": the repo's rule is state busy OR a turn start recorded (cut-turn-wiring.ts, update-check.ts), because
      // a pane whose screen has not changed for a while still reads `live` in the middle of a long step
      if (!e || e.state !== 'live' || e.turn_started_at || e.needs_you || e.dialog || e.limit_wait) continue
      const active = e.last_active_at ? Date.parse(e.last_active_at) : Number.NaN
      if (!Number.isFinite(active) || now - active < QUIET_MS) continue
      if (runEnded(e, c.at)) continue // it restarted since: reportUnanswered's notice
      if (store.answeredIn(c.thread_id, c.message_thread, c.at)) continue
      const slot = toTell.get(c.message_thread) ?? {
        session: c.thread_id,
        stretch: e.last_active_at ?? '',
        ids: [],
        lines: e.quiet_lines,
      }
      slot.ids.push(c.message_id)
      toTell.set(c.message_thread, slot)
    }
    for (const [where, { session, stretch, ids, lines }] of toTell) {
      for (const id of ids) {
        this.d.mark(quietKey(id)) // BEFORE the post
        this.done.add(quietKey(id))
      }
      // several messages read at different times in ONE quiet stretch of one session give one row
      const sk = stretchKey(where, session, stretch)
      if (this.d.seen(sk)) continue
      this.d.mark(sk)
      void this.d
        .post(where, session, lines)
        .catch((e) => this.d.warn?.('quiet notice not posted', { error: (e as Error).message }))
    }
  }
}

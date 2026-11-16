// Which session's lane an inbound frame belongs to. An owner message waits for its undo point before it is delivered
// (undo/service.ts), up to 5 s; it does that on its session's lane, off the serial inbound queue, so other sessions go
// on. Everything that acts on the same session must keep its place behind such a message: a stop sent after a message
// must stop that message's turn, not run first and let the message start a fresh one.
//
// - message, voice note: always on their session's lane.
// - session and thread-session controls, voice asks and call ends, card answers: on their session's lane while it has
//   work queued, inline on the serial queue as before when it has none. A session control, a voice ask and a call's end
//   act on main's session, so they also wait on main's lane.
// - frames that can touch any session (a config patch or a settings card's answer, a notification action whose thread
//   is only known after its check, an agent restart): wait until every lane is idle, then run inline. That holds the
//   serial queue while a lane finishes: up to the 5 s undo hold plus the delivery. A notification Reply, once checked,
//   goes on its session's lane like any message (inbound-cards.ts).
// - anything else (an integration event, a digest, a share, a problem report: frames for main's session): behind every
//   lane that has work queued (a thread's message may yet fall back to main; up to the 5 s hold), inline as before when
//   none has. A replay is told in the order it was sent.
import { leadThreadFor, UndoCardPayload } from '@talos-app/protocol'
import type { BridgeContext } from './context.ts'
import type { Item, Of } from './inbound-shared.ts'
import { sessionsInFolder } from './undo/busy.ts'

/** The main session's lane: every thread without a lead of its own. Not a thread id (those start with a letter). */
export const MAIN_LANE = '#main'

/** `anyBusy`: also wait on every lane that is busy when the frame arrives (its message may still go to main). */
export type LanePlan = { keys: string[]; always: boolean; anyBusy?: true } | 'barrier' | undefined

/** The lane of the session that answers `thread`: its lead's, or main's. */
export function sessionLane(ctx: BridgeContext, thread: string): string {
  return leadThreadFor(ctx.config.config, thread) ?? MAIN_LANE
}

export function lanePlan(ctx: BridgeContext, it: Item): LanePlan {
  const f = it.frame
  switch (f.type) {
    case 'message':
    case 'voice_note':
      return { keys: [sessionLane(ctx, f.thread_id)], always: true }
    case 'session.control': {
      // the app's session controls act on main's session whatever thread they were typed in
      const keys = [...new Set([MAIN_LANE, sessionLane(ctx, f.thread_id)])]
      return { keys, always: false }
    }
    case 'thread.session.control':
      return { keys: [sessionLane(ctx, f.thread_id)], always: false }
    case 'voice.ask':
    case 'voice.ended': {
      // a voice call is main's: its question and its end reach main's session, about that thread
      const keys = [...new Set([MAIN_LANE, sessionLane(ctx, f.thread_id)])]
      return { keys, always: false }
    }
    case 'undo.request':
      // reads the thread's folder to make the card: behind that session's queued turn, never ahead of it, and always on
      // the lane, so the git calls of a large folder never hold up the other threads' messages
      return { keys: [sessionLane(ctx, (f as Of<'undo.request'>).thread_id)], always: true }
    case 'card.resolve': {
      const row = ctx.ledger.get((f as Of<'card.resolve'>).card_id)
      // a settings card can change which session answers a thread: like a config patch, it waits for every lane
      if (row?.binding.kind === 'config') return 'barrier'
      // an undo card rewrites a folder: always on the lanes of every session that can write in it (main's when it is
      // main's folder, each thread worker's whose folder overlaps it), so their next messages wait for the restore
      if (row?.binding.kind === 'undo') {
        const p = UndoCardPayload.safeParse(row.binding.payload)
        const keys = new Set([sessionLane(ctx, row.thread_id)])
        if (p.success) {
          const s = sessionsInFolder(ctx, p.data.root, row.thread_id)
          if (s.main) keys.add(MAIN_LANE)
          for (const l of s.leads) keys.add(l)
        }
        return { keys: [...keys], always: true }
      }
      return row ? { keys: [sessionLane(ctx, row.thread_id)], always: false } : undefined
    }
    case 'config.patch':
    case 'native.act':
    case 'agent.recover':
      return 'barrier'
    default:
      // everything else that reaches a session reaches main's (an integration event, a digest, a share, a problem
      // report): it keeps its place behind every message still waiting, since a thread worker's message can still be
      // handed to main, and runs inline as before when none is
      return { keys: [MAIN_LANE], always: false, anyBusy: true }
  }
}

/** A backlog answers every thread it carries in main's session, so it waits for each of their lanes. */
export function backlogLanes(ctx: BridgeContext, items: Item[]): string[] {
  const keys = new Set([MAIN_LANE])
  for (const it of items) keys.add(sessionLane(ctx, (it.frame as Of<'message'>).thread_id))
  return [...keys]
}

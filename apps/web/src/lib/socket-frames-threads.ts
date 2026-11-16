// Thread list, agent status, presence, read marks and the agent config the Mac pushes.
// Handlers of the frame switch in socketClient.ts, which dispatches to them. Each reads the closure through ctx.
import { type FrameOf, hostOf, ownValue, type ThreadT } from '@talos-app/protocol'
import { rememberHost } from './hostWords.ts'
import type { FrameContext } from './socket-frames-context.ts'

export function onStatus(ctx: FrameContext, frame: FrameOf<'status'>): void {
  const { set } = ctx
  set((s) => ({
    statuses: {
      ...s.statuses,
      [frame.thread_id]: {
        thread_id: frame.thread_id,
        state: frame.state,
        ...(frame.label ? { label: frame.label } : {}),
        since: frame.since,
      },
    },
  }))
  return
}

export function onPresence(ctx: FrameContext, frame: FrameOf<'presence'>): void {
  const { set } = ctx
  rememberHost(hostOf(frame.features)) // the words before sign-in and while offline (lib/hostWords.ts)
  set(() => ({
    // the bridge's features ride every presence (S1.5): dropping them here hid Schedules behind "Update Talos"
    presence: {
      bridge_online: frame.bridge_online,
      last_seen: frame.last_seen,
      queue_depth: frame.queue_depth,
      ...(frame.features ? { features: frame.features } : {}),
      ...(frame.features_at ? { features_at: frame.features_at } : {}),
      ...(frame.superseded ? { superseded: true } : {}),
      ...(frame.main ? { main: frame.main } : {}), // Main's state on the agent's computer: the sign-in banner
    },
  }))
  return
}

export function onThreadUpsert(ctx: FrameContext, frame: FrameOf<'thread.upsert'>): void {
  const { set, bumpSeq } = ctx
  const t = frame.thread
  set((s) => {
    const i = s.threads.findIndex((x) => x.id === t.id)
    const threads: ThreadT[] = s.threads.slice()
    if (i >= 0) threads[i] = t
    else threads.push(t)
    threads.sort((a, b) => a.order - b.order)
    return { threads }
  })
  bumpSeq(frame)
  return
}

export function onThreadArchive(ctx: FrameContext, frame: FrameOf<'thread.archive'>): void {
  const { set, bumpSeq } = ctx
  set((s) => ({ threads: s.threads.map((t) => (t.id === frame.thread_id ? { ...t, archived: true } : t)) }))
  bumpSeq(frame)
  return
}

export function onThreadRead(ctx: FrameContext, frame: FrameOf<'thread.read'>): void {
  const { set } = ctx
  // Another device read this thread up to `up_to_seq`. The relay counts the rows above its mark, so a row this device
  // got after that point is still unread: only what is at or below the mark comes off. The count never goes up here (a
  // row counted by `ready.unread` and never seen by seq is taken as read), and the mark only rises, as on the relay.
  const above = ctx.forgetUnreadSeqs(frame.thread_id, frame.up_to_seq)
  set((s) => ({
    unread: { ...s.unread, [frame.thread_id]: Math.min(ownValue(s.unread, frame.thread_id) ?? 0, above) },
    ...(s.readUpto
      ? {
          readUpto: {
            ...s.readUpto,
            [frame.thread_id]: Math.max(ownValue(s.readUpto, frame.thread_id) ?? 0, frame.up_to_seq),
          },
        }
      : {}),
  }))
  return
}

export function onThreadUnread(ctx: FrameContext, frame: FrameOf<'thread.unread'>): void {
  const { set } = ctx
  // The relay's answer to a mark-unread from any device (ours included): the count it holds and the read mark it
  // lowered to. With no mark (no counting row left in its buffer) the old one stands.
  set((s) => ({
    unread: { ...s.unread, [frame.thread_id]: Math.max(1, frame.count ?? 1) },
    ...(s.readUpto && frame.up_to_seq !== undefined
      ? { readUpto: { ...s.readUpto, [frame.thread_id]: frame.up_to_seq } }
      : {}),
  }))
  return
}

export function onConfigSync(ctx: FrameContext, frame: FrameOf<'config.sync'>): void {
  const { set, bumpSeq, settleConfig, configWaiters } = ctx
  set(() => ({ config: frame.config, threads: frame.config.threads }))
  bumpSeq(frame)
  if (frame.applied) settleConfig(frame.applied)
  // a bridge from before `applied`: any newer config is taken as ours (the old behaviour)
  else for (const [id, w] of configWaiters) if (frame.rev > w.baseRev) settleConfig(id)
  return
}

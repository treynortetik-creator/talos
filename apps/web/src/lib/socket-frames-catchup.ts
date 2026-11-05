// What happens after a connection: `ready`, catch-up batches (the lastSeq logic), the reset, and history pages.
// Handlers of the frame switch in socketClient.ts, which dispatches to them. Each reads the closure through ctx.
import { type FrameOf, parseFrame } from '@talos-app/protocol'
import type { FrameContext } from './socket-frames-context.ts'
import { unknownOfFrame } from './unknownFrames.ts'

export function onReady(ctx: FrameContext, frame: FrameOf<'ready'>): void {
  const { store, set, now, lostIds, patchMessage } = ctx
  const s = store.getState()
  const open = frame.open_cards ?? []
  const openIds = new Set(open.map((c) => c.id))
  // A cached card still pending here but not open now was decided or expired while this device was away. It is kept,
  // not dropped: the catch-up `card.update` that follows only changes a card that is held (the create is at or below
  // `last_seq` and is not replayed), so dropping it left the card missing from the timeline for good. It is shown as
  // expired only once its own time has passed. Absence from `open_cards` alone does not mean expired: the relay moves
  // a card to resolved when it stores a decision (this device's or another's) and sends no `card.update` then, so
  // the card stays as it was until the Mac's update lands, and a second tap gets `card_not_pending` from the relay.
  const cards = [
    ...s.cards.map((c) =>
      c.state === 'pending' && !openIds.has(c.id) && Date.parse(c.expires_at) <= now()
        ? { ...c, state: 'expired' as const }
        : c,
    ),
    ...open.filter((c) => !s.cards.some((x) => x.id === c.id)),
  ].map((c) => open.find((o) => o.id === c.id) ?? c)
  set((st) => ({
    presence: frame.presence,
    relayFeatures: frame.features ?? [],
    readySeq: (st.readySeq ?? 0) + 1,
    ...(frame.agent_config ? { config: frame.agent_config } : {}),
    ...(frame.threads ? { threads: frame.threads } : frame.agent_config ? { threads: frame.agent_config.threads } : {}),
    ...(frame.unread ? { unread: frame.unread } : {}),
    ...(frame.read_upto ? { readUpto: frame.read_upto } : {}),
    ...(frame.statuses ? { statuses: Object.fromEntries(frame.statuses.map((x) => [x.thread_id, x])) } : {}),
    cards,
    lastSeq: Math.max(st.lastSeq, 0),
    serverSeq: frame.server_seq,
  }))
  // Messages the relay gave up on while this device was away (D38). Remembered by id too, because the row itself may
  // only arrive later in a catch-up and must not come back as "Sent".
  for (const id of frame.not_delivered ?? []) {
    lostIds.add(id)
    patchMessage(id, (m) => ({ ...m, receipt: 'not_delivered' as const }))
  }
  return
}

export function onCatchupBatch(ctx: FrameContext, frame: FrameOf<'catchup.batch'>): void {
  const { set, dispatch, send, isRecord, applyStoredOwnerFrame, noteUnknown } = ctx
  for (const raw of frame.frames) {
    const p = parseFrame(raw, { direction: 'relay_to_app' })
    if (p.ok) dispatch(p.frame, true)
    else if (isRecord(raw) && (raw.type === 'message' || raw.type === 'voice_note')) applyStoredOwnerFrame(raw)
    else noteUnknown(unknownOfFrame(raw))
  }
  set((s) => ({ lastSeq: Math.max(s.lastSeq, frame.to_seq) }))
  if (frame.more) send({ type: 'catchup.request', since_seq: frame.to_seq })
  return
}

export function onCatchupReset(ctx: FrameContext, frame: FrameOf<'catchup.reset'>): void {
  const { set } = ctx
  ctx.bumpResetGen() // a history page asked for before this was cut from a window that no longer exists
  set((s) => ({
    messages: Object.fromEntries(
      Object.entries(s.messages).map(([t, list]) => [
        t,
        // A row the relay gave up on (D38) is the only copy of the owner's text once the buffer dropped it: it stays.
        list.filter((m) => m.seq === undefined || m.seq >= frame.min_seq || m.receipt === 'not_delivered'),
      ]),
    ),
    lastSeq: Math.max(s.lastSeq, frame.min_seq - 1),
  }))
  return
}

export function onCatchupSummary(ctx: FrameContext, frame: FrameOf<'catchup.summary'>): void {
  const { set } = ctx
  set(() => ({
    catchup: {
      since_seq: frame.since_seq,
      threads: frame.threads,
      open_cards: frame.open_cards,
      ...(frame.overnight ? { overnight: frame.overnight } : {}),
    },
  }))
  return
}

export function onHistoryPage(ctx: FrameContext, frame: FrameOf<'history.page'>): void {
  const { store, set, upsertMessage, historyGen, historyAsked, contextRequests, latestRequests, historyWaiters } = ctx
  const resetGen = ctx.getResetGen()
  const gen = historyGen.get(frame.request_id)
  historyGen.delete(frame.request_id)
  // Only a page this client asked for, for the thread it asked about. The page itself is not signed (the request is),
  // so the relay could push a page nobody requested: it is dropped here, and rows from another thread are never merged.
  const asked = historyAsked.get(frame.request_id)
  if (asked === undefined || asked !== frame.thread_id) return
  // Dropped, not merged: beside rows from after the wipe it would leave a hole nobody asks for again.
  const stale = gen !== undefined && gen !== resetGen
  if (!contextRequests.has(frame.request_id) && !stale) {
    for (const m of frame.messages) if (m.thread_id === asked) upsertMessage(m)
    // A page with no `before_seq` is the thread's newest. On a device that has never caught up (`lastSeq` 0) the
    // relay sends no catch-up on the next hello, so what this page holds is where the device now stands.
    if (latestRequests.delete(frame.request_id)) {
      const top = frame.messages.reduce((n, m) => Math.max(n, m.seq ?? 0), 0)
      if (top > store.getState().lastSeq) set(() => ({ lastSeq: top }))
    }
  }
  historyWaiters.get(frame.request_id)?.(frame)
  return
}

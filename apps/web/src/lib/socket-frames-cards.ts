// Cards, MCP app views and the inbox: creation, updates, and the unread count a new inbox item adds.
// Handlers of the frame switch in socketClient.ts, which dispatches to them. Each reads the closure through ctx.
import type { FrameOf, InboxItemT } from '@talos-app/protocol'
import type { FrameContext } from './socket-frames-context.ts'

export function onCardCreate(ctx: FrameContext, frame: FrameOf<'card.create'>): void {
  const { upsertCard, bumpSeq } = ctx
  upsertCard(frame.card)
  bumpSeq(frame)
  return
}

export function onCardUpdate(ctx: FrameContext, frame: FrameOf<'card.update'>): void {
  const { set, bumpSeq } = ctx
  set((s) => ({
    cards: s.cards.map((c) => {
      if (c.id !== frame.card_id) return c
      // The explanation of a permission card is unsigned, so it is taken once: only from "pending" to "ready" or "failed", the
      // first answer wins, and nothing sets it on a card that never had one. Its update repeats the card's state; that must
      // not move the card (one the owner already answered stays answered).
      const explain =
        frame.explain && frame.explain.status !== 'pending' && c.explain?.status === 'pending'
          ? { explain: frame.explain }
          : {}
      if (frame.explain && !frame.resolution && !frame.result) return { ...c, ...explain }
      return {
        ...c,
        state: frame.state,
        ...(frame.resolution ? { resolution: frame.resolution } : {}),
        ...(frame.result ? { result: frame.result } : {}),
        ...explain,
      }
    }),
  }))
  bumpSeq(frame)
  return
}

export function onAppUpdate(ctx: FrameContext, frame: FrameOf<'app.update'>): void {
  const { set, bumpSeq } = ctx
  set((s) => ({
    appStates: {
      ...s.appStates,
      [frame.view_id]: { state: frame.state, ...(frame.reason ? { reason: frame.reason } : {}) },
    },
  }))
  bumpSeq(frame)
  return
}

export function onInboxItem(ctx: FrameContext, frame: FrameOf<'inbox.item'>, isCatchup: boolean): void {
  const { store, set, bumpSeq, bumpUnread } = ctx
  const known = store.getState().inbox.some((i) => i.id === frame.item.id)
  set((s) => ({ inbox: [frame.item, ...s.inbox.filter((i) => i.id !== frame.item.id)] }))
  bumpSeq(frame)
  // The relay counts a new inbox item as unread in its thread; so does the phone, live, or the app icon would jump
  // between the relay's number (in each push) and this one.
  if (!isCatchup && !known) bumpUnread(frame.item.thread)
  return
}

export function onInboxUpdate(ctx: FrameContext, frame: FrameOf<'inbox.update'>): void {
  const { set, bumpSeq } = ctx
  set((s) => ({
    inbox: s.inbox.map(
      (i): InboxItemT =>
        i.id === frame.event_id
          ? {
              ...i,
              ...(frame.state ? { state: frame.state } : {}),
              ...(frame.snooze_until ? { snooze_until: frame.snooze_until } : {}),
              ...(frame.priority ? { priority: frame.priority } : {}),
              ...(frame.agent_summary ? { agent_summary: frame.agent_summary } : {}),
              ...(frame.card_id ? { card_id: frame.card_id } : {}),
            }
          : i,
    ),
  }))
  bumpSeq(frame)
  return
}

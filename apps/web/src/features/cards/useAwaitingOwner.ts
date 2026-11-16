import type { CardT } from '@talos-app/protocol'
import { useMemo } from 'react'
import { useTalos } from '../../lib/client.ts'
import { awaitsOwner } from './logic.ts'
import { useRelayNow } from './util.ts'

/**
 * Cards that need the owner right now, on the same 30 s clock Home uses, so the badge, sidebar, tab title,
 * thread pill and Home agree even as cards expire. On the relay's clock, which is the one a card's expiry is written
 * in. Optionally limited to one thread.
 */
export function useAwaitingOwner(threadId?: string): readonly CardT[] {
  const cards = useTalos((s) => s.cards)
  const now = useRelayNow(30_000)
  return useMemo(
    () => cards.filter((c) => (threadId === undefined || c.thread_id === threadId) && awaitsOwner(c, now)),
    [cards, threadId, now],
  )
}

// "<Thread> needs you": said to a screen reader when a card arrives for a thread other than the one on screen, wherever the owner
// is (Home, Settings, another thread). Called once, from the shell. A card replayed on reconnect (catch-up) is not news, and a
// burst of cards (several at once) is one sentence with a count.
import { useEffect, useRef } from 'react'
import { announce } from '../../lib/announce.ts'
import { needsYou, SOURCE, threadsNeedYou } from '../../lib/announceText.ts'
import { useTalosClient } from '../../lib/client.ts'

/** Cards that arrive within this long of each other are one burst. */
export const NEEDS_YOU_BURST_MS = 300

/** `viewing` is the thread on screen (null on Home and the other screens). */
export function useAnnounceNeedsYou(viewing: string | null): void {
  const client = useTalosClient()
  const onScreen = useRef(viewing)
  onScreen.current = viewing
  useEffect(() => {
    let burst = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = client.onFrame('card.create', (f, meta) => {
      if (meta?.catchup) return
      const { card } = f
      if (card.state !== 'pending' || card.thread_id === onScreen.current) return
      burst.add(card.thread_id)
      const name = client.store.getState().threads.find((t) => t.id === card.thread_id)?.name ?? 'A thread'
      announce(burst.size === 1 ? needsYou(name) : threadsNeedYou(burst.size), SOURCE.needsYou)
      clearTimeout(timer)
      timer = setTimeout(() => {
        burst = new Set()
      }, NEEDS_YOU_BURST_MS)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [client])
}

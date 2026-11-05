// Shared clocks for the agents panel (docs/SUBAGENTS.md 6.2), paused while the tab is hidden. One 1 s clock drives every
// elapsed counter while a live row is on screen; with nothing live, a 30 s clock only keeps "3m ago" and the 10 min
// expiry honest, so the list does not re-render every second for nothing.
import { useSyncExternalStore } from 'react'

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

function makeClock(periodMs: number) {
  const subs = new Set<() => void>()
  let now = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = () => {
    now = Date.now()
    for (const s of subs) s()
  }
  const arm = () => {
    if (timer || hidden() || subs.size === 0) return
    now = Date.now() // fresh on (re)subscribe without forcing a commit
    timer = setInterval(tick, periodMs)
  }
  const disarm = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }
  const onVisibility = () => {
    if (hidden()) disarm()
    else {
      arm()
      tick()
    }
  }
  return {
    subscribe(cb: () => void) {
      subs.add(cb)
      if (subs.size === 1 && typeof document !== 'undefined')
        document.addEventListener('visibilitychange', onVisibility)
      arm()
      return () => {
        subs.delete(cb)
        if (subs.size === 0) {
          disarm()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }
    },
    get: () => now,
  }
}

const fast = makeClock(1000)
const slow = makeClock(30_000)

/** Milliseconds since the epoch: once a second while `live` (something on screen is counting), else every 30 s. */
export function useNowTick(live = true): number {
  const c = live ? fast : slow
  return useSyncExternalStore(c.subscribe, c.get)
}

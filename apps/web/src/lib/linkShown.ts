// What the screen says about the link, not what the link is (owner, 2026-11-15: "it flashes on and off pretty regularly…
// it only flashes if it hasn't been connected for … 30 seconds or longer"). A drop shorter than LINK_DOWN_GRACE_MS shows
// nothing at all; a longer one shows once it has lasted that long. Only the words and dots wait: sending, queueing and every
// decision still read the real state (a message sent during a short drop goes into the outbox and out on reconnect).
// When a drop began is kept here, shared by every screen, so a screen opened halfway through an outage does not start over.
import { useEffect, useState } from 'react'
import type { ConnectionState } from './client.ts'
import { useTalos } from './client.ts'

/** How long the link (or the Mac) must be down, without a break, before anything on screen says so. One place to change. */
export const LINK_DOWN_GRACE_MS = 30_000

// Unit tests and the fake demo build (which the browser specs drive) say a drop at once, as before, so their offline and
// Mac-away cases need no wait; a test of the wait itself turns it on (setLinkGraceForTests).
// A browser spec against a real-socket build sets window.__talosLinkGraceMs before the page loads (addInitScript); nothing
// in the app sets it.
// a spec run in Node imports this file too (through features/settings/offline.ts): no Vite env there
const viteEnv: Record<string, string | undefined> = (import.meta as { env?: Record<string, string> }).env ?? {}
const override = (globalThis as { __talosLinkGraceMs?: unknown }).__talosLinkGraceMs
let grace =
  typeof override === 'number'
    ? override
    : viteEnv.MODE === 'test' || viteEnv.VITE_FAKE === '1'
      ? 0
      : LINK_DOWN_GRACE_MS
/** Tests: how long a drop is held back (LINK_DOWN_GRACE_MS in the real app). */
export function setLinkGraceForTests(ms: number): void {
  grace = ms
}

const downSince: Record<'link' | 'mac', number | null> = { link: null, mac: null }

/** True while `up`, and for LINK_DOWN_GRACE_MS after it went down (re-rendered when that time is up). */
function useHeldUp(kind: 'link' | 'mac', up: boolean): boolean {
  if (up) downSince[kind] = null
  else downSince[kind] ??= Date.now()
  const since = downSince[kind]
  const [, tick] = useState(0)
  useEffect(() => {
    if (since === null) return
    const left = since + grace - Date.now()
    if (left <= 0) return
    const t = setTimeout(() => tick((n) => n + 1), left + 50)
    return () => clearTimeout(t)
  }, [since])
  return since === null || Date.now() - since < grace
}

/** The relay link as the screen shows it: 'online' until it has been down for LINK_DOWN_GRACE_MS. */
export function useShownConnection(): ConnectionState {
  const real = useTalos((s) => s.connection)
  return useHeldUp('link', real === 'online') ? 'online' : real
}

/** Whether the screen calls the Mac online: yes until it has been away for LINK_DOWN_GRACE_MS. */
export function useShownMacOnline(): boolean {
  const real = useTalos((s) => s.presence.bridge_online)
  return useHeldUp('mac', real)
}

/** Tests: forget when the last drops began. */
export function resetLinkShownForTests(): void {
  downSince.link = null
  downSince.mac = null
}

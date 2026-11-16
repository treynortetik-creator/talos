// Every sentence that names the owner's computer says it in that computer's words (Pantheon's no-Mac-words pass, 2026-11-14):
// the Mac's own sentence byte for byte on a Mac; "your computer" / "this computer" on a Linux computer, with its commands; on the
// Windows PC (no terminal) the Talos icon by the clock and its tray items, or "can't … on a Windows PC yet" where there is no way
// (Titan's words). Read when the sentence is said, never at import, so the host (platform.ts) is the one in force.
import { hostname } from 'node:os'
import type { Host } from '@talos-app/protocol'
import { ownerHost } from './platform.ts'

/** One sentence per computer; a Windows one left out says the Linux one (no command in it, so it fits both). */
export type HostWords = { mac: string; linux: string; windows?: string }

/**
 * The Windows PC is "your PC" / "this PC" in every sentence, as the web app says it (Pantheon), so the phone never mixes the two:
 * a Windows sentence, or the Linux one it falls back to, has its "computer" read as "PC".
 */
export const pcWords = (t: string): string => t.replace(/\b([Yy]our|[Tt]his|the owner's) computer\b/g, '$1 PC')

/** The sentence for this computer (or `host`, a test's). */
export function say(w: HostWords, host: Host = ownerHost()): string {
  return host === 'mac' ? w.mac : host === 'windows' ? pcWords(w.windows ?? w.linux) : w.linux
}

/**
 * This computer's name as a sentence may show it: one line of printable characters, at most 40, or "this computer" when nothing
 * is left (Fable's follow-up: one cleaner for every place that names the machine).
 */
export function machineName(raw: string = hostname()): string {
  const kept = raw.replace(/[\p{Cc}\p{Cf}\p{Z}]+/gu, ' ').trim()
  if (kept === '') return 'this computer'
  const cp = [...kept]
  return cp.length > 40 ? `${cp.slice(0, 39).join('')}…` : kept
}

/** The Windows PC's tray, as its owner finds it (Titan): the Talos icon by the clock, maybe behind the ^ arrow. */
export const TRAY = 'click the Talos icon by the clock'

/**
 * Where a Linux owner attaches to a thread's session, the Windows PC's owner opens it from the tray: Titan's "Open a thread's
 * session..." (three ASCII dots, as the tray writes it), which lists the threads by name and opens a window onto the one picked.
 * It follows the line's own first sentence (what the session is showing). One constant, pinned byte for byte.
 */
export const WINDOWS_OPEN_SESSION =
  "On the PC, click the Talos icon by the clock, choose Open a thread's session..., and pick this thread."

/** Sign in to Claude on the Windows PC (the tray has it). */
export const WINDOWS_SIGN_IN = `On the PC, ${TRAY} and choose Sign in to Claude…`

/**
 * The fix for an app that needs scanning (or signing in) again, as a whole sentence: the owner runs `talos-app apps <what>` on
 * the computer; on the Windows PC apps can't be set up yet (Titan, gap 5).
 */
export const appsFix = (what = 'scan', tail = '.'): string =>
  say({
    mac: `Run talos-app apps ${what} on the Mac${tail}`,
    linux: `Run talos-app apps ${what} on this computer${tail}`,
    windows: "MCP apps can't be set up on a Windows PC yet.",
  })

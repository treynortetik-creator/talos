// Voice/audio playback speed: the allowed steps and a per-device preference. A convenience only, so storage failures
// are ignored (private window, blocked storage).

export const SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const
export type Speed = (typeof SPEEDS)[number]

const KEY = 'talos.audio.speed'

export const nextSpeed = (s: Speed): Speed => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] ?? 1

/** "1x", "1.25x": the same text goes in the aria-label (and, with a multiplication sign, on the button). */
export const formatSpeed = (s: Speed): string => `${s}x`

export function loadSpeed(): Speed {
  try {
    const n = Number(localStorage.getItem(KEY))
    return SPEEDS.find((s) => s === n) ?? 1
  } catch {
    return 1
  }
}

export function saveSpeed(s: Speed): void {
  try {
    localStorage.setItem(KEY, String(s))
  } catch {
    /* private window or blocked storage */
  }
}

// Per-device driving preferences. Conveniences only, so storage failures are ignored (private window, blocked storage).
const FALLBACK = 'talos.drive.phone_voice'
const TAP = 'talos.drive.tap_to_talk'
const THREAD = 'talos.drive.thread'

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* ignore */
  }
}

/** "Use the phone's voice as a fallback": on unless switched off. */
export const loadPhoneVoiceFallback = (): boolean => read(FALLBACK) !== '0'
export const savePhoneVoiceFallback = (on: boolean): void => write(FALLBACK, on ? '1' : '0')
/** Tap once to start talking and again to send, instead of holding. */
export const loadTapToTalk = (): boolean => read(TAP) === '1'
export const saveTapToTalk = (on: boolean): void => write(TAP, on ? '1' : '0')
export const loadDriveThread = (): string | null => read(THREAD)
export const saveDriveThread = (id: string): void => write(THREAD, id)

// ---- driving continuity (survives the PWA being killed) -------------------------------------------------------------
const HEARD = 'talos.drive.heard'
const TOUCH = 'talos.drive.touch'
export type Heard = { seq: number; until: number }
/** The last reply seq that was handled while driving was on, valid until `until` (the driving window it belongs to). */
export function loadHeard(): Heard | null {
  try {
    const v = JSON.parse(read(HEARD) ?? 'null') as Heard | null
    return v && Number.isFinite(v.seq) && Number.isFinite(v.until) ? v : null
  } catch {
    return null
  }
}
export const saveHeard = (h: Heard | null): void => {
  try {
    if (h) localStorage.setItem(HEARD, JSON.stringify(h))
    else localStorage.removeItem(HEARD)
  } catch {
    /* ignore */
  }
}
/** The last time the owner talked or tapped on /drive (ms). */
export const loadTouch = (): number | null => {
  const n = Number(read(TOUCH))
  return Number.isFinite(n) && n > 0 ? n : null
}
export const saveTouch = (t: number): void => write(TOUCH, String(t))
/** The driving window (`driving_until`, ms) this device claimed as the one driving; it reads replies aloud. */
const LOCAL = 'talos.drive.local'
export const loadLocal = (): number | null => {
  const n = Number(read(LOCAL))
  return Number.isFinite(n) && n > 0 ? n : null
}
export const saveLocal = (until: number | null): void => {
  try {
    if (until) localStorage.setItem(LOCAL, String(until))
    else localStorage.removeItem(LOCAL)
  } catch {
    /* ignore */
  }
}

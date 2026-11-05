// Per-device voice preference: hands-free or hold-to-talk. A convenience only, so storage failures are ignored.

export type TalkMode = 'hands_free' | 'hold'

const KEY = 'talos.voice.mode'

export function loadTalkMode(): TalkMode {
  try {
    return localStorage.getItem(KEY) === 'hold' ? 'hold' : 'hands_free'
  } catch {
    return 'hands_free'
  }
}

export function saveTalkMode(mode: TalkMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* private window or blocked storage */
  }
}

// Main's first-start state as the phone hears it: the Linux supervisor's `$TALOS_APP_HOME/run/main-state` (the Windows tray
// reads the same file; apps/bridge/src/supervisor/main-state.ts writes it), reduced by the bridge to one of five words and
// sent in its health beat. Only the word leaves the machine: never the screen text behind a `waiting:unknown`.
// A Mac writes no such file, so a Mac bridge sends none. No feature string: the field is optional on both frames, an older
// relay drops it and an older page ignores it, and both parse it with .catch so a word added later never breaks either.
import { z } from 'zod'

export const MAIN_STATES = ['signin', 'waiting', 'starting', 'running', 'stopped'] as const
export const MainState = z.enum(MAIN_STATES)
export type MainStateT = z.infer<typeof MainState>

/**
 * The file's first line, `main=<state>`, as one word: `waiting:<any kind>` is waiting (kinds may be added), the four
 * others are themselves. Anything else, or no text, is undefined: the bridge does not know, and says nothing.
 */
export function mainStateOf(text: string | null | undefined): MainStateT | undefined {
  const line = (text ?? '').split('\n', 1)[0]?.trim() ?? ''
  if (/^main=waiting:[a-z_]{1,40}$/.test(line)) return 'waiting'
  const m = /^main=(signin|starting|running|stopped)$/.exec(line)
  return m ? (m[1] as MainStateT) : undefined
}

// Choose… in the Mac app: the page asks the Mac for its own open panel (`pick_folder`) and waits for `folder_picked`. The
// panel is the Mac's; the page only says where to begin. A path that comes back is saved through the same checked thread patch
// as a typed one, so the Mac (bridge) still decides whether it may be used. An answer to a request nobody made is ignored.
import { newUlid, SHELL_FEATURE_PICK_FOLDER } from '@talos-app/protocol'
import { getShell } from './shell.ts'

/** How long a request may wait for the Mac before it is given up on and its slot freed. The panel is the owner's to take their time with. */
export const PICK_WAIT_MS = 10 * 60_000

/** What the Mac said: the folder, or none; `why` is set when it was not the owner cancelling. */
export type PickResult = { path: string | null; why?: 'not_now' | 'bad_name' }

const waiting = new Map<string, (r: PickResult) => void>()

/** Requests still waiting for an answer (tests). */
export const pendingPickCount = (): number => waiting.size

/** True inside a Mac app that can show its open panel (an older Mac app does not list `pick-folder`, and gets the in-app browser). */
export function canPickNative(): boolean {
  return getShell()?.features?.includes(SHELL_FEATURE_PICK_FOLDER) === true
}

/** Shows the Mac's open panel. Resolves with the folder chosen, or no path when the owner cancelled, the shell cannot be asked, or nobody answered. */
export function pickFolderNative(start?: string): Promise<PickResult> {
  const shell = getShell()
  if (!shell) return Promise.resolve({ path: null })
  // a request id is 1 to 32 letters, digits, - and _ (a ULID's 26 characters fit)
  const req = newUlid()
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ path: null }), PICK_WAIT_MS)
    const finish = (r: PickResult) => {
      clearTimeout(timer)
      if (waiting.delete(req)) resolve(r)
    }
    waiting.set(req, finish)
    if (!shell.bridge.send({ type: 'pick_folder', req, ...(start ? { start } : {}) })) finish({ path: null })
  })
}

/** The shell's `folder_picked`. */
export function folderPicked(req: string, path: string | null, why?: 'not_now' | 'bad_name'): void {
  waiting.get(req)?.({ path, ...(why ? { why } : {}) })
}

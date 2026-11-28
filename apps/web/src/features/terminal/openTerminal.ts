// Where a message's "Open terminal" action (protocol MessageAction) goes. THE ONE PLACE to change when the remote terminal viewer lands:
// make `canOpenTerminal` true on the phone and in a browser, and send them to the viewer in `openTerminal`. Until then the terminal is
// the Mac app's native screen only (docs/desktop.md "The Terminal screen"): there is no such screen in a browser or on the phone, so
// the message shows its text and no button there.
import type { NavigateFunction } from 'react-router'
import { getShell } from '../../lib/native/shell.ts'
import { useTerminalSessions } from './sessions.ts'

/** Can this client show a thread's terminal? Today: the Mac app. */
export const canOpenTerminal = (): boolean => getShell() !== null

/** Opens the Terminal screen on `thread`'s tab (picked as soon as the tab list has it). */
export function openTerminal(thread: string, navigate: NavigateFunction): void {
  useTerminalSessions.getState().want(thread)
  navigate('/terminal')
}

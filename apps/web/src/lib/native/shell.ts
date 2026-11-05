// Detects the Mac app shell, swaps the platform adapter, and exposes the one door the shell uses to talk to the page.
// The iPhone shell is detected and adapted elsewhere (lib/native.ts, lib/capacitorPlatform.ts); `inShell()` is the one
// question both answer, and the one the sign-in path asks.

import { isNativeShell } from '../native.ts'
import { type Platform, setPlatform } from '../platform.ts'
import { createDesktopPlatform } from './adapters.ts'
import { createShellBridge, type ShellBridge } from './bridge.ts'
import { detectShell } from './detect.ts'

export type Shell = { kind: 'desktop'; bridge: ShellBridge; platform: Platform }

type PostTarget = { postMessage(message: unknown): unknown }

let installed: Shell | null = null
/** The Mac app shell this page runs in, or null (a browser, or the iPhone shell). */
export const getShell = (): Shell | null => installed

/** True in either native shell (Mac app or iPhone app): they cannot do passkeys and sign in with the setup code. */
export const inShell = (scope: unknown = globalThis): boolean => installed !== null || isNativeShell(scope)

/** Returns null unless this is the Mac app. Call before anything reads `getPlatform()`. */
export function installShell(scope: unknown = globalThis): Shell | null {
  if (detectShell(scope) !== 'desktop') return null
  const s = scope as Record<string, unknown>
  const handler = (s.webkit as { messageHandlers?: { talos?: PostTarget } } | undefined)?.messageHandlers?.talos
  const bridge = createShellBridge({
    post(message) {
      if (handler) handler.postMessage(message)
    },
  })
  const platform = createDesktopPlatform(bridge)
  setPlatform(platform)
  // The shell calls window.talosNative.receive(json) or receiveAck(json). They exist in the top frame of a detected shell
  // only, so an agent-written page in an iframe never sees it.
  //  - `receive` is always a plain boolean ("the page accepted it"). An older Mac app reads it with evaluateJavaScript, which
  //    cannot take a promise: it would report "not taken" for a message that was in fact stored, and a retry would send it again.
  //  - `receiveAck` is the newer door: a promise that settles after the work is done (a message is signed and stored), true
  //    or false. A newer Mac app uses it when it exists, and keeps the owner's text until then.
  Object.defineProperty(s, 'talosNative', {
    value: Object.freeze({
      receive: (raw: unknown): boolean => {
        const answer = bridge.receive(raw)
        return typeof answer === 'boolean' ? answer : true
      },
      receiveAck: (raw: unknown): Promise<boolean> => Promise.resolve(bridge.receive(raw)),
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  })
  installed = { kind: 'desktop', bridge, platform }
  return installed
}

// The page's end of the shell bridge (packages/protocol/src/native.ts). Every message out is validated before it is
// posted, and every message in is validated before a handler sees it, so a bad value from either side is dropped here.
import { NativeToWeb, type NativeToWebT, WebToNative, type WebToNativeT } from '@talos-app/protocol'

export interface ShellTransport {
  post(message: unknown): void
}

export type ShellHandlers = {
  [K in NativeToWebT['type']]?: (message: Extract<NativeToWebT, { type: K }>) => void | Promise<void>
}

export interface ShellBridge {
  /** False (and nothing posted) when the message is not a valid web -> native message or the transport throws. */
  send(message: WebToNativeT): boolean
  /**
   * Called by the shell with a JSON string or an object. False when it is not a valid native -> web message or the handler
   * refused it. A handler that does its work asynchronously makes this a promise of the same answer: it settles true when
   * the work is done and false when it failed, so the shell can keep the owner's text until then.
   */
  receive(raw: unknown): boolean | Promise<boolean>
  setHandlers(handlers: ShellHandlers): void
}

export function createShellBridge(transport: ShellTransport): ShellBridge {
  let handlers: ShellHandlers = {}
  return {
    send(message) {
      const parsed = WebToNative.safeParse(message)
      if (!parsed.success) return false
      try {
        transport.post(parsed.data)
        return true
      } catch {
        return false
      }
    },
    receive(raw) {
      let value: unknown = raw
      if (typeof raw === 'string') {
        if (raw.length > 40_000_000) return false
        try {
          value = JSON.parse(raw)
        } catch {
          return false
        }
      }
      const parsed = NativeToWeb.safeParse(value)
      if (!parsed.success) return false
      const handler = handlers[parsed.data.type] as ((m: NativeToWebT) => void | Promise<void>) | undefined
      if (!handler) return false
      try {
        const done = handler(parsed.data)
        if (done && typeof done.then === 'function')
          return done.then(
            () => true,
            () => false,
          )
      } catch {
        return false
      }
      return true
    },
    setHandlers(h) {
      handlers = h
    },
  }
}

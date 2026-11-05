// The iPhone shell's share-sheet token plugin (apps/mobile `TalosShare`, IOS-SPEC 6.1). Feature-detected on the globals
// the shell injects; a normal browser or an older shell build answers `false` and nothing is called. The call carries the
// token and its scopes and NOTHING else: the shell posts to the relay compiled into the app, never to one named here
// (IOS-SPEC E15). There is no read method: the page cannot ask the shell for the token back.
import type { ShareScopeT } from '@talos-app/protocol'
import { isNativeShell } from './native.ts'

type Method = (options?: Record<string, unknown>) => Promise<unknown>
type Plugin = Partial<Record<'setToken' | 'clearToken', Method>>

function plugin(scope: unknown): Plugin | null {
  try {
    const p = (scope as { Capacitor?: { Plugins?: { TalosShare?: unknown } } } | null | undefined)?.Capacitor?.Plugins
      ?.TalosShare
    return typeof p === 'object' && p !== null ? (p as Plugin) : null
  } catch {
    return null
  }
}

/** True inside the shell, when this build of the shell has the share plugin. */
export function shareSheetAvailable(scope: unknown = globalThis): boolean {
  return isNativeShell(scope) && plugin(scope) !== null
}

/** Stores the share token for the share extension. Resolves false (never throws) when the shell refuses or is missing. */
export async function setShareToken(
  token: string,
  scopes: ShareScopeT[],
  scope: unknown = globalThis,
): Promise<boolean> {
  try {
    const p = plugin(scope)
    if (!shareSheetAvailable(scope) || !p?.setToken) return false
    await p.setToken({ token, scopes })
    return true
  } catch {
    return false
  }
}

export async function clearShareToken(scope: unknown = globalThis): Promise<boolean> {
  try {
    const p = plugin(scope)
    if (!shareSheetAvailable(scope) || !p?.clearToken) return false
    await p.clearToken()
    return true
  } catch {
    return false
  }
}

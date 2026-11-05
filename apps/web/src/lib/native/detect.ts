// Whether the Mac app is hosting this page (the iPhone shell is lib/native.ts). Feature detection only; nothing here loads a library or touches the
// network. A normal browser, an installed PWA, or a page that merely defines a look-alike global stays 'none', so the
// plain web adapter is used unchanged (docs/SPEC.md, desktop spec 5.1 and WP-W1).
export type ShellKind = 'desktop' | 'none'

/** The suffix the Mac app adds to the web view's user agent. A page that only defines the message handler is not a shell. */
export const DESKTOP_UA_MARK = ' TalosDesktop/'

type Scope = {
  webkit?: { messageHandlers?: { talos?: { postMessage?: unknown } } }
  navigator?: { userAgent?: string }
  top?: unknown
}

/** An agent-written page in an iframe never counts: only the top frame is the app. */
function isTopFrame(scope: Scope): boolean {
  try {
    return scope.top === scope
  } catch {
    return false
  }
}

export function detectShell(scope: unknown = globalThis): ShellKind {
  try {
    const s = (typeof scope === 'object' && scope !== null ? scope : {}) as Scope
    if (!isTopFrame(s)) return 'none'
    const post = s.webkit?.messageHandlers?.talos?.postMessage
    if (typeof post === 'function' && (s.navigator?.userAgent ?? '').includes(DESKTOP_UA_MARK)) return 'desktop'
  } catch {
    /* fall through */
  }
  return 'none'
}

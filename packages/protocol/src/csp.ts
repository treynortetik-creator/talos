// The Content-Security-Policy every app page is served with: the relay sets it on responses and the web service worker sets it on the
// shell it answers from the precache. Pure, so both (and the web specs) build the identical string.

export function appCsp(origin: string): string {
  const u = new URL(origin)
  const ws = `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self' ${ws}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

/**
 * The policy agent-made HTML is served with (an attachment page, /media/:id/page, and an org page's frame, /p/:id/frame): a
 * sandboxed, opaque origin that runs only its own inline script and style, shows only `data:`/`blob:` images, media and fonts,
 * and has no `connect-src`, so no fetch, XHR or WebSocket; no forms, popups, downloads or top navigation (the sandbox allows
 * none of them). The page can read nothing but its own bytes.
 */
export const PAGE_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:"

/** The `sandbox` attribute of the frame that shows such a page: script only, never `allow-same-origin` (the web lint refuses it). */
export const PAGE_SANDBOX_ATTR = 'allow-scripts'

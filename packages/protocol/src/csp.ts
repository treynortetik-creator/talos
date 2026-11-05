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

// Which same-origin navigations the service worker hands to the relay instead of answering with the app's shell. Every
// one of these is a relay page or endpoint the shell must never stand in for: /api, /media, /hook, /bridge, /ws, /healthz,
// and /p (an org page's link and its frame, docs/ORG-PAGES-SPEC.md: without it the frame would get the shell, not the page).
export const RELAY_PATHS = /^\/(api|media|hook|bridge|p|ws|healthz)(\/|$)/

/** True for a path the relay answers itself. */
export const goesToRelay = (pathname: string): boolean => RELAY_PATHS.test(pathname)

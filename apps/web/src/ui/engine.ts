// Which browser engine is this? One question the app asks: does a sandboxed page get to pull keyboard focus into itself
// without a tap? Chromium engines let it (Chrome, Edge, Brave, Samsung Internet, Android Chrome); WebKit does not (Safari,
// the iPhone app, the Mac app's web view). Chrome and Edge on iPhone are WebKit underneath, so they count as WebKit.
type NavLike = {
  userAgent: string
  userAgentData?: { brands?: ReadonlyArray<{ brand: string }> }
}

export function isChromiumEngine(nav: NavLike | undefined = typeof navigator === 'undefined' ? undefined : navigator) {
  if (!nav) return false
  const ua = nav.userAgent ?? ''
  if (/\b(iPhone|iPad|iPod)\b/.test(ua) || /\b(CriOS|EdgiOS|FxiOS)\//.test(ua)) return false
  if (nav.userAgentData?.brands?.some((b) => /chromium/i.test(b.brand))) return true
  return /\b(Chrome|Chromium|HeadlessChrome)\//.test(ua)
}

/** HTML page cards on these engines wait for a tap before they run any script. Everywhere else they run at once. */
export const pageCardsWaitForTap = () => isChromiumEngine()

/**
 * Safari, every browser on iPhone and iPad, and the Mac app's web view. WebKit does not let a frame focus its own field
 * without a tap (checked with Playwright WebKit), so nothing is guarded there and a tap into a page is never second-guessed.
 * Android browsers and Chromium carry a `Chrome/` token; the Mac app's web view may have no `Safari/` token, so the test
 * is "WebKit and not anything else", not "says Safari".
 */
export function isWebKitEngine(nav: NavLike | undefined = typeof navigator === 'undefined' ? undefined : navigator) {
  if (!nav) return false
  const ua = nav.userAgent ?? ''
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true
  if (nav.userAgentData?.brands?.some((b) => /chromium/i.test(b.brand))) return false
  return /\bAppleWebKit\//.test(ua) && !/\b(Chrome|Chromium|HeadlessChrome|Android|Edg|OPR)\b/.test(ua)
}

/** The frame focus guard runs on every engine except WebKit (Chromium, Firefox and anything we do not recognise). */
export const frameFocusGuardNeeded = () => !isWebKitEngine()

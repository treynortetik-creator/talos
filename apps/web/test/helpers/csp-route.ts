import type { Route } from '@playwright/test'

/** Requests the proxy could not pass on while their page was still open. A spec takes the list at the end of each test,
 *  BEFORE unrouteAll: that call answers or disposes what is still in flight, and those are the end of the test, not a fault. */
export const proxyFailures: string[] = []

/** Passes a request on to the server and answers with its response, adding `csp` to HTML pages (the relay's production
 *  Content-Security-Policy). No retry: the ECONNRESETs CI saw on WebKit (1158624, d4167e0) were vite preview closing an
 *  idle keep-alive connection as this fetch reused it, fixed at the server (vite.config.ts previewKeepsIdle), so any reset
 *  left is a real one and fails its test. A request that outlives its page is aborted quietly, since a closed
 *  page has nothing to answer; any other failure is aborted and recorded, so its test fails and names the URL and error. */
export async function proxyWithCsp(route: Route, csp: string) {
  try {
    const res = await route.fetch()
    const headers = res.headers()
    if ((headers['content-type'] ?? '').includes('text/html')) headers['content-security-policy'] = csp
    await route.fulfill({ status: res.status(), headers, body: await res.body() })
  } catch (e) {
    const req = route.request()
    let gone = true
    try {
      gone = req.frame().page().isClosed()
    } catch {} // a request with no frame (a service worker's) belongs to no page that could show it
    if (!gone) proxyFailures.push(`${req.method()} ${req.url()}: ${(e as Error).message.split('\n')[0]}`)
    await route.abort().catch(() => {})
  }
}

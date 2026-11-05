import { appCsp } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import { openSignedIn } from '../helpers/util.ts'

test.use({ serviceWorkers: 'allow' })

test('the built sw.js carries the whole page policy, so a policy change forces a reinstall', async ({
  harness,
  request,
}) => {
  const js = await (await request.get(`${harness.url}/sw.js`)).text()
  // Every origin-independent directive of the relay's policy appears in the compiled worker.
  const fixed = appCsp('https://x.example')
    .split('; ')
    .filter((d) => !d.startsWith('connect-src'))
  for (const d of fixed) expect(js, d).toContain(d)
  // The stamp is production-only: the build must have resolved the flag, not left it for the browser.
  expect(js).not.toContain('import.meta.env')
})

test('a shell served by the service worker carries the relay CSP and blocks inline script', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context, '/')
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 })
  // The installed app starts at '/', which the precache route (not the navigate handler) answers: every address must be stamped.
  for (const path of ['/', '/index.html', '/?utm_source=x', '/threads']) {
    const resp = await page.goto(path)
    expect(resp?.fromServiceWorker(), path).toBe(true)
    expect(resp?.headers()['content-security-policy'], path).toBe(appCsp(harness.url))
  }
  const resp = await page.reload()
  expect(resp?.fromServiceWorker()).toBe(true)

  const result = await page.evaluate(async () => {
    const violations: string[] = []
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective))
    ;(window as unknown as { __ran: boolean }).__ran = false
    const s = document.createElement('script')
    s.textContent = 'window.__ran = true'
    document.head.appendChild(s)
    await new Promise((r) => setTimeout(r, 300))
    return { ran: (window as unknown as { __ran: boolean }).__ran, violations }
  })
  expect(result.ran).toBe(false)
  expect(result.violations.some((v) => v.startsWith('script-src'))).toBe(true)
})

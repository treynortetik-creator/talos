// Spec 10.4: an SVG with <script> and a .html upload claiming image/png, opened top-level at /media/:id, are sandboxed
// attachments that run nothing; an HTML attachment served at /media/:id/page runs in an opaque origin and can read neither
// the app's cookies nor IndexedDB nor /api.
import { expect, test } from '@playwright/test'
import { startTestRelay, type TestRelay } from './harness.ts'

let relay: TestRelay
const SESSION = { 'X-Test-Session': 'none', Origin: 'https://relay.example.com', 'X-Talos-CSRF': '1' }

test.beforeAll(async () => {
  relay = await startTestRelay()
})
test.afterAll(async () => {
  await relay.stop()
})

async function upload(body: string, claimed: string, name: string): Promise<{ media_id: string; mime: string }> {
  const res = await fetch(`${relay.httpBase}/api/media`, {
    method: 'POST',
    body,
    headers: { ...SESSION, 'content-type': claimed, 'x-talos-name': name },
  })
  return (await res.json()) as { media_id: string; mime: string }
}

test.describe('media sandbox', () => {
  test.beforeEach(async ({ context }) => {
    await context.setExtraHTTPHeaders({ 'X-Test-Session': 'none' })
    await context.addCookies([{ name: 'talos_s', value: 'top-secret-session', url: relay.httpBase }])
  })

  for (const [label, body, claimed, name] of [
    [
      'an SVG with a script',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = document.cookie</script></svg>',
      'image/svg+xml',
      'x.svg',
    ],
    [
      'a .html upload claiming image/png',
      '<!doctype html><script>document.title = document.cookie</script>',
      'image/png',
      'cat.png',
    ],
  ] as const) {
    test(`${label} opened top-level is a download, not a page`, async ({ page }) => {
      const ref = await upload(body, claimed, name)
      const download = page.waitForEvent('download')
      await page.goto(`${relay.httpBase}/media/${ref.media_id}`).catch(() => undefined) // "Download is starting"
      const d = await download
      expect(d.suggestedFilename()).toBe(name)
      // nothing ran: the blank page still has no title from the script
      expect(await page.title()).toBe('')
    })
  }

  test('the response itself says sandbox, attachment and nosniff', async ({ request }) => {
    const ref = await upload(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      'image/svg+xml',
      'y.svg',
    )
    const res = await request.get(`${relay.httpBase}/media/${ref.media_id}`, { headers: { 'X-Test-Session': 'none' } })
    expect(res.headers()['content-disposition']).toMatch(/^attachment/)
    expect(res.headers()['content-security-policy']).toMatch(/^sandbox;/)
    expect(res.headers()['x-content-type-options']).toBe('nosniff')
  })

  test('an HTML attachment at /page runs, but cannot read cookies, IndexedDB or /api', async ({ page }) => {
    const script = `
      const out = {}
      try { out.cookie = 'read:' + document.cookie } catch (e) { out.cookie = e.name }
      try { const r = indexedDB.open('talos-app'); out.idb = 'opened' ; r.onerror = () => {} } catch (e) { out.idb = e.name }
      fetch('/api/push/test', { method: 'POST' })
        .then((r) => r.text().then(() => { out.api = 'status:' + r.status }))
        .catch((e) => { out.api = e.name })
        .finally(() => { document.title = JSON.stringify(out) })`
    const ref = await upload(
      `<!doctype html><title>start</title><script>${script}</script>`,
      'text/html',
      'report.html',
    )
    expect(ref.mime).toBe('text/html')
    await page.goto(`${relay.httpBase}/media/${ref.media_id}/page`)
    await expect.poll(async () => page.title(), { timeout: 10_000 }).toContain('{')
    const out = JSON.parse(await page.title()) as Record<string, string>
    expect(out.cookie).toBe('SecurityError')
    expect(out.idb).toBe('SecurityError')
    expect(out.api).not.toMatch(/^status:2/)
  })
})

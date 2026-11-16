// Org pages, phase 1 (docs/ORG-PAGES-SPEC.md, "Tests"): a published page, shown in its frame the way the app shows it
// (sandbox = PAGE_SANDBOX_ATTR, under PAGE_CSP), runs its own script, but every way out fails: fetch, a form, a popup and top
// navigation, and it cannot read the Talos cookie. Run in Chromium and WebKit (playwright.config.ts).
import { expect, test } from '@playwright/test'
import { PAGE_SANDBOX_ATTR } from '@talos-app/protocol'
import { startTestRelay, type TestRelay } from './harness.ts'
import { bridgeFetch } from './helpers.ts'

let relay: TestRelay

test.beforeAll(async () => {
  relay = await startTestRelay()
})
test.afterAll(async () => {
  await relay.stop()
})

const TRAP = '/api/pages?escaped=1'

async function publish(html: string): Promise<string> {
  const res = await bridgeFetch(
    relay,
    'POST',
    `/bridge/pages?thread_id=trip&title=${encodeURIComponent('Sandbox check')}`,
    new TextEncoder().encode(html),
    { 'content-type': 'text/html; charset=utf-8' },
  )
  expect(res.status).toBe(201)
  return ((await res.json()) as { page_id: string }).page_id
}

test.describe('an org page in its frame', () => {
  test.beforeEach(async ({ context }) => {
    await context.setExtraHTTPHeaders({ 'X-Test-Session': 'none' })
    await context.addCookies([{ name: 'talos_s', value: 'top-secret-session', url: relay.httpBase }])
  })

  test('runs its own script, but fetch, a form, a popup and top navigation all fail, and the cookie is unreadable', async ({
    page,
    context,
  }) => {
    const script = `
      const out = {}
      try { out.cookie = 'read:' + document.cookie } catch (e) { out.cookie = e.name }
      try { const w = window.open('${TRAP}&via=popup'); out.popup = w ? 'opened' : 'blocked' } catch (e) { out.popup = e.name }
      try {
        const f = document.createElement('form')
        f.action = '${TRAP}&via=form'
        f.method = 'post'
        document.body.append(f)
        f.submit()
        out.form = 'tried'
      } catch (e) { out.form = e.name }
      try { top.location.href = '${TRAP}&via=top'; out.top = 'tried' } catch (e) { out.top = e.name }
      fetch('${TRAP}&via=fetch')
        .then((r) => { out.fetch = 'status:' + r.status })
        .catch((e) => { out.fetch = e.name })
        .finally(() => { document.title = JSON.stringify(out) })`
    const id = await publish(`<!doctype html><title>start</title><body><script>${script}</script></body>`)
    // what reached the relay, and every window that opened
    const escaped: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('escaped=1')) escaped.push(r.url())
    })
    const popups: string[] = []
    context.on('page', (p) => popups.push(p.url()))
    // the host: a page of the relay's own origin framing the page as the app does
    const host = `${relay.httpBase}/host-${id}`
    await page.route(host, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>host</title><iframe sandbox="${PAGE_SANDBOX_ATTR}" referrerpolicy="no-referrer" src="/p/${id}/frame"></iframe>`,
      }),
    )
    await page.goto(host)
    const frame = () => page.frames().find((f) => f.url().includes(`/p/${id}/frame`))
    await expect.poll(async () => (await frame()?.title()) ?? '', { timeout: 15_000 }).toContain('{')
    const out = JSON.parse((await frame()?.title()) ?? '{}') as Record<string, string>
    // it ran (the title is its own), in an opaque origin
    expect(out.cookie).toBe('SecurityError')
    // no connect-src: the request never leaves the page
    expect(out.fetch).not.toMatch(/^status:/)
    // a moment for anything that was going to happen anyway
    await page.waitForTimeout(1_500)
    expect(escaped).toEqual([])
    expect(popups).toEqual([])
    expect(page.url()).toBe(host)
    expect(frame()?.url()).toContain(`/p/${id}/frame`)
  })

  test('opened by its link, a page that navigates itself to another site stays put (the wrapper’s frame-src)', async ({
    page,
  }) => {
    const id = await publish(
      `<!doctype html><title>start</title><script>
        setTimeout(() => { location.href = 'http://escape.invalid/?d=' + encodeURIComponent('typed') }, 50)
        setTimeout(() => { document.title = 'still-here' }, 300)
      </script>`,
    )
    const out: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('escape.invalid')) out.push(r.url())
    })
    await page.goto(`${relay.httpBase}/p/${id}`)
    await page.waitForTimeout(1_500)
    const frame = page.frames().find((f) => f.url().includes(`/p/${id}/frame`))
    expect(out).toEqual([])
    expect(page.url()).toBe(`${relay.httpBase}/p/${id}`)
    // the frame never left (or was stopped before it did): no outside page ever loaded in it
    expect(page.frames().some((f) => f.url().includes('escape.invalid'))).toBe(false)
    expect(frame === undefined || !frame.url().includes('escape.invalid')).toBe(true)
  })

  test('the frame opened top-level is refused: it only ever runs inside a frame', async ({ page }) => {
    const id = await publish('<!doctype html><title>bare</title><p>x</p>')
    const res = await page.goto(`${relay.httpBase}/p/${id}/frame`)
    expect(res?.status()).toBe(404)
    expect(await page.title()).not.toBe('bare')
  })

  test('the frame response says the page policy, private, never cached', async ({ request }) => {
    const id = await publish('<!doctype html><p>x</p>')
    const res = await request.get(`${relay.httpBase}/p/${id}/frame`, { headers: { 'X-Test-Session': 'none' } })
    expect(res.status()).toBe(200)
    expect(res.headers()['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none';/)
    expect(res.headers()['content-security-policy']).not.toMatch(/connect-src/)
    expect(res.headers()['cache-control']).toBe('private, no-store')
  })
})

// The memory browser (docs/V2-FEATURES.md V5.3) on iPhone (WebKit), Pixel and desktop: the real screen and socket adapter
// over frames the bridge's memory service captured on a synthetic notes folder.
import { expect, type Page, test } from '@playwright/test'
import { verifyOwnerFrame } from '@talos-app/protocol'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

async function open(page: Page, route = '/memory', o: { offline?: boolean } = {}) {
  const q = new URLSearchParams({ route })
  if (o.offline) q.set('offline', '1')
  await page.goto(`/test/memory/harness/index.html?${q}`)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}

test('the tree, a note with frontmatter and links, and a script that stays text', async ({ page }) => {
  await open(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Memory' })).toBeVisible()
  await page.getByTestId('memory-entry-Overview.md').click()
  await expect(page.getByTestId('memory-frontmatter')).toContainText('draft')
  const body = page.getByTestId('memory-body')
  await expect(body).toContainText('<script>alert(1)</script>')
  expect(await body.locator('script').count()).toBe(0)
  await expect(body.getByTestId('memory-link-null')).toHaveCount(2)
  await body.getByText('Launch checklist').click()
  await expect(page.getByTestId('location')).toContainText('Launch+checklist.md')
  await expectAxeClean(page)
})

test('a long folder pages in, and a long note loads the rest', async ({ page }) => {
  await open(page, `/memory?r=notes&p=${'d'.repeat(144)}`)
  await expect(page.getByTestId('memory-list')).toBeVisible()
  // scrolling to the end loads the next page by itself, until all 500 are there
  await expect
    .poll(
      async () => {
        await page.getByTestId('memory-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight))
        return await page.getByTestId('memory-list').getByRole('listitem').count()
      },
      { timeout: 20_000 },
    )
    .toBe(500)
  await open(page, '/memory?r=notes&n=big/Big note.md')
  await expect(page.getByTestId('memory-note')).toBeVisible()
  await expect
    .poll(
      async () => {
        await page.getByTestId('memory-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight))
        return await page.getByTestId('memory-load-more').count()
      },
      { timeout: 20_000 },
    )
    .toBe(0)
})

test('search lists hits and a hit opens its note', async ({ page }) => {
  await open(page)
  await page.getByTestId('memory-search').fill('quarterly release')
  await expect(page.getByTestId('hit-row')).toContainText('projects/example/plan.md')
  await page.getByTestId('hit-row').click()
  await expect(page.getByTestId('location')).toContainText('n=projects%2Fexample%2Fplan.md')
})

test('Ask sends a signed message with refs', async ({ page }) => {
  await open(page, '/memory?r=notes&n=Overview.md')
  await page.getByTestId('memory-ask').click()
  await page.getByTestId('memory-ask-send').click()
  await expect(page.getByText('Thread')).toBeVisible()
  const f = await page.evaluate(() => JSON.parse(JSON.stringify(window.__talos.sent.find((x) => x.type === 'message'))))
  expect(f.refs).toHaveLength(1)
  expect(f.refs[0]).toMatchObject({ kind: 'memory', root_id: 'notes', path: 'Overview.md' })
  const jwk = await page.evaluate(() => window.__talos.publicJwk())
  expect(await verifyOwnerFrame(f, jwk)).toBeTruthy()
})

test('hidden notes and the off switch say what to do', async ({ page }) => {
  await open(page, '/memory?r=notes&n=private/Secret plan.md')
  await expect(page.getByTestId('memory-error')).toContainText("isn't shared")
})

test('with the Mac offline: Needs your Mac', async ({ page }) => {
  await open(page, '/memory', { offline: true })
  await expect(page.getByTestId('memory-needs-mac')).toBeVisible()
})

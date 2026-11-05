import { createHash } from 'node:crypto'
import { newId } from '@talos-app/protocol'
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

const PAGE = `<!doctype html><meta charset="utf-8"><body>page<script>
const out = {}
try { out.cookie = document.cookie } catch (e) { out.cookie = 'blocked:' + e.name }
try { out.storage = String(localStorage.length) } catch (e) { out.storage = 'blocked:' + e.name }
fetch('/api/me').then((r) => { out.fetch = 'status ' + r.status }).catch(() => { out.fetch = 'failed' }).finally(() => parent.postMessage(out, '*'))
</script></body>`

test('an HTML page card is a sandboxed iframe: no same-origin, no cookies, no /api', async ({
  page,
  context,
  harness,
}) => {
  await page.addInitScript(() => {
    window.addEventListener('message', (e) => {
      ;(window as unknown as { __page: unknown }).__page = e.data
    })
  })
  await openSignedIn(harness, page, context)
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: a readable cookie the sandboxed page must not see
    document.cookie = 'probe=1; path=/'
  })
  const media_id = newId('md')
  const bytes = Buffer.from(PAGE)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  harness.relay.media.set(media_id, { bytes, sha256, mime: 'text/html' })
  harness.relay.sendToApps(
    agentReply({
      text: 'Here is the page.',
      attachments: [
        {
          media_id,
          kind: 'html',
          role: 'attachment',
          mime: 'text/html',
          name: 'report.html',
          size: bytes.length,
          sha256,
        },
      ],
    }),
  )
  // Chromium waits for a tap before an inline page runs; WebKit runs it at once.
  await page.locator('iframe[title="report.html"], button[aria-label="Run report.html"]').first().waitFor()
  const run = page.getByRole('button', { name: 'Run report.html' })
  if (await run.count()) await run.click()
  const frame = page.locator('iframe[title="report.html"]')
  await expect(frame).toBeVisible()
  expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(await frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  await expect(page.frameLocator('iframe[title="report.html"]').locator('body')).toContainText('page')

  await expect.poll(() => page.evaluate(() => (window as unknown as { __page?: unknown }).__page)).toBeDefined()
  const out = (await page.evaluate(() => (window as unknown as { __page: Record<string, string> }).__page)) as Record<
    string,
    string
  >
  expect(out.cookie).not.toContain('probe')
  expect(out.cookie === '' || out.cookie?.startsWith('blocked:')).toBe(true)
  expect(out.storage?.startsWith('blocked:')).toBe(true)
  expect(out.fetch).toBe('failed')
})

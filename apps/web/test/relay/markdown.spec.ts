import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

const CORPUS = [
  '<img src=x onerror="window.__xss=1">',
  '<script>window.__xss=2</script>',
  '[click](javascript:window.__xss=3)',
  '[data](data:text/html,<script>window.__xss=4</script>)',
  '![pic](javascript:window.__xss=5)',
  '<a href="javascript:window.__xss=6">raw anchor</a>',
  '<svg onload="window.__xss=7"></svg>',
  '<iframe src="javascript:window.__xss=8"></iframe>',
  '<div style="background:url(javascript:window.__xss=9)">styled</div>',
  '[vbscript](vbscript:msgbox)',
  '[ok](https://example.com/path)',
  'mail me at <alex@example.com> or visit https://example.org',
].join('\n\n')

test('markdown XSS payloads render inert; links are http(s)/mailto only and leave through the platform adapter', async ({
  page,
  context,
  harness,
}) => {
  await page.addInitScript(() => {
    ;(window as unknown as { __opened: unknown[] }).__opened = []
    window.open = ((...a: unknown[]) => {
      ;(window as unknown as { __opened: unknown[] }).__opened.push(a)
      return null
    }) as typeof window.open
  })
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: CORPUS }))
  const msg = page.getByTestId('msg-agent').first()
  await expect(msg.getByRole('link', { name: 'ok' })).toBeVisible()

  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  const hrefs = await msg.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))
  for (const h of hrefs) expect(h === '' || /^(https?:|mailto:)/i.test(h)).toBe(true)
  // The Listen button under the message is the app's own icon, not the agent's markup.
  await expect(
    msg.locator(
      'script, iframe, svg:not([data-testid="speak"] svg):not([data-testid="msg-copy-inline"] svg), [onerror], [onload], [style]',
    ),
  ).toHaveCount(0)
  await expect(msg.locator('img')).toHaveCount(0)

  const ok = msg.getByRole('link', { name: 'ok' })
  await expect(ok).toHaveAttribute('target', '_blank')
  await expect(ok).toHaveAttribute('rel', 'noopener noreferrer')
  await ok.click()
  expect(await page.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened)).toEqual([
    ['https://example.com/path', '_blank', 'noopener,noreferrer'],
  ])
  expect(page.url()).toMatch(/\/t\/general$/)
})

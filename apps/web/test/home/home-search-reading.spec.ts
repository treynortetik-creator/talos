// R2 D34 in a real browser at 393 px: a wide table scrolls inside its own box (the page does not), and an image in
// agent text is a link chip that never asks the network for the picture.
import { expect, test } from '@playwright/test'

const TABLE = [
  '| Region | Owner | Pipeline | Closed won | Forecast | Notes |',
  '| --- | --- | --- | --- | --- | --- |',
  '| West | Dana Whitfield | $1,240,000 | $410,000 | $980,000 | Two large renewals slipped to next quarter |',
  '| East | Marcus Ibarra | $860,000 | $390,000 | $720,000 | On track |',
].join('\n')
const IMG_URL = 'https://tracker.invalid/pixel.png?u=owner'

test('a six-column table scrolls sideways at 393 px and an image is only a link chip', async ({ page }) => {
  const requested: string[] = []
  page.on('request', (r) => requested.push(r.url()))
  await page.setViewportSize({ width: 393, height: 852 })
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(
    ({ table, img }) => {
      const c = (window as unknown as { __talos: { store: { getState(): never; setState(p: unknown): void } } }).__talos
      const s = c.store.getState() as { messages: Record<string, unknown[]> }
      const msg = {
        id: 'm_r2_md',
        thread_id: 'general',
        seq: 9999,
        author: 'agent',
        kind: 'text',
        text: `Here is the board.\n\n${table}\n\n![quarterly chart](${img})`,
        format: 'markdown',
        attachments: [],
        via: 'agent',
        created_at: new Date().toISOString(),
      }
      c.store.setState({ ...s, messages: { ...s.messages, general: [...(s.messages.general ?? []), msg] } })
    },
    { table: TABLE, img: IMG_URL },
  )
  const table = page.locator('.prose-talos table').first()
  await expect(table).toBeVisible()
  const m = await table.evaluate((t) => ({
    scrollWidth: t.scrollWidth,
    clientWidth: t.clientWidth,
    page: (document.scrollingElement as HTMLElement).scrollWidth,
    inner: innerWidth,
  }))
  expect(m.scrollWidth, `table scrollWidth ${m.scrollWidth} vs clientWidth ${m.clientWidth}`).toBeGreaterThan(
    m.clientWidth,
  )
  expect(m.page).toBeLessThanOrEqual(m.inner) // the table scrolls, the page does not
  const chip = page.locator('.prose-talos a.md-image-chip')
  await expect(chip).toHaveText('Image: quarterly chart')
  await expect(page.locator('.prose-talos img')).toHaveCount(0)
  expect(requested.filter((u) => u.includes('tracker.invalid'))).toEqual([])
})

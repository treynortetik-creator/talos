// An HTML attachment's Expand on a phone opens our own full-viewport layer with Close at the top right, never the
// browser's element fullscreen: iOS WebKit's fullscreen says "Swipe down to exit" and left on every scroll of a long
// page (the owner, 2026-11-14). With a mouse, Expand still asks for real fullscreen.
import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { agentReply, newId, openSignedIn } from '../helpers/util.ts'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
function htmlAtt(harness: Harness, name: string, body: string) {
  const media_id = newId('md')
  const bytes = Buffer.from(body)
  harness.relay.media.set(media_id, { bytes, sha256: sha(bytes), mime: 'text/html' })
  return { media_id, kind: 'html', role: 'attachment', mime: 'text/html', name, size: bytes.length, sha256: sha(bytes) }
}
const LONG = `<!doctype html><body style="margin:0"><div style="height:6000px">a long page</div></body>`

/** Counts every requestFullscreen call before the page runs. */
const countFullscreen = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __fsCalls: number }
    w.__fsCalls = 0
    const real = Element.prototype.requestFullscreen
    Element.prototype.requestFullscreen = function (this: Element, ...a: Parameters<typeof real>) {
      w.__fsCalls++
      return real ? real.apply(this, a) : Promise.resolve()
    }
  })

async function expand(page: Page, harness: Harness) {
  harness.relay.sendToApps(agentReply({ text: 'Here it is', attachments: [htmlAtt(harness, 'audit.html', LONG)] }))
  await expect(page.locator('iframe[title="audit.html"]')).toBeVisible()
  await page.getByRole('button', { name: 'Expand audit.html to full screen' }).click()
  await expect(page.getByRole('dialog', { name: 'audit.html' })).toBeVisible()
}

test('on a touch screen Expand opens our layer with Close at the top right, and a scroll never closes it', async ({
  page,
  context,
  harness,
}, info) => {
  test.skip(info.project.name === 'desktop', 'a touch screen')
  await countFullscreen(page)
  await openSignedIn(harness, page, context)
  await expand(page, harness)
  expect(
    await page.evaluate(() => (window as unknown as { __fsCalls: number }).__fsCalls),
    'no element fullscreen',
  ).toBe(0)
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  const dialog = page.getByRole('dialog', { name: 'audit.html' })
  const close = dialog.getByRole('button', { name: 'Close' })
  const box = await close.boundingBox()
  const vp = page.viewportSize()
  if (!box || !vp) throw new Error('no Close')
  expect(box.x + box.width, 'Close is the right-most control').toBeGreaterThan(vp.width - 24)
  expect(box.width, 'a 44 px target').toBeGreaterThanOrEqual(44)
  expect(box.y, 'Close at the top').toBeLessThan(120)
  expect(box.height, 'a 44 px target').toBeGreaterThanOrEqual(44)
  // scroll the page down and back up inside its own frame (mobile WebKit has no wheel here): the layer stays
  const inner = page.frameLocator('[role="dialog"] iframe').locator('body')
  await inner.evaluate(() => window.scrollBy(0, 1500))
  await inner.evaluate(() => window.scrollTo(0, 0))
  await expect(dialog).toBeVisible()
  await close.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('with a mouse, Expand still asks for real fullscreen', async ({ page, context, harness }, info) => {
  test.skip(info.project.name !== 'desktop', 'a mouse')
  await countFullscreen(page)
  await openSignedIn(harness, page, context)
  await expand(page, harness)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fsCalls: number }).__fsCalls)).toBe(1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

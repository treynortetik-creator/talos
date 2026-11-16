// A mascot clip never holds the page's load event: with every mascot video request held open (a slow phone connection, a
// slow media stack), the page still reaches load, shows the still first, and only then puts the clip on the page.
import { expect, test } from '@playwright/test'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

test('the page loads while the mascot videos have not answered; the clip comes after', async ({ page }) => {
  // the page's load event held back 3 s by an image the test adds and answers late (as a slow connection would), so the
  // app has drawn its mascots before load fires; and every mascot video held open, never answered while the test runs
  await page.route('**/__slow-load.png', async (r) => {
    await new Promise((res) => setTimeout(res, 3000))
    await r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) })
  })
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const img = document.createElement('img')
      img.src = '/__slow-load.png'
      img.alt = ''
      img.style.display = 'none'
      document.body.appendChild(img)
    })
  })
  await page.route(/\/brand\/mascot\/.*\.(mov|webm)(\?.*)?$/, () => new Promise(() => {}))
  // what is on the page at the moment of the load event: no clip may be (it would have held the event)
  await page.addInitScript(() => {
    addEventListener('load', () => {
      ;(window as unknown as { __clipsAtLoad: number }).__clipsAtLoad =
        document.querySelectorAll('.mascot video').length
      ;(window as unknown as { __mascotsAtLoad: number }).__mascotsAtLoad = document.querySelectorAll('.mascot').length
    })
  })
  await page.goto('/', { waitUntil: 'load', timeout: 15_000 }) // Home: a large animated mascot
  const at = await page.evaluate(() => {
    const w = window as unknown as { __clipsAtLoad: number; __mascotsAtLoad: number }
    return { clips: w.__clipsAtLoad, mascots: w.__mascotsAtLoad }
  })
  expect(at.mascots).toBeGreaterThan(0) // a mascot was there at load...
  expect(at.clips).toBe(0) // ...as its still, not a clip
  await expect(page.locator('.mascot video').first()).toBeAttached()
})

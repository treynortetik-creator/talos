// Edge-swipe simulation. Chromium (Pixel): real touch input through CDP, so hit-testing and native scrolling take part.
// WebKit (iPhone): Playwright has no touch-drag, so a swipe is dispatched as touch events on the element under the
// first point (or on `target`), which is what the page's listeners see.
import type { Locator, Page } from '@playwright/test'

type Pt = { x: number; y: number }

export async function swipe(
  page: Page,
  from: Pt,
  to: Pt,
  opts: { steps?: number; target?: Locator; second?: Pt } = {},
) {
  const steps = opts.steps ?? 8
  const isChromium = page.context().browser()?.browserType().name() === 'chromium'
  if (isChromium && !opts.target && !opts.second) {
    const cdp = await page.context().newCDPSession(page)
    const at = (i: number) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
    for (let i = 1; i <= steps; i++)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(i)] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    return
  }
  const handle = opts.target ? await opts.target.elementHandle() : null
  await page.evaluate(
    ({ from, to, steps, second, el }) => {
      const target = (el as Element | null) ?? document.elementFromPoint(from.x, from.y) ?? document.body
      const fire = (type: string, pts: Array<{ x: number; y: number }>) => {
        const e = new Event(type, { bubbles: true, cancelable: true })
        const list = pts.map((p, i) => ({ clientX: p.x, clientY: p.y, identifier: i, target }))
        Object.defineProperty(e, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : list })
        target.dispatchEvent(e)
      }
      const extra = second ? [second] : []
      fire('touchstart', [from, ...extra])
      for (let i = 1; i <= steps; i++)
        fire('touchmove', [
          { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
          ...extra,
        ])
      fire('touchend', [])
    },
    { from, to, steps, second: opts.second ?? null, el: handle },
  )
}

/** A touchstart that is cancelled by the system (iOS taking the edge for its back gesture), then more moves. */
export async function swipeCancelled(page: Page, from: Pt, to: Pt) {
  await page.evaluate(
    ({ from, to }) => {
      const target = document.elementFromPoint(from.x, from.y) ?? document.body
      const fire = (type: string, p?: { x: number; y: number }) => {
        const e = new Event(type, { bubbles: true })
        Object.defineProperty(e, 'touches', {
          value: p ? [{ clientX: p.x, clientY: p.y, identifier: 0, target }] : [],
        })
        target.dispatchEvent(e)
      }
      fire('touchstart', from)
      fire('touchmove', { x: from.x + 10, y: from.y })
      fire('touchcancel')
      fire('touchmove', to)
    },
    { from, to },
  )
}

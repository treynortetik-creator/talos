// The on-screen keyboard in Playwright. In the iPhone shell the Keyboard plugin runs in `native` resize mode: the web view
// really shrinks to the space above the keyboard, so the layout viewport changes size (window.innerHeight, 100dvh, the
// media queries). `keyboard(page, px)` models exactly that with `setViewportSize`; `keyboard(page, 0)` restores the size
// the page had before. Nothing stubs `visualViewport` any more: the old stub (a layout that never shrank) hid the headline
// bug. The lift (`keyboardWillShow`) is a window event the plugin dispatches; `keyboardWillShow` below sends the same one.
import type { Page } from '@playwright/test'

const full = new WeakMap<Page, { width: number; height: number }>()

// A keyboard only exists on a touch device. The app (rightly) ignores a window that shrinks under a MOUSE (resizing the
// Mac app must not hide the header), so on a project with a fine pointer (desktop) the page has to BE a touch device
// while the keyboard is up. This answers `(pointer: coarse)` with true on that one page, and puts the browser's own
// answer back when the keyboard goes. Where the project already is coarse (iphone, pixel) it changes nothing, and the
// app's `coarsePointer` is untouched for every test that does not call `keyboard()`.
const touchOn = () => {
  const w = window as unknown as { __kbRealMatchMedia?: typeof window.matchMedia }
  const real = window.matchMedia.bind(window)
  if (w.__kbRealMatchMedia || real('(pointer: coarse)').matches) return
  w.__kbRealMatchMedia = window.matchMedia
  window.matchMedia = (q: string) => {
    const list = real(q)
    if (!/\(\s*pointer\s*:\s*coarse\s*\)/.test(q)) return list
    return new Proxy(list, {
      get(t, k) {
        if (k === 'matches') return true
        const v = Reflect.get(t, k, t)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  }
}
const touchOff = () => {
  const w = window as unknown as { __kbRealMatchMedia?: typeof window.matchMedia }
  if (!w.__kbRealMatchMedia) return
  window.matchMedia = w.__kbRealMatchMedia
  delete w.__kbRealMatchMedia
}
/** Three frames: the resize event, then the app's two-frame settle before it sets or clears `data-kb`. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      ),
  )

/** Opens the keyboard (px > 0) or closes it (px = 0) by resizing the page, and returns once the app has settled. */
export async function keyboard(page: Page, px: number): Promise<void> {
  if (px <= 0) {
    const f = full.get(page)
    if (f) await page.setViewportSize(f)
    full.delete(page)
    await settle(page)
    await page.evaluate(touchOff)
    await settle(page)
    return
  }
  const f = full.get(page) ?? page.viewportSize()
  if (!f) throw new Error('keyboard(): the page has no viewport size')
  full.set(page, f)
  await page.evaluate(touchOn)
  await page.setViewportSize({ width: f.width, height: f.height - px })
  await settle(page)
}

/** The window event the Keyboard plugin sends as the keyboard starts to slide (the property is set on the event itself). */
export const keyboardWillShow = (page: Page, keyboardHeight: number) =>
  page.evaluate((h) => {
    const e = new Event('keyboardWillShow') as Event & { keyboardHeight?: number }
    e.keyboardHeight = h
    window.dispatchEvent(e)
  }, keyboardHeight)

export const keyboardWillHide = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('keyboardWillHide')))

/** The visible part of the page while the keyboard is up. With native resize that is the whole layout viewport. */
export const visible = (page: Page) => page.evaluate(() => ({ top: 0, bottom: window.innerHeight }))

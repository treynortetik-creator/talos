// The phone's pull-down: it opens the palette only for a deliberate pull from the very top, never for a normal scroll.
import { describe, expect, it, vi } from 'vitest'
import { attachPullToSearch } from '../../src/features/palette/pull.ts'

function setup(scrollTop = 0) {
  const el = document.createElement('div')
  let top = scrollTop
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v) => {
      top = v
    },
    configurable: true,
  })
  const fn = vi.fn()
  const off = attachPullToSearch(el, fn)
  const t = (type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true }) as Event & {
      touches?: unknown
      changedTouches?: unknown
    }
    const pt = [{ clientX: x, clientY: y }]
    e.touches = type === 'touchend' ? [] : pt
    e.changedTouches = pt
    el.dispatchEvent(e)
  }
  return {
    el,
    fn,
    off,
    t,
    scroll: (v: number) => {
      top = v
    },
  }
}

describe('pull to search', () => {
  it('opens after a long, mostly vertical pull down from the top', () => {
    const { fn, t } = setup()
    t('touchstart', 100, 100)
    t('touchmove', 102, 150)
    t('touchmove', 104, 230)
    t('touchend', 104, 230)
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('never opens for a normal scroll: the finger moves up', () => {
    const { fn, t } = setup()
    t('touchstart', 100, 400)
    t('touchmove', 100, 300)
    t('touchmove', 100, 150)
    t('touchend', 100, 150)
    expect(fn).not.toHaveBeenCalled()
  })
  it('never opens for a scroll back up the list: it started below the top', () => {
    const { fn, t } = setup(240)
    t('touchstart', 100, 100)
    t('touchmove', 100, 300)
    t('touchend', 100, 300)
    expect(fn).not.toHaveBeenCalled()
  })
  it('never opens when the list scrolls away during the gesture (a fling that ends at the top)', () => {
    const { fn, t, scroll } = setup(0)
    t('touchstart', 100, 100)
    scroll(30)
    t('touchmove', 100, 260)
    scroll(0)
    t('touchend', 100, 260)
    expect(fn).not.toHaveBeenCalled()
  })
  it('never opens for a short pull, a sideways drag, or a swipe that turns back', () => {
    const a = setup()
    a.t('touchstart', 100, 100)
    a.t('touchend', 100, 170)
    const b = setup()
    b.t('touchstart', 100, 100)
    b.t('touchmove', 300, 230)
    b.t('touchend', 300, 230)
    const c = setup()
    c.t('touchstart', 100, 100)
    c.t('touchmove', 100, 60)
    c.t('touchmove', 100, 240)
    c.t('touchend', 100, 240)
    expect(a.fn).not.toHaveBeenCalled()
    expect(b.fn).not.toHaveBeenCalled()
    expect(c.fn).not.toHaveBeenCalled()
  })
  it('stops listening when detached', () => {
    const { fn, t, off } = setup()
    off()
    t('touchstart', 100, 100)
    t('touchmove', 100, 260)
    t('touchend', 100, 260)
    expect(fn).not.toHaveBeenCalled()
  })
})

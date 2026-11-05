import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachEdgeSwipe,
  COMMIT_PX,
  decide,
  EDGE_PX,
  edgeOf,
  SLOP_PX,
  scrollsInDirection,
} from '../../src/features/phone/edgeSwipe.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('edgeOf', () => {
  it('only the outer strip counts', () => {
    expect(edgeOf(0, 400)).toBe('left')
    expect(edgeOf(EDGE_PX, 400)).toBe('left')
    expect(edgeOf(EDGE_PX + 1, 400)).toBeNull()
    expect(edgeOf(400 - EDGE_PX, 400)).toBe('right')
    expect(edgeOf(400 - EDGE_PX - 1, 400)).toBeNull()
    expect(edgeOf(200, 400)).toBeNull()
  })
  it('unknown values never match', () => {
    expect(edgeOf(Number.NaN, 400)).toBeNull()
    expect(edgeOf(5, 0)).toBeNull()
    expect(edgeOf(5, Number.NaN)).toBeNull()
    expect(edgeOf(-3, 400)).toBeNull()
    expect(edgeOf(Number.POSITIVE_INFINITY, 400)).toBeNull()
  })
})

describe('decide', () => {
  it('commits on a long, mostly sideways pull in from the edge', () => {
    expect(decide('left', COMMIT_PX, 5)).toBe('commit')
    expect(decide('right', -COMMIT_PX, -5)).toBe('commit')
  })
  it('waits while short', () => {
    expect(decide('left', COMMIT_PX - 1, 0)).toBe('pending')
    expect(decide('right', -20, 3)).toBe('pending')
  })
  it('aborts on vertical drift, outward travel and a diagonal', () => {
    expect(decide('left', 12, SLOP_PX + 20)).toBe('abort')
    expect(decide('left', -(SLOP_PX + 1), 0)).toBe('abort')
    expect(decide('right', SLOP_PX + 1, 0)).toBe('abort')
    expect(decide('left', COMMIT_PX, COMMIT_PX * 0.9)).toBe('abort')
  })
  it('the wrong direction for the edge never commits', () => {
    expect(decide('left', -COMMIT_PX, 0)).toBe('abort')
    expect(decide('right', COMMIT_PX, 0)).toBe('abort')
  })
})

function scroller(scrollLeft: number) {
  const pre = document.createElement('pre')
  pre.style.overflowX = 'auto'
  Object.defineProperty(pre, 'scrollWidth', { value: 1000 })
  Object.defineProperty(pre, 'clientWidth', { value: 300 })
  pre.scrollLeft = scrollLeft
  Object.defineProperty(pre, 'scrollLeft', { value: scrollLeft, writable: true })
  document.body.append(pre)
  return pre
}

describe('scrollsInDirection', () => {
  it('a code block scrolled right keeps a left-edge swipe (it scrolls back)', () => {
    expect(scrollsInDirection(scroller(40), 'left')).toBe(true)
  })
  it('a code block at its start has nothing to scroll for a left-edge swipe', () => {
    expect(scrollsInDirection(scroller(0), 'left')).toBe(false)
  })
  it('a right-edge swipe scrolls forward: conflicts until the block is at its end', () => {
    expect(scrollsInDirection(scroller(0), 'right')).toBe(true)
    expect(scrollsInDirection(scroller(700), 'right')).toBe(false)
  })
  it('plain content and a null target never conflict', () => {
    const p = document.createElement('p')
    document.body.append(p)
    expect(scrollsInDirection(p, 'left')).toBe(false)
    expect(scrollsInDirection(null, 'right')).toBe(false)
  })
})

function touch(type: string, points: Array<[number, number]>, target: Element = document.body) {
  const e = new Event(type, { bubbles: true })
  const list = points.map(([clientX, clientY], i) => ({ clientX, clientY, identifier: i, target }))
  Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : list })
  target.dispatchEvent(e)
}

describe('attachEdgeSwipe', () => {
  function setup(enabled = true) {
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
    const onOpen = vi.fn()
    const off = attachEdgeSwipe({ onOpen, enabled: () => enabled })
    return { onOpen, off }
  }
  it('opens once per gesture, for the edge it began at', () => {
    const { onOpen, off } = setup()
    touch('touchstart', [[4, 300]])
    touch('touchmove', [[40, 302]])
    touch('touchmove', [[70, 303]])
    touch('touchmove', [[120, 304]])
    expect(onOpen).not.toHaveBeenCalled() // opens when the finger lifts
    touch('touchend', [])
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('left')
    touch('touchstart', [[397, 300]])
    touch('touchmove', [[300, 301]])
    touch('touchend', [])
    expect(onOpen).toHaveBeenLastCalledWith('right')
    expect(onOpen).toHaveBeenCalledTimes(2)
    off()
  })
  it('ignores swipes that start inside the screen, are disabled, pinch, cancel, or start in an opted-out region', () => {
    const { onOpen, off } = setup()
    touch('touchstart', [[120, 300]])
    touch('touchmove', [[260, 300]])
    touch('touchstart', [
      [4, 300],
      [200, 300],
    ])
    touch('touchmove', [
      [120, 300],
      [200, 300],
    ])
    touch('touchend', [])
    touch('touchstart', [[4, 300]])
    touch('touchcancel', [])
    touch('touchmove', [[120, 300]])
    touch('touchend', [])
    const zone = document.createElement('div')
    zone.setAttribute('data-no-edge-swipe', '')
    document.body.append(zone)
    touch('touchstart', [[4, 300]], zone)
    touch('touchmove', [[120, 300]], zone)
    touch('touchend', [], zone)
    expect(onOpen).not.toHaveBeenCalled()
    off()
    const off2 = setup(false)
    touch('touchstart', [[4, 300]])
    touch('touchmove', [[120, 300]])
    touch('touchend', [])
    expect(off2.onOpen).not.toHaveBeenCalled()
    off2.off()
  })
  it('ignores the edge while a dialog is open (image viewer, sheets)', () => {
    const { onOpen, off } = setup()
    const d = document.createElement('div')
    d.setAttribute('role', 'dialog')
    d.setAttribute('data-state', 'open')
    document.body.append(d)
    touch('touchstart', [[4, 300]])
    touch('touchmove', [[120, 300]])
    touch('touchend', [])
    expect(onOpen).not.toHaveBeenCalled()
    off()
  })
  it('pulling back under the distance before lifting opens nothing', () => {
    const { onOpen, off } = setup()
    touch('touchstart', [[4, 300]])
    touch('touchmove', [[120, 300]])
    touch('touchmove', [[20, 300]])
    touch('touchend', [])
    expect(onOpen).not.toHaveBeenCalled()
    off()
  })
  it('ignores the edge under any modal layer, Radix or hand-built (aria-modal with no data-state)', () => {
    const { onOpen, off } = setup()
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    document.body.append(overlay)
    touch('touchstart', [[4, 300]])
    touch('touchmove', [[120, 300]])
    touch('touchend', [])
    expect(onOpen).not.toHaveBeenCalled()
    off()
  })
  it('stops listening after teardown', () => {
    const { onOpen, off } = setup()
    off()
    touch('touchstart', [[4, 300]])
    touch('touchmove', [[120, 300]])
    touch('touchend', [])
    expect(onOpen).not.toHaveBeenCalled()
  })
})

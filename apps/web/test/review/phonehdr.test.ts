// Review of PR #94 at e3e206a: failing unit tests for the edge-swipe guard. The browser half is phonehdr.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachEdgeSwipe, COMMIT_PX } from '../../src/features/phone/edgeSwipe.ts'

function touch(type: string, points: Array<[number, number]>) {
  const e = new Event(type, { bubbles: true })
  const list = points.map(([clientX, clientY], i) => ({ clientX, clientY, identifier: i, target: document.body }))
  Object.defineProperty(e, 'touches', { value: type === 'touchend' || type === 'touchcancel' ? [] : list })
  document.body.dispatchEvent(e)
}

function setup() {
  Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
  const onOpen = vi.fn()
  return { onOpen, off: attachEdgeSwipe({ onOpen, enabled: () => true }) }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PR #94 edge swipe review', () => {
  // Medium, unproven system gesture. edgeSwipe.ts says iOS cancels first, so "the two never both fire". That holds only
  // if the cancel beats the 56 px commit. No browser here can show what iOS does, so this pins the one part we control:
  // once the panel has opened on a touchmove, a later cancel cannot undo it. If the fix retracts the panel on cancel
  // instead of waiting for the finger to lift, change this assertion to match. The device pass is still required.
  it('a system cancel that arrives after the commit distance leaves nothing open', () => {
    const { onOpen, off } = setup()
    touch('touchstart', [[4, 300]])
    touch('touchmove', [[4 + COMMIT_PX + 10, 300]])
    touch('touchcancel', [])
    expect(onOpen).not.toHaveBeenCalled()
    off()
  })
})

// @vitest-environment jsdom
// "Inside this view" (gesture.ts): activation is the view's only after focus moved into ITS frame with no host input
// since, and pays for one request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGestureTracker } from '../../src/features/apps/gesture.ts'

let frame: HTMLIFrameElement
let other: HTMLIFrameElement
let clock = 0
let active = true
let refocused = 0
let tracker: ReturnType<typeof createGestureTracker>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  frame = document.body.appendChild(document.createElement('iframe'))
  other = document.body.appendChild(document.createElement('iframe'))
  clock = 0
  active = true
  refocused = 0
  tracker = createGestureTracker({
    win: window,
    doc: document,
    frame: () => frame,
    now: () => clock,
    active: () => active,
    refocus: () => void refocused++,
  })
})
afterEach(() => {
  tracker.dispose()
  frame.remove()
  other.remove()
  vi.useRealTimers()
})

/** The owner taps inside a frame: the page's window blurs and the frame holds focus. */
const tapIn = async (el: HTMLElement) => {
  clock += 10
  el.focus()
  window.dispatchEvent(new Event('blur'))
  await vi.advanceTimersByTimeAsync(1)
}
const hostInput = (type = 'pointerdown') => {
  clock += 10
  document.body.dispatchEvent(new Event(type, { bubbles: true }))
}

describe('gesture tracker', () => {
  it('no focus in the frame: activation alone is not the view’s', () => {
    expect(tracker.claim()).toBe(false)
  })
  it('a tap inside the frame is a gesture, once', async () => {
    await tapIn(frame)
    expect(tracker.claim()).toBe(true)
    expect(refocused).toBe(1)
    expect(tracker.claim()).toBe(false)
  })
  it('the request can beat the deferred focus check (slow WebKit): the tap is still the view’s, once', () => {
    // No timer advance: the view's postMessage is handled before the host's setTimeout(0) after blur has run.
    clock += 10
    frame.focus()
    window.dispatchEvent(new Event('blur'))
    expect(tracker.claim()).toBe(true)
    expect(tracker.claim()).toBe(false)
    // and the next tap, again with the request first, is a new gesture
    clock += 10
    frame.focus()
    window.dispatchEvent(new Event('blur'))
    expect(tracker.claim()).toBe(true)
  })
  it('a blur whose focus never reached the frame is not a gesture even when the request is first', () => {
    clock += 10
    window.dispatchEvent(new Event('blur'))
    expect(tracker.claim()).toBe(false)
  })
  it('host input after a not-yet-processed blur still revokes it', () => {
    clock += 10
    frame.focus()
    window.dispatchEvent(new Event('blur'))
    hostInput()
    expect(tracker.claim()).toBe(false)
  })
  it('a second tap in the frame is a new gesture; a second request from the first is not', async () => {
    await tapIn(frame)
    expect(tracker.claim()).toBe(true)
    expect(tracker.claim()).toBe(false)
    await tapIn(frame)
    expect(tracker.claim()).toBe(true)
  })
  it.each(['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'])(
    'host %s after the tap revokes it',
    async (t) => {
      await tapIn(frame)
      hostInput(t)
      expect(tracker.claim()).toBe(false)
    },
  )
  it('a tap on Talos chrome after the view had focus is not the view’s', async () => {
    await tapIn(frame)
    expect(tracker.claim()).toBe(true)
    frame.focus()
    hostInput()
    expect(tracker.claim()).toBe(false)
  })
  it('focus in a different frame is not this view’s', async () => {
    await tapIn(other)
    expect(tracker.claim()).toBe(false)
  })
  it('focus that moved on to another frame after the tap no longer counts', async () => {
    await tapIn(frame)
    other.focus()
    expect(tracker.claim()).toBe(false)
  })
  it('the browser saying activation lapsed ends it', async () => {
    await tapIn(frame)
    active = false
    expect(tracker.claim()).toBe(false)
  })
  it('a blur that does not land on the frame is nothing', async () => {
    clock += 10
    window.dispatchEvent(new Event('blur'))
    await vi.advanceTimersByTimeAsync(1)
    expect(tracker.claim()).toBe(false)
  })
  it('R1-1: a tap in another view, then this frame takes focus with no new blur, is not this view’s', async () => {
    await tapIn(other)
    frame.focus()
    expect(tracker.claim()).toBe(false)
  })
  it('R1-4b: after one claim, a second claim with no new blur is refused', async () => {
    await tapIn(frame)
    expect(tracker.claim()).toBe(true)
    frame.focus()
    expect(tracker.claim()).toBe(false)
  })
  it('R1-4c: host input after the blur revokes the gesture', async () => {
    await tapIn(frame)
    hostInput('keydown')
    expect(tracker.claim()).toBe(false)
  })
  it('R1-4d: WebKit race, the request arrives before any timer: true once, with no timer ever run', () => {
    clock += 10
    frame.focus()
    window.dispatchEvent(new Event('blur'))
    expect(vi.getTimerCount()).toBe(0)
    expect(tracker.claim()).toBe(true)
    expect(tracker.claim()).toBe(false)
  })
  it('after dispose the page’s input no longer matters and nothing is claimable by stale listeners', async () => {
    tracker.dispose()
    await tapIn(frame)
    expect(tracker.claim()).toBe(false)
    tracker = createGestureTracker({
      win: window,
      doc: document,
      frame: () => frame,
      now: () => clock,
      active: () => active,
      refocus: () => {},
    })
  })
})

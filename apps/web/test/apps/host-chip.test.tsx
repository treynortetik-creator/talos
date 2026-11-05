// @vitest-environment jsdom
// The question sheet's arm rules, with the clock under the test's control: the main button ignores press, click and
// Enter/Space for 600 ms after the sheet opens and again after the visual viewport moves. Nothing here tracks positions:
// the sheet is fixed and modal, so there is nothing behind it that can move the button.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHIP_ARM_MS, HostChip } from '../../src/features/apps/HostChip.tsx'
import type { ChipAnswer } from '../../src/features/apps/host.ts'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(kind: 'message' | 'fullscreen' = 'message', text = 'Order 40 pizzas to 12 Elm St') {
  const answers: ChipAnswer[] = []
  render(
    <HostChip
      kind={kind}
      text={text}
      label="Gremlin"
      container={null}
      onDecide={(a) => answers.push(a)}
      onClosed={() => {}}
    />,
  )
  return { answers, send: screen.getByTestId(kind === 'message' ? 'app-message-send' : 'app-fullscreen-allow') }
}
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))
const tap = (el: HTMLElement) => {
  fireEvent.pointerDown(el)
  fireEvent.pointerUp(el)
  fireEvent.click(el, { detail: 1 })
}

describe('HostChip arming', () => {
  it('names the app and shows the whole text in a scrolling box', () => {
    const long = 'x'.repeat(500)
    mount('message', long)
    expect(screen.getByRole('dialog').textContent).toContain('Gremlin wants to send:')
    expect(screen.getByTestId('app-message-text').textContent).toBe(long)
    expect(screen.getByTestId('app-message-scroll').className).toContain('overflow-y-auto')
  })

  it('a tap before the wait is over sends nothing; after it, one answer', () => {
    const { answers, send } = mount()
    wait(CHIP_ARM_MS - 50)
    tap(send)
    expect(answers).toEqual([])
    wait(60)
    expect(send.getAttribute('data-armed')).toBe('true')
    tap(send)
    expect(answers).toEqual(['allow'])
  })

  it('a press while it was not armed does not send when the release comes after the wait', () => {
    const { answers, send } = mount()
    fireEvent.pointerDown(send)
    wait(CHIP_ARM_MS + 10)
    fireEvent.click(send, { detail: 1 })
    expect(answers).toEqual([])
  })

  it('Enter and Space are held back until armed', () => {
    const { answers, send } = mount()
    for (const key of ['Enter', ' ']) expect(fireEvent.keyDown(send, { key })).toBe(false)
    fireEvent.click(send, { detail: 0 }) // a browser that clicked anyway
    expect(answers).toEqual([])
    wait(CHIP_ARM_MS + 10)
    expect(fireEvent.keyDown(send, { key: 'Enter' })).toBe(true)
    fireEvent.click(send, { detail: 0 })
    expect(answers).toEqual(['allow'])
  })

  it('a visual viewport resize or scroll disarms the button and it waits again', () => {
    const vv = new EventTarget()
    vi.stubGlobal('visualViewport', vv)
    for (const type of ['resize', 'scroll']) {
      const { answers, send } = mount()
      wait(CHIP_ARM_MS + 10)
      expect(send.getAttribute('data-armed')).toBe('true')
      act(() => void vv.dispatchEvent(new Event(type)))
      expect(send.getAttribute('data-armed')).toBe('false')
      tap(send)
      expect(fireEvent.keyDown(send, { key: 'Enter' })).toBe(false)
      expect(answers).toEqual([])
      wait(CHIP_ARM_MS + 10)
      tap(send)
      expect(answers).toEqual(['allow'])
      cleanup()
    }
  })

  it('No, Stop asking and Escape answer at once, armed or not; a tap on the backdrop does nothing', () => {
    const { answers } = mount()
    fireEvent.click(screen.getByTestId('app-message-dismiss'))
    fireEvent.click(screen.getByTestId('app-chip-mute'))
    expect(answers).toEqual(['no', 'mute'])
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(answers).toEqual(['no', 'mute', 'no'])
    fireEvent.pointerDown(document.body)
    expect(answers).toEqual(['no', 'mute', 'no'])
  })

  it('a fullscreen sheet says what it asks and uses the same rule', () => {
    const { answers, send } = mount('fullscreen')
    expect(screen.getByTestId('app-fullscreen-chip').textContent).toContain('Gremlin wants to go full screen')
    tap(send)
    expect(answers).toEqual([])
    wait(CHIP_ARM_MS + 10)
    tap(send)
    expect(answers).toEqual(['allow'])
  })
})

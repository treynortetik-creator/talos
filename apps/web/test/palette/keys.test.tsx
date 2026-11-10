// Every chord -> its table entry, in the browser and in the Mac app; Cmd/Ctrl chords still work while typing, plain keys never act
// globally, letters match the layout (not the key's place), a Mac takes Cmd only and the rest take Ctrl only.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeyEntry } from '../../src/lib/keymap.ts'
import { useGlobalKeys } from '../../src/lib/useKeyboard.ts'

afterEach(cleanup)

function Probe({
  onAction,
  macApp = false,
  mac = macApp,
}: {
  onAction: (e: KeyEntry) => unknown
  macApp?: boolean
  /** Cmd (true) or Ctrl (false) is the chord key. */
  mac?: boolean
}) {
  useGlobalKeys({ onAction }, { macApp, mac })
  return (
    <div>
      <input aria-label="field" />
      <textarea aria-label="Message" />
    </div>
  )
}
const ids = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => (c[0] as KeyEntry).id)
const down = (target: Element | Window, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  fireEvent(target, e)
  return e
}

describe('chords', () => {
  it.each([
    [{ code: 'KeyK', key: 'k', metaKey: true }, 'palette'],
    [{ code: 'KeyK', key: 'k', ctrlKey: true }, 'palette'],
    [{ code: 'KeyK', key: 'K', metaKey: true, shiftKey: true }, 'call'],
    [{ code: 'Digit1', key: '1', metaKey: true }, 'thread1'],
    [{ code: 'Digit9', key: '9', ctrlKey: true }, 'thread9'],
    [{ code: 'KeyF', key: 'f', metaKey: true }, 'findInThread'],
    [{ code: 'Period', key: '.', metaKey: true }, 'sessionPanel'],
    [{ code: 'KeyJ', key: 'j', metaKey: true }, 'needsYou'],
    [{ code: 'Slash', key: '/', metaKey: true }, 'shortcuts'],
    [{ code: 'Backslash', key: '\\', ctrlKey: true }, 'sidebar'],
    [{ code: 'Escape', key: 'Escape' }, 'close'],
  ])('%j runs %s', (init, id) => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac={'metaKey' in init} />)
    const e = down(window, init)
    expect(ids(fn)).toEqual([id])
    expect(e.defaultPrevented).toBe(id !== 'close')
  })

  it('Cmd+Shift+K calls and does not open the palette; Alt variants are other people’s chords', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} />)
    down(window, { code: 'KeyK', key: 'k', metaKey: true, altKey: true })
    down(window, { code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true }) // Ctrl+Shift+K is not the call chord
    expect(fn).not.toHaveBeenCalled()
  })

  it('Cmd+[ and Cmd+] belong to the Mac app: in a browser they are left alone (Back / Forward)', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac />)
    const a = down(window, { code: 'BracketLeft', key: '[', metaKey: true })
    const b = down(window, { code: 'BracketRight', key: ']', metaKey: true })
    expect(fn).not.toHaveBeenCalled()
    expect(a.defaultPrevented || b.defaultPrevented).toBe(false)
  })
  it('in the Mac app Cmd+[ and Cmd+] step through the threads', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} macApp />)
    down(window, { code: 'BracketLeft', key: '[', metaKey: true })
    down(window, { code: 'BracketRight', key: ']', metaKey: true })
    expect(ids(fn)).toEqual(['threadPrev', 'threadNext'])
  })
  it('there is no Cmd+N chord in the page: the browser’s and the Mac menu’s Quick compose', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} macApp />)
    const e = down(window, { code: 'KeyN', key: 'n', metaKey: true })
    expect(fn).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
  it('an action that says it did nothing (false) leaves the browser’s own chord alone', () => {
    const fn = vi.fn(() => false)
    render(<Probe onAction={fn} mac />)
    const e = down(window, { code: 'KeyF', key: 'f', metaKey: true })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(false)
  })
  it('a held toggle does not strobe, and its repeats never reach the browser (Ctrl+J, Ctrl+F)', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac />)
    const held = [
      down(window, { code: 'KeyK', key: 'k', metaKey: true, repeat: true }),
      down(window, { code: 'KeyJ', key: 'j', metaKey: true, repeat: true }),
      down(window, { code: 'KeyF', key: 'f', metaKey: true, repeat: true }),
      down(window, { code: 'Backslash', key: '\\', metaKey: true, repeat: true }),
    ]
    expect(fn).not.toHaveBeenCalled()
    for (const e of held) expect(e.defaultPrevented).toBe(true)
    down(window, { code: 'Digit2', key: '2', metaKey: true, repeat: true })
    expect(ids(fn)).toEqual(['thread2'])
  })
  it('a held key that is not a chord is left alone', () => {
    render(<Probe onAction={vi.fn()} mac />)
    expect(down(window, { code: 'KeyV', key: 'v', metaKey: true, repeat: true }).defaultPrevented).toBe(false)
  })
  it('never a paste chord', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} macApp />)
    for (const init of [
      { code: 'KeyV', key: 'v', metaKey: true },
      { code: 'KeyV', key: 'V', metaKey: true, shiftKey: true },
      { code: 'Insert', key: 'Insert', shiftKey: true },
    ])
      down(window, init)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('the keyboard layout, not the key’s place', () => {
  it('Dvorak: Cmd+V (the V sits where Period is) is paste, not the Session panel', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac />)
    const e = down(window, { code: 'Period', key: 'v', metaKey: true })
    expect(fn).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
  it('Dvorak: Cmd+Z (the Z sits where Slash is) is undo, not the shortcut list', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac />)
    const e = down(window, { code: 'Slash', key: 'z', metaKey: true })
    expect(fn).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
  it('Dvorak: the K that is typed as K opens the palette wherever it sits', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac />)
    down(window, { code: 'KeyV', key: 'k', metaKey: true })
    expect(ids(fn)).toEqual(['palette'])
  })
  it('German: Ctrl+- (the minus sits where Slash is) is not taken', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac={false} />)
    const e = down(window, { code: 'Slash', key: '-', ctrlKey: true })
    expect(fn).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
  it('a Cyrillic or Greek layout falls back to the key’s place: Cmd+K still opens the palette', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac />)
    down(window, { code: 'KeyK', key: 'к', metaKey: true })
    down(window, { code: 'KeyJ', key: 'π', metaKey: true })
    expect(ids(fn)).toEqual(['palette', 'needsYou'])
  })
  it('the digit row goes by its place (AZERTY types & on the 1 key)', () => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac />)
    down(window, { code: 'Digit1', key: '&', metaKey: true })
    expect(ids(fn)).toEqual(['thread1'])
  })
})

describe('Cmd on a Mac, Ctrl everywhere else', () => {
  it.each([
    ['KeyF', 'f'],
    ['KeyK', 'k'],
    ['KeyJ', 'j'],
    ['Backslash', '\\'],
    ['Digit1', '1'],
  ])('on a Mac Ctrl+%s is a text-editing or system key, not ours', (code, key) => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac />)
    const e = down(window, { code, key, ctrlKey: true })
    expect(fn).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
  it.each([
    ['KeyF', 'f'],
    ['KeyK', 'k'],
    ['KeyJ', 'j'],
  ])('elsewhere Meta+%s (the Windows or Super key) is not ours', (code, key) => {
    const fn = vi.fn()
    render(<Probe onAction={fn} mac={false} />)
    down(window, { code, key, metaKey: true })
    expect(fn).not.toHaveBeenCalled()
  })
  it('each platform’s own key works', () => {
    const mac = vi.fn()
    const other = vi.fn()
    render(<Probe onAction={mac} mac />)
    down(window, { code: 'KeyJ', key: 'j', metaKey: true })
    cleanup()
    render(<Probe onAction={other} mac={false} />)
    down(window, { code: 'KeyJ', key: 'j', ctrlKey: true })
    expect(ids(mac)).toEqual(['needsYou'])
    expect(ids(other)).toEqual(['needsYou'])
  })
})

describe('while typing', () => {
  it('Cmd/Ctrl chords still work in the message box and in an input (switching threads while typing is useful)', () => {
    const fn = vi.fn()
    const { getByLabelText } = render(<Probe onAction={fn} mac />)
    down(getByLabelText('Message'), { code: 'Digit2', key: '2', metaKey: true })
    down(getByLabelText('field'), { code: 'KeyK', key: 'k', metaKey: true })
    down(getByLabelText('Message'), { code: 'KeyJ', key: 'j', metaKey: true })
    expect(ids(fn)).toEqual(['thread2', 'palette', 'needsYou'])
  })
  it('Esc works in a field', () => {
    const fn = vi.fn()
    const { getByLabelText } = render(<Probe onAction={fn} />)
    down(getByLabelText('field'), { code: 'Escape', key: 'Escape' })
    expect(ids(fn)).toEqual(['close'])
  })
  it('plain keys never act globally: letters, arrows, Enter, slash, brackets and digits', () => {
    const fn = vi.fn()
    const { getByLabelText } = render(<Probe onAction={fn} macApp />)
    for (const target of [getByLabelText('Message'), getByLabelText('field'), document.body]) {
      for (const [code, key] of [
        ['KeyK', 'k'],
        ['KeyJ', 'j'],
        ['KeyN', 'n'],
        ['Digit1', '1'],
        ['Slash', '/'],
        ['BracketLeft', '['],
        ['ArrowDown', 'ArrowDown'],
        ['ArrowUp', 'ArrowUp'],
        ['Enter', 'Enter'],
        ['Period', '.'],
      ] as const)
        down(target, { code, key })
    }
    expect(fn).not.toHaveBeenCalled()
  })
  it('a field that uses a chord itself keeps it: Cmd+[ and Cmd+] do nothing inside a text field', () => {
    const fn = vi.fn()
    const { getByLabelText } = render(<Probe onAction={fn} macApp />)
    down(getByLabelText('Message'), { code: 'BracketLeft', key: '[', metaKey: true })
    down(getByLabelText('field'), { code: 'BracketRight', key: ']', metaKey: true })
    expect(fn).not.toHaveBeenCalled()
  })
  it('does not act on a key that is part of an IME composition', () => {
    const fn = vi.fn()
    const { getByLabelText } = render(<Probe onAction={fn} mac />)
    down(getByLabelText('Message'), { code: 'Digit1', key: '1', metaKey: true, isComposing: true })
    expect(fn).not.toHaveBeenCalled()
  })
})

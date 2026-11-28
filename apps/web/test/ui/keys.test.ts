// @vitest-environment jsdom
// The one Escape and IME rule for search boxes (src/ui/keys.ts): Esc with text clears; Esc when empty closes, once; a held,
// modified or input-method Esc never closes; Enter during an input-method choice never submits.
import { describe, expect, it, vi } from 'vitest'
import { escapeIntent, isImeKey, keepEscapeInBox, searchBoxKeys } from '../../src/ui/keys.ts'

const esc = (o: Record<string, unknown> = {}) => ({ key: 'Escape', ...o })

describe('isImeKey', () => {
  it('is true for isComposing alone, for keyCode 229 alone (Safari ends the composition first), and for both', () => {
    expect(isImeKey({ isComposing: true })).toBe(true)
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true)
    expect(isImeKey({ isComposing: true, keyCode: 229 })).toBe(true)
  })
  it('is false for an ordinary key', () => {
    expect(isImeKey({ isComposing: false, keyCode: 27 })).toBe(false)
    expect(isImeKey({})).toBe(false)
  })
})

describe('escapeIntent', () => {
  it('Esc with text clears; spaces count as text', () => {
    expect(escapeIntent(esc(), 'abc')).toBe('clear')
    expect(escapeIntent(esc(), ' ')).toBe('clear')
  })
  it('Esc on an empty box closes', () => {
    expect(escapeIntent(esc(), '')).toBe('close')
  })
  it('a key repeat never closes and never clears: it is swallowed, with text or without', () => {
    expect(escapeIntent(esc({ repeat: true }), 'abc')).toBe('swallow')
    expect(escapeIntent(esc({ repeat: true }), '')).toBe('swallow')
  })
  it('an input-method Esc does nothing, whichever signal says so, with or without a repeat', () => {
    expect(escapeIntent(esc({ isComposing: true }), 'abc')).toBe('ignore')
    expect(escapeIntent(esc({ isComposing: false, keyCode: 229 }), 'abc')).toBe('ignore')
    expect(escapeIntent(esc({ isComposing: true }), '')).toBe('ignore')
    expect(escapeIntent(esc({ isComposing: true, repeat: true }), '')).toBe('ignore')
  })
  it('a modified Esc is swallowed: it is not Esc', () => {
    for (const m of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
      expect(escapeIntent(esc({ [m]: true }), 'abc')).toBe('swallow')
      expect(escapeIntent(esc({ [m]: true }), '')).toBe('swallow')
    }
  })
  it('any other key is not ours', () => {
    expect(escapeIntent({ key: 'Enter' }, 'abc')).toBe('ignore')
    expect(escapeIntent({ key: 'a' }, '')).toBe('ignore')
  })
})

function fake(o: Record<string, unknown>) {
  const e = {
    key: 'Escape',
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...o,
  }
  const nativeEvent = { isComposing: o.isComposing, keyCode: o.keyCode }
  return Object.assign(e, { nativeEvent }) as never as Parameters<ReturnType<typeof searchBoxKeys>>[0] & typeof e
}

describe('searchBoxKeys', () => {
  const setup = (value: string, withClose = true, withEnter = true) => {
    const onClear = vi.fn()
    const onClose = vi.fn()
    const onEnter = vi.fn()
    const on = searchBoxKeys({
      value,
      onClear,
      ...(withClose ? { onClose } : {}),
      ...(withEnter ? { onEnter } : {}),
    })
    return { on, onClear, onClose, onEnter }
  }
  it('Esc with text clears once, does not close, and consumes the key', () => {
    const { on, onClear, onClose } = setup('abc')
    const e = fake({})
    on(e)
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
  })
  it('Esc when empty closes once', () => {
    const { on, onClear, onClose } = setup('')
    const e = fake({})
    on(e)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClear).not.toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
  })
  it('an empty box with no close action leaves the key to the page', () => {
    const { on, onClear } = setup('', false)
    const e = fake({})
    on(e)
    expect(onClear).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(e.stopPropagation).not.toHaveBeenCalled()
  })
  it('a repeat is consumed and does nothing', () => {
    for (const v of ['abc', '']) {
      const { on, onClear, onClose } = setup(v)
      const e = fake({ repeat: true })
      on(e)
      expect(onClear).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(e.preventDefault).toHaveBeenCalled()
      expect(e.stopPropagation).toHaveBeenCalled()
    }
  })
  it('a modified Esc is consumed and does nothing', () => {
    const { on, onClear, onClose } = setup('abc')
    const e = fake({ shiftKey: true })
    on(e)
    expect(onClear).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
  })
  it('an input-method Esc touches nothing (the input method owns it)', () => {
    for (const o of [{ isComposing: true }, { keyCode: 229 }]) {
      const { on, onClear, onClose } = setup('abc')
      const e = fake(o)
      on(e)
      expect(onClear).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(e.preventDefault).not.toHaveBeenCalled()
      expect(e.stopPropagation).not.toHaveBeenCalled()
    }
  })
  it('Enter runs onEnter once; during an input-method choice or as a repeat it runs nothing', () => {
    const plain = setup('abc')
    plain.on(fake({ key: 'Enter' }))
    expect(plain.onEnter).toHaveBeenCalledTimes(1)
    for (const o of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
      const s = setup('abc')
      const e = fake({ key: 'Enter', ...o })
      s.on(e)
      expect(s.onEnter).not.toHaveBeenCalled()
    }
  })
  it('an input-method Enter is not consumed (the input method needs it)', () => {
    const s = setup('abc')
    const e = fake({ key: 'Enter', isComposing: true })
    s.on(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
  it('other keys are left alone', () => {
    const s = setup('abc')
    const e = fake({ key: 'ArrowDown' })
    s.on(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(s.onClear).not.toHaveBeenCalled()
  })
})

describe('keepEscapeInBox (Radix onEscapeKeyDown)', () => {
  it('stops the dismissal when Esc came from a marked box, and only then', () => {
    document.body.innerHTML = '<div id="in" data-escape-box=""><input id="a"></div><input id="b">'
    const mk = (id: string) => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      Object.defineProperty(ev, 'target', { value: document.getElementById(id) })
      return ev
    }
    const inside = mk('a')
    keepEscapeInBox(inside)
    expect(inside.defaultPrevented).toBe(true)
    const outside = mk('b')
    keepEscapeInBox(outside)
    expect(outside.defaultPrevented).toBe(false)
  })
})

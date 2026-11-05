import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useGlobalKeys } from '../../src/lib/useKeyboard.ts'

function Probe({ onSidebar }: { onSidebar: () => void }) {
  useGlobalKeys({ onThread: () => {}, onSidebar })
  return null
}
const press = (init: KeyboardEventInit) => fireEvent.keyDown(window, { code: 'Backslash', key: '\\', ...init })

describe('sidebar chord', () => {
  it('Ctrl+\\ and Cmd+\\ fire; Shift, Alt or a bare backslash do not', () => {
    const fn = vi.fn()
    render(<Probe onSidebar={fn} />)
    press({ ctrlKey: true })
    press({ metaKey: true })
    expect(fn).toHaveBeenCalledTimes(2)
    press({ ctrlKey: true, shiftKey: true })
    press({ ctrlKey: true, altKey: true })
    press({})
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

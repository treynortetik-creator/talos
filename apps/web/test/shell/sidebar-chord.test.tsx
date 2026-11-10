import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useGlobalKeys } from '../../src/lib/useKeyboard.ts'

function Probe({ onSidebar, mac }: { onSidebar: () => void; mac: boolean }) {
  useGlobalKeys({ onAction: (e) => (e.id === 'sidebar' ? onSidebar() : undefined) }, { mac })
  return null
}
const press = (init: KeyboardEventInit) => fireEvent.keyDown(window, { code: 'Backslash', key: '\\', ...init })

describe('sidebar chord', () => {
  it('Ctrl+\\ folds it off a Mac and Cmd+\\ on one; Shift, Alt or a bare backslash do not', () => {
    const fn = vi.fn()
    const off = render(<Probe onSidebar={fn} mac={false} />)
    press({ ctrlKey: true })
    press({ metaKey: true }) // the Windows or Super key is not ours
    expect(fn).toHaveBeenCalledTimes(1)
    off.unmount()
    render(<Probe onSidebar={fn} mac />)
    press({ metaKey: true })
    press({ ctrlKey: true }) // Ctrl is a text-editing key on a Mac
    expect(fn).toHaveBeenCalledTimes(2)
    press({ metaKey: true, shiftKey: true })
    press({ metaKey: true, altKey: true })
    press({})
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

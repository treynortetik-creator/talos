// Esc in the icon search of the thread editor (a Radix sheet): text clears it and the sheet, with the name typed so far, stays;
// an empty box closes the sheet; a held or input-method Esc never closes it.
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadEditor } from '../../../src/features/threads/manage/ThreadEditor.tsx'
import { renderWith, setup } from '../../cards/helpers.tsx'

afterEach(cleanup)

function open() {
  const onOpenChange = vi.fn()
  renderWith(<ThreadEditor open onOpenChange={onOpenChange} />, setup())
  const name = document.getElementById('thread-name') as HTMLInputElement
  fireEvent.change(name, { target: { value: 'Kept name' } })
  const box = screen.getByLabelText('Search icons') as HTMLInputElement
  fireEvent.change(box, { target: { value: 'star' } })
  return { name, box, onOpenChange }
}

describe('Esc in the icon search', () => {
  it('with text it clears the filter, keeps the sheet and the typed name; empty closes the sheet once', () => {
    const { name, box, onOpenChange } = open()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box.value).toBe('')
    expect(name.value).toBe('Kept name')
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
  it('a held Esc and an input-method Esc never close it', () => {
    const { box, onOpenChange } = open()
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(box, { key: 'Escape', keyCode: 229 })
    fireEvent.keyDown(box, { key: 'Escape', repeat: true })
    expect(box.value).toBe('star')
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.keyDown(box, { key: 'Escape', repeat: true })
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

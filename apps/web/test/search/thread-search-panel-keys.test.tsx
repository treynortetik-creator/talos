// Esc and input-method keys in the find-in-thread panel: text clears, an empty box closes the panel, once; held, modified and
// input-method Esc never close it.
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadSearchPanel } from '../../src/features/search/ThreadSearchPanel.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

afterEach(cleanup)

function open(text = 'abc') {
  const onClose = vi.fn()
  renderWith(<ThreadSearchPanel threadId="general" threadName="General" onClose={onClose} />, setup())
  const box = screen.getByRole('searchbox') as HTMLInputElement
  fireEvent.change(box, { target: { value: text } })
  return { box, onClose }
}

describe('Esc in the find-in-thread box', () => {
  it('with text it clears and the panel stays; on an empty box it closes once', () => {
    const { box, onClose } = open()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box.value).toBe('')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('spaces only: clears first', () => {
    const { box, onClose } = open('  ')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box.value).toBe('')
    expect(onClose).not.toHaveBeenCalled()
  })
  it('a held Esc never closes, with text or on an empty box', () => {
    const { box, onClose } = open()
    fireEvent.keyDown(box, { key: 'Escape', repeat: true })
    expect(box.value).toBe('abc')
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.keyDown(box, { key: 'Escape', repeat: true })
    fireEvent.keyDown(box, { key: 'Escape', repeat: true })
    expect(onClose).not.toHaveBeenCalled()
  })
  it('an input-method Esc and a modified Esc do nothing', () => {
    const { box, onClose } = open()
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(box, { key: 'Escape', keyCode: 229 })
    fireEvent.keyDown(box, { key: 'Escape', ctrlKey: true })
    expect(box.value).toBe('abc')
    expect(onClose).not.toHaveBeenCalled()
  })
  it('Esc from a hit row (not the box) still closes the panel, and a held one does not', () => {
    const { box, onClose } = open('')
    const row = document.createElement('button')
    row.setAttribute('data-testid', 'hit-row')
    box.closest('[role="dialog"]')?.appendChild(row)
    fireEvent.keyDown(row, { key: 'Escape', repeat: true })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

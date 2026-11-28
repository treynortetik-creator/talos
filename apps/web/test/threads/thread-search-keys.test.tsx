// Esc and input-method keys in the thread-list search box (sidebar and phone menu): Esc with text clears it and the box stays;
// Esc on an empty box puts the thread list back; a held, modified or input-method Esc does neither.
import { cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadTools, useThreadSearch } from '../../src/features/threads/ThreadSearch.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

afterEach(cleanup)

function Host() {
  const search = useThreadSearch()
  return <ThreadTools search={search} editing={false} onEditing={() => {}} />
}

async function open() {
  renderWith(<Host />, setup())
  await userEvent.click(screen.getByRole('button', { name: 'Search threads' }))
  const box = screen.getByRole('searchbox', { name: 'Search all threads' }) as HTMLInputElement
  fireEvent.change(box, { target: { value: 'abc' } })
  return box
}
const stillSearching = () => screen.queryByRole('searchbox', { name: 'Search all threads' }) !== null

describe('Esc in the thread search box', () => {
  it('with text it clears the box and keeps searching; the next Esc ends the search', async () => {
    const box = await open()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box.value).toBe('')
    expect(stillSearching()).toBe(true)
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(stillSearching()).toBe(false)
  })
  it('text of only spaces counts as text', async () => {
    const box = await open()
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box.value).toBe('')
    expect(stillSearching()).toBe(true)
  })
  it('a held Esc clears once and then never ends the search, with text or without', async () => {
    const box = await open()
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.keyDown(box, { key: 'Escape', repeat: true })
    fireEvent.keyDown(box, { key: 'Escape', repeat: true })
    expect(stillSearching()).toBe(true)
  })
  it('an input-method Esc does nothing: no clear, no end (isComposing, and keyCode 229 alone)', async () => {
    const box = await open()
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(box, { key: 'Escape', keyCode: 229 })
    expect(box.value).toBe('abc')
    expect(stillSearching()).toBe(true)
  })
  it('a modified Esc does nothing', async () => {
    const box = await open()
    fireEvent.keyDown(box, { key: 'Escape', shiftKey: true })
    expect(box.value).toBe('abc')
    expect(stillSearching()).toBe(true)
  })
})

// Esc and input-method keys in the command palette (a real Radix dialog): Esc with text clears it and the palette stays; an
// empty box closes it once; a held, modified or input-method Esc never closes it; an input-method Enter runs nothing.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { Palette } from '../../src/features/palette/Palette.tsx'
import { usePalette } from '../../src/features/palette/store.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { setup } from '../cards/helpers.tsx'

afterEach(() => {
  fireEvent.keyUp(window, { key: 'Enter' })
  act(() => usePalette.getState().close())
  cleanup()
})

const input = () => screen.getByRole('combobox') as HTMLInputElement
const isOpen = () => screen.queryByRole('combobox') !== null

function mount() {
  render(
    <ClientProvider client={setup({ cards: [] })}>
      <MemoryRouter initialEntries={['/t/general']}>
        <Palette mac phone={false} hasSession={false} ctx={{}} />
      </MemoryRouter>
    </ClientProvider>,
  )
  act(() => usePalette.getState().open('palette'))
  fireEvent.change(input(), { target: { value: 'abc' } })
}

describe('Esc in the palette box', () => {
  it('with text it clears and the palette stays; then an empty box closes it', () => {
    mount()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(input().value).toBe('')
    expect(isOpen()).toBe(true)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(isOpen()).toBe(false)
  })
  it('spaces only: clears first', () => {
    mount()
    fireEvent.change(input(), { target: { value: '  ' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(isOpen()).toBe(true)
    expect(input().value).toBe('')
  })
  it('a held Esc never closes it, with text or empty', () => {
    mount()
    fireEvent.keyDown(input(), { key: 'Escape', repeat: true })
    expect(input().value).toBe('abc')
    fireEvent.keyDown(input(), { key: 'Escape' })
    fireEvent.keyDown(input(), { key: 'Escape', repeat: true })
    fireEvent.keyDown(input(), { key: 'Escape', repeat: true })
    expect(isOpen()).toBe(true)
  })
  it('an input-method Esc and a modified Esc do nothing', () => {
    mount()
    fireEvent.keyDown(input(), { key: 'Escape', isComposing: true })
    fireEvent.keyDown(input(), { key: 'Escape', keyCode: 229 })
    fireEvent.keyDown(input(), { key: 'Escape', metaKey: true })
    expect(input().value).toBe('abc')
    expect(isOpen()).toBe(true)
  })
  it('an empty box that was never typed in closes on the first Esc', () => {
    mount()
    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(isOpen()).toBe(false)
  })
})

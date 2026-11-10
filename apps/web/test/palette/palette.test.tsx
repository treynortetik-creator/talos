// The palette: items and their shortcut labels come from the keymap table; it only OPENS a Needs-you card and never answers one.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Palette } from '../../src/features/palette/Palette.tsx'
import { usePalette } from '../../src/features/palette/store.ts'
import { chordLabel, DEFAULT_KEYMAP } from '../../src/lib/keymap.ts'
import { makeCard, renderWith, setup } from '../cards/helpers.tsx'

function SearchProbe() {
  return <div data-testid="search">{useLocation().search}</div>
}

afterEach(() => {
  fireEvent.keyUp(window, { key: 'Enter' }) // a run by key leaves Enter swallowed until it comes up
  act(() => usePalette.getState().close())
  cleanup()
})

const entry = (id: string) => {
  const e = DEFAULT_KEYMAP.find((x) => x.id === id)
  if (!e) throw new Error(id)
  return e
}
const open = (mode: 'palette' | 'needs' = 'palette') => act(() => usePalette.getState().open(mode))
const input = () => screen.getByRole('combobox')
const loc = () => screen.getByTestId('location').textContent
const search = () => screen.getByTestId('search').textContent

function mount(over: { phone?: boolean; macApp?: boolean } = {}) {
  const card = makeCard({ title: 'Reply to the venue' })
  const client = setup({ cards: [card] })
  const resolve = vi.spyOn(client, 'resolveCard')
  const send = vi.spyOn(client, 'sendMessage')
  renderWith(
    <>
      <Palette mac phone={over.phone ?? false} macApp={over.macApp ?? false} />
      <SearchProbe />
    </>,
    client,
    '/',
  )
  return { client, card, resolve, send }
}

describe('items', () => {
  it('lists the jump targets, each labelled from the table, with its shortcut beside it', () => {
    mount()
    open()
    for (const id of ['needsYou', 'topCard', 'schedules', 'settings', 'memory', 'newThread', 'shortcuts']) {
      const opt = screen.getByRole('option', { name: new RegExp(entry(id).label) })
      const chord = chordLabel(entry(id).chord, true)
      if (chord) expect(within(opt).getByText(chord), id).toBeTruthy()
      else expect(opt.querySelector('kbd'), id).toBeNull()
    }
  })
  it('lists the threads in sidebar order, the first nine with their Cmd+digit', () => {
    const { client } = mount()
    open()
    const names = client.store
      .getState()
      .threads.filter((t) => !t.archived)
      .map((t) => t.name)
    expect(names.length).toBeGreaterThan(0)
    names.forEach((n, i) => {
      const opt = screen.getByRole('option', { name: new RegExp(n) })
      expect(within(opt).getByText(chordLabel(entry(`thread${i + 1}`).chord, true))).toBeTruthy()
    })
  })
  it('shows no shortcut on a phone', () => {
    mount({ phone: true })
    open()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(3)
    expect(document.body.querySelectorAll('kbd')).toHaveLength(0)
  })
  it('hides the Mac-app-only items from a browser, and lists them in the Mac app', () => {
    mount()
    open()
    expect(screen.queryByRole('option', { name: new RegExp(entry('threadNext').label) })).toBeNull()
    cleanup()
    act(() => usePalette.getState().close())
    mount({ macApp: true })
    open()
    expect(screen.getByRole('option', { name: new RegExp(entry('threadNext').label) })).toBeTruthy()
  })
  it('has no Call item, because the Call chord is not wired anywhere today', () => {
    mount()
    open()
    expect(screen.queryByRole('option', { name: new RegExp(entry('call').label) })).toBeNull()
  })
})

describe('doing things', () => {
  it('a thread name then Enter opens that thread', () => {
    const { client } = mount()
    open()
    const t = client.store.getState().threads.find((x) => !x.archived)
    fireEvent.change(input(), { target: { value: (t?.name ?? '').slice(0, 4) } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(loc()).toBe(`/t/${t?.id}`)
    expect(screen.queryByRole('combobox')).toBeNull()
  })
  it('text that matches nothing offers to search messages, in the existing search screen', () => {
    mount()
    open()
    fireEvent.change(input(), { target: { value: 'zzqq' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(loc()).toBe('/search')
    expect(search()).toBe('?q=zzqq')
  })
  it('arrows move the highlight (aria-activedescendant) and Enter runs it', () => {
    mount()
    open()
    fireEvent.change(input(), { target: { value: 'settings' } })
    const first = screen.getAllByRole('option')[0] as HTMLElement
    expect(input().getAttribute('aria-activedescendant')).toBe(first.id)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(loc()).toBe('/settings')
  })
  it('Esc closes it', () => {
    mount()
    open()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

describe('a held Enter', () => {
  it('a repeating Enter (the key was already down) opens nothing', () => {
    mount()
    open()
    fireEvent.change(input(), { target: { value: 'settings' } })
    fireEvent.keyDown(input(), { key: 'Enter', repeat: true })
    expect(loc()).toBe('/')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(loc()).toBe('/settings')
  })
})

describe('Needs you: open, never answer', () => {
  it('the top-card item opens the card and sends nothing', () => {
    const { card, resolve, send } = mount()
    open()
    fireEvent.change(input(), { target: { value: entry('topCard').label } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(loc()).toBe(`/card/${card.id}`)
    expect(resolve).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('the Cmd+J list shows the waiting cards; Enter opens one and never answers it', () => {
    const { card, resolve, send } = mount()
    open('needs')
    const opt = screen.getByRole('option', { name: /Reply to the venue/ })
    expect(opt).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(Send|Allow|Approve|Kill|Deny)/ })).toBeNull()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(loc()).toBe(`/card/${card.id}`)
    expect(resolve).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('a stray Enter, Space or repeated Enter in the list opens at most the one card', () => {
    const { resolve } = mount()
    open('needs')
    fireEvent.keyDown(input(), { key: 'Enter' })
    open('needs')
    fireEvent.keyDown(input(), { key: ' ' })
    fireEvent.keyDown(input(), { key: 'Enter', repeat: true })
    expect(resolve).not.toHaveBeenCalled()
  })
  it('an empty list says so', () => {
    const client = setup({ cards: [] })
    renderWith(<Palette mac phone={false} macApp={false} />, client, '/')
    open('needs')
    expect(screen.getByText(/Nothing needs you/i)).toBeTruthy()
  })
})

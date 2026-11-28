// The page-level search and filter boxes follow the same Esc and input-method rule as the boxes in dialogs (ui/keys.ts): Esc with
// text clears it; a held, modified or input-method Esc does not; an empty box leaves Esc to the page (nothing to close).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilesPane } from '../../src/features/files/FilesPane.tsx'
import { SentFiles } from '../../src/features/files/SentFiles.tsx'
import { useFilesBrowser } from '../../src/features/files/useFilesBrowser.ts'
import { HelpScreen } from '../../src/features/help/HelpScreen.tsx'
import { HomeScreen } from '../../src/features/home/HomeScreen.tsx'
import { FilterBar } from '../../src/features/schedules/GroupList.tsx'
import { SearchScreen } from '../../src/features/search/SearchScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { setup } from '../cards/helpers.tsx'
import { replayClient } from './../search/replay.ts'

afterEach(cleanup)

function inRouter(ui: ReactElement, client = setup()) {
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </ClientProvider>,
  )
}
function FilterHost() {
  const [q, setQ] = useState('')
  return <FilterBar filters={new Set()} onFilters={() => {}} query={q} onQuery={setQ} search />
}

/** A thread's folder on the Mac: the files browser with its filter box. */
function FolderHost() {
  const b = useFilesBrowser('general')
  return <FilesPane b={b} layout="pane" />
}

const boxes: Array<{ name: string; mount: () => void; box: () => Promise<HTMLInputElement> | HTMLInputElement }> = [
  {
    name: 'Home search',
    mount: () => inRouter(<HomeScreen />),
    box: () => screen.getByRole('searchbox', { name: 'Search' }) as HTMLInputElement,
  },
  {
    name: 'Help search',
    mount: () => inRouter(<HelpScreen />),
    box: () => screen.getByLabelText('Search Help') as HTMLInputElement,
  },
  {
    name: 'Message search screen',
    mount: () => inRouter(<SearchScreen />, Object.assign(createFakeClient(), { search: replayClient() })),
    box: () => screen.getByRole('searchbox', { name: 'Search messages' }) as HTMLInputElement,
  },
  {
    name: 'Files (sent) search',
    mount: () => inRouter(<SentFiles layout="list" />),
    box: () => screen.getByTestId('sent-files-search') as HTMLInputElement,
  },
  {
    name: 'Schedules filter bar',
    mount: () => inRouter(<FilterHost />),
    box: () => screen.getByLabelText(/search/i) as HTMLInputElement,
  },
  {
    name: 'Agent folder filter',
    mount: () => inRouter(<FolderHost />),
    box: () => screen.getByLabelText('Filter files') as HTMLInputElement,
  },
]

describe.each(boxes)('$name', ({ mount, box }) => {
  const open = async () => {
    mount()
    const b = await box()
    fireEvent.change(b, { target: { value: 'abc' } })
    return b
  }
  it('Esc with text clears it (spaces count as text)', async () => {
    const b = await open()
    expect(fireEvent.keyDown(b, { key: 'Escape' })).toBe(false) // consumed
    expect(b.value).toBe('')
    fireEvent.change(b, { target: { value: '  ' } })
    fireEvent.keyDown(b, { key: 'Escape' })
    expect(b.value).toBe('')
  })
  it('a held, modified or input-method Esc leaves the text alone', async () => {
    const b = await open()
    fireEvent.keyDown(b, { key: 'Escape', repeat: true })
    fireEvent.keyDown(b, { key: 'Escape', shiftKey: true })
    fireEvent.keyDown(b, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(b, { key: 'Escape', keyCode: 229 })
    expect(b.value).toBe('abc')
  })
  it('Esc on an empty box is the page’s: not consumed, so nothing here swallows it', async () => {
    const b = await open()
    fireEvent.change(b, { target: { value: '' } })
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    fireEvent.keyDown(b, { key: 'Escape' })
    window.removeEventListener('keydown', seen)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

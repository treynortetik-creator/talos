// The quiet notice's pane lines are drawn under it, as plain text, only while the app holds them (they are never saved, so a reload shows the
// notice alone). A row without lines is exactly what it was.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageT } from '@talos-app/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearLocalData } from '../../src/features/auth/session.ts'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { useQuietLines } from '../../src/features/threads/quietLines.ts'
import { QUIET_LINES_CAPTION } from '../../src/features/threads/quietLinesWords.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)
beforeEach(() => useQuietLines.getState().clear())

const ID = 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3'
const row = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: ID,
    thread_id: 'general',
    author: 'system',
    kind: 'text',
    text: "Trip has been quiet for 5 minutes and isn't doing anything. Open its terminal to see what's going on.",
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-11-26T15:00:00.000Z',
    ...over,
  }) as MessageT

const mount = (m: MessageT) =>
  render(
    <MemoryRouter>
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={setup({})}>
          <MetaProvider store={createMetaStore()}>
            <MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
          </MetaProvider>
        </ClientProvider>
      </StorageProvider>
    </MemoryRouter>,
  )

describe('the quiet notice with pane lines', () => {
  it('shows the lines the app holds for that message, one per row, under the notice', () => {
    act(() => useQuietLines.getState().set(ID, ['Reading the file', 'Running the tests']))
    mount(row())
    const box = screen.getByTestId('quiet-lines')
    expect([...box.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Reading the file', 'Running the tests'])
  })

  it('a small fixed caption says the lines are from the terminal (so pane text cannot pose as Talos), from the words table; a bug-report screenshot leaves the box out', () => {
    act(() => useQuietLines.getState().set(ID, ['Reading the file']))
    mount(row())
    const box = screen.getByTestId('quiet-lines-box')
    expect(box.getAttribute('data-no-capture')).toBe('')
    expect(box.textContent).toContain(QUIET_LINES_CAPTION)
    expect(QUIET_LINES_CAPTION).toBe('From the terminal')
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'features', 'threads', 'QuietLines.tsx'), 'utf8')
    expect(src).not.toContain('From the terminal')
  })

  it('signing out (or any local wipe) forgets the lines', async () => {
    act(() => useQuietLines.getState().set(ID, ['secret-ish line']))
    await clearLocalData(createMemoryStorage())
    expect(useQuietLines.getState().byMessage).toEqual({})
  })

  it('text is text: markup in a line is shown as it is, never made into elements', () => {
    act(() => useQuietLines.getState().set(ID, ['<img src=x onerror=alert(1)>']))
    const { container } = mount(row())
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('quiet-lines').textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('no lines held (after a reload, an older relay, a Mac without them): the row is the notice alone', () => {
    mount(row())
    expect(screen.queryByTestId('quiet-lines')).toBeNull()
  })

  it('lines held for ANOTHER message are not shown here', () => {
    act(() => useQuietLines.getState().set('m_01JBF3V7Q8K2M4N6P8R0S9Z9Z9', ['elsewhere']))
    mount(row())
    expect(screen.queryByTestId('quiet-lines')).toBeNull()
  })

  it('an owner message never shows lines even if an id matched', () => {
    act(() => useQuietLines.getState().set(ID, ['nope']))
    mount(row({ author: 'owner' }))
    expect(screen.queryByTestId('quiet-lines')).toBeNull()
  })
})

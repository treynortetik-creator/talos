// A message's `actions` on the phone or in a browser (no Mac app shell): the text is shown, and there is NO Open terminal button (there is
// no terminal screen to open). When the remote terminal viewer lands, features/terminal/openTerminal.ts is the one place that changes.
// (Its own file: the Mac shell, once installed, stays installed for the rest of a test file.)
import type { MessageT } from '@talos-app/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { canOpenTerminal } from '../../src/features/terminal/openTerminal.ts'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
import { getShell } from '../../src/lib/native/shell.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

const row = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3',
    thread_id: 'general',
    author: 'system',
    kind: 'text',
    text: "Trip has been quiet for 5 minutes and isn't doing anything. Open its terminal to see what's going on.",
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-11-26T15:00:00.000Z',
    actions: [{ kind: 'open_terminal', thread: 'trip' }],
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

describe('a message with an Open terminal action, where there is no terminal screen', () => {
  it('there is no Mac shell here, so canOpenTerminal is false', () => {
    expect(getShell()).toBeNull()
    expect(canOpenTerminal()).toBe(false)
  })

  it('shows the text and no button', () => {
    mount(row())
    expect(screen.getByText(/has been quiet for 5 minutes/)).toBeTruthy()
    expect(screen.queryByTestId('msg-action-open-terminal')).toBeNull()
    expect(screen.queryByRole('button', { name: /open terminal/i })).toBeNull()
  })

  it('a message with no actions is drawn as it always was', () => {
    mount(row({ actions: undefined, text: 'A plain notice' }))
    expect(screen.getByText('A plain notice')).toBeTruthy()
    expect(screen.queryByTestId('msg-actions')).toBeNull()
  })
})

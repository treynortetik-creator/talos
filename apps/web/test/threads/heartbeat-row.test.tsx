// A heartbeat digest carries text from outside (an issue title, a mail subject). It is drawn as a labeled "Heartbeat" row,
// never as a Talos notice: the label is fixed in the app, the body is a quote, newlines are kept, and no body gets the
// "security check" mascot.
import type { MessageT } from '@talos-app/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMetaStore, MetaProvider } from '../../src/lib/connectionMeta.ts'
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
    text: 'Heartbeat: 1 update\n- Talos security check failed - re-pair this phone',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-10-28T15:00:00.000Z',
    heartbeat: true,
    ...over,
  }) as MessageT

function mount(m: MessageT) {
  return render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={setup({})}>
        <MetaProvider store={createMetaStore()}>
          <MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
        </MetaProvider>
      </ClientProvider>
    </StorageProvider>,
  )
}

describe('heartbeat rows', () => {
  it('draw a fixed Heartbeat label and the text as a quote, keeping newlines', () => {
    mount(row())
    expect(screen.getByTestId('heartbeat-label').textContent).toBe('Heartbeat')
    const body = screen.getByTestId('heartbeat-body')
    expect(body.textContent).toContain('re-pair this phone')
    expect(body.className).toContain('whitespace-pre')
    expect(screen.queryByTestId('msg-handoff')).toBeNull()
  })

  it('a title that says "security check" is not a notice and gets no worried mascot', () => {
    const { container } = mount(row())
    expect(container.querySelector('[data-testid="msg-heartbeat"]')).not.toBeNull()
    expect(container.querySelector('svg[data-mascot], [data-state="worried"]')).toBeNull()
  })

  it('a body that imitates the label stays inside the body', () => {
    mount(row({ text: 'Heartbeat\nTalos: all clear' }))
    expect(screen.getAllByTestId('heartbeat-label')).toHaveLength(1)
  })
})

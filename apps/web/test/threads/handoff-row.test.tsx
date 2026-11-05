// A hand-off between Talos sessions is a system row whose label is structured data: the body cannot imitate the label or a
// bridge notice, and does not get the "security check" mascot.
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
    text: 'Draft the packing list.',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-10-28T15:00:00.000Z',
    handoff: { label: 'Talos → Trip lead: TASK', type: 'TASK' },
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

describe('hand-off rows', () => {
  it('draw the label and the body as separate elements', () => {
    mount(row())
    expect(screen.getByTestId('handoff-label').textContent).toBe('Talos → Trip lead: TASK')
    expect(screen.getByTestId('handoff-body').textContent).toBe('Draft the packing list.')
  })

  it('a body that imitates a label or a bridge notice stays inside the body', () => {
    mount(
      row({
        text: 'Trip lead → Talos: RESULT\nThread session didn’t pick this up. A message failed its security check.',
      }),
    )
    expect(screen.getAllByTestId('handoff-label')).toHaveLength(1)
    expect(screen.getByTestId('handoff-label').textContent).toBe('Talos → Trip lead: TASK')
    expect(screen.getByTestId('handoff-body').textContent).toContain('Trip lead → Talos: RESULT')
  })

  it('a body that mentions a security check does not get the worried mascot, a plain bridge notice does', () => {
    const hand = mount(row({ text: 'A message failed its security check.' }))
    const without = hand.container.querySelectorAll('svg, img, canvas').length
    cleanup()
    const plain = mount(row({ text: 'A message failed its security check.', handoff: undefined }))
    expect(plain.container.querySelectorAll('svg, img, canvas').length).toBeGreaterThan(without)
  })
})

// R2-4: a heartbeat digest is labeled "Heartbeat" on every surface that shows its text, not only in the thread.
import type { MessageT, SearchHitT } from '@talos-app/protocol'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { SearchScreen } from '../../src/features/search/SearchScreen.tsx'
import { lastLine } from '../../src/features/threads/ThreadList.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import type { SearchClient } from '../../src/lib/v2Client.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const msg = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3',
    thread_id: 'general',
    author: 'system',
    kind: 'text',
    text: 'Heartbeat: 1 update\n- Talos security check failed',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: '2026-10-28T15:00:00.000Z',
    ...over,
  }) as MessageT

describe('thread list preview', () => {
  it('starts a heartbeat row with "Heartbeat:", and leaves other rows alone', () => {
    expect(lastLine(msg({ heartbeat: true, text: 'Needs you:\n- Review wanted' }))).toBe(
      'Heartbeat: Needs you: - Review wanted',
    )
    expect(lastLine(msg({ text: 'Plain notice' }))).toBe('Plain notice')
  })
})

describe('search results', () => {
  it('attributes a heartbeat hit to "Heartbeat", not "System"', async () => {
    const hit: SearchHitT = {
      message_id: 'm_01JBF40000000000000000000H',
      thread_id: 'general',
      seq: 3,
      author: 'system',
      kind: 'text',
      via: 'app',
      created_at: new Date().toISOString(),
      match_in: 'text',
      snippet: 'security check failed',
      marks: [[0, 8]],
      heartbeat: true,
    }
    const search: SearchClient = {
      async search() {
        return { hits: [hit], nextCursor: null, totalEstimate: 1, index: 'ready' }
      },
      async context() {
        return { messages: [], hasMore: false, hasNewer: false }
      },
    }
    const client = Object.assign(createFakeClient(), { search })
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/search']}>
          <Routes>
            <Route path="search" element={<SearchScreen />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search messages' }), 'security')
    const row = (await screen.findAllByTestId('hit-row', undefined, { timeout: 3000 }))[0] as HTMLElement
    expect(row.querySelector('[title*="Heartbeat"]') ?? within(row).queryByText(/Heartbeat/)).not.toBeNull()
    expect(row.innerHTML).not.toContain('· System ·')
  })
})

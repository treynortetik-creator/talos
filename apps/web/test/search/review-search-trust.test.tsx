// Adversarial review of WP-V2 (PR #45): shared material (V4.3/V4.7, always external) in search results. The bridge stores a
// token share as author 'owner', via 'share', and indexes share_content into the `text` column (search/columns.ts), so
// the hit comes back as `author:'owner', via:'share', match_in:'text'`. The hit row ignores `via`.
import type { SearchHitT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { searchCached } from '../../src/features/search/logic.ts'
import { SearchScreen } from '../../src/features/search/SearchScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import type { SearchClient } from '../../src/lib/v2Client.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const shareHit: SearchHitT = {
  message_id: 'm_01JBF40000000000000000000S',
  thread_id: 'inbox',
  seq: 7,
  author: 'owner',
  kind: 'text',
  via: 'share',
  created_at: new Date().toISOString(),
  match_in: 'text',
  snippet: 'Approve the wire transfer to account 0042 today',
  marks: [[12, 17]],
}

function mount(hits: SearchHitT[]) {
  const search: SearchClient = {
    async search() {
      return { hits, nextCursor: null, totalEstimate: hits.length, index: 'ready' }
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
}

describe('shared (external) material in search results', () => {
  it('FAILS: a token share is attributed to "You" with the badge "in message"', async () => {
    mount([shareHit])
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Search messages' }), 'transfer')
    const row = (await screen.findAllByTestId('hit-row', undefined, { timeout: 3000 }))[0] as HTMLElement
    // V4.4: "Inbox rows from a token show 'Shared via {label}'"; V4.7: shared material is never owner words
    expect(within(row).queryByText(/· You ·/)).toBeNull()
    expect(within(row).queryByText('in message')).toBeNull()
    expect(row.textContent ?? '').toMatch(/shared/i)
  })

  it('FAILS: offline, "From: You" includes shares (online excludes them: query.ts filterSql)', () => {
    const msgs = {
      inbox: [
        {
          id: 'm_01JBF40000000000000000000S',
          thread_id: 'inbox',
          author: 'owner' as const,
          kind: 'text' as const,
          text: 'wire transfer note',
          format: 'plain' as const,
          attachments: [],
          via: 'share' as const,
          created_at: new Date().toISOString(),
        },
      ],
    }
    const hits = searchCached(
      msgs,
      'transfer',
      { thread_ids: [], from: 'owner', has_file: null, after: null, before: null },
      'newest',
    )
    expect(hits).toEqual([])
  })
})

describe('paging with a time filter', () => {
  it('FAILS: "Show more" with "Past week" recomputes `after`, so the cursor belongs to another search (bridge: bad_query)', async () => {
    const asked: Array<{ after: string | null; cursor: string | null }> = []
    const hit = (n: number): SearchHitT => ({
      ...shareHit,
      via: 'app',
      thread_id: 'general',
      message_id: `m_01JBF4000000000000000000${String(n).padStart(2, '0')}`,
    })
    const search: SearchClient = {
      async search(a) {
        asked.push({ after: a.filters.after, cursor: a.cursor })
        // the bridge's rule (query.ts qhash over the filters): a cursor is only valid for the same filters
        if (a.cursor && a.cursor !== `c:${asked[0]?.after}`)
          throw Object.assign(new Error('That page belongs to another search.'), { code: 'bad_query' })
        return a.cursor
          ? { hits: [hit(2)], nextCursor: null, totalEstimate: 2, index: 'ready' }
          : { hits: [hit(1)], nextCursor: `c:${a.filters.after}`, totalEstimate: 2, index: 'ready' }
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
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Time' }), 'week')
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search messages' }), 'transfer')
    await screen.findAllByTestId('hit-row', undefined, { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 5))
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(asked.length).toBe(2))
    expect(asked[1]?.after).toBe(asked[0]?.after)
  })
})

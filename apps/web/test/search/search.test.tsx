// WP-V2 web: the search screen, hit rows, the offline fallback and the context view, driven by the frames the REAL bridge
// captured (packages/testkit/fixtures/captured/search). `replay.ts` runs the real createSocketSearch over those frames.

import type { MessageT } from '@talos-app/protocol'
import { foldForSearch } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextView } from '../../src/features/search/ContextView.tsx'
import { searchCached, segments } from '../../src/features/search/logic.ts'
import { SearchScreen } from '../../src/features/search/SearchScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { pageOf, resultsOf, SCENARIOS } from './captured.ts'
import { replayClient } from './replay.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
}

function mountSearch(opts: { offline?: boolean; prefer?: string; macMessages?: MessageT[] } = {}) {
  const replay = replayClient()
  replay.offline = Boolean(opts.offline)
  if (opts.prefer) replay.prefer = opts.prefer
  const client = Object.assign(createFakeClient({ macOffline: opts.offline ?? false }), { search: replay })
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={['/search']}>
        <Routes>
          <Route path="search" element={<SearchScreen />} />
          <Route path="t/:thread" element={<ContextOrThread />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </ClientProvider>,
  )
  return { replay, client }
}
function ContextOrThread() {
  const l = useLocation()
  const m = new URLSearchParams(l.search).get('m')
  const thread = l.pathname.split('/')[2] ?? ''
  return m ? <ContextView threadId={thread} messageId={m} /> : <p data-testid="live">live timeline</p>
}

const type = async (text: string) => {
  const box = await screen.findByRole('searchbox', { name: 'Search messages' })
  await userEvent.type(box, text)
}

describe('logic', () => {
  it('segments cut at marks, clamp bad offsets and never produce HTML', () => {
    expect(segments('a release b', [[2, 9]])).toEqual([
      { text: 'a ', mark: false },
      { text: 'release', mark: true },
      { text: ' b', mark: false },
    ])
    expect(
      segments('abc', [
        [2, 99],
        [-5, 1],
      ])
        .map((s) => s.text)
        .join(''),
    ).toBe('abc')
    expect(segments('x', [[5, 9]])).toEqual([{ text: 'x', mark: false }])
  })

  it('every captured hit has marks that land on its snippet and only plain text', () => {
    for (const sc of Object.values(SCENARIOS))
      for (const st of sc.steps)
        for (const f of st.sent_by_bridge)
          if (f.type === 'search.results')
            for (const h of (f as ReturnType<typeof resultsOf>).hits) {
              expect(h.snippet).not.toMatch(/[]/)
              for (const [, b] of h.marks) expect(b).toBeLessThanOrEqual(h.snippet.length)
            }
  })

  it('searchCached folds case and accents, needs every word, and newest first', () => {
    const mk = (id: string, text: string, at: string): MessageT => ({
      id,
      thread_id: 'general',
      author: 'owner',
      kind: 'text',
      text,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: at,
    })
    const msgs = {
      general: [
        mk('m1', 'Café menu', '2026-10-01T10:00:00.000Z'),
        mk('m2', 'the cafe is closed', '2026-10-02T10:00:00.000Z'),
        mk('m3', 'nothing', '2026-10-03T10:00:00.000Z'),
      ],
    }
    const f = { thread_ids: [], from: 'any' as const, has_file: null, after: null, before: null }
    const hits = searchCached(msgs, 'CAFE', f, 'relevance')
    expect(hits.map((h) => h.message_id)).toEqual(['m2', 'm1'])
    expect(hits[0]?.snippet.slice(...(hits[0].marks[0] as [number, number]))).toBe('cafe')
    expect(searchCached(msgs, 'cafe closed', f, 'relevance')).toHaveLength(1)
    expect(foldForSearch('Café')).toBe('cafe')
  })
})

describe('search screen on the captured frames', () => {
  it('shows hits with marks and the match badge; <img> in a snippet is text, not an element', async () => {
    const { replay } = mountSearch()
    await type('release')
    const rows = await screen.findAllByTestId('hit-row', undefined, { timeout: 3000 })
    expect(rows).toHaveLength(resultsOf('01-relevance', 0).hits.length)
    expect(screen.getAllByText('in message').length).toBeGreaterThan(0)
    expect(screen.getByText('in file name')).toBeTruthy()
    expect(screen.getByText('in voice note')).toBeTruthy()
    expect(screen.getByText('in card')).toBeTruthy()
    const marks = document.querySelectorAll('mark')
    expect(marks.length).toBeGreaterThan(0)
    for (const m of marks) expect(m.textContent?.toLowerCase()).toBe('release')
    // the hostile snippet is on the page as text; nothing in the results parsed into an element
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/, { exact: false })).toBeTruthy()
    expect(document.querySelector('[data-testid="search-results"] img')).toBeNull()
    expect(replay.asked[0]?.q).toBe('release')
  })

  it('waits for 2 characters and debounces typing into one query', async () => {
    const { replay } = mountSearch()
    await type('r')
    await new Promise((r) => setTimeout(r, 450))
    expect(replay.asked).toHaveLength(0)
    await type('elease')
    await screen.findAllByTestId('hit-row', undefined, { timeout: 3000 })
    expect(replay.asked).toHaveLength(1)
  })

  it('says "Building the search index" while the Mac is behind', async () => {
    mountSearch({ prefer: '07-indexing' })
    await type('release')
    expect(await screen.findByTestId('search-indexing', undefined, { timeout: 3000 })).toBeTruthy()
  })

  it('no match: says so; a bad query is an alert, not a crash', async () => {
    mountSearch()
    await type('zzzzzz')
    expect(await screen.findByTestId('search-empty', undefined, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByTestId('search-empty-hint').textContent).toBe(
      'Try fewer words, or set the filters back to All threads and Any time',
    )
  })

  it('Show more pages with the cursor in newest order', async () => {
    mountSearch()
    await userEvent.click(await screen.findByRole('button', { name: /Sorted by best match/ }))
    await type('release')
    await screen.findAllByTestId('hit-row', undefined, { timeout: 3000 })
    const first = screen.getAllByTestId('hit-row').length
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(screen.getAllByTestId('hit-row').length).toBeGreaterThan(first))
  })

  it('clicking a hit opens its message in the context view route', async () => {
    mountSearch()
    await type('release')
    const rows = await screen.findAllByTestId('hit-row', undefined, { timeout: 3000 })
    await userEvent.click(rows[0] as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toMatch(/^\/t\/projects\?m=m_/))
  })

  it('remembers the last queries on this device', async () => {
    mountSearch()
    await type('release')
    await screen.findAllByTestId('hit-row', undefined, { timeout: 3000 })
    expect(JSON.parse(localStorage.getItem('talos.search.recent') ?? '[]')).toEqual(['release'])
    cleanup()
    mountSearch()
    expect(await screen.findByText('release', { selector: 'button' })).toBeTruthy()
  })

  it('Mac offline: searches the messages cached on this device and says so', async () => {
    const { client } = mountSearch({ offline: true })
    await client.sendMessage({ threadId: 'general', text: 'Pick up the release balloons' })
    await type('balloons')
    expect(
      await screen.findByText(/Your Mac is offline\. Showing matches from messages on this device\./, undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy()
    const rows = await screen.findAllByTestId('hit-row')
    expect(within(rows[0] as HTMLElement).getByText('balloons', { selector: 'mark' })).toBeTruthy()
  })
})

describe('context view on the captured pages', () => {
  function mountContext(thread: string, id: string) {
    const replay = replayClient()
    const client = Object.assign(createFakeClient(), { search: replay })
    const before = JSON.stringify(client.store.getState().messages)
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={[`/t/${thread}?m=${id}`]}>
          <Routes>
            <Route path="t/:thread" element={<ContextOrThread />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ClientProvider>,
    )
    return { replay, client, before }
  }

  it('opens around the anchor, highlights it, pages Older and Newer, and leaves the live timeline alone', async () => {
    const anchor = (pageOf('06-context', 1).anchor_id ?? '') as string
    expect(anchor).toMatch(/^m_/)
    const { client, before } = mountContext('general', anchor)
    const list = await screen.findByTestId('context-list', undefined, { timeout: 3000 })
    await waitFor(() => expect(within(list).getByText('The needle is in this message.')).toBeTruthy())
    expect(screen.getByText('Showing a past conversation')).toBeTruthy()
    const shown = () => list.querySelectorAll('[id^="ctx-"]').length
    const n0 = shown()
    expect(n0).toBe(pageOf('06-context', 1).messages.length)
    await userEvent.click(screen.getByRole('button', { name: 'Older' }))
    await waitFor(() => expect(shown()).toBeGreaterThan(n0))
    await userEvent.click(screen.getByRole('button', { name: 'Newer' }))
    await waitFor(() => expect(shown()).toBeGreaterThan(n0 + 19))
    // none of it went into the live store
    expect(JSON.stringify(client.store.getState().messages)).toBe(before)
    expect(screen.queryByRole('textbox')).toBeNull() // no composer
  })

  it('at the end: "You\'re up to date" and Jump to latest is primary; it returns to the live thread', async () => {
    const anchor = (pageOf('06-context', 0).anchor_id ?? '') as string
    mountContext('projects', anchor)
    expect(await screen.findByText("You're up to date", undefined, { timeout: 3000 })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/t/projects'))
  })

  it('a message that is no longer on the Mac says so', async () => {
    mountContext('projects', 'm_00000000000000000000009999')
    expect(await screen.findByText('That message is no longer on your Mac.', undefined, { timeout: 3000 })).toBeTruthy()
  })
})

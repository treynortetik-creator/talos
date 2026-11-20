// On /card/:id the sidebar treats the card's thread as the one on screen, as Shell and ThreadBanner do: its row is
// highlighted, and a sub-thread's parent stays open so the row can be seen.
import type { ThreadT } from '@talos-app/protocol'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Sidebar } from '../../src/features/threads/Nav.tsx'
import { makeCard, renderWith, setup } from '../cards/helpers.tsx'

afterEach(cleanup)

const T = (id: string, name: string, over: Partial<ThreadT> = {}): ThreadT => ({
  id,
  name,
  kind: 'agent',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...over,
})

describe('the sidebar on /card/:id', () => {
  it("highlights the card's thread, and keeps a sub-thread's parent open", async () => {
    const card = makeCard({ thread_id: 'visas' })
    const client = setup({ cards: [card] })
    client.store.setState((s) => ({
      ...s,
      threads: [...s.threads, T('trip', 'Trip'), T('visas', 'Visas', { parent_id: 'trip' })],
    }))
    renderWith(<Sidebar />, client, `/card/${card.id}`)
    const row = await screen.findByRole('link', { name: /Visas/ })
    expect(row.className).toContain('bg-chrome-active')
    expect(screen.getByRole('link', { name: /Trip/ }).className).not.toContain('bg-chrome-active')
  })
})

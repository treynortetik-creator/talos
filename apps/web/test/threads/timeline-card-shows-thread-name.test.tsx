// A card in a thread's timeline says where it belongs in its header: "<kind> · <thread name>". A card that has no history
// row of its own yet (every live card until the row is paged in, and every permission card, which never gets one) is drawn
// by Timeline itself, which hands CardView the thread's ID where the name goes. The id is a slug made when the thread was
// created and never changes, so after a rename the card names a thread the owner no longer has.
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { makeCard, renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() // jsdom has none
})

describe('a card in the timeline', () => {
  it('names its thread by the thread name, not the thread id', async () => {
    const card = makeCard({ thread_id: 'general', title: 'Reply to the venue' })
    const client = setup({ cards: [card] })
    // the owner renamed the thread: the id stays `general`
    client.store.setState((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === 'general' ? { ...t, name: 'Money matters' } : t)),
    }))
    renderWith(<ThreadScreen />, client, '/t/general', '/t/:thread')
    const article = await waitFor(() => {
      const el = document.querySelector(`article[data-card-id="${card.id}"]`)
      if (!el) throw new Error('card not drawn yet')
      return el
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Money matters')
    expect(article.textContent).toContain('Email · Money matters')
  })
})

// The Threads list puts a "Needs you" dot on a thread that has a card waiting for the owner. Every other "Needs you" mark
// (the tab badge, the sidebar count, Home, the pill in the thread) goes by one rule, `awaitsOwner`: pending, not past its
// expiry and not altered. The list row only looks at `state === 'pending'`, so a card that ran out of time (no frame says
// so: the state stays 'pending') or one that fails its hash check keeps the dot on the row while nothing anywhere else
// says the owner is needed.
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BottomBar } from '../../src/features/threads/Nav.tsx'
import { ThreadList } from '../../src/features/threads/ThreadList.tsx'
import { makeCard, renderWith, setup } from '../cards/helpers.tsx'

const expired = () => makeCard({ title: 'Expired', thread_id: 'general', expires_at: '2020-01-01T00:00:00.000Z' })
const altered = () => makeCard({ title: 'Altered', thread_id: 'general', payload_hash: `sha256:${'1'.repeat(64)}` })

describe('the "Needs you" dot on a thread row', () => {
  it('shows for a live pending card (the control)', async () => {
    renderWith(<ThreadList />, setup({ cards: [makeCard({ thread_id: 'general' })] }))
    const row = await screen.findByTestId('thread-row-general')
    expect(within(row).queryByRole('img', { name: 'Needs you' })).not.toBeNull()
  })

  it('is not shown for a card that is past its expiry', async () => {
    const client = setup({ cards: [expired()] })
    renderWith(
      <>
        <ThreadList />
        <BottomBar />
      </>,
      client,
    )
    const row = await screen.findByTestId('thread-row-general')
    // the tab badge agrees that nothing needs the owner
    expect(screen.queryByRole('img', { name: /need you/ })).toBeNull()
    expect(within(row).queryByRole('img', { name: 'Needs you' })).toBeNull()
  })

  it('is not shown for a card that fails its hash check', async () => {
    renderWith(<ThreadList />, setup({ cards: [altered()] }))
    const row = await screen.findByTestId('thread-row-general')
    expect(within(row).queryByRole('img', { name: 'Needs you' })).toBeNull()
  })
})

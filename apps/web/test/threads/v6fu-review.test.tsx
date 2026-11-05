// Review of PR #100 (v6 follow-ups), web UI: what the owner SEES when a signed read is refused, and a search hit whose card
// is not in this device's store. Real components on the fake client.
import type { MessageT } from '@talos-app/protocol'
import { newId } from '@talos-app/protocol'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ContextView } from '../../src/features/search/ContextView.tsx'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { TalosClientError } from '../../src/lib/client.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const CLOCK_OFF = "This device's clock is off. Set it to automatic date and time, then try again."

const row = (over: Partial<MessageT> = {}): MessageT => ({
  id: newId('m'),
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text: 'hello',
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: '2026-10-28T15:00:00.000Z',
  ...over,
})

describe('scroll-back says why it failed (finding 5)', () => {
  it('"Load earlier messages" shows the Mac refusal text, and clears it on the next try', async () => {
    const client = setup()
    let n = 0
    client.loadHistory = async () => {
      n += 1
      if (n === 1) throw new TalosClientError('stale', CLOCK_OFF)
      return { hasMore: true }
    }
    renderWith(<ThreadScreen />, client, '/t/general', '/t/:thread')
    // A short thread asks for its history on open (the Timeline's own load), so the first, failing ask is that one; the
    // button press below is the retry.
    expect((await screen.findByTestId('older-error')).textContent).toBe(CLOCK_OFF)
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeTruthy() // still retryable
    await userEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await waitFor(() => expect(screen.queryByTestId('older-error')).toBeNull())
  })
})

describe('the context view Older / Newer buttons say why they failed (finding 5)', () => {
  it('shows the Mac text on a refused page, keeps the buttons, and mac_offline still goes to the offline state', async () => {
    const client = setup()
    const first = row({ id: newId('m'), text: 'anchor' })
    let calls = 0
    const search = {
      context: async () => {
        calls += 1
        if (calls === 1) return { messages: [first], hasMore: true, hasNewer: true }
        throw new TalosClientError('stale', CLOCK_OFF)
      },
    }
    const withSearch = Object.assign(client, { search }) as never
    renderWith(<ContextView threadId="general" messageId={first.id} />, withSearch, '/t/general', '/t/:thread')
    await userEvent.click(await screen.findByRole('button', { name: 'Older' }))
    expect((await screen.findByTestId('context-page-error')).textContent).toBe(CLOCK_OFF)
    expect(screen.getByRole('button', { name: 'Older' })).toBeTruthy()
  })
})

describe('a search hit for a card that is not in the store (finding 12)', () => {
  const cardRow = (over: Partial<MessageT> = {}) =>
    row({ kind: 'card', card_id: `c_${'0'.repeat(26)}`, text: 'Send the invoice\nTo the venue, $240', ...over })

  it('renders the card heading from the history row, with no action buttons', () => {
    const client = setup()
    renderWith(
      <MessageView message={cardRow()} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />,
      client,
    )
    const el = screen.getByTestId('msg-card-past')
    expect(el.textContent).toContain('Send the invoice')
    expect(el.textContent).toContain('To the venue, $240')
    expect(el.querySelectorAll('button')).toHaveLength(0)
  })

  it('a row with no text at all renders nothing rather than an empty box', () => {
    const client = setup()
    const { container } = renderWith(
      <MessageView
        message={cardRow({ text: '' })}
        cards={[]}
        inbox={[]}
        onOpenImage={() => {}}
        onOpenItem={() => {}}
      />,
      client,
    )
    expect(container.querySelector('[data-testid="msg-card-past"]')).toBeNull()
  })
})

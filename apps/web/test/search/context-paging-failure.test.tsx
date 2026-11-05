// D30: a failed Older/Newer press in the search context view says so and keeps its button. Before, a timeout did nothing
// and showed nothing, and an offline answer replaced the whole view's state and removed both buttons.
import type { MessageT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextView } from '../../src/features/search/ContextView.tsx'
import { ClientProvider, TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(cleanup)

const msg = (n: number): MessageT => ({
  id: `m_ctx_${n}`,
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text: `ctx ${n}`,
  format: 'plain',
  attachments: [],
  via: 'app',
  seq: n,
  created_at: new Date(Date.UTC(2026, 9, 1, 12, n)).toISOString(),
})

function mount(second: Error) {
  const context = vi
    .fn()
    .mockResolvedValueOnce({ messages: [msg(2), msg(3), msg(4)], hasMore: true, hasNewer: true })
    .mockRejectedValue(second)
  const client = Object.assign(createFakeClient(), { search: { context } as never })
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={['/t/general?m=m_ctx_3']}>
        <Routes>
          <Route path="t/:thread" element={<ContextView threadId="general" messageId="m_ctx_3" />} />
        </Routes>
      </MemoryRouter>
    </ClientProvider>,
  )
  return context
}

describe('context view paging failures', () => {
  it('a timeout on Older says so, keeps both buttons, and the next press asks again', async () => {
    const context = mount(new TalosClientError('internal', 'timed out'))
    await userEvent.click(await screen.findByRole('button', { name: 'Older' }))
    expect((await screen.findByTestId('context-page-note')).textContent).toBe('Could not load. Try again')
    expect(screen.getByRole('button', { name: 'Older' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Newer' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Older' }))
    await waitFor(() => expect(context).toHaveBeenCalledTimes(3))
  })

  it('an offline answer on Newer says the Mac is offline and keeps the buttons', async () => {
    mount(new TalosClientError('mac_offline', 'offline'))
    await userEvent.click(await screen.findByRole('button', { name: 'Newer' }))
    expect((await screen.findByTestId('context-page-note')).textContent).toMatch(/Mac is offline/)
    expect(screen.getByRole('button', { name: 'Older' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Newer' })).toBeTruthy()
  })
})

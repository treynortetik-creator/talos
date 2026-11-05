// Review finding #9: the offline banner needs a Retry button (an auth close leaves the app "offline" with no way out).
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { Banners } from '../../src/features/threads/Banners.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(cleanup)

it('the offline banner has a Retry button that reconnects', async () => {
  const client = createFakeClient()
  client.store.setState({ connection: 'offline' })
  const reconnect = vi.spyOn(client, 'reconnect')
  render(
    <ClientProvider client={client}>
      <Banners />
    </ClientProvider>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(reconnect).toHaveBeenCalledTimes(1)
})

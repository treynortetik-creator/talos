// Renders the real Settings screen and returns the rows of its section list, in order.
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { SettingsScreen } from '../../src/features/settings/SettingsScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

export async function renderSettingsLinks(): Promise<Array<{ name: string; href: string | null }>> {
  const client = createFakeClient({})
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<SettingsScreen />} />
        </Routes>
      </MemoryRouter>
    </ClientProvider>,
  )
  const nav = await screen.findByRole('navigation', { name: 'Settings sections' })
  const links = [...nav.querySelectorAll('a')].map((a) => ({
    name: (a.textContent ?? '').replace(/Unsaved changes/, '').trim(),
    href: a.getAttribute('href'),
  }))
  cleanup()
  return links
}

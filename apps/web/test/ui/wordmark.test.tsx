// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { Sidebar } from '../../src/features/threads/Nav.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { Wordmark } from '../../src/ui/Wordmark.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

describe('Wordmark', () => {
  it('Talos: one accessible image, T + flipped V + LOS', () => {
    render(<Wordmark name="Talos" />)
    const img = screen.getByRole('img', { name: 'Talos' })
    expect([...img.children].map((c) => c.textContent)).toEqual(['T', 'V', 'LOS'])
    expect(img.children[1]?.classList.contains('wordmark-lambda')).toBe(true)
  })

  it('a custom name is plain text, no image role', () => {
    render(<Wordmark name="Athena" className="x" />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Athena')).toBeTruthy()
  })
})

describe('Sidebar brand', () => {
  it('shows the Talos wordmark', () => {
    render(
      <ClientProvider client={setup()}>
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>
      </ClientProvider>,
    )
    expect(screen.getByRole('img', { name: 'Talos' })).toBeTruthy()
  })
})

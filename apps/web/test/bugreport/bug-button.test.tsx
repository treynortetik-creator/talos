// The Report a bug button on every screen: B by default (a slot in the phone's tab bar, a row in the desktop sidebar's
// footer, and in a thread on a phone the timeline's corner), A (an icon in each header) after `?bugbtn=a`, kept across
// launches until `?bugbtn=b`; exactly one placement shows; a tap opens the reporter; the button is never in the picture.
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn(async () => {})
vi.mock('../../src/features/bugreport/store.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/bugreport/store.ts')>()),
  openBugReport: () => open(),
}))

import { MemoryRouter } from 'react-router'
import {
  BUG_PLACEMENT_KEY,
  BugHeaderButton,
  BugThreadButton,
  bugPlacement,
} from '../../src/features/bugreport/BugButton.tsx'
import { BottomBar } from '../../src/features/threads/Nav.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

const at = (search: string) => window.history.replaceState(null, '', `/${search}`)
const both = () =>
  render(
    <ClientProvider client={createFakeClient()}>
      <MemoryRouter>
        <BugHeaderButton />
        <BottomBar />
        <BugThreadButton />
      </MemoryRouter>
    </ClientProvider>,
  )
const bugs = () => screen.getAllByRole('button', { name: 'Report a bug' })

beforeEach(() => {
  localStorage.removeItem(BUG_PLACEMENT_KEY)
  at('')
  open.mockClear()
})
afterEach(() => cleanup())

describe('Report a bug button', () => {
  it('B by default: a slot in the tab bar (read as "Report a bug") and the thread corner button, no header icon', () => {
    expect(bugPlacement()).toBe('b')
    both()
    expect(bugs()).toHaveLength(2)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('button', { name: 'Report a bug' })).toBeTruthy()
    expect(bugs().some((b) => b.className.includes('fixed'))).toBe(false) // nothing floats over content
  })

  it('?bugbtn=a switches to the header icon only, and it is kept after the address loses it; ?bugbtn=b switches back', () => {
    at('?bugbtn=a')
    expect(bugPlacement()).toBe('a')
    at('')
    both()
    expect(bugs()).toHaveLength(1)
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('button', { name: 'Report a bug' }),
    ).toBeNull()
    cleanup()
    at('?bugbtn=b')
    expect(bugPlacement()).toBe('b')
    at('')
    expect(bugPlacement()).toBe('b')
  })

  it('an unknown value changes nothing', () => {
    at('?bugbtn=zzz')
    expect(bugPlacement()).toBe('b')
    expect(localStorage.getItem(BUG_PLACEMENT_KEY)).toBeNull()
  })

  it('a tap opens the reporter; the button is marked so the picture leaves it out', async () => {
    both()
    for (const x of bugs()) expect(x.hasAttribute('data-no-capture')).toBe(true)
    const b = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Report a bug' })
    await act(async () => userEvent.click(b))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('placement A shows no thread button', () => {
    at('?bugbtn=a')
    render(<BugThreadButton />)
    expect(screen.queryByTestId('bug-button')).toBeNull()
  })

  it('?bugbtn=a still decides this load when storage refuses the write', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      at('?bugbtn=a')
      expect(bugPlacement()).toBe('a')
    } finally {
      set.mockRestore()
    }
  })

  it('storage that throws (a locked-down web view) still shows B', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      expect(bugPlacement()).toBe('b')
    } finally {
      get.mockRestore()
    }
  })
})

// Sharing more than four files to Talos (Android / desktop Chrome share sheet). The service worker's share-target handler
// keeps the first SHARE_LIMITS.files (4) and stops reading; nothing records that there were more, so the /share page
// shows four files and Send sends four, with no word that the others were left out. The page's own rule for the shared
// text is "nothing silently lost" (a trimmed text gets a note).
import { SHARE_LIMITS } from '@talos-app/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShareScreen } from '../../src/features/share/index.tsx'
import { handleShareTarget, memoryPendingStore } from '../../src/features/share/shareTarget.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(cleanup)

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

describe('share target with more files than a share can carry', () => {
  it('tells the owner that some files were left out', async () => {
    const store = memoryPendingStore()
    const form = new FormData()
    const names = ['one.png', 'two.png', 'three.png', 'four.png', 'five.png', 'six.png']
    for (const name of names) form.append('files', new File(['picture'], name, { type: 'image/png' }))
    const req = { formData: async () => form } as unknown as Request
    const res = await handleShareTarget(req, { store, now: () => Date.now() })
    const to = res.headers.get('Location') ?? ''
    expect(to).toMatch(/^\/share\?pending=/)

    render(
      <ClientProvider client={createFakeClient()}>
        <MemoryRouter initialEntries={[to]}>
          <Routes>
            <Route path="/share" element={<ShareScreen store={store} />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    const page = await screen.findByTestId('share-screen')
    const text = page.textContent ?? ''
    // The limit itself is fine; what is asserted is that the owner is told. Four of the six are on the page...
    expect(names.filter((n) => text.includes(n))).toHaveLength(SHARE_LIMITS.files)
    // ...so the page must say that the other two are not part of this share (any wording that names the fact).
    expect(text).toMatch(/left out|not included|were not added|only the first|only 4|only four|too many files/i)
  })
})

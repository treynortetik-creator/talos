// WP-I5: `/open/<ref>`, where a named thread's iPhone notification lands. The real App and its real routes.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function open(url: string, answer: () => Response | Promise<Response>) {
  window.history.pushState({}, '', url)
  const fetchSpy = vi.fn(async () => answer())
  vi.stubGlobal('fetch', fetchSpy)
  const { App } = await import('../../src/App.tsx')
  const { createFakeClient } = await import('../../src/lib/fakeClient.ts')
  const { createMemoryStorage } = await import('../../src/lib/storage.ts')
  render(<App client={createFakeClient()} storage={createMemoryStorage()} />)
  return fetchSpy
}

describe('/open/<ref>', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_FAKE', '1')
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    Element.prototype.scrollIntoView = () => {}
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('asks the relay what the reference means and goes to that thread', async () => {
    const f = await open('/open/r_AAAAAAAAAAAAAAAA', () => Response.json({ thread_id: 'inbox' }))
    await waitFor(() => expect(window.location.pathname).toBe('/t/inbox'))
    expect(String((f.mock.calls as unknown[][])[0]?.[0])).toBe('/api/push/ref/r_AAAAAAAAAAAAAAAA')
  })

  it.each([
    ['unknown reference (404)', () => Response.json({ error: 'not_found' }, { status: 404 })],
    ['a server error', () => new Response('x', { status: 500 })],
    ['a thread id that is not one', () => Response.json({ thread_id: '../../evil' })],
    ['no thread id', () => Response.json({})],
  ])('%s: lands on the start page, never anywhere else', async (_n, answer) => {
    await open('/open/r_AAAAAAAAAAAAAAAA', answer)
    await waitFor(() => expect(window.location.pathname).not.toMatch(/^\/open/))
    expect(window.location.pathname).not.toMatch(/evil|undefined/)
  })
})

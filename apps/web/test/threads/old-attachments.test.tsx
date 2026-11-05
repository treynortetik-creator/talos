// @vitest-environment jsdom
// D4: files and HTML cards past the relay's 7-day buffer ask the Mac (signed media.fetch), wait a bounded time, and say
// truthfully when it does not come back. The relay is a fetch stub that answers 410 until `media.ready`; the client is a
// stub that records `fetchMedia` and lets the test fire frames, so this runs the real components and hooks.
import { type AttachmentRefT, type MessageT, newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentView } from '../../src/features/threads/Attachments.tsx'
import { AUTO_REHYDRATE_MAX_BYTES, fetchTimeoutFor, MEDIA_FETCH_TIMEOUT_MS } from '../../src/features/threads/media.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'

const mk = (kind: AttachmentRefT['kind'], mime: string, name: string, size = 2048): AttachmentRefT => ({
  media_id: newId('md'),
  kind,
  role: 'attachment',
  mime,
  name,
  size,
  sha256: 'a'.repeat(64),
})
const msg = { id: newId('m'), thread_id: 'general' } as unknown as MessageT

type Listener = (f: { media_id: string }) => void
function stubClient() {
  const listeners: Listener[] = []
  const asked: string[] = []
  const client = {
    onFrame: (type: string, l: Listener) => {
      if (type !== 'media.ready') return () => {}
      listeners.push(l)
      return () => void listeners.splice(listeners.indexOf(l), 1)
    },
    fetchMedia: (id: string) => void asked.push(id),
  } as unknown as TalosClient
  return {
    client,
    asked,
    ready: (id: string) => {
      for (const l of listeners.slice()) l({ media_id: id })
    },
  }
}

/** The relay: 410 for everything until `back` holds the id, then 200. Counts probes. */
function stubRelay(missing: 404 | 410 = 410) {
  const back = new Set<string>()
  const probes: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    probes.push(`${init?.method} ${url}`)
    inits.push(init)
    const id = /md_[0-9A-Z]+/.exec(url)?.[0] ?? ''
    return new Response(null, { status: back.has(id) ? 200 : missing })
  })
  vi.stubGlobal('fetch', fetchStub)
  return { back, probes, inits }
}

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function view(att: AttachmentRefT, c: ReturnType<typeof stubClient>) {
  return render(
    <ClientProvider client={c.client}>
      <AttachmentView att={att} message={msg} onOpenImage={() => {}} />
    </ClientProvider>,
  )
}

describe('file chip past the relay buffer', () => {
  it('asks the Mac, shows it is loading, and becomes a real download link on media.ready', async () => {
    const relay = stubRelay()
    const c = stubClient()
    const att = mk('file', 'application/zip', 'report.zip')
    view(att, c)
    await flush()
    expect(c.asked).toEqual([att.media_id])
    expect(screen.getByTestId('media-fetching').textContent).toContain('from your Mac')
    expect(document.querySelector('a[download]')).toBeNull() // no dead link while it is out

    relay.back.add(att.media_id)
    act(() => c.ready(att.media_id))
    await flush()
    const a = document.querySelector('a[download]') as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe(`/media/${att.media_id}?c=2`)
    expect(screen.queryByTestId('media-fetching')).toBeNull()
  })

  it('says it failed when the Mac never answers, and Retry asks again', async () => {
    stubRelay()
    const c = stubClient()
    const att = mk('file', 'text/csv', 'sheet.csv')
    view(att, c)
    await flush()
    expect(screen.getByTestId('media-fetching')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(fetchTimeoutFor(2048) + 1)
    })
    expect(screen.getByTestId('media-failed').textContent).toContain("Couldn't load sheet.csv")
    expect(screen.queryByTestId('media-fetching')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await flush()
    expect(c.asked).toEqual([att.media_id, att.media_id])
    expect(screen.getByTestId('media-fetching')).toBeTruthy()
  })

  it('a file still gone after media.ready is a failure, not a loop of asking', async () => {
    stubRelay() // never adds the id back
    const c = stubClient()
    const att = mk('file', 'text/csv', 'sheet.csv')
    view(att, c)
    await flush()
    act(() => c.ready(att.media_id))
    await flush()
    expect(screen.getByTestId('media-failed')).toBeTruthy()
    expect(c.asked).toHaveLength(1)
  })

  it('a file the relay still has is an ordinary link and the Mac is never asked', async () => {
    const relay = stubRelay()
    const c = stubClient()
    const att = mk('file', 'application/zip', 'fresh.zip')
    relay.back.add(att.media_id)
    view(att, c)
    await flush()
    expect(document.querySelector('a[download]')).not.toBeNull()
    expect(c.asked).toEqual([])
  })

  it('a failed probe (offline) reads as failed, never as a working link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )
    const c = stubClient()
    view(mk('file', 'application/zip', 'x.zip'), c)
    await flush()
    expect(screen.getByTestId('media-failed')).toBeTruthy()
    expect(document.querySelector('a[download]')).toBeNull()
  })
})

describe('HTML card past the relay buffer', () => {
  it('shows no frame while the page is out, then the page once the Mac sent it', async () => {
    const relay = stubRelay()
    const c = stubClient()
    const att = mk('html', 'text/html', 'report.html')
    view(att, c)
    await flush()
    expect(c.asked).toEqual([att.media_id])
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByTestId('media-fetching')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Expand/ }) as HTMLButtonElement).disabled).toBe(true)

    relay.back.add(att.media_id)
    act(() => c.ready(att.media_id))
    await flush()
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(`/media/${att.media_id}/page?c=2`)
  })

  it('times out to a failed state with Retry', async () => {
    stubRelay()
    const c = stubClient()
    view(mk('html', 'text/html', 'report.html'), c)
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(fetchTimeoutFor(2048) + 1)
    })
    expect(screen.getByTestId('media-failed')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })
})

describe('image and audio past the relay buffer', () => {
  it('an image that never comes back is a failed state with Retry, not "Loading" forever', async () => {
    const c = stubClient()
    const att = mk('image', 'image/png', 'photo.png')
    const r = view(att, c)
    fireEvent.error(r.container.querySelector('img') as HTMLImageElement)
    expect(c.asked).toEqual([att.media_id])
    expect(screen.getByTestId('media-fetching')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(fetchTimeoutFor(2048) + 1)
    })
    expect(screen.getByTestId('media-failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    // Retry goes back to the relay first: the picture is mounted again and the Mac is asked only if it fails to load
    expect(c.asked).toHaveLength(1)
    fireEvent.error(r.container.querySelector('img') as HTMLImageElement)
    expect(c.asked).toHaveLength(2)
  })

  it('Retry on an image the relay still holds reloads it from the relay (a new URL), without asking the Mac', async () => {
    const c = stubClient()
    const att = mk('image', 'image/png', 'photo.png')
    const r = view(att, c)
    const first = (r.container.querySelector('img') as HTMLImageElement).getAttribute('src')
    fireEvent.error(r.container.querySelector('img') as HTMLImageElement) // a network blip
    await act(async () => {
      await vi.advanceTimersByTimeAsync(fetchTimeoutFor(2048) + 1)
    })
    expect(screen.getByTestId('media-failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const img = r.container.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).not.toBe(first)
    expect(img.getAttribute('src')).toMatch(/^\/media\/md_[0-9A-Z]+\?c=2&r=\d+$/)
    expect(c.asked).toHaveLength(1) // only the first load error asked
  })

  it('an audio clip that never comes back says so', async () => {
    const c = stubClient()
    const att = mk('audio', 'audio/mp4', 'reply.m4a')
    const r = view(att, c)
    fireEvent.error(r.container.querySelector('audio') as HTMLAudioElement)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(fetchTimeoutFor(2048) + 1)
    })
    expect(screen.getByTestId('media-failed').textContent).toContain("Couldn't load reply.m4a")
  })
})

describe('the probe', () => {
  it('goes to a cache-busted URL with cache: no-store, so a 410 an old browser cached cannot answer it', async () => {
    const relay = stubRelay()
    const c = stubClient()
    const att = mk('file', 'application/zip', 'a.zip')
    view(att, c)
    await flush()
    expect(relay.probes[0]).toBe(`HEAD /media/${att.media_id}?c=2`)
    expect(relay.inits[0]?.cache).toBe('no-store')
  })

  it('a chip shows no download link while the probe is still out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    ) // never answers
    const c = stubClient()
    view(mk('file', 'application/zip', 'slow.zip'), c)
    await flush()
    expect(document.querySelector('a[download]')).toBeNull()
    expect(screen.getByTestId('file-chip-checking').textContent).toContain('slow.zip')
  })

  it('a 404 (the relay dropped the row, history outlived it) asks the Mac like a 410', async () => {
    const relay = stubRelay(404)
    const c = stubClient()
    const att = mk('file', 'application/zip', 'old.zip')
    view(att, c)
    await flush()
    expect(c.asked).toEqual([att.media_id])
    relay.back.add(att.media_id)
    act(() => c.ready(att.media_id))
    await flush()
    expect(document.querySelector('a[download]')).not.toBeNull()
  })

  it('an HTML card asks on a 404 too', async () => {
    stubRelay(404)
    const c = stubClient()
    const att = mk('html', 'text/html', 'p.html')
    view(att, c)
    await flush()
    expect(c.asked).toEqual([att.media_id])
  })
})

describe('big files wait for a tap; the timeout grows with the size', () => {
  it('a file over the auto limit is not asked for on render; "Load from your Mac" asks', async () => {
    stubRelay()
    const c = stubClient()
    const att = mk('file', 'application/zip', 'huge.zip', AUTO_REHYDRATE_MAX_BYTES + 1)
    view(att, c)
    await flush()
    expect(c.asked).toEqual([])
    expect(screen.getByTestId('media-gone').textContent).toContain('huge.zip is only on your Mac')
    fireEvent.click(screen.getByRole('button', { name: 'Load from your Mac' }))
    await flush()
    expect(c.asked).toEqual([att.media_id])
    expect(screen.getByTestId('media-fetching')).toBeTruthy()
  })

  it('ten old zips on screen ask for nothing until tapped', async () => {
    stubRelay()
    const c = stubClient()
    for (let i = 0; i < 10; i++) view(mk('file', 'application/zip', `z${i}.zip`, 50 * 1024 * 1024), c)
    await flush()
    expect(c.asked).toEqual([])
  })

  it('a 50 MB file is not called gone at 20 s: the client waits as long as the bridge may take', async () => {
    stubRelay()
    const c = stubClient()
    const size = 50 * 1024 * 1024
    const att = mk('file', 'application/zip', 'big.zip', size)
    view(att, c)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Load from your Mac' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEDIA_FETCH_TIMEOUT_MS + 1)
    })
    expect(screen.getByTestId('media-fetching')).toBeTruthy()
    expect(screen.queryByTestId('media-failed')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(fetchTimeoutFor(size))
    })
    expect(screen.getByTestId('media-failed')).toBeTruthy()
  })

  it('a media.ready that arrives after the failed state re-probes and recovers', async () => {
    const relay = stubRelay()
    const c = stubClient()
    const att = mk('file', 'text/csv', 'late.csv')
    view(att, c)
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(fetchTimeoutFor(2048) + 1)
    })
    expect(screen.getByTestId('media-failed')).toBeTruthy()
    relay.back.add(att.media_id)
    act(() => c.ready(att.media_id)) // the Mac was just slow
    await flush()
    expect(screen.queryByTestId('media-failed')).toBeNull()
    expect(document.querySelector('a[download]')).not.toBeNull()
  })
})

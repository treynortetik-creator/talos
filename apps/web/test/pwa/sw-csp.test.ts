// @vitest-environment node
// The service worker answers navigations from the precache, so the page's CSP must be set by the worker itself.
// This loads the real src/sw.ts with the REAL workbox precaching (install, activate, route, plugins) against a fake worker
// scope with an in-memory cache, and checks the header on what the worker actually answers, against the relay's appCsp.
import { appCsp } from '@talos-app/protocol'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'https://talos.example.com'
type Listener = (e: unknown) => void
const listeners = new Map<string, Listener[]>()
const store = new Map<string, Response>()
// 'address' = what a response read back from the real cache reports; '' mimics a shell stored after a redirect.
let address: 'real' | 'empty' = 'real'
let offline = false

const fakeCache = {
  put: async (req: Request | string, res: Response) => {
    store.set(typeof req === 'string' ? req : req.url, res.clone())
  },
  match: async (req: Request | string) => {
    const hit = store.get(typeof req === 'string' ? req : req.url)
    if (!hit) return undefined
    const out = hit.clone()
    return address === 'real'
      ? Object.defineProperty(out, 'url', { value: typeof req === 'string' ? req : req.url })
      : out
  },
  delete: async () => true,
  keys: async () => [],
}

// workbox checks `instanceof FetchEvent`; a worker scope has the class, node does not.
class FakeExtendableEvent {}
class FakeFetchEvent extends FakeExtendableEvent {}

async function dispatch(type: string, event: Record<string, unknown>) {
  const waits: Promise<unknown>[] = []
  for (const fn of listeners.get(type) ?? [])
    fn(Object.assign(new FakeExtendableEvent(), { type }, event, { waitUntil: (p: Promise<unknown>) => waits.push(p) }))
  // waitUntil promises can add more (workbox queues its cache writes from inside); settle until none are new.
  for (let seen = 0; seen < waits.length; ) {
    seen = waits.length
    await Promise.all(waits)
  }
}

async function navigate(path: string): Promise<Response> {
  let answer: Promise<Response> | undefined
  const request = Object.assign(new Request(`${ORIGIN}${path}`), {})
  Object.defineProperty(request, 'mode', { value: 'navigate' })
  for (const fn of listeners.get('fetch') ?? []) {
    fn(
      Object.assign(new FakeFetchEvent(), {
        request,
        respondWith: (p: Promise<Response>) => {
          answer ??= p
        },
        waitUntil: () => {},
      }),
    )
    if (answer) break
  }
  if (!answer) throw new Error('the worker did not answer the navigation')
  return answer
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('PROD', true)
  vi.stubGlobal('FetchEvent', FakeFetchEvent)
  vi.stubGlobal('ExtendableEvent', FakeExtendableEvent)
  const staleShell = () =>
    new Response('<html></html>', {
      headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" },
    })
  vi.stubGlobal('caches', {
    open: async () => fakeCache,
    match: (req: Request) => fakeCache.match(req),
    has: async () => true,
    keys: async () => [],
    delete: async () => true,
  })
  vi.stubGlobal('fetch', async (input: Request | string) => {
    if (offline) throw new TypeError('offline')
    const u = typeof input === 'string' ? input : input.url
    if (u.endsWith('/app.js')) return new Response('//js', { headers: { 'content-type': 'text/javascript' } })
    return staleShell()
  })
  Object.assign(globalThis, {
    __WB_MANIFEST: [
      { url: 'index.html', revision: 'r1' },
      { url: 'assets/app.js', revision: null },
    ],
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { scope: `${ORIGIN}/` },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (t: string, fn: Listener) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
  })
  Object.assign(globalThis, { self: globalThis })
  await import('../../src/sw.ts')
  await dispatch('install', {})
  await dispatch('activate', {})
})

describe('service worker shell response (real workbox precaching)', () => {
  it.each(['/', '/index.html', '/?utm_source=x', '/threads'])(
    '%s is answered with the relay CSP, replacing the stale install-time one',
    async (path) => {
      const res = await navigate(path)
      expect(res.headers.get('content-security-policy')).toBe(appCsp(ORIGIN))
      expect(await res.text()).toBe('<html></html>')
      expect(res.headers.get('content-type')).toBe('text/html')
      expect(res.status).toBe(200)
    },
  )

  it('stamps the shell even when the cache reports an empty address (stored after a redirect), with no network', async () => {
    address = 'empty'
    offline = true
    try {
      for (const path of ['/', '/threads']) {
        const res = await navigate(path)
        expect(res.headers.get('content-security-policy')).toBe(appCsp(ORIGIN))
        expect(await res.text()).toBe('<html></html>')
      }
    } finally {
      address = 'real'
      offline = false
    }
  })

  it('leaves precached non-HTML assets alone', async () => {
    let answer: Promise<Response> | undefined
    for (const fn of listeners.get('fetch') ?? [])
      fn(
        Object.assign(new FakeFetchEvent(), {
          request: new Request(`${ORIGIN}/assets/app.js`),
          respondWith: (p: Promise<Response>) => {
            answer ??= p
          },
          waitUntil: () => {},
        }),
      )
    const res = await answer
    expect(await res?.text()).toBe('//js')
    expect(res?.headers.get('content-security-policy')).toBeNull()
  })

  it('does not touch API paths', async () => {
    await expect(navigate('/api/threads')).rejects.toThrow('did not answer')
  })
})

describe('development', () => {
  it('does not stamp outside a production build (the dev refresh preamble is inline script)', async () => {
    vi.resetModules()
    listeners.clear()
    vi.stubEnv('PROD', false)
    await import('../../src/sw.ts')
    await dispatch('install', {})
    await dispatch('activate', {})
    const res = await navigate('/threads')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'")
    const root = await navigate('/')
    expect(root.headers.get('content-security-policy')).toBe("default-src 'self'")
  })
})

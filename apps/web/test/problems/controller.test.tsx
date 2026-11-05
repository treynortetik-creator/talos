// @vitest-environment jsdom
import type { ProblemT } from '@talos-app/protocol'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { CaptureEnv } from '../../src/features/problems/capture.ts'
import { installProblems, ProblemController, uninstallProblems } from '../../src/features/problems/controller.ts'
import type { PostResult } from '../../src/features/problems/queue.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { AppErrorBoundary, RowErrorBoundary } from '../../src/ui/ErrorBoundary.tsx'

const ORIGIN = 'https://app.example.com'
const OWN = `    at render (${ORIGIN}/assets/index-abc123.js:10:20)`
const env = (): CaptureEnv => ({
  origin: ORIGIN,
  versions: { app: '1.2.3' },
  device: 'browser',
  routes: ['home'],
  now: () => Date.parse('2026-11-02T10:00:00.000Z'),
})
const boom = (message = 'x is not a function') => {
  const e = new Error(message)
  e.stack = `Error: ${message}\n${OWN}`
  return e
}

function setup(over: { post?: (p: ProblemT) => Promise<PostResult> } = {}) {
  const posted: ProblemT[] = []
  const storage = createMemoryStorage()
  const store = createStore(() => ({ connection: 'offline' as string }))
  const target = new EventTarget()
  const ctl = new ProblemController({
    storage,
    client: { store, uploadMedia: async () => Promise.reject(new Error('no media')) } as never,
    env,
    target: target as never,
    post:
      over.post ??
      (async (p) => {
        posted.push(p)
        return { ok: true }
      }),
  })
  ctl.start()
  return { ctl, posted, storage, store, target }
}
const tick = () => new Promise((r) => setTimeout(r, 10))
const fire = (t: EventTarget, type: string, init: Record<string, unknown>) => {
  const ev = new Event(type)
  Object.assign(ev, init)
  t.dispatchEvent(ev)
}

function Boom(): never {
  throw boom('render failed')
}

function Stale(): never {
  throw new Error('Failed to fetch dynamically imported module: /assets/x.js')
}

afterEach(() => uninstallProblems())

describe('global handlers', () => {
  it('an uncaught error becomes one report; the same error 100 times is still one', async () => {
    const { ctl, posted, target } = setup()
    for (let i = 0; i < 100; i++) fire(target, 'error', { error: boom(), message: 'x' })
    await tick()
    expect(posted).toHaveLength(1)
    expect((await ctl.status()).held).toBe(99)
    ctl.stop()
  })

  it('an unhandled rejection is reported by what it rejected with', async () => {
    const { ctl, posted, target } = setup()
    fire(target, 'unhandledrejection', { reason: boom('rejected') })
    await tick()
    expect(posted).toHaveLength(1)
    expect(posted[0]?.message).toBe('rejected')
    ctl.stop()
  })

  it('skips an abort, a chunk error and a script error from elsewhere', async () => {
    const { ctl, posted, target } = setup()
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    fire(target, 'unhandledrejection', { reason: abort })
    fire(target, 'error', { error: new Error('Failed to fetch dynamically imported module: /a.js'), message: 'x' })
    fire(target, 'error', { error: undefined, message: 'Script error.' })
    await tick()
    expect(posted).toHaveLength(0)
    expect(await ctl.queue.size()).toBe(0)
    ctl.stop()
  })

  it('offline: kept in the queue; the connection coming up sends it; the browser saying "online" does too', async () => {
    let up = false
    const posted: ProblemT[] = []
    const { ctl, store, target } = setup({
      post: async (p) => {
        if (!up) return { ok: false, network: true }
        posted.push(p)
        return { ok: true }
      },
    })
    fire(target, 'error', { error: boom('first'), message: 'x' })
    await tick()
    expect(await ctl.queue.size()).toBe(1)
    up = true
    store.setState({ connection: 'online' })
    await tick()
    expect(posted).toHaveLength(1)
    expect(await ctl.queue.size()).toBe(0)
    up = false
    fire(target, 'error', { error: boom('second one'), message: 'x' })
    await tick()
    expect(await ctl.queue.size()).toBe(1)
    up = true
    target.dispatchEvent(new Event('online'))
    await tick()
    expect(posted).toHaveLength(2)
    ctl.stop()
  })

  it('stop() removes the handlers: nothing is reported after it', async () => {
    const { ctl, posted, target } = setup()
    ctl.stop()
    fire(target, 'error', { error: boom(), message: 'x' })
    await tick()
    expect(posted).toHaveLength(0)
  })

  it('a reporter that itself fails stays quiet: no throw, no console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctl, target } = setup({
      post: async () => {
        throw new Error('post exploded')
      },
    })
    expect(() => fire(target, 'error', { error: boom(), message: 'x' })).not.toThrow()
    await tick()
    expect(spy).not.toHaveBeenCalled()
    ctl.stop()
    spy.mockRestore()
  })

  it('does not report while it is already reporting (a handler that triggers an error cannot loop)', () => {
    const { ctl } = setup()
    const submit = vi.spyOn(ctl, 'submit')
    ;(ctl as unknown as { reporting: boolean }).reporting = true
    ctl.report(boom())
    expect(submit).not.toHaveBeenCalled()
    ctl.stop()
  })
})

describe('error boundaries', () => {
  it('a crashed screen and a broken row are each reported once, with the render error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const posted: ProblemT[] = []
    installProblems({
      storage: createMemoryStorage(),
      client: {
        store: createStore(() => ({ connection: 'offline' })),
        uploadMedia: async () => Promise.reject(new Error('x')),
      } as never,
      env,
      target: new EventTarget() as never,
      post: async (p) => {
        posted.push(p)
        return { ok: true }
      },
    })
    render(
      <RowErrorBoundary>
        <Boom />
      </RowErrorBoundary>,
    )
    await tick()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ name: 'Error', message: 'render failed', kind: 'auto' })
  })

  it('a stale-chunk failure is not reported', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const posted: ProblemT[] = []
    installProblems({
      storage: createMemoryStorage(),
      client: {
        store: createStore(() => ({ connection: 'offline' })),
        uploadMedia: async () => Promise.reject(new Error('x')),
      } as never,
      env,
      target: new EventTarget() as never,
      post: async (p) => {
        posted.push(p)
        return { ok: true }
      },
    })
    render(
      <AppErrorBoundary>
        <Stale />
      </AppErrorBoundary>,
    )
    await tick()
    expect(posted).toHaveLength(0)
  })
})

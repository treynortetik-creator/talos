// scripts/mic-preflight.mjs: it answers ok or stuck within its limit and never hangs, whatever the browser does.
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs next to the shell scripts, no types
import { preflight } from './mic-preflight.mjs'

type Fake = { closed: boolean }
/** A browser whose getUserMedia call is `gum`; close() is `close`. */
function browser(
  gum: () => Promise<void>,
  close: () => Promise<void> = async () => {},
  state: Fake = { closed: false },
) {
  return {
    state,
    launch: async () => ({
      newContext: async () => ({
        newPage: async () => ({
          route: async () => {},
          goto: async () => {},
          evaluate: gum,
        }),
      }),
      close: async () => {
        state.closed = true
        await close()
      },
    }),
  }
}
const never = () => new Promise<void>(() => {})

describe('mic-preflight', () => {
  it('ok when getUserMedia answers, and the browser is closed', async () => {
    const b = browser(async () => {})
    expect(await preflight({ launch: b.launch, timeoutMs: 1000 })).toEqual({ status: 'ok' })
    expect(b.state.closed).toBe(true)
  })

  it('stuck when getUserMedia never answers: returns at the limit, browser closed', async () => {
    const b = browser(never)
    const t = Date.now()
    expect(await preflight({ launch: b.launch, timeoutMs: 200 })).toEqual({ status: 'stuck' })
    expect(Date.now() - t).toBeLessThan(2000)
    expect(b.state.closed).toBe(true)
  })

  it('stuck even when close() hangs too: still returns', async () => {
    const b = browser(never, never)
    const t = Date.now()
    expect(await preflight({ launch: b.launch, timeoutMs: 100 })).toEqual({ status: 'stuck' })
    expect(Date.now() - t).toBeLessThan(6000)
  })

  it('error, not stuck and not ok, when the browser never starts', async () => {
    const r = await preflight({ launch: never, timeoutMs: 100, launchMs: 100 })
    expect(r.status).toBe('error')
  })

  it('a slow start is not a stuck microphone: only getUserMedia has the short limit', async () => {
    const b = browser(async () => {})
    const slow = () => new Promise((r) => setTimeout(() => r(b.launch()), 300))
    expect(await preflight({ launch: slow, timeoutMs: 100, launchMs: 2000 })).toEqual({ status: 'ok' })
  })

  it('error when getUserMedia is refused', async () => {
    const b = browser(async () => {
      throw new Error('NotAllowedError')
    })
    const r = await preflight({ launch: b.launch, timeoutMs: 1000 })
    expect(r).toEqual({ status: 'error', detail: expect.stringContaining('NotAllowedError') })
    expect(b.state.closed).toBe(true)
  })
})

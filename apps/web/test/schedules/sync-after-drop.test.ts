// The Schedules list after the Mac drops mid-request (features/schedules/sync.ts). A `schedules.list` in flight when the bridge
// went away is never answered, only timed out; it used to stay the shared in-flight request, so every refresh after the Mac
// came back waited on it, and its late failure then marked a fresh list as an error.
import { describe, expect, it, vi } from 'vitest'
import { abandonRefresh, refreshSchedules } from '../../src/features/schedules/sync.ts'
import { TalosClientError } from '../../src/lib/client.ts'
import { setup } from '../cards/helpers.tsx'

/** A list call that waits until the test settles it. */
function pending() {
  let settle!: (err?: Error) => void
  const p = new Promise<void>((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve())
  })
  return { p, settle }
}

describe('refreshSchedules after the Mac drops', () => {
  it('a refresh when the Mac is back starts a new request at once, not the dead one', async () => {
    const client = setup()
    const first = pending()
    const second = pending()
    const calls = vi.fn().mockReturnValueOnce(first.p).mockReturnValueOnce(second.p)
    client.schedules.listSchedules = calls as never
    void refreshSchedules(client)
    void refreshSchedules(client) // shared while it runs
    expect(calls).toHaveBeenCalledTimes(1)
    abandonRefresh(client) // the Mac went away
    const again = refreshSchedules(client) // the Mac is back
    expect(calls).toHaveBeenCalledTimes(2)
    second.settle()
    await again
  })

  it("the abandoned request's late failure does not mark the list an error", async () => {
    const client = setup()
    const first = pending()
    const second = pending()
    client.schedules.listSchedules = vi.fn().mockReturnValueOnce(first.p).mockReturnValueOnce(second.p) as never
    const old = refreshSchedules(client)
    abandonRefresh(client)
    const fresh = refreshSchedules(client)
    second.settle()
    await fresh
    const before = client.store.getState().schedules.status
    first.settle(new TalosClientError('internal', 'no_answer')) // the dead request times out at last
    await old
    expect(client.store.getState().schedules.status).toBe(before)
    expect(client.store.getState().schedules.status).not.toBe('error')
  })

  it('a request that fails while it is still the one on record still says so', async () => {
    const client = setup()
    const only = pending()
    client.schedules.listSchedules = vi.fn().mockReturnValueOnce(only.p) as never
    const r = refreshSchedules(client)
    only.settle(new TalosClientError('internal', 'no_answer'))
    await r
    expect(client.store.getState().schedules).toMatchObject({ status: 'error', error: 'no_answer' })
  })

  it('the request let go when the Mac drops (it rejects at once) does not mark the list an error', async () => {
    const client = setup()
    client.store.setState((st) => ({ ...st, schedules: { ...st.schedules, status: 'loading', error: null } }))
    client.schedules.listSchedules = vi.fn(
      ({ signal }: { signal?: AbortSignal } = {}) =>
        new Promise<never>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new TalosClientError('internal', 'abandoned'))),
        ),
    ) as never
    const r = refreshSchedules(client)
    abandonRefresh(client)
    await r
    expect(client.store.getState().schedules.status).not.toBe('error')
  })
})

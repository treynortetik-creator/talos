// The shared waitFor: a condition that throws is "not yet", never an early failure, and a wait that runs out keeps the last
// error's own message.
import { describe, expect, it } from 'vitest'
import { waitFor } from '../src/index.ts'

describe('waitFor', () => {
  it('asks a condition that throws again, and resolves once it holds (a log read before the fake wrote it)', async () => {
    let tries = 0
    await waitFor(() => {
      tries++
      if (tries < 4) throw new Error('ENOENT: no such file')
      return true
    }, 2000)
    expect(tries).toBe(4)
  })

  it('rejects with the last error when time runs out, so an assertion keeps its message', async () => {
    const err = new Error('expected 2 frames, got 1')
    await expect(
      waitFor(() => {
        throw err
      }, 20),
    ).rejects.toBe(err)
  })

  it('names what it waited for when the condition only ever answered false', async () => {
    await expect(waitFor(() => false, 20, 'the pong')).rejects.toThrow('timed out waiting for the pong')
  })

  it('a condition that threw earlier and now answers false times out with the plain message, not the old error', async () => {
    let tries = 0
    await expect(
      waitFor(
        () => {
          tries++
          if (tries === 1) throw new Error('early')
          return false
        },
        20,
        'the row',
      ),
    ).rejects.toThrow('timed out waiting for the row')
  })
})

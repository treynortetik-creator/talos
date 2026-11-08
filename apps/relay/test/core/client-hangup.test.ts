// A client that hangs up mid-request is not a relay fault: it must not be filed as a problem for the owner's Mac
// (a real "Error: aborted" was). Real faults, including look-alikes, still are.
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayProblemRecorder } from '../../src/core/problems.ts'
import { buildApp } from '../../src/routes.ts'
import { startTestRelay, type TestRelay } from './harness.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await relay?.stop()
  relay = null
})

/** Starts an upload with a body it never finishes, then drops the connection (node's `Error: aborted`, code ECONNRESET). */
async function hangUpMidUpload(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(
        'POST /api/media HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Test-Session: none\r\nOrigin: https://relay.example.com\r\n' +
          'X-Talos-CSRF: 1\r\nContent-Type: text/plain\r\nContent-Length: 100000\r\n\r\nabc',
      )
      setTimeout(() => {
        s.destroy()
        resolve()
      }, 100)
    })
    s.on('error', reject)
  })
}

const HANGUP_LINE = 'client hung up mid-request'

/** The relay's real catch-all, with one extra route that throws what the test hands it. */
async function appThrowing(err: unknown) {
  relay = await startTestRelay()
  const services = relay.relay.services
  const app = buildApp(services)
  app.get('/__boom', () => {
    throw err
  })
  const record = vi.spyOn(RelayProblemRecorder.prototype, 'record').mockReturnValue(true)
  const debug = vi.spyOn(services.log, 'debug')
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  const res = await app.request('/__boom')
  return { res, record, debug, stderr }
}

describe('a client that hangs up', () => {
  it('mid-upload (a real socket) files no problem and is logged at debug', async () => {
    relay = await startTestRelay()
    const record = vi.spyOn(RelayProblemRecorder.prototype, 'record')
    const debug = vi.spyOn(relay.relay.services.log, 'debug')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    await hangUpMidUpload(relay.relay.port)
    await vi.waitFor(() => expect(debug).toHaveBeenCalledWith(expect.anything(), HANGUP_LINE))
    expect(record).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
  })

  it('an Error "aborted" with code ECONNRESET (node\'s own shape) files no problem', async () => {
    const hangup = Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
    const { res, record, debug } = await appThrowing(hangup)
    expect(res.status).toBe(500)
    expect(record).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(expect.anything(), HANGUP_LINE)
  })
})

describe('a real fault is still filed', () => {
  it('a plain Error from a handler: one problem, logged, plain 500', async () => {
    const { res, record, debug, stderr } = await appThrowing(new Error('disk exploded'))
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Internal Server Error')
    expect(record).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })

  it('a longer message that merely contains "aborted" is filed', async () => {
    const { record } = await appThrowing(new Error('upstream transcription aborted after 3 retries'))
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('an AbortError from our own timeout (our own abort, not the client) is filed', async () => {
    const own = new DOMException('This operation was aborted', 'AbortError')
    const { record } = await appThrowing(own)
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('an outbound reset (`read ECONNRESET`, same code, other message) is filed', async () => {
    const { res, record, debug } = await appThrowing(
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    )
    expect(res.status).toBe(500)
    expect(record).toHaveBeenCalledTimes(1)
    expect(debug).not.toHaveBeenCalled()
  })

  it('an Error "aborted" with no code is filed', async () => {
    const { record } = await appThrowing(new Error('aborted'))
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('a different socket code is filed', async () => {
    const { record } = await appThrowing(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))
    expect(record).toHaveBeenCalledTimes(1)
  })
})

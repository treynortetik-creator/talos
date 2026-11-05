// media.failed leftover from D4: a signed media.fetch the Mac cannot serve ("not on this Mac", or the upload throws) used to
// be only a log line, so the app waited out its timeout (20 s + 2 s per MB). Now the Mac answers error{ref} for that frame id
// at once, with an existing ErrorCode. Real Bridge + FakeRelay + FakeApp, as in production; a served fetch stays silent.
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCode, newId } from '@talos-app/protocol'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'
import { longTimeouts } from './schedules/harness.ts'

longTimeouts()

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const errsFor = (x: Harness, id: string) =>
  x.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'error' && r.raw.ref === id)

async function evictedMedia(x: Harness) {
  const p = join(x.home, 'media', 'old.txt')
  writeFileSync(p, 'FILE-BYTES')
  await x.bridge.callTool('attach', { thread_id: 'general', path: p })
  const f = await x.relay.expectFrame('reply', (r) => r.message.kind === 'file', { direction: 'from_bridge' })
  const id = f.message.attachments[0]?.media_id as string
  x.relay.media.delete(id)
  return id
}

describe('a media.fetch the Mac cannot serve says so', () => {
  test('a file that is not on this Mac gets an error{ref} for that frame, and uploads nothing', async () => {
    h = await startHarness()
    const req = await h.app.buildMediaFetch(newId('md')) // a well-formed id the Mac never stored
    h.relay.sendToBridge(req, { durable: false })
    await waitFor(() => errsFor(h as Harness, req.id).length === 1, 3000, 'the refusal')
    const e = errsFor(h, req.id)[0]?.raw as { code: string; message: string }
    expect(ErrorCode.safeParse(e.code).success).toBe(true)
    expect(e.message).toMatch(/no longer on your Mac/)
    await sleep(200)
    expect(errsFor(h, req.id)).toHaveLength(1)
  })

  test('an upload that throws gets an error{ref} too', async () => {
    h = await startHarness()
    const id = await evictedMedia(h)
    ;(h.bridge.ctx.media as unknown as { rehydrate: () => Promise<boolean> }).rehydrate = async () => {
      throw new Error('relay said 503')
    }
    const req = await h.app.buildMediaFetch(id)
    h.relay.sendToBridge(req, { durable: false })
    await waitFor(() => errsFor(h as Harness, req.id).length === 1, 3000, 'the refusal')
    const e = errsFor(h, req.id)[0]?.raw as { code: string; message: string }
    expect(ErrorCode.safeParse(e.code).success).toBe(true)
    expect(e.message).toMatch(/could not send that file/)
    expect(e.message).not.toMatch(/503/) // no detail from the relay's reply goes to the app
  })

  test('a file the Mac has is uploaded and nothing is refused', async () => {
    h = await startHarness()
    const id = await evictedMedia(h)
    const req = await h.app.buildMediaFetch(id)
    h.relay.sendToBridge(req, { durable: false })
    await waitFor(() => (h as Harness).relay.media.has(id), 3000, 're-upload')
    await sleep(200)
    expect(errsFor(h, req.id)).toHaveLength(0)
  })
})

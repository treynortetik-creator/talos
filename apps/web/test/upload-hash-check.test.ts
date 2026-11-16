// @vitest-environment node
// The relay's answer to an upload carries the hash and size that get signed into the attachment. A relay that answers
// with another file's hash or size must be refused, or it could swap the file under a valid signature.
import { describe, expect, it } from 'vitest'
import { createSocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

const BODY = 'hello world'
const REAL_SHA = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' // sha256 of "hello world"
const OTHER_SHA = 'a'.repeat(64)

function ref(over: Record<string, unknown>) {
  return {
    media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T426',
    kind: 'file',
    role: 'attachment',
    mime: 'text/plain',
    name: 'a.txt',
    size: BODY.length,
    sha256: REAL_SHA,
    ...over,
  }
}
function upload(over: Record<string, unknown>) {
  const client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://127.0.0.1:9/ws',
    isOnline: () => false,
    fetchImpl: (async () => Response.json(ref(over))) as typeof fetch,
  })
  const p = client.uploadMedia(new Blob([BODY], { type: 'text/plain' }), { name: 'a.txt' })
  return { p, close: () => client.close() }
}

describe('the relay answer to an upload', () => {
  it('passes when hash and size match what was sent', async () => {
    const u = upload({})
    await expect(u.p).resolves.toMatchObject({ sha256: REAL_SHA, size: BODY.length })
    u.close()
  })
  it('is refused when the hash differs', async () => {
    const u = upload({ sha256: OTHER_SHA })
    await expect(u.p).rejects.toThrow(/different file/)
    u.close()
  })
  it('is refused when the size differs', async () => {
    const u = upload({ size: BODY.length + 1 })
    await expect(u.p).rejects.toThrow(/different file/)
    u.close()
  })
})

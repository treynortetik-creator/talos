// @vitest-environment node
// A transcript (.txt) upload hit the relay's "csrf content type" refusal because text/plain is a type an HTML form can send.
// The client now sends such a file as application/octet-stream with its real type in X-Talos-File-Type.
import { describe, expect, it } from 'vitest'
import { createSocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

function rig() {
  const seen: Array<{ headers: Record<string, string>; body: unknown }> = []
  const client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: 'ws://127.0.0.1:9/ws',
    isOnline: () => false,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: init.body })
      const h = init.headers as Record<string, string>
      return Response.json({
        media_id: 'md_01J00000000000000000000000',
        kind: 'file',
        role: 'attachment',
        mime: h['X-Talos-File-Type'] ?? h['Content-Type'],
        name: decodeURIComponent(h['X-Talos-Name'] as string),
        size: 3,
        sha256: h['X-Talos-Sha256'],
      })
    }) as unknown as typeof fetch,
  })
  return { client, seen }
}

describe('uploading a text file', () => {
  const cases: Array<[string, string, string]> = [
    ['call.txt', 'text/plain', 'text/plain'],
    ['call.txt', 'text/plain;charset=utf-8', 'text/plain'],
    ['call.txt', '', 'text/plain'],
    ['call.md', '', 'text/markdown'],
    ['call.md', 'text/markdown', 'text/markdown'],
    ['call.csv', 'text/csv', 'text/csv'],
    ['call.csv', '', 'text/csv'],
    ['call.vtt', '', 'text/vtt'],
    ['call.srt', '', 'application/x-subrip'],
    ['data.json', 'application/json', 'application/json'],
  ]
  for (const [name, type, real] of cases)
    it(`${name} (browser type "${type}") goes as octet-stream and names ${real}`, async () => {
      const { client, seen } = rig()
      await client.uploadMedia(new Blob(['hi\n'], { type }), { name })
      const h = seen[0]?.headers as Record<string, string>
      expect(h['Content-Type']).toBe('application/octet-stream')
      expect(h['X-Talos-File-Type']).toBe(real)
      expect(h['X-Talos-CSRF']).toBe('1')
      client.close()
    })

  it('never puts a form-sendable type on the wire, whatever the file', async () => {
    const { client, seen } = rig()
    await client.uploadMedia(new Blob(['x'], { type: 'text/plain' }), { name: 'weird.bin' })
    await client.uploadMedia(new Blob(['x'], { type: 'multipart/form-data' }), { name: 'f.dat' })
    for (const s of seen) expect(s.headers['Content-Type']).toBe('application/octet-stream')
    // not a text format by name: no file-type header to claim
    expect(seen[0]?.headers['X-Talos-File-Type']).toBe('text/plain')
    expect(seen[1]?.headers['X-Talos-File-Type']).toBeUndefined()
    client.close()
  })

  it('leaves pdf, images and audio exactly as they were', async () => {
    const { client, seen } = rig()
    await client.uploadMedia(new Blob(['%PDF-'], { type: 'application/pdf' }), { name: 'a.pdf' })
    await client.uploadMedia(new Blob(['x'], { type: 'image/png' }), { name: 'a.png' })
    await client.uploadMedia(new Blob(['x'], { type: 'audio/webm' }), { name: 'v.webm' })
    expect(seen.map((s) => s.headers['Content-Type'])).toEqual(['application/pdf', 'image/png', 'audio/webm'])
    for (const s of seen) expect(s.headers['X-Talos-File-Type']).toBeUndefined()
    client.close()
  })
})

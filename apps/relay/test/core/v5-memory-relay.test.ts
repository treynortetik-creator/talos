/* biome-ignore-all lint/suspicious/noExplicitAny: captured frames are untyped JSON */
// WP-V5 (docs/V2-FEATURES.md V5.4): the near-cap frames the REAL memory service produced (packages/testkit/fixtures/
// captured/memory/, from `bun run capture:memory` over a synthetic notes folder) go bridge -> REAL relay -> app. The relay
// hangs up on any frame over MAX_FRAME_BYTES, so this proves the byte-fit leaves it room, and that the relay routes each
// answer to the asking socket only and stores nothing.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_FRAME_BYTES, newUlid } from '@talos-app/protocol'
import { mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/testkit/fixtures/captured/memory')
type Cap = { frames: Array<{ asked: string; frame?: Record<string, any>; error?: { code: string } }> }
const cap = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Cap

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('memory answers through the real relay', () => {
  it('every captured answer, including the near-cap listing pages and note chunks, reaches only the asker and the socket stays up', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const bridge = await k
      .bridge({
        pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
        autoReply: false,
        features: ['memory/1'],
      })
      .connect()
    let widest = 0
    for (const name of [
      '01-roots-and-top.json',
      '02-note-links-frontmatter.json',
      '04-listing-pages.json',
      '05-big-note-chunks.json',
    ]) {
      for (const step of cap(name).frames) {
        const answer = step.frame as Record<string, any>
        const ask = await app.sign({ ...mkFrame(step.asked), request_id: answer.request_id, ...askFields(step.asked) })
        app.send(ask)
        await bridge.expectFrame(step.asked as never, ((x: { id: string }) => x.id === ask.id) as never, {
          direction: 'in',
        })
        const wire = { ...answer, id: newUlid() }
        widest = Math.max(widest, Buffer.byteLength(JSON.stringify(wire)))
        bridge.send(wire)
        const got = await app.expectFrame(answer.type, ((x: any) => x.request_id === answer.request_id) as never, {
          direction: 'in',
        })
        expect(got.type).toBe(answer.type)
      }
    }
    // the largest answer is within a few KiB of the cap, so the test means something
    expect(widest).toBeGreaterThan(MAX_FRAME_BYTES - 16 * 1024)
    expect(widest).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    await sleep(200)
    expect(app.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'error')).toBe(false)
    // the other device never saw a memory frame, and the socket is still open
    expect(other.rec.frames.some((r) => String(r.raw.type).startsWith('memory.'))).toBe(false)
    expect(relay.runtime).toBeTruthy()
    await app.close()
    await other.close()
    await bridge.close()
  })
})

function askFields(type: string): Record<string, unknown> {
  if (type === 'memory.tree') return { root_id: 'notes', path: '', cursor: null }
  if (type === 'memory.read') return { root_id: 'notes', path: 'Overview.md', offset: 0 }
  return { q: 'x', root_ids: [], cursor: null, limit: 10 }
}

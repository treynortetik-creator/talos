// The files sent in Talos through the real Bridge: the Mac says it lists them (files-sent/1), and a signed `files.sent` from
// a (fake) app over the (fake) relay comes back as `files.sent_list` for the same request_id, from the Mac's own history.
import { afterEach, describe, expect, test } from 'bun:test'
import { FILES_SENT_FEATURE, type MessageT, newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { bridgeFeatures } from '../src/handshake.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const filters = { type: 'all', name: '', thread_ids: [], from: 'any', after: null, before: null }
const inbound = (x: Harness, pick: (r: Record<string, unknown>) => boolean) =>
  waitFor(() => x.app.rec.frames.some((r) => r.direction === 'in' && pick(r.raw)), 5000, 'answer').then(
    () => x.app.rec.frames.find((r) => r.direction === 'in' && pick(r.raw))?.raw as Record<string, unknown>,
  )

describe('files.sent through the real Bridge', () => {
  test('the Mac says it lists sent files, and answers the same request from its history', async () => {
    h = await startHarness({})
    const x = h
    expect(bridgeFeatures(x.bridge.ctx)).toContain(FILES_SENT_FEATURE)
    x.bridge.ctx.store.addMessage({
      id: `m_${newUlid()}`,
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text: 'here it is',
      format: 'plain',
      attachments: [
        {
          media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4AB',
          kind: 'html',
          role: 'attachment',
          mime: 'text/html',
          name: 'report.html',
          size: 7,
          sha256: 'a'.repeat(64),
        },
      ],
      via: 'app',
      created_at: new Date().toISOString(),
    } as unknown as MessageT)
    const f = await x.app.sign({ ...mkFrame('files.sent'), request_id: newUlid(), filters, cursor: null, limit: 50 })
    x.app.send(f)
    const r = await inbound(x, (raw) => raw.type === 'files.sent_list' && raw.request_id === f.request_id)
    const files = r.files as Array<{ file: { name: string }; thread_id: string; removed: boolean }>
    expect(files.map((x) => [x.file.name, x.thread_id, x.removed])).toEqual([['report.html', 'general', false]])
    expect(r.next_cursor).toBeNull()
  })
})

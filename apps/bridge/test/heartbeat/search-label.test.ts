// R2-4: a search hit on a heartbeat digest says so, so the app can attribute it to "Heartbeat" rather than "System".
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FrameOf, type MessageT, newId, newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { openHistory } from '../../src/history-store.ts'
import { createSearchService } from '../../src/search/install.ts'
import { tempHome } from '../helpers.ts'

const row = (text: string, over: Partial<MessageT> = {}): MessageT => ({
  id: newId('m'),
  thread_id: 'general',
  author: 'system',
  kind: 'text',
  text,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date().toISOString(),
  ...over,
})
const q = (text: string) =>
  ({
    ...mkFrame('search.query'),
    request_id: newUlid(),
    q: text,
    filters: { thread_ids: [], from: 'any', has_file: null, after: null, before: null },
    sort: 'relevance',
    cursor: null,
    limit: 50,
  }) as unknown as FrameOf<'search.query'>

test('a hit on a heartbeat row carries heartbeat:true; a plain system row does not', async () => {
  const s = openHistory(join(tempHome(), 'h.sqlite'))
  const svc = createSearchService(s)
  const hb = row('Heartbeat: 1 update - zebra rollout', { heartbeat: true })
  const plain = row('zebra notice from the bridge')
  s.addMessage(hb)
  s.addMessage(plain)
  while (svc.tick());
  const r = await svc.query(q('zebra'))
  expect(r.hits.find((h) => h.message_id === hb.id)?.heartbeat).toBe(true)
  expect(r.hits.find((h) => h.message_id === plain.id)?.heartbeat).toBeUndefined()
})

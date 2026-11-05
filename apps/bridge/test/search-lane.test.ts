// A worker's search is held to its own lane: whatever thread ids it asks for, only its thread comes back.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FrameOf, type MessageT, newId, newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { openHistory } from '../src/history-store.ts'
import { createSearchService } from '../src/search/install.ts'
import { laneSearch } from '../src/search/lane.ts'
import { tempHome } from './helpers.ts'

const msg = (thread: string, text: string): MessageT => ({
  id: newId('m'),
  thread_id: thread,
  author: 'owner',
  kind: 'text',
  text,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date().toISOString(),
})
const q = (text: string, thread_ids: string[] = []) =>
  ({
    ...mkFrame('search.query'),
    request_id: newUlid(),
    q: text,
    filters: { thread_ids, from: 'any', has_file: null, after: null, before: null },
    sort: 'relevance',
    cursor: null,
    limit: 50,
  }) as unknown as FrameOf<'search.query'>

describe('laneSearch', () => {
  test('a search from a worker returns only its own thread, even when it names other threads or none', async () => {
    const store = openHistory(join(tempHome(), 'h.sqlite'))
    const svc = createSearchService(store)
    const trip = msg('trip', 'ferry timetable for the island')
    const garden = msg('garden', 'ferry timetable for the allotment')
    store.addMessage(trip)
    store.addMessage(garden)
    while (svc.tick());
    const lane = laneSearch(svc, 'trip')
    for (const asked of [[], ['trip'], ['garden'], ['garden', 'trip']]) {
      const r = await lane.query(q('ferry', asked))
      expect(r.hits.map((h) => h.message_id)).toEqual([trip.id])
      expect(r.hits.every((h) => h.thread_id === 'trip')).toBe(true)
    }
    // the unwrapped service still sees both, so the filter is what narrows it
    expect((await svc.query(q('ferry'))).hits).toHaveLength(2)
    store.close()
  })

  test('a result from the service that is outside the lane is dropped before the worker sees it', async () => {
    const leaky = {
      available: true,
      query: async () => ({
        hits: [
          { message_id: 'm_a', thread_id: 'trip' },
          { message_id: 'm_b', thread_id: 'garden' },
        ],
        next_cursor: null,
        total_estimate: 2,
        took_ms: 1,
        index: 'ready',
      }),
    } as never
    const r = await laneSearch(leaky, 'trip').query(q('x'))
    expect(r.hits.map((h) => h.message_id)).toEqual(['m_a'])
  })
})

// Follow-ups to the signed history reads: the short freshness window covers ALL owner reads (search, memory), with sane
// clock-skew tolerance.
import { afterEach, expect, test } from 'bun:test'
import { newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { type Harness, sleep, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const F0 = { thread_ids: [], from: 'any', has_file: null, after: null, before: null }
const at = (ms: number) => new Date(Date.now() + ms).toISOString()
const search = (ts: string) =>
  h?.app.sign({
    ...mkFrame('search.query', {}, ts),
    request_id: newUlid(),
    q: 'hello',
    filters: F0,
    sort: 'relevance',
    cursor: null,
    limit: 5,
  }) as Promise<Record<string, unknown> & { id: string }>
const memory = (ts: string) =>
  h?.app.sign({
    ...mkFrame('memory.tree', {}, ts),
    request_id: newUlid(),
    root_id: null,
    path: '',
    cursor: null,
  }) as Promise<Record<string, unknown> & { id: string }>
const answered = async (id: string) => {
  await sleep(300)
  return (h as Harness).relay.frames.find((r) => r.direction === 'from_bridge' && r.raw.ref === id)?.raw
}

test('a search.query or memory.tree signed 1 hour ago is refused (stale: clock off), not served', async () => {
  h = await startHarness()
  for (const f of [await search(at(-3600_000)), await memory(at(-3600_000))]) {
    h.app.send(f)
    expect((await answered(f.id))?.code).toBe('stale')
  }
})

test('clock skew: 4 minutes behind and 1 minute ahead are still served (not refused)', async () => {
  h = await startHarness()
  for (const f of [await search(at(-4 * 60_000)), await search(at(60_000)), await memory(at(-4 * 60_000))]) {
    h.app.send(f)
    expect(['sig_invalid', 'stale']).not.toContain((await answered(f.id))?.code)
  }
})

test('a history.request 6 minutes behind is refused; 4 minutes behind is served', async () => {
  h = await startHarness()
  const old = await h.app.buildHistoryRequest('general', { ts: at(-6 * 60_000) })
  const ok = await h.app.buildHistoryRequest('general', { ts: at(-4 * 60_000) })
  h.app.send(old)
  h.app.send(ok)
  expect((await answered(old.id))?.code).toBe('stale')
  await h.relay.expectFrame('history.page', (f) => f.request_id === ok.request_id, { direction: 'from_bridge' })
})

// PR #55 review, finding B: the seen-id check runs AFTER the signature on every signed read and schedule frame.
test('a valid read sent twice: one answer, then "already used"; a forged schedules.list gets one answer for seen and unseen ids', async () => {
  h = await startHarness()
  const s = await search(at(0))
  h.app.sendRaw(JSON.stringify(s))
  await sleep(300)
  h.app.sendRaw(JSON.stringify(s))
  await sleep(300)
  const answers = h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.ref === s.id)
  expect(answers.map((r) => r.raw.message)).toContain('That request was already used.')
  // the relay dedups schedule frame ids itself, so the probe reuses the id the Mac saw on the search above
  const list = (await h.app.sign({ ...mkFrame('schedules.list'), request_id: newUlid() })) as Record<string, unknown>
  const forge = (id: string) => {
    const osig = String(list.osig)
    return { ...list, id, osig: (osig[0] === 'A' ? 'B' : 'A') + osig.slice(1) }
  }
  const seen = forge(s.id)
  const fresh = forge(newUlid())
  h.app.sendRaw(JSON.stringify(seen))
  h.app.sendRaw(JSON.stringify(fresh))
  await sleep(400)
  const codeFor = (id: string) =>
    h?.relay.frames
      .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'error' && r.raw.ref === id)
      .map((r) => `${r.raw.code}:${r.raw.message}`)
  expect(codeFor(fresh.id)).toEqual(['sig_invalid:signature check failed'])
  expect(codeFor(seen.id)).toContain('sig_invalid:signature check failed')
  expect(codeFor(seen.id)?.at(-1)).toBe('sig_invalid:signature check failed')
})

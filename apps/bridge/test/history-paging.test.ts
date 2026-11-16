// Scroll-back served by the Mac. The app pages with one cursor, the lowest seq it holds; the store orders by arrival
// (`ord`), which is not seq order (an agent reply is written before the relay numbers it) and includes rows that never
// get a seq (card rows). Whatever the mix, walking the pages must show every row exactly once.
import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageT } from '@talos-app/protocol'
import { HistoryStore } from '../src/history-store.ts'
import { type Harness, startHarness, tempHome } from './helpers.ts'

const homes: string[] = []
let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshStore(): HistoryStore {
  const home = tempHome()
  homes.push(home)
  return new HistoryStore(join(home, 'history.sqlite'))
}

let n = 0
/** One row, stored now (so `ord` is the call order). `seq` undefined is a row the relay never numbers, like a card row. */
function add(store: HistoryStore, name: string, seq?: number, thread = 'general') {
  n++
  store.addMessage({
    id: `m_${String(n).padStart(26, '0')}`,
    thread_id: thread,
    author: 'agent',
    kind: seq === undefined ? 'card' : 'text',
    text: name,
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(),
    ...(seq !== undefined ? { seq } : {}),
  } as MessageT)
}

/** Pages the way the app does (Timeline.tsx): first with no cursor, then before the lowest seq it holds, until no more. */
function walk(store: HistoryStore, limit: number, startBefore?: number) {
  const pages: string[][] = []
  const held: MessageT[] = []
  let before = startBefore
  for (let i = 0; i < 500; i++) {
    const page = store.page({
      thread_id: 'general',
      limit,
      timeline: true,
      ...(before !== undefined ? { beforeSeq: before } : {}),
    })
    pages.push(page.messages.map((m) => `${m.text}#${m.seq ?? '-'}`))
    held.push(...page.messages)
    if (!page.hasMore) return { pages, texts: held.map((m) => m.text as string) }
    const lowest = held.reduce<number | undefined>(
      (lo, m) => (m.seq === undefined ? lo : lo === undefined ? m.seq : Math.min(lo, m.seq)),
      before,
    )
    if (lowest === before) throw new Error(`no progress at before_seq ${before}: ${JSON.stringify(pages.at(-1))}`)
    before = lowest
  }
  throw new Error('paging did not end')
}

describe('scroll-back from the Mac', () => {
  test('a card row with no seq and a reply numbered after a later message both appear, once', () => {
    const store = freshStore()
    // arrival order on the Mac; R1 was written before M2 arrived but numbered after it
    add(store, 'old1', 7)
    add(store, 'old2', 8)
    add(store, 'old3', 9)
    add(store, 'cardRow')
    add(store, 'R1', 11)
    add(store, 'M2', 10)
    add(store, 'R2', 12)
    add(store, 'M3', 13)
    add(store, 'R3', 14)
    const { pages, texts } = walk(store, 4)
    expect([...texts].sort()).toEqual(['M2', 'M3', 'R1', 'R2', 'R3', 'cardRow', 'old1', 'old2', 'old3'])
    expect(pages[0]).toEqual(['R1#11', 'R2#12', 'M3#13', 'R3#14'])
    // the card row comes with the row it followed, in the page that row is in
    expect(pages.flat().indexOf('cardRow#-')).toBe(pages.flat().indexOf('old3#9') + 1)
  })

  test('an app that already holds the newer rows from the relay gets everything below its lowest seq, and nothing above', () => {
    const store = freshStore()
    add(store, 'old1', 7)
    add(store, 'card after old1')
    add(store, 'R1', 11)
    add(store, 'M2', 10)
    add(store, 'old2', 8) // numbered early, arrived late
    add(store, 'R2', 12)
    const { texts } = walk(store, 2, 10)
    expect([...texts].sort()).toEqual(['card after old1', 'old1', 'old2'])
  })

  test('any mix of arrival order, numbering and un-numbered rows: every row once, at every page size', () => {
    // a small fixed generator, so a failure names its case
    let state = 42
    const rnd = (k: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state % k
    }
    for (let round = 0; round < 40; round++) {
      const store = freshStore()
      const total = 5 + rnd(60)
      const seqs = Array.from({ length: total }, (_, i) => i + 1)
      // local disorder: swap neighbours now and then, as a reply and a message crossing do
      for (let i = 0; i + 1 < seqs.length; i++)
        if (rnd(4) === 0) [seqs[i], seqs[i + 1]] = [seqs[i + 1] as number, seqs[i] as number]
      const want: string[] = []
      seqs.forEach((seq, i) => {
        const none = rnd(5) === 0
        add(store, `row${i}`, none ? undefined : seq)
        want.push(`row${i}`)
        // sometimes a run of un-numbered rows, longer than a small page
        if (rnd(12) === 0)
          for (let k = 0; k < 4; k++) {
            add(store, `row${i}x${k}`)
            want.push(`row${i}x${k}`)
          }
      })
      add(store, 'other thread', 9999, 'inbox')
      for (const limit of [1, 2, 3, 7, 50]) {
        const { texts } = walk(store, limit)
        expect({ round, limit, rows: [...texts].sort() }).toEqual({ round, limit, rows: [...want].sort() })
      }
      store.close()
    }
  })

  test('more un-numbered rows in a row than one page holds come together, so the next request moves on', () => {
    const store = freshStore()
    add(store, 'first', 1)
    for (let i = 0; i < 6; i++) add(store, `card${i}`)
    add(store, 'last', 2)
    const { pages, texts } = walk(store, 3)
    expect(texts).toHaveLength(8)
    expect(new Set(texts).size).toBe(8)
    expect(pages.some((p) => p.length > 3)).toBe(true)
  })

  test('a thread whose rows were never numbered at all still pages to its end', () => {
    const store = freshStore()
    for (let i = 0; i < 5; i++) add(store, `card${i}`)
    const { texts } = walk(store, 2)
    expect(texts).toEqual(['card0', 'card1', 'card2', 'card3', 'card4'])
  })

  test('over the wire: history.request pages from the real bridge show the card row and the late-numbered reply', async () => {
    h = await startHarness()
    const store = h.bridge.ctx.store
    add(store, 'old1', 7)
    add(store, 'old2', 8)
    add(store, 'old3', 9)
    add(store, 'cardRow')
    add(store, 'R1', 11)
    add(store, 'M2', 10)
    add(store, 'R2', 12)
    add(store, 'M3', 13)
    add(store, 'R3', 14)
    const seen: string[] = []
    let before: number | undefined
    for (let i = 0; i < 10; i++) {
      const request_id = `page${i}`
      await h.app.sendHistoryRequest('general', { request_id, limit: 4, ...(before ? { before_seq: before } : {}) })
      const page = await h.relay.expectFrame('history.page', (f) => f.request_id === request_id, {
        direction: 'from_bridge',
      })
      seen.push(...page.messages.map((m) => String(m.text)))
      if (!page.has_more) break
      before = Math.min(...page.messages.flatMap((m) => (m.seq === undefined ? [] : [m.seq])), before ?? Infinity)
    }
    expect([...seen].sort()).toEqual(['M2', 'M3', 'R1', 'R2', 'R3', 'cardRow', 'old1', 'old2', 'old3'])
  })

  /** Pages over real history.request frames the way the app does, and returns every text it was shown. */
  async function walkOverTheWire(hh: Harness, limit: number) {
    const seen: string[] = []
    let before: number | undefined
    for (let i = 0; i < 40; i++) {
      const request_id = `wire${i}`
      await hh.app.sendHistoryRequest('general', { request_id, limit, ...(before ? { before_seq: before } : {}) })
      const page = await hh.relay.expectFrame('history.page', (f) => f.request_id === request_id, {
        direction: 'from_bridge',
      })
      seen.push(...page.messages.map((m) => String(m.text)))
      if (!page.has_more) return seen
      const lowest = Math.min(...page.messages.flatMap((m) => (m.seq === undefined ? [] : [m.seq])), before ?? Infinity)
      if (lowest === before || lowest === Infinity) throw new Error(`the cursor is stuck at before_seq ${before}`)
      before = lowest
    }
    throw new Error('paging did not end')
  }

  test('a run of card rows too big for one frame does not wall off what is older: its numbered row always rides in the page', async () => {
    h = await startHarness()
    const store = h.bridge.ctx.store
    for (let i = 1; i <= 40; i++) add(store, `older ${i}`, i)
    add(store, 'anchor', 41)
    for (let i = 0; i < 600; i++) add(store, `card ${i} ${'card '.repeat(100)}`)
    add(store, 'top', 42)
    const seen = await walkOverTheWire(h, 50)
    for (let i = 1; i <= 40; i++) expect(seen).toContain(`older ${i}`)
    expect(seen).toContain('anchor')
    expect(seen).toContain('top')
    // the newest cards of the run are the ones shown; the frame cap decides how many
    expect(seen.some((t) => t.startsWith('card 599 '))).toBe(true)
    expect(new Set(seen).size).toBe(seen.length)
  })

  test('rows never numbered that do not fit one frame: the newest are sent and the page says there is no more to ask for', async () => {
    h = await startHarness()
    const store = h.bridge.ctx.store
    for (let i = 0; i < 600; i++) add(store, `card ${i} ${'card '.repeat(100)}`)
    const seen = await walkOverTheWire(h, 50) // would throw "stuck" if the page asked to be continued
    expect(seen.some((t) => t.startsWith('card 599 '))).toBe(true)
    expect(seen.length).toBeLessThan(600)
  })
})

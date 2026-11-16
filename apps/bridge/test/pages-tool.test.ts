// publish_page (docs/ORG-PAGES-SPEC.md, phase 1) through the real bridge against the fake relay's /bridge/pages: a signed
// raw-HTML publish naming its thread and title, a new version by page_id, another thread's page refused, the relay's caps
// said plainly, a bad title stopped before anything is sent, and no share tool anywhere.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { PAGES_FULL } from '@talos-app/protocol'
import { AGENT_TOOL_NAMES, PAGE_BRIDGE_TOOLS, WORKER_THREAD_LOCKED_TOOLS } from '../src/tools/table.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

const HTML = '<!doctype html><title>Rota</title><p>week 46</p>'
const pageCalls = () => h.relay.http.filter((r) => r.path.startsWith('/bridge/pages'))
const json = (res: { content: { text?: string }[] }) =>
  JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>

describe('publish_page', () => {
  test('publishes the HTML, signed, with its thread and title in the signed query; returns the page and its link', async () => {
    h = await startHarness()
    const res = await h.bridge.callTool('publish_page', { thread_id: 'general', title: 'Rota', html: HTML })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const out = json(res)
    expect(out.page_id).toMatch(/^pg_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(out.version).toBe(createHash('sha256').update(HTML).digest('hex'))
    expect(out.owner_url).toBe(`https://relay.example.com/p/${out.page_id}`)
    const [call] = pageCalls()
    expect(call?.status).toBe(201)
    expect(new URL(call?.path ?? '', 'http://x').searchParams.get('thread_id')).toBe('general')
    expect(new URL(call?.path ?? '', 'http://x').searchParams.get('title')).toBe('Rota')
    expect(call?.body.toString('utf8')).toBe(HTML)
    expect(call?.headers['x-talos-sha256']).toBe(out.version as string)
    expect(String(call?.headers.authorization)).toMatch(/^TalosBridge /)
  })

  test('a new page puts one agent message in the thread, carrying the page for the card', async () => {
    h = await startHarness()
    const out = json(await h.bridge.callTool('publish_page', { thread_id: 'general', title: 'Rota', html: HTML }))
    const f = await h.relay.expectFrame('reply', (r) => r.message.page?.page_id === out.page_id, {
      direction: 'from_bridge',
    })
    expect(f.message).toMatchObject({
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text: 'Published a page: “Rota”.',
      page: { page_id: out.page_id, title: 'Rota', version: out.version },
    })
  })

  test('page_id adds a version; the same bytes again are unchanged', async () => {
    h = await startHarness()
    const first = json(await h.bridge.callTool('publish_page', { thread_id: 'general', title: 'Rota', html: HTML }))
    const second = await h.bridge.callTool('publish_page', {
      thread_id: 'general',
      title: 'Rota',
      html: `${HTML}<p>v2</p>`,
      page_id: first.page_id,
    })
    expect(json(second)).toMatchObject({ page_id: first.page_id, unchanged: false })
    const again = await h.bridge.callTool('publish_page', {
      thread_id: 'general',
      title: 'Rota',
      html: `${HTML}<p>v2</p>`,
      page_id: first.page_id,
    })
    expect(json(again).unchanged).toBe(true)
    expect(h.relay.pages.get(first.page_id as string)?.versions).toHaveLength(2)
    // one message per new page or version, none for the same bytes again
    await h.relay.expectFrame('reply', (r) => r.message.text === 'Updated the page “Rota”.', {
      direction: 'from_bridge',
    })
    const pageRows = () =>
      h.relay.frames.filter(
        (f) =>
          f.direction === 'from_bridge' && f.frame.type === 'reply' && f.frame.message.page?.page_id === first.page_id,
      )
    await new Promise((r) => setTimeout(r, 300))
    expect(pageRows()).toHaveLength(2)
  })

  test('another thread’s page is refused with what to do instead', async () => {
    h = await startHarness()
    h.relay.pages.set('pg_01JBF3V7Q8K2M4N6P8R0S2T4V9', { thread_id: 'work', title: 'x', versions: ['a'], current: 'a' })
    const res = await h.bridge.callTool('publish_page', {
      thread_id: 'general',
      title: 'Rota',
      html: HTML,
      page_id: 'pg_01JBF3V7Q8K2M4N6P8R0S2T4V9',
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('was published from this thread')
    expect(h.relay.pages.get('pg_01JBF3V7Q8K2M4N6P8R0S2T4V9')?.versions).toEqual(['a'])
  })

  test('the relay full (507) is said in its own words', async () => {
    h = await startHarness()
    h.relay.refusePages({ status: 507, body: PAGES_FULL })
    const res = await h.bridge.callTool('publish_page', { thread_id: 'general', title: 'Rota', html: HTML })
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toBe(PAGES_FULL.message)
  })

  test('a title on two lines, an empty page or a bad page_id is stopped before anything is sent', async () => {
    h = await startHarness()
    for (const args of [
      { title: 'two\nlines', html: HTML },
      { title: 'Rota', html: '' },
      { title: 'Rota', html: HTML, page_id: 'not-a-page' },
    ]) {
      const res = await h.bridge.callTool('publish_page', { thread_id: 'general', ...args })
      expect(res.isError).toBe(true)
    }
    expect(pageCalls()).toEqual([])
  })

  test('is its own group, locked to a worker’s own thread, and no tool can share a page', () => {
    expect([...PAGE_BRIDGE_TOOLS]).toEqual(['publish_page'])
    expect(WORKER_THREAD_LOCKED_TOOLS).toContain('publish_page')
    expect(AGENT_TOOL_NAMES.filter((n) => /share|unshare/.test(n))).toEqual([])
  })
})

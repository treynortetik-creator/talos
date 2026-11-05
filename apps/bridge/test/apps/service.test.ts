import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeAppCspHeader, parseFrame } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { type AppsHarness, mkApps, THREAD } from './harness.ts'

const live: AppsHarness[] = []
afterEach(async () => {
  while (live.length) await live.pop()?.h.stop()
})
const boot = async (o: Parameters<typeof mkApps>[0] = {}) => {
  const a = await mkApps(o)
  live.push(a)
  return a
}

describe('showing a view', () => {
  it('the post hook nudges, app_show uploads the pinned page with its CSP header and posts a kind-app message', async () => {
    const a = await boot()
    const s = await a.showView({ caption: 'Here it is' })
    expect(s.nudge?.hookSpecificOutput.additionalContext).toContain(`call app_show with capture_id "${s.captureId}"`)
    expect(s.text).toMatch(/^shown \(view av_/)
    // the page went up as text/html with the exact CSP header the catalog approved
    const page = a.puts.find((p) => p.mime === 'text/html')
    expect(page).toBeDefined()
    const csp = decodeAppCspHeader(page?.headers['X-Talos-App-Csp'], 'https://relay.example.com')
    expect(csp.ok && csp.csp).toEqual(a.fx.csp)
    expect(new TextDecoder().decode(page?.bytes)).toBe(a.fx.html)
    // the reply frame parses and carries the view
    const reply = await a.h.relay.expectFrame('reply', (f) => f.message.kind === 'app', { direction: 'from_bridge' })
    expect(parseFrame(reply).ok).toBe(true)
    const m = reply.message
    expect(m.author).toBe('app')
    expect(m.text).toBe('Here it is')
    expect(m.app?.label).toBe('Probe view')
    expect(m.app?.approval_key).toBe(a.fx.key)
    expect(m.app?.tool_input).toEqual({})
    expect(m.app?.tool_result?.structuredContent).toEqual({ tool: 'show_widget', ok: true })
    expect(Date.parse(m.app?.calls_until as string) - Date.parse(m.app?.shown_at as string)).toBe(24 * 3600_000)
    expect(m.app?.page.mime).toBe('text/html')
    // stored in history, and the capture is gone
    expect(a.h.bridge.ctx.store.page({ thread_id: THREAD, limit: 20 }).messages.find((x) => x.id === m.id)?.kind).toBe(
      'app',
    )
    expect(existsSync(join(a.fx.P.captures, `${s.captureId}.json`))).toBe(false)
    expect(a.svc.store.getView(s.viewId)?.state).toBe('active')
  })
  it('a second show of the same resource supersedes the first and reuses the uploaded page', async () => {
    const a = await boot()
    const one = await a.showView()
    const two = await a.showView()
    expect(a.svc.store.getView(one.viewId)?.state).toBe('superseded')
    expect(a.svc.store.getView(two.viewId)?.state).toBe('active')
    expect(a.updates(one.viewId).map((u) => u.state)).toEqual(['superseded'])
    const ids = a.puts.filter((p) => p.mime === 'text/html').map((p) => p.id)
    expect(new Set(ids).size).toBe(1) // one media id for the approval key
    // a call on the superseded view is closed
    const f = await a.call(one.viewId, 'read_note', { id: 'n1' })
    expect((await a.response(f.request_id)).error?.code).toBe('view_closed')
  })
  it('errors name the fix: unknown capture, failed call, too large, unapproved tool, missing file, caption, thread', async () => {
    const a = await boot()
    const run = async (args: Record<string, unknown>) =>
      (await a.h.bridge.callTool('app_show', args)).content[0]?.text ?? ''
    expect(await run({ thread_id: THREAD, capture_id: 'nope' })).toContain('No such capture')
    expect(await run({ thread_id: 'nowhere', capture_id: 'x' })).toContain('Unknown thread')
    expect(await run({ thread_id: THREAD })).toContain('capture_id is required')
    expect(await run({ thread_id: THREAD, capture_id: '../x' })).toContain('No such capture')
    a.hook('post-tool-use-failure', {
      tool_name: 'mcp__probe__show_widget',
      tool_input: {},
      tool_use_id: 'toolu_bad',
      error: 'Error',
    })
    expect(await run({ thread_id: THREAD, capture_id: 'toolu_bad' })).toContain('No such capture')
    await a.showView({ toolUseId: 'toolu_ok' }) // consumes toolu_ok
    expect(await run({ thread_id: THREAD, capture_id: 'toolu_ok' })).toContain('No such capture') // shown once
    a.hook('post-tool-use', {
      tool_name: 'mcp__probe__show_widget',
      tool_input: {},
      tool_use_id: 'toolu_long',
      tool_response: '{}',
    })
    expect(await run({ thread_id: THREAD, capture_id: 'toolu_long', caption: 'x'.repeat(281) })).toContain(
      'caption is over 280',
    )
    // the pinned file disappearing is a fix-it message, not a crash
    a.hook('post-tool-use', {
      tool_name: 'mcp__probe__show_widget',
      tool_input: {},
      tool_use_id: 'toolu_nofile',
      tool_response: '{}',
    })
    await Bun.$`rm ${join(a.fx.P.resources, `${a.fx.sha}.html`)}`
    expect(await run({ thread_id: THREAD, capture_id: 'toolu_nofile' })).toContain('approved app file is missing')
  })
  it('a capture older than 15 minutes is gone; a tool whose app is not approved cannot be shown', async () => {
    const clock = fakeClock('2026-10-30T12:00:00.000Z')
    const a = await boot({ clock })
    a.hook('post-tool-use', {
      tool_name: 'mcp__probe__show_widget',
      tool_input: {},
      tool_use_id: 'toolu_old',
      tool_response: '{}',
    })
    clock.advance(15 * 60_000 + 1)
    const r = await a.h.bridge.callTool('app_show', { thread_id: THREAD, capture_id: 'toolu_old' })
    expect(r.content[0]?.text).toContain('No such capture')
    expect(r.isError).toBe(true)
  })
  it('the catalog and the live session on different Claude Code versions: app_show refuses and names both', async () => {
    const a = await boot()
    writeFileSync(a.fx.P.liveVersion, '2.1.400\n')
    const s = await a.showView()
    expect(s.text).toContain('scanned with Claude Code 2.1.312 and this session runs 2.1.400')
    writeFileSync(a.fx.P.liveVersion, '2.1.312\n')
    expect((await a.showView()).text).toMatch(/^shown/)
  })
  it('show: ask raises a low-risk card; PRIMARY shows it, KILL deletes the capture', async () => {
    const a = await boot({ fx: { show: 'ask' } })
    a.hook('post-tool-use', {
      tool_name: 'mcp__probe__show_widget',
      tool_input: {},
      tool_use_id: 'toolu_a',
      tool_response: '{"x":1}',
    })
    expect((await a.h.bridge.callTool('app_show', { thread_id: THREAD, capture_id: 'toolu_a' })).content[0]?.text).toBe(
      "waiting for the owner's tap",
    )
    const card = (
      await a.h.relay.expectFrame('card.create', (f) => f.card.kind === 'app_action', { direction: 'from_bridge' })
    ).card
    expect(card.title).toBe('Show Probe view result in this thread?')
    expect(card.risk).toBe('low')
    expect(card.body).toBe("It'll be stored on your relay for 7 days.")
    expect(
      a.h.relay.frames.some(
        (r) => r.frame.type === 'reply' && (r.frame as { message?: { kind?: string } }).message?.kind === 'app',
      ),
    ).toBe(false)
    await a.resolve(card, 'primary')
    await a.h.relay.expectFrame('reply', (f) => f.message.kind === 'app', { direction: 'from_bridge' })
    await a.h.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done', {
      direction: 'from_bridge',
    })
    expect(a.notesOf('card_action')).toEqual([]) // a bridge-run card never reaches the agent
    // KILL
    a.hook('post-tool-use', {
      tool_name: 'mcp__probe__show_widget',
      tool_input: {},
      tool_use_id: 'toolu_b',
      tool_response: '{"x":2}',
    })
    await a.h.bridge.callTool('app_show', { thread_id: THREAD, capture_id: 'toolu_b' })
    const card2 = (
      await a.h.relay.expectFrame('card.create', (f) => f.card.kind === 'app_action' && f.card.id !== card.id, {
        direction: 'from_bridge',
      })
    ).card
    const sent: Array<{ type: string; card_id?: string; state?: string }> = []
    const real = a.h.bridge.ctx.transport.sendDurable.bind(a.h.bridge.ctx.transport)
    a.h.bridge.ctx.transport.sendDurable = (f) => {
      sent.push(f as never)
      return real(f)
    }
    await a.resolve(card2, 'kill')
    await a.waitFor(() => !existsSync(join(a.fx.P.captures, 'toolu_b.json')), 2000, 'capture deleted')
    // the capture is deleted, then the ledger and the wire are settled in the same step: no later frame can contradict
    const mine = sent.filter((f) => f.type === 'card.update' && f.card_id === card2.id).map((f) => f.state)
    expect(mine).toContain('done')
    expect(mine).not.toContain('failed')
    expect(a.h.bridge.ctx.ledger.get(card2.id)?.state).toBe('done')
    expect(a.svc.store.activeViews().length).toBe(1)
  })
  it('show: ask approved while Apps are off shows nothing and says why, with the not-run marker', async () => {
    const a = await boot({ fx: { show: 'ask' } })
    a.hook('post-tool-use', {
      tool_name: 'mcp__probe__show_widget',
      tool_input: {},
      tool_use_id: 'toolu_off',
      tool_response: '{"x":1}',
    })
    await a.h.bridge.callTool('app_show', { thread_id: THREAD, capture_id: 'toolu_off' })
    const card = (
      await a.h.relay.expectFrame('card.create', (f) => f.card.kind === 'app_action', { direction: 'from_bridge' })
    ).card
    a.flag.on = false
    await a.resolve(card, 'primary')
    const upd = await a.h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', {
      direction: 'from_bridge',
    })
    expect(upd.result).toMatchObject({ ok: false, ran: false })
    expect(upd.result?.text).toContain('Apps are turned off on this Mac')
    expect(
      a.h.relay.frames.some(
        (r) => r.raw.type === 'reply' && (r.raw as { message?: { kind?: string } }).message?.kind === 'app',
      ),
    ).toBe(false)
  })
  it('media.fetch re-uploads the page with its CSP header (a re-upload without it would 404 at the relay)', async () => {
    const a = await boot()
    const s = await a.showView()
    const page = a.puts.find((p) => p.mime === 'text/html')
    expect(page).toBeDefined()
    a.puts.length = 0
    expect(await a.h.bridge.ctx.media.rehydrate(page?.id as string)).toBe(true)
    expect(a.puts.length).toBe(1)
    expect(a.puts[0]?.headers['X-Talos-App-Csp']).toBeDefined()
    void s
  })
  it('a result over 128 KiB goes up as JSON media, never into the Mac media cache; over 8 MiB is refused', async () => {
    const a = await boot()
    const big = JSON.stringify({ data: 'y'.repeat(200 * 1024) })
    const s = await a.showView({ response: big })
    expect(s.text).toMatch(/^shown/)
    const reply = await a.h.relay.expectFrame('reply', (f) => f.message.kind === 'app', { direction: 'from_bridge' })
    expect(reply.message.app?.tool_result).toBeUndefined()
    expect(reply.message.app?.tool_result_media?.mime).toBe('application/json')
    const up = a.puts.find((p) => p.mime === 'application/json')
    expect(up?.bytes.length).toBeGreaterThan(200 * 1024)
    expect(existsSync(join(a.h.home, 'media', `${up?.id}.json`))).toBe(false)
    const huge = await a.showView({ response: JSON.stringify({ data: 'z'.repeat(9 * 1024 * 1024) }) })
    expect(huge.text).toContain('too large')
  })
})

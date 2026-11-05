// @vitest-environment jsdom
// AP3 host protocol (M2.2, M2.3, M4.6, M6.4). The view is hostile: every test here is something it could send.
import { AppRequestFrame, AppResponseFrame, RPC_ERR, verifyOwnerFrame } from '@talos-app/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChipAnswer } from '../../src/features/apps/host.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { makeHost, makeView } from './helpers.ts'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(() => vi.useRealTimers())

describe('who may talk', () => {
  it('ignores a window that is not the frame, before and after the handshake', async () => {
    const t = makeHost()
    const other = { postMessage: vi.fn() }
    t.say(t.req(1, 'ui/initialize', {}), other)
    expect(t.posted).toEqual([])
    await t.start()
    t.say(t.req(2, 'ping'), other)
    t.say(t.req(3, 'tools/call', { name: 'x' }), window)
    t.say(t.req(4, 'tools/call', { name: 'x' }), null)
    await t.flush()
    expect(t.replies(2)).toEqual([])
    expect(t.sent).toEqual([])
  })

  it('sends nothing before the view says initialized, then tool-input and tool-result once, in that order', async () => {
    const t = makeHost()
    t.say(t.req('i', 'ui/initialize', { protocolVersion: '2026-01-26' }))
    expect(t.posted.map((m) => m.id ?? m.method)).toEqual(['i'])
    t.host.sendContext({ theme: 'dark' })
    await t.flush()
    expect(t.posted).toHaveLength(1)
    t.say(t.note('ui/notifications/initialized', {}))
    t.say(t.note('ui/notifications/initialized', {}))
    await t.flush()
    expect(t.methods()).toEqual([
      'ui/notifications/host-context-changed',
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
    ])
    const input = t.posted.find((m) => m.method === 'ui/notifications/tool-input')
    expect(input?.params).toEqual({ arguments: t.view.tool_input })
    expect(t.posted.find((m) => m.method === 'ui/notifications/tool-result')?.params).toEqual(t.view.tool_result)
  })

  it('answers a request before ui/initialize with -32002 and a notification with nothing', async () => {
    const t = makeHost()
    t.say(t.req(1, 'tools/call', { name: 'x' }))
    t.say(t.req(2, 'ping'))
    t.say(t.note('notifications/message', { data: 'hi' }))
    expect(t.replies(1)[0]?.error).toMatchObject({ code: RPC_ERR.NOT_INITIALIZED })
    expect(t.replies(2)[0]?.error).toMatchObject({ code: RPC_ERR.NOT_INITIALIZED })
    expect(t.host.log).toEqual([])
    expect(t.sent).toEqual([])
  })

  it('unknown method -32601, bad params -32602, junk dropped without a reply', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'resources/read', {}))
    t.say(t.req(2, 'tools/call', { name: 5 }))
    t.say(t.req(3, 'ui/request-display-mode', { mode: 'sideways' }))
    t.say('not an object')
    t.say([1])
    t.say({ jsonrpc: '1.0', id: 9, method: 'ping' })
    t.say({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })
    expect(t.replies(1)[0]?.error).toMatchObject({ code: RPC_ERR.METHOD_NOT_FOUND })
    expect(t.replies(2)[0]?.error).toMatchObject({ code: RPC_ERR.INVALID_PARAMS })
    expect(t.replies(3)[0]?.error).toMatchObject({ code: RPC_ERR.INVALID_PARAMS })
    expect(t.replies(9)).toEqual([])
    expect(t.sent).toEqual([])
  })

  it('drops a message over 256 KiB without reading it', async () => {
    const t = makeHost()
    await t.start()
    const before = t.posted.length
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x'.repeat(300_000) } }))
    expect(t.posted.length).toBe(before)
    expect(t.sent).toEqual([])
  })

  it('answers ping', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'ping'))
    expect(t.replies(1)[0]?.result).toEqual({})
  })
})

describe('tools/call', () => {
  it('sends a signed app.request that verifies on raw JSON, with the raw tool name and the gesture', async () => {
    const client = createFakeClient()
    const t = makeHost({ sendRequest: (f) => client.sendAppRequest?.(f) as Promise<void>, claimGesture: () => true })
    await t.start()
    t.say(t.req(7, 'tools/call', { name: 'read_note', arguments: { id: 'n1' } }))
    await vi.waitFor(() => expect(client.sent).toHaveLength(1))
    const raw = client.sent[0] as Record<string, unknown>
    expect(await verifyOwnerFrame(raw, await client.publicJwk())).toBe(true)
    expect(AppRequestFrame.safeParse(raw).success).toBe(true)
    expect(raw).toMatchObject({
      type: 'app.request',
      method: 'tools/call',
      tool_name: 'read_note',
      arguments: { id: 'n1' },
      user_gesture: true,
      view_id: t.view.view_id,
      thread_id: t.view.thread_id,
    })
    expect(String(raw.request_id)).toMatch(/^ar_[0-9A-HJKMNP-TV-Z]{26}$/)
    // tampering with any field breaks the signature (second caller: the signature is the only identity)
    expect(await verifyOwnerFrame({ ...raw, tool_name: 'delete_note' }, await client.publicJwk())).toBe(false)
  })

  it('user_gesture is false without activation, and true is never assumed', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    expect(t.sent[0]?.user_gesture).toBe(false)
  })

  it('done -> result (an isError result is still a result); the matching id only', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    t.say(t.req(2, 'tools/call', { name: 'b' }))
    const [a, b] = t.sent
    // answered out of order, and one stray response for another view
    t.host.handleResponse({
      view_id: 'av_01JBF3V7Q8K2M4N6P8R0S2T43Z',
      request_id: String(a?.request_id),
      state: 'done',
      result: { content: [] },
    })
    expect(t.replies(1)).toEqual([])
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(b?.request_id),
      state: 'done',
      result: { content: [{ type: 'text', text: 'B' }], isError: true },
    })
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(a?.request_id),
      state: 'done',
      result: { content: [{ type: 'text', text: 'A' }] },
    })
    expect(t.replies(2)[0]?.result).toEqual({ content: [{ type: 'text', text: 'B' }], isError: true })
    expect(t.replies(1)[0]?.result).toEqual({ content: [{ type: 'text', text: 'A' }] })
    // a second answer for the same request changes nothing
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(a?.request_id),
      state: 'done',
      result: { content: [] },
    })
    expect(t.replies(1)).toHaveLength(1)
  })

  it('failed -> -32000 with data.talos and a Talos-built message', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    const rid = String(t.sent[0]?.request_id)
    const frame = AppResponseFrame.parse({
      v: 1,
      id: '01JBF3V7Q8K2M4N6P8R0S2T43X',
      ts: '2026-10-28T16:00:00.000Z',
      type: 'app.response',
      view_id: t.view.view_id,
      request_id: rid,
      state: 'failed',
      error: { code: 'agent_declined', message: 'Claude said no.' },
    })
    t.host.handleResponse(frame)
    expect(t.replies(1)[0]?.error).toEqual({
      code: -32000,
      message: 'Claude said no.',
      data: { talos: 'agent_declined' },
    })
  })

  it('pending_card keeps waiting and says so; done clears it', async () => {
    const onChange = vi.fn()
    const t = makeHost({ onChange })
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    expect(t.host.status).toBe('agent')
    const rid = String(t.sent[0]?.request_id)
    t.host.handleResponse({ view_id: t.view.view_id, request_id: rid, state: 'pending_card' })
    expect(t.host.status).toBe('approval')
    expect(t.replies(1)).toEqual([])
    t.host.handleResponse({ view_id: t.view.view_id, request_id: rid, state: 'done', result: { content: [] } })
    expect(t.host.status).toBe('idle')
  })

  it('progress heartbeats every 20 s only with a progressToken, and stop on the answer', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'slow', _meta: { progressToken: 'tok' } }))
    t.say(t.req(2, 'tools/call', { name: 'quiet' }))
    vi.advanceTimersByTime(19_999)
    expect(t.methods()).not.toContain('notifications/progress')
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(20_000)
    const beats = t.posted.filter((m) => m.method === 'notifications/progress')
    expect(beats.map((b) => b.params)).toEqual([
      { progressToken: 'tok', progress: 1 },
      { progressToken: 'tok', progress: 2 },
    ])
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(t.sent[0]?.request_id),
      state: 'done',
      result: { content: [] },
    })
    vi.advanceTimersByTime(60_000)
    expect(t.posted.filter((m) => m.method === 'notifications/progress')).toHaveLength(2)
  })

  it('no answer by the derived 13 minute ceiling fails with timeout, not before', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    vi.advanceTimersByTime(13 * 60_000 - 1)
    expect(t.replies(1)).toEqual([])
    vi.advanceTimersByTime(1)
    expect(t.replies(1)[0]?.error).toMatchObject({ code: -32000, data: { talos: 'timeout' } })
    expect(t.host.status).toBe('idle')
  })

  it('a request the relay refuses (offline, not pinned, bad frame) fails once with a Talos code', async () => {
    const err = Object.assign(new Error('x'), { code: 'mac_offline' })
    const t = makeHost({ sendRequest: () => Promise.reject(err) })
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    await t.flush()
    expect(t.replies(1)).toHaveLength(1)
    expect(t.replies(1)[0]?.error).toMatchObject({ data: { talos: 'mac_offline' } })
    const odd = makeHost({
      sendRequest: () =>
        Promise.reject(Object.assign(new Error('secret detail from the server'), { code: 'bad_frame' })),
    })
    await odd.start()
    odd.say(odd.req(1, 'tools/call', { name: 'a' }))
    await odd.flush()
    const e = odd.replies(1)[0]?.error as { message: string; data: { talos: string } }
    expect(e.data.talos).toBe('tool_failed')
    expect(e.message).not.toMatch(/secret/)
  })

  it('a client with no sendAppRequest (older web build seams) fails the call, it does not hang', async () => {
    const t = makeHost({
      sendRequest: async () => {
        throw new Error('This Talos cannot send app requests yet.')
      },
    })
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    await t.flush()
    expect(t.replies(1)[0]?.error).toMatchObject({ data: { talos: 'tool_failed' } })
  })

  it('the 31st call in a minute is refused locally and never sent; the window reopens', async () => {
    const t = makeHost()
    await t.start()
    for (let i = 1; i <= 31; i++) t.say(t.req(i, 'tools/call', { name: 'a' }))
    expect(t.sent).toHaveLength(30)
    expect(t.replies(31)[0]?.error).toMatchObject({ data: { talos: 'rate_limited' } })
    t.state.mono += 60_001
    t.say(t.req(32, 'tools/call', { name: 'a' }))
    expect(t.sent).toHaveLength(31)
  })

  it('a wall clock that jumps cannot free a rate window, and a monotonic reset cannot lock one', async () => {
    const t = makeHost()
    await t.start()
    t.state.mono = 5000
    for (let i = 1; i <= 30; i++) t.say(t.req(i, 'tools/call', { name: 'a' }))
    t.state.wall += 24 * 3600_000 // the wall clock jumps a day forward: the window is on the monotonic clock
    t.state.wall -= 2 * 24 * 3600_000 // and back
    t.say(t.req(40, 'tools/call', { name: 'a' }))
    expect(t.replies(40)[0]?.error).toMatchObject({ data: { talos: 'rate_limited' } })
    t.state.mono = 0 // clock went backwards: forget, do not lock
    t.say(t.req(41, 'tools/call', { name: 'a' }))
    expect(t.sent).toHaveLength(31)
  })

  it('after calls_until the view cannot call; the wall clock decides, at the boundary', async () => {
    const t = makeHost()
    await t.start()
    t.state.wall = Date.parse(t.view.calls_until)
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    expect(t.sent).toHaveLength(1)
    t.state.wall += 1
    t.say(t.req(2, 'tools/call', { name: 'a' }))
    expect(t.replies(2)[0]?.error).toMatchObject({ data: { talos: 'view_closed' } })
    expect(t.sent).toHaveLength(1)
  })

  it('arguments over 16 KiB are refused as invalid params, never sent', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a', arguments: { blob: 'x'.repeat(17_000) } }))
    expect(t.replies(1)[0]?.error).toMatchObject({ code: RPC_ERR.INVALID_PARAMS })
    expect(t.sent).toEqual([])
  })

  it('a result in media is fetched, parsed and returned; a failed fetch is a tool_failed', async () => {
    const t = makeHost({ fetchResult: async () => ({ content: [{ type: 'text', text: 'BIG' }] }) })
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(t.sent[0]?.request_id),
      state: 'done',
      result_media: { media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T43T' },
    })
    await t.flush()
    expect(t.replies(1)[0]?.result).toEqual({ content: [{ type: 'text', text: 'BIG' }] })
    const bad = makeHost({
      fetchResult: async () => {
        throw new Error('410')
      },
    })
    await bad.start()
    bad.say(bad.req(1, 'tools/call', { name: 'a' }))
    bad.host.handleResponse({
      view_id: bad.view.view_id,
      request_id: String(bad.sent[0]?.request_id),
      state: 'done',
      result_media: { media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T43T' },
    })
    await bad.flush()
    expect(bad.replies(1)[0]?.error).toMatchObject({ data: { talos: 'tool_failed' } })
  })

  it('tool_result_media: fetched after initialized; an unreadable one cancels instead of hanging', async () => {
    const media = {
      media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T43T',
      kind: 'file',
      role: 'attachment',
      mime: 'application/json',
      name: 'r.json',
      size: 1,
      sha256: 'a'.repeat(64),
    }
    const { tool_result: _drop, ...rest } = makeView() as Record<string, unknown>
    const view = makeView({ ...rest, tool_result: undefined, tool_result_media: media })
    const ok = makeHost({ fetchResult: async () => ({ content: [{ type: 'text', text: 'FROM MEDIA' }] }) }, view)
    await ok.start()
    expect(ok.posted.find((m) => m.method === 'ui/notifications/tool-result')?.params).toEqual({
      content: [{ type: 'text', text: 'FROM MEDIA' }],
    })
    const gone = makeHost(
      {
        fetchResult: async () => {
          throw new Error('gone')
        },
      },
      view,
    )
    await gone.start()
    expect(gone.methods()).toContain('ui/notifications/tool-cancelled')
    expect(gone.methods()).not.toContain('ui/notifications/tool-result')
    expect(gone.host.resultFailed).toBe(true)
  })
})

describe('ui/message', () => {
  it('accepts one block or an array, joins text with a newline, signs it', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'ui/message', { role: 'user', content: { type: 'text', text: 'one' } }))
    await t.flush()
    t.say(
      t.req(2, 'ui/message', {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    )
    await t.flush()
    expect(t.sent.map((s) => s.text)).toEqual(['one', 'a\nb'])
    expect(t.sent[0]).toMatchObject({ type: 'app.request', method: 'ui/message', view_id: t.view.view_id })
    t.host.handleResponse({ view_id: t.view.view_id, request_id: String(t.sent[0]?.request_id), state: 'done' })
    expect(t.replies(1)[0]?.result).toEqual({})
  })

  it('failure replies {isError:true} (the SDK result shape), never a JSON-RPC error', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(t.sent[0]?.request_id),
      state: 'failed',
      error: { code: 'agent_declined', message: 'no' },
    })
    expect(t.replies(1)[0]).toMatchObject({ result: { isError: true } })
    expect(t.replies(1)[0]).not.toHaveProperty('error')
  })

  it('a non-text block, an empty one, or 4,001 characters is {isError:true} and never sent', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'image', data: 'x' } }))
    t.say(t.req(2, 'ui/message', { content: { type: 'text', text: '' } }))
    t.say(t.req(3, 'ui/message', { content: { type: 'text', text: 'x'.repeat(4001) } }))
    for (const id of [1, 2, 3]) expect(t.replies(id)[0]).toMatchObject({ result: { isError: true } })
    expect(t.sent).toEqual([])
    t.say(t.req(4, 'ui/message', { content: { type: 'text', text: 'x'.repeat(4000) } }))
    await t.flush()
    expect(t.sent).toHaveLength(1)
  })

  it('the 7th message in a minute is refused', async () => {
    const t = makeHost()
    await t.start()
    for (let i = 1; i <= 7; i++) {
      t.say(t.req(i, 'ui/message', { content: { type: 'text', text: 'x' } }))
      await t.flush()
    }
    expect(t.sent).toHaveLength(6)
    expect(t.replies(7)[0]).toMatchObject({ result: { isError: true } })
  })

  it('waits for the owner: nothing is sent until [Send], then it carries owner_confirmed', async () => {
    const decide: Array<(v: ChipAnswer) => void> = []
    const asked: string[] = []
    const t = makeHost({
      confirmMessage: (text) =>
        new Promise<ChipAnswer>((r) => {
          asked.push(text)
          decide.push(r)
        }),
    })
    t.state.gesture = true // a faked tap changes nothing: the chip decides
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'Order 40 pizzas to 12 Elm St' } }))
    await t.flush()
    expect(asked).toEqual(['Order 40 pizzas to 12 Elm St'])
    expect(t.sent).toEqual([])
    decide[0]?.('allow')
    await t.flush()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toMatchObject({ method: 'ui/message', owner_confirmed: true, user_gesture: true })
  })

  it('[Dismiss] (or a chip that throws) is {isError:true} and nothing is sent', async () => {
    const t = makeHost({ confirmMessage: async () => 'no' })
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    expect(t.replies(1)[0]).toMatchObject({ result: { isError: true } })
    const u = makeHost({ confirmMessage: () => Promise.reject(new Error('gone')) })
    await u.start()
    u.say(u.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await u.flush()
    expect(u.replies(1)[0]).toMatchObject({ result: { isError: true } })
    expect(t.sent.concat(u.sent)).toEqual([])
  })

  it('one chip per view: a second message while one waits is {isError:true} at once, and only the first is sent', async () => {
    const decide: Array<(v: ChipAnswer) => void> = []
    const t = makeHost({ confirmMessage: () => new Promise<ChipAnswer>((r) => decide.push(r)) })
    await t.start()
    for (const id of [1, 2, 3]) t.say(t.req(id, 'ui/message', { content: { type: 'text', text: `m${id}` } }))
    await t.flush()
    expect(decide).toHaveLength(1)
    expect(t.replies(2)[0]).toMatchObject({ result: { isError: true } })
    expect(t.replies(3)[0]).toMatchObject({ result: { isError: true } })
    expect(t.replies(1)).toEqual([])
    decide[0]?.('allow')
    await t.flush()
    expect(t.sent.map((s) => s.text)).toEqual(['m1'])
  })

  it('a view that closes while the chip is up sends nothing', async () => {
    const decide: Array<(v: ChipAnswer) => void> = []
    const t = makeHost({ confirmMessage: () => new Promise<ChipAnswer>((r) => decide.push(r)) })
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    t.host.dispose('disposed')
    decide[0]?.('allow')
    await t.flush()
    expect(t.sent).toEqual([])
  })

  it('the bridge refusing with needs_confirm is {isError:true}', async () => {
    const t = makeHost({ sendRequest: () => Promise.reject(Object.assign(new Error('x'), { code: 'needs_confirm' })) })
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    expect(t.replies(1)[0]).toMatchObject({ result: { isError: true } })
  })

  it('needs_confirm on a tool call reaches the view as its own code with the Talos wording, not tool_failed', async () => {
    const t = makeHost({ sendRequest: () => Promise.reject(Object.assign(new Error('x'), { code: 'needs_confirm' })) })
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'send_it', arguments: {} }))
    await t.flush()
    expect(t.replies(1)[0]?.error).toMatchObject({
      message: 'Tap Send on the card.',
      data: { talos: 'needs_confirm' },
    })
  })

  it('a send the relay refuses is {isError:true}, once', async () => {
    const t = makeHost({ sendRequest: () => Promise.reject(Object.assign(new Error('x'), { code: 'mac_offline' })) })
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    await t.flush()
    expect(t.replies(1)).toHaveLength(1)
    expect(t.replies(1)[0]).toMatchObject({ result: { isError: true } })
  })
})

describe('ui/open-link', () => {
  it('asks first; only [Open] opens, and only an https URL gets that far', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'ui/open-link', { url: 'https://example.com/a?b=1' }))
    t.say(t.req(2, 'ui/open-link', { url: 'javascript:alert(1)' }))
    t.say(t.req(3, 'ui/open-link', { url: 'data:text/html,hi' }))
    t.say(t.req(4, 'ui/open-link', { url: ' https://example.com' }))
    expect(t.state.links).toEqual([])
    expect(t.confirms).toHaveLength(1)
    for (const id of [2, 3, 4]) expect(t.replies(id)[0]?.error).toMatchObject({ code: RPC_ERR.INVALID_PARAMS })
    t.confirms[0]?.(true)
    await t.flush()
    expect(t.state.links).toEqual(['https://example.com/a?b=1'])
    expect(t.replies(1)[0]?.result).toEqual({})
  })

  it('Cancel opens nothing; a second link while the sheet is up is refused', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'ui/open-link', { url: 'https://example.com/1' }))
    t.say(t.req(2, 'ui/open-link', { url: 'https://example.com/2' }))
    expect(t.replies(2)[0]).toMatchObject({ result: { isError: true } })
    t.confirms[0]?.(false)
    await t.flush()
    expect(t.state.links).toEqual([])
    expect(t.replies(1)[0]).toMatchObject({ result: { isError: true } })
  })

  it('7th ask in a minute is refused without a sheet', async () => {
    const t = makeHost()
    await t.start()
    for (let i = 1; i <= 7; i++) {
      t.say(t.req(i, 'ui/open-link', { url: 'https://example.com/' }))
      t.confirms.at(-1)?.(false)
      await t.flush()
    }
    expect(t.confirms).toHaveLength(6)
  })
})

describe('display mode and size', () => {
  it('fullscreen needs the view to have declared it AND a tap on the chip; a gesture alone is nothing; pip never', async () => {
    const asked: number[] = []
    const chip = () => {
      asked.push(1)
      return Promise.resolve<ChipAnswer>('no')
    }
    const noDecl = makeHost({ confirmFullscreen: chip })
    await noDecl.start(['inline'])
    noDecl.state.gesture = true
    noDecl.say(noDecl.req(1, 'ui/request-display-mode', { mode: 'fullscreen' }))
    await noDecl.flush()
    expect(noDecl.replies(1)[0]?.result).toEqual({ mode: 'inline' })

    const gestureOnly = makeHost({ confirmFullscreen: () => new Promise<ChipAnswer>(() => {}) })
    await gestureOnly.start()
    gestureOnly.state.gesture = true // a self-focus makes this true; it must not be enough
    gestureOnly.say(gestureOnly.req(1, 'ui/request-display-mode', { mode: 'fullscreen' }))
    await gestureOnly.flush()
    expect(gestureOnly.state.mode).toBe('inline')
    expect(gestureOnly.replies(1)).toEqual([]) // waiting on the chip, not granted

    const declined = makeHost({ confirmFullscreen: chip })
    await declined.start()
    declined.say(declined.req(1, 'ui/request-display-mode', { mode: 'fullscreen' }))
    await declined.flush()
    expect(declined.replies(1)[0]?.result).toEqual({ mode: 'inline' })
    expect(declined.state.mode).toBe('inline')

    const pip = makeHost({ confirmFullscreen: chip })
    await pip.start()
    pip.state.gesture = true
    pip.say(pip.req(1, 'ui/request-display-mode', { mode: 'pip' }))
    await pip.flush()
    expect(pip.replies(1)[0]?.result).toEqual({ mode: 'inline' })
    expect(asked).toHaveLength(1) // only `declined` ever showed a chip
  })

  it('ui/request-display-mode is limited to 6 a minute, every ask, and a refused ask shows no chip', async () => {
    let chips = 0
    const t = makeHost({
      confirmFullscreen: async () => {
        chips++
        return 'no'
      },
    })
    await t.start()
    for (let i = 1; i <= 8; i++) {
      t.say(t.req(i, 'ui/request-display-mode', { mode: 'fullscreen' }))
      await t.flush()
    }
    expect(chips).toBe(6)
    expect(t.replies(8)[0]?.result).toEqual({ mode: 'inline' })
    t.state.mono += 60_001
    t.say(t.req(9, 'ui/request-display-mode', { mode: 'inline' }))
    await t.flush()
    expect(t.replies(9)[0]?.result).toEqual({ mode: 'inline' })
    expect(chips).toBe(6)
  })

  it('fullscreen after [Allow] switches and sends containerDimensions via host-context-changed; inline restores with no chip', async () => {
    let chips = 0
    const t = makeHost({
      confirmFullscreen: async () => {
        chips++
        return 'allow'
      },
    })
    await t.start()
    t.say(t.req(1, 'ui/request-display-mode', { mode: 'fullscreen' }))
    await t.flush()
    expect(t.replies(1)[0]?.result).toEqual({ mode: 'fullscreen' })
    expect(t.posted.at(-1)).toMatchObject({
      method: 'ui/notifications/host-context-changed',
      params: {
        displayMode: 'fullscreen',
        containerDimensions: { width: 800, height: 500 },
        safeAreaInsets: { top: 1, right: 2, bottom: 3, left: 4 },
      },
    })
    t.say(t.req(2, 'ui/request-display-mode', { mode: 'inline' }))
    await t.flush()
    expect(t.replies(2)[0]?.result).toEqual({ mode: 'inline' })
    expect(t.posted.at(-1)?.params).toMatchObject({
      displayMode: 'inline',
      containerDimensions: { width: 400, maxHeight: 640 },
    })
    expect(t.posted.at(-1)?.params).not.toHaveProperty('safeAreaInsets')
    expect(chips).toBe(1)
  })

  it('a fullscreen chip and a message chip never stack: the second ask is refused at once', async () => {
    const decide: Array<(v: ChipAnswer) => void> = []
    const t = makeHost({ confirmFullscreen: () => new Promise<ChipAnswer>((r) => decide.push(r)) })
    await t.start()
    t.say(t.req(1, 'ui/request-display-mode', { mode: 'fullscreen' }))
    t.say(t.req(2, 'ui/message', { content: { type: 'text', text: 'x' } }))
    t.say(t.req(3, 'ui/request-display-mode', { mode: 'fullscreen' }))
    await t.flush()
    expect(decide).toHaveLength(1)
    expect(t.replies(2)[0]).toMatchObject({ result: { isError: true } })
    expect(t.replies(3)[0]?.result).toEqual({ mode: 'inline' })
  })

  it('[Stop asking] mutes message and fullscreen chips for this host; the asks fail at once and show nothing', async () => {
    let chips = 0
    const t = makeHost({
      confirmMessage: async () => {
        chips++
        return 'mute'
      },
      confirmFullscreen: async () => {
        chips++
        return 'allow'
      },
    })
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    expect(t.replies(1)[0]).toMatchObject({ result: { isError: true } })
    t.say(t.req(2, 'ui/message', { content: { type: 'text', text: 'y' } }))
    t.say(t.req(3, 'ui/request-display-mode', { mode: 'fullscreen' }))
    await t.flush()
    expect(t.replies(2)[0]).toMatchObject({ result: { isError: true } })
    expect(t.replies(3)[0]?.result).toEqual({ mode: 'inline' })
    expect(t.state.mode).toBe('inline')
    expect(chips).toBe(1)
    expect(t.sent).toEqual([])
    // closed and reopened = a new host: asking works again
    const again = makeHost({ confirmMessage: async () => 'allow' })
    await again.start()
    again.say(again.req(1, 'ui/message', { content: { type: 'text', text: 'z' } }))
    await again.flush()
    expect(again.sent.map((s) => s.text)).toEqual(['z'])
  })

  it('muting from a fullscreen chip mutes messages too, and the fullscreen ask is refused', async () => {
    const t = makeHost({ confirmFullscreen: async () => 'mute' })
    await t.start()
    t.say(t.req(1, 'ui/request-display-mode', { mode: 'fullscreen' }))
    await t.flush()
    expect(t.replies(1)[0]?.result).toEqual({ mode: 'inline' })
    t.say(t.req(2, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    expect(t.replies(2)[0]).toMatchObject({ result: { isError: true } })
  })

  it('size-changed is applied while a question sheet is up: the modal backdrop, not a frozen frame, protects Send', async () => {
    const decide: Array<(v: ChipAnswer) => void> = []
    const t = makeHost({ confirmMessage: () => new Promise<ChipAnswer>((r) => decide.push(r)) })
    await t.start()
    t.say(t.note('ui/notifications/size-changed', { height: 400 }))
    t.rafs.shift()?.()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    t.say(t.note('ui/notifications/size-changed', { height: 150 }))
    for (const cb of t.rafs.splice(0)) cb()
    expect(t.state.height).toBe(150)
    decide[0]?.('no')
    await t.flush()
  })

  it('a view torn down with a chip up never applies a later height', async () => {
    const decide: Array<(v: ChipAnswer) => void> = []
    const t = makeHost({ confirmMessage: () => new Promise<ChipAnswer>((r) => decide.push(r)) })
    await t.start()
    t.say(t.req(1, 'ui/message', { content: { type: 'text', text: 'x' } }))
    await t.flush()
    t.say(t.note('ui/notifications/size-changed', { height: 150 }))
    t.host.dispose('disposed')
    decide[0]?.('no')
    await t.flush()
    for (const cb of t.rafs.splice(0)) cb()
    expect(t.state.height).toBe(0)
  })

  it('size-changed clamps to [64, maxHeight], one layout per frame, ignored in fullscreen', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.note('ui/notifications/size-changed', { height: 10 }))
    t.say(t.note('ui/notifications/size-changed', { height: 9999 }))
    t.say(t.note('ui/notifications/size-changed', { height: 300.4 }))
    expect(t.rafs).toHaveLength(1)
    t.rafs.shift()?.()
    expect(t.state.height).toBe(300)
    t.say(t.note('ui/notifications/size-changed', { height: 1 }))
    t.rafs.shift()?.()
    expect(t.state.height).toBe(64)
    t.say(t.note('ui/notifications/size-changed', { height: 9999 }))
    t.rafs.shift()?.()
    expect(t.state.height).toBe(640)
    t.state.mode = 'fullscreen'
    t.say(t.note('ui/notifications/size-changed', { height: 200 }))
    expect(t.rafs).toHaveLength(0)
    t.say(t.note('ui/notifications/size-changed', { height: Number.NaN }))
    t.say(t.note('ui/notifications/size-changed', { height: -5 }))
    expect(t.rafs).toHaveLength(0)
  })
})

describe('log, navigation and teardown', () => {
  it('notifications/message keeps 200 x 1 KiB and drops past 60 a minute, never leaving the device', async () => {
    const t = makeHost()
    await t.start()
    for (let i = 0; i < 65; i++) t.say(t.note('notifications/message', { level: 'info', data: `m${i}` }))
    expect(t.host.log).toHaveLength(60)
    expect(t.host.logDropped).toBe(5)
    t.state.mono += 60_001
    t.say(t.note('notifications/message', { data: 'y'.repeat(5000) }))
    expect(t.host.log.at(-1)?.text).toHaveLength(1024)
    expect(t.sent).toEqual([])
    const big = makeHost()
    await big.start()
    for (let r = 0; r < 5; r++) {
      for (let i = 0; i < 60; i++) big.say(big.note('notifications/message', { data: `r${r}-${i}` }))
      big.state.mono += 60_001
    }
    expect(big.host.log).toHaveLength(200)
    expect(big.host.log[0]?.text).toBe('r1-40')
  })

  it('a second frame load tears the view down: no more messages, no more requests', async () => {
    const onChange = vi.fn()
    const t = makeHost({ onChange })
    t.host.onFrameLoad()
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a' }))
    t.host.onFrameLoad()
    expect(t.host.phase).toBe('closed')
    expect(t.host.closedReason).toBe('navigated')
    t.say(t.req(2, 'tools/call', { name: 'a' }))
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(t.sent[0]?.request_id),
      state: 'done',
      result: { content: [] },
    })
    expect(t.sent).toHaveLength(1)
    expect(t.replies(1)).toEqual([])
    vi.advanceTimersByTime(14 * 60_000)
    expect(t.replies(1)).toEqual([])
  })

  it('the first load alone is normal (a view starts before it loads)', async () => {
    const t = makeHost()
    await t.start() // handshake before any load event
    t.host.onFrameLoad()
    expect(t.host.phase).toBe('ready')
  })

  it('teardown tells the view first and waits at most 500 ms for the answer', async () => {
    const t = makeHost()
    await t.start()
    const done = t.host.teardown()
    expect(t.posted.at(-1)).toMatchObject({ method: 'ui/resource-teardown' })
    expect(t.host.phase).toBe('ready')
    vi.advanceTimersByTime(499)
    expect(t.host.phase).toBe('ready')
    vi.advanceTimersByTime(1)
    await done
    expect(t.host.phase).toBe('closed')

    const quick = makeHost()
    await quick.start()
    const q = quick.host.teardown()
    const td = quick.posted.at(-1) as { id: string }
    quick.say({ jsonrpc: '2.0', id: td.id, result: {} })
    await q
    expect(quick.host.phase).toBe('closed')
  })

  it('request-teardown from the view closes it', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.note('ui/notifications/request-teardown', {}))
    vi.advanceTimersByTime(500)
    await t.flush()
    expect(t.host.closedReason).toBe('teardown')
  })

  it('pagehide teardown is best effort and immediate', async () => {
    const t = makeHost()
    await t.start()
    t.host.teardownNow()
    expect(t.methods()).toContain('ui/resource-teardown')
    expect(t.host.phase).toBe('closed')
  })

  it('disposing with a request open sends the view nothing and leaves no timer behind', async () => {
    const t = makeHost()
    await t.start()
    t.say(t.req(1, 'tools/call', { name: 'a', _meta: { progressToken: 1 } }))
    const before = t.posted.length
    t.host.dispose()
    vi.advanceTimersByTime(20 * 60_000)
    expect(t.posted.length).toBe(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failing postMessage (the frame is gone) does not throw', async () => {
    const t = makeHost()
    await t.start()
    t.win.postMessage.mockImplementation(() => {
      throw new Error('detached')
    })
    expect(() => t.say(t.req(1, 'ping'))).not.toThrow()
  })
})

// MCP Apps: the view -> host message parser (a view is third-party code; nothing here may throw).
import { describe, expect, it } from 'vitest'
import {
  APP_MESSAGE_MAX_CHARS,
  parseViewMessage,
  RPC_ERR,
  UiInitializeResult,
  UiMessageParams,
  uiMessageText,
  VIEW_METHODS,
} from '../src/index.ts'

const call = (method: string, params?: unknown, id: string | number | null = 1) => ({
  jsonrpc: '2.0',
  method,
  ...(id === null ? {} : { id }),
  ...(params === undefined ? {} : { params }),
})

describe('parseViewMessage', () => {
  it('parses each supported method with its real shape', () => {
    const ok = (m: unknown) => parseViewMessage(m)
    expect(
      ok(
        call('ui/initialize', {
          protocolVersion: '2026-01-26',
          appInfo: { name: 'a', version: '1' },
          appCapabilities: { availableDisplayModes: ['inline'] },
        }),
      ),
    ).toMatchObject({ ok: true, kind: 'request', method: 'ui/initialize' })
    expect(ok(call('ui/notifications/initialized', {}, null))).toMatchObject({ ok: true, kind: 'notification' })
    expect(ok(call('ping'))).toMatchObject({ ok: true, kind: 'request' })
    expect(
      ok(call('tools/call', { name: 'read_note', arguments: { id: 'n1' }, _meta: { progressToken: 'p' } })),
    ).toMatchObject({ ok: true, method: 'tools/call' })
    expect(ok(call('ui/message', { role: 'user', content: { type: 'text', text: 'hi' } }))).toMatchObject({ ok: true })
    expect(ok(call('ui/open-link', { url: 'https://example.com/a' }))).toMatchObject({ ok: true })
    expect(ok(call('ui/request-display-mode', { mode: 'fullscreen' }))).toMatchObject({ ok: true })
    expect(ok(call('ui/notifications/size-changed', { width: 10, height: 20 }, null))).toMatchObject({
      ok: true,
      kind: 'notification',
    })
    expect(ok(call('ui/notifications/request-teardown', {}, null))).toMatchObject({ ok: true })
    expect(ok(call('notifications/message', { level: 'info', data: 'x' }, null))).toMatchObject({ ok: true })
    expect(Object.keys(VIEW_METHODS)).toHaveLength(10)
  })

  it.each([null, 5, 'x', [], undefined, true])('drops a non-object %s without a reply', (v) => {
    expect(parseViewMessage(v)).toMatchObject({ ok: false, drop: true })
  })

  it('drops a message that is not JSON-RPC 2.0, or has a bad id', () => {
    expect(parseViewMessage({ method: 'ping', id: 1 })).toMatchObject({ ok: false, drop: true })
    expect(parseViewMessage({ jsonrpc: '1.0', method: 'ping', id: 1 })).toMatchObject({ ok: false, drop: true })
    expect(parseViewMessage({ jsonrpc: '2.0', id: 1 })).toMatchObject({ ok: false, drop: true })
    expect(parseViewMessage({ jsonrpc: '2.0', method: 'ping', id: { a: 1 } })).toMatchObject({ ok: false, drop: true })
    expect(parseViewMessage({ jsonrpc: '2.0', method: 'ping', id: null })).toMatchObject({ ok: false, drop: true })
  })

  it('drops over 256 KiB and an unmeasurable payload (cycle, bigint)', () => {
    expect(
      parseViewMessage(call('notifications/message', { data: 'x'.repeat(APP_MESSAGE_MAX_CHARS) }, null)),
    ).toMatchObject({ ok: false, drop: true })
    const cyc: Record<string, unknown> = { jsonrpc: '2.0', method: 'ping', id: 1 }
    cyc.self = cyc
    expect(parseViewMessage(cyc)).toMatchObject({ ok: false, drop: true })
    expect(parseViewMessage({ jsonrpc: '2.0', method: 'ping', id: 1, params: { n: 1n } })).toMatchObject({
      ok: false,
      drop: true,
    })
  })

  it('unknown method is -32601, with the id when it asked a question', () => {
    expect(parseViewMessage(call('resources/read', {}, 7))).toEqual({
      ok: false,
      id: 7,
      code: RPC_ERR.METHOD_NOT_FOUND,
      message: 'method not found',
    })
    expect(parseViewMessage(call('sampling/createMessage', {}, null))).toMatchObject({
      ok: false,
      code: -32601,
      drop: true,
    })
    for (const m of ['__proto__', 'toString', 'constructor', 'hasOwnProperty'])
      expect(parseViewMessage(call(m, {}, 1))).toMatchObject({ ok: false, code: -32601, id: 1 })
  })

  it('bad params are -32602 (with the id for requests)', () => {
    expect(parseViewMessage(call('tools/call', {}, 3))).toMatchObject({
      ok: false,
      id: 3,
      code: RPC_ERR.INVALID_PARAMS,
    })
    expect(parseViewMessage(call('tools/call', { name: '' }, 3))).toMatchObject({ ok: false, code: -32602 })
    expect(parseViewMessage(call('tools/call', { name: 'x'.repeat(129) }, 3))).toMatchObject({
      ok: false,
      code: -32602,
    })
    expect(
      parseViewMessage(call('tools/call', { name: 'a', arguments: { x: 'y'.repeat(17 * 1024) } }, 3)),
    ).toMatchObject({ ok: false, code: -32602 })
    expect(parseViewMessage(call('ui/request-display-mode', { mode: 'pip2' }, 4))).toMatchObject({
      ok: false,
      code: -32602,
    })
    expect(parseViewMessage(call('ui/notifications/size-changed', { width: -1 }, null))).toMatchObject({
      ok: false,
      drop: true,
    })
    expect(
      parseViewMessage(call('ui/notifications/size-changed', { width: Number.POSITIVE_INFINITY }, null)),
    ).toMatchObject({ ok: false })
  })

  it('open-link takes https/http only: javascript:, data:, file: and whitespace tricks are refused', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      ' https://example.com',
      'https://exa\nmple.com',
      'tauri://x',
    ])
      expect(parseViewMessage(call('ui/open-link', { url }, 5)), url).toMatchObject({ ok: false, code: -32602 })
  })

  it('a request sent without an id, or a notification sent with one, is dropped', () => {
    expect(parseViewMessage(call('tools/call', { name: 'a' }, null))).toMatchObject({ ok: false, drop: true })
    expect(parseViewMessage(call('ui/notifications/size-changed', { width: 1 }, 9))).toMatchObject({
      ok: false,
      drop: true,
    })
  })

  it('is stable when two views talk at once (pure)', async () => {
    const outs = await Promise.all(
      Array.from({ length: 200 }, async (_, i) =>
        parseViewMessage(call('tools/call', { name: 'a', arguments: { i } }, i)),
      ),
    )
    for (const [i, o] of outs.entries()) expect(o).toMatchObject({ ok: true, id: i })
  })
})

describe('ui/message text', () => {
  const text = (content: unknown) => {
    const p = UiMessageParams.safeParse({ content })
    return p.success ? uiMessageText(p.data) : 'PARSE_FAIL'
  }
  it('takes one block or an array, joins text blocks with a newline', () => {
    expect(text({ type: 'text', text: 'a' })).toBe('a')
    expect(
      text([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb')
  })
  it('refuses non-text blocks, empty text and over 4,000 characters, never trims', () => {
    expect(text({ type: 'image', data: 'x' })).toBeUndefined()
    expect(text([{ type: 'text', text: 'a' }, { type: 'resource' }])).toBeUndefined()
    expect(text({ type: 'text', text: '' })).toBeUndefined()
    expect(text({ type: 'text', text: 'x'.repeat(4001) })).toBeUndefined()
    expect(text({ type: 'text', text: 'x'.repeat(4000) })).toHaveLength(4000)
    expect(text('just a string')).toBe('PARSE_FAIL')
  })
})

describe('UiInitializeResult', () => {
  const good = () => ({
    protocolVersion: '2026-01-26',
    hostInfo: { name: 'talos-app', version: '0.1.0' },
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      logging: {},
      message: { text: {} },
      sandbox: { permissions: {}, csp: { connectDomains: [] } },
    },
    hostContext: { theme: 'dark', displayMode: 'inline' },
  })
  it('accepts the M2.4 shape and tolerates additions', () => {
    expect(UiInitializeResult.safeParse(good()).success).toBe(true)
    expect(UiInitializeResult.safeParse({ ...good(), future: 1 }).success).toBe(true)
  })
  it('refuses a wrong protocol version or host name', () => {
    expect(UiInitializeResult.safeParse({ ...good(), protocolVersion: '2025-01-01' }).success).toBe(false)
    expect(UiInitializeResult.safeParse({ ...good(), hostInfo: { name: 'other', version: '1' } }).success).toBe(false)
  })
})

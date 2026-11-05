// @vitest-environment jsdom
// The REAL view library (ext-apps App + PostMessageTransport, a test-only devDependency, nothing from it ships) talking
// to our host. If the host's handshake or any reply were off by a key, this App would reject it.
import {
  App,
  McpUiHostStylesSchema,
  McpUiInitializeResultSchema,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps'
import { describe, expect, it, vi } from 'vitest'
import { buildInitializeResult } from '../../src/features/apps/host.ts'
import { TOKEN_MAP } from '../../src/features/apps/host-styles.ts'
import { makeHost, makeView } from './helpers.ts'

const variables = Object.fromEntries([
  ...TOKEN_MAP.map(([spec]) => [spec, '#123456']),
  ['--font-sans', 'system-ui, -apple-system, sans-serif'],
  ['--font-mono', 'ui-monospace, monospace'],
])

const initOpts = (view = makeView()) => ({
  csp: view.csp,
  theme: 'dark' as const,
  variables,
  width: 400,
  maxHeight: 640,
  locale: 'en-US',
  phone: true,
  touch: true,
  hover: false,
  appVersion: '1.2.3',
})

describe('M2.4 / M2.5 against the SDK schemas', () => {
  it('the ui/initialize result parses with McpUiInitializeResultSchema and equals M2.4', () => {
    const view = makeView()
    const result = buildInitializeResult(initOpts(view))
    expect(McpUiInitializeResultSchema.safeParse(result).success).toBe(true)
    expect(result).toEqual({
      protocolVersion: '2026-01-26',
      hostInfo: { name: 'talos-app', version: '1.2.3' },
      hostCapabilities: {
        openLinks: {},
        serverTools: {},
        logging: {},
        message: { text: {} },
        sandbox: {
          permissions: {},
          csp: {
            connectDomains: ['https://api.example.com'],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
        },
      },
      hostContext: {
        theme: 'dark',
        styles: { variables },
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
        containerDimensions: { width: 400, maxHeight: 640 },
        locale: 'en-US',
        platform: 'mobile',
        deviceCapabilities: { touch: true, hover: false },
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/timeZone|userAgent|toolInfo|safeAreaInsets/)
  })

  it('every M2.5 key is in the SDK style-variable union; a misspelled key fails (control)', () => {
    for (const [spec] of TOKEN_MAP) {
      expect(McpUiHostStylesSchema.safeParse({ variables: { [spec]: '#fff' } }).success, spec).toBe(true)
    }
    expect(McpUiHostStylesSchema.safeParse({ variables: { '--font-sans': 'x', '--font-mono': 'y' } }).success).toBe(
      true,
    )
    expect(McpUiHostStylesSchema.safeParse({ variables: { '--color-backround-primary': '#fff' } }).success).toBe(false)
  })

  it('maps exactly the M2.5 table', () => {
    const m = Object.fromEntries(TOKEN_MAP)
    expect(m['--color-background-primary']).toBe('--surface')
    expect(m['--color-background-tertiary']).toBe('--bg')
    expect(m['--color-border-secondary']).toBe('--hairline')
    expect(m['--color-ring-primary']).toBe('--focus')
    expect(m['--border-radius-md']).toBe('--radius-card')
    expect(m['--border-radius-full']).toBe('--radius-pill')
    expect(TOKEN_MAP).toHaveLength(24)
  })
})

describe('the real SDK App against the host', () => {
  async function connect(over: Parameters<typeof makeHost>[0] = {}) {
    const t = makeHost(over)
    // The view's "parent": messages the App sends reach the host with the frame's window as source; what the host
    // posts comes back to the App as a message event whose source is `window` (the transport's expected source).
    const parent = { postMessage: (msg: unknown) => t.host.handleMessage(t.win, msg) } as unknown as Window
    t.win.postMessage.mockImplementation((msg: unknown) => {
      t.posted.push(msg as Record<string, unknown>)
      queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: msg, source: window })))
    })
    const app = new App(
      { name: 'probe', version: '1' },
      { availableDisplayModes: ['inline', 'fullscreen'] },
      { autoResize: false },
    )
    const input = vi.fn()
    const result = vi.fn()
    const ctx = vi.fn()
    app.ontoolinput = input
    app.ontoolresult = result
    app.onhostcontextchanged = ctx
    await app.connect(new PostMessageTransport(parent, window))
    return { t, app, input, result, ctx }
  }

  it('handshakes, then delivers tool-input and tool-result once', async () => {
    const { t, app, input, result } = await connect()
    expect(app.getHostContext()?.theme).toBe('light')
    expect(app.getHostCapabilities()?.serverTools).toBeDefined()
    await vi.waitFor(() => expect(result).toHaveBeenCalledTimes(1))
    expect(input).toHaveBeenCalledWith({ arguments: t.view.tool_input })
    expect(result.mock.calls[0]?.[0]).toMatchObject({ content: t.view.tool_result?.content })
    expect(input).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('callServerTool: a signed-shape app.request out, the Mac answer back as the SDK result', async () => {
    const { t, app } = await connect()
    const call = app.callServerTool({ name: 'read_note', arguments: { id: 'n1' } })
    await vi.waitFor(() => expect(t.sent).toHaveLength(1))
    expect(t.sent[0]).toMatchObject({ method: 'tools/call', tool_name: 'read_note', arguments: { id: 'n1' } })
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(t.sent[0]?.request_id),
      state: 'done',
      result: { content: [{ type: 'text', text: 'Buy milk' }] },
    })
    expect(await call).toMatchObject({ content: [{ type: 'text', text: 'Buy milk' }] })
    await app.close()
  })

  it('callServerTool failure rejects with the Talos code in the error data', async () => {
    const { t, app } = await connect()
    const call = app.callServerTool({ name: 'read_note', arguments: {} })
    await vi.waitFor(() => expect(t.sent).toHaveLength(1))
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(t.sent[0]?.request_id),
      state: 'failed',
      error: { code: 'owner_killed', message: 'You declined.' },
    })
    await expect(call).rejects.toMatchObject({ data: { talos: 'owner_killed' } })
    await app.close()
  })

  it('sendMessage resolves {isError:true} on failure (an SDK that read -32000 would throw)', async () => {
    const { t, app } = await connect()
    const p = app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello agent' }] })
    await vi.waitFor(() => expect(t.sent).toHaveLength(1))
    expect(t.sent[0]).toMatchObject({ method: 'ui/message', text: 'hello agent' })
    t.host.handleResponse({
      view_id: t.view.view_id,
      request_id: String(t.sent[0]?.request_id),
      state: 'failed',
      error: { code: 'mac_offline', message: 'x' },
    })
    await expect(p).resolves.toMatchObject({ isError: true })
    await app.close()
  })

  it('openLink waits for the owner; display mode and host-context-changed reach the App', async () => {
    const { t, app, ctx } = await connect()
    const link = app.openLink({ url: 'https://docs.example.com/x' })
    await vi.waitFor(() => expect(t.confirms).toHaveLength(1))
    t.confirms[0]?.(true)
    await expect(link).resolves.toBeTruthy()
    expect(t.state.links).toEqual(['https://docs.example.com/x'])

    const mode = await app.requestDisplayMode({ mode: 'fullscreen' })
    expect(mode.mode).toBe('fullscreen')
    await vi.waitFor(() => expect(ctx).toHaveBeenCalled())
    expect(ctx.mock.calls.at(-1)?.[0]).toMatchObject({
      displayMode: 'fullscreen',
      containerDimensions: { width: 800, height: 500 },
    })
    await app.close()
  })

  it('teardown: the App answers ui/resource-teardown and the host closes', async () => {
    const { t, app } = await connect()
    const seen = vi.fn()
    app.onteardown = async () => {
      seen()
      return {}
    }
    await t.host.teardown()
    expect(seen).toHaveBeenCalled()
    expect(t.host.phase).toBe('closed')
    await app.close()
  })
})

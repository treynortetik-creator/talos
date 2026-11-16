// The screen tools against a fake screen socket: the real client (src/screen.ts) over a real Unix socket, answered the way
// TalosDesktopCore's ScreenSocket answers. Every failure must come back at once as one sentence, never a wait or an empty
// success. The Mac app is not needed: the socket lives in a temp home under /tmp (socket paths are short on macOS).
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { BridgeContext } from '../src/context.ts'
import { parseAnswer, refusalText, SCREEN_TEXT, screenRequest, screenSockPath } from '../src/screen.ts'
import { callTool } from '../src/tools/index.ts'
import { SCREEN_TOOL_RECORDS, screenTransport } from '../src/tools/screen.ts'
import { SCREEN_BRIDGE_TOOLS } from '../src/tools/table.ts'

const homes: string[] = []
const servers: Server[] = []
/** Every connection a fake server took: close() waits for them all, and one the client gave up on may never end by itself. */
const conns: Socket[] = []
afterEach(async () => {
  for (const c of conns.splice(0)) c.destroy()
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
  screenTransport.request = original
})
const original = screenTransport.request

function home(): string {
  const h = mkdtempSync('/tmp/tsb-')
  homes.push(h)
  mkdirSync(join(h, 'run'), { mode: 0o700 })
  return h
}

/** A fake screen socket: `answer` gets each request object and returns the line to send (or null to say nothing). */
async function fakeSocket(
  h: string,
  answer: (req: Record<string, unknown>) => string | null,
): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = []
  const server = createServer((sock) => {
    conns.push(sock)
    let buf = ''
    sock.on('data', (b) => {
      buf += b.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      buf = buf.slice(nl + 1)
      seen.push(req)
      const out = answer(req)
      if (out !== null) sock.write(`${out}\n`)
    })
    sock.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(screenSockPath(h), () => r()))
  return seen
}

const mac = { platform: 'darwin' }
const err = (code: string, text = '', app?: string) =>
  JSON.stringify({ v: 1, ok: false, error: { code, text, ...(app ? { app } : {}) } })

/** A context with only what the screen tools read; calls go through the real callTool and the real client, forced to darwin. */
function ctxFor(h: string): BridgeContext {
  screenTransport.request = (_ctx, req) => screenRequest(h, req, mac)
  return {
    env: { scheduler: 'auto', apps: false },
    mode: 'live',
    superseded: false,
    paths: { home: h },
  } as unknown as BridgeContext
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')

describe('the screen client', () => {
  test('no socket: the app is not running, said at once', async () => {
    const t0 = Date.now()
    const a = await screenRequest(home(), { op: 'apps' }, mac)
    expect(a).toEqual({ ok: false, code: 'not_running', text: '' })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(refusalText(a as never)).toBe(
      "Talos.app isn't running on this Mac, so the screen tools can't work right now. Nothing was done.",
    )
  })

  test('a path that is not a socket, or a socket of another user, is refused before connecting', async () => {
    const h = home()
    writeFileSync(screenSockPath(h), 'x')
    expect(await screenRequest(h, { op: 'apps' }, mac)).toEqual({ ok: false, code: 'not_running', text: '' })
    const h2 = home()
    const seen = await fakeSocket(h2, () => JSON.stringify({ v: 1, ok: true, apps: [] }))
    const other = (process.getuid?.() ?? 0) + 1
    const a = await screenRequest(h2, { op: 'apps' }, { ...mac, uid: other })
    expect(a).toEqual({ ok: false, code: 'not_ours', text: '' })
    expect(seen).toEqual([])
    expect(refusalText(a as never)).toBe(
      "The screen socket on this Mac isn't Talos's own (another user owns it), so nothing was sent.",
    )
  })

  test('not a Mac: refused without touching anything', async () => {
    const a = await screenRequest(home(), { op: 'apps' }, { platform: 'linux' })
    expect(refusalText(a as never)).toBe('The screen tools work only on a Mac running Talos.app. Nothing was done.')
  })

  test('an app that never answers: the timeout, as a sentence', async () => {
    const h = home()
    await fakeSocket(h, () => null)
    const t0 = Date.now()
    const a = await screenRequest(h, { op: 'shot' }, { ...mac, timeoutMs: 200 })
    expect(a).toEqual({ ok: false, code: 'no_answer', text: '' })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(refusalText(a as never)).toBe(
      "Talos.app didn't answer within 15 s. The action may or may not have happened; take a screenshot to check.",
    )
  })

  test('junk, an answer too big, or a close without an answer are never a success', async () => {
    for (const line of ['not json', '[1]', '{"ok":"yes"}', '{"ok":false}', '{"ok":false,"error":{"code":5}}'])
      expect(parseAnswer(line)).toEqual({ ok: false, code: 'bad_answer', text: '' })
    const h = home()
    await fakeSocket(h, () => JSON.stringify({ v: 1, ok: true, png_base64: 'A'.repeat(5000) }))
    expect((await screenRequest(h, { op: 'shot' }, { ...mac, maxBytes: 1000 })).ok).toBe(false)
    const h2 = home()
    const s = createServer((sock) => {
      conns.push(sock)
      sock.end()
    })
    servers.push(s)
    await new Promise<void>((r) => s.listen(screenSockPath(h2), () => r()))
    expect(await screenRequest(h2, { op: 'apps' }, mac)).toEqual({ ok: false, code: 'bad_answer', text: '' })
  })

  test('the request carries v 1 and its fields; unknown fields of the answer are kept and ignored', async () => {
    const h = home()
    const seen = await fakeSocket(h, () => JSON.stringify({ v: 1, ok: true, apps: [], later: { x: 1 } }))
    const a = await screenRequest(h, { op: 'apps' }, mac)
    expect(a.ok).toBe(true)
    expect(seen).toEqual([{ v: 1, op: 'apps' }])
  })
})

describe('refusal texts, word for word', () => {
  test('the codes Talos words itself', () => {
    expect(refusalText({ code: 'screen_recording_not_granted', text: 'the app says' })).toBe(
      "macOS hasn't allowed Talos to see the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck.",
    )
    expect(refusalText({ code: 'accessibility_not_granted', text: '' })).toBe(
      "macOS hasn't allowed Talos to control the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck.",
    )
    expect(refusalText({ code: 'app_not_allowed', text: '', app: 'com.example.notes' })).toBe(
      "com.example.notes isn't on this Mac's allowed list yet.",
    )
    expect(refusalText({ code: 'app_not_allowed', text: '' })).toBe("That app isn't on this Mac's allowed list yet.")
    expect(refusalText({ code: 'filter_unavailable', text: '' })).toBe(
      "Talos couldn't limit the screenshot to the apps allowed on this Mac, so it took no screenshot. Nothing was shown.",
    )
    expect(
      refusalText({ code: 'filter_unavailable', text: 'Talos could not limit it (x), so it took no screenshot.' }),
    ).toBe('Talos could not limit it (x), so it took no screenshot.')
  })

  test('an unknown code from a newer app degrades to its text, or a plain line', () => {
    expect(refusalText({ code: 'future_thing', text: 'Something new\nhappened.' })).toBe('Something new happened.')
    expect(refusalText({ code: 'future_thing', text: '' })).toBe(
      'The screen helper refused (future_thing). Nothing was done.',
    )
    expect(refusalText({ code: 'x', text: 'y'.repeat(1000) }).length).toBe(300)
  })

  test('every code the bridge words is one the Mac app sends', () => {
    const swift = ['ScreenCore.swift', 'ScreenServer.swift', 'ScreenSocket.swift']
      .map((f) => readFileSync(join(import.meta.dir, '../../desktop/Sources/TalosDesktopCore', f), 'utf8'))
      .join('\n')
    for (const code of [
      'screen_recording_not_granted',
      'accessibility_not_granted',
      'app_not_allowed',
      'filter_unavailable',
    ])
      expect(swift).toContain(`"${code}"`)
    expect(swift).toContain('"/run/screen.sock"')
    expect(screenSockPath('/h')).toBe('/h/run/screen.sock')
    // the texts the app itself sends for the grants match the bridge's, so an old bridge reads the same words
    expect(swift).toContain(SCREEN_TEXT.screenGrant)
    expect(swift).toContain(SCREEN_TEXT.controlGrant)
  })
})

describe('the tools, through callTool', () => {
  test('screen_shot answers an image and the mapping to screen points', async () => {
    const h = home()
    const seen = await fakeSocket(h, () =>
      JSON.stringify({
        v: 1,
        ok: true,
        png_base64: 'iVBORw0KGgo=',
        width: 1568,
        height: 980,
        area: { x: 0, y: 0, width: 3136, height: 1960 },
        shown_apps: ['com.example.notes'],
        hidden_windows: 3,
      }),
    )
    const r = await callTool(ctxFor(h), 'screen_shot', {})
    expect(r.isError).toBeUndefined()
    expect(r.content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })
    expect(r.content[1]?.type).toBe('text')
    expect(textOf(r)).toBe(
      "Screenshot 1568×980 pixels of the screen area x 0, y 0, width 3136, height 1960 (points). To click a pixel (px, py): screen_click x = 0 + px × 2, y = 0 + py × 2. Shows: com.example.notes. 3 windows are blank: their apps aren't on this Mac's allowed list yet.",
    )
    expect(seen).toEqual([{ v: 1, op: 'shot', area: { kind: 'full' } }])
    await callTool(ctxFor(h), 'screen_shot', { region: { x: 1, y: 2, width: 3, height: 4 } })
    await callTool(ctxFor(h), 'screen_shot', { display_id: 2 })
    expect(seen.slice(1)).toEqual([
      { v: 1, op: 'shot', area: { kind: 'region', x: 1, y: 2, width: 3, height: 4 } },
      { v: 1, op: 'shot', area: { kind: 'display', id: 2 } },
    ])
  })

  test('a shot with no picture in it is an error, not an empty image', async () => {
    const h = home()
    await fakeSocket(h, () => JSON.stringify({ v: 1, ok: true, width: 1, height: 1 }))
    const r = await callTool(ctxFor(h), 'screen_shot', {})
    expect(r.isError).toBe(true)
    expect(r.content.some((c) => c.type === 'image')).toBe(false)
  })

  test('each input tool sends its op and says what it did', async () => {
    const h = home()
    const seen = await fakeSocket(h, () => JSON.stringify({ v: 1, ok: true, events: 1 }))
    const ctx = ctxFor(h)
    expect(textOf(await callTool(ctx, 'screen_click', { x: 10, y: 20, button: 'right', count: 2 }))).toBe(
      'Clicked at 10, 20.',
    )
    expect(textOf(await callTool(ctx, 'screen_type', { text: 'héllo' }))).toBe('Typed 5 characters.')
    expect(textOf(await callTool(ctx, 'screen_key', { keys: 'cmd+s' }))).toBe('Pressed cmd+s.')
    expect(textOf(await callTool(ctx, 'screen_scroll', { x: 1, y: 2, dy: -40 }))).toBe('Scrolled at 1, 2.')
    expect(textOf(await callTool(ctx, 'screen_open_app', { bundle_id: 'com.example.notes' }))).toBe(
      'Opened com.example.notes.',
    )
    expect(seen).toEqual([
      { v: 1, op: 'click', x: 10, y: 20, button: 'right', count: 2 },
      { v: 1, op: 'type', text: 'héllo' },
      { v: 1, op: 'key', keys: 'cmd+s' },
      { v: 1, op: 'scroll', x: 1, y: 2, dx: 0, dy: -40 },
      { v: 1, op: 'open_app', bundle_id: 'com.example.notes' },
    ])
  })

  test('screen_apps lists the apps and which are allowed', async () => {
    const h = home()
    await fakeSocket(h, () =>
      JSON.stringify({
        v: 1,
        ok: true,
        apps: [
          { name: 'Notes Example', bundle_id: 'com.example.notes', pid: 1, allowed: true },
          { name: 'Loose Tool', pid: 2, allowed: false },
        ],
      }),
    )
    expect(textOf(await callTool(ctxFor(h), 'screen_apps', {}))).toBe(
      'Apps running on this Mac:\n- Notes Example (com.example.notes): allowed\n- Loose Tool',
    )
  })

  test("each refusal reaches the agent as Talos's sentence, flagged as an error", async () => {
    const h = home()
    const answers = [
      err('screen_recording_not_granted', 'x'),
      err('accessibility_not_granted', 'x'),
      err('app_not_allowed', 'x', 'com.example.secret'),
      err('filter_unavailable', ''),
    ]
    await fakeSocket(h, () => answers.shift() ?? null)
    const ctx = ctxFor(h)
    const got = [
      await callTool(ctx, 'screen_shot', {}),
      await callTool(ctx, 'screen_type', { text: 'x' }),
      await callTool(ctx, 'screen_click', { x: 1, y: 1 }),
      await callTool(ctx, 'screen_shot', {}),
    ]
    expect(got.map((r) => r.isError)).toEqual([true, true, true, true])
    expect(got.map(textOf)).toEqual([
      "macOS hasn't allowed Talos to see the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck.",
      "macOS hasn't allowed Talos to control the screen yet. On the Mac: Talos → Permissions → Grant. Nothing is stuck.",
      "com.example.secret isn't on this Mac's allowed list yet.",
      "Talos couldn't limit the screenshot to the apps allowed on this Mac, so it took no screenshot. Nothing was shown.",
    ])
  })

  test('no app running: every tool says so at once', async () => {
    const h = home()
    const ctx = ctxFor(h)
    for (const [name, args] of [
      ['screen_shot', {}],
      ['screen_click', { x: 1, y: 1 }],
      ['screen_type', { text: 'x' }],
      ['screen_key', { keys: 'a' }],
      ['screen_scroll', { x: 1, y: 1, dy: 1 }],
      ['screen_apps', {}],
      ['screen_open_app', { bundle_id: 'com.example.notes' }],
    ] as const) {
      const r = await callTool(ctx, name, args as Record<string, unknown>)
      expect(r.isError, name).toBe(true)
      expect(textOf(r), name).toBe(SCREEN_TEXT.notRunning)
    }
  })

  test('bad arguments are refused before anything is sent', async () => {
    const h = home()
    const seen = await fakeSocket(h, () => JSON.stringify({ v: 1, ok: true }))
    const ctx = ctxFor(h)
    const bad: Array<[string, Record<string, unknown>]> = [
      ['screen_click', { x: '1', y: 2 }],
      ['screen_click', { x: 1, y: 2, count: 'two' }],
      ['screen_type', { text: '' }],
      ['screen_key', {}],
      ['screen_scroll', { x: 1, y: 2, dy: 'up' }],
      ['screen_open_app', { bundle_id: '' }],
      ['screen_shot', { region: { x: 1 } }],
      ['screen_shot', { display_id: 'main' }],
    ]
    for (const [name, args] of bad) {
      const r = await callTool(ctx, name, args)
      expect(r.isError, name).toBe(true)
      expect(textOf(r), name).toEndWith('Nothing was done.')
    }
    expect(seen).toEqual([])
  })

  test('a headless job cannot use them', async () => {
    const h = home()
    const seen = await fakeSocket(h, () => JSON.stringify({ v: 1, ok: true }))
    const ctx = { ...ctxFor(h), mode: 'headless' } as unknown as BridgeContext
    const r = await callTool(ctx, 'screen_type', { text: 'x' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('needs a live session')
    expect(seen).toEqual([])
  })

  test('the records: main and thread sessions, never headless, in the table in this order', () => {
    expect([...SCREEN_BRIDGE_TOOLS]).toEqual([
      'screen_shot',
      'screen_click',
      'screen_type',
      'screen_key',
      'screen_scroll',
      'screen_apps',
      'screen_open_app',
    ])
    for (const t of SCREEN_TOOL_RECORDS) {
      expect(t.headless, t.name).toBe(false)
      expect(t.worker, t.name).toBe(true)
      expect(t.locked, t.name).toBe(false)
    }
  })
})

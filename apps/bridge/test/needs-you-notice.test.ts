// The kit's Notification hook tells the hub a session waits on the owner in a way that has no card (an elicitation dialog): the hub
// posts ONE fixed sentence with an Open terminal action, at most one per kind per thread per ten minutes, and NEVER forwards the notification's own
// text. Real hub and bridge, the real hook (python3) against the real hub socket. No real claude.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { NEEDS_YOU_NOTICE } from '../src/permission/needs-you-words.ts'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

const KIT = join(import.meta.dir, '..', '..', '..', 'kit', 'hooks', 'notification-relay.py')
let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function start() {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      permission_relay: true,
      threads: [
        ...c.threads,
        {
          id: 'trip',
          name: 'Trip',
          kind: 'fixed',
          order: 5,
          notify: 'all',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
    })) as never,
  })
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}

const MARK = 'zq-notification-text-9f3'
const stdin = (type: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 's1',
    transcript_path: '/nonexistent/t.jsonl',
    cwd: '/srv/proj',
    hook_event_name: 'Notification',
    message: `${MARK} Claude is waiting for your input`,
    notification_type: type,
    ...over,
  })
const runHook = async (
  x: Harness,
  type: string,
  env: Record<string, string> = {},
  over: Record<string, unknown> = {},
  home = x.home,
) => {
  const proc = Bun.spawn(['python3', KIT], {
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', TALOS_APP_HOME: home, ...env },
    stdin: new Blob([stdin(type, over)]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  return { code, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() }
}

const general = (x: Harness): string => x.bridge.ctx.config.config.default_thread
const noticesIn = (x: Harness, thread: string): MessageT[] =>
  x.bridge.ctx.store.page({ thread_id: thread, limit: 50 }).messages.filter((m) => m.author === 'system')
const everything = (x: Harness) =>
  JSON.stringify(x.relay.frames.map((f) => f.raw)) + JSON.stringify(noticesIn(x, general(x)))

describe('the Notification hook through the hub', () => {
  test('an elicitation dialog in Main: ONE fixed sentence in the main thread with an Open terminal action; nothing of the notification’s own text goes anywhere', async () => {
    const x = await start()
    const r = await runHook(x, 'elicitation_dialog')
    expect(r).toMatchObject({ code: 0, out: '' })
    await eventually(() => expect(noticesIn(x, general(x))).toHaveLength(1))
    const n = noticesIn(x, general(x))[0] as MessageT
    expect(n.text).toBe(NEEDS_YOU_NOTICE.askMain)
    expect(n.text).toBe('The main agent asked you something at its terminal. Open it to answer.')
    expect(n.actions).toEqual([{ kind: 'open_terminal', thread: 'main' }])
    expect(everything(x)).not.toContain(MARK)
  })

  test('a second one within ten minutes is not told again; ten minutes later it is', async () => {
    const x = await start()
    await runHook(x, 'elicitation_dialog')
    await eventually(() => expect(noticesIn(x, general(x))).toHaveLength(1))
    await runHook(x, 'elicitation_dialog')
    await sleep(t(300)) // timing-ok: negative window: nothing more is posted
    expect(noticesIn(x, general(x))).toHaveLength(1)
    x.bridge.ctx.store.kvSet(`needs_notice:ask:${general(x)}`, String(Date.now() - 11 * 60_000))
    await runHook(x, 'elicitation_dialog')
    await eventually(() => expect(noticesIn(x, general(x))).toHaveLength(2))
  })

  test('an idle prompt (Claude Code sends it after every answered turn), a permission prompt, a sign-in notice or any other type: nothing', async () => {
    const x = await start()
    for (const type of ['idle_prompt', 'permission_prompt', 'auth_success', 'elicitation_complete', 'something_new'])
      expect(await runHook(x, type)).toMatchObject({ code: 0, out: '' })
    await sleep(t(300)) // timing-ok: negative window
    expect(noticesIn(x, general(x))).toHaveLength(0)
  })

  test('the template registers only the elicitation dialog', () => {
    const tpl = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '..', 'kit', 'templates', 'dot-claude', 'settings.json'), 'utf8'),
    )
    const entries = tpl.hooks.Notification as Array<{ matcher: string }>
    expect(entries.map((e) => e.matcher)).toEqual(['elicitation_dialog'])
  })

  test('an unattended run, or another event, says nothing', async () => {
    const x = await start()
    await runHook(x, 'elicitation_dialog', { CLAUDE_CODE_SESSION_ATTENDED: '0' })
    await runHook(x, 'elicitation_dialog', {}, { hook_event_name: 'Stop' })
    await sleep(t(300)) // timing-ok: negative window
    expect(noticesIn(x, general(x))).toHaveLength(0)
  })

  test('its own off switch, TALOS_NOTIFICATION_RELAY_OFF=1; the permission hook’s switch does not stop it', async () => {
    const x = await start()
    await runHook(x, 'elicitation_dialog', { TALOS_NOTIFICATION_RELAY_OFF: '1' })
    await sleep(t(300)) // timing-ok: negative window
    expect(noticesIn(x, general(x))).toHaveLength(0)
    await runHook(x, 'elicitation_dialog', { TALOS_PERMISSION_RELAY_OFF: '1' })
    await eventually(() => expect(noticesIn(x, general(x))).toHaveLength(1))
  })

  test('no bridge to reach: exit 0 at once, no output', async () => {
    const x = await start()
    writeFileSync(join(x.home, 'bridge.pid'), JSON.stringify({ pid: 1, started_at: '', instance: 'other' }))
    expect(await runHook(x, 'elicitation_dialog')).toMatchObject({ code: 0, out: '', err: '' })
    await sleep(t(300)) // timing-ok: negative window
    expect(noticesIn(x, general(x))).toHaveLength(0)
  })

  test('a hub that drips an answer: the hook is gone within its ONE deadline, not one per read', async () => {
    const x = await start()
    const dir = mkdtempSync(join(tmpdir(), 'nh'))
    mkdirSync(join(dir, 'run'))
    writeFileSync(join(dir, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }))
    const socks: Socket[] = []
    const server = createServer((s) => {
      socks.push(s)
      s.on('error', () => {})
      s.on('data', () => {
        // a byte every 300 ms: a per-read timer would be restarted by each one
        const drip = setInterval(() => s.write('x'), 300)
        s.on('close', () => clearInterval(drip))
      })
    })
    await new Promise<void>((r) => server.listen(join(dir, 'run', 'hub.sock'), () => r()))
    const began = Date.now()
    const r = await runHook(x, 'elicitation_dialog', { TALOS_NOTIFICATION_HOOK_WAIT_S: '1' }, {}, dir)
    server.close()
    for (const s of socks) s.destroy()
    rmSync(dir, { recursive: true, force: true })
    expect(r).toMatchObject({ code: 0, out: '' })
    expect(Date.now() - began).toBeLessThan(t(2_500))
  })

  test('a thread session must prove itself: a thread named without the pid and nonce is refused, and nothing is posted', async () => {
    const x = await start()
    const sock = createConnection(join(x.home, 'run', 'hub.sock'))
    const lines: string[] = []
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => lines.push(d))
    sock.on('connect', () =>
      sock.write(`${JSON.stringify({ t: 'notify', id: 'n_1', kind: 'ask', thread_id: 'trip' })}\n`),
    )
    await eventually(() => expect(lines.join('')).toContain('notify_result'))
    expect(lines.join('')).not.toContain('told')
    sock.destroy()
    await sleep(t(200)) // timing-ok: negative window
    expect(noticesIn(x, 'trip')).toHaveLength(0)
  })

  test('a thread session that proves itself gets its notice in ITS thread, naming it, with its own terminal as the action', async () => {
    const x = await start()
    const told = await x.bridge.ctx.needsYou?.tell('ask', 'trip')
    expect(told).toBe('told')
    const n = noticesIn(x, 'trip')[0] as MessageT
    expect(n.text).toBe(NEEDS_YOU_NOTICE.ask('Trip'))
    expect(n.actions).toEqual([{ kind: 'open_terminal', thread: 'trip' }])
  })

  test('a bad notify line on a connection that is already something (a worker’s own link, an open permission request) changes nothing: it is not answered and the socket is not ended', async () => {
    const x = await start()
    const hub = x.bridge.hub as unknown as { onLine(c: unknown, line: string): Promise<void> }
    for (const owner of [{ thread: 'trip' }, { perm: new AbortController() }]) {
      const written: string[] = []
      let ended = false
      const conn = {
        ...owner,
        buf: '',
        sock: {
          destroyed: false,
          write: (s: string) => written.push(s),
          end: () => {
            ended = true
          },
        },
      }
      await hub.onLine(conn, JSON.stringify({ t: 'notify', id: 5, kind: 'nonsense' }))
      expect({ ended, written }).toEqual({ ended: false, written: [] })
    }
  })

  test('a second notify on one connection is ignored (one request per connection)', async () => {
    const x = await start()
    const needs = x.bridge.ctx.needsYou as unknown as { tell: (...a: unknown[]) => Promise<string> }
    let calls = 0
    const real = needs.tell.bind(needs)
    needs.tell = (...a) => {
      calls++
      return real(...a)
    }
    const hub = x.bridge.hub as unknown as { onLine(c: unknown, line: string): Promise<void> }
    const written: string[] = []
    const conn = { buf: '', sock: { destroyed: false, write: (s: string) => written.push(s), end: () => {} } }
    const line = JSON.stringify({ t: 'notify', id: 'n_1', kind: 'ask' })
    await hub.onLine(conn, line)
    await hub.onLine(conn, line)
    expect(calls).toBe(1)
    expect(written).toHaveLength(1)
  })

  test('the words are in the table: neither the hook’s relay nor the notice file writes a sentence of its own', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'permission', 'needs-you-notice.ts'), 'utf8')
    expect(src).not.toMatch(/asked you something|Open it to answer/)
    const py = readFileSync(KIT, 'utf8')
    expect(py).not.toMatch(/\["message"\]|get\("message"\)/) // the notification's text is never read
  })
})

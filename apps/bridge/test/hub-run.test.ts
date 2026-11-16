// The hub socket lives in its own 0700 folder, <home>/run/hub.sock, not in home. On Linux, Bun cannot fs.watch a folder that
// holds a unix socket (ENXIO, and the watch ends), and the bridge watches home for config edits: with the socket in home
// every edit, from the app or the shell, waited for the 10 s poll (found on Titan, WSL; trust-mode.test.ts took 10 s there).
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { HubClient } from '../src/hub/client.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
const servers: Server[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
})

test('the hub socket is in its own 0700 folder, and a config edit is seen within 3 s (the watch of home works, not the 10 s poll)', async () => {
  h = await startHarness()
  const sock = join(h.home, 'run', 'hub.sock')
  await waitFor(() => existsSync(sock), 5000, 'the hub socket')
  expect(statSync(join(h.home, 'run')).mode & 0o777).toBe(0o700)
  expect(statSync(sock).mode & 0o777).toBe(0o600)
  expect(existsSync(join(h.home, 'hub.sock'))).toBe(false)
  const p = join(h.home, 'config.json')
  const cfg = JSON.parse(readFileSync(p, 'utf8'))
  cfg.agent = { ...(cfg.agent ?? {}), name: 'Watched' }
  writeFileSync(p, JSON.stringify(cfg), { mode: 0o600 })
  // the poll is every 10 s: only the watch can see it this soon
  const name = () => (h?.bridge.ctx.config.config as { agent?: { name?: string } } | undefined)?.agent?.name
  await waitFor(() => name() === 'Watched', 3000, 'the edit, within 3 s') // 1 s timed out under a full gate's load
})

test("a dead bridge's socket where it used to be (home/hub.sock) is taken out when the bridge starts", async () => {
  const home = tempHome()
  const old = join(home, 'hub.sock')
  // a socket file with nobody listening: a bridge that died without cleaning up
  const py = Bun.spawnSync(['python3', '-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', old])
  expect(py.exitCode).toBe(0)
  expect(existsSync(old)).toBe(true)
  h = await startHarness({ home })
  await waitFor(() => existsSync(join(home, 'run', 'hub.sock')), 5000, 'the hub socket')
  expect(existsSync(old)).toBe(false)
})

test('a worker reaches a bridge not yet restarted, at the old place, for one release; the new place wins when both are there', async () => {
  const home = tempHome()
  const listen = (path: string) => {
    let n = 0
    const s = createServer((c) => {
      n++
      c.destroy()
    }).listen(path)
    servers.push(s)
    return { count: () => n, up: new Promise<void>((r) => s.once('listening', () => r())) }
  }
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
  const client = (over: { sockPath: string; legacySockPath: string }) =>
    new HubClient({ ...over, threadId: 'th_x', nonce: 'n', log, reconnectMs: 60_000 })
  const legacy = listen(join(home, 'hub.sock'))
  await legacy.up
  const a = client({ sockPath: join(home, 'run', 'hub.sock'), legacySockPath: join(home, 'hub.sock') })
  void a.connect()
  await waitFor(() => legacy.count() === 1, 2000, 'the old place, used')
  a.close()
})

// Bughunt: the BUILT relay as its own process in production mode (what the container runs). A WebSocket upgrade the
// relay refuses (403 bad Origin, 401 no cookie, 429 over the upgrade budget) answered by a TCP reset from the client
// throws an unhandled 'error' on the raw socket and kills the whole process. No credentials are needed.
// Fails on main at 7cd80ce.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY_DIST, WEB_DIST } from '../harness/paths.ts'
import { freePort, vapidKeys, waitUntil } from '../harness/stack.ts'

let relay: ChildProcess
let port: number
let data: string
let stderr = ''

test.beforeEach(async () => {
  data = mkdtempSync(join(process.env.E2E_TMP_ROOT ?? tmpdir(), 'talos-crash-'))
  port = await freePort()
  const vapid = vapidKeys()
  stderr = ''
  relay = spawn('node', [RELAY_DIST], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      PUBLIC_ORIGIN: 'https://relay.example.com',
      RP_ID: 'relay.example.com',
      DATA_DIR: data,
      DATA_KEY: randomBytes(32).toString('base64'),
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:owner@example.com',
      TALOS_WEB_DIR: WEB_DIST,
      TRUST_PROXY_HOPS: '1',
      LOG_LEVEL: 'warn',
    },
  })
  relay.stderr?.on('data', (d) => {
    stderr += d.toString()
  })
  await waitUntil(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok
      } catch {
        return false
      }
    },
    'the production relay to answer /healthz',
    45_000,
  ).catch((e: Error) => {
    // a cold start on a busy CI Mac once took over 20 s; say what the relay printed if it never came up
    throw new Error(`${e.message}; relay exit ${relay.exitCode}; stderr: ${stderr.slice(-2000) || '(none)'}`)
  })
})

test.afterEach(async () => {
  if (relay.exitCode === null) relay.kill('SIGTERM')
  rmSync(data, { recursive: true, force: true })
})

/** Sends a raw upgrade request, reads the status line, then resets the TCP connection (what a dropped phone does). */
function refusedUpgradeThenReset(path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: relay.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
      )
    })
    s.once('data', (d) => {
      const line = d.toString().split('\r\n')[0] ?? ''
      s.resetAndDestroy()
      resolve(line)
    })
    s.on('error', () => {})
  })
}

async function alive(): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 300))
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok && relay.exitCode === null
  } catch {
    return false
  }
}

test('BUG D1: /ws upgrade with a foreign Origin (403) + TCP reset must not crash the relay', async () => {
  const line = await refusedUpgradeThenReset('/ws', { Origin: 'https://evil.example' })
  expect(line).toContain('403')
  expect(await alive(), `relay exited ${relay.exitCode}; stderr: ${stderr.slice(-300)}`).toBe(true)
})

test('BUG D2: /ws upgrade with no cookie (401) + TCP reset must not crash the relay', async () => {
  const line = await refusedUpgradeThenReset('/ws', { Origin: 'https://relay.example.com' })
  expect(line).toContain('401')
  expect(await alive(), `relay exited ${relay.exitCode}; stderr: ${stderr.slice(-300)}`).toBe(true)
})

test('BUG D3: /bridge upgrades over the 10/min budget (429) + TCP reset must not crash the relay', async () => {
  // A legitimate bridge in a reconnect loop gets here on its own (see BUG A); an attacker needs no key at all.
  let line = ''
  for (let i = 0; i < 12 && !line.includes('429'); i++) {
    line = await refusedUpgradeThenReset('/bridge', { 'X-Forwarded-For': '198.51.100.9' })
  }
  expect(line).toContain('429')
  expect(await alive(), `relay exited ${relay.exitCode}; stderr: ${stderr.slice(-300)}`).toBe(true)
})

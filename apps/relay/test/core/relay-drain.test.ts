// A deploy stops the relay: every socket closes with 1012 ("Service Restart") so clients come straight back, and each
// close is logged once with its code (key close_code: the logger redacts `code`).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateBridgeKey } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { NoopTransport } from '../../src/core/push.ts'
import { loadEnv } from '../../src/env.ts'
import { type RunningRelay, startRelay } from '../../src/index.ts'
import { TEST_DATA_KEY } from '../helpers/fake-services.ts'

type Line = { level: string; obj: Record<string, unknown>; msg: string }

let relay: RunningRelay | null = null
let dir = ''

async function boot(lines: Line[]): Promise<RunningRelay> {
  dir = mkdtempSync(join(tmpdir(), 'talos-drain-'))
  const bridgeKey = await generateBridgeKey()
  const rec = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    lines.push({ level, obj: obj ?? {}, msg: msg ?? '' })
  }
  const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => log }
  relay = await startRelay({
    env: loadEnv({
      NODE_ENV: 'development',
      DATA_DIR: dir,
      PUBLIC_ORIGIN: 'https://relay.example.com',
      RP_ID: 'relay.example.com',
      DATA_KEY: TEST_DATA_KEY,
      BRIDGE_PUBKEY: bridgeKey.publicKeyB64,
      LOG_LEVEL: 'debug',
    }),
    host: '127.0.0.1',
    port: 0,
    transport: new NoopTransport(),
    log: log as never,
  })
  return relay
}

function openBridge(port: number): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`)
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on('close', (code, reason) => res({ code, reason: reason.toString() }))
    })
    ws.on('open', () => resolve({ ws, closed }))
    ws.on('error', reject)
  })
}

afterEach(async () => {
  try {
    await relay?.stop()
  } catch {
    // already stopped
  }
  relay = null
  resetAuthImplementation()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('relay stop drains sockets', () => {
  it('closes an open socket with 1012 "restarting", not 1006', async () => {
    const lines: Line[] = []
    const r = await boot(lines)
    const { closed } = await openBridge(r.port)
    await r.stop()
    const c = await closed
    expect(c.code).toBe(1012)
    expect(c.reason).toBe('restarting')
  })

  it('logs one "socket closed" line with close_code and role, and no identifying keys', async () => {
    const lines: Line[] = []
    const r = await boot(lines)
    const { closed } = await openBridge(r.port)
    await r.stop()
    await closed
    const closedLines = lines.filter((l) => l.msg === 'socket closed')
    expect(closedLines).toHaveLength(1)
    const o = closedLines[0]?.obj ?? {}
    expect(closedLines[0]?.level).toBe('info')
    expect(o.role).toBe('bridge')
    expect(o.close_code).toBe(1012)
    expect(typeof o.open_ms).toBe('number')
    for (const k of Object.keys(o)) expect(k).not.toMatch(/ip|device|session|thread/i)
  })
})

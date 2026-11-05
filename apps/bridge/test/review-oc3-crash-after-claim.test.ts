// Re-review of PR #68 at 0b5c05c. FINDING: fails until a worker that dies after `read_inbound` leaves a row. The deadline
// only covers unclaimed messages (router.ts onDeadline: "the worker got it"), read_inbound has already told the phone
// 'seen', and nothing watches the claim afterwards, so the owner gets a read receipt and then silence.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

const NONCE = 'test-nonce-0123456789abcdef'
const SESSION = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'
let h: Harness | undefined
let worker: Bridge | undefined
afterEach(async () => {
  await worker?.stop()
  worker = undefined
  await h?.stop()
  h = undefined
})

function writeWorkers(home: string, state: string, panePid: number, restarts: string[]) {
  const trip = { state, session_id: SESSION, tmux: 't-trip', pane_pid: panePid, cwd: home, restarts, error: null }
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads: { trip },
    }),
  )
}

test('FINDING: a worker that dies after claiming a message leaves a row in the thread', async () => {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [
        ...c.threads,
        {
          id: 'trip',
          name: 'Trip',
          kind: 'fixed',
          order: 5,
          notify: 'all',
          voice_context: 'recent',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  const hh = h
  await waitFor(() => existsSync(join(hh.home, 'hub.sock')))
  const me = pgidOf(process.pid) as number
  writeWorkers(hh.home, 'live', me, [])
  mkdirSync(join(hh.home, 'workers', 'trip'), { recursive: true })
  writeFileSync(join(hh.home, 'workers', 'trip', 'nonce'), NONCE)
  worker = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: hh.home,
      TALOS_APP_RELAY_URL: hh.relay.httpUrl,
      TALOS_APP_WORKER_THREAD: 'trip',
      TALOS_APP_WORKER_NONCE: NONCE,
    }),
    logger: nullLogger,
  })
  const ok = await worker.startWorker()
  expect(ok, `the worker was refused: ${JSON.stringify(worker.hubClient?.lastRefusal)}`).toBe(true)
  await hh.app.sendMessage('trip', 'Find a hotel near the station')
  await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
  const r = JSON.parse((await worker.callTool('read_inbound', {})).content[0]?.text ?? '{}')
  expect(r.messages).toHaveLength(1)
  // the turn dies with no reply: what the supervisor writes for a crash while live
  await worker.stop()
  worker = undefined
  writeWorkers(hh.home, 'parked', 0, [new Date().toISOString()])
  hh.bridge.optionCTick()
  await sleep(100)
  hh.bridge.optionCTick()
  await hh.relay.expectFrame('reply', (f) => f.message.author === 'system' && f.message.thread_id === 'trip', {
    direction: 'from_bridge',
    timeoutMs: 1500,
  })
})

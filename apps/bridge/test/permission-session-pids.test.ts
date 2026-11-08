// Which Claude Code is the bridge's own? A hook from it can have a relay twin; a hook from any other session cannot
// (permission-hook review R2-1). The bridge is launched the way .mcp.json launches it, `bun run --cwd <dir> --silent start`,
// which runs server.ts under a script runner, so the Claude Code pid is an ancestor and not the parent.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FakeClaude, FakeRelay, loadExampleConfig, sleep } from '@talos-app/testkit'
import { ancestorPids } from '../src/permission/doctor.ts'
import { eventually, stopRelay, tempHome } from './helpers.ts'

const BRIDGE_DIR = resolve(import.meta.dir, '..')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {})
})

test('the real launch shape records the LAUNCHING process among the bridge ancestors, not just its parent', async () => {
  const relay = await new FakeRelay().start()
  const home = tempHome('talos-sess-')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ ...loadExampleConfig('default'), permission_relay: true }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(home, 'bridge.key'),
    JSON.stringify({
      v: 1,
      pkcs8: relay.bridgeKey.privateKeyPkcs8B64,
      public: relay.bridgeKey.publicKeyB64,
      key_id: relay.bridgeKey.keyId,
    }),
    { mode: 0o600 },
  )
  const claude = new FakeClaude({
    command: 'bun',
    args: ['run', '--cwd', BRIDGE_DIR, '--silent', 'start'], // what install-mcp writes into .mcp.json
    cwd: BRIDGE_DIR,
    clientVersion: '2.1.312',
    env: {
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: relay.httpUrl,
      TALOS_APP_BRIDGE: '1',
      TALOS_APP_OTHER_CHANNELS: '',
    },
  })
  cleanups.push(async () => {
    await claude.stop()
    await stopRelay(relay)
  })
  await claude.start()
  let pids: number[] = []
  await eventually(() => {
    const line = readFileSync(join(home, 'bridge.log'), 'utf8')
      .split('\n')
      .find((l) => l.includes('permission session pids'))
    expect(line).toBeDefined()
    pids = (JSON.parse(line as string) as { pids: number[] }).pids
  })
  expect(pids).toContain(process.pid) // this process launched it: it plays Claude Code
  expect(pids.length).toBeGreaterThan(1) // and it is not the parent: a runner sits between
  expect(pids).not.toContain(process.pid + 1_000_000)
  await sleep(10)
})

test('ancestorPids walks up from a pid, nearest first, and stops at 1', () => {
  const up = ancestorPids(process.pid)
  expect(up[0]).toBe(process.pid)
  expect(up.length).toBeGreaterThan(1)
  expect(up).not.toContain(1)
  expect(ancestorPids(999_999_999)).toEqual([999_999_999]) // a pid with no ps entry: just itself, never a throw
})

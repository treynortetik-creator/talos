// Doctor row for a session that started before tool-prompt cards were turned on (2026-11-03): the setting says on, but
// Claude Code never sends prompts to a server that did not declare the capability at start.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
const realHome = process.env.HOME
afterEach(async () => {
  await h?.stop()
  h = undefined
  if (realHome === undefined) process.env.HOME = undefined
  else process.env.HOME = realHome
})

const ROW = 'permission_relay is on but this session started before it was turned on: restart the session'

async function doctor(opts: { configured: boolean; declared: boolean | undefined; pid?: number }) {
  const home = mkdtempSync(join(tmpdir(), 'talos-home-'))
  mkdirSync(join(home, '.claude'))
  process.env.HOME = home
  h = await startHarness({ startBridge: false, config: (c) => ({ ...c, permission_relay: opts.configured }) })
  const agent = mkdtempSync(join(tmpdir(), 'talos-agent-'))
  const status = {
    v: 1,
    pid: opts.pid ?? process.pid,
    instance: 'i',
    started_at: new Date().toISOString(),
    mode: 'live',
    relay: { connected: true, last_connect_at: null, last_close_code: null },
    queue_depth: 0,
    permission_relay: opts.configured,
    ...(opts.declared === undefined ? {} : { permission_relay_declared: opts.declared }),
    bridge_commit: null,
    updated_at: new Date().toISOString(),
  }
  writeFileSync(paths(h.home).status, JSON.stringify(status), { mode: 0o600 })
  const out: string[] = []
  const io = {
    out: (l: string) => out.push(l),
    err: () => {},
    prompt: async () => 'n',
    sleep: async () => {},
    now: () => Date.now(),
  }
  const env = { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl }
  await runCli(['install-mcp', '--agent-dir', agent], { ...io, out: () => {} }, env)
  await runCli(['doctor', '--agent-dir', agent, '--claude-dir', join(home, '.claude')], io, env, {
    processes: () => [],
  })
  return out
}

describe('doctor: permission_relay needs a session restart', () => {
  test('on in config, not declared by the running session: a warn row names the fix', async () => {
    const out = await doctor({ configured: true, declared: false })
    const line = out.find((l) => l.includes(ROW))
    expect(line).toBeDefined()
    expect(line?.startsWith('warn')).toBe(true)
  })

  test('declared at start: no row', async () => {
    expect((await doctor({ configured: true, declared: true })).some((l) => l.includes(ROW))).toBe(false)
  })

  test('off in config: no row', async () => {
    expect((await doctor({ configured: false, declared: false })).some((l) => l.includes(ROW))).toBe(false)
  })

  test('an older status file without the field: no row (nothing known, nothing claimed)', async () => {
    expect((await doctor({ configured: true, declared: undefined })).some((l) => l.includes(ROW))).toBe(false)
  })

  test('a dead bridge pid: no row (the status file belongs to nothing running)', async () => {
    expect((await doctor({ configured: true, declared: false, pid: 2_147_000_000 })).some((l) => l.includes(ROW))).toBe(
      false,
    )
  })
})

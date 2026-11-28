// Who may run which relay command: connect is the owner's, in a terminal; update and auto on follow the peer-link gate (the lock and
// outside text); disconnect is gated the same way (it forgets the token); auto off and status are always the agent's to run.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExampleConfig } from '@talos-app/testkit'
import { agentCliRefusal } from '../../src/agent-cli.ts'
import { loadEnv } from '../../src/config.ts'
import { HistoryStore } from '../../src/history-store.ts'
import { agentUnlessLocked, terminalOnly } from '../../src/talos.ts'
import { SETTINGS_LOCKED } from '../../src/trust.ts'
import { refusedForWorkers } from '../../src/worker/cli-refusal.ts'
import { tempHome } from '../helpers.ts'
import { cli, connectProject, useWorldCleanup, world } from './helpers.ts'

useWorldCleanup()

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})
function home(o: { lock?: boolean; outside?: boolean } = {}) {
  const h = tempHome('talos-relaygate-')
  homes.push(h)
  writeFileSync(
    join(h, 'config.json'),
    JSON.stringify({ ...loadExampleConfig('default'), ...(o.lock ? { settings_lock: true } : {}) }),
    { mode: 0o600 },
  )
  const store = new HistoryStore(join(h, 'history.sqlite'))
  if (o.outside) store.kvSet('outside_text_at:general', String(Date.now() - 5 * 60_000))
  store.close()
  return { h, env: loadEnv({ TALOS_APP_HOME: h } as Record<string, string>) }
}
const cwd = () => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'rg-cwd-'))
  homes.push(d)
  return d
}
const gate = (w: ReturnType<typeof home>, argv: string[], terminal = false) =>
  agentCliRefusal(w.env, argv, { terminal, raw: {}, cwd: cwd() })

describe('the command classes', () => {
  test('connect is terminal-only; update, auto, disconnect and status are not', () => {
    expect(terminalOnly(['relay', 'connect'])).toBe('relay connect')
    for (const a of ['update', 'auto', 'disconnect', 'status']) expect(terminalOnly(['relay', a]), a).toBeUndefined()
  })
  test('update, auto and disconnect are agent-unless-locked; connect is not', () => {
    expect(agentUnlessLocked(['relay', 'update'])).toBe('relay update')
    expect(agentUnlessLocked(['relay', 'disconnect'])).toBe('relay disconnect')
    expect(agentUnlessLocked(['relay', 'auto', 'on'])).toBe('relay auto')
    expect(agentUnlessLocked(['relay', 'connect'])).toBeUndefined()
  })
  test('a thread session may run update, auto, disconnect and status, never connect', () => {
    for (const a of ['update', 'auto', 'disconnect', 'status']) expect(refusedForWorkers(['relay', a]), a).toBe(false)
    expect(refusedForWorkers(['relay', 'connect'])).toBe(true)
  })
})

describe('the gate', () => {
  test('lock on: update, auto on and disconnect are refused for the agent, with the same words; auto off and status are not', () => {
    const w = home({ lock: true })
    expect(gate(w, ['relay', 'update'])).toBe(SETTINGS_LOCKED)
    expect(gate(w, ['relay', 'disconnect'])).toBe(SETTINGS_LOCKED)
    expect(gate(w, ['relay', 'disconnect'], true)).toBeUndefined() // a terminal is the owner's
    expect(gate(w, ['relay', 'auto', 'on'])).toBe(SETTINGS_LOCKED)
    expect(gate(w, ['relay', 'auto', 'off'])).toBeUndefined()
    expect(gate(w, ['relay', 'status'])).toBeUndefined()
    expect(gate(w, ['relay', 'update'], true)).toBeUndefined() // a terminal is the owner's
  })
  test('outside text since the owner spoke: update, auto on and disconnect are refused; off and status are not', () => {
    const w = home({ outside: true })
    expect(gate(w, ['relay', 'update'])).toMatch(/outside text/)
    expect(gate(w, ['relay', 'auto', 'on'])).toMatch(/outside text/)
    expect(gate(w, ['relay', 'disconnect'])).toMatch(/outside text/)
    expect(gate(w, ['relay', 'auto', 'off'])).toBeUndefined()
  })
  test('quiet home, unlocked: disconnect runs for the agent', () => {
    const w = home()
    expect(gate(w, ['relay', 'disconnect'])).toBeUndefined()
  })
  test('quiet home: update runs for the agent, with one audit line that names the command only', () => {
    const w = home()
    expect(gate(w, ['relay', 'update'])).toBeUndefined()
    const log = require('node:fs').readFileSync(join(w.h, 'bridge.log'), 'utf8') as string
    expect(log).toContain('relay update')
    expect(log).not.toMatch(/rw_|service_id|environment/)
  })
})

describe('through the real command', () => {
  test('connect from an agent (no terminal) is refused, and update is refused under the lock, before Railway is asked', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    const calls = w.railway.calls.length
    const c = await cli(w, ['relay', 'connect'], { terminal: false })
    expect(c.code).toBe(1)
    expect(c.err).toContain('only runs in')
    writeFileSync(
      join(w.home, 'config.json'),
      JSON.stringify({ ...loadExampleConfig('default'), settings_lock: true }),
      { mode: 0o600 },
    )
    const u = await cli(w, ['relay', 'update'], { terminal: false })
    expect(u.code).toBe(1)
    expect(u.err).toContain(SETTINGS_LOCKED)
    expect(w.railway.calls.length).toBe(calls)
    // off still works for the agent under the lock; disconnect is refused for it like update, and runs in a terminal
    expect((await cli(w, ['relay', 'auto', 'off'], { terminal: false })).code).toBe(0)
    const d = await cli(w, ['relay', 'disconnect'], { terminal: false })
    expect(d.code).toBe(1)
    expect(d.err).toContain(SETTINGS_LOCKED)
    expect((await cli(w, ['relay', 'disconnect'], { terminal: true })).code).toBe(0)
    void mkdirSync
  })
})

// scripts/gate/group-run.pl: how the gate runs the web browser specs. The command goes in a process group of its own; at the time
// limit, or when the gate itself is stopped, the group is asked to stop with INT first (Playwright tears its web server down on INT
// only, and that server is in a group of its own that no group kill reaches), then TERM, then KILL, each after a wait.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { timeFactor } from '../packages/testkit/src/time-factor.ts'

const here = dirname(fileURLToPath(import.meta.url))
const PL = join(here, 'gate', 'group-run.pl')
const F = timeFactor()
vi.setConfig({ testTimeout: 60_000 * F, hookTimeout: 60_000 * F })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'grouprun-'))
  dirs.push(d)
  return d
}
// a command that writes the signals it is sent to <dir>/log, one a line; `ignore` lists the ones it does not stop for
const script = (d: string, ignore: string[]) =>
  `${['INT', 'TERM']
    .map((s) => `trap 'echo ${s} >> "${d}/log"; ${ignore.includes(s) ? ':' : 'exit 0'}' ${s}`)
    .join('; ')}; echo up > "${d}/up"; while :; do sleep 0.05; done`
const signals = (d: string) =>
  existsSync(join(d, 'log')) ? readFileSync(join(d, 'log'), 'utf8').trim().split('\n') : []
const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? '',
  GATE_STOP_WAIT: '1',
  WEB_LIMIT_NAME: 'WEB_SPECS_LIMIT',
  ...extra,
})

describe('gate/group-run.pl', () => {
  it('runs the command and exits with its own code; a signal that killed it is 128 + the signal', () => {
    expect(spawnSync('perl', [PL, '30', 'sh', '-c', 'exit 3'], { env: env() }).status).toBe(3)
    expect(spawnSync('perl', [PL, '30', 'sh', '-c', 'kill -9 $$'], { env: env() }).status).toBe(128 + 9)
  })

  it('at the limit the group gets INT first (and is left alone when that stops it), and the exit is 142 with the limit named', () => {
    const d = tmp()
    const r = spawnSync('perl', [PL, '1', 'sh', '-c', script(d, [])], { env: env(), encoding: 'utf8' })
    expect(r.status).toBe(142)
    expect(r.stderr).toContain('the web browser specs were stopped after 1 s (WEB_SPECS_LIMIT)')
    expect(signals(d)).toEqual(['INT'])
  })

  it('a group that ignores INT gets TERM after the wait, and one that ignores both is killed', () => {
    const d = tmp()
    const r = spawnSync('perl', [PL, '1', 'sh', '-c', script(d, ['INT'])], { env: env(), encoding: 'utf8' })
    expect(r.status).toBe(142)
    expect(signals(d).slice(0, 2)).toEqual(['INT', 'TERM'])
    const e = tmp()
    const k = spawnSync('perl', [PL, '1', 'sh', '-c', script(e, ['INT', 'TERM'])], { env: env(), encoding: 'utf8' })
    expect(k.status).toBe(142) // gone by KILL, not hung
    expect(signals(e).slice(0, 2)).toEqual(['INT', 'TERM'])
  })

  it('when the gate itself is stopped with TERM, the group still gets INT first, and the gate ends 143', async () => {
    const d = tmp()
    const c = spawn('perl', [PL, '600', 'sh', '-c', script(d, [])], { env: env(), stdio: 'ignore' })
    const done = new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    await vi.waitUntil(() => existsSync(join(d, 'up')), { timeout: 20_000 * F, interval: 25 })
    process.kill(c.pid as number, 'SIGTERM')
    expect(await done).toBe(143)
    expect(signals(d)).toEqual(['INT'])
  })

  it('stops once: a second TERM or INT while it stops does not start the sequence over (Playwright must not get a second INT)', async () => {
    const d = tmp()
    // INT is written down and the command goes on; TERM ends it; so a second INT would show
    const body = `trap 'echo INT >> "${d}/log"' INT; trap 'echo TERM >> "${d}/log"; exit 0' TERM; echo up > "${d}/up"; while :; do sleep 0.05; done`
    const c = spawn('perl', [PL, '600', 'sh', '-c', body], { env: env({ GATE_STOP_WAIT: '2' }), stdio: 'ignore' })
    const done = new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    await vi.waitUntil(() => existsSync(join(d, 'up')), { timeout: 20_000 * F, interval: 25 })
    process.kill(c.pid as number, 'SIGTERM')
    await vi.waitUntil(() => signals(d).length > 0, { timeout: 20_000 * F, interval: 25 })
    process.kill(c.pid as number, 'SIGTERM')
    process.kill(c.pid as number, 'SIGINT')
    expect(await done).toBe(143)
    expect(signals(d)).toEqual(['INT', 'TERM']) // once each, in that order: no second INT
  })

  it('scripts/gate.sh runs the web specs through it', () => {
    const gate = readFileSync(join(here, 'gate.sh'), 'utf8')
    expect(gate).toContain('gate/group-run.pl')
    expect(existsSync(PL)).toBe(true)
  })
})

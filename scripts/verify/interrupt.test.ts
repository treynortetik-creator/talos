// The harness scripts leave nothing behind when they are interrupted (SIGTERM, as a time limit or a closing session sends it):
// every process group they started is gone and their temp folders are removed, and a second "@stop-relay" is a no-op. These run the
// REAL scripts as child processes, in a group of their own so a bug that signals "its own group" cannot take the test runner with it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../../packages/testkit/src/time-factor.ts'
import { fakeTool } from '../fake-tool'

vi.setConfig({ testTimeout: scaled(120_000), hookTimeout: scaled(120_000) })
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../..')
const dirs: string[] = []
const pids: number[] = []
afterAll(() => {
  for (const p of pids) {
    try {
      process.kill(-p, 'SIGKILL')
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Stopped: no such process, or a zombie no one has reaped yet (its group was SIGKILLed; on a busy Linux runner the reaper can lag,
 * and `kill(pid, 0)` still succeeds on a zombie). Waits a moment for it, as the kill itself is not instant. */
const zombie = (pid: number) =>
  /^Z/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())
const expectGone = async (pid: number) => {
  await until(`process ${pid} to be gone`, () => !alive(pid) || zombie(pid), scaled(5000)).catch(() => {})
  expect(!alive(pid) || zombie(pid)).toBe(true)
}
/** `gone` says why the thing waited on can never happen (its script has exited), with what it printed: the wait ends at once with that. */
const until = async (what: string, f: () => boolean, ms = scaled(60_000), gone?: () => string | undefined) => {
  const end = Date.now() + ms
  while (!f()) {
    const why = gone?.()
    if (why) throw new Error(`${what} never happened: ${why}`)
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

function world() {
  const T = mkdtempSync(join(tmpdir(), 'vi-'))
  dirs.push(T)
  const tmp = join(T, 'tmp')
  mkdirSync(tmp)
  const env = {
    ...process.env,
    TMPDIR: tmp,
    TALOS_VERIFY_EVIDENCE_ROOT: join(T, 'ev'),
  } as Record<string, string>
  const start = (script: string, args: string[], extra: Record<string, string> = {}) => {
    const child = spawn('node', [resolve(here, script), ...args], {
      cwd: repo,
      env: { ...env, ...extra },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.pid) pids.push(child.pid)
    let out = ''
    child.stdout?.on('data', (d) => {
      out += d
    })
    child.stderr?.on('data', (d) => {
      out += d
    })
    let ended: string | undefined
    const done = new Promise<number | null>((r) =>
      child.on('close', (code, signal) => {
        ended = `the script exited (${code === null ? `signal ${signal}` : `code ${code}`})`
        r(code)
      }),
    )
    /** What the script printed, for a message: the folders and home paths replaced, the last 2000 characters. */
    const shown = () => {
      const text = [
        [T, '<temp>'],
        [repo, '<repo>'],
        [homedir(), '<home>'],
      ].reduce((t, [from, to]) => (from ? t.split(from).join(to as string) : t), out.trim())
      return text.length > 2000 ? `...${text.slice(-2000)}` : text
    }
    const outputOf = () => (shown() ? `\n${shown()}` : ' (it printed nothing)')
    /** Waits for something the script does: ends at once when the script has exited, and always says what it printed. */
    const waitFor = (what: string, f: () => boolean, ms?: number) =>
      until(what, f, ms, () => (ended ? `${ended}.${outputOf()}` : undefined)).catch((e: Error) => {
        throw new Error(e.message.startsWith('timed out') ? `${e.message}.${outputOf()}` : e.message)
      })
    return { child, done, output: () => out, shown, until: waitFor }
  }
  return { T, tmp, env, start, leftovers: (prefix: string) => readdirSync(tmp).filter((n) => n.startsWith(prefix)) }
}

describe('SIGTERM mid-run', () => {
  it('bridge-run: the step it runs and its temp folder are gone, and it exits 143', async () => {
    const w = world()
    const pidFile = join(w.T, 'step.pid')
    const r = w.start('bridge-run.mjs', [
      '--worktree',
      repo,
      '--label',
      'before',
      '--route',
      'sigtest',
      '--run',
      `sleep 60 & echo $! > ${pidFile}; wait`,
    ])
    await r.until('the step to start', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const step = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(step)).toBe(true)
    expect(w.leftovers('talos-verify-bridge-')).toHaveLength(1)
    r.child.kill('SIGTERM')
    expect(await r.done).toBe(143)
    await expectGone(step)
    expect(w.leftovers('talos-verify-bridge-')).toEqual([])
  })

  it('bridge-run: the REAL relay it started is stopped too', async () => {
    const w = world()
    const pidFile = join(w.T, 'step.pid')
    const r = w.start('bridge-run.mjs', [
      '--worktree',
      repo,
      '--label',
      'before',
      '--route',
      'sigtest',
      '--cli',
      '0::errors list',
      '--run',
      `sleep 60 & echo $! > ${pidFile}; wait`,
    ])
    await r.until(
      'the step to start (after the relay is up)',
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '',
    )
    const [tempName] = w.leftovers('talos-verify-bridge-')
    const relay = Number(readFileSync(join(w.tmp, tempName as string, 'relay.pid'), 'utf8').trim())
    const step = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(relay)).toBe(true)
    r.child.kill('SIGTERM')
    expect(await r.done).toBe(143)
    await expectGone(relay)
    await expectGone(step)
    expect(w.leftovers('talos-verify-bridge-')).toEqual([])
  })

  it('capture: the web build it started is gone, the temp build folder too, and it exits 143', async () => {
    const w = world()
    const bin = join(w.T, 'bin')
    mkdirSync(bin)
    const pidFile = join(w.T, 'build.pid')
    // the stand-in "pnpm" is the build: it hangs, so the interrupt arrives mid-build
    fakeTool(bin, 'pnpm', `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 60\n`)
    const r = w.start(
      'capture.mjs',
      ['web', '--worktree', repo, '--label', 'before', '--routes', 'home', '--themes', 'talos'],
      { PATH: `${bin}:${process.env.PATH}` },
    )
    await r.until('the build to start', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const build = Number(readFileSync(pidFile, 'utf8').trim())
    expect(alive(build)).toBe(true)
    r.child.kill('SIGTERM')
    expect(await r.done).toBe(143)
    await expectGone(build)
    expect(w.leftovers('talos-verify-web-')).toEqual([])
  })

  it('SIGINT exits 130 the same way', async () => {
    const w = world()
    const pidFile = join(w.T, 'step.pid')
    const r = w.start('bridge-run.mjs', [
      '--worktree',
      repo,
      '--label',
      'before',
      '--route',
      'sigtest',
      '--run',
      `sleep 60 & echo $! > ${pidFile}; wait`,
    ])
    await r.until('the step to start', () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')
    const step = Number(readFileSync(pidFile, 'utf8').trim())
    r.child.kill('SIGINT')
    expect(await r.done).toBe(130)
    await expectGone(step)
    expect(w.leftovers('talos-verify-bridge-')).toEqual([])
  })
})

describe('a script that is gone is reported, not waited for', () => {
  const script = (w: ReturnType<typeof world>, name: string, body: string) => {
    const f = join(w.T, name)
    writeFileSync(f, body)
    return f
  }

  it('a script that exited early ends the wait at once, with its exit code and its output', async () => {
    const w = world()
    const f = script(
      w,
      'early.mjs',
      "console.error('bad start in', process.cwd(), 'and', process.env.TMPDIR)\nprocess.exit(3)\n",
    )
    const r = w.start(f, [])
    const e = await r
      .until('the step to start', () => false, scaled(5000))
      .then(
        () => new Error('it did not throw'),
        (x: Error) => x,
      )
    expect(e.message).toMatch(/exited.*3/)
    expect(e.message).not.toMatch(/timed out/)
    expect(e.message).toContain('bad start in')
    expect(e.message).toContain('<temp>')
    expect(e.message).not.toContain(w.T)
    expect(e.message).not.toContain(repo)
    expect(e.message).not.toContain(homedir())
  })

  it('a wait that ends for the script keeps what it printed (bounded), and the time-out message shows it too', async () => {
    const w = world()
    const f = script(w, 'slow.mjs', "console.log('x'.repeat(5000) + ' the-last-line')\nsetTimeout(() => {}, 60_000)\n")
    const r = w.start(f, [])
    await r.until('the output', () => r.output().includes('the-last-line'))
    const e = await r
      .until('something that never happens', () => false, scaled(300))
      .then(
        () => new Error('it did not throw'),
        (x: Error) => x,
      )
    expect(e.message).toMatch(/timed out waiting for something that never happens/)
    expect(e.message).toContain('the-last-line')
    expect(e.message.length).toBeLessThan(3000)
    r.child.kill('SIGKILL')
    await r.done
  })

  it('a wait that is already satisfied returns even though the script has exited', async () => {
    const w = world()
    const f = script(w, 'quick.mjs', 'process.exit(0)\n')
    const r = w.start(f, [])
    await r.done
    await r.until('nothing', () => true)
  })
})

describe('bridge-run keeps its relay port', () => {
  // The relay port is picked before `talos-app init` and used by the relay seconds later. These put another process on it in between:
  // a `bun` that takes the port while init runs, and a `node` (the relay's start) that takes it, answers once and dies, fills its log
  // with a port error, stays silent, or dies. Every relay start is written down (its pid, one line each) by the fake `node`.
  type NodeMode = 'take-once' | 'inuse-log' | 'flash' | 'flash-inuse' | 'silent' | 'die' | ''
  function stand(mode: { bun?: 'take' | 'slow-second'; node?: NodeMode; host?: string; relayWaitMs?: number }) {
    const w = world()
    const bin = join(w.T, 'bin')
    mkdirSync(bin)
    const take = join(w.T, 'take-port.mjs')
    writeFileSync(
      take,
      [
        "import { spawn } from 'node:child_process'",
        "import { existsSync, writeFileSync } from 'node:fs'",
        "import { createServer } from 'node:net'",
        'const [port, file, host, mode] = process.argv.slice(2)',
        "if (mode === 'hold') {",
        '  const s = createServer()',
        "  s.once('error', (e) => { writeFileSync(file, 'busy ' + e.code + '\\n'); process.exit(0) })",
        "  s.listen(Number(port), host, () => writeFileSync(file, 'taken ' + process.pid + '\\n'))",
        '  setTimeout(() => process.exit(0), 120_000)',
        '} else {',
        "  spawn(process.execPath, [process.argv[1], port, file, host, 'hold'], { detached: true, stdio: 'ignore' }).unref()",
        '  const end = Date.now() + 10_000',
        '  while (!existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 20))',
        '}',
        '',
      ].join('\n'),
    )
    // a relay stand-in that answers the first /healthz with 200 and exits 100 ms later (in 'flash-inuse' mode with a port error first)
    const flash = join(w.T, 'flash.mjs')
    writeFileSync(
      flash,
      [
        "import { createServer } from 'node:http'",
        'createServer((_q, s) => {',
        "  s.end('ok')",
        "  if (process.env.FAKE_RELAY === 'flash-inuse') console.error('Error: listen EADDRINUSE: address already in use')",
        '  setTimeout(() => process.exit(9), 100)',
        '}).listen(Number(process.env.PORT))',
        '',
      ].join('\n'),
    )
    fakeTool(
      bin,
      'bun',
      [
        '#!/bin/sh',
        'if [ "$3" = init ]; then',
        '  echo x >> "$INITS_FILE"',
        '  if [ "$BUN_MODE" = take ]; then "$REAL_NODE" "$TAKE_JS" "$(basename "$5" | cut -d: -f2)" "$TAKE_FILE" 127.0.0.1; fi',
        '  if [ "$BUN_MODE" = slow-second ] && [ "$(wc -l < "$INITS_FILE" | tr -d " ")" = 2 ]; then echo $$ > "$REINIT_FILE"; exec sleep 60; fi',
        'fi',
        'exec "$REAL_BUN" "$@"',
        '',
      ].join('\n'),
    )
    fakeTool(
      bin,
      'node',
      [
        '#!/bin/sh',
        'if [ "$1" = apps/relay/dist/index.js ]; then',
        '  echo $$ >> "$STARTS_FILE"',
        '  n=$(wc -l < "$STARTS_FILE" | tr -d " ")',
        '  case "$FAKE_RELAY" in',
        '    take-once) [ "$n" = 1 ] && "$REAL_NODE" "$TAKE_JS" "$PORT" "$TAKE_FILE" "$TAKE_HOST" ;;',
        '    inuse-log) if [ "$n" = 1 ]; then',
        '      echo "Error: listen EADDRINUSE: address already in use :::$PORT" >&2',
        '      for i in 1 2 3 4 5 6 7 8; do echo "    at frame $i (node:net)" >&2; done',
        '      exit 1',
        '    fi ;;',
        '    flash|flash-inuse) [ "$n" = 1 ] && exec "$REAL_NODE" "$FLASH_JS" ;;',
        '    silent) exec sleep 120 ;;',
        '    die) date +%s > "$STARTS_FILE.died"; echo "boom: the relay cannot start" >&2; exit 7 ;;',
        '  esac',
        'fi',
        'exec "$REAL_NODE" "$@"',
        '',
      ].join('\n'),
    )
    const f = (n: string) => join(w.T, n)
    const run = (route: string, extra: string[] = []) =>
      w.start(
        'bridge-run.mjs',
        [
          '--worktree',
          repo,
          '--label',
          'before',
          '--route',
          route,
          '--sha',
          route,
          '--cli',
          '0::errors list',
          '--cli',
          '2::errors requeue-bug-report abc',
          ...extra,
        ],
        {
          PATH: `${bin}:${process.env.PATH}`,
          REAL_NODE: process.execPath,
          REAL_BUN: spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim(),
          TAKE_JS: take,
          TAKE_FILE: f('take.txt'),
          TAKE_HOST: mode.host ?? '127.0.0.1',
          FLASH_JS: flash,
          STARTS_FILE: f('starts.txt'),
          INITS_FILE: f('inits.txt'),
          REINIT_FILE: f('reinit.pid'),
          BUN_MODE: mode.bun ?? '',
          FAKE_RELAY: mode.node ?? '',
          ...(mode.relayWaitMs ? { TALOS_VERIFY_RELAY_WAIT_MS: String(mode.relayWaitMs) } : {}),
        },
      )
    const lines = (n: string) => (existsSync(f(n)) ? readFileSync(f(n), 'utf8').split('\n').filter(Boolean) : [])
    const taken = () => lines('take.txt').join('')
    /** every relay start the fake `node` saw, by pid */
    const starts = () => lines('starts.txt').map(Number)
    // a process that took the port lives in a group of its own: stop it when the test is over
    const reap = () => {
      const pid = Number(/^taken (\d+)/.exec(taken())?.[1])
      if (pid) pids.push(pid)
    }
    const transcript = (route: string) => readFileSync(join(w.T, `ev/${route}/cli-${route}-na-before.txt`), 'utf8')
    return { w, run, taken, starts, reap, transcript, f, lines }
  }

  it('the port is held while init runs: nobody else can take it before the relay does', async () => {
    const s = stand({ bun: 'take' })
    const r = s.run('portheld')
    try {
      expect(await r.done, r.shown()).toBe(0)
      expect(s.taken()).toMatch(/^busy EADDRINUSE/)
    } finally {
      s.reap()
    }
  })

  for (const host of ['127.0.0.1', '0.0.0.0']) {
    it(`a port taken on ${host} as the relay starts: another port is picked, the first relay is gone, and a signed call works on the new one`, async () => {
      const s = stand({ node: 'take-once', host })
      const r = s.run('portretry')
      try {
        expect(await r.done, r.shown()).toBe(0)
        expect(s.taken()).toMatch(/^taken \d+/)
        const t = s.transcript('portretry')
        expect(t).toMatch(/relay port \d+ did not work.*another/)
        expect(t).toMatch(/a real relay of this checkout at http:\/\/127\.0\.0\.1:\d+ \(pid \d+\)/)
        expect(t).toMatch(/\$ talos-app errors list\n\(exit 0\)/)
        // the signed call reached the relay that came up on the new port (it answers; the report id is not there)
        expect(t).toMatch(/\$ talos-app errors requeue-bug-report abc\n\(exit 2\)/)
        // One start per try, and every start before the last is gone. The fake taker takes only the first port, but the second port
        // is picked and released before the relay binds it, and a parallel test's port-0 bind can take it in that gap: then the
        // script retries once more (3 tries at most). Two starts is the usual count, never exactly two by right.
        const n = s.starts().length
        expect(n).toBeGreaterThanOrEqual(2)
        expect(n).toBeLessThanOrEqual(3)
        expect(t.match(/# relay port \d+ did not work/g)).toHaveLength(n - 1)
        for (const p of s.starts()) await expectGone(p)
        expect(s.w.leftovers('talos-verify-bridge-')).toEqual([])
      } finally {
        s.reap()
      }
    })
  }

  it('a relay whose log has the port error far above its last lines is still a taken port (the whole log is read)', async () => {
    const s = stand({ node: 'inuse-log' })
    const r = s.run('portlog')
    expect(await r.done, r.shown()).toBe(0)
    expect(s.starts()).toHaveLength(2)
    expect(s.transcript('portlog')).toMatch(/relay port \d+ did not work.*another/)
  })

  it('a relay that answers once and then dies is a real failure, said at once, and started once (not a taken port)', async () => {
    const s = stand({ node: 'flash' })
    const r = s.run('portflash')
    expect(await r.done, r.shown()).toBe(3)
    expect(r.output()).toMatch(/relay \(pid \d+\) exited \(code 9\)/)
    expect(s.starts()).toHaveLength(1)
  })

  it('a relay that answers once and dies with the port error in its log is a taken port: another one is tried', async () => {
    const s = stand({ node: 'flash-inuse' })
    const r = s.run('portflashuse')
    expect(await r.done, r.shown()).toBe(0)
    expect(s.starts()).toHaveLength(2)
    expect(s.transcript('portflashuse')).toMatch(/relay port \d+ did not work.*another/)
  })

  it('a relay that dies at its start is said at once, with its exit code and its log, and is started once', async () => {
    const s = stand({ node: 'die' })
    const r = s.run('portdie')
    expect(await r.done, r.shown()).toBe(3)
    const died = Number(s.lines('starts.txt.died')[0])
    expect(Math.floor(Date.now() / 1000) - died).toBeLessThan(10) // the 30 s wait is not run out after the relay is gone
    expect(r.output()).toMatch(/relay \(pid \d+\) exited \(code 7\)/)
    expect(r.output()).toContain('boom: the relay cannot start')
    expect(r.output()).not.toMatch(/did not answer/)
    expect(s.starts()).toHaveLength(1) // a relay that dies for another reason is never started again
  })

  it('a relay that is alive but silent, with no other process on its port, is reported at the end of the wait: no second try', async () => {
    const s = stand({ node: 'silent', relayWaitMs: 3000 })
    const r = s.run('portsilent')
    expect(await r.done, r.shown()).toBe(3)
    expect(r.output()).toMatch(/relay \(pid \d+\) did not answer \/healthz within 3 s/)
    expect(s.starts()).toHaveLength(1)
    expect(s.w.leftovers('talos-verify-bridge-')).toEqual([])
    await expectGone(s.starts()[0] as number)
  })

  it('after a retry, relay.pid is the new relay, the first is gone, and an interrupt stops everything (SIGTERM 143)', async () => {
    const s = stand({ node: 'take-once' })
    const stepPid = join(s.w.T, 'step.pid')
    const r = s.run('portretrysig', ['--run', `sleep 60 & echo $! > ${stepPid}; wait`])
    try {
      await r.until('the step to start', () => existsSync(stepPid) && readFileSync(stepPid, 'utf8').trim() !== '')
      const [tempName] = s.w.leftovers('talos-verify-bridge-')
      const relay = Number(readFileSync(join(s.w.tmp, tempName as string, 'relay.pid'), 'utf8').trim())
      const [first, second] = s.starts()
      expect(s.starts(), r.shown()).toHaveLength(2)
      expect(relay).toBe(second)
      expect(alive(relay)).toBe(true)
      await expectGone(first as number)
      r.child.kill('SIGTERM')
      expect(await r.done).toBe(143)
      for (const p of [...s.starts(), Number(readFileSync(stepPid, 'utf8').trim())]) await expectGone(p)
      expect(s.w.leftovers('talos-verify-bridge-')).toEqual([])
    } finally {
      s.reap()
    }
  })

  for (const [name, code] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const) {
    it(`${name} while the second try runs init: it exits ${code}, and no relay, init or temp folder is left`, async () => {
      const s = stand({ node: 'inuse-log', bun: 'slow-second' })
      const r = s.run('portreinit')
      await r.until('the second init to start', () => s.lines('reinit.pid').length > 0)
      const init = Number(s.lines('reinit.pid')[0])
      expect(alive(init)).toBe(true)
      r.child.kill(name)
      expect(await r.done).toBe(code)
      for (const p of [...s.starts(), init]) await expectGone(p)
      expect(s.w.leftovers('talos-verify-bridge-')).toEqual([])
    })
  }
})

describe('@stop-relay twice', () => {
  it('the second one is a no-op with a line in the transcript, never a signal to its own group', async () => {
    const w = world()
    const r = w.start('bridge-run.mjs', [
      '--worktree',
      repo,
      '--label',
      'before',
      '--route',
      'stoptwice',
      '--sha',
      'stoptwice',
      '--cli',
      '0::errors list',
      '--cli',
      '@stop-relay',
      '--cli',
      '@stop-relay',
    ])
    expect(await r.done, r.shown()).toBe(0)
    const t = readFileSync(join(w.T, 'ev/stoptwice/cli-stoptwice-na-before.txt'), 'utf8')
    expect(t).toContain('# relay stopped (pid')
    expect(t).toMatch(/# no relay running: nothing to stop/)
  })
})

describe('sim only drives a device it booted', () => {
  // an xcrun that knows one booted device and one shut down, and writes down every call
  function shim() {
    const w = world()
    const bin = join(w.T, 'bin')
    mkdirSync(bin)
    const log = join(w.T, 'xcrun.log')
    const json = JSON.stringify({
      devices: {
        rt: [
          { udid: 'U-BOOTED', name: 'iPhone Booted', state: 'Booted' },
          { udid: 'U-OFF', name: 'iPhone Off', state: 'Shutdown' },
        ],
      },
    })
    writeFileSync(join(w.T, 'devices.json'), json)
    fakeTool(
      bin,
      'xcrun',
      `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in *"list devices"*) cat ${join(w.T, 'devices.json')} ;; esac\nexit 0\n`,
    )
    const run = (args: string[]) =>
      spawnSync('node', [join(here, 'capture.mjs'), 'sim', '--worktree', repo, '--routes', 'home', ...args], {
        cwd: repo,
        env: { ...w.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    return { run, calls }
  }

  it('an "after" run without --route-list is refused before anything is touched', () => {
    const s = shim()
    const r = s.run(['--label', 'after', '--udid', 'U-OFF'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--route-list')
    expect(s.calls()).toBe('')
  })

  it('no --udid and no --use-booted: refused (a device nobody named is not ours)', () => {
    const s = shim()
    const r = s.run(['--label', 'before'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/--udid/)
    expect(s.calls()).not.toMatch(/openurl|screenshot|boot /)
  })

  it('a device that is already booted is refused unless --use-booted says it is yours', () => {
    const s = shim()
    const r = s.run(['--label', 'before', '--udid', 'U-BOOTED'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('already booted')
    expect(s.calls()).not.toMatch(/openurl|screenshot|boot U/)
  })

  it('--udid of a device that does not exist is refused', () => {
    const s = shim()
    const r = s.run(['--label', 'before', '--udid', 'U-NOPE'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('no simulator')
  })
})

#!/usr/bin/env node
// bridge-run.mjs: the verify skill's CLI / bridge-side route. It makes a throwaway Talos home in a temp folder (never ~/.talos),
// runs `talos-app init` there, starts the REAL relay of the checkout on a free local port with the key that init made, runs the
// real bridge CLI against it, and writes the whole transcript (command, exit code, stdout, stderr) to the evidence folder.
// Every process it starts is stopped by pid before it exits, and the temp folder is removed.
//
//   node scripts/verify/bridge-run.mjs --worktree <dir> --label before|after --route <name> \
//     --cli '0::errors list' --cli '2::errors requeue-bug-report abc' --cli '@stop-relay' [--run '<shell command in the checkout>'] \
//     [--expect-text '<regex over the transcript>'] [--sha <folder>] [--route-list <file>] [--proves <text>]
//
// --cli '<exit>::<args>'   one `talos-app <args>` call; <exit> is the exit code it must have (omit "<exit>::" for 0)
// --cli '@stop-relay'    stops the relay mid-run, so the steps after it show what the owner reads when it is gone
// --run '<command>'        any other command, run with `bash -c` in the checkout with the same clean environment (its exit must be 0);
//                          e.g. the test file that covers the stored-report path
// Exit codes as capture.mjs: 0 good, 1 an expectation failed in an "after" run (recorded as observed in a "before" run), 2 usage,
// 3 a part could not start (relay build, relay up, init): never a quiet skip.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { reservePort } from '../../e2e/harness/port.ts'
import {
  addCapture,
  captureName,
  EXIT,
  evidenceRoot,
  installSignalCleanup,
  loadIndex,
  onInterrupt,
  parseArgs,
  runGroup,
  safePart,
  saveIndex,
  trackGroup,
  Unreachable,
  Usage,
  untrackGroup,
} from './lib.mjs'

/** The session's own Talos variables change what the CLI does; none of them, and no real home, reaches a step. */
export function cleanEnv(base, home, fakeHome) {
  const env = {}
  for (const [k, v] of Object.entries(base))
    if (!/^(TALOS_|CLAUDE_CODE_|CLAUDECODE$|CHRONOS_RUN$)/.test(k) && v !== undefined) env[k] = v
  env.TALOS_APP_HOME = home
  env.HOME = fakeHome
  return env
}

/** "2::errors list" -> {exit: 2, args: "errors list"}; no prefix means 0. */
export function parseStep(s) {
  const m = /^(\d{1,3})::(.*)$/s.exec(s)
  return m ? { exit: Number(m[1]), text: m[2] } : { exit: 0, text: s }
}

/** True when another process already listens on 127.0.0.1:port. The probe's own socket lives only for this check. */
const listenerOn = (port) =>
  new Promise((ok) => {
    const s = createServer()
    s.once('error', (e) => ok(e.code === 'EADDRINUSE'))
    s.listen(port, '127.0.0.1', () => s.close(() => ok(false)))
  })

/**
 * Waits for the relay on `port`; says what it found: 'up', 'gone' (the relay process has exited), 'taken' (another process has the
 * port) or 'silent' (the relay is alive, nothing answered, and nobody else is shown on the port).
 * macOS lets a relay bind 0.0.0.0:port beside another process that listens on 127.0.0.1:port, and loopback then reaches the
 * other one: the relay stays alive and silent. So on macOS a failed answer is followed by a bind on 127.0.0.1:port: "address in
 * use" shows the other process (our relay listens on the wildcard, which that bind does not collide with on macOS). A bind that
 * works proves nothing, and the wait goes on. On Linux a taker makes the relay itself exit with the port error, and the same bind
 * would collide with our own relay, so there is no probe. A 200 is believed only after a short settle: a relay that dies after a
 * 200 is 'gone' (a real failure; a retry happens only if its log has the port error), and on macOS another process on the port
 * makes it 'taken' (the answer may have come from that process).
 */
async function waitRelay(url, port, ms, gone) {
  const probe = process.platform === 'darwin'
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (gone()) return 'gone'
    let ok = false
    try {
      ok = (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) })).ok
    } catch {}
    if (ok) {
      await new Promise((r) => setTimeout(r, 500))
      if (gone()) return 'gone'
      return probe && (await listenerOn(port)) ? 'taken' : 'up'
    }
    if (probe && !gone() && (await listenerOn(port))) return 'taken'
    await new Promise((r) => setTimeout(r, 300))
  }
  return gone() ? 'gone' : 'silent'
}

const RELAY_TRIES = 3
// the time a relay gets to answer /healthz; a test shortens it
const relayWaitMs =
  Number(process.env.TALOS_VERIFY_RELAY_WAIT_MS) > 0 ? Number(process.env.TALOS_VERIFY_RELAY_WAIT_MS) : 30_000

async function main() {
  const args = parseArgs(process.argv.slice(2), { repeatable: ['cli', 'run', 'expect-text'] })
  const label = args.label
  if (label !== 'before' && label !== 'after') throw new Usage('--label must be before or after')
  const wt = args.worktree && resolve(args.worktree)
  if (!wt || !existsSync(join(wt, 'apps/bridge/src/cli.ts')))
    throw new Usage('--worktree <dir> must be a Talos checkout')
  const route = safePart('route', args.route)
  const cli = (args.cli ?? []).map(parseStep)
  const runs = args.run ?? []
  if (cli.length + runs.length === 0) throw new Usage('nothing to run: pass --cli and/or --run')
  const routeList = args['route-list'] ? readFileSync(args['route-list'], 'utf8') : ''
  if (label === 'after' && !routeList.trim())
    throw new Usage(
      'an "after" run needs --route-list <file> (every sender, device and platform; exercised or NOT exercised and why)',
    )
  if (!existsSync(join(wt, 'node_modules')))
    throw new Unreachable(
      `${wt}/node_modules is missing: run "pnpm install --frozen-lockfile --ignore-scripts" there first`,
    )

  const sha = spawnSync('git', ['-C', wt, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() !== ''
  const tree = dirty ? `${sha}-dirty` : sha
  const dir = join(evidenceRoot(), safePart('sha', args.sha ?? sha))
  mkdirSync(dir, { recursive: true })

  installSignalCleanup()
  const T = mkdtempSync(join(tmpdir(), 'talos-verify-bridge-'))
  onInterrupt(() => rmSync(T, { recursive: true, force: true }))
  const home = join(T, 'talos-home')
  const fakeHome = join(T, 'home')
  mkdirSync(fakeHome)
  const env = cleanEnv(process.env, home, fakeHome)
  const t0 = Date.now()
  const lines = []
  const redact = (t) => String(t).split(T).join('<temp>')
  const record = (title, r) => {
    lines.push(`$ ${title}`, `(exit ${r.code}${r.timedOut ? ', TIMED OUT' : ''})`)
    if (r.stdout.trim()) lines.push(redact(r.stdout.trimEnd()))
    if (r.stderr.trim()) lines.push(`[stderr] ${redact(r.stderr.trimEnd())}`)
    lines.push('')
  }
  let relayPid = null
  const problems = []
  try {
    if (cli.length > 0) {
      const build = await runGroup('pnpm', ['--filter', '@talos-app/relay', 'build'], {
        cwd: wt,
        env,
        timeoutMs: 240_000,
      })
      if (build.code !== 0)
        throw new Unreachable(
          `the relay build failed (exit ${build.code}): ${redact(`${build.stdout}\n${build.stderr}`.trim().split('\n').slice(-6).join(' / '))}`,
        )
      let origin = ''
      for (let attempt = 1; ; attempt++) {
        // The port is held while `init` runs, which takes seconds (no other bind on 127.0.0.1 and no ephemeral port pick can take
        // it; a wildcard bind on macOS can), and given up right before the relay starts. A port that turns out to be someone
        // else's (waitRelay) is given up: that relay is stopped and the whole start is tried again on a new port, each try with
        // a data folder and key of its own. A relay that is only silent, or that exits for another reason, is not tried again.
        const held = await reservePort()
        const port = held.port
        origin = `http://127.0.0.1:${port}`
        let pubkey
        try {
          const init = await runGroup('bun', ['run', 'apps/bridge/src/cli.ts', 'init', '--relay-url', origin], {
            cwd: wt,
            env,
            timeoutMs: 60_000,
          })
          pubkey = /BRIDGE_PUBKEY=(\S+)/.exec(init.stdout)?.[1]
          if (init.code !== 0 || !pubkey)
            throw new Unreachable(
              `talos-app init failed in the temp home (exit ${init.code}): ${redact(`${init.stdout}${init.stderr}`.trim().slice(0, 300))}`,
            )
        } finally {
          await held.release()
        }
        const relayLog = join(T, 'relay.log')
        const logFd = openSync(relayLog, 'w')
        const relay = spawn('node', ['apps/relay/dist/index.js'], {
          cwd: wt,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: {
            ...env,
            NODE_ENV: 'development',
            PORT: String(port),
            PUBLIC_ORIGIN: origin,
            RP_ID: '127.0.0.1',
            DATA_DIR: join(T, `relay-data-${attempt}`),
            DATA_KEY: randomBytes(32).toString('base64'),
            BRIDGE_PUBKEY: pubkey,
            TRUST_PROXY_HOPS: '0',
            LOG_LEVEL: 'warn',
          },
        })
        closeSync(logFd)
        relayPid = relay.pid
        let gone = null
        relay.on('exit', (code, signal) => {
          gone = code === null ? `signal ${signal}` : `code ${code}`
        })
        trackGroup(relayPid)
        writeFileSync(join(T, 'relay.pid'), `${relayPid}\n`)
        mkdirSync(join(T, `relay-data-${attempt}`), { recursive: true })
        const found = await waitRelay(origin, port, relayWaitMs, () => gone !== null)
        if (found === 'up') break
        const log = readFileSync(relayLog, 'utf8')
        const tail = redact(log.trim().split('\n').slice(-5).join(' / '))
        // the whole log is read for the port error: a stack trace puts it far above the last lines
        const retry = found === 'taken' || (found === 'gone' && /EADDRINUSE/.test(log))
        if (!retry || attempt >= RELAY_TRIES)
          throw new Unreachable(
            found === 'silent'
              ? `the relay (pid ${relayPid}) did not answer /healthz within ${relayWaitMs / 1000} s (nobody else is on its port): ${tail}`
              : found === 'gone'
                ? `the relay (pid ${relayPid}) exited (${gone}) before /healthz answered: ${tail}`
                : `the relay's port ${port} is held by another process (${attempt} tries): ${tail}`,
          )
        lines.push(
          `# relay port ${port} did not work (${found === 'gone' ? 'the relay found it in use' : 'another process has it'}); trying another port`,
          '',
        )
        try {
          process.kill(-relayPid, 'SIGKILL')
        } catch {}
        untrackGroup(relayPid)
        relayPid = null
      }
      lines.push(
        `# throwaway home and a real relay of this checkout at ${origin} (pid ${relayPid}); the bridge key is the one init just made`,
        '',
      )
      for (const step of cli) {
        if (step.text.trim() === '@stop-relay') {
          // the relay goes away mid-run: the next step shows what the owner sees then (never an empty or ok reading)
          if (relayPid === null) {
            lines.push('# no relay running: nothing to stop', '')
            continue
          }
          process.kill(-relayPid, 'SIGTERM')
          await new Promise((r) => setTimeout(r, 800))
          lines.push(`# relay stopped (pid ${relayPid})`, '')
          untrackGroup(relayPid)
          relayPid = null
          continue
        }
        const words = step.text.trim().split(/\s+/).filter(Boolean)
        const r = await runGroup('bun', ['run', 'apps/bridge/src/cli.ts', ...words], {
          cwd: wt,
          env,
          timeoutMs: 60_000,
        })
        record(`talos-app ${step.text}`, r)
        if (r.code !== step.exit) problems.push(`talos-app ${step.text}: exit ${r.code}, wanted ${step.exit}`)
      }
    }
    for (const cmd of runs) {
      const r = await runGroup('bash', ['-c', cmd], { cwd: wt, env, timeoutMs: 300_000 })
      record(cmd, r)
      if (r.code !== 0) problems.push(`${cmd}: exit ${r.code}`)
    }
    const text = lines.join('\n')
    for (const re of args['expect-text'] ?? [])
      if (!new RegExp(re).test(text)) problems.push(`the transcript does not match /${re}/`)
    const file = captureName({ surface: 'cli', route, theme: 'na', label, ext: 'txt' })
    writeFileSync(join(dir, file), `${text}\n# ${((Date.now() - t0) / 1000).toFixed(1)} s, tree ${tree}\n`)
    const index = loadIndex(dir)
    index.title = index.title || `for ${args.sha ?? sha}`
    if (routeList.trim()) index.routeList = routeList
    addCapture(index, {
      file,
      surface: 'cli',
      route,
      theme: 'na',
      label,
      tree,
      result:
        problems.length === 0
          ? 'ok'
          : label === 'before'
            ? `observed: ${problems.join('; ')}`
            : `FAIL: ${problems.join('; ')}`,
      proves:
        args.proves ??
        'the real bridge CLI against a real relay and a throwaway home: what the owner reads at a terminal',
      facts: { steps: cli.length + runs.length },
    })
    saveIndex(dir, index)
    console.log(
      `bridge: ${cli.length + runs.length} steps in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${join(dir, file)}`,
    )
    for (const p of problems) console.error(`${label === 'after' ? 'FAIL' : 'observed'} ${p}`)
    return problems.length > 0 && label === 'after' ? EXIT.failed : EXIT.ok
  } finally {
    if (relayPid) {
      try {
        process.kill(-relayPid, 'SIGTERM')
        await new Promise((r) => setTimeout(r, 500))
        process.kill(-relayPid, 'SIGKILL')
      } catch {}
    }
    rmSync(T, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      if (e instanceof Usage) {
        console.error(`verify: ${e.message}`)
        process.exit(EXIT.usage)
      }
      if (e instanceof Unreachable) {
        console.error(`verify: SURFACE NOT REACHED: ${e.message}`)
        process.exit(EXIT.unreachable)
      }
      console.error(`verify: unexpected error: ${e?.stack ?? e}`)
      process.exit(EXIT.failed)
    },
  )
}

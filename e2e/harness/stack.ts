// The whole product in one process tree, with nothing mocked on the path under test:
//   - the BUILT relay bundle (apps/relay/dist/index.js), booted in this process with a controllable clock, serving the
//     BUILT web app (apps/web/dist) on one origin, like production;
//   - the real bridge (apps/bridge/src/server.ts under Bun) behind the testkit's FakeClaude, an MCP client that stands in
//     for a Claude Code session;
//   - the real bridge CLI (`init`, `enroll`) for the Mac-side steps.
// Only the speech-to-text and text-to-speech commands are stubs (the bridge runs them exactly as it would a real one).
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { createECDH, randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type AgentDriverOptions, FakeClaude } from '@talos-app/testkit'
import { clockEnv, worldOffsetMs } from './clock.ts'
import { BRIDGE_CLI, BRIDGE_DIR, BRIDGE_SERVER, RELAY_DIST, STUBS_DIR, WEB_DIST } from './paths.ts'

type RelayModule = typeof import('../../apps/relay/src/index.ts')
export type RunningRelay = Awaited<ReturnType<RelayModule['startRelay']>>

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

export async function waitUntil(fn: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 40))
  }
}

const shQuote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`

/**
 * The command wrapped so it runs on a real pty. `enroll`, `devices` and the other owner-only commands refuse unless stdin
 * and stdout are a terminal, and there is deliberately no switch that turns that check off. `script` is on every Mac and
 * every Linux CI image; macOS spells it `script -q /dev/null cmd args`, Linux `script -qec 'cmd args' /dev/null` (-e passes
 * the child's exit code on). Output comes back with \r\n line ends and the typed input echoed, as a terminal shows it, and
 * stderr is mixed into it.
 *
 * Node hands a child a socket for stdin, and macOS `script` refuses a socket (tcgetattr: Operation not supported), so the
 * input goes through `cat` first, which gives `script` an ordinary pipe. The Cli closes our end when the child exits.
 */
export function onPty(argv: string[]): [string, string[]] {
  const script =
    process.platform === 'darwin' ? ['-q', '/dev/null', ...argv] : ['-qec', argv.map(shQuote).join(' '), '/dev/null']
  return ['/bin/bash', ['-c', 'exec script "$@" < <(exec cat)', 'bash', ...script]]
}

/** A running `talos-app` CLI command with its output captured and stdin open. */
export class Cli {
  out = ''
  err = ''
  exit: number | null = null
  trace: string[] = []
  private t0 = Date.now()
  private child: ChildProcessWithoutNullStreams
  private home: string
  constructor(home: string, args: string[], extraEnv: Record<string, string> = {}) {
    this.home = home
    const [cmd, cmdArgs] = onPty(['bun', 'run', BRIDGE_CLI, ...args])
    this.child = spawn(cmd, cmdArgs, {
      cwd: BRIDGE_DIR,
      env: { ...process.env, TALOS_APP_HOME: home, ...extraEnv },
    })
    this.child.stdout.on('data', (d) => {
      this.out += d.toString()
      this.trace.push(`${Date.now() - this.t0}ms out ${JSON.stringify(d.toString())}`)
    })
    this.child.stderr.on('data', (d) => {
      this.err += d.toString()
    })
    this.child.on('exit', (code) => {
      this.exit = code ?? -1
      this.child.stdin.destroy() // lets the `cat` in front of the pty finish
    })
  }
  private pendingFiles(): string {
    try {
      return readdirSync(join(this.home, 'enroll-pending')).join(',')
    } catch {
      return '(none)'
    }
  }
  write(line: string): void {
    this.child.stdin.write(line)
  }
  async waitFor(re: RegExp, ms = 30_000): Promise<RegExpMatchArray> {
    let m: RegExpMatchArray | null = null
    await waitUntil(
      () => {
        m = this.out.match(re)
        return m !== null
      },
      `CLI output ${re} (saw: ${JSON.stringify(this.out.slice(-300))} ${this.err.slice(-200)} trace: ${this.trace.join(' | ')} exit=${this.exit} pending=${this.pendingFiles()})`,
      ms,
    )
    return m as unknown as RegExpMatchArray
  }
  async done(ms = 15_000): Promise<number> {
    await waitUntil(() => this.exit !== null, 'CLI exit', ms)
    return this.exit as number
  }
  kill(): void {
    this.child.kill()
  }
}

/** A throwaway VAPID key pair in the shape `web-push generate-vapid-keys` prints (base64url, uncompressed public key). */
export function vapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  }
}

export type Stack = Awaited<ReturnType<typeof startStack>>

export async function startStack(
  opts: { stt?: boolean; tts?: boolean; env?: Record<string, string>; at?: string } = {},
) {
  const root = mkdtempSync(join(process.env.E2E_TMP_ROOT ?? tmpdir(), 'talos-e2e-'))
  // With `at` or E2E_NOW, the relay and every bun process (bridge, CLI) run on one clock that starts at that instant.
  const worldOffset = worldOffsetMs(opts.at)
  const dataDir = join(root, 'relay-data')
  const home = join(root, 'bridge-home')
  mkdirSync(dataDir, { recursive: true })
  const port = await freePort()
  const origin = `http://localhost:${port}`

  // Mac side, step 1: `talos-app init` creates the key, config and bridge.env, and prints BRIDGE_PUBKEY.
  const init = spawnSync('bun', ['run', BRIDGE_CLI, 'init', '--relay-url', origin], {
    cwd: BRIDGE_DIR,
    env: { ...process.env, TALOS_APP_HOME: home, ...clockEnv(worldOffset) },
    encoding: 'utf8',
  })
  const pubkey = /BRIDGE_PUBKEY=([A-Za-z0-9_-]{43})/.exec(init.stdout)?.[1]
  if (init.status !== 0 || !pubkey) throw new Error(`talos-app init failed: ${init.stdout} ${init.stderr}`)

  // Relay: the built bundle, with a clock the tests can skew and a log recorder.
  const relayLog: string[] = []
  const skew = { ms: 0 }
  // Timers the relay has set and that have neither fired nor been cleared; a stopped relay must leave none.
  const liveTimers = new Set<unknown>()
  const clock = {
    now: () => Date.now() + worldOffset + skew.ms,
    setTimeout: (fn: () => void, ms: number) => {
      const h = setTimeout(() => {
        liveTimers.delete(h)
        fn()
      }, ms)
      liveTimers.add(h)
      h.unref?.()
      return h
    },
    clearTimeout: (h: unknown) => {
      liveTimers.delete(h)
      clearTimeout(h as ReturnType<typeof setTimeout>)
    },
  }
  const rec = (level: string, base: Record<string, unknown>) => ({
    debug: (o: object | string, m?: string) =>
      relayLog.push(JSON.stringify({ level: 'debug', ...base, ...wrap(o, m) })),
    info: (o: object | string, m?: string) => relayLog.push(JSON.stringify({ level: 'info', ...base, ...wrap(o, m) })),
    warn: (o: object | string, m?: string) => relayLog.push(JSON.stringify({ level: 'warn', ...base, ...wrap(o, m) })),
    error: (o: object | string, m?: string) =>
      relayLog.push(JSON.stringify({ level: 'error', ...base, ...wrap(o, m) })),
    child: (b: Record<string, unknown>) => rec(level, { ...base, ...b }),
  })
  const wrap = (o: object | string, m?: string) =>
    typeof o === 'string' ? { msg: o } : { ...o, ...(m ? { msg: m } : {}) }
  const mod = (await import(pathToFileURL(RELAY_DIST).href)) as RelayModule
  const vapid = vapidKeys()
  const env = mod.loadEnv({
    NODE_ENV: 'development',
    PUBLIC_ORIGIN: origin,
    RP_ID: 'localhost',
    DATA_DIR: dataDir,
    DATA_KEY: randomBytes(32).toString('base64'),
    BRIDGE_PUBKEY: pubkey,
    TRUST_PROXY_HOPS: '0',
    LOG_LEVEL: 'debug',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:owner@example.com',
    ...opts.env,
  })
  const boot = () => mod.startRelay({ env, port, host: '127.0.0.1', webDir: WEB_DIST, clock, log: rec('info', {}) })
  // `let`: stopRelay/startRelay swap it. Everything below reads the variable at call time, never a captured copy.
  let relay = await boot()
  let relayUp = true
  const bridgeOnline = (): boolean => relayUp && relay.services.bus.bridgeOnline()
  const liveRelay = (): RunningRelay => {
    if (!relayUp) throw new Error('the relay is stopped')
    return relay
  }

  const bridgeEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    TALOS_APP_HOME: home,
    TALOS_APP_RELAY_URL: origin,
    TALOS_APP_BRIDGE: '1',
    ...clockEnv(worldOffset),
    ...(opts.stt === false ? {} : { TALOS_APP_STT_CMD: JSON.stringify(['bash', join(STUBS_DIR, 'stt.sh'), '{in}']) }),
    ...(opts.tts === false
      ? {}
      : { TALOS_APP_TTS_CMD: JSON.stringify(['bash', join(STUBS_DIR, 'tts.sh'), '{out}', '{text}']) }),
    ...extra,
  })

  let claude: FakeClaude | null = null
  const stack = {
    root,
    dataDir,
    home,
    port,
    origin,
    /** The running relay. Throws while it is stopped, so a test never reads a closed database by accident. */
    get relay(): RunningRelay {
      return liveRelay()
    },
    get relayRunning(): boolean {
      return relayUp
    },
    relayLog,
    skew,
    /** The relay's clock, which is also the bridge's, plus any `skew`. */
    now: () => clock.now(),
    /** False when this stack runs on the wall clock. */
    movedClock: worldOffset !== 0,
    /** The env that puts another bun process (a hook the agent runs) on the stack's clock; empty on the wall clock. */
    clockEnv: clockEnv(worldOffset),
    bridgeKey: pubkey,
    vapidPublicKey: vapid.publicKey,
    get claude(): FakeClaude {
      if (!claude) throw new Error('the bridge is not running')
      return claude
    },
    /** Starts the bridge the way Claude Code does: an MCP stdio server, here driven by FakeClaude. */
    async startBridge(
      extra: {
        env?: Record<string, string>
        autoReply?: boolean
        /** MCP Apps: real MCP clients to connector servers plus the real hook command lines (testkit `AgentDriver`). */
        agentDriver?: AgentDriverOptions
        /** The Claude Code version FakeClaude reports as its MCP client version. */
        clientVersion?: string
      } = {},
    ): Promise<FakeClaude> {
      if (claude) throw new Error('the bridge is already running')
      const c = new FakeClaude({
        command: 'bun',
        args: ['run', BRIDGE_SERVER],
        cwd: BRIDGE_DIR,
        autoReply: extra.autoReply ?? true,
        env: bridgeEnv(extra.env),
        ...(extra.agentDriver ? { agentDriver: extra.agentDriver } : {}),
        ...(extra.clientVersion ? { clientVersion: extra.clientVersion } : {}),
      })
      await c.start()
      claude = c
      await waitUntil(bridgeOnline, 'the bridge to connect to the relay')
      return c
    },
    /**
     * A SECOND Mac session with the same bridge key (a copy of the key, config and pins in another folder), as if the
     * owner started Claude Code twice or copied the key. Returns its FakeClaude; it is not tracked by `stopBridge`.
     */
    async startSecondBridge(): Promise<{ claude: FakeClaude; home: string }> {
      const home2 = join(root, 'bridge-home-2')
      mkdirSync(home2, { recursive: true, mode: 0o700 })
      for (const f of ['bridge.key', 'config.json', 'devices.json', 'bridge.env']) {
        try {
          copyFileSync(join(home, f), join(home2, f))
        } catch {
          // devices.json may not exist yet
        }
      }
      const c = new FakeClaude({
        command: 'bun',
        args: ['run', BRIDGE_SERVER],
        cwd: BRIDGE_DIR,
        autoReply: true,
        env: { ...bridgeEnv(), TALOS_APP_HOME: home2 },
      })
      await c.start()
      return { claude: c, home: home2 }
    },
    /**
     * A graceful relay stop, as in a redeploy (sockets closed, database closed). It is NOT a crash. The port, the data
     * folder and the env (so the same DATA_KEY) are kept for `startRelay`.
     */
    async stopRelay(): Promise<void> {
      if (!relayUp) throw new Error('the relay is already stopped')
      relayUp = false
      await relay.stop()
    },
    /** How many timers on the relay's clock are still waiting to fire. Zero right after `stopRelay` unless something leaks. */
    relayTimersLeft(): number {
      return liveTimers.size
    },
    /**
     * Starts the relay again on the same port, data folder and env: the same database and keys. It is a new relay in the
     * same process (new in-memory state, same module cache, same clock), so anything the old one left running is still
     * running next to it.
     */
    async startRelay(): Promise<void> {
      if (relayUp) throw new Error('the relay is already running')
      relay = await boot()
      relayUp = true
    },
    /** Stops the bridge (a crash, as far as the relay can tell). */
    async stopBridge(): Promise<void> {
      const c = claude
      claude = null
      if (c) await c.stop()
      await waitUntil(() => !bridgeOnline(), 'the relay to notice the bridge is gone')
    },
    /** A hard crash: SIGKILL to the bridge process (no goodbye, no flush), found through its pid file. */
    async crashBridge(): Promise<void> {
      const pid = (JSON.parse(readFileSync(join(home, 'bridge.pid'), 'utf8')) as { pid: number }).pid
      const c = claude
      claude = null
      process.kill(pid, 'SIGKILL')
      await waitUntil(() => !bridgeOnline(), 'the relay to notice the crash')
      try {
        await c?.stop()
      } catch {
        // the transport is already gone
      }
    },
    /** Frames the relay still holds for the bridge because it has not acked them as consumed. */
    pendingForBridge(): number {
      return (liveRelay().services.db.prepare('select count(*) as n from core_outbox').get() as { n: number }).n
    },
    /** `talos-app <args>` on the Mac. */
    cli(args: string[]): Cli {
      return new Cli(home, args, bridgeEnv())
    },
    /** How many app WebSockets the relay holds open right now (one per signed-in tab). */
    appSocketCount(): number {
      return (liveRelay().services.bus as unknown as { apps: Map<string, unknown> }).apps.size
    },
    /** Kills every app WebSocket from the relay side (a dropped network, as far as the browser can tell). */
    dropAppSockets(): number {
      const hub = liveRelay().services.bus as unknown as {
        apps: Map<string, { conn: { terminate(): void } }>
      }
      let n = 0
      for (const a of hub.apps.values()) {
        a.conn.terminate()
        n++
      }
      return n
    },
    bridgeLog(): string {
      try {
        return readFileSync(join(home, 'bridge.log'), 'utf8')
      } catch {
        return ''
      }
    },
    async stop(): Promise<void> {
      try {
        await stack.stopBridge()
      } catch {
        // already gone
      }
      if (relayUp) await relay.stop()
      relayUp = false
      if (!process.env.E2E_KEEP) rmSync(root, { recursive: true, force: true })
    },
  }
  return stack
}

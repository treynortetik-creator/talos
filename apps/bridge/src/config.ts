// Bridge environment (spec 4.2): `$TALOS_APP_HOME/bridge.env` first, then the process environment wins.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BridgeEnv = {
  home: string
  /** TALOS_APP_BUNDLE: where the Mac app that started this agent is installed (the Mac sets it; status.json's `app_path` is it, checked). */
  appBundle?: string | undefined
  relayUrl: string | undefined
  live: boolean
  ttsCmd: string[] | undefined
  ttsExt: string
  ttsTimeoutS: number
  ffmpeg: string | undefined
  logLevel: string
  // ---- Schedules (docs/SCHEDULES.md S1.4) ----
  /** `auto` (discover), `chronos` (same, but never `none` on purpose) or `off` (no tab, no tools). */
  scheduler: 'auto' | 'chronos' | 'off'
  /** Absolute path to the `chronos` CLI; wins over PATH discovery. */
  chronosBin: string | undefined
  /** Passed to Chronos as CHRONOS_CONFIG. */
  chronosConfig: string | undefined
  /**
   * Set only by a test harness (TALOS_TEST_ROOT, read from the process too): a Chronos is used only if it lives under this
   * folder, symlinks followed (schedules/test-root.ts). Unset in production, where nothing changes.
   */
  testRoot: string | undefined
  /** Every adapter call is killed after this long (S2.4). */
  schedulerTimeoutMs: number
  /** How often the live bridge's schedule runner and refresh loops look (S3.2): never slower than the defaults, never under 5 s. */
  scheduleRunnerMs: number
  scheduleRefreshMs: number
  /** TEST BUILDS ONLY: passed to Chronos as CHRONOS_NOW. A production environment that sees it refuses to start. */
  chronosNow: string | undefined
  /** Directories searched for `chronos` (step 3 of discovery); from PATH. */
  pathDirs: string[]
  /** The owner's home directory (`~/.local/share/chronos/bin/chronos`); from HOME. */
  userHome: string
  /** Claude Code's config folder (CLAUDE_CONFIG_DIR, else `~/.claude`): where a worker's transcript is read for its context. */
  claudeConfigDir?: string | undefined
  /**
   * Where the owner's files for threads that have their own session are copied, one folder per thread: `~/.talos-inbox`
   * (TALOS_INBOX_ROOT changes it; the tests always do, so none touches the real one).
   */
  inboxRoot: string
  /** False only in tests: never probe PATH or ~/.local/share for a real Chronos. */
  chronosAutoDiscover: boolean
  /** Passed through to Chronos so it computes in the owner's zone. */
  tz: string | undefined
  /**
   * How many days of message history the Mac keeps, and so how far back search reaches (docs/V2-FEATURES.md V3.1, V10
   * Q1). Default 90; `0` = keep message text forever (TALOS_APP_HISTORY_DAYS).
   */
  historyDays: number
  /** The environment names this process runs under (test builds say `test`). */
  nodeEnv: string | undefined
  /** Headless `claude -p` runs export CHRONOS_JOB (S3.6). */
  chronosJob: string | undefined
  /**
   * Option C (docs/OPTION-C.md): set in a thread's own session. The server then runs in worker mode: no relay socket,
   * no pid takeover, and it refuses to start at all if TALOS_APP_BRIDGE=1 is set too.
   */
  workerThread: string | undefined
  /** The nonce the supervisor wrote for this start; the hub refuses a `hello` without it. */
  workerNonce: string | undefined
  /** O6: an ntfy topic the bridge posts to when it has had no relay connection for 10 minutes while the Mac is awake. Unset = off. */
  alertNtfyUrl: string | undefined
  /** `TALOS_EXPLAINER` (process or bridge.env): off, 0, false or no turns the plain explanation of permission cards off. */
  explainer: string | undefined
  /** MCP apps (MCP-APPS-SPEC): off unless TALOS_APP_APPS=1. Off, the bridge registers no app tool and answers app requests with a fixed refusal. */
  apps: boolean
}

export function defaultHome(): string {
  return join(homedir(), '.config', 'talos', 'app')
}

/** KEY=VALUE lines; `#` comments; optional single or double quotes; no interpolation. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = (m[2] as string).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1] as string] = v
  }
  return out
}

function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/** A JSON argv array of strings, or undefined (and `error` set) when it is not one. */
export function parseArgv(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  try {
    const v: unknown = JSON.parse(value)
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return v as string[]
  } catch {
    // fall through
  }
  return undefined
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 0 = forever; a positive whole number of days; anything else falls back to 90. */
function historyDays(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 90
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 36_500 ? n : 90
}

/**
 * A kill switch (flags.json, scripts/flags.test.ts): on only when its value is exactly `1`; unset, empty or anything else is
 * off, which is today's behaviour. The first source with a non-empty value decides, so a caller states its precedence by the
 * order (`[merged]` after loadEnv's merge; `[file, process]` where bridge.env must win); `fallback` only when none has one.
 */
export function flag(
  name: string,
  sources: Array<Record<string, string | undefined> | undefined>,
  fallback = false,
): boolean {
  for (const s of sources) {
    const v = s?.[name]
    if (v !== undefined && v !== '') return v === '1'
  }
  return fallback
}

export function loadEnv(processEnv: Record<string, string | undefined> = process.env): BridgeEnv {
  const home = processEnv.TALOS_APP_HOME || defaultHome()
  const merged: Record<string, string | undefined> = { ...readEnvFile(join(home, 'bridge.env')) }
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined && v !== '') merged[k] = v
  return {
    home,
    appBundle: merged.TALOS_APP_BUNDLE || undefined,
    relayUrl: merged.TALOS_APP_RELAY_URL?.replace(/\/+$/, ''),
    live: flag('TALOS_APP_BRIDGE', [merged]),
    ttsCmd: parseArgv(merged.TALOS_APP_TTS_CMD),
    ttsExt: (merged.TALOS_APP_TTS_EXT || 'mp3').replace(/^\./, '').replace(/[^A-Za-z0-9]/g, '') || 'mp3',
    ttsTimeoutS: num(merged.TALOS_APP_TTS_TIMEOUT_S, 120),
    ffmpeg: merged.TALOS_APP_FFMPEG || undefined,
    logLevel: merged.TALOS_APP_LOG || 'info',
    scheduler:
      merged.TALOS_APP_SCHEDULER === 'off' || merged.TALOS_APP_SCHEDULER === 'chronos'
        ? merged.TALOS_APP_SCHEDULER
        : 'auto',
    chronosBin: merged.TALOS_APP_CHRONOS_BIN || undefined,
    // Off only in test runs (test/preload.ts): a test bridge must never find the owner's real Chronos by PATH or
    // ~/.local/share and act on its live claims (2026-11-03, a test closed the live morning brief). Read from the process
    // too, because tests build their env by hand; an explicit TALOS_APP_CHRONOS_BIN still wins.
    chronosAutoDiscover:
      (merged.TALOS_APP_CHRONOS_AUTODISCOVER ?? process.env.TALOS_APP_CHRONOS_AUTODISCOVER) !== 'off',
    chronosConfig: merged.TALOS_APP_CHRONOS_CONFIG || undefined,
    testRoot: merged.TALOS_TEST_ROOT ?? process.env.TALOS_TEST_ROOT,
    schedulerTimeoutMs: Math.round(num(merged.TALOS_APP_SCHEDULER_TIMEOUT_S, 15) * 1000),
    // The browser suite's real bridge runs these faster, so a job that comes due is offered within seconds, not a minute later
    scheduleRunnerMs: Math.round(Math.min(60, Math.max(5, num(merged.TALOS_APP_SCHEDULE_RUNNER_S, 60))) * 1000),
    scheduleRefreshMs: Math.round(Math.min(30, Math.max(5, num(merged.TALOS_APP_SCHEDULE_REFRESH_S, 30))) * 1000),
    chronosNow: merged.TALOS_APP_CHRONOS_NOW || undefined,
    pathDirs: (merged.PATH ?? '').split(':').filter(Boolean),
    userHome: merged.HOME || homedir(),
    // read from the process too, like the inbox root: a test's hand-built env still gets the test folder (test/preload.ts)
    claudeConfigDir: merged.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || undefined,
    // read from the process too, like the Chronos switch above: a test's hand-built env still gets the test root (test/preload.ts)
    inboxRoot:
      merged.TALOS_INBOX_ROOT || process.env.TALOS_INBOX_ROOT || join(merged.HOME || homedir(), '.talos-inbox'),
    tz: merged.TZ || undefined,
    nodeEnv: merged.NODE_ENV || undefined,
    historyDays: historyDays(merged.TALOS_APP_HISTORY_DAYS),
    chronosJob: merged.CHRONOS_JOB || undefined,
    // never from bridge.env: only the supervisor's launch environment makes a worker
    workerThread: processEnv.TALOS_APP_WORKER_THREAD || undefined,
    workerNonce: processEnv.TALOS_APP_WORKER_NONCE || undefined,
    alertNtfyUrl: merged.TALOS_APP_ALERT_NTFY_URL?.trim() || undefined,
    explainer: merged.TALOS_EXPLAINER?.trim() || undefined,
    apps: flag('TALOS_APP_APPS', [merged]),
  }
}

/** Paths under $TALOS_APP_HOME. */
export function paths(home: string, inboxRoot: string = join(homedir(), '.talos-inbox')) {
  return {
    home,
    /** The threads' inbox folders (see BridgeEnv.inboxRoot): outside the Talos home on purpose. */
    inbox: inboxRoot,
    configJson: join(home, 'config.json'),
    bridgeKey: join(home, 'bridge.key'),
    bridgeKeyNext: join(home, 'bridge.key.next'),
    bridgeKeyPrev: join(home, 'bridge.key.prev'),
    /** The rotation certificates the OLD key signed (attest.ts): 0600, a JSON array, appended by `rotate`. */
    bridgeRotations: join(home, 'bridge.rotations.json'),
    devicesJson: join(home, 'devices.json'),
    historyDb: join(home, 'history.sqlite'),
    media: join(home, 'media'),
    approved: join(home, 'approved'),
    enrollPending: join(home, 'enroll-pending'),
    /** The Mac app's one-shot setup request (onboarding-hello.ts): a small file the app writes here, in a folder only this user may write. */
    onboardingDir: join(home, 'onboarding'),
    pid: join(home, 'bridge.pid'),
    envFile: join(home, 'bridge.env'),
    /** The Talos mod's shared secret (docs/CLAUDE-CODE.md C2.3): 0600, rewritten by the live bridge, read by the mod. */
    modKey: join(home, 'mod.key'),
    /**
     * Option C: the live bridge's local socket for worker sessions (docs/OPTION-C.md), in its own 0700 folder. Not in home
     * itself: on Linux, Bun cannot fs.watch a folder that holds a unix socket (ENXIO, and the watch ends), and the bridge
     * watches home for config edits; with the socket there every edit waited for the 10 s poll (found on Titan, WSL).
     */
    hubDir: join(home, 'run'),
    hubSock: join(home, 'run', 'hub.sock'),
    /** Where it was before: a client falls back to it for one release, so a bridge not yet restarted is still reached. */
    hubSockLegacy: join(home, 'hub.sock'),
    log: join(home, 'bridge.log'),
    /** The live bridge's content-free health file (DESKTOP-SPEC 6.2): read by the Mac menu bar and `talos-app status`. */
    status: join(home, 'status.json'),
    /** The Mac's stall watchdog asks here for a second delivery of Main's oldest unseen owner message (main-resend.ts). */
    mainResend: join(home, 'main-resend.json'),
    /** What the bridge answers it with, for the Mac to read: {v, unseen_at, outcome: 'sent' | 'failed', delivered, why?}. */
    mainResendResult: join(home, 'main-resend-result.json'),
    /** The Mac's updater names here (in its own 0700 folder) the threads whose turn an Update now cut off ({v, at, version, threads}); update-resend.ts reads it once and offers, never sends. */
    updateInterrupted: join(home, 'auto-update', 'update-interrupted.json'),
    /** The relay's last `ready.features`, so a restart's first hello is the one it takes (relay-features-memo.ts). */
    relayFeatures: join(home, 'relay-features.json'),
    /** The versions the live bridge started cleanly from, newest first; `talos-app rollback` reads it. */
    goodStarts: join(home, 'good-starts.json'),
    /** Undo points' copies of folders that are not git (undo/snapshot.ts). */
    undo: join(home, 'undo'),
  }
}
export type BridgePaths = ReturnType<typeof paths>

/** `https://host` or `http://127.0.0.1:port` to the matching ws(s) URL for `/bridge`. */
export function relayWsUrl(relayUrl: string): string {
  const u = new URL(relayUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/bridge'
  u.search = ''
  u.hash = ''
  return u.toString()
}

/**
 * Spec 4.2: the relay URL is https. Plain http is for a relay on this machine only (local development and the tests).
 * Anything else would carry the owner's messages and the signed bridge traffic in cleartext.
 */
export function assertSecureRelayUrl(relayUrl: string): void {
  let u: URL
  try {
    u = new URL(relayUrl)
  } catch {
    throw new Error(`not a URL: ${relayUrl}`)
  }
  if (u.protocol === 'https:') return
  if (u.protocol === 'http:' && isLoopbackUrl(relayUrl)) return
  throw new Error(`the relay URL must be https (plain http is only allowed for localhost): ${relayUrl}`)
}

export function isLoopbackUrl(relayUrl: string): boolean {
  const h = new URL(relayUrl).hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
}

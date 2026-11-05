import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }

export const MCP_SERVER_NAME = 'talos-app'
export const CHANNEL_CAPABILITY = 'claude/channel'
export const BRIDGE_CLIENT_NAME = 'talos-app-bridge'

/** Runs a command, returns its trimmed stdout, or undefined on any failure. Injectable for tests. */
export type VersionRun = (cmd: string, args: string[], cwd: string) => string | undefined

const realRun: VersionRun = (cmd, args, cwd) => {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    if (r.status !== 0) return undefined
    return r.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export type ResolvedVersion = {
  /** What a person reads: APP_VERSION, else `git describe --tags --always --dirty` (a short sha with no tags), else package.json. */
  version: string
  /** The 7-character commit this checkout is on; undefined when there is no git or this is not the talos-app repo. */
  commit: string | undefined
}

/**
 * The bridge's version, resolved from git the way scripts/version.mjs does (the same order, minus the Railway sha: a Mac has
 * none), falling back to the package value (0.0.0). `repoDir` is any folder inside the checkout. A git repository that is
 * not this one (the bridge copied under another project) is ignored, so it can't report someone else's commit.
 */
export function resolveVersion(
  repoDir: string,
  opts: { env?: Record<string, string | undefined>; run?: VersionRun; exists?: (p: string) => boolean } = {},
): ResolvedVersion {
  const run = opts.run ?? realRun
  const exists = opts.exists ?? existsSync
  const top = run('git', ['rev-parse', '--show-toplevel'], repoDir)
  const ours = top !== undefined && exists(join(top, 'apps', 'bridge', 'src', 'version.ts'))
  const commit = ours ? run('git', ['rev-parse', '--short=7', 'HEAD'], repoDir) : undefined
  const fromEnv = (opts.env ?? process.env).APP_VERSION?.trim()
  if (fromEnv) return { version: fromEnv, commit }
  const described = ours ? run('git', ['describe', '--tags', '--always', '--dirty'], repoDir) : undefined
  return { version: described ?? pkg.version, commit }
}

/** The checkout this file lives in: apps/bridge/src -> repo root. */
export const REPO_DIR: string = resolve(dirname(import.meta.path), '..', '..', '..')

// Resolved once, at start: a long-running bridge reports the code it was started from, not whatever a later `git pull` put on disk.
const RESOLVED = resolveVersion(REPO_DIR)
export const BRIDGE_VERSION: string = RESOLVED.version
export const BRIDGE_COMMIT: string | undefined = RESOLVED.commit
/** True when the checkout had edited tracked files at start (`git describe --dirty`). Read once, like the commit. */
export const BRIDGE_DIRTY: boolean = RESOLVED.version.endsWith('-dirty')

export type Skew = { level: 'ok' | 'warn'; text: string } | undefined

/** `abc1234` or `abc1234-dirty` -> `abc1234`; anything else (dev, a tag, empty) -> undefined. */
export function shaOf(v: string | undefined): string | undefined {
  const m = /^([0-9a-f]{7,40})(-dirty)?$/.exec(v?.trim() ?? '')
  return m?.[1]?.slice(0, 7)
}

/**
 * Compares this Mac's commit with the relay's. The relay reports a short sha, or `dev` for an unbundled run; either side
 * unknown means nothing can be said, so no warning (a guess here would be a false alarm).
 */
export function versionSkew(bridgeCommit: string | undefined, relayVersion: string | undefined): Skew {
  const b = shaOf(bridgeCommit)
  const r = shaOf(relayVersion)
  if (!b || !r) return undefined
  if (b === r) return { level: 'ok', text: `bridge and relay are both at ${b}` }
  return {
    level: 'warn',
    text: `this Mac runs ${b} and the relay runs ${r}. If the update changed the relay, deploy it from Railway; if it did not, they can differ safely`,
  }
}

/**
 * Which commit to compare with the relay, and whether the Mac is running older code than it has on disk. `talos-app status`
 * and `doctor` are short-lived processes, so their own BRIDGE_COMMIT is the code ON DISK. After `talos-app update` and before a
 * restart the running bridge is older than that; the running one is whatever it wrote to status.json at start.
 */
export function commitReport(
  bridge: { running: boolean; startedFrom: string | null | undefined },
  onDisk: string | undefined,
): { commit: string | undefined; note: string | undefined } {
  if (!bridge.running) return { commit: shaOf(onDisk), note: undefined } // nothing runs: what the next start will run
  const started = shaOf(bridge.startedFrom ?? undefined)
  if (!started) return { commit: undefined, note: undefined } // an older bridge that doesn't say: no guess
  const disk = shaOf(onDisk)
  if (disk && disk !== started)
    return {
      commit: started,
      note: `the running bridge started from ${started} but this folder is now at ${disk}. Restart the agent to run the new code`,
    }
  return { commit: started, note: undefined }
}

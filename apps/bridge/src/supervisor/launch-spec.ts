// A thread session's launch spec on Linux, for restart-on-update (packages/protocol spec-hash.ts holds the procedure and the
// vectors the Mac shares). Built from what the start actually computes: the argv, the variables it sets on top of the login
// environment, and the bytes of every file it writes for the session, before they are written, so the same function gives the
// hash of a launch that has not happened (the update check) and of one that has (WorkerLaunched.spec_hash).
import { createHash } from 'node:crypto'
import { type LaunchSpecT, specHash } from '@talos-app/protocol'
import { workerEnvStripRulesText } from './worker-spec.ts'

/**
 * Never in the spec (one list, as the procedure asks): the values that differ on every launch. The nonce (its variable; its
 * file is written by the start itself, never one of `files`) and the session id, which rides in argv as the value of a session
 * flag (`--resume`, `-r`, `--session-id`, or their `=` forms) and is dropped with the flag.
 */
export const LAUNCH_SPEC_EXCLUDED_ENV = ['TALOS_APP_WORKER_NONCE'] as const
const SESSION_FLAGS = ['--resume', '-r', '--session-id'] as const

/** argv without the session flag and its id (both forms), everything else in order. */
export function argvWithoutSession(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if ((SESSION_FLAGS as readonly string[]).includes(a)) {
      i++ // and its value
      continue
    }
    if (SESSION_FLAGS.some((f) => f.startsWith('--') && a.startsWith(`${f}=`))) continue
    out.push(a)
  }
  return out
}

export type LaunchSpecInputs = {
  /** The launch's argv, the program first. */
  argv: readonly string[]
  /** The whole environment the session gets. */
  env: Readonly<Record<string, string>>
  /** The login environment it was built on: only what the start sets or changes over it counts. */
  baseEnv: Readonly<Record<string, string>>
  /** Each file the start writes for the session, by its name in the worker's folder: its exact bytes (absent: not written). */
  files: Readonly<Record<string, string | Uint8Array | null | undefined>>
  /** The strip rule's text; none: this build's (worker-spec.ts). Given only by a test of a rule that changed. */
  stripRules?: string
}

/** The spec's name for the strip rule: not a file the start writes, the rule its environment is stripped by. */
export const STRIP_RULES_ENTRY = 'env-strip-rules'
/** The instructions a session outside the agent folder is handed (its token replaced): one file of the spec. */
export const INSTRUCTIONS_ENTRY = 'system-prompt.md'

const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')

/** WorkerLaunched.instructions_hash: the same digest the spec holds for the instructions file, as a spec hash is written. */
export const instructionsDigest = (bytes: string | Uint8Array): string => `sha256:${sha(bytes)}`

/**
 * The procedure's object for this launch. env: what the start sets or changes over the login environment. What it strips from
 * that environment is hashed as its RULE, a file of the spec (worker-spec.ts WORKER_ENV_STRIP_RULES), never as the names that
 * happened to be there: a release that strips a new name restarts sessions, a login environment that drifts does not (Delphi).
 */
export function launchSpec(i: LaunchSpecInputs, digests: Readonly<Record<string, string>> = {}): LaunchSpecT {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(i.env))
    if (i.baseEnv[k] !== v && !(LAUNCH_SPEC_EXCLUDED_ENV as readonly string[]).includes(k)) env[k] = v
  const files: Record<string, string> = {}
  for (const [name, bytes] of Object.entries(i.files))
    if (bytes !== null && bytes !== undefined) files[name] = sha(bytes)
  // a file known only by its digest (the update check puts a recorded instructions digest back in): the same entry
  for (const [name, hex] of Object.entries(digests)) files[name] = hex
  files[STRIP_RULES_ENTRY] = sha(i.stripRules ?? workerEnvStripRulesText())
  return { v: 1, argv: argvWithoutSession(i.argv), env, files }
}

/** spec_hash for this launch; `digests`: files given by their sha256 hex instead of their bytes. */
export const launchSpecHash = (i: LaunchSpecInputs, digests: Readonly<Record<string, string>> = {}): string =>
  specHash(launchSpec(i, digests))

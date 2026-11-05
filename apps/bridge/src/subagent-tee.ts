#!/usr/bin/env bun
// `talos-app subagent-tee [-- <original command...>]` (docs/SUBAGENTS.md 5.2). Claude Code runs it as the
// `subagentStatusLine` command once per refresh tick, while subagent rows are on screen, with the rows on stdin
// (base hook fields, `columns`, `tasks[]`). It keeps the CLI's own row data ({id, name, agentType, status, label,
// description, startTime, model, tokenCount} per task) in `$TALOS_APP_HOME/state/agents-tee/<session id>.json` (one file
// per session, so two live sessions never overwrite each other), written atomically, for the Talos mod to merge. It PRINTS NOTHING, so the CLI keeps its default rows (DOC: "Omit a task's id to keep the
// default rendering"); wrapped around the owner's own command it passes that command's stdout through unchanged.
//
// Kept import-light (node: builtins only, no workspace code) so it starts fast and never waits: test/agents.test.ts pins
// the imports, the absence of any sleep, lock or retry, and its CPU and elapsed time as a ratio to an empty bun start. It
// must exit 0 on bad input too. Nothing it reads is sent anywhere; the file is overwritten each tick and blanked at session end by the mod.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TEE_DIR = join('state', 'agents-tee')
/** The session's file under the home; undefined for a session id that cannot be a file name (nothing is written). */
export function teeFileOf(sessionId: unknown): string | undefined {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(sessionId)
    ? join(TEE_DIR, `${sessionId}.json`)
    : undefined
}
const MAX_TASKS = 100
const MAX_STR = 1000
/** The original command, when wrapped, gets this long before its row overrides are given up on. */
const WRAPPED_TIMEOUT_MS = 2000

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_STR) : undefined)
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export type TeeTaskOut = {
  id: string
  name?: string
  agentType?: string
  status?: string
  label?: string
  description?: string
  startTime?: number
  model?: string
  tokenCount?: number
}

/** The kept fields of each task; anything that is not a task with a string id is skipped. Never throws. */
export function teeTasks(input: unknown): TeeTaskOut[] {
  const tasks = isObj(input) && Array.isArray(input.tasks) ? input.tasks : []
  const out: TeeTaskOut[] = []
  for (const t of tasks.slice(0, MAX_TASKS)) {
    if (!isObj(t)) continue
    const id = s(t.id)
    if (!id) continue
    const row: TeeTaskOut = { id }
    const fields = {
      name: s(t.name),
      agentType: s(t.agentType),
      status: s(t.status),
      label: s(t.label),
      description: s(t.description),
      startTime: n(t.startTime),
      model: s(t.model),
      tokenCount: n(t.tokenCount),
    }
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) (row as Record<string, unknown>)[k] = v
    out.push(row)
  }
  return out
}

export function teeHome(env: Record<string, string | undefined>): string {
  return env.TALOS_APP_HOME || join(env.HOME || homedir(), '.config', 'talos', 'app')
}

/** Atomic: a temp file in the same folder, then rename. 0600; the folder is created 0700 if missing. */
export function writeTee(home: string, sessionId: unknown, tasks: TeeTaskOut[], now: number): string | undefined {
  const file = teeFileOf(sessionId)
  if (!file) return undefined
  const path = join(home, file)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.agents-tee.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, JSON.stringify({ v: 1, at: now, session_id: sessionId, tasks }), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  return path
}

/**
 * One tick. `stdin` is the CLI's JSON; `wrapped` the owner's own command (argv), run with the same stdin and its stdout
 * returned for the CLI. Returns what to print: '' unless wrapped. Any failure of ours is swallowed (exit 0, print
 * nothing extra): a broken tee must never break the CLI's rows.
 */
export function runTee(
  stdin: string,
  wrapped: string[],
  env: Record<string, string | undefined>,
  now: number = Date.now(),
): { stdout: string } {
  try {
    const input: unknown = JSON.parse(stdin)
    writeTee(teeHome(env), isObj(input) ? input.session_id : undefined, teeTasks(input), now)
  } catch {
    // bad JSON, unwritable home: nothing kept this tick
  }
  if (wrapped.length === 0) return { stdout: '' }
  try {
    const [cmd, ...args] = wrapped as [string, ...string[]]
    const r = spawnSync(cmd, args, {
      input: stdin,
      encoding: 'utf8',
      timeout: WRAPPED_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: env as NodeJS.ProcessEnv,
    })
    return { stdout: typeof r.stdout === 'string' ? r.stdout : '' }
  } catch {
    return { stdout: '' }
  }
}

/** argv after `subagent-tee`: nothing, or `-- <command> [args...]`. */
export function wrappedOf(argv: string[]): string[] {
  const i = argv.indexOf('--')
  return i === -1 ? [] : argv.slice(i + 1)
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export function mainTee(argv: string[]): number {
  const { stdout } = runTee(readStdin(), wrappedOf(argv), process.env)
  if (stdout) process.stdout.write(stdout)
  return 0
}

if (import.meta.main) process.exit(mainTee(process.argv.slice(2)))

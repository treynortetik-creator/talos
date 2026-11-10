// What a thread's own session (a worker) has in its context, for the app's chip and Session panel (docs/OPTION-C.md 9.3).
// The numbers come from the worker's own transcript, `<Claude config dir>/projects/<folder>/<session id>.jsonl`, which
// Claude Code appends to with every model reply: the last main-chain reply's `usage` is what that call put in the window
// (input + cache creation + cache read, the same sum Claude Code's status line uses for `used_percentage`). So a reading is
// as fresh as the worker's last reply, and it is read when the hub polls (every 10 s). The window is not in the transcript:
// `[1m]` in the worker's model means 1M, anything else is 200k, and a reading above 200k proves the window is 1M (this errs
// high, never low). The transcript's own model id never carries `[1m]`, so the model comes from how the worker was LAUNCHED:
// an explicit model is passed as `--model` (WorkerSpec.swift `args += ["--model", ...]`), but `inherit` and `default` pass
// none, so Claude Code takes `model` from its settings files: the thread folder's `.claude/settings.local.json` and
// `.claude/settings.json`, then `<Claude config dir>/settings.json` (the worker's own `--settings` file sets no model). Main's
// LIVE `/model` is never used: main can switch to 1M while the worker stays on its launch model. A parked worker keeps its
// file, so its last reading stays.
//
// KNOWN LIMITATION: `/clear` typed in a worker's pane starts a new session id that workers.json never learns, so the chip
// keeps the reading from before the clear until the worker is restarted. Falling back to "the newest file in the folder" is
// not an option: the agent folder is shared with main, so the newest file may be main's.
//
// Nothing here starts a process or writes a file. A transcript that is missing or does not read gives a state with no
// `context`, never an error, and never main's numbers. The state is sent as a scoped `session.state` (SessionState.scope),
// which only a relay that lists `thread-sessions/1` is sent: an older app's strict SessionState refuses `scope`.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_THREAD_SESSION_STATES, type SessionStateT, type WorkersFileT } from '@talos-app/protocol'

/** Read this much of the end of a transcript first, then this much if no reply was in it (one tool result can be huge). */
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024] as const
export const DEFAULT_WINDOW = 200_000
export const LONG_WINDOW = 1_000_000
/** A session whose transcript is not where its folder name says (a long path is named differently) is looked for at most this often. */
const FIND_EVERY_MS = 60_000

/** Claude Code names a project folder after the working folder with every character that is not a letter or digit as `-`. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
export const transcriptPath = (claudeDir: string, cwd: string, sessionId: string): string =>
  join(claudeDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`)

export type ContextReading = { tokens: number; at: string | undefined }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

/** The reading in one transcript line, or undefined when the line is not a main-chain model reply with a usage. */
function readingOf(line: string): ContextReading | undefined {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObj(row) || row.type !== 'assistant' || row.isSidechain === true || row.isApiErrorMessage === true)
    return undefined
  const msg = row.message
  if (!isObj(msg) || msg.model === '<synthetic>' || !isObj(msg.usage)) return undefined
  const u = msg.usage
  const input = count(u.input_tokens)
  if (input === undefined) return undefined
  const tokens = Math.round(
    input + (count(u.cache_creation_input_tokens) ?? 0) + (count(u.cache_read_input_tokens) ?? 0),
  )
  const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
  return { tokens, at: Number.isFinite(ts) ? new Date(ts).toISOString() : undefined }
}

/** The last main-chain reply's context in the transcript at `path`; undefined when there is no file or no reply in its end. */
export function readLastContext(path: string): ContextReading | undefined {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const size = fstatSync(fd).size
    for (const want of TAIL_BYTES) {
      const len = Math.min(size, want)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      const lines = buf.toString('utf8').split('\n')
      if (size > len) lines.shift() // starts mid-line
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        const r = line ? readingOf(line) : undefined
        if (r) return r
      }
      if (size <= len) break
    }
    return undefined
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** The `model` string of the first settings file that sets one, in Claude Code's order (local, project, then user). */
export function configuredModel(claudeDir: string, cwd: string): string | undefined {
  for (const f of [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(claudeDir, 'settings.json'),
  ]) {
    try {
      const m = (JSON.parse(readFileSync(f, 'utf8')) as { model?: unknown }).model
      if (typeof m === 'string' && m) return m
    } catch {
      // missing or not JSON: Claude Code skips it too
    }
  }
  return undefined
}

/** The model a worker was launched with: its own when it has one, else whatever Claude Code reads from settings. */
export function launchModel(claudeDir: string, cwd: string, model: string | undefined): string | undefined {
  return model && model !== 'inherit' && model !== 'default' ? model : configuredModel(claudeDir, cwd)
}

export function windowFor(model: string | undefined, tokens: number): number {
  if (model && /\[1m\]/i.test(model)) return LONG_WINDOW
  return tokens > DEFAULT_WINDOW ? LONG_WINDOW : DEFAULT_WINDOW
}

// `projects/<any folder>/<session id>.jsonl`: the id is a UUID, so at most one folder holds it.
function findTranscript(claudeDir: string, sessionId: string): string | undefined {
  try {
    for (const d of readdirSync(join(claudeDir, 'projects'))) {
      const p = join(claudeDir, 'projects', d, `${sessionId}.jsonl`)
      if (statKey(p)) return p
    }
  } catch {
    // no projects folder yet
  }
  return undefined
}

type Cached = { key: string; reading: ContextReading | undefined }
type Found = { session: string; path: string | undefined; at: number }

export class WorkerContextFeed {
  private sent = new Map<string, string>()
  private cache = new Map<string, Cached>()
  private found = new Map<string, Found>()

  constructor(
    private readonly o: {
      /** Claude Code's config folder; undefined when it cannot be known (nothing is read). */
      claudeDir: () => string | undefined
      now?: () => number
    },
  ) {}

  /** Forget what was sent, so the next tick sends every state again (after `ready`). */
  reset(): void {
    this.sent.clear()
  }

  /** Sends the scoped state of each dedicated thread that has a session, once per change. */
  tick(file: WorkersFileT | null, dedicated: (thread: string) => boolean, send: (state: SessionStateT) => void): void {
    const claudeDir = this.o.claudeDir()
    if (!file || !claudeDir) return
    const live = new Set<string>()
    for (const [thread, e] of Object.entries(file.threads)) {
      if (!dedicated(thread) || !e.session_id) continue
      if (live.size >= MAX_THREAD_SESSION_STATES) break
      live.add(thread)
      const path = this.pathOf(thread, claudeDir, e.cwd, e.session_id)
      const reading = path ? this.read(thread, path) : undefined
      const state: SessionStateT = {
        session_id: e.session_id,
        scope: { thread_id: thread },
        source: 'hooks',
        capabilities: [],
        rate_limits: [], // the plan's limits are one pool: the app shows main's
        surfaces: [],
        at: reading?.at ?? e.started_at ?? e.last_turn_at ?? new Date(0).toISOString(),
      }
      if (reading) {
        const window = windowFor(launchModel(claudeDir, e.cwd, e.model), reading.tokens)
        state.context = {
          tokens: reading.tokens,
          window,
          percent: Math.min(100, Math.round((reading.tokens / window) * 1000) / 10),
        }
      }
      const key = JSON.stringify(state)
      if (this.sent.get(thread) === key) continue
      this.sent.set(thread, key)
      send(state)
    }
    // a thread that is gone (deleted, switched back to shared, no session) leaves nothing behind
    for (const m of [this.sent, this.cache, this.found]) for (const t of [...m.keys()]) if (!live.has(t)) m.delete(t)
  }

  /** The transcript's path: where the folder name says, else (lazily, on a miss) wherever that session id lives; the folder found is remembered. */
  private pathOf(thread: string, claudeDir: string, cwd: string, sessionId: string): string | undefined {
    const direct = transcriptPath(claudeDir, cwd, sessionId)
    if (statKey(direct)) return direct
    const now = (this.o.now ?? Date.now)()
    const hit = this.found.get(thread)
    if (hit && hit.session === sessionId) {
      if (hit.path && statKey(hit.path)) return hit.path
      if (now - hit.at < FIND_EVERY_MS) return undefined
    }
    const path = findTranscript(claudeDir, sessionId)
    this.found.set(thread, { session: sessionId, path, at: now })
    return path
  }

  private read(thread: string, path: string): ContextReading | undefined {
    const stat = statKey(path)
    const hit = this.cache.get(thread)
    if (hit && hit.key === `${path}:${stat}`) return hit.reading
    const reading = stat ? readLastContext(path) : undefined
    this.cache.set(thread, { key: `${path}:${stat}`, reading })
    return reading
  }
}

function statKey(path: string): string {
  try {
    const s = statSync(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return ''
  }
}

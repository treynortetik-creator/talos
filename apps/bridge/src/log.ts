// pino-style JSON lines to $TALOS_APP_HOME/bridge.log. Never stdout: stdout is the MCP pipe. Never message text,
// tokens, codes or cookies: callers pass ids, frame types and error codes only.
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from './fsutil.ts'

export const LOG_MAX_BYTES = 5 * 1024 * 1024
const CHECK_EVERY = 200

/** One generation is kept: bridge.log becomes bridge.log.1 (replacing the previous one) once it passes the cap. */
export function rotateLog(file: string, max = LOG_MAX_BYTES) {
  try {
    if (statSync(file).size <= max) return
    renameSync(file, `${file}.1`)
    appendFileSync(file, '', { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch {
    // no file yet, or another process rotated it first
  }
}

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const
export type LogLevel = keyof typeof LEVELS

/** What an `error` line hands to a tap: the call's own words and fields, plus a stack when the caller had one. */
export type ErrorTap = (msg: string, fields: Record<string, unknown> | undefined, detail: { stack?: string }) => void

export type Logger = {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  /** `detail.stack` goes to the tap only, never into bridge.log. */
  error(msg: string, fields?: Record<string, unknown>, detail?: { stack?: string }): void
  /** Security events (dropped frames, failed card checks) always log, whatever the level. */
  security(msg: string, fields?: Record<string, unknown>): void
  /** Problem reports: one function that sees every `error` line, set by the live bridge and cleared when it stops. */
  setErrorTap?(tap: ErrorTap | null): void
}

export function createLogger(home: string | null, level: string = 'info', sink?: (line: string) => void): Logger {
  const min = LEVELS[level as LogLevel] ?? LEVELS.info
  const file = home ? join(home, 'bridge.log') : null
  if (file && home) {
    ensureDir(home)
    rotateLog(file)
    if (!existsSync(file)) {
      appendFileSync(file, '', { mode: 0o600 })
      chmodSync(file, 0o600)
    }
  }
  let writes = 0
  const write = (lvl: LogLevel | 'security', msg: string, fields?: Record<string, unknown>) => {
    const num = lvl === 'security' ? LEVELS.warn : LEVELS[lvl]
    if (lvl !== 'security' && num < min) return
    const line = `${JSON.stringify({ level: lvl, time: Date.now(), msg, ...fields })}\n`
    try {
      if (sink) sink(line)
      else if (file) {
        if (++writes % CHECK_EVERY === 0) rotateLog(file)
        appendFileSync(file, line)
      }
    } catch {
      // logging must never take the bridge down
    }
  }
  let tap: ErrorTap | null = null
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f, d) => {
      write('error', m, f)
      try {
        tap?.(m, f, d ?? {})
      } catch {
        // a report that cannot be made must never break the line that asked for it
      }
    },
    security: (m, f) => write('security', m, { security: true, ...f }),
    setErrorTap: (t) => {
      tap = t
    },
  }
}

export const nullLogger: Logger = createLogger(null, 'error', () => {})

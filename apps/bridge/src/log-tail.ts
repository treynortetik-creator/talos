// Reading the bridge log for people: one line as readable text, and the last few lines of the file. `talos-app logs`,
// `talos-app report` and the bug reporter's read all start here, and all clean the result with the same `redact` (redact.ts).
import { readFileSync } from 'node:fs'

/** One bridge.log line (pino-style JSON) as a readable line; anything that is not JSON is passed through. */
export function formatLogLine(line: string): string {
  try {
    const { level, time, msg, ...rest } = JSON.parse(line) as Record<string, unknown>
    const when = typeof time === 'number' ? new Date(time).toISOString() : '?'
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''
    return `${when} ${String(level ?? '').padEnd(8)} ${String(msg ?? '')}${extra}`
  } catch {
    return line
  }
}

export function tailLines(file: string, n: number): string[] {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n').filter((l) => l !== '')
  return lines.slice(-n)
}

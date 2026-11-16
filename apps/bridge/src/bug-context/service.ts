// What the bug reporter asks the Mac for (`bug.context`, a signed owner read): the bridge and Claude Code versions, the
// errors the Mac has filed (names and scrubbed messages, never a stack), and the tail of bridge.log. All text goes through
// the same `redact` as `talos-app report` and `talos-app logs`, with the same two folders shown as `~` and `$TALOS_APP_HOME`.
// Nothing is stored and nothing is sent anywhere but back to the asking device.
import { existsSync } from 'node:fs'
import { BUG_REPORT_LIMITS, type FrameOf } from '@talos-app/protocol'
import { formatLogLine, tailLines } from '../log-tail.ts'
import { listProblems } from '../problems/store.ts'
import { redact } from '../redact.ts'
import type { BugContextBody, BugContextSeam } from '../v2-seams.ts'

/** The answer is cut to this many bytes as JSON, well under the relay's 256 KiB frame cap. */
export const CONTEXT_MAX_BYTES = 200 * 1024

export type BugContextDeps = {
  /** TALOS_APP_HOME. */
  home: string
  /** The owner's home folder (shown as `~`). */
  userHome: string
  logFile: string
  bridgeVersion: string
  /** Claude Code's version from the MCP handshake, when it has reported one. */
  claudeCodeVersion: () => string | undefined
}

export class BugContextService implements BugContextSeam {
  readonly available = true
  constructor(private d: BugContextDeps) {}

  read(f: Pick<FrameOf<'bug.context'>, 'lines'>): BugContextBody {
    const clean = (t: string) => redact(t, { userHome: this.d.userHome, appHome: this.d.home })
    const errors = listProblems(this.d.home, 'open')
      .flatMap((l) => (l.problem ? [l.problem] : []))
      .slice(0, BUG_REPORT_LIMITS.errors)
      .map((p) =>
        clean(`${p.source}: ${p.name}: ${p.message}${p.count > 1 ? ` (x${p.count})` : ''}`).slice(
          0,
          BUG_REPORT_LIMITS.errorChars,
        ),
      )
    let logs = ''
    if (existsSync(this.d.logFile)) {
      const lines = tailLines(this.d.logFile, Math.min(f.lines, BUG_REPORT_LIMITS.logLines)).map((l) =>
        clean(formatLogLine(l)),
      )
      logs = lines.join('\n')
      // Cut from the front (the newest lines matter most) at a line start when it would pass the frame's cap.
      if (logs.length > BUG_REPORT_LIMITS.logChars) {
        logs = logs.slice(logs.length - BUG_REPORT_LIMITS.logChars)
        logs = logs.slice(logs.indexOf('\n') + 1)
      }
    }
    const body = {
      bridge_version: this.d.bridgeVersion.slice(0, 40),
      claude_code: this.d.claudeCodeVersion()?.slice(0, 40) ?? null,
      recent_errors: errors,
      logs,
    }
    // Worst case stays under the relay's frame limit whatever the characters are: logs lose their oldest lines until it fits.
    while (Buffer.byteLength(JSON.stringify(body)) > CONTEXT_MAX_BYTES && body.logs.length > 0) {
      const cut = body.logs.indexOf('\n', Math.floor(body.logs.length / 4))
      body.logs = cut < 0 ? '' : body.logs.slice(cut + 1)
    }
    return body
  }
}

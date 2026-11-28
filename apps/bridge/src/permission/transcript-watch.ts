// Has this exact tool call a result in the session's transcript yet? (docs/CLAUDE-CODE.md C3.5, "the prompt is over")
//
// A permission hook that tied its prompt to exactly one PreToolUse record knows its call's tool_use id. The bridge then watches the
// transcript for a top-level `user` record whose message has a `tool_result` block with that id: a result is written only when the
// call has finished (answered Yes and run, answered No, or interrupted), so the prompt of that call cannot be open any more. Only an
// exact id counts. Nothing else does: another call's result, a copy of a message inside another kind of record (an `api-request-blob`),
// a queued channel message that mentions the id, an assistant record, or a path that is not the shape Claude Code gives a hook.
//
// Cost: one open and fstat per look, and only the bytes appended since the last one are read, at most CAP per look. Never the whole file:
// the first look (and the first after the file was cut shorter) starts at most LOOKBACK bytes from the end (the result can be written a
// moment before the first look), and a line is parsed only if it holds the id. The file is opened without following a link and without
// waiting (a pipe left in its place cannot hold the bridge), and judged by the OPEN file, never by a path looked at before.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const ID = /^[A-Za-z0-9_-]{1,100}$/
/** The end of an old file read at the first look. */
const LOOKBACK = 1024 * 1024
/** At most this much is read in one look (a big block is read over several looks). */
const CAP = 4 * 1024 * 1024
/** A line longer than this (a huge tool result) is dropped rather than held. */
const MAX_LINE = 8 * 1024 * 1024

/**
 * The transcript to watch for a hook's call, or undefined when what the hook said is not the shape Claude Code gives it:
 * `<anything>/projects/<folder>/<session id>.jsonl`, absolute, no dot segments, named by the hook's own session id. A subagent's
 * calls are in their own file beside it, `<session id>/subagents/agent-<agent id>.jsonl`. The hook names the path, so the bridge
 * reads nothing else, and a link is refused when it is read (ResultWatch).
 */
export function safeTranscriptPath(transcriptPath: unknown, sessionId: unknown, agentId: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || typeof sessionId !== 'string' || !ID.test(sessionId)) return undefined
  if (transcriptPath.includes('\0') || !isAbsolute(transcriptPath) || resolve(transcriptPath) !== transcriptPath)
    return undefined
  if (basename(transcriptPath) !== `${sessionId}.jsonl`) return undefined
  if (basename(dirname(dirname(transcriptPath))) !== 'projects') return undefined
  if (agentId === undefined) return transcriptPath
  if (typeof agentId !== 'string' || !ID.test(agentId)) return undefined
  return join(dirname(transcriptPath), sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

export class ResultWatch {
  private offset = -1
  private skipPartial = false
  private carry = Buffer.alloc(0)

  constructor(
    private readonly path: string,
    private readonly id: string,
  ) {}

  /** True once the transcript holds a top-level user record with a tool_result for this id. Never throws. */
  poll(): boolean {
    try {
      return this.look()
    } catch {
      return false
    }
  }

  private look(): boolean {
    let fd: number
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch {
      return false // not there yet (it may be written later), or a link
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) return false // a pipe or anything else is not read
      if (this.offset < 0 || st.size < this.offset) {
        // the first look, or the file was cut shorter: start near the end, and the first line there is a piece of one
        this.offset = Math.max(0, st.size - LOOKBACK)
        this.skipPartial = this.offset > 0
        this.carry = Buffer.alloc(0)
      }
      if (st.size <= this.offset) return false
      const want = Math.min(CAP, st.size - this.offset)
      const buf = Buffer.allocUnsafe(want)
      const n = readSync(fd, buf, 0, want, this.offset)
      if (n <= 0) return false
      this.offset += n
      return this.feed(buf.subarray(0, n))
    } finally {
      closeSync(fd)
    }
  }

  private feed(chunk: Buffer): boolean {
    let data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk
    this.carry = Buffer.alloc(0)
    if (this.skipPartial) {
      const nl = data.indexOf(10)
      if (nl < 0) return false
      data = data.subarray(nl + 1)
      this.skipPartial = false
    }
    let start = 0
    for (;;) {
      const nl = data.indexOf(10, start)
      if (nl < 0) break
      if (this.isMine(data.subarray(start, nl))) return true
      start = nl + 1
    }
    const rest = data.subarray(start)
    if (rest.length <= MAX_LINE) this.carry = Buffer.from(rest)
    return false
  }

  private isMine(line: Buffer): boolean {
    if (line.length < 20 || line.indexOf(this.id) < 0) return false // cheap: only a line that names the id is parsed
    let rec: unknown
    try {
      rec = JSON.parse(line.toString('utf8'))
    } catch {
      return false
    }
    if (typeof rec !== 'object' || rec === null || (rec as { type?: unknown }).type !== 'user') return false
    const content = (rec as { message?: { content?: unknown } }).message?.content
    return (
      Array.isArray(content) &&
      content.some(
        (b) =>
          typeof b === 'object' &&
          b !== null &&
          (b as { type?: unknown }).type === 'tool_result' &&
          (b as { tool_use_id?: unknown }).tool_use_id === this.id,
      )
    )
  }
}

// Captures (M5.2, M4.10): the result of a UI tool call or a claimed app request, kept on the Mac for a few minutes so
// `app_show` (or the live bridge's app.response) can use it. Dirs 0700, files 0600, TTL 15 min, 64 MiB cap.
import { closeSync, constants, fstatSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CaptureId, IsoTs, McpCallToolResult, type McpCallToolResultT, stripHostMetaDeep } from '@talos-app/protocol'
import { z } from 'zod'
import { ensureDir, writeJsonAtomic } from '../fsutil.ts'
import { openResolvedNoFollow } from '../safe-open.ts'
import type { AppPaths } from './paths.ts'

export const CAPTURE_TTL_MS = 15 * 60_000
export const CAPTURE_TOTAL_MAX = 64 * 1024 * 1024
export const CAPTURE_RESULT_MAX = 8 * 1024 * 1024
const OVERSIZE_FILE_MAX_AGE_MS = 120_000

export const Capture = z.object({
  capture_id: CaptureId,
  server: z.string().max(120),
  source: z.string().max(40),
  tool: z.string().max(128),
  tool_input: z.record(z.string(), z.unknown()),
  result: McpCallToolResult.optional(),
  ok: z.boolean(),
  too_large: z.boolean().optional(),
  at: IsoTs,
})
export type CaptureT = z.infer<typeof Capture>

const file = (p: AppPaths, id: string) => join(p.captures, `${id}.json`)

export function writeCapture(p: AppPaths, c: CaptureT): void {
  const parsed = Capture.parse(c)
  ensureDir(p.captures)
  writeJsonAtomic(file(p, parsed.capture_id), parsed, 0o600)
}

export function readCapture(p: AppPaths, id: string, nowMs: number): CaptureT | undefined {
  if (!CaptureId.safeParse(id).success) return undefined
  try {
    const f = file(p, id)
    const c = Capture.safeParse(JSON.parse(readFileSync(f, 'utf8')))
    if (!c.success) return undefined
    if (nowMs - Date.parse(c.data.at) > CAPTURE_TTL_MS) return undefined
    return c.data
  } catch {
    return undefined
  }
}

export function deleteCapture(p: AppPaths, id: string): void {
  if (!CaptureId.safeParse(id).success) return
  try {
    unlinkSync(file(p, id))
  } catch {
    // gone
  }
}

/** Expired captures go first, then the oldest until the total is under the cap. */
export function pruneCaptures(p: AppPaths, nowMs: number, keep: ReadonlySet<string> = new Set()): number {
  let names: string[]
  try {
    names = readdirSync(p.captures)
  } catch {
    return 0
  }
  const rows: Array<{ f: string; id: string; mtime: number; size: number }> = []
  let removed = 0
  for (const n of names) {
    const f = join(p.captures, n)
    try {
      const st = statSync(f)
      const id = n.replace(/\.json$/, '')
      if (nowMs - st.mtimeMs > CAPTURE_TTL_MS && !keep.has(id)) {
        unlinkSync(f)
        removed++
      } else rows.push({ f, id, mtime: st.mtimeMs, size: st.size })
    } catch {
      // raced with another pruner
    }
  }
  let total = rows.reduce((s, r) => s + r.size, 0)
  for (const r of rows.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= CAPTURE_TOTAL_MAX) break
    try {
      unlinkSync(r.f)
      total -= r.size
      removed++
    } catch {
      // gone
    }
  }
  return removed
}

// ---- normalising tool_response (M5.2) ---------------------------------------------------------------------------------

// anchored; the path capture stops before the sentence's trailing period
const OVERSIZE =
  /^Error: result \((\d+) characters\) exceeds maximum allowed tokens\. Output has been saved to (\/\S+?\.txt)\./

export type NormaliseCtx = {
  server: string
  tool: string
  transcript_path?: string | undefined
  session_id?: string | undefined
  nowMs: number
}

export type Normalised = { result: McpCallToolResultT } | { too_large: true }

/** How Claude Code is assumed to spell a name inside a file name: runs of anything but [A-Za-z0-9_-] become `_`. */
const spell = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_')

/**
 * The oversize file, only if it is this session's own `tool-results/` file for this server and tool. The string that
 * names it is server-controllable (a small result can carry the same text), so every check is required.
 */
function readOversizeFile(path: string, ctx: NormaliseCtx): string | undefined {
  if (!ctx.transcript_path || !ctx.session_id || !/^[A-Za-z0-9_-]{1,100}$/.test(ctx.session_id)) return undefined
  try {
    const expectedDir = realpathSync(join(dirname(ctx.transcript_path), ctx.session_id, 'tool-results'))
    const real = realpathSync(path)
    if (dirname(real) !== expectedDir) return undefined
    const name = basename(real)
    if (!name.startsWith('mcp-') || !name.endsWith('.txt')) return undefined
    const hasName = (n: string) => name.includes(n) || name.includes(spell(n))
    if (!hasName(ctx.server) || !hasName(ctx.tool)) return undefined
    // read through one handle opened with no link followed (the checks above were on a name), and judge the handle
    const fd = openResolvedNoFollow(real, constants.O_NONBLOCK)
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) return undefined
      if (ctx.nowMs - st.mtimeMs > OVERSIZE_FILE_MAX_AGE_MS || st.size > CAPTURE_RESULT_MAX) return undefined
      return readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function fromString(text: string): McpCallToolResultT | undefined {
  let structured: Record<string, unknown> | undefined
  try {
    const v: unknown = JSON.parse(text)
    if (isPlainObject(v)) structured = v
  } catch {
    // plain text
  }
  const out = { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) }
  const r = McpCallToolResult.safeParse(stripHostMetaDeep(out))
  return r.success ? r.data : undefined
}

export function normaliseToolResponse(resp: unknown, ctx: NormaliseCtx): Normalised {
  if (typeof resp === 'string') {
    const m = OVERSIZE.exec(resp)
    if (m) {
      const text = readOversizeFile(m[2] as string, ctx)
      if (text === undefined) return { too_large: true }
      const r = fromString(text)
      return r ? { result: r } : { too_large: true }
    }
    const r = fromString(resp)
    return r ? { result: r } : { too_large: true }
  }
  // defensive branches, never observed (a Claude Code version may change the shape)
  if (Array.isArray(resp)) {
    const r = McpCallToolResult.safeParse(stripHostMetaDeep({ content: resp }))
    return r.success ? { result: r.data } : { too_large: true }
  }
  if (isPlainObject(resp) && Array.isArray(resp.content)) {
    const r = McpCallToolResult.safeParse(stripHostMetaDeep(resp))
    return r.success ? { result: r.data } : { too_large: true }
  }
  return { too_large: true }
}

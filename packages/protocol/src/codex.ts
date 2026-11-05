// Optional Codex delegate (docs/CLAUDE-CODE.md C6.2). The bridge CLI `talos-app codex run` spawns `codex exec` with
// exactly this argv (no shell). It never passes -c, --enable, --add-dir, --approve-for-me or a --dangerously-* flag, and
// always --ignore-user-config, so the user's own Codex MCP servers and plugins (which run outside Codex's sandbox) stay
// out of the run. The agent only ever sees the summary, whose text is already inside a wrapExternal block.
import { z } from 'zod'
import { ThreadId } from './ids.ts'

export const CODEX_SANDBOXES = ['read-only', 'workspace-write'] as const
export type CodexSandbox = (typeof CODEX_SANDBOXES)[number]
/** Flags the wrapper never passes, whatever it is asked. */
export const CODEX_FORBIDDEN_FLAGS = [
  '-c',
  '--config',
  '--enable',
  '--add-dir',
  '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '-p',
  '--profile',
] as const
export const CODEX_TIMEOUT_MS = 20 * 60_000

export class CodexArgError extends Error {}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/
function absPath(p: string, what: string): string {
  if (typeof p !== 'string' || !p.startsWith('/') || CONTROL.test(p) || p.length > 1024)
    throw new CodexArgError(`${what} must be an absolute path`)
  return p
}

export type CodexExecOptions = {
  dir: string
  sandbox: CodexSandbox
  prompt: string
  lastMessagePath: string
  images?: string[]
}

/** `codex exec` argv (without the `codex` binary itself). The prompt goes after `--`, so it can never read as a flag. */
export function codexExecArgv(o: CodexExecOptions): string[] {
  const dir = absPath(o.dir, 'dir')
  const out = absPath(o.lastMessagePath, 'lastMessagePath')
  if (!(CODEX_SANDBOXES as readonly string[]).includes(o.sandbox)) throw new CodexArgError('sandbox not allowed')
  if (typeof o.prompt !== 'string' || o.prompt.trim() === '' || o.prompt.length > 32_000)
    throw new CodexArgError('prompt must be 1-32000 characters')
  const images = (o.images ?? []).flatMap((p) => ['-i', absPath(p, 'image')])
  return ['exec', '--json', '--ignore-user-config', '-C', dir, '-s', o.sandbox, '-o', out, ...images, '--', o.prompt]
}

/** What `talos-app codex run` prints for the agent. No path to Codex's raw text: only the wrapped summary. */
export const CodexRunSummary = z.strictObject({
  ok: z.boolean(),
  summary_wrapped: z.string().max(8000),
  files: z.array(z.string().max(1024)).max(10),
  usage: z.record(z.string(), z.number()),
  thread_id: ThreadId,
  codex_thread_id: z.string().max(80).optional(),
  error: z.string().max(500).optional(),
})
export type CodexRunSummaryT = z.infer<typeof CodexRunSummary>

/** Codex's words are never posted as the agent's own. */
export function codexReplyText(text: string): string {
  return `Codex: ${text}`
}

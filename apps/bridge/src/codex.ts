// `talos-app codex check|run` (docs/CLAUDE-CODE.md C6.2). Wraps `codex exec --json` and reports into a Talos thread
// through the same headless tools `talos-app post` uses. Codex's words are data: the agent only sees them wrapped.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import {
  CODEX_SANDBOXES,
  CODEX_TIMEOUT_MS,
  type CodexRunSummaryT,
  type CodexSandbox,
  codexExecArgv,
  codexReplyText,
  wrapExternal,
} from '@talos-app/protocol'

const MAX_FILES = 10
const MAX_FILE_BYTES = 50 * 1024 * 1024
const PROGRESS_EVERY_MS = 20_000
const MAX_PROGRESS_POSTS = 6
const REPLY_TEXT_LIMIT = 30_000
const PREVIEW_CHARS = 3000
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const SKIP_DIRS = new Set(['.git', 'node_modules'])

export type CodexCheck = { ok: true; version: string } | { ok: false; message: string }

type Out = { code: number; stdout: string } | undefined

async function capture(argv: string[], timeoutMs = 15_000): Promise<Out> {
  try {
    const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env })
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    const [stdout, , code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    return { code, stdout }
  } catch {
    return undefined // binary not found
  }
}

/** Optional feature: on only when `codex` is on PATH and logged in. The messages are what the agent relays. */
export async function checkCodex(): Promise<CodexCheck> {
  const v = await capture(['codex', '--version'])
  if (!v || v.code !== 0)
    return {
      ok: false,
      message: 'Codex is not installed (no `codex` on PATH). Install the Codex CLI, then run `codex login`.',
    }
  const l = await capture(['codex', 'login', 'status'])
  if (!l || l.code !== 0) return { ok: false, message: 'Codex is installed but not logged in. Run `codex login`.' }
  return { ok: true, version: v.stdout.trim() }
}

export type CodexEvent =
  | { kind: 'thread'; id: string }
  | { kind: 'progress'; label: string }
  | { kind: 'message'; text: string }
  | { kind: 'usage'; usage: Record<string, number> }
  | { kind: 'failed'; message: string }
  | { kind: 'ignore' }

const ITEM_LABEL: Record<string, string> = {
  reasoning: 'Codex is thinking',
  command_execution: 'Codex is running a command',
  file_change: 'Codex is editing files',
  mcp_tool_call: 'Codex is calling a tool',
  web_search: 'Codex is searching the web',
  plan_update: 'Codex is planning',
}

/** One JSONL line to one event. Unknown shapes are ignored: the format may grow. */
export function parseCodexLine(line: string): CodexEvent {
  let j: unknown
  try {
    j = JSON.parse(line)
  } catch {
    return { kind: 'ignore' }
  }
  if (!j || typeof j !== 'object') return { kind: 'ignore' }
  const e = j as Record<string, unknown>
  const item = (e.item ?? {}) as Record<string, unknown>
  switch (e.type) {
    case 'thread.started':
      return typeof e.thread_id === 'string' ? { kind: 'thread', id: e.thread_id } : { kind: 'ignore' }
    case 'item.started': {
      const label = typeof item.type === 'string' ? ITEM_LABEL[item.type] : undefined
      return label ? { kind: 'progress', label } : { kind: 'ignore' }
    }
    case 'item.completed':
      return item.type === 'agent_message' && typeof item.text === 'string'
        ? { kind: 'message', text: item.text }
        : { kind: 'ignore' }
    case 'turn.completed': {
      const u = (e.usage ?? {}) as Record<string, unknown>
      const usage: Record<string, number> = {}
      for (const [k, v] of Object.entries(u)) if (typeof v === 'number' && Number.isFinite(v)) usage[k] = v
      return { kind: 'usage', usage }
    }
    case 'turn.failed': {
      const m = (e.error as Record<string, unknown> | undefined)?.message
      return { kind: 'failed', message: typeof m === 'string' ? m : 'the turn failed' }
    }
    default:
      return { kind: 'ignore' }
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function walk(dir: string, depth: number, out: string[]) {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue
    const p = join(dir, n)
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      if (depth > 0) walk(p, depth - 1, out)
    } else if (st.isFile()) out.push(p)
  }
}

/**
 * Files this run produced: everything in Codex's generated-images folder for the run's thread, plus images changed and
 * other files created in the run directory since it started. Capped; the extras are only named.
 */
export function collectProduced(dir: string, startMs: number, codexThreadId: string | undefined) {
  const found: string[] = []
  if (codexThreadId && /^[\w-]{1,80}$/.test(codexThreadId))
    walk(join(codexHome(), 'generated_images', codexThreadId), 1, found)
  const inDir: string[] = []
  walk(dir, 3, inDir)
  for (const p of inDir) {
    const st = statSync(p)
    const isImage = IMAGE_EXT.has(extname(p).toLowerCase())
    if (isImage ? st.mtimeMs >= startMs : st.birthtimeMs >= startMs) found.push(p)
  }
  const ok = [...new Set(found)].filter((p) => statSync(p).size <= MAX_FILE_BYTES)
  ok.sort((a, b) => Number(IMAGE_EXT.has(extname(b).toLowerCase())) - Number(IMAGE_EXT.has(extname(a).toLowerCase())))
  return { files: ok.slice(0, MAX_FILES), extra: ok.slice(MAX_FILES) }
}

export type CodexRunDeps = {
  /** Posts into the thread (the bridge's reply tool) and returns its text and error flag. */
  call(tool: 'reply', args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  now(): number
  timeoutMs?: number
}

export type CodexRunArgs = { thread: string; dir?: string; sandbox: CodexSandbox; images: string[]; prompt: string }

function summarize(
  ok: boolean,
  text: string,
  files: string[],
  usage: Record<string, number>,
  o: CodexRunArgs,
  ct?: string,
  error?: string,
): CodexRunSummaryT {
  const body = text.length > 6000 ? `${text.slice(0, 6000)}\n[truncated]` : text
  return {
    ok,
    summary_wrapped: wrapExternal(body || '(Codex returned no message)', { source: 'Codex (codex exec)' }),
    files,
    usage,
    thread_id: o.thread as CodexRunSummaryT['thread_id'],
    ...(ct ? { codex_thread_id: ct.slice(0, 80) } : {}),
    ...(error ? { error: error.slice(0, 500) } : {}),
  }
}

function usageLine(u: Record<string, number>): string {
  if (u.input_tokens === undefined && u.output_tokens === undefined) return ''
  const cached = u.cached_input_tokens ? ` (${u.cached_input_tokens} cached)` : ''
  return `\n\n_Tokens: ${u.input_tokens ?? 0} in${cached}, ${u.output_tokens ?? 0} out. Codex reports tokens, not cost; it bills your own ChatGPT plan or API key._`
}

/** The bridge refuses protected files (`.env`, `.env.*`, `bridge.env`) in a reply; leave them out and say so. */
function splitRefused(paths: string[]) {
  const files: string[] = []
  const skipped: Array<{ path: string; why: string }> = []
  for (const p of paths) {
    const b = basename(p)
    if (b === '.env' || b.startsWith('.env.') || b === 'bridge.env')
      skipped.push({ path: p, why: 'protected file, never sent' })
    else files.push(p)
  }
  return { files, skipped }
}

async function inGitRepo(dir: string): Promise<boolean> {
  const r = await capture(['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'])
  return r?.code === 0
}

/** Runs `codex exec`, streams progress, posts the result. Throws Error with a plain message on setup problems. */
export async function runCodex(a: CodexRunArgs, deps: CodexRunDeps): Promise<CodexRunSummaryT> {
  if (!(CODEX_SANDBOXES as readonly string[]).includes(a.sandbox))
    throw new Error('--sandbox must be read-only or workspace-write')
  const c = await checkCodex()
  if (!c.ok) throw new Error(c.message)
  let dir = a.dir
  const scratch = mkdtempSync(join(tmpdir(), 'talos-codex-'))
  if (!dir) {
    // Codex refuses to run outside a git repo; a throwaway one keeps image and scratch work out of the owner's folders.
    dir = join(scratch, 'work')
    mkdirSync(dir)
    await capture(['git', '-C', dir, 'init', '-q'])
  } else if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`--dir ${dir} is not a directory`)
  else if (!(await inGitRepo(dir)))
    throw new Error(
      `Codex only runs inside a git repository and ${dir} is not in one. Run git init there, or leave --dir out for a scratch folder.`,
    )
  const last = join(scratch, 'last.md')
  const argv = [
    'codex',
    ...codexExecArgv({ dir, sandbox: a.sandbox, prompt: a.prompt, lastMessagePath: last, images: a.images }),
  ]
  const startMs = deps.now()
  let codexThread: string | undefined
  let message = ''
  let usage: Record<string, number> = {}
  let failure: string | undefined
  let lastProgress = Number.NEGATIVE_INFINITY
  let lastLabel = ''
  let progressPosts = 0
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', cwd: dir, env: process.env })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
    // a grandchild can keep the pipe open after the kill
    void reader.cancel().catch(() => {})
  }, deps.timeoutMs ?? CODEX_TIMEOUT_MS)
  const errText = new Response(proc.stderr as ReadableStream).text()
  // The CLI is a headless bridge, which drops set_status, so progress is a real silent message (no push).
  const progress = async (label: string, force = false) => {
    if (
      !force &&
      (label === lastLabel || deps.now() - lastProgress < PROGRESS_EVERY_MS || progressPosts >= MAX_PROGRESS_POSTS)
    )
      return
    lastProgress = deps.now()
    lastLabel = label
    progressPosts++
    await deps.call('reply', {
      thread_id: a.thread,
      text: codexReplyText(`${label.replace(/^Codex is /, '')}...`),
      silent: true,
    })
  }
  const handle = async (line: string) => {
    const ev = parseCodexLine(line)
    if (ev.kind === 'thread') codexThread = ev.id
    else if (ev.kind === 'message') message = ev.text
    else if (ev.kind === 'usage') usage = ev.usage
    else if (ev.kind === 'failed') failure = ev.message
    else if (ev.kind === 'progress') await progress(ev.label)
  }
  await progress('Codex is starting', true)
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const l = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (l) await handle(l)
      nl = buf.indexOf('\n')
    }
  }
  if (buf.trim()) await handle(buf.trim())
  const code = await proc.exited
  clearTimeout(timer)
  const stderr = timedOut ? '' : (await errText).trim()
  if (existsSync(last)) message = readFileSync(last, 'utf8').trim() || message

  const error = timedOut
    ? `Codex ran past ${Math.round((deps.timeoutMs ?? CODEX_TIMEOUT_MS) / 60_000)} minutes and was stopped.`
    : (failure ??
      (code !== 0 ? `codex exited with code ${code}${stderr ? `: ${stderr.split('\n').pop()}` : ''}` : undefined))
  const produced = collectProduced(dir, startMs, codexThread)
  const { files, skipped } = splitRefused(produced.files)
  const extra = produced.extra
  const ok = !error
  const notes: string[] = []
  if (extra.length) notes.push(`${extra.length} more file(s) not attached, in ${dir}.`)
  for (const sk of skipped) notes.push(`Not attached: ${basename(sk.path)} (${sk.why}).`)
  const noteText = notes.length ? `\n\n${notes.join('\n')}` : ''
  const full = ok ? message || '(no message)' : `failed. ${error}${message ? `\n\n${message}` : ''}`
  const attach = [...files]
  let body = full
  if (codexReplyText(full).length + noteText.length + 400 > REPLY_TEXT_LIMIT) {
    // reply refuses over 32k characters: keep the whole answer as a file and post a preview
    const answer = join(scratch, 'codex-answer.md')
    writeFileSync(answer, full)
    attach.unshift(answer)
    if (attach.length > MAX_FILES) attach.length = MAX_FILES
    body = `${full.slice(0, PREVIEW_CHARS)}\n\n[answer is ${full.length} characters; the whole text is attached as codex-answer.md]`
  }
  const text = `${codexReplyText(body)}${noteText}${ok ? usageLine(usage) : ''}`
  let posted = await deps.call('reply', { thread_id: a.thread, text, ...(attach.length ? { files: attach } : {}) })
  if (posted.isError && attach.length) {
    // whatever the bridge refuses (a protected path, a size cap) must not cost the owner the answer
    posted = await deps.call('reply', {
      thread_id: a.thread,
      text: `${text}\n\nAttachments were refused by the bridge (${posted.text.slice(0, 200)}), so none were sent.`,
    })
  }
  if (posted.isError) throw new Error(`could not post to the thread: ${posted.text}`)
  return summarize(ok, message || (error ?? ''), attach, usage, a, codexThread, error)
}

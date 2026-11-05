// Spawns an external command from an argv array. Never a shell: `{in}`, `{out}` and `{text}` are replaced inside single
// argv elements, so transcripts, file names or reply text can never become shell syntax.
export type ExecResult =
  | { ok: true; stdout: string; code: 0 }
  | { ok: false; reason: 'timeout' | 'exit' | 'spawn'; code?: number; stderr?: string }

const MAX_STDOUT = 1_000_000

export function fillArgv(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) => a.replace(/\{(in|out|text)\}/g, (m, k: string) => vars[k] ?? m))
}

export async function runArgv(argv: string[], timeoutMs: number): Promise<ExecResult> {
  const [cmd, ...args] = argv
  if (!cmd) return { ok: false, reason: 'spawn' }
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([cmd, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  } catch {
    return { ok: false, reason: 'spawn' }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve('timeout')
    }, timeoutMs)
  })
  const finished = Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ])
  try {
    // A killed shell script can leave a grandchild holding the pipes open, so a timeout must not wait for them to close.
    const r = await Promise.race([finished, timeout])
    if (r === 'timeout') {
      finished.catch(() => {})
      return { ok: false, reason: 'timeout' }
    }
    const [stdout, stderr, code] = r
    if (code !== 0) return { ok: false, reason: 'exit', code, stderr: stderr.slice(0, 500) }
    return { ok: true, stdout: stdout.slice(0, MAX_STDOUT), code: 0 }
  } finally {
    clearTimeout(timer)
  }
}

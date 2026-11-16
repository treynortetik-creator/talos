// The login environment a thread session starts with (P3d2; the Mac's WorkerLaunchEnv): the owner's login shell's `env -0`, read
// in the background so a start never waits on a slow shell profile (the blocking loginShellEnv() takes up to 5 s, and Main's start
// can afford it once, a queue of worker starts cannot). The last good read is kept; a failed read never replaces it, and none
// is cached as a fallback: with nothing read yet a start holds (the manager asks again), never a launch on a bare PATH.
/** Printed before `env -0`, so a profile that prints a greeting cannot glue it onto a variable. */
export const ENV_MARKER = '__TALOS_LOGIN_ENV__'

/** `env -0` output after the marker; null when the marker is missing. */
export function parseLoginEnv(out: string): Record<string, string> | null {
  const at = out.indexOf(`${ENV_MARKER}\0`)
  if (at < 0) return null
  const env: Record<string, string> = {}
  for (const entry of out.slice(at + ENV_MARKER.length + 1).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

/** A good read is refreshed this often: an owner who edits their profile gets it in later starts. */
export const LOGIN_ENV_REFRESH_S = 15 * 60
/** After a failed read, the next tries come this much later (the last repeats). */
export const LOGIN_ENV_RETRY_S = [30, 60, 120, 300] as const

export class LoginEnvCache {
  private env: Record<string, string> | null = null
  private readAt: number | null = null
  private failures = 0
  private nextTry = Number.NEGATIVE_INFINITY
  private inFlight = false

  /** `read` resolves to the login environment or null; `now` is a monotonic clock in seconds. */
  constructor(
    private readonly read: () => Promise<Record<string, string> | null>,
    private readonly now: () => number,
  ) {}

  /** The last good login environment, or null when none has been read yet (a start then holds). */
  current(): Record<string, string> | null {
    return this.env
  }

  /** Starts a read when one is due and none is running. Never waits for it. */
  refreshIfDue(): void {
    const t = this.now()
    if (this.inFlight) return
    if (this.env !== null && this.readAt !== null && t - this.readAt < LOGIN_ENV_REFRESH_S) return
    if (t < this.nextTry) return
    this.inFlight = true
    void this.read()
      .catch(() => null)
      .then((env) => {
        this.inFlight = false
        const at = this.now()
        if (env) {
          this.env = env
          this.readAt = at
          this.failures = 0
          this.nextTry = Number.NEGATIVE_INFINITY
        } else {
          const gap = LOGIN_ENV_RETRY_S[Math.min(this.failures, LOGIN_ENV_RETRY_S.length - 1)] as number
          this.failures++
          this.nextTry = at + gap
        }
      })
  }
}

/** loginShellEnv() without blocking: the same marker and `env -0`, given up on after `timeoutMs`. Null on any failure. */
export async function loginShellEnvAsync(
  shell: string,
  env: Record<string, string>,
  timeoutMs = 5_000,
  argvOverride?: string[],
): Promise<Record<string, string> | null> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([shell, ...(argvOverride ?? ['-l', '-i', '-c', `printf '%s\\0' ${ENV_MARKER}; env -0`])], {
      env,
      // a session of its own, with no controlling terminal: an interactive shell started from a background process group of a
      // terminal would take the terminal (SIGTTIN/SIGTTOU) and stop the whole group, the supervisor too, so the time limit below
      // could never fire (a supervisor started by hand from a terminal, 2026-11-11)
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
  } catch {
    return null
  }
  // raced, not awaited alone: a profile that leaves something running with our stdout would keep the read open for good
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => {
      proc.kill('SIGKILL')
      r(null)
    }, timeoutMs)
  })
  const read = (async () => {
    const out = await new Response(proc.stdout as ReadableStream).text()
    const code = await proc.exited
    return code === 0 ? parseLoginEnv(out) : null
  })().catch(() => null)
  try {
    return await Promise.race([read, late])
  } finally {
    clearTimeout(timer)
  }
}

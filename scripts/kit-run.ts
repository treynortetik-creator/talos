// Runs one kit shell script the way a new owner's machine would, and always cleans up after it.
// A script that hangs often has grandchildren (a `sleep &`, a fake server) that keep the output pipes open. Killing only bash then
// leaves them running and the pipes never close, so the runner would wait forever and report nothing. So the script runs in its own
// process group, a timeout kills the whole group, and the result is read from 'exit' with whatever output arrived by then.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type RunResult = { code: number | null; out: string; timedOut: boolean }

export type RunOptions = {
  cwd: string
  timeoutMs: number
  /** Builds the environment from the temp HOME and TMPDIR made for this one run. */
  env: (home: string, tmp: string) => Record<string, string>
  /** Where the per-run temp folder is made. Short on purpose: unix socket paths have a length limit. */
  tmpRoot?: string
}

export function runScript(script: string, opts: RunOptions): Promise<RunResult> {
  // Every path a script is handed (HOME, TMPDIR) goes through a symlink, as on macOS where /tmp and /var are links into /private:
  // a script that compares such a path with a resolved one (pwd -P, realpath) fails here the way it fails on a Mac.
  const real = mkdtempSync(join(opts.tmpRoot ?? '/tmp', 'kt-'))
  const base = `${real}-via-link`
  symlinkSync(real, base)
  const finish = () => {
    try {
      unlinkSync(base)
    } catch {
      // already gone
    }
    rmSync(real, { recursive: true, force: true })
  }
  return new Promise((resolve, reject) => {
    try {
      const home = join(base, 'home')
      const tmp = join(base, 't')
      mkdirSync(home)
      mkdirSync(tmp)
      const child = spawn('bash', [script], {
        cwd: opts.cwd,
        env: opts.env(home, tmp),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      const pid = child.pid
      let out = ''
      let timedOut = false
      const collect = (d: Buffer) => {
        out += d
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      const killGroup = () => {
        if (pid === undefined) return
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // the group is already gone
        }
      }
      const timer = setTimeout(() => {
        timedOut = true
        killGroup()
      }, opts.timeoutMs)
      child.on('error', (e) => {
        clearTimeout(timer)
        killGroup()
        finish()
        reject(e)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        // Anything the script left running in its group goes too, finished or not.
        killGroup()
        finish()
        if (timedOut)
          out += `\n[kit-run: killed after ${opts.timeoutMs} ms; the script and everything it started were stopped]\n`
        resolve({ code, out, timedOut })
      })
    } catch (e) {
      finish()
      reject(e)
    }
  })
}

/** Why a "skip ..." line a kit test prints is expected. A line that matches nothing here is reported as unlisted. */
export const KNOWN_SKIPS: { script: string; line: RegExp; reason: string }[] = [
  {
    script: 'test-jobs.sh',
    line: /^skip harden test\b/i,
    reason:
      "the harden check replays the kit's own git history (commit 1f01d8b) and kit/ is imported here without that history, so this one check cannot run",
  },
  {
    script: 'test-jobs.sh',
    line: /^skip real-Chronos checks\b/i,
    reason: 'opt-in: needs TALOS_TEST_CHRONOS=/path/to/chronos, a real Chronos checkout',
  },
  {
    script: 'test-recall.sh',
    line: /^skip real semantic checks\b/i,
    reason: 'opt-in: needs TALOS_TEST_SEMANTIC=1, which installs a model into a virtualenv',
  },
  {
    script: 'test-plugin.sh',
    line: /^skip claude plugin validate and the real-session checks\b/i,
    reason: 'the claude CLI is not installed here; these checks run the real Claude Code against the built plugin',
  },
  {
    script: 'test-plugin.sh',
    line: /^skip restore-last-good compatibility\b/i,
    reason:
      "needs the repo's bridge (apps/bridge), bun and node_modules; plugin-move's saved version is read by the bridge's own list command",
  },
  {
    script: 'test-install.sh',
    line: /^skip \[network\]/i,
    reason: 'opt-in: needs TALOS_TEST_NETWORK=1; the run is offline',
  },
  {
    script: 'test-install.sh',
    line: /^skip real-Chronos install\b/i,
    reason: 'opt-in: needs TALOS_TEST_CHRONOS=/path/to/chronos',
  },
  {
    script: 'test-install.sh',
    line: /^skip setup\.sh python3\.14 discovery\b/i,
    reason: 'only runs on a machine that has a Python 3.10+ to wrap',
  },
]

/** Splits a script's output into its skip lines, each with the reason it is expected, or undefined when nobody listed it. */
export function classifySkips(script: string, out: string): { line: string; reason: string | undefined }[] {
  const found: { line: string; reason: string | undefined }[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!/^skip\b/i.test(line)) continue
    found.push({ line, reason: KNOWN_SKIPS.find((k) => k.script === script && k.line.test(line))?.reason })
  }
  return found
}

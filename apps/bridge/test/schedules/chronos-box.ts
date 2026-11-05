// A real Chronos install in a temp HOME (third_party/chronos at v0.3.0), reachable through a wrapper script the bridge
// can use as TALOS_APP_CHRONOS_BIN. No bridge imports here: the vitest contract suites (Node) use it too.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChronosDraftT } from '@talos-app/protocol'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
export const CHRONOS_SRC = join(REPO, 'third_party', 'chronos')
export const TZ = 'America/New_York'

/** 2026-10-05 is a Monday; 11:00Z = 07:00 EDT. */
export const MON_0700_EDT = '2026-10-05T11:00:00Z'

let pythonBin: string | undefined
/**
 * The real interpreter behind `python3`, resolved once. On a box with pyenv, `python3` is a shim that runs a bash script
 * (dozens of lines of startup) before the real Python: 50+ ms on every one of the ~7 Chronos calls a bridge start makes.
 */
function realPython(): string {
  if (pythonBin) return pythonBin
  const r = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
  const p = r.status === 0 ? r.stdout.trim() : ''
  pythonBin = p && existsSync(p) ? p : 'python3'
  return pythonBin
}

export function draft(over: Partial<ChronosDraftT> = {}): ChronosDraftT {
  return {
    id: 'daily-digest',
    name: 'Daily Digest',
    description: 'Example job',
    when: { type: 'daily', time: '07:30' },
    catchup_min: 180,
    enabled: true,
    runner: 'session',
    permissions: 'full',
    allowed_tools: [],
    model: null,
    notify: 'failure',
    prompt: 'Summarise yesterday and post it.\n',
    ...over,
  }
}

/** A real Chronos install in a temp HOME, reachable through a wrapper script the bridge can use as TALOS_APP_CHRONOS_BIN. */
export class ChronosBox {
  readonly dir = mkdtempSync(join(tmpdir(), 'talos-chronos-box-'))
  readonly home = join(this.dir, 'home')
  readonly bin = join(this.dir, 'chronos')
  now: string
  /** The box's own config.json: the bridge reads Chronos's limits from here, never from the machine's real ~/.config. */
  get configFile() {
    return join(this.home, '.config', 'chronos', 'config.json')
  }

  /** `src` is a Chronos checkout; the vendored tag unless a test brings a newer one (times-real.test.ts). */
  constructor(now: string, tz = TZ, src = CHRONOS_SRC) {
    this.now = now
    mkdirSync(join(this.home, '.config', 'chronos'), { recursive: true })
    mkdirSync(join(this.home, 'chronos-workspace'), { recursive: true }) // where headless runs start
    // a headless run starts Chronos's fake claude (tests/fake-claude.sh), never the real one
    writeFileSync(
      join(this.home, '.config', 'chronos', 'config.json'),
      JSON.stringify({ claude_bin: join(src, 'tests', 'fake-claude.sh') }),
    )
    writeFileSync(
      this.bin,
      `#!/bin/sh\nexport HOME='${this.home}' TZ='${tz}' CHRONOS_TEST_MODE=1 PYTHONDONTWRITEBYTECODE=1 FAKE_LAUNCHCTL_DIR='${this.dir}/launchctl' CHRONOS_LAUNCHCTL='${join(src, 'tests', 'fake-launchctl.sh')}'\nunset CHRONOS_CONFIG\nexec '${realPython()}' '${join(src, 'bin', 'chronos')}' "$@"\n`,
    )
    chmodSync(this.bin, 0o755)
  }

  /** Runs `chronos <args>` (not `api`). */
  cli(args: string[], stdin?: unknown, now = this.now): { status: number; out: string } {
    const r = spawnSync(this.bin, args, {
      input: stdin === undefined ? '' : JSON.stringify(stdin),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CHRONOS_NOW: now },
    })
    return { status: r.status ?? -1, out: r.stdout }
  }
  api<T = Record<string, unknown>>(verb: string[], stdin?: unknown, now = this.now): T {
    const r = this.cli(['api', ...verb], stdin, now)
    return JSON.parse(r.out) as T
  }
  configure(c: { sessionRunner?: 'talos' | 'hook'; approvalRequired?: boolean }) {
    const args: string[] = []
    if (c.sessionRunner) args.push('session_runner', c.sessionRunner)
    if (c.approvalRequired !== undefined) args.push('approval_required', String(c.approvalRequired))
    if (args.length) this.api(['config', 'set', ...args])
  }
  create(d: ChronosDraftT, now = this.now): string | null {
    return this.change({ op: 'create', draft: d }, now)
  }
  /** validate + apply of any change, as the bridge does it. Returns the new etag. */
  change(change: Record<string, unknown>, now = this.now): string | null {
    const v = this.api<{ normalized?: unknown; expected_etag?: string | null; error?: unknown }>(
      ['validate'],
      change,
      now,
    )
    if (v.error) throw new Error(`validate: ${JSON.stringify(v.error)}`)
    const a = this.api<{ etag?: string | null; error?: unknown }>(
      ['apply'],
      { change: v.normalized, expected_etag: v.expected_etag },
      now,
    )
    if (a.error) throw new Error(`apply: ${JSON.stringify(a.error)}`)
    return a.etag ?? null
  }
  dispose() {
    rmSync(this.dir, { recursive: true, force: true })
  }
  /**
   * A job the way Chronos 0.2 (or a hand edit) leaves it: straight into jobs.json and prompt.md, no apply, no approved record.
   * `in_session` true with `headless` true or absent is the 0.2 meaning of "session first, background after a grace".
   */
  handWrite(job: { id: string; name: string; time: string; prompt: string; in_session?: boolean; headless?: boolean }) {
    const file = join(this.home, '.config', 'chronos', 'jobs.json')
    const list = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>) : []
    const { prompt, ...rec } = job
    list.push({
      description: '',
      days: 'daily',
      catchup_min: 180,
      enabled: true,
      in_session: false,
      notify: 'failure',
      once: null,
      created: '2026-09-01T09:00:00',
      updated: '2026-09-01T09:00:00',
      ...rec,
    })
    writeFileSync(file, JSON.stringify(list, null, 2))
    mkdirSync(this.jobDir(job.id), { recursive: true })
    writeFileSync(join(this.jobDir(job.id), 'prompt.md'), prompt)
  }
  jobDir(id: string) {
    return join(this.home, '.config', 'chronos', 'jobs', id)
  }
  /** A local process rewriting prompt.md: no apply, no approval. */
  editPromptOutside(id: string, text: string) {
    writeFileSync(join(this.jobDir(id), 'prompt.md'), text)
  }
  /** Chronos's home_dir (PAUSED, headless.blocked live here). */
  homeDir() {
    return join(this.home, '.chronos')
  }
  stateDir() {
    return join(this.home, '.chronos', 'state')
  }
  /** `chronos list`'s schedule column for a job (the ground truth for `when_text`). */
  listedWhenText(id: string, now = this.now): string {
    const line = this.cli(['list'], undefined, now)
      .out.split('\n')
      .find((l) => l.startsWith(id))
    if (!line) throw new Error(`chronos list has no ${id}`)
    return line.slice(25, 25 + 34).trim()
  }
}

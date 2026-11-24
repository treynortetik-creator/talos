// The shared pieces of the root-install-sched*.test.ts files: a Mac made out of stubs (uname says Darwin, plutil, a launchctl
// that remembers what is loaded, a bash that stubs the memory and voice setups) on top of root-install-harness.ts, so the real
// macOS branch of the installers runs on any computer and NEVER reaches a real launchd: every stub is first (and only) on PATH.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { REPO, run, type Sandbox, sandbox, snapshot, which } from './root-install-harness.ts'

export type SB = Sandbox
export const BUNDLED = join(REPO, 'apps', 'chronos')
export const KIT = join(REPO, 'kit')
export const put = (sb: SB, name: string, body: string) => {
  rmSync(join(sb.bin, name), { force: true })
  writeFileSync(join(sb.bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(sb.bin, name), 0o755)
}
export const lc = (sb: SB, ...p: string[]) => join(sb.root, 'lc', ...p)
export const flagOn = (sb: SB, name: string) => writeFileSync(lc(sb, name), '')
export const flagOff = (sb: SB, name: string) => rmSync(lc(sb, name), { force: true })
export const stateDir = (sb: SB) => join(sb.home, '.config', 'talos')
export const markerPath = (sb: SB) => join(stateDir(sb), 'chronos-not-added.json')
export const recordPath = (sb: SB) => join(stateDir(sb), 'chronos-dir')
export const cfgPath = (sb: SB) => join(sb.home, '.config', 'chronos', 'config.json')
export const plist = (sb: SB, label: string) =>
  join(sb.home, 'Library', 'LaunchAgents', `io.github.chronos.${label}.plist`)
export const loaded = (sb: SB) => (existsSync(lc(sb, 'loaded')) ? readdirSync(lc(sb, 'loaded')).sort() : [])
export const lcCalls = (sb: SB) => (existsSync(lc(sb, 'calls.log')) ? readFileSync(lc(sb, 'calls.log'), 'utf8') : '')

/** The Mac: uname, plutil, a stateful launchctl (flags in <root>/lc: fail-bootstrap-tick|ui|all, print-lies, kill-on-bootstrap), ps and a bash that stubs the setups. */
export function macSandbox(): SB {
  const sb = sandbox()
  mkdirSync(lc(sb, 'loaded'), { recursive: true })
  // uname (always a Mac) and plutil come from the shared sandbox. Its launchctl REFUSES and `run` fails any run that called it; this
  // file replaces it on purpose, with one that remembers what is loaded. Its calls go to <root>/lc/calls.log, never to the sandbox's
  // calls.log, so that check does not see them: it is still a stub first on PATH, and the real launchd is never reachable.
  const L = lc(sb)
  put(
    sb,
    'launchctl',
    `echo "$*" >> "${L}/calls.log"
label() { basename "$1" .plist; }
case "$1" in
  bootstrap)
    l="$(label "$3")"
    [ -f "${L}/kill-on-bootstrap" ] && {
      p=$PPID; list=""
      while [ "$p" -gt 1 ]; do
        case "$(ps -o command= -p "$p")" in */install.sh*) list="$p $list" ;; esac
        p="$(ps -o ppid= -p "$p" | tr -d ' ')"; [ -n "$p" ] || break
      done
      for x in $list; do kill -9 "$x"; done
      kill -9 $$
    }
    [ -f "${L}/fail-bootstrap-all" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    case "$l" in *tick) [ -f "${L}/fail-bootstrap-tick" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; } ;; esac
    case "$l" in *ui) [ -f "${L}/fail-bootstrap-ui" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; } ;; esac
    [ -f "$3" ] || { echo "no such plist" >&2; exit 5; }
    [ -f "${L}/loaded/$l" ] && { echo "already loaded" >&2; exit 37; }
    cp "$3" "${L}/loaded/$l"; exit 0 ;;
  bootout)
    l="$(basename "$2")"
    [ -f "${L}/loaded/$l" ] && { rm -f "${L}/loaded/$l"; exit 0; }
    exit 3 ;;
  print)
    l="$(basename "$2")"
    [ -f "${L}/print-lies" ] && exit 113
    [ -f "${L}/loaded/$l" ] && { echo "$l = { state = running }"; exit 0; }
    exit 113 ;;
esac
exit 0`,
  )
  for (const t of ['ps', 'rmdir']) {
    const real = which(t)
    if (!real) continue
    rmSync(join(sb.bin, t), { force: true }) // a shared sandbox may already have one: ours replaces it
    symlinkSync(real, join(sb.bin, t))
  }
  // the memory search and voice setups download models: stubbed (a call is recorded; the search's stub makes the index file)
  const bash = which('bash')
  put(
    sb,
    'bash',
    `case " $* " in
  *scripts/memory/setup.sh*|*scripts/memory/fetch-reranker.sh*|*scripts/voice/setup.sh*)
    echo "stub-setup $*" >> "${sb.root}/setups.log"
    # only a real run makes the index file: the kit's own dry run names the KIT as its agent folder, and a file there would be copied into every later agent
    case " $* " in *--dry-run*) ;; *memory/setup.sh*) d="$(echo "$*" | sed -n 's/.*--agent-dir \\([^ ]*\\).*/\\1/p')"; mkdir -p "$d/.index" && : > "$d/.index/memory.db" ;; esac
    exit 0 ;;
esac
exec "${bash}" "$@"`,
  )
  return sb
}

/** python3 that fails (exit 1, a message on stderr) for a call whose arguments match `match` (a case pattern). */
export function pyFails(sb: SB, match: string) {
  const real = which('python3')
  put(sb, 'python3', `case " $* " in ${match}) echo "injected failure" >&2; exit 1 ;; esac\nexec "${real}" "$@"`)
}
export function pyOk(sb: SB) {
  put(sb, 'python3', `exec "${which('python3')}" "$@"`)
}
/** cp that fails for a call whose arguments match. */
export function cpFails(sb: SB, match: string) {
  put(sb, 'cp', `case " $* " in ${match}) echo "cp: injected failure" >&2; exit 1 ;; esac\nexec "${which('cp')}" "$@"`)
}
export function cpOk(sb: SB) {
  put(sb, 'cp', `exec "${which('cp')}" "$@"`)
}

export const TEST_ENV = { CHRONOS_TEST_MODE: '1', CHRONOS_PRINT_TRIES: '1', TALOS_INSTALL_MEMSEARCH_DEFAULT: 'on' }
export const BASE = ['--no-app', '--yes']
export const install = (sb: SB, extra: string[] = [], env: Record<string, string> = {}) =>
  run(sb, ['--agent-dir', sb.agent, ...BASE, ...extra], { ...TEST_ENV, ...env }, { chronos: true })

/** The kit installer called directly (what an explicit ask or a script would do). */
export function kitRun(sb: SB, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(KIT, 'install.sh'), ...args], {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      PATH: sb.bin,
      HOME: sb.home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      PYTHONDONTWRITEBYTECODE: '1',
      TALOS_INSTALL_OS: 'Darwin',
      TALOS_FORCE_ARCH: 'arm64',
      ...TEST_ENV,
      ...env,
    },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

export const jobsOf = (sb: SB) =>
  JSON.parse(readFileSync(join(sb.home, '.config', 'chronos', 'jobs.json'), 'utf8')) as {
    id: string
    enabled?: boolean
  }[]
export const hookCount = (sb: SB) =>
  (readFileSync(join(sb.agent, '.claude', 'settings.json'), 'utf8').match(/chronos-session-start/g) ?? []).length
export const markerThere = (sb: SB) => {
  try {
    lstatSync(markerPath(sb))
    return true
  } catch {
    return false
  }
}
export const marker = (sb: SB) => JSON.parse(readFileSync(markerPath(sb), 'utf8')) as Record<string, unknown>
export const setupsRan = (sb: SB) =>
  existsSync(join(sb.root, 'setups.log')) ? readFileSync(join(sb.root, 'setups.log'), 'utf8') : ''

/** The agent is complete whatever happened to the scheduler: files, git with a first commit, the app's MCP server, verify-install. */
export function expectAgentComplete(sb: SB, out: string, setups = true) {
  for (const f of ['CLAUDE.md', '.claude/settings.json', '.talos-version', '.mcp.json'])
    expect(existsSync(join(sb.agent, f)), `${f}\n${out}`).toBe(true)
  expect(readFileSync(join(sb.agent, '.mcp.json'), 'utf8')).toContain('talos-app')
  const log = spawnSync('git', ['-C', sb.agent, 'log', '--oneline'], {
    encoding: 'utf8',
    env: { PATH: sb.bin, GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  expect(log.stdout.trim().length, `git log\n${out}`).toBeGreaterThan(0)
  const v = spawnSync('bash', [join(sb.agent, 'scripts', 'verify-install.sh')], {
    encoding: 'utf8',
    cwd: sb.agent,
    env: { PATH: sb.bin, HOME: sb.home, GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  expect(v.status, `verify-install\n${v.stdout}${v.stderr}`).toBe(0)
  // memory search and the voice setup were reached (stubbed: they download models)
  if (!setups) return
  expect(setupsRan(sb)).toContain('memory/setup.sh')
  expect(setupsRan(sb)).toContain('voice/setup.sh')
}

/** After a failed scheduler: nothing loaded, no plist left, and the marker (exactly its three keys) and the log are there. */
export function expectNotAdded(sb: SB, reason: string, out: string) {
  expect(loaded(sb), `loaded\n${out}`).toEqual([])
  expect(existsSync(plist(sb, 'tick')) || existsSync(plist(sb, 'ui')), `plists\n${out}`).toBe(false)
  const m = marker(sb)
  expect(Object.keys(m).sort()).toEqual(['at', 'reason', 'v'])
  expect(m.v).toBe(1)
  expect(m.reason).toBe(reason)
  expect(String(m.at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  expect(lstatSync(markerPath(sb)).mode & 0o777).toBe(0o600)
  expect(lstatSync(stateDir(sb)).mode & 0o777).toBe(0o700)
  const log = join(stateDir(sb), 'chronos-not-added.log')
  expect(lstatSync(log).mode & 0o777).toBe(0o600)
  expect(out).toMatch(/Your agent is complete, but the scheduler \(Chronos\) was not added/)
  expect(out).toMatch(/Chronos: +not added/)
  expect(out).not.toMatch(/Chronos: +installed/)
}

/** After the finishing run: loaded, no marker, one job each, one hook, the record is this clone's Chronos. */
export function expectFinished(sb: SB, out: string, memoryJob = true) {
  expect(loaded(sb), out).toEqual(['io.github.chronos.tick', 'io.github.chronos.ui'])
  expect(
    markerThere(sb),
    `marker still there
${out}`,
  ).toBe(false)
  const ids = jobsOf(sb).map((j) => j.id)
  expect(new Set(ids).size, 'a job twice').toBe(ids.length)
  const on = jobsOf(sb)
    .filter((j) => j.enabled)
    .map((j) => j.id)
    .sort()
  expect(
    on,
    `${out}
SETUPS:${setupsRan(sb)}
INDEX:${existsSync(join(sb.agent, '.index')) ? readdirSync(join(sb.agent, '.index', '.')).join(',') : 'none'}`,
  ).toEqual(
    memoryJob
      ? ['talos-memory-index', 'talos-weekly-snapshot', 'talos-weekly-wiki-lint']
      : ['talos-weekly-snapshot', 'talos-weekly-wiki-lint'],
  )
  expect(hookCount(sb)).toBe(1)
  expect(readFileSync(recordPath(sb), 'utf8').trim()).toBe(BUNDLED)
  expect(out).toMatch(/Chronos: +installed/)
}

export { REPO, run, sandbox, snapshot, which }

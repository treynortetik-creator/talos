// The PATH of a ci-local.sh that a test starts (repo() in scripts/ci-local-jobs.test.ts and scripts/ci-local-jobs-gates.test.ts): an
// allow-list, one private folder and nothing else. It holds the test's own fake tools, links to the short list of real tools below,
// and a refusing stub for every tool that would start a VM, a container, an app or the network. Any other name is "command not
// found" (127): a test that reaches for something unlisted goes red, and nothing real runs. (A deny-list was not enough: a run of
// these harnesses once reached the real colima through `docker_up`, which the machine had on its PATH.)
//
// The scripts also name a few tools by absolute path, which no PATH can stop: only scripts/ci-local/machine.sh's ci_tmux_ok
// (/opt/homebrew/bin/tmux, /usr/local/bin/tmux, /usr/bin/tmux; CI_TMUX_PATHS replaces the list, and harnessEnv points it at a file that
// is not there). Nothing else under scripts/ci-local* or apps/desktop/scripts/ci.sh names an absolute tool.
import { accessSync, constants, mkdirSync, statSync, symlinkSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fakeTool } from './fake-tool'

/** The real tools a harness run may use, each linked from where the test process finds it, and why the scripts need it. */
export const REAL_TOOLS: Record<string, string> = {
  bash: 'the scripts, and every `bash -c` and `bash <script>` they start',
  sh: 'fake tools written as /bin/sh, and `sh -c` in the tools the scripts call',
  env: '`env -u GH_TOKEN ...` before a commit’s own install and build, and shebangs',
  git: 'worktrees, merge-base, archive and the commit’s sha (it reads no configuration: see harnessEnv)',
  perl: 'the group time limit and setpgrp (heavy-lock.sh, hostile.sh)',
  cat: 'reading results and markers',
  cp: 'copying files into the run',
  mv: 'moving a log to prev/ and writing a result whole',
  rm: 'removing a run’s own folders and markers',
  rmdir: 'removing an empty lock folder',
  mkdir: 'making the run’s folders',
  ln: 'linking the lock and slot folders',
  ls: 'listing a folder',
  touch: 'marker files',
  chmod: 'making a script executable',
  mktemp: 'temp folders and files',
  find: 'sweeping the results folder',
  readlink: 'resolving a link',
  basename: 'a log’s name',
  dirname: 'the script’s own folder',
  stat: 'file times for the log and lock sweeps',
  id: 'the owner of a lock',
  awk: 'reading the statuses, the parts file and the timings',
  sed: 'trimming lines',
  grep: 'reading logs and markers',
  head: 'the first line of a file or a list',
  tail: 'the end of a failed job’s log',
  cut: 'columns of a line',
  tr: 'character sets and cases',
  sort: 'ordering a list',
  uniq: 'deduplicating a list',
  wc: 'counting lines',
  xargs: 'one call for each name of a list',
  tee: 'a line into the log and the output',
  diff: 'comparing two files',
  date: 'times, stamps and waits',
  sleep: 'waits between polls',
  nice: 'report-ci/fast runs its typecheck, lint and tests at nice 15 (jobs-check.sh, job_fast)',
  seq: 'counting loops',
  uname: 'which OS this is',
  sysctl: 'the cores, the memory and the wake time',
  getconf: 'the number of cores',
  nproc: 'the number of cores (Linux)',
  hostname: 'the machine’s name',
  uptime: 'the load average',
  ps: 'reading processes of the run',
  pgrep: 'finding a process of the run',
  lsof: 'who holds a port (read-only)',
  flock: 'the shared lock (Linux)',
  openssl: 'a random key for the image job (it only makes bytes)',
  cksum: 'a checksum of a name',
}

/** Tools that must never run for real from a test. Each is a stub that prints its name, writes a line to $REFUSED_MARKER, exits 97. */
export const REFUSED_TOOLS = [
  'colima',
  'docker',
  'limactl',
  'claude',
  'npm',
  'npx',
  'gh',
  'xcodebuild',
  'xcodegen',
  'swift',
  'xcrun',
  'open',
  'osascript',
  'launchctl',
  'defaults',
  'security',
] as const

/** Where the test process finds `name` (its own PATH, never the harness's), or null. */
function outer(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    try {
      if (!statSync(p).isFile()) continue
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Fills `bin` (made if need be): links to the REAL_TOOLS this machine has, then a refusing stub for each of REFUSED_TOOLS. A test's
 * own fake of the same name, written after, replaces either one.
 */
export function harnessBin(bin: string): void {
  mkdirSync(bin, { recursive: true })
  for (const name of Object.keys(REAL_TOOLS)) {
    const real = outer(name)
    if (real) symlinkSync(real, join(bin, name))
  }
  for (const name of REFUSED_TOOLS) {
    const script = [
      '#!/bin/bash',
      `echo "refused: ${name}: a test reached a real tool"`,
      `echo "${name} $*" >> "\${REFUSED_MARKER:-/dev/null}"`,
      'exit 97',
      '',
    ].join('\n')
    fakeTool(bin, name, script)
  }
}

/**
 * What the run's environment says about the machine: the private folder is the whole PATH, the home is the test's, git reads no
 * configuration, the refusing stubs write to `<T>/refused`, tmux is looked for where it is not, and no startup file runs (a
 * BASH_ENV, ENV or PERL5OPT of the test process would run code, or define a function over a tool, in every shell and perl).
 */
export function harnessEnv(T: string, bin: string, home: string): Record<string, string> {
  return {
    PATH: bin,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    REFUSED_MARKER: join(T, 'refused'),
    CI_TMUX_PATHS: join(T, 'no-tmux'),
    BASH_ENV: '',
    ENV: '',
    PERL5OPT: '',
  }
}

/** `env` without what the test process may have inherited from a running gate or hook: git's GIT_* pointers (a GIT_DIR would aim a commit at the real repository) and exported shell functions (BASH_FUNC_*). */
export function withoutInherited(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_') && !k.startsWith('BASH_FUNC_')) out[k] = v
  return out
}

/** The environment of the fixtures' own git calls (the one-commit repository and its clones): the real PATH for git, a home that is not the owner's, and no GIT_* or configuration. */
export function fixtureGitEnv(T: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: join(T, 'githome'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
}

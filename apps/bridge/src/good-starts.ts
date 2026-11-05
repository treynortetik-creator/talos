// The versions this Mac's bridge started cleanly from, for `talos-app rollback`. The live bridge adds one line to
// $TALOS_APP_HOME/good-starts.json the first time the relay says `ready` after it starts. Nothing here ever runs a
// rollback: it only writes this record.
import { realpathSync } from 'node:fs'
import { readJsonFile, writeJsonAtomic } from './fsutil.ts'
import { type Run, runCommand } from './run-command.ts'

export type GoodStart = { commit: string; repo: string; recorded_at: string }

/** Enough to step back past a version that started but misbehaves, few enough to stay a short file. */
export const GOOD_STARTS_KEEP = 10

const FULL_COMMIT = /^[0-9a-f]{40}$/
/** Printed to the terminal, so only a plain timestamp passes (no escape codes). */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Newest first. A missing, torn or unknown-version file reads as empty. A commit that is not 40 hex digits is dropped: the value goes to git. */
export function readGoodStarts(file: string): GoodStart[] {
  const raw = readJsonFile<{ v?: unknown; starts?: unknown }>(file)
  if (raw?.v !== 1 || !Array.isArray(raw.starts)) return []
  return raw.starts.filter(
    (s): s is GoodStart =>
      !!s &&
      typeof s === 'object' &&
      typeof (s as GoodStart).commit === 'string' &&
      FULL_COMMIT.test((s as GoodStart).commit) &&
      typeof (s as GoodStart).repo === 'string' &&
      typeof (s as GoodStart).recorded_at === 'string' &&
      TIMESTAMP.test((s as GoodStart).recorded_at),
  )
}

export type RecordResult = { ok: true } | { ok: false; why: string }

/**
 * Records HEAD as a version that started cleanly. `started` is the 7-character commit the running process was started
 * from (BRIDGE_COMMIT). Records nothing unless the checkout is still on that commit with no edited tracked files: only
 * then is the code that is running exactly that commit. Never throws.
 */
export function recordHealthyStart(o: {
  file: string
  repoDir: string
  started: string | undefined
  now?: () => string
  run?: Run
}): RecordResult {
  try {
    const run = o.run ?? ((cmd, cwd) => runCommand(cmd, cwd, 10_000))
    const git = (...a: string[]) => run(['git', ...a], o.repoDir)
    if (!o.started) return { ok: false, why: 'the running commit is unknown' }
    const top = git('rev-parse', '--show-toplevel')
    const head = git('rev-parse', 'HEAD')
    if (top.code !== 0 || head.code !== 0) return { ok: false, why: 'not a git checkout' }
    if (!FULL_COMMIT.test(head.out) || !head.out.startsWith(o.started))
      return { ok: false, why: 'the checkout moved since this process started' }
    const dirty = git('status', '--porcelain', '--untracked-files=no')
    if (dirty.code !== 0 || dirty.out)
      return { ok: false, why: 'tracked files are edited, so the code is not a commit' }
    const repo = realpathSync(top.out)
    const entry: GoodStart = { commit: head.out, repo, recorded_at: (o.now ?? (() => new Date().toISOString()))() }
    const rest = readGoodStarts(o.file).filter((s) => !(s.repo === repo && s.commit === entry.commit))
    writeJsonAtomic(o.file, { v: 1, starts: [entry, ...rest].slice(0, GOOD_STARTS_KEEP) })
    return { ok: true }
  } catch (e) {
    return { ok: false, why: (e as Error).message }
  }
}

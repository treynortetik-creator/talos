// The shell text of "wait for this file", for a stub a test writes (a fake that holds a lock until the test lets go, a job that
// waits for a signal file). A bare `while [ ! -f go ]; do sleep 0.05; done` waits for ever when its test fails, times out or is
// killed: its folder is deleted, nothing will ever make the file, and the process runs on with its parent gone (23 of them ran for
// days on one Mac). This loop ends when the file exists, and gives up (exit 1, so a hang is never a pass) when the file's folder is
// gone or when it has waited the cap. It runs in sh, bash 3.2 and bash 5: builtins only, a counter and no per-turn `date` fork.
import { timeFactor } from '../packages/testkit/src/time-factor.ts'

export interface WaitLoopOptions {
  /** The pause between looks, in seconds. Default 0.05. */
  step?: number
  /** The most it waits, in seconds on a machine at time factor 1 (TALOS_TEST_TIME_FACTOR scales it). Default 600. */
  cap?: number
  /** `f` a file (default), `e` anything at that path, `d` a folder. */
  test?: 'f' | 'e' | 'd'
  /**
   * The folder that must still be there (same quoting as the file). Default: the file's own folder. Give an older one when the
   * file's folder is made later by what the test starts, or the wait would give up before it exists.
   */
  folder?: string
  /** A shell command that must keep succeeding for the wait to go on (`kill -0 $PPID`: while the waiter lives). When it fails the loop ends quietly, as if the file were there. */
  keepWhile?: string
}

/**
 * The shell text of a loop that waits for `file`. `file` goes inside double quotes in the shell, so `$HOME/go` expands and a
 * literal path is used as it is; one with a double quote, a backtick or a backslash is refused. The text has no single quote, so it
 * can sit inside `sh -c '...'`, and is one line of statements: put a `;` or a newline after it.
 */
export function waitForFile(file: string, options: WaitLoopOptions = {}): string {
  const { step = 0.05, cap = 600, test = 'f', keepWhile, folder } = options
  if (/["`\\\n]/.test(file)) throw new Error(`waitForFile: not a plain path: ${JSON.stringify(file)}`)
  if (folder !== undefined && /["`\\\n]/.test(folder))
    throw new Error(`waitForFile: not a plain path: ${JSON.stringify(folder)}`)
  if (keepWhile?.includes("'")) throw new Error('waitForFile: keepWhile has a single quote')
  if (!(step > 0) || !(cap > 0)) throw new Error('waitForFile: step and cap must be positive')
  const turns = Math.max(1, Math.ceil((cap * timeFactor()) / step))
  // The folder is the path up to its last slash; a path with none has no folder to lose, so only the cap bounds it.
  const dir = folder === undefined ? '${__wl_f%/*}' : '$__wl_d'
  return (
    `__wl_f="${file}"; ${folder === undefined ? '' : `__wl_d="${folder}"; `}__wl_n=0; ` +
    `while [ ! -${test} "$__wl_f" ]; do ` +
    `if [ "${dir}" != "$__wl_f" ] && [ ! -d "${dir}" ]; then echo "gave up waiting for $__wl_f: its folder is gone" >&2; exit 1; fi; ` +
    (keepWhile ? `if ! { ${keepWhile}; }; then break; fi; ` : '') +
    `if [ $__wl_n -ge ${turns} ]; then echo "gave up waiting for $__wl_f after ${cap * timeFactor()} s" >&2; exit 1; fi; ` +
    `sleep ${step}; __wl_n=$((__wl_n + 1)); done`
  )
}

/**
 * The shell text of a loop that runs until it is killed (a stub that must still be there when the test signals it), with the same
 * ends as waitForFile: its `folder` going, or the cap. It waits for a file in `folder` that nothing makes.
 */
export function waitForever(folder: string, options: WaitLoopOptions = {}): string {
  return waitForFile(`${folder}/never-made`, options)
}

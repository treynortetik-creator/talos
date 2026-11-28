// What a test that spawns a REAL bridge must give it, so the bridge never reads or touches the owner's real home, inbox, Claude
// folder or Chronos. bun's own tests get the same from apps/bridge/test/preload.ts; a vitest harness that spawns `src/server.ts`
// has no preload, so it passes this env (bridge.contract, schedule-frames).
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The env that points everything under `root`, a throw-away folder the test owns and removes: HOME and XDG_CONFIG_HOME (so
 * `userHome` and `homedir()` are inside it), the inbox, the Claude config folder, no Chronos discovery, and TALOS_TEST_ROOT,
 * which makes the bridge refuse any Chronos that is not under `root` (apps/bridge/src/schedules/test-root.ts).
 */
export function isolatedBridgeEnv(root: string): Record<string, string> {
  const userHome = join(root, 'userhome')
  mkdirSync(join(userHome, '.config'), { recursive: true })
  return {
    HOME: userHome,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    TALOS_INBOX_ROOT: join(root, 'inbox', '.talos-inbox'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    TALOS_APP_CHRONOS_AUTODISCOVER: 'off',
    TALOS_TEST_ROOT: root,
    TALOS_TEST_CHANNEL: 'unknown',
    TALOS_EXPLAINER: 'off',
  }
}

/** Does this env run a child as the real user's own home (os.userInfo().homedir)? A test bridge must never. */
export function runsInRealHome(env: Record<string, string | undefined>): boolean {
  const home = env.HOME
  if (!home) return true
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  // by real path: a link to the real home, or the real home spelled another way, is still the real home
  return real(home) === real(userInfo().homedir)
}

/** Throws when a real bridge is about to start with the real home as its HOME. `what` names the harness. */
export function assertNotRealHome(env: Record<string, string | undefined>, what: string): void {
  if (runsInRealHome(env))
    throw new Error(
      `${what}: a test bridge would run with the real home as HOME (${userInfo().homedir}). Pass isolatedBridgeEnv(root) as its env.`,
    )
}

/**
 * Is this command line the real bridge (`src/server.ts`, or a bare `server.ts` run from the bridge folder) or the bridge's own CLI
 * (a path ending `apps/bridge/src/cli.ts`)? The CLI reads and writes the same home, inbox and Claude folder. A bare or relative
 * `cli.ts` is not matched: it could be any program's, and other `cli.ts` files live in the bridge's sub-folders.
 */
export function isBridgeSpawn(args: readonly string[]): boolean {
  return args.some(
    (a) => /(^|\/)src\/server\.ts$/.test(a) || /(^|\/)apps\/bridge\/src\/cli\.ts$/.test(a) || a === 'server.ts',
  )
}

/**
 * The env for any child a test starts, and what to call when it is stopped. For the real bridge it is ALWAYS isolated: the caller's
 * `extra` (its home, relay URL, a stub Chronos) is laid over `isolatedBridgeEnv`, and a HOME that is the owner's real home throws.
 * The root is a fresh throw-away folder unless the caller names its own in `extra.TALOS_TEST_ROOT` (one it owns and removes, such as
 * a Chronos box); an inherited TALOS_TEST_ROOT is never reused, and a Chronos program the caller passes is never what makes the
 * root: the bridge refuses it if it is not under the root. For any other command it is just `base` plus `extra`.
 * This is the one place a test's bridge env comes from: FakeClaude and every direct spawn go through it.
 */
export function bridgeChildEnv(
  args: readonly string[],
  extra: Record<string, string | undefined> = {},
  base: Record<string, string | undefined> = process.env,
  what = 'a test bridge',
): { env: Record<string, string>; cleanup: () => void } {
  const merge = (o: Record<string, string | undefined>) =>
    Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === 'string'))
  if (!isBridgeSpawn(args)) return { env: merge({ ...base, ...extra }), cleanup: () => {} }
  const named = extra.TALOS_TEST_ROOT
  const made = named ? undefined : mkdtempSync(join(tmpdir(), 'talos-test-bridge-'))
  const root = (named || made) as string
  const cleanup = () => made && rmSync(made, { recursive: true, force: true })
  const env = merge({ ...base, ...isolatedBridgeEnv(root), ...extra, TALOS_TEST_ROOT: root })
  try {
    assertNotRealHome(env, what)
  } catch (e) {
    cleanup() // nothing will start, so nobody would call cleanup: the folder goes before the throw
    throw e
  }
  return { env, cleanup }
}

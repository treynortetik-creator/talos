// Owner ruling 2026-11-14: three commands that used to be typed only by the owner in a terminal (`theme reset`, `memory init`,
// `lead init`) run from the agent too, when the owner asked for it and "Lock Talos settings" is off. Run from a terminal they are
// the owner's own and nothing here applies. The proof of asking is the bridge's own (trust.ts ownerAskedIn): his words in the
// thread, within two hours, with no outside text in that thread since. history.sqlite is read here, never written.
import { existsSync } from 'node:fs'
import { type BridgeEnv, paths } from './config.ts'
import { ConfigFile } from './config-file.ts'
import { type HistoryStore, openHistory } from './history-store.ts'
import { memoryJsonPath } from './memory/config.ts'
import { lastOwnerThread, ownerAskedIn, SETTINGS_LOCKED } from './trust.ts'

/**
 * True when the owner asked something in the last two hours, in the thread he spoke in most recently, with no outside text there
 * since (ownerAskedIn). For a start of Main from the agent while the owner's own Stop stands (supervisor/cli.ts). Reads
 * history.sqlite; false when it can't be read.
 */
export function ownerAskedRecently(env: BridgeEnv, now: number = Date.now()): boolean {
  const p = paths(env.home)
  const file = new ConfigFile(p.configJson, { log: { warn: () => {} } })
  let store: HistoryStore | undefined
  try {
    file.load()
    store = openHistory(p.historyDb)
    const ctx = { store, clock: { now: () => now }, config: file } as unknown as Parameters<typeof ownerAskedIn>[0]
    const t = lastOwnerThread(ctx)
    return t !== undefined && ownerAskedIn(ctx, t)
  } catch {
    return false
  } finally {
    store?.close()
  }
}

/** The commands an agent may run when the owner asked. */
export const ON_REQUEST_COMMANDS = ['theme reset', 'memory init', 'lead init'] as const

/** Which of them `argv` runs, or undefined. */
export function onRequestCommand(argv: readonly string[]): (typeof ON_REQUEST_COMMANDS)[number] | undefined {
  const name = `${argv[0] ?? ''} ${argv[1] ?? ''}`
  return (ON_REQUEST_COMMANDS as readonly string[]).includes(name)
    ? (name as (typeof ON_REQUEST_COMMANDS)[number])
    : undefined
}

/**
 * Why `argv` may not run now, or undefined when it may: the lock always; the owner's ask only without a terminal. `lead init <thread>` needs the owner's words in that thread or
 * in the default thread; the other two in any thread.
 */
export function onRequestRefusal(
  env: BridgeEnv,
  argv: readonly string[],
  now: number = Date.now(),
  opts: { terminal?: boolean } = {},
): string | undefined {
  const name = onRequestCommand(argv)
  if (!name) return undefined
  const p = paths(env.home)
  const file = new ConfigFile(p.configJson, { log: { warn: () => {} } })
  // Install time (owner ruling 2026-11-15): the installers (the Mac app's Create, Windows Setup) run `memory init --defaults`
  // with no terminal, before any conversation. With no history.sqlite there has been no Talos conversation for an ask to be
  // in, and with no memory.json there is no owner choice to override, so the defaults (memory/ and wiki/, to the owner's
  // own phone) go ahead. Only for the folder it runs in (no --agent-dir: the installer runs it from the new agent folder, so
  // a session cannot point it at another folder). The lock still holds, and a config that exists but cannot be read is
  // refused like below. Once either file exists, it is the normal rule below again.
  if (
    !opts.terminal &&
    name === 'memory init' &&
    argv.includes('--defaults') &&
    !argv.includes('--agent-dir') &&
    !existsSync(p.historyDb) &&
    !existsSync(memoryJsonPath(env.home))
  ) {
    if (!existsSync(p.configJson)) return undefined // no config yet: no lock to hold
    try {
      file.load()
    } catch (e) {
      return `talos-app: ${(e as Error).message}`
    }
    return file.config.settings_lock === true ? SETTINGS_LOCKED : undefined
  }
  try {
    file.load()
  } catch (e) {
    // no readable config.json: there is no lock to hold, so typed in a terminal the command goes on to its own handler (which
    // says what is missing); from the agent its ask can't be checked, so it is refused
    return opts.terminal ? undefined : `talos-app: ${(e as Error).message}`
  }
  // the lock holds with or without a terminal: a terminal can be faked (`script`), so it is not proof that the owner typed it
  if (file.config.settings_lock === true) return SETTINGS_LOCKED
  if (opts.terminal) return undefined // typed in a terminal: the owner's own, no ask to look for
  let store: HistoryStore | undefined
  try {
    store = openHistory(p.historyDb)
    const ctx = { store, clock: { now: () => now }, config: file } as unknown as Parameters<typeof ownerAskedIn>[0]
    const thread = name === 'lead init' ? argv[2] : undefined
    const asked =
      thread !== undefined
        ? ownerAskedIn(ctx, thread) || ownerAskedIn(ctx, file.config.default_thread)
        : (() => {
            const t = lastOwnerThread(ctx)
            return t !== undefined && ownerAskedIn(ctx, t)
          })()
    return asked
      ? undefined
      : `talos-app ${name} runs for the agent only when the owner asked for it${thread ? ` (in thread ${thread} or the default thread)` : ''}. Ask him, or he can type it in a terminal.`
  } catch (e) {
    return `talos-app ${name}: the message history can't be read (${(e as Error).message}), so the owner's ask can't be checked.`
  } finally {
    store?.close()
  }
}

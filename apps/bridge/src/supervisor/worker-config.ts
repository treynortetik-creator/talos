// What the thread-session manager reads from the config each tick (split out of cli.ts): the dedicated threads, the live cap,
// the start refused before it takes a slot, and whether Main runs in a mode no thread session can be held to.
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { AUTO_CONTINUE_AT_LIMIT_DEFAULT, dedicatedSettings, type MainLaunchConfig } from '@talos-app/protocol'
import { mainClaudeDir } from '../claude-dir.ts'
import { postSystemRow } from '../system-post.ts'
import { processEnv } from './launch-env.ts'
import { phoneThread, readAppConfig } from './notices.ts'
import { kitVendor, permissionHookProblem } from './worker-hook.ts'
import { enabledPluginKeys } from './worker-mcp.ts'
import { mainNarrowedMode, managedSettingsDir, workerFolderProblem } from './worker-policy.ts'
import {
  dedicatedMaxLive,
  dedicatedThreads,
  droppedEntriesNotice,
  droppedThreadEntries,
  MAIN_ENV_UNKNOWN,
  mainRead,
  mainSettingsRefusal,
} from './workers-wiring.ts'

/**
 * Every configured dedicated thread's folder, read now (no notice, no audit: the fence's reader), or null when config.json
 * cannot be read.
 */
export function threadFolders(home: string, agentDir: string): string[] | null {
  try {
    const threads = dedicatedThreads(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), agentDir)
    return threads ? threads.map((t) => t.cwd) : null
  } catch {
    return null
  }
}

/**
 * The developer thread fence (protocol dev.ts; owner ruling 2026-11-15), read again at every start: off ONLY when config.json
 * says `"dev": { "thread_fence": false }`. Anything else (absent, another value, a file that cannot be read) is on: the fence
 * never opens by accident.
 */
export function threadFenceOn(home: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      dev?: { thread_fence?: unknown }
    } | null
    return raw?.dev?.thread_fence !== false
  } catch {
    return true
  }
}

/**
 * The owner's "continue at the usage limit" switch (config.json `auto_continue_at_limit`), read again at every start: what a boolean
 * there says, else the config default (AUTO_CONTINUE_AT_LIMIT_DEFAULT) for an absent or junk value or a file that cannot be read.
 * The settings of each session then carry it, `true` or `false`, as Claude Code's own `autoContinueAtUsageLimit`.
 */
export function autoContinueAtLimitOn(home: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      auto_continue_at_limit?: unknown
    } | null
    const v = raw?.auto_continue_at_limit
    return typeof v === 'boolean' ? v : AUTO_CONTINUE_AT_LIMIT_DEFAULT
  } catch {
    return AUTO_CONTINUE_AT_LIMIT_DEFAULT
  }
}

/**
 * The fence's reader for each start: every configured thread's folder, read again each call. A config that cannot be read
 * for a moment never narrows the fence: the folders last read are kept. Null until one read succeeds (the start is refused).
 */
export function threadFolderReader(home: string): (agentDir: string) => string[] | null {
  let last: string[] | null = null
  return (agentDir) => {
    const now = threadFolders(home, agentDir)
    if (now) last = now
    return last
  }
}

/**
 * What the thread-session manager reads from the config each tick: the dedicated threads (entries that are not a thread are
 * left out, and the owner told once per set of them), the live cap, and the start refused before it takes a slot (Main's own
 * --settings cannot be read). The last good list and cap are kept when config.json cannot be read.
 */
export function workerConfigReaders(
  home: string,
  userHome: string,
  launchCfg: () => MainLaunchConfig | null,
  audit: (event: string, fields?: Record<string, string>) => void,
  /** The environment Main runs under: as it was started, else as a session's is built now. */
  mainEnv: () => Record<string, string>,
) {
  let droppedSaid = '' // the config.threads entries last said to be ignored
  const fencedFolders = threadFolderReader(home)
  const readConfig = (): unknown => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  return {
    // the owner's continue-at-limit switch, for the usage-limit line (each start reads it again for the session's settings)
    autoContinue: () => autoContinueAtLimitOn(home),
    threads: () => {
      const c = launchCfg()
      if (!c) return null
      // switched off: no thread is dedicated here (a live session parks after its turn, as for one no longer dedicated)
      if (c.workers === false) return []
      try {
        const raw = readConfig()
        const tell = droppedEntriesNotice(raw, droppedSaid)
        if (tell) {
          audit('config_threads_entries_ignored', { entries: tell.said })
          void postSystemRow({ ...processEnv(), TALOS_APP_HOME: home }, tell.thread, tell.text).catch(() => {})
        }
        if (droppedThreadEntries(raw).length === 0 || tell) droppedSaid = tell ? tell.said : ''
        const list = dedicatedThreads(raw, c.agentDir)
        // the plugins switched on in the config folder Main runs under: part of each session's launch (a change restarts it after its turn)
        const plugins = enabledPluginKeys(mainClaudeDir(mainEnv(), userHome))
        // null: the plugin files are there but cannot be read (a half-written file): the set is not known, so it is no change
        return list && plugins ? list.map((t) => ({ ...t, plugins })) : list
      } catch {
        return null // the last good list is kept
      }
    },
    maxLive: () => {
      try {
        return dedicatedMaxLive(readConfig())
      } catch {
        return null // the last good cap is kept
      }
    },
    // restart-on-update (update-restart.ts): the switch, and the owner's thread for its one line
    restartOnUpdate: () => {
      try {
        return dedicatedSettings(readConfig() as { dedicated?: unknown }).restart_on_update
      } catch {
        return null // config.json cannot be read: nothing this round
      }
    },
    defaultThread: () => {
      try {
        return phoneThread(readAppConfig(readConfig()))
      } catch {
        return null
      }
    },
    // a running sub-thread's parent moved into a folder no session may use: as a start would refuse (a parent that cannot be
    // resolved for a moment is no verdict: never a reason to stop a session that runs)
    parentFolderProblem: (parent: string) => {
      const c = launchCfg()
      // for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
      const real = (p: string) => {
        try {
          return realpathSync(p)
        } catch {
          return null
        }
      }
      const r = real(parent)
      if (!c || r === null || r === real(c.agentDir)) return null
      return workerFolderProblem(parent, userHome, home)
    },
    mainNarrowed: () => {
      const c = launchCfg()
      if (!c) return null
      const env = mainEnv()
      if (env === MAIN_ENV_UNKNOWN) return "an environment this supervisor can't read"
      return mainNarrowedMode(c.args, env)
    },
    preflight: (id: string, baseEnv: Record<string, string>) => {
      const c = launchCfg()
      if (!c) return null
      // a hook that cannot run refuses every start: found before a slot is taken, so no session is parked for it; the same
      // fences as the start (the agent folder and every thread's)
      const others = fencedFolders(c.agentDir)
      const hookWhy =
        others === null
          ? "the thread folders can't be read from config.json yet, so the hook can't be fenced"
          : permissionHookProblem(kitVendor(process.env), baseEnv, [c.agentDir, ...others])
      if (hookWhy) {
        audit('worker_hook_missing', { thread: id, why: hookWhy })
        return { code: 'start_failed' as const, detail: hookWhy, hookMissing: hookWhy }
      }
      const inputs = {
        talosHome: home,
        userHome,
        agentDir: c.agentDir,
        claudeDir: '',
        resolveClaude: () => null,
        mainArgs: () => c.args,
        managedDir: managedSettingsDir(),
        audit,
        threadFolders: () => others,
      }
      return mainSettingsRefusal(inputs, id, mainRead(inputs, mainEnv()))
    },
  }
}

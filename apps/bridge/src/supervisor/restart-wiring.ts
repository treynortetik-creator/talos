// The supervisor's wiring for Main's restart on request (main-request.ts RestartActor, main-restart-check.ts): what it reads
// for the reasons, Main's start and stop, the owner's devices, the known threads, and the one line to the default thread.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JwkP256T, MainLaunchConfig, PtyHost } from '@talos-app/protocol'
import { postSystemRow } from '../system-post.ts'
import { launchIsApproved } from './launch-approval.ts'
import type { MainSupervisor } from './main.ts'
import { RestartActor } from './main-request.ts'
import type { MainStateExtras } from './main-state.ts'
import { phoneThread, readAppConfig } from './notices.ts'

const DEV_FLAG = '--dangerously-load-development-channels'

/** The channels a launch's args pass after the development-channels flag (up to the next option). */
export function launchChannels(args: readonly string[]): string[] {
  const i = args.indexOf(DEV_FLAG)
  if (i < 0) return []
  const out: string[] = []
  for (let k = i + 1; k < args.length && !(args[k] as string).startsWith('-'); k++) out.push(args[k] as string)
  return out
}

/** Thread ids this computer knows: config.json's `threads[].id` and workers.json's `threads` keys; unreadable files give none. */
export function knownThreadIds(home: string): Set<string> {
  const ids = new Set<string>()
  try {
    const c = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { threads?: Array<{ id?: unknown }> }
    for (const t of c.threads ?? []) if (typeof t?.id === 'string') ids.add(t.id)
  } catch {
    // none from it
  }
  try {
    const w = JSON.parse(readFileSync(join(home, 'workers.json'), 'utf8')) as { threads?: Record<string, unknown> }
    for (const id of Object.keys(w.threads ?? {})) ids.add(id)
  } catch {
    // none from it
  }
  return ids
}

export function restartActorWiring(o: {
  home: string
  userHome: string
  audit: (e: string, f?: Record<string, string>) => void
  main: MainSupervisor
  host: Pick<PtyHost, 'clientActivities'>
  stoppedFlag: string
  configPath: string
  readConfig: (home: string, userHome: string) => MainLaunchConfig | { error: string }
  resolveClaude: (claudePath: string, env: Record<string, string>) => string | null
  env: () => Record<string, string>
  extras: () => MainStateExtras | undefined
  pinnedKey: (deviceId: string) => JwkP256T | undefined
}): RestartActor {
  const readCfg = () => o.readConfig(o.home, o.userHome)
  return new RestartActor({
    home: o.home,
    audit: o.audit,
    now: () => performance.now() / 1000,
    wallMs: () => Date.now(),
    launchedAtMs: Math.trunc(Date.now()),
    status: () => o.main.status(),
    extras: o.extras,
    inputs: async () => {
      const c = readCfg()
      const clients = await o.host.clientActivities()
      const attached = clients === null ? null : clients.length > 0
      const sessionId = o.main.status().sessionId
      if ('error' in c)
        return {
          configOk: false,
          agentDirExists: false,
          devChannels: false,
          approved: false,
          launchChannels: [],
          claudeFound: false,
          autoConfirmRestart: false,
          attached,
          sessionId,
        }
      return {
        configOk: true,
        agentDirExists: existsSync(c.agentDir),
        devChannels: c.args.includes(DEV_FLAG),
        approved: launchIsApproved(o.configPath, readCfg, c).ok,
        launchChannels: launchChannels(c.args),
        claudeFound: o.resolveClaude(c.claudePath, o.env()) !== null,
        autoConfirmRestart: c.autoConfirmRestart,
        attached,
        sessionId,
      }
    },
    ownerStopped: () => existsSync(o.stoppedFlag),
    stop: () => o.main.stop({ quiet: true }),
    start: () => o.main.start(),
    pinnedKey: o.pinnedKey,
    knownThread: (id) => knownThreadIds(o.home).has(id),
    post: async (text) => {
      let app = readAppConfig(undefined)
      try {
        app = readAppConfig(JSON.parse(readFileSync(join(o.home, 'config.json'), 'utf8')))
      } catch {
        // no config.json yet: the defaults
      }
      // a system row, signed with the bridge key in this process: never through a command an agent could run too
      await postSystemRow({ ...o.env(), TALOS_APP_HOME: o.home }, phoneThread(app), text)
    },
  })
}

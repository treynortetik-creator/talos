// The one planner a thread session's start is made by, for the supervisor and for the update check's report alike (as the Mac's
// SupervisorController.workerOptions is): the same inputs give the same plan, so the report says what the supervisor would do.
import type { MainLaunchConfig } from '@talos-app/protocol'
import { threadFenceOn } from './worker-config.ts'
import { claudeJsonHome } from './worker-mcp.ts'
import { managedSettingsDir } from './worker-policy.ts'
import type { WorkerDeps } from './worker-types.ts'
import { workerPlanner } from './workers-wiring.ts'

export type SupervisorPlanDeps = {
  home: string
  userHome: string
  /** supervisor.json as read now; null when it cannot be read (every start is then refused). */
  launchCfg: () => MainLaunchConfig | null
  /** Every configured thread's folder (the hook's fences), for the agent folder given. */
  fencedFolders: (agentDir: string) => string[] | null
  /** Main's environment as it was started (null: none running, the planner reads its own). */
  mainEnv: () => Record<string, string> | null
  /** cli.ts's own readers, passed in (this module never imports cli.ts at run time). */
  claudeDirOf: (env: Record<string, string>, userHome: string) => string
  resolveOnPath: (program: string, env: Record<string, string>) => string | null
  audit: (event: string, fields?: Record<string, string>) => void
}

/** WorkerDeps.plan for this supervisor's settings. */
export function supervisorPlan(d: SupervisorPlanDeps): WorkerDeps['plan'] {
  return (p) => {
    const c = d.launchCfg()
    if (!c) return { refused: { code: 'start_failed', detail: 'the supervisor settings cannot be read' } }
    const claudeDir = d.claudeDirOf(p.baseEnv, d.userHome)
    return workerPlanner({
      talosHome: d.home,
      userHome: d.userHome,
      agentDir: c.agentDir,
      // the hook's fences: every configured thread's folder, read again at each start
      threadFolders: () => d.fencedFolders(c.agentDir),
      // the developer thread fence, read again at each start (off only when config.json says so)
      threadFence: () => threadFenceOn(d.home),
      launchEnv: () => d.launchCfg()?.env,
      claudeDir,
      // where Claude Code reads .claude.json: CLAUDE_CONFIG_DIR when set (even to ~/.claude itself), else the home folder
      configHome: claudeJsonHome(p.baseEnv, d.userHome, claudeDir),
      claudeDirOf: (env) => d.claudeDirOf(env, d.userHome),
      resolveClaude: (env) => d.resolveOnPath(c.claudePath, env),
      mainArgs: () => c.args,
      mainEnv: d.mainEnv,
      managedDir: managedSettingsDir(),
      audit: d.audit,
    })(p)
  }
}

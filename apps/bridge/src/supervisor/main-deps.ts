// What MainSupervisor (main.ts) is given: the host, the clock, the settings and every outside effect, so tests can stand in for each.
import type { MainLaunchConfig, MainStatus, PtyHost } from '@talos-app/protocol'
import type { MainStateExtras } from './main-state.ts'
import type { MainEvent } from './notices.ts'
import type { ProcIdentity } from './proc.ts'
import type { AgentEntry, Blocker } from './takeover.ts'

export type MainDeps = {
  processEnv?: (pid: number) => Record<string, string> | null // an adopted Main's real one (launch-env.ts adoptedMainEnv)
  host: PtyHost
  identity: ProcIdentity
  session: string
  /** Read at every start: the owner's settings (supervisor.json), or why they could not be read. */
  config: () => MainLaunchConfig | { error: string }
  /** Writes a new session id into the settings (a cold start without one owns it). */
  saveSessionId: (id: string) => void
  /** The owner's login environment, read again at every start (`$SHELL -l -i`); buildMainEnv makes Main's from it. */
  loginEnv: () => Record<string, string>
  /** `claude` (or the configured path) on that PATH, or null. */
  resolveClaude: (claudePath: string, env: Record<string, string>) => string | null
  isDir: (path: string) => boolean
  newSessionId: () => string
  /** Monotonic seconds. */
  now: () => number
  /** Wall-clock ms: the restart times shown to the owner, and the pane's last output (tmux reports it that way). */
  wallMs: () => number
  /** In [-1, 1]. */
  random: () => number
  /** The status, and what the one-line state file adds to it (main-state.ts): sign-in trouble and first-start waits. */
  publish: (status: MainStatus, extras?: MainStateExtras) => void
  audit: (event: string, fields?: Record<string, string>) => void
  /** Tells the owner (a desktop notice, a phone line for a stop): notices.ts decides how. Never throws back into the queue. */
  tell?: (e: MainEvent) => void
  /** Who else holds Telegram, the bridge or the Talos channel (takeover.ts), given our own process groups; none = []. */
  takeover?: (ourPgids: Set<number>, mainEnv: Record<string, string>) => Promise<Blocker[]>
  /** `claude agents --json` with Main's environment; null when it could not be read. */
  listAgents?: (mainEnv: Record<string, string>) => Promise<AgentEntry[] | null>
  /**
   * Whether Claude Code has saved a transcript for this session in this folder. It saves one only after the first message:
   * a session nobody has typed in yet cannot be resumed, and is started again with the same id instead.
   */
  sessionSaved: (agentDir: string, sessionId: string, mainEnv: Record<string, string>) => boolean
  /** Records that this session id had a turn (its transcript was seen): from then on a missing transcript is never "new". */
  markConversationSeen?: (sessionId: string) => void
  /** The session's transcript exists but holds no conversation (no user or assistant line): it can never be resumed. */
  conversationEmpty: (agentDir: string, sessionId: string, mainEnv: Record<string, string>) => boolean
  /** The live bridge's status.json (mode, pid, updated_at) in the Talos home Main's bridge uses, or undefined. */
  readBridgeStatus: (talosHome: string | undefined) =>
    | {
        mode: string
        pid: number
        updated_at: string
        relay?: { connected: boolean }
        /** The oldest owner message this bridge run told the agent about that it has not touched yet (SeenTracker), or null. */
        unseen_oldest_at?: string | null
      }
    | undefined
  /** Why the talos-app MCP server did not start, from Claude Code's MCP log for this folder (with Main's environment, whose
   * XDG_CACHE_HOME is the one Claude Code uses); null when none can be read. */
  mcpLogReason: (agentDir: string, mainEnv: Record<string, string>) => string | null
  /**
   * Linux: Main's first start with nobody at the pane (first-start.ts). `approved`: root approved this launch as supervisor.json
   * says it (launch-approval.ts), read at the start; `talosFolder`: the folder holds `.talos-version`. Absent: nothing answered.
   */
  firstStart?: { approved: (cfg: MainLaunchConfig) => boolean; talosFolder: (agentDir: string) => boolean }
  /** The security notes Claude Code showed at a first start, once, before the supervisor's Enter (first-start.ts). */
  notesShown?: (text: string[]) => boolean
}

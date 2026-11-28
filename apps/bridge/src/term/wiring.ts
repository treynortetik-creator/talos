// Builds the terminal view's service for a live main bridge (bridge.ts): the tmux control client on the supervisor's own socket
// and config, the audit in the history store, and which tmux session a target names. Without tmux there is no service: the Mac
// does not list term-view/1 and an open is answered `unsupported`.
import { MAIN_TMUX_SESSION, ThreadId, TMUX_SOCKET } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { resolveOnPath, SUPERVISOR_FILES, testSocket } from '../supervisor/cli.ts'
import { processEnv } from '../supervisor/launch-env.ts'
import { isValidSessionName } from '../supervisor/tmux-commands.ts'
import { TermAudit } from './audit.ts'
import { type OpenSource, tmuxSourceOpener } from './control.ts'
import { TermService } from './service.ts'

export type TermWiringOptions = {
  /** Test seam: where a view's pane comes from (a real tmux in production). */
  openSource?: OpenSource
  /** Test seam: no terminal service at all, as on a Mac without tmux. */
  off?: boolean
  idleS?: number
  maxS?: number
}

/** The tmux session of a target: `main` is the agent's own, a thread id is that thread's own session (`t-<id>`), else none. */
export function sessionOfTarget(ctx: Pick<BridgeContext, 'config'>, target: string): string | null {
  if (target === 'main') return MAIN_TMUX_SESSION
  if (!ThreadId.safeParse(target).success || !ctx.config.thread(target)) return null
  const name = `t-${target}`
  return isValidSessionName(name) ? name : null
}

export function createTermService(
  ctx: BridgeContext,
  home: string,
  o: TermWiringOptions = {},
): TermService | undefined {
  if (o.off) return undefined
  let openSource = o.openSource
  if (!openSource) {
    const tmux = resolveOnPath('tmux', processEnv())
    if (!tmux) return undefined
    const socket = testSocket(() => {}) ?? TMUX_SOCKET
    openSource = tmuxSourceOpener({ tmux, configPath: `${home}/${SUPERVISOR_FILES.tmuxConf}`, socket })
  }
  return new TermService({
    clock: ctx.clock,
    log: ctx.log,
    send: (frame) => ctx.transport.sendEphemeral(frame),
    openSource,
    audit: new TermAudit(ctx.store.db),
    sessionOf: (t) => sessionOfTarget(ctx, t),
    deviceOk: (id) => ctx.devices.pinnedKey(id) !== undefined,
    ...(o.idleS !== undefined ? { idleS: o.idleS } : {}),
    ...(o.maxS !== undefined ? { maxS: o.maxS } : {}),
  })
}

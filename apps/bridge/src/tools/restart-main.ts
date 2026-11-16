// `restart_main` (docs/bridge.md "restart_main"): the main session, or a thread's lead, checks whether Main would come back
// after a restart and, only on yes, asks the Mac app to restart it. The work is in ../restart-main.ts; this is the record and
// who may call it.
import { threadSessionMode } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { say } from '../owner-words.ts'
import { checkText, cleanWhy, goRestartMain, readRestartCheck, withOwedCards } from '../restart-main.ts'
import { fail, ok, type ToolResult } from './common.ts'
import { type ToolRecord, WORKER_NO_THREAD } from './define.ts'

/**
 * Main's live session, or the lead of a thread that has its own session now. Headless jobs never reach here (the record is
 * not `headless`), but the handler says no too, so the rule does not rest on one list.
 */
function whoMayNot(ctx: BridgeContext): string | undefined {
  if (ctx.worker) {
    ctx.config.refresh()
    if (threadSessionMode(ctx.config.config, ctx.worker.thread) !== 'dedicated')
      return `Thread "${ctx.worker.thread}" no longer has its own session, so this session is not its lead and cannot restart Main. Stop here.`
    return undefined
  }
  if (ctx.mode !== 'live' || ctx.superseded)
    return 'restart_main needs the main session or a thread lead; a scheduled or headless job cannot restart Main.'
  return undefined
}

export const restartMain: ToolRecord = {
  name: 'restart_main',
  group: 'handoff',
  headless: false,
  ...WORKER_NO_THREAD,
  // read when asked, so the computer in force says it (Fable)
  get instructions() {
    return `\`restart_main\` restarts the main session through ${say({ mac: 'the Talos app on the Mac', linux: 'the Talos supervisor on this computer' })}, for when Main is stuck or must load new bridge code. Call it with action \`check\` first: it says whether Main would come back on its own and changes nothing. \`go\` (with a short \`why\`) restarts only when the answer is yes, at most once in 2 minutes and 3 times an hour across all sessions, and tells the owner in the default thread. When the answer is no, tell the owner why; they can restart from the phone.`
  },
  told: ['main', 'worker'],
  // read when asked, so the computer in force says it (Fable)
  get description() {
    return `Restart the main Talos session through ${say({ mac: 'the Mac app', linux: 'the supervisor on this computer' })}. action "check": would Main come back after a restart? Changes nothing. action "go": restart it, only when the check says yes; needs \`why\` (1-80 characters), shown to the owner in the default thread. Main and thread leads only; at most once in 2 minutes and 3 times an hour.`
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['check', 'go'] },
      why: { type: 'string', maxLength: 80, description: 'For go: why Main should restart, in a few words.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async handler(ctx, args): Promise<ToolResult> {
    const refused = whoMayNot(ctx)
    if (refused) return fail(refused)
    if (args.action === 'check') {
      const now = ctx.clock.now()
      return ok(checkText(withOwedCards(ctx, readRestartCheck(ctx.paths.home, now), now)))
    }
    if (args.action !== 'go') return fail('action must be "check" or "go"')
    const w = cleanWhy(args.why)
    if (!w.ok) return fail(w.text)
    const caller = ctx.worker ? { thread: ctx.worker.thread } : {}
    const r = goRestartMain(ctx, caller, w.why)
    if (!r.ok) return fail(r.text)
    if (!ctx.worker)
      return ok(
        say({
          mac: `Asked the Talos app to restart Main (request ${r.controlId}). The Mac app checks again and decides; if it restarts, it acts within a few seconds and this session will end. The Mac app tells the owner itself.`,
          linux: `Asked the supervisor to restart Main (request ${r.controlId}). The supervisor checks again and decides; if it restarts, it acts within a few seconds and this session will end. The supervisor tells the owner itself.`,
        }),
      )
    return ok(
      say({
        mac: `Asked the Talos app to restart Main (request ${r.controlId}). The Mac app checks again and decides, and tells the owner itself. Call check a minute from now to see what came of this request (came back, stalled at the Mac, or refused).`,
        linux: `Asked the supervisor to restart Main (request ${r.controlId}). The supervisor checks again and decides, and tells the owner itself. Call check a minute from now to see what came of this request (came back, stalled at this computer, or refused).`,
      }),
    )
  },
}

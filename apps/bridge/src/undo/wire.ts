// The live main bridge's undo wiring: the point service the router and the backlog call before a hand-over, main's
// agent folder, the undo card, and a message's undo point for the app. Absent everywhere else, and then no point is taken.
import type { BridgeOptions } from '../bridge-options.ts'
import type { BridgeContext } from '../context.ts'
import { agentDirFromEnv } from '../last-good.ts'
import { HandOvers, RestoringRoots, realFolder } from './busy.ts'
import { UndoCards } from './card.ts'
import { UndoMarks } from './marks.ts'
import { UndoPoints } from './points.ts'
import { UndoService } from './service.ts'

export function wireUndo(ctx: BridgeContext, opts: BridgeOptions['undo']): void {
  const undo = new UndoService({
    points: new UndoPoints(ctx.store.db),
    undoDir: ctx.paths.undo,
    clock: ctx.clock,
    log: ctx.log,
    ...(opts?.snapshot ? { snapshot: opts.snapshot } : {}),
    recorded: (ids) => ctx.undoMarks?.recorded(ids),
  })
  // a test names the folder (or none); production reads TALOS_AGENT_DIR, which install-mcp records
  const given = opts && 'agentDir' in opts ? opts.agentDir : agentDirFromEnv(process.env)
  // links resolved once, as the points' roots are: a folder given through a link still matches its points
  const agentDir = given === undefined ? undefined : realFolder(given)
  ctx.undo = {
    before: (t) => undo.before(t),
    abandon: () => undo.abandon(),
    mainFolder: () => agentDir,
    exclusive: (threads, fn) => undo.exclusive(threads, fn),
    restoring: new RestoringRoots(),
    handOvers: new HandOvers(),
  }
  ctx.undoCards = new UndoCards(ctx)
  ctx.undoMarks = new UndoMarks(ctx)
}

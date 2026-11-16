// "Undo to here": put a message's folder back the way its undo point saw it, then say so with one line in the message's
// thread that the session hears too, so the conversation keeps its context and knows its files moved back. The chat
// itself is not rewound. Only the paths in `deletes` that are new since the point are deleted (restore.ts).
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import type { RunAsync } from '../run-command.ts'
import { firstWords } from '../worker/handoff.ts'
import { type UndoPointRow, UndoPoints } from './points.ts'
import { applyRestore, type RestoreDone, type RestoreSeams } from './restore.ts'

export async function undoTo(
  ctx: BridgeContext,
  o: {
    messageId: string
    deletes: readonly string[]
    /** Why the point is not the one approved, or undefined: checked again once the restore has its turn. */
    check?: (row: UndoPointRow | undefined) => string | undefined
    /** Test seams: the git runner, and how birth times are judged. */
    run?: RunAsync
    seams?: RestoreSeams
  },
): Promise<RestoreDone> {
  const points = new UndoPoints(ctx.store.db)
  const row = points.get(o.messageId)
  if (!row) return { ok: false, why: 'This message has no undo point.' }
  // no point of this thread is pruned or taken while its files are copied back (a copy folder is named by thread and
  // turn); one recorded while this waited its turn is read here, so only the approved point is ever restored
  const restore = async (): Promise<RestoreDone> => {
    const now = points.get(o.messageId)
    const why = o.check?.(now)
    if (why) return { ok: false, why }
    if (!now) return { ok: false, why: 'This message has no undo point.' }
    // what git ignored then, widened by every later point of the folder: nothing any of them knew of is "new"
    const point = points.withLaterIgnored(now)
    const run = () =>
      applyRestore(point, { ...o.seams, undoDir: ctx.paths.undo, deletes: o.deletes, ...(o.run ? { run: o.run } : {}) })
    // marked as being restored: a turn that would start in this folder (any session, a scheduled run) waits for it
    return ctx.undo ? ctx.undo.restoring.hold(now.root, run) : run()
  }
  // exclusive on every thread: any session may work in this folder, so no point anywhere is taken while files are
  // half put back (a restore is short; points elsewhere wait for it)
  const threads = [...new Set([row.thread_id, ...ctx.config.config.threads.map((t) => t.id)])]
  const done = await (ctx.undo ? ctx.undo.exclusive(threads, restore) : restore())
  const words = () => {
    try {
      return firstWords(ctx.store.getMessage(o.messageId)?.text ?? '', 12) || 'that message'
    } catch {
      return 'that message'
    }
  }
  if (!done.ok) {
    // some files may already be back: the session must know, as it would of a whole undo
    if (done.partial) await tell(ctx, row.thread_id, `Files were partly undone back to "${words()}"; check the folder.`)
    return done
  }
  // nothing moved (it already matched): no line, the files are as the point saw them
  if (!done.rewritten.length && !done.recreated.length && !done.deleted.length) return done
  const left = done.blocked.length + done.failed.length
  const tail = left
    ? ` ${left} ${left === 1 ? 'file was' : 'files were'} left as ${left === 1 ? 'it is' : 'they are'}.`
    : ''
  await tell(ctx, row.thread_id, `Files were undone back to "${words()}".${tail}`)
  return done
}

/** One line in the thread that the session hears too. The files are as they are either way: a failed post is logged. */
async function tell(ctx: BridgeContext, thread: string, text: string): Promise<void> {
  try {
    await postSystemNotice(ctx, text, { thread: threadRef(ctx, thread), toAgent: true })
  } catch (e) {
    ctx.log.warn('undo line not posted', { error: (e as Error).message })
  }
}

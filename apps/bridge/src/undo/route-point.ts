// Where an owner message's turn runs, decided where the router decides who gets it: the thread worker's folder, or main's
// agent folder (main's own threads, a fallback, a late fallback). The router awaits `pointBefore` right before each
// hand-over, so the point is of the folder that hand-over runs in.
import { ThreadSessionOpts, type WorkerEntryT } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import type { Notification } from '../notify.ts'
import { refuseWhenStopping } from '../stopping.ts'
import type { UndoTurn } from './service.ts'

/** What the live main bridge puts on the context. */
export type UndoSeam = {
  before(t: UndoTurn): Promise<void>
  /** The bridge is stopping: every hold that waits ends at once and records nothing (service.ts). */
  abandon(): void
  /** Main's agent folder; undefined when it is not known. */
  mainFolder(): string | undefined
  /** Runs `fn` with no point taken, recorded or pruned for these threads meanwhile (a restore). */
  exclusive<T>(threads: readonly string[], fn: () => Promise<T>): Promise<T>
  /** Folders being restored right now: no turn starts in one until its restore ends. */
  restoring: import('./busy.ts').RestoringRoots
  /** Hand-overs a moment ago: their session counts as working for a while (busy.ts). */
  handOvers: import('./busy.ts').HandOvers
}

/**
 * The owner's own messages that start a turn (text, a file, a voice note, a Run): the kinds a worker can take too. A
 * question asked on a voice call (voice_delegation) is not an owner message row and gets no point.
 */
const UNDOABLE_KINDS = new Set(['text', 'file', 'voice_note'])

function ownerMessage(n: Notification): { id: string; thread: string } | undefined {
  const { kind, trust, message_id: id, thread_id: thread } = n.meta
  if (!kind || !UNDOABLE_KINDS.has(kind) || trust !== 'owner' || !id || !thread) return undefined
  return { id, thread }
}

/** The folder a thread's worker runs in: where it was started when it is running, else where it would start. */
export function workerFolder(
  ctx: BridgeContext,
  file: { threads: Partial<Record<string, WorkerEntryT>> } | null | undefined,
  lead: string,
): string | undefined {
  const entry = file?.threads[lead]
  if (entry && (entry.state === 'live' || entry.state === 'busy')) return entry.launched?.cwd ?? entry.cwd
  const opts = ThreadSessionOpts.safeParse(ctx.config.thread(lead)?.session_opts ?? {})
  return (opts.success ? opts.data.cwd : undefined) ?? ctx.undo?.mainFolder()
}

/**
 * Waits until no restore runs in the folder a hand-over would start a turn in ('main' for main's agent folder). Every
 * hand-over waits here, owner messages, scheduled runs and hand-offs alike: a turn never starts in a folder being undone.
 */
export async function waitForRestore(
  ctx: BridgeContext,
  folder: 'main' | { worker: string | undefined },
): Promise<void> {
  const undo = ctx.undo
  if (undo) await undo.restoring.waitFor(folder === 'main' ? undo.mainFolder() : folder.worker)
  refuseWhenStopping(ctx) // a hand-over after this would go to a session that is going away
}

/** Marks a hand-over into `folder` as just made: its session counts as working until its turn shows (busy.ts). */
export function noteHandOver(ctx: BridgeContext, folder: 'main' | { worker: string | undefined }): void {
  const undo = ctx.undo
  if (undo)
    undo.handOvers.note(folder === 'main' ? undo.mainFolder() : folder.worker, ctx.clock.now(), ctx.mod.turnStarts())
}

/**
 * Right before a hand-over into `folder` ('main' for main's agent folder): waits for any restore there, takes an owner
 * message's point (recorded, or the hold ran out), then waits again, so a restore that started meanwhile ends before the
 * turn does. For any other notification only the waits; nothing at all when undo is off.
 */
export async function pointBefore(
  ctx: BridgeContext,
  n: Notification,
  folder: 'main' | { worker: string | undefined },
  opts: { replace?: boolean | 'elsewhere' } = {},
): Promise<void> {
  const undo = ctx.undo
  if (!undo) return refuseWhenStopping(ctx) // no undo: no waits, but a stopping bridge still hands nothing over
  await waitForRestore(ctx, folder)
  const m = ownerMessage(n)
  if (m)
    await undo.before({
      messages: [m],
      folder: folder === 'main' ? undo.mainFolder() : folder.worker,
      ...(opts.replace ? { replace: opts.replace } : {}),
    })
  await waitForRestore(ctx, folder) // refuses a bridge that is stopping, whether the hold ran out or was given up
  noteHandOver(ctx, folder) // the hand-over follows now: its session counts as working until its turn shows
}

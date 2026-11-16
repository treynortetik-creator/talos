// Park, resume, restart or start fresh one thread's own session (docs/OPTION-C.md). The one place that checks and writes the
// wake file for a control: the owner's button (`thread.session.control`, controls.ts) and the main session's `thread_session`
// tool both come here, so they share every refusal (not dedicated, the Mac app not running, a saved session it cannot read,
// the usage governor) and write the same file. The desktop supervisor does the work.
import {
  supervisorFresh,
  threadSessionMode,
  trustOn,
  WAKE_CAPPED_ACTIONS,
  WAKE_IDLE_ONLY_ACTIONS,
  WAKE_NOTICE,
  wakeCapCheck,
  wakeLimitText,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { say } from '../owner-words.ts'
import { type WorkersReader, wakeCapTimes, writeWake } from '../worker/files.ts'
import { allowsStart, governorNow } from './governor.ts'

type SessionControlAction = 'park' | 'resume' | 'restart' | 'fresh'

type SessionControlResult = {
  ok: boolean
  code?: 'worker_unavailable' | 'usage_governor' | 'rate_limited'
  text: string
}

const TEXT = {
  park: 'Parking this thread’s session. Its conversation is kept; the next message resumes it.',
  resume: 'Resuming this thread’s session.',
  restart: 'Restarting this thread’s session with its current settings.',
  get fresh() {
    return say({
      mac: 'Starting a fresh conversation for this thread. The old one is kept on the Mac.',
      linux: 'Starting a fresh conversation for this thread. The old one is kept on your computer.',
    })
  },
} as const

export function controlThreadSession(
  ctx: Pick<BridgeContext, 'config' | 'clock' | 'paths' | 'log' | 'mod' | 'usage'>,
  req: { thread_id: string; action: SessionControlAction; by: 'owner' | 'main' },
  workers: WorkersReader,
): SessionControlResult {
  if (threadSessionMode(ctx.config.config, req.thread_id) !== 'dedicated')
    return { ok: false, code: 'worker_unavailable', text: 'This thread doesn’t have its own session.' }
  const file = workers.read()
  if (!supervisorFresh(file, ctx.clock.now()) || !file?.supervisor.workers_supported)
    return {
      ok: false,
      code: 'worker_unavailable',
      text: say({ mac: 'The Talos app on your Mac isn’t running.', linux: 'Talos on your computer isn’t running.' }),
    }
  if (file.unavailable.includes(req.thread_id))
    return {
      ok: false,
      code: 'worker_unavailable',
      text: say({
        mac: 'Your Mac can’t read this thread’s saved session, so it won’t start it. The Talos app on your Mac says how to fix it.',
        linux:
          'Your computer can’t read this thread’s saved session, so it won’t start it. `talos-app supervise status` there says how to fix it.',
        windows:
          'Your computer can’t read this thread’s saved session, so it won’t start it. On the PC, click the Talos icon by the clock and choose Open the log folder; the newest supervisor log says why.',
      }),
    }
  // The reader's own rules (wake-decision.ts), checked here first so the answer is the reader's refusal, never "Starting..." or
  // "Restarting..." followed by it. A fresh start only while the session is not in a turn: `busy` in workers.json is the turn the
  // supervisor publishes. Then the gap and the hourly cap, counted for every caller: the wake file cannot prove who asked.
  if (
    (WAKE_IDLE_ONLY_ACTIONS as readonly string[]).includes(req.action) &&
    file.threads[req.thread_id]?.state === 'busy'
  )
    return { ok: false, code: 'worker_unavailable', text: WAKE_NOTICE.busy }
  if ((WAKE_CAPPED_ACTIONS as readonly string[]).includes(req.action)) {
    const cap = wakeCapCheck(wakeCapTimes(ctx.paths.home, req.thread_id), ctx.clock.now())
    if (!cap.ok) return { ok: false, code: 'rate_limited', text: wakeLimitText(req.action as 'restart' | 'fresh') }
  }
  const starts = req.action === 'resume' || req.action === 'restart' || req.action === 'fresh'
  const trust = trustOn(ctx.config.config)
  const reading = governorNow(ctx)
  if (starts && !allowsStart(reading, { trust }))
    return {
      ok: false,
      code: 'usage_governor',
      text: 'Plan limits are close, so thread sessions are paused. Main keeps answering.',
    }
  try {
    writeWake(
      ctx.paths.home,
      {
        v: 1,
        thread_id: req.thread_id,
        message_ids: [],
        at: new Date(ctx.clock.now()).toISOString(),
        reason: 'control',
        action: req.action,
        by: req.by,
      },
      (msg, f) => ctx.log.warn(msg, f),
    )
  } catch (e) {
    ctx.log.warn('thread session control not written', { error: (e as Error).message })
    return {
      ok: false,
      code: 'worker_unavailable',
      text: say({
        mac: 'The Mac could not pass that on. Try again.',
        linux: 'This computer could not pass that on. Try again.',
      }),
    }
  }
  // trust mode lets a start through the "limits are close" band, and says so
  const warn = starts && reading.state === 'paused' ? ' Plan limits are close, so this may run out sooner.' : ''
  return { ok: true, text: `${TEXT[req.action]}${warn}` }
}

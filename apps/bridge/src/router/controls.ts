// `thread.session.control` (docs/OPTION-C.md): park, resume, restart or start fresh one thread's own session. The hub
// only checks and passes it on as a wake file; the desktop supervisor does the work. The result is recorded like a
// session.control result (same frame, same replay rule), so a relay replay never runs it twice.
import { dedicatedSettings, type Frame, supervisorFresh, threadSessionMode, trustOn } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { RESET_REFUSAL, signedBeforeReset } from '../history-recover.ts'
import { WorkersReader, writeWake } from '../worker/files.ts'
import { allowsStart, governor } from './governor.ts'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>

const TEXT = {
  park: 'Parking this thread’s session. Its conversation is kept; the next message resumes it.',
  resume: 'Resuming this thread’s session.',
  restart: 'Restarting this thread’s session with its current settings.',
  fresh: 'Starting a fresh conversation for this thread. The old one is kept on the Mac.',
} as const

type Result = { ok: boolean; code?: 'worker_unavailable' | 'usage_governor'; text: string }

export function onThreadSessionControl(
  ctx: BridgeContext,
  f: Of<'thread.session.control'>,
  finish: () => void,
  workers: WorkersReader = new WorkersReader(ctx.paths.home),
): void {
  if (ctx.session.hasResult(f.control_id)) ctx.session.resend(f.control_id)
  else
    ctx.session.recordResult(f.control_id, signedBeforeReset(ctx.store, f.ts) ? RESET_REFUSAL : decide(ctx, f, workers))
  finish()
}

function decide(ctx: BridgeContext, f: Of<'thread.session.control'>, workers: WorkersReader): Result {
  if (threadSessionMode(ctx.config.config, f.thread_id) !== 'dedicated')
    return { ok: false, code: 'worker_unavailable', text: 'This thread doesn’t have its own session.' }
  const file = workers.read()
  if (!supervisorFresh(file, ctx.clock.now()) || !file?.supervisor.workers_supported)
    return { ok: false, code: 'worker_unavailable', text: 'The Talos app on your Mac isn’t running.' }
  const starts = f.action === 'resume' || f.action === 'restart' || f.action === 'fresh'
  const trust = trustOn(ctx.config.config)
  const reading = governor(dedicatedSettings(ctx.config.config), ctx.mod.liveState())
  if (starts && !allowsStart(reading, { trust }))
    return {
      ok: false,
      code: 'usage_governor',
      text: 'Plan limits are close, so thread sessions are paused. Main keeps answering.',
    }
  try {
    writeWake(ctx.paths.home, {
      v: 1,
      thread_id: f.thread_id,
      message_ids: [],
      at: new Date(ctx.clock.now()).toISOString(),
      reason: 'control',
      action: f.action,
    })
  } catch (e) {
    ctx.log.warn('thread session control not written', { error: (e as Error).message })
    return { ok: false, code: 'worker_unavailable', text: 'The Mac could not pass that on. Try again.' }
  }
  // trust mode lets a start through the "limits are close" band, and says so
  const warn = starts && reading.state === 'paused' ? ' Plan limits are close, so this may run out sooner.' : ''
  return { ok: true, text: `${TEXT[f.action]}${warn}` }
}

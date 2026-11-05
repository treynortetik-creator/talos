// Live voice (spec 6, WP4): POST /api/voice/session, the close route, the sideband hand-off and the caps.
import { newUlid, routes as protocolRoutes } from '@talos-app/protocol'
import { Hono } from 'hono'
import { rateLimit, requireCsrf, requireSession } from '../auth/contract.ts'
import { findRuntime } from '../core/runtime.ts'
import type { AppEnv, RelayServices } from '../services.ts'
import { GptLiveProvider } from './gpt-live.ts'
import { pruneVoiceUsage, VoiceError, VoiceManager } from './manager.ts'
import type { VoiceProvider } from './provider.ts'

export const routes = new Hono<AppEnv>()

let manager: VoiceManager | null = null
let injected: VoiceProvider | null = null

/** Tests install a scripted provider here (before `register`). `null` goes back to the env-configured one. */
export function setVoiceProvider(p: VoiceProvider | null): void {
  injected = p
}

export function getVoiceManager(): VoiceManager | null {
  return manager
}

function pickProvider(services: RelayServices): VoiceProvider | null {
  if (injected) return injected
  const { OPENAI_API_KEY, VOICE_MODEL } = services.env
  if (!OPENAI_API_KEY) return null
  return new GptLiveProvider(OPENAI_API_KEY, VOICE_MODEL, services.log)
}

const fail = (e: VoiceError) => ({ error: e.code, message: e.message })

routes.post('/api/voice/session', requireSession, requireCsrf, rateLimit('voice'), async (c) => {
  if (!manager) return c.json({ error: 'voice_disabled', message: 'Live voice is not set up.' }, 503)
  const body = protocolRoutes.voiceSession.req.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'bad_request', message: 'Bad call request.' }, 400)
  try {
    const res = await manager.createSession({ threadId: body.data.thread_id, sdp: body.data.sdp })
    return c.json(protocolRoutes.voiceSession.res.parse(res))
  } catch (e) {
    if (e instanceof VoiceError) return c.json(fail(e), e.status)
    throw e
  }
})

routes.post('/api/voice/session/:id/close', requireSession, requireCsrf, async (c) => {
  if (!manager) return c.json({ error: 'voice_disabled', message: 'Live voice is not set up.' }, 503)
  try {
    await manager.endSession(c.req.param('id'), 'requested')
  } catch (e) {
    // Closing a call that already ended is fine: the app may race the relay's own close.
    if (!(e instanceof VoiceError && e.status === 404)) throw e
  }
  return c.body(null, 204)
})

const managers = new WeakMap<RelayServices, VoiceManager>()

/** Called by the relay's own `stop()`: saves usage for calls in progress (the next start reconciles them). */
export function shutdownVoice(services: RelayServices): void {
  managers.get(services)?.shutdown()
}

export function register(services: RelayServices): void {
  const provider = pickProvider(services)
  manager = provider ? new VoiceManager(services, provider) : null
  if (!manager) return
  const m = manager
  let sweepTimer: unknown
  const sweepUsage = () => {
    try {
      pruneVoiceUsage(services)
    } catch (e) {
      services.log.error({ err: e instanceof Error ? e.name : 'error' }, 'voice usage prune failed')
    }
    sweepTimer = services.clock.setTimeout(sweepUsage, 3_600_000)
  }
  sweepTimer = services.clock.setTimeout(sweepUsage, 60_000)
  // Stopped with the relay: the sweep would otherwise run on a closed database and keep the process's timers alive.
  findRuntime(services)?.onStop(() => services.clock.clearTimeout(sweepTimer))
  managers.set(services, m)
  services.bus.onAppFrame('voice.ask', async (frame, ctx) => {
    const refusal = await m.handleAsk(frame, ctx.raw)
    if (refusal) {
      ctx.reply({ v: 1, type: 'error', id: newUlid(), ref: frame.id, code: 'bad_frame', message: refusal })
    } else {
      // Accepted and queued for the Mac. The app keeps a sent voice.ask in its outbox until it is acked, so without this
      // every old ask is resent on every reconnect (and refused again).
      ctx.reply({ v: 1, type: 'ack', id: newUlid(), ref: frame.id })
    }
  })
  services.bus.onBridgeFrame('voice.progress', (frame) => m.handleProgress(frame))
  services.bus.onBridgeFrame('reply', (frame) => m.handleReply(frame))
}

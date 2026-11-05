import { newId, newUlid } from '@talos-app/protocol'
import { loadFrameFixture } from '@talos-app/testkit'
import type { Hono } from 'hono'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { buildApp } from '../../src/routes.ts'
import type { AppEnv } from '../../src/services.ts'
import { FakeVoiceProvider } from '../../src/voice/fake-provider.ts'
import { register, setVoiceProvider } from '../../src/voice/index.ts'
import { setVoicePorts } from '../../src/voice/ports.ts'
import { createFakeServices, type FakeServices } from '../helpers/fake-services.ts'
import { installTestAuth, testAppHeaders } from '../helpers/test-auth.ts'

export type Harness = FakeServices & {
  provider: FakeVoiceProvider
  app: Hono<AppEnv>
  call(threadId?: string): Promise<Response>
  start(threadId?: string): Promise<{ voice_session_id: string; sdp_answer: string; max_minutes: number }>
  delegate(sessionId: string, delegationId?: string): void
  ask(sessionId: string, delegationId: string, over?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  progress(delegationId: string, text: string, say: boolean): Promise<void>
  reply(delegationId: string, over?: Record<string, unknown>): Promise<void>
  appended: unknown[]
}

export function setup(env: Record<string, string> = {}): Harness {
  resetAuthImplementation()
  installTestAuth()
  const f = createFakeServices({ env })
  const provider = new FakeVoiceProvider()
  setVoiceProvider(provider)
  const appended: unknown[] = []
  setVoicePorts({ sink: { append: async (m) => void appended.push(...m) } })
  register(f.services)
  f.bus.setBridgeOnline(true)
  const app = buildApp(f.services)
  const headers = { ...testAppHeaders('https://relay.example.com', 'd_abc'), 'content-type': 'application/json' }
  const call = (threadId = 'general') =>
    Promise.resolve(
      app.request('/api/voice/session', {
        method: 'POST',
        headers,
        body: JSON.stringify({ thread_id: threadId, sdp: 'v=0\r\no=- offer\r\n' }),
      }),
    )
  const h: Harness = {
    ...f,
    provider,
    app,
    appended,
    call,
    async start(threadId) {
      const res = await call(threadId)
      if (res.status !== 200) throw new Error(`start failed: ${res.status} ${await res.text()}`)
      return res.json() as never
    },
    delegate(sessionId, delegationId = 'dlg_1') {
      void sessionId
      provider.last.emit({
        type: 'session.delegation.created',
        event_id: 'e1',
        offset_ms: 1,
        delegation: { id: delegationId, target: 'client', type: 'delegation' },
      })
    },
    async ask(sessionId, delegationId, over = {}) {
      const raw = {
        ...loadFrameFixture('voice.ask'),
        id: newUlid(),
        voice_session_id: sessionId,
        delegation_id: delegationId,
        thread_id: 'general',
        ...over,
      }
      return f.bus.injectAppFrame(raw)
    },
    async progress(delegationId, text, say) {
      await f.bus.injectBridgeFrame({
        ...loadFrameFixture('voice.progress'),
        id: newUlid(),
        voice_delegation_id: delegationId,
        text,
        say,
      })
    },
    async reply(delegationId, over = {}) {
      const base = loadFrameFixture('reply') as { message: Record<string, unknown> }
      await f.bus.injectBridgeFrame({
        ...base,
        id: newUlid(),
        message: { ...base.message, id: newId('m') },
        voice_delegation_id: delegationId,
        ...over,
      })
    },
  }
  return h
}

export function teardown(): void {
  setVoiceProvider(null)
  setVoicePorts(null)
  resetAuthImplementation()
}

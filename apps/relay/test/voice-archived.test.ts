// Voice input archived 2026-11-19 at the owner's request (dictation, the voice-note microphone, the live call).
// Tag archive/voice-2026-11-19; how to bring it back: docs/archived/voice.md.
// These tests prove the relay no longer offers any of it.
import { mkFrame } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadEnv } from '../src/env.ts'
import { type RealRelay, startRealRelay } from './review/real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

const KEY = Buffer.alloc(32, 7).toString('base64')
const base = { PUBLIC_ORIGIN: 'https://relay.example.com', RP_ID: 'relay.example.com', DATA_KEY: KEY }

describe('voice input is archived: relay', () => {
  it('POST /api/dictate, /api/voice/session and its close answer 404', async () => {
    r = await startRealRelay({ env: { OPENAI_API_KEY: 'sk-test-not-real' } })
    const owner = await r.owner()
    for (const path of [
      '/api/dictate',
      '/api/voice/session',
      '/api/voice/session/v_01JBF3V7Q8K2M4N6P8R0S2T4V6/close',
    ]) {
      const res = await fetch(`${r.httpBase}${path}`, {
        method: 'POST',
        headers: {
          Origin: 'https://relay.example.com',
          'X-Talos-CSRF': '1',
          'content-type': 'application/json',
          Cookie: owner.cookie,
        },
        body: '{}',
      })
      expect(res.status, path).toBe(404)
    }
  })

  it('/api/me has no dictate or voice field', async () => {
    r = await startRealRelay({ env: { OPENAI_API_KEY: 'sk-test-not-real' } })
    const owner = await r.owner()
    const res = await fetch(`${r.httpBase}/api/me`, { headers: { Cookie: owner.cookie } })
    expect(res.status).toBe(200)
    const me = (await res.json()) as Record<string, unknown>
    expect(me).not.toHaveProperty('dictate')
    expect(me).not.toHaveProperty('voice')
  })

  it('the app page forbids the microphone for every origin', async () => {
    r = await startRealRelay()
    const res = await fetch(`${r.httpBase}/healthz`)
    expect(res.headers.get('permissions-policy')).toBe('microphone=(), camera=(), geolocation=(), payment=()')
  })

  it('the voice and dictation environment variables are not read', () => {
    const e = loadEnv({
      ...base,
      OPENAI_API_KEY: 'sk-test-not-real',
      OPENAI_BASE_URL: 'https://openai.example.com/v1',
      TRANSCRIBE_MODEL: 'some-model',
      DICTATE_DAILY_MAX_MB: '5',
      DICTATE_TIMEOUT_S: '5',
      VOICE_MODEL: 'some-model',
      VOICE_DAILY_MAX_MIN: '5',
      VOICE_SESSION_MAX_MIN: '5',
    })
    for (const k of [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'TRANSCRIBE_MODEL',
      'DICTATE_DAILY_MAX_MB',
      'DICTATE_TIMEOUT_S',
      'VOICE_MODEL',
      'VOICE_DAILY_MAX_MIN',
      'VOICE_SESSION_MAX_MIN',
    ])
      expect(e, k).not.toHaveProperty(k)
  })

  it('an app that still sends a voice note or a voice.ask gets an error and no ack', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const app = r.app(owner)
    await app.connect()
    const attachment = {
      media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T401',
      kind: 'voice_note',
      role: 'attachment',
      mime: 'audio/mp4',
      name: 'note.m4a',
      size: 2048,
      sha256: 'ab'.repeat(32),
      duration_ms: 4200,
    }
    const frames = [
      { type: 'voice_note', thread_id: 'general', client_msg_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T41Z', attachment },
      {
        type: 'voice.ask',
        voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T426',
        delegation_id: 'vd_example',
        thread_id: 'general',
        question: 'What is on my plate today?',
        transcript_tail: [],
      },
    ]
    for (const body of frames) {
      const f = await app.sign(mkFrame(body.type, body))
      app.send(f)
      const err = await app.expectFrame('error', (e) => e.ref === f.id)
      expect(err.code).toBe('bad_frame')
      await app.rec.expectNoFrame('ack', (a) => a.ref === f.id)
    }
  })
})

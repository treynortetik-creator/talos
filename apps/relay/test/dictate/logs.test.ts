// Dictation logs lengths and status only: never audio, never transcript, never the key.
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { buildApp } from '../../src/routes.ts'
import { createFakeServices } from '../helpers/fake-services.ts'
import { installTestAuth, testAppHeaders } from '../helpers/test-auth.ts'
import { startFakeOpenAI } from './fake-openai.ts'

afterEach(() => resetAuthImplementation())

describe('dictation logging', () => {
  for (const mode of ['ok', 'upstream 500', 'dropped'] as const) {
    it(`logs no audio, transcript or key (${mode})`, async () => {
      const openai = await startFakeOpenAI()
      try {
        openai.behaviour =
          mode === 'ok'
            ? { kind: 'text', text: 'transcript-words-b81e44c0' }
            : mode === 'dropped'
              ? { kind: 'drop' }
              : {
                  kind: 'status',
                  status: 500,
                  body: '{"error":{"message":"transcript-words-b81e44c0 sk-test-not-real"}}',
                }
        resetAuthImplementation()
        installTestAuth()
        const f = createFakeServices({
          env: { OPENAI_API_KEY: 'sk-test-not-real', OPENAI_BASE_URL: openai.baseUrl },
        })
        const app = buildApp(f.services)
        const body = new Uint8Array(500)
        body.set([0x1a, 0x45, 0xdf, 0xa3])
        body.set(new TextEncoder().encode('AUDIO-MARKER-9f3c1d7e5a'), 16)
        const res = await app.request('/api/dictate', {
          method: 'POST',
          headers: { ...testAppHeaders('https://relay.example.com', 'd_abc'), 'content-type': 'audio/webm' },
          body,
        })
        expect(res.status).toBe(mode === 'ok' ? 200 : 502)
        const logged = JSON.stringify(f.logs)
        expect(logged).toContain('dictate') // it does log something
        expect(logged).toContain('"bytes":500')
        for (const secret of ['AUDIO-MARKER', 'transcript-words', 'sk-test-not-real'])
          expect(logged, secret).not.toContain(secret)
      } finally {
        await openai.stop()
      }
    })
  }
})

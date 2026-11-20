// Voice input archived 2026-11-19 at the owner's request (dictation, the voice-note microphone, the live call).
// Tag archive/voice-2026-11-19; how to bring it back: docs/archived/voice.md.
// These tests prove the wire format no longer carries any of it, and that old config files still read.
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AgentConfig,
  CHANNEL_KINDS,
  CHANNEL_TRUSTS,
  CONSUMABLE_FRAME_TYPES,
  classifyUnparsed,
  DIRECTION_TYPES,
  DURABLE_FRAME_TYPES,
  FRAME_TYPES,
  HealthBeat,
  NATIVE_TO_WEB,
  OWNER_FRAME_TYPES,
  parseFrame,
  routes,
  SETTINGS_TABLE,
  wantVoiceReply,
} from '../src/index.ts'

const GONE_FRAMES = ['voice_note', 'voice.state', 'voice.ask', 'voice.progress', 'voice.ended']

describe('voice input is archived: protocol', () => {
  it('no frame union carries a voice-note or live-call frame', () => {
    for (const t of GONE_FRAMES) {
      expect(FRAME_TYPES as string[], t).not.toContain(t)
      expect(OWNER_FRAME_TYPES as readonly string[], t).not.toContain(t)
      expect(DURABLE_FRAME_TYPES as readonly string[], t).not.toContain(t)
      expect(CONSUMABLE_FRAME_TYPES as readonly string[], t).not.toContain(t)
      for (const [dir, types] of Object.entries(DIRECTION_TYPES))
        expect(types as readonly string[], `${dir} ${t}`).not.toContain(t)
      expect(
        parseFrame({ v: 1, type: t, id: '01JBF3V7Q8K2M4N6P8R0S2T4V6', ts: '2026-11-19T10:00:00.000Z' }).ok,
        t,
      ).toBe(false)
    }
  })

  it('a reply no longer carries a live-call field, and a native shell has no voice_note message', () => {
    expect(Object.keys(NATIVE_TO_WEB)).not.toContain('voice_note')
    const ok = parseFrame({
      v: 1,
      type: 'reply',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
      ts: '2026-11-19T10:00:00.000Z',
      message: {
        id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4V7',
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        text: 'hi',
        created_at: '2026-11-19T10:00:00.000Z',
      },
      voice_delegation_id: 'vd_example',
      speak: 'hello',
    })
    expect(ok.ok && 'voice_delegation_id' in ok.frame).toBe(false)
    expect(ok.ok && 'speak' in ok.frame).toBe(false)
  })

  it('the channel meta has no voice kinds and no voice trust', () => {
    for (const k of ['voice_note', 'voice_delegation', 'voice_ended'])
      expect(CHANNEL_KINDS as readonly string[]).not.toContain(k)
    expect(CHANNEL_TRUSTS as readonly string[]).not.toContain('owner_voice')
  })

  it('the HTTP table has no dictate or live-voice route, and /api/me no field for them', () => {
    expect(Object.keys(routes)).not.toContain('dictate')
    expect(Object.keys(routes)).not.toContain('voiceSession')
    expect(Object.keys(routes)).not.toContain('voiceSessionClose')
    expect(Object.keys(routes.me.res.shape)).not.toContain('voice')
    expect(Object.keys(routes.me.res.shape)).not.toContain('dictate')
  })

  it('the settings table has no live-call voice or persona row', () => {
    expect(Object.keys(SETTINGS_TABLE)).not.toContain('agent.voice')
    expect(Object.keys(SETTINGS_TABLE)).not.toContain('agent.voice_persona')
  })

  it('a config file that still has the live-call keys parses (they are accepted and ignored)', () => {
    const old = structuredClone(defaultConfig) as unknown as {
      agent: Record<string, unknown>
      threads: Array<Record<string, unknown>>
      voice_notes: unknown
    }
    old.agent.voice = 'meridian'
    old.agent.voice_persona = 'calm'
    for (const t of old.threads) t.voice_context = 'recent'
    old.voice_notes = { reply_with_voice: 'when_voice', driving_until: null }
    const r = AgentConfig.safeParse(old)
    expect(r.success).toBe(true)
  })

  it('a stored when_voice reads as never; always and driving still speak', () => {
    const cfg = (p: 'when_voice' | 'always' | 'never', until: string | null = null) => ({
      voice_notes: { reply_with_voice: p, driving_until: until },
    })
    const now = Date.parse('2026-11-19T10:00:00.000Z')
    expect(wantVoiceReply(cfg('when_voice'), now)).toBe(false)
    expect(wantVoiceReply(cfg('never'), now)).toBe(false)
    expect(wantVoiceReply(cfg('always'), now)).toBe(true)
    expect(wantVoiceReply(cfg('never', '2026-11-19T11:00:00.000Z'), now)).toBe(true)
  })

  it('the health beat reads with or without stt: an older bridge still says true, this one says false for an older relay', () => {
    const b = {
      bridge: { version: 'v', started_at: '2026-11-12T00:00:00.000Z' },
      mod: { state: 'absent', last_seen: null, expected: false },
      tts: false,
      sqlite: { fts5: true },
    }
    for (const stt of [undefined, true, false])
      expect(HealthBeat.safeParse({ ...b, stt }).success, String(stt)).toBe(true)
  })

  it('a stored voice-note or call frame from before the archive is not read as a sign of a newer app', () => {
    // a catch-up or a relay's queue may still hold one for days: it is skipped quietly, not "update Talos"
    for (const type of GONE_FRAMES) {
      expect(classifyUnparsed({ type, id: '01JC0000000000000000000000' }, 'relay_to_app'), type).toEqual({
        kind: 'broken',
      })
      expect(classifyUnparsed({ type, id: '01JC0000000000000000000000' }, 'relay_to_bridge'), type).toEqual({
        kind: 'broken',
      })
    }
    expect(classifyUnparsed({ type: 'some.new_thing' }, 'relay_to_app')).toEqual({
      kind: 'unknown_type',
      type: 'some.new_thing',
    })
  })
})

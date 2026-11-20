// Voice input archived 2026-11-19 at the owner's request (dictation, the voice-note microphone, the live call).
// Tag archive/voice-2026-11-19; how to bring it back: docs/archived/voice.md.
// These tests prove the bridge no longer offers, reads or tells the agent about any of it.
import { afterEach, describe, expect, test } from 'bun:test'
import { agentInstructions } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { APP_INSTRUCTIONS } from '../src/tools/apps.ts'
import { toolsFor } from '../src/tools/index.ts'
import * as T from '../src/tools/table.ts'
import { eventually, type Harness, pushOwnerFrameToBridge, sleep, startHarness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

const WORDS = /live call|voice note|dictat|owner_voice|voice_delegation|voice_progress|Talk live|spoken question/i

describe('voice input is archived: bridge', () => {
  test('the tool table has no voice_progress, and reply has no live-call arguments', () => {
    expect(Object.keys(T.AGENT_TOOLS)).not.toContain('voice_progress')
    for (const worker of [undefined, 'general'])
      for (const t of toolsFor({ scheduler: 'off', apps: false, workerThread: worker })) {
        expect(t.name).not.toBe('voice_progress')
        if (t.name === 'reply') {
          const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties)
          expect(props).not.toContain('voice_delegation_id')
          expect(props).not.toContain('speak')
          expect(t.description).not.toMatch(/live call/i)
        }
      }
  })

  test('what the agent is told never mentions a live call, a voice note or dictation', () => {
    for (const worker of [false, true])
      for (const trust of [false, true]) {
        const text = agentInstructions({ worker, trust, appInstructions: APP_INSTRUCTIONS })
        expect(text).not.toMatch(WORDS)
      }
  })

  test('the speech-to-text variables for voice notes are not read', () => {
    const env = loadEnv({
      TALOS_APP_HOME: '/tmp/talos-voice-archived-nonexistent',
      TALOS_APP_STT_CMD: '["stt","{in}"]',
      TALOS_APP_STT_LONG_CMD: '["stt","{in}"]',
      TALOS_APP_STT_LONG_AFTER_S: '5',
      TALOS_APP_STT_TIMEOUT_S: '5',
    })
    for (const k of ['sttCmd', 'sttLongCmd', 'sttLongAfterS', 'sttTimeoutS']) expect(env).not.toHaveProperty(k)
  })

  test('a voice note, a voice.ask and a voice.ended from the relay are refused as unknown frames, and reach no agent', async () => {
    h = await startHarness()
    const att = {
      media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T401',
      kind: 'voice_note',
      role: 'attachment',
      mime: 'audio/mp4',
      name: 'note.m4a',
      size: 2048,
      sha256: 'ab'.repeat(32),
      duration_ms: 4200,
    }
    await pushOwnerFrameToBridge(h, {
      type: 'voice_note',
      thread_id: 'general',
      client_msg_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T41Z',
      attachment: att,
    })
    await pushOwnerFrameToBridge(h, {
      type: 'voice.ask',
      voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T426',
      delegation_id: 'vd_example',
      thread_id: 'general',
      question: 'What is on my plate today?',
      transcript_tail: [],
    })
    h.relay.sendToBridge({
      type: 'voice.ended',
      voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T426',
      thread_id: 'general',
      duration_s: 12,
      transcript: [],
    })
    await eventually(() =>
      expect(
        h.relay.rec.of('error', 'from_bridge').filter((f) => f.code === 'bad_frame').length,
      ).toBeGreaterThanOrEqual(3),
    )
    await sleep(200)
    expect(h.notes).toHaveLength(0)
    expect(h.relay.bridgeConnected).toBe(true)
    // and they are no sign of a newer relay or phone: no "update Talos on this Mac" in the Inbox
    expect(newerNotices()).toBe(0)
    // (a frame type this build really lacks still gets the notice: the check above can see one)
    h.relay.sendToBridge({ type: 'some.new_thing', thread_id: 'general' })
    await eventually(() => expect(newerNotices()).toBe(1))
  })
})

const newerNotices = () =>
  h.relay.frames.filter((f) => f.direction === 'from_bridge' && JSON.stringify(f).includes('newer kind of message'))
    .length

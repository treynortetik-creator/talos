// The supervisor's run/main-state as one word (main-state.ts): its contract is Hestia's (apps/bridge/src/supervisor/main-state.ts).
import { describe, expect, it } from 'vitest'
import { HealthBeat, MAIN_STATES, mainStateOf } from '../src/index.ts'

describe('mainStateOf', () => {
  it('reads the first line: four states as themselves, any waiting kind as waiting', () => {
    expect(mainStateOf('main=signin\n')).toBe('signin')
    expect(mainStateOf('main=running')).toBe('running')
    expect(mainStateOf('main=starting\n')).toBe('starting')
    expect(mainStateOf('main=stopped\n')).toBe('stopped')
    for (const k of [
      'theme',
      'security_notes',
      'trust',
      'mcp_consent',
      'dev_channels',
      'api_key',
      'bypass',
      'unknown',
      'a_new_kind',
    ])
      expect(mainStateOf(`main=waiting:${k}\n`), k).toBe('waiting')
    expect(mainStateOf('main=waiting:unknown\nthe screen, which never leaves the machine\n')).toBe('waiting')
  })
  it('anything else is "do not know"', () => {
    for (const t of [
      undefined,
      null,
      '',
      '\n',
      'main=',
      'main=waiting',
      'main=waiting:',
      'main=Signin',
      'main=signin extra',
      'signin',
      'x\nmain=signin',
      'main=dreaming',
    ])
      expect(mainStateOf(t), JSON.stringify(t)).toBeUndefined()
  })
  it('the beat takes the five words and drops any other (an older relay never fails a whole beat on a new word)', () => {
    const b = {
      bridge: { version: 'v', started_at: '2026-11-12T00:00:00.000Z' },
      mod: { state: 'absent', last_seen: null, expected: false },
      tts: false,
      stt: false,
      sqlite: { fts5: true },
    }
    for (const m of MAIN_STATES) expect(HealthBeat.parse({ ...b, main: m }).main).toBe(m)
    expect(HealthBeat.parse({ ...b, main: 'dreaming' }).main).toBeUndefined()
    expect(HealthBeat.parse(b).main).toBeUndefined()
  })
})

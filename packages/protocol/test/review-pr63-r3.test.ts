// Independent review round 3 of PR #63 at fbdd8c8: the tolerant-read fix. `AgentConfig.dedicated` falls back to absent
// (= off) when any field inside it is one this build can't read. A newer Mac that allows more workers, or a hand edit,
// then makes an old app believe the master switch is OFF while the Mac has it ON, and the switch-off is not offered.
// REVIEW-FAIL tests fail on fbdd8c8.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { dedicatedSettings, newUlid, parseFrame } from '../src/index.ts'

const base = JSON.parse(readFileSync(new URL('../fixtures/frames/ready.json', import.meta.url), 'utf8'))
const readyWith = (dedicated: unknown) => ({
  ...base,
  id: newUlid(),
  agent_config: { ...base.agent_config, dedicated },
})
const parsedEnabled = (dedicated: unknown) => {
  const r = parseFrame(readyWith(dedicated), { direction: 'relay_to_app' })
  if (!r.ok) throw new Error(`ready dropped: ${r.code}`)
  const cfg = (r.frame as { agent_config: { dedicated?: unknown } }).agent_config
  return dedicatedSettings(cfg).enabled
}

describe('recheck r3 OC0: a dedicated block this build cannot fully read keeps the master switch', () => {
  test('control: today’s dedicated block is read as on', () => {
    expect(parsedEnabled({ enabled: true, max_live: 3 })).toBe(true)
  })

  test('the ready itself is never dropped (fix holds)', () => {
    expect(parseFrame(readyWith({ enabled: true, max_live: 12 }), { direction: 'relay_to_app' }).ok).toBe(true)
  })

  test('REVIEW-FAIL: a newer Mac that allows more live workers (max_live 8) is still read as switched ON', () => {
    expect(parsedEnabled({ enabled: true, max_live: 8 })).toBe(true)
  })

  test('REVIEW-FAIL: a governor field this build does not know the range of (five_hour 0) keeps the switch ON', () => {
    expect(parsedEnabled({ enabled: true, governor: { five_hour: 0 } })).toBe(true)
  })
})

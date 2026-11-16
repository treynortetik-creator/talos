import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { agentInstructions, INSTRUCTIONS } from '../src/bridge.ts'
import * as moved from '../src/instructions.ts'

// SHA-256 of the text each kind of session receives, taken from the code before the instruction text moved to instructions.ts.
// A change to what the agent is told is deliberate: update the hash with it.
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const APPS = 'APPS TEXT'

describe('what the agent is told', () => {
  const cases: Array<[string, Parameters<typeof agentInstructions>[0], string]> = [
    ['main', { worker: false, trust: false }, '1cd45e5a076477c26b3f7bdf7e969d8c9ed2f208215ce5c50adc81616625e24f'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      '663490a151ac0fcd40849b843f5bce13efce0c8e160beb410b00f8cd7720fa92',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      '61462069776db720308d156dfe5ce8977692487bff731504b668c78668b61051',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      '9145604cd4c4be1c93f357555e209c3e123b5c3af0dc2da5081671db201369bb',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      '7f206eaf236d75eff8d8dea30e8d5b870801a27a723eec52340d33220b3d9049',
    ],
    ['worker', { worker: true, trust: false }, '5199778c1edac8db89f154118fbc708753cff6d9cc963d917b5514a66d326667'],
    [
      'worker, trust and apps (neither reaches it)',
      { worker: true, trust: true, appInstructions: APPS },
      '5199778c1edac8db89f154118fbc708753cff6d9cc963d917b5514a66d326667',
    ],
  ]
  for (const [name, opts, hash] of cases)
    test(`the ${name} text is unchanged`, () => {
      expect(sha(agentInstructions(opts))).toBe(hash)
    })

  test('bridge.ts exports the same text instructions.ts holds', () => {
    expect(INSTRUCTIONS).toBe(moved.INSTRUCTIONS)
    expect(INSTRUCTIONS.length).toBeGreaterThan(0)
  })
})

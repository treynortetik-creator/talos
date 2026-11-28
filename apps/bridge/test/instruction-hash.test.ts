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
    ['main', { worker: false, trust: false }, '247dd8d7b87572e3b2775f2ce1d829e577fd8cd97bed91ab038f7b5c093d2347'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      'be4e21d9736d41575b27945ed3ecfd41f46c883d331eb74f7bb2da9c1ef07d1d',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      'da0f99e1ff0280c9786f14feba457fa0c5a7392176a0d09ca19147b1460cf514',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      'e57115accfa4bb71f8d93ec1afe93a3a22e08a33e4a71671a4a56ac15c84f8c1',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      '5424777e68b7f1a34b9d39f6f131935b6b3e9f095ac1804276859e9810e6220a',
    ],
    ['worker', { worker: true, trust: false }, '0a12afee7c6b0576325e088f86385409dcfd38490241c08b535188926fd350ff'],
    [
      'worker, trust and apps (neither reaches it)',
      { worker: true, trust: true, appInstructions: APPS },
      '0a12afee7c6b0576325e088f86385409dcfd38490241c08b535188926fd350ff',
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

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
    ['main', { worker: false, trust: false }, 'fcbad0ff3579f86e61a9e42cb508a57b2f96d17fe6157776b4845db839090a69'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      '3af2a26e619f018b18e3c548af47c9c2ca089096ab9e29f6fafabda2a7e9136a',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      '260c4edc39cf2fdf51bcbcc6e0fc56d9c6d4ac88c330b72799b71d34a31afe48',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      '3cc04c356b11a2bb80a708b9af6d1a6cbbe460032ff1497bf51f59019d9c72a5',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      'ee78194c090f72b9994a02abbef45b292525c8cd33c477d673204f7f61a4cb7e',
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

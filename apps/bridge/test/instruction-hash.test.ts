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
    ['main', { worker: false, trust: false }, 'aba8aeade9bf2bff9a5e842d95f72bf43c94d04613a998f444a48b2a6c4092c9'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      'edbecb3b539d73906a5578c132ffa795b09f28595fc12715d051f5196be5e634',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      'f909e615c3b1f230de86b5089b06ccfe40132b10f50ac3970a627f00e30dcfcd',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      '279b36243c99292ad98197f9ff45e2f4c1ca58a9bd93d424dd9332db2b8d8e0e',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      '6f9c840efae3adcc3cdfabdc48cbdb3a9cee78819563ad142f260621daddf32e',
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

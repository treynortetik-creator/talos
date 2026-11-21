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
    ['main', { worker: false, trust: false }, '2b4b563f3b4653989262b7bb53c9a67c0f8e01ca2de7b3772d8e41d5cb84381a'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      '07cd2b08585e052c45b1985df8cca21c5bba16e87b707c84f8bd6ca036134233',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      '7ebfe1572626df59efa5367a27d3a5834e83ff059e06fa24107f13f88f7870c4',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      '254031e95b39c9fd9608b6289d33e50f309f7e7de5b0ad36c7caece1374ebbc7',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      'e5bb9539232da2fc38916f89b67e74dc220c49399b3396a03e759364d28653f4',
    ],
    ['worker', { worker: true, trust: false }, '327e21ce266a89fc8f46b864d8b11580413ab517ee38a9b005ba3a1005d522e8'],
    [
      'worker, trust and apps (neither reaches it)',
      { worker: true, trust: true, appInstructions: APPS },
      '327e21ce266a89fc8f46b864d8b11580413ab517ee38a9b005ba3a1005d522e8',
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

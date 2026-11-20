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
    ['main', { worker: false, trust: false }, '7ae82330fdf40f287181b89c096692459e8eb69b1046c91234bca819d8762a36'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      '52d54bdb12a1b1ef0e797b57f6c50cb8516d6d48b6ab193d682ed75d9eb26ecc',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      '80ed7697ab4b5dce4fc29fa5c8b289961391ee25e7627c236712eb553019a332',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      '1aa8976bfb357f20caadcd4d1efcd180ef3c8b460a8463131cafda531f616332',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      '760c8521b0c7da8510219ad43e37d97a3befd84e54271a500d5264c02f7d47b2',
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

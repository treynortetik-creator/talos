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
    ['main', { worker: false, trust: false }, '165529901070cc13b75102e2dcc4a97179fcafe419469c37f544cc5bf6db83e7'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      '4c28752032c696305fdd98a15a87e3bbe052e8d63b2ea34829b0bb839f0ce7c6',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      '273dde2b52a3c7e2aa9c7e39ba4bcf958fb05f411476c845eb9075f9d3f3f969',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      '18508dfb166e87735c7447c3cd2b7b48de4e88e95e14a84178d6c2f1dc5345b4',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      '2063e13942cdbdf9439a007fee788af38c835ee54db086fa1aac87cd1ba5e5c1',
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

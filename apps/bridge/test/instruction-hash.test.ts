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
    ['main', { worker: false, trust: false }, 'a39065621749017afa12cb9d14f302da79563dd5f9d98fa085638fe67a800428'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      '01d331f64cdb233dc61e8810caa3f3102e5996af3a6db300748df494698730b2',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      '8d04f4e65d4a49bd67e0d51a079f447fdf6754db655fdb2972eb740949c902d0',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      'fdf296528ad304a22c11c4b8e6571c78e416886f90620d28a6aff2647dc784f1',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      '512fef9f81f561a4f4f32249a8d0208392d5e5e66bf56f1cde2c2b2d0612646b',
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

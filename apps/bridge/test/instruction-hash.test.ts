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
    ['main', { worker: false, trust: false }, '59f10b357bcc45d08370ee45983cc410a1ced2a9a11b549319a755f55d245873'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      '0365189a9aeae1abed954f1690a73eae474ea9817c048cccd302a90b11bf794f',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      '8d69853779a011cdeaeb7e31d331469ca3951c3066b81c439cb6a76c8db559ed',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      'f5b4193cf19b048ecd1541466cd9819930875752f295f99d53c53a11f455d62f',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      '42d40328e6e19d4f4fbf62cb8cd5462eb4767398a69debb1a5369a7683a00c3d',
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

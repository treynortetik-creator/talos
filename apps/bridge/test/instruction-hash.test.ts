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
    ['main', { worker: false, trust: false }, '12bab80d72a4159d9f78e61f6fb8632d55156b6614a78bd69717ec86cb32ef41'],
    [
      'main with apps',
      { worker: false, trust: false, appInstructions: APPS },
      '255017e071a3c2002c5425edeee132a258d4285bba90bd2e90d5ae84d420af54',
    ],
    [
      'main with trust',
      { worker: false, trust: true },
      '5117575d615e54ee5636efe985a80beeeef863b0206ee9328bf12187d7a223ce',
    ],
    [
      'main with trust and apps',
      { worker: false, trust: true, appInstructions: APPS },
      '5de414b5501882e7fa6eb3bc36c8bfccd1aa51c63174f44419c4121a96b090f1',
    ],
    [
      'main with the self-map',
      {
        worker: false,
        trust: false,
        self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' },
      },
      '09ed42965abf9a2146f1870182ca03e3bbb881d574872066ebdcc25eb70b1a85',
    ],
    ['worker', { worker: true, trust: false }, '2c69923b500574c07236f568d5c6cf7b058e2db0f25d78c05b00cf82a4321d64'],
    [
      'worker, trust and apps (neither reaches it)',
      { worker: true, trust: true, appInstructions: APPS },
      '2c69923b500574c07236f568d5c6cf7b058e2db0f25d78c05b00cf82a4321d64',
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

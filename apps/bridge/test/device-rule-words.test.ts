// The rule about devices and security settings, as the agent is told it: it names the exceptions the code really has, and
// the things it says stay with the owner really are kept from the agent. A wording fix: nothing here may allow more.
import { describe, expect, test } from 'bun:test'
import { DEVICE_EXCEPTIONS, INSTRUCTIONS } from '../src/instructions.ts'
import { agentUnlessLocked, terminalOnly } from '../src/talos.ts'

describe('the devices rule names its exceptions', () => {
  test('the main instructions keep the rule and then carry the exceptions', () => {
    expect(INSTRUCTIONS).toContain(
      `Never change devices, keys, enrollment or security settings, whoever asks, and never edit config files yourself. ${DEVICE_EXCEPTIONS}`,
    )
  })

  test('every command the exceptions let the agent run is one the code lets it run (unless locked)', () => {
    for (const argv of [
      ['devices', 'list'],
      ['devices', 'revoke', 'x'],
      ['peer', 'link', 'x'],
      ['relay', 'update'],
      ['sandbox', 'on'],
      ['sandbox', 'off'],
    ])
      expect(agentUnlessLocked(argv)).toBeDefined()
  })

  test('what the exceptions keep for the owner is still kept from the agent', () => {
    for (const argv of [['enroll'], ['rotate'], ['trust', 'on'], ['install-guards', '--remove']]) {
      expect(agentUnlessLocked(argv)).toBeUndefined()
      expect(terminalOnly(argv)).toBeDefined()
    }
  })
})

// Where a needs-you step is done, in the platform's words (router/status-line.ts ownerPlace): the Mac's own sentences on a Mac,
// this computer's name elsewhere, and the phone's status carries the one that fits (Pantheon 2026-11-14).
import { describe, expect, it } from 'bun:test'
import { hostname } from 'node:os'
import { NEEDS_YOU_MAC_PLACE, NEEDS_YOU_USAGE_LIMIT } from '@talos-app/protocol'
import { machineName } from '../src/owner-words.ts'
import { ownerPlace, statusNeedsYou } from '../src/router/status-line.ts'

describe('ownerPlace and the phone’s step', () => {
  it('the Mac’s place on a Mac, the computer’s own name elsewhere, and this platform’s by default', () => {
    expect(ownerPlace('mac', 'box')).toBe(NEEDS_YOU_MAC_PLACE)
    expect(ownerPlace('linux', 'box')).toBe('on box')
    expect(ownerPlace('windows', 'box')).toBe('on the PC')
    // the tests' computer is the Mac (preload); the product's is this one (platform.ts)
    expect(ownerPlace()).toBe('at the Mac')
    expect(ownerPlace('linux')).toBe(`on ${machineName(hostname())}`)
  })
  it('the step the phone is sent names the place given, and only the Mac’s on a Mac', () => {
    const n = { kind: NEEDS_YOU_USAGE_LIMIT, since: '2026-11-14T10:00:00.000Z' }
    expect(statusNeedsYou(n, ownerPlace('linux', 'box')).step).toBe(
      'press Esc in its pane on box, then /model <another model> (Talos presses nothing there: one option spends usage credits)',
    )
    expect(statusNeedsYou(n, ownerPlace('mac')).step).toBe(
      'press Esc in its pane at the Mac, then /model <another model> (Talos presses nothing there: one option spends usage credits)',
    )
    // no step for a kind that has none, wherever it runs
    expect(statusNeedsYou({ ...n, kind: 'trust this folder' }, 'on box').step).toBeUndefined()
  })
})

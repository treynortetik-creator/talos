// A git push to main is its own kind ("push"); an older grant for "deploy" still covers it (owner 2026-11-15: always-allowed
// pushes were buzzing his phone as "deploys"). The list check lives here so the bridge and the apps read one rule.
import { describe, expect, it } from 'vitest'
import { alwaysAllowed, isSendKind } from '../src/index.ts'

const grant = (...kinds: string[]) => kinds.map((kind) => ({ kind, destination: null })) as never

describe('always allowed: push and deploy', () => {
  it('push is a send kind', () => expect(isSendKind('push')).toBe(true))
  it('a deploy grant also covers push', () => {
    expect(alwaysAllowed(grant('deploy'), 'push')).toBe(true)
    expect(alwaysAllowed(grant('deploy'), 'deploy')).toBe(true)
  })
  it('a push grant covers push only, never deploy', () => {
    expect(alwaysAllowed(grant('push'), 'push')).toBe(true)
    expect(alwaysAllowed(grant('push'), 'deploy')).toBe(false)
  })
  it('neither grant: a card for both', () => {
    expect(alwaysAllowed(grant('email', 'publish'), 'push')).toBe(false)
    expect(alwaysAllowed(undefined, 'push')).toBe(false)
    expect(alwaysAllowed([], 'deploy')).toBe(false)
  })
  it('a grant with a destination (a narrower scope) never counts for the broader kind', () => {
    expect(alwaysAllowed([{ kind: 'deploy', destination: 'x' }] as never, 'push')).toBe(false)
  })
})

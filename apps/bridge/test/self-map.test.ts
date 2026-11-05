import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { agentInstructions, selfMapBlock, WORKER_INSTRUCTIONS } from '../src/instructions.ts'

const self = { bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: '9f8e7d6' }

describe('the self-map in the agent instructions', () => {
  test('names the live bridge path, its commit, the relay version and how a change ships', () => {
    const t = selfMapBlock(self)
    expect(t).toContain('/home/alex/talos-app')
    expect(t).toContain('abc1234')
    expect(t).toContain('9f8e7d6')
    expect(t).toContain('Railway deploy')
    expect(t).toContain('next launch')
    expect(t).toContain('rebuild and install')
    expect(t).toContain('session restart')
    expect(t.split('\n').length).toBeLessThanOrEqual(5)
  })

  test('an unknown commit or relay version is left out, never printed as undefined', () => {
    for (const s of [
      { bridgeDir: '/home/alex/talos-app', commit: undefined, relayVersion: undefined },
      { bridgeDir: '/home/alex/talos-app', commit: '', relayVersion: '  ' },
    ]) {
      const t = selfMapBlock(s)
      expect(t).not.toMatch(/undefined|null|\(\)/)
      expect(t).not.toContain('commit')
      expect(t).not.toContain('Relay version')
      expect(t).toContain('/home/alex/talos-app')
    }
    const t = selfMapBlock({ bridgeDir: '/home/alex/talos-app', commit: 'abc1234', relayVersion: undefined })
    expect(t).toContain('abc1234')
    expect(t).not.toContain('Relay version')
  })

  test('the path under the real home folder is shown home-relative', () => {
    const t = selfMapBlock({ bridgeDir: `${homedir()}/code/talos-app`, commit: 'abc1234', relayVersion: undefined })
    expect(t).toContain('~/code/talos-app')
    expect(t).not.toContain(homedir())
  })

  test('the main text carries it, a worker does not, and the same input gives the same text', () => {
    const main = agentInstructions({ worker: false, trust: false, self })
    expect(main).toContain(selfMapBlock(self))
    expect(agentInstructions({ worker: false, trust: false, self })).toBe(main)
    expect(agentInstructions({ worker: false, trust: false })).not.toContain('Railway')
    expect(agentInstructions({ worker: true, trust: false, self })).toBe(WORKER_INSTRUCTIONS)
  })
})

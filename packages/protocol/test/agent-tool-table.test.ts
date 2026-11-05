// The table of agent tools: what its type refuses and what its rows derive.
import { describe, expect, it } from 'vitest'
import { AGENT_TOOLS, type AgentToolRow, HEADLESS_BRIDGE_TOOLS, READ_THREAD_TOOLS } from '../src/index.ts'

describe('the agent tool table', () => {
  it('does not allow a tool that posts into a thread to go to workers unlocked', () => {
    // @ts-expect-error a worker tool that posts into a thread must be locked to the worker's own
    const unlocked: AgentToolRow = { group: 'core', headless: false, worker: true, locked: false, thread: 'post' }
    expect(unlocked.worker).toBe(true)
  })

  it('derives the headless list from the rows', () => {
    expect(HEADLESS_BRIDGE_TOOLS.every((n) => AGENT_TOOLS[n].headless)).toBe(true)
  })

  it('keeps instruction text out of the table, which the web client bundles', () => {
    for (const row of Object.values(AGENT_TOOLS)) expect(Object.keys(row).sort()).not.toContain('instructions')
  })

  it('lets only the listed tools be labelled as reading a thread', () => {
    for (const [n, row] of Object.entries(AGENT_TOOLS))
      if ('thread' in row && row.thread === 'read') expect(READ_THREAD_TOOLS as readonly string[]).toContain(n)
  })
})

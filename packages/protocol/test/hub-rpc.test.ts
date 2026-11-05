// The hub socket's schedule request (docs/OPTION-C.md "Thread schedules"): one unknown tool is one refused answer, not a
// line the hub cannot read.
import { describe, expect, it } from 'vitest'
import { HUB_MAX_LINE_BYTES, HUB_RPC_MAX_TEXT, HUB_RPC_TOOLS, HubHubLine, HubWorkerLine } from '../src/index.ts'

describe('hub rpc lines', () => {
  it('a request for each known tool, and for a tool from a newer worker, parses', () => {
    for (const tool of [...HUB_RPC_TOOLS, 'schedule_something_newer'])
      expect(HubWorkerLine.safeParse({ t: 'rpc', id: 'rpc_1', tool, args: { a: 1 } }).success, tool).toBe(true)
  })
  it('a request carries no thread: a worker cannot name one', () => {
    expect(
      HubWorkerLine.safeParse({ t: 'rpc', id: 'x', tool: 'schedules_list', args: {}, thread_id: 'garden' }).success,
    ).toBe(false)
  })
  it('a request with no id, a long tool name or non-object args is refused', () => {
    for (const bad of [
      { t: 'rpc', tool: 'schedules_list', args: {} },
      { t: 'rpc', id: 'x', tool: 'x'.repeat(41), args: {} },
      { t: 'rpc', id: 'x', tool: 'schedules_list', args: 'no' },
    ])
      expect(HubWorkerLine.safeParse(bad).success).toBe(false)
  })
  it('the answer carries ok and text, and its text fits the hub line', () => {
    expect(HubHubLine.safeParse({ t: 'rpc_result', id: 'rpc_1', ok: true, text: 'GO' }).success).toBe(true)
    expect(
      HubHubLine.safeParse({ t: 'rpc_result', id: 'rpc_1', ok: false, text: 'x'.repeat(HUB_RPC_MAX_TEXT + 1) }).success,
    ).toBe(false)
    expect(HUB_RPC_MAX_TEXT).toBeLessThan(HUB_MAX_LINE_BYTES)
  })
})

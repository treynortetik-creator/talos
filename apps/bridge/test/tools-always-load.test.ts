// Claude Code loads an MCP tool up front, with no ToolSearch first, when its definition carries
// `_meta: { 'anthropic/alwaysLoad': true }`. Exactly three tools carry it: each one costs context in every session.
import { describe, expect, test } from 'bun:test'
import { listedTools } from '../src/tools/common.ts'
import { toolsFor } from '../src/tools/index.ts'

const UP_FRONT = ['card', 'read_inbound', 'reply']
const SHAPES = [
  { scheduler: 'on', apps: false },
  { scheduler: 'off', apps: false },
  { scheduler: 'on', apps: true },
  { scheduler: 'off', apps: true },
  { scheduler: 'on', workerThread: 't_one' },
  { scheduler: 'off', workerThread: 't_one' },
]

describe('tools/list marks card, reply and read_inbound as always loaded', () => {
  for (const env of SHAPES) {
    test(JSON.stringify(env), () => {
      const listed = listedTools(toolsFor(env))
      const marked = listed.filter((t) => t._meta !== undefined)
      for (const t of marked) expect(t._meta).toEqual({ 'anthropic/alwaysLoad': true })
      const names = marked.map((t) => t.name).sort()
      const present = UP_FRONT.filter((n) => listed.some((t) => t.name === n))
      expect(names).toEqual(present)
      // the main session lists reply and card; a worker lists all three
      if (!env.workerThread) expect(names).toEqual(['card', 'reply'])
      else expect(names).toEqual(UP_FRONT)
    })
  }

  test('every other tool has no _meta key at all, and the old three keys are unchanged', () => {
    for (const t of listedTools(toolsFor({ scheduler: 'on', apps: true }))) {
      if (UP_FRONT.includes(t.name)) continue
      expect('_meta' in t).toBe(false)
      expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name'])
    }
  })
})

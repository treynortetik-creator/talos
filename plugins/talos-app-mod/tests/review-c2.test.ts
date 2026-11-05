// Review C2 (adversarial): guard regressions the builder's suite did not pin. Both pass on feat/cc-c2.
// The `$.mcp.call` bypass (another plugin calling the bridge directly) cannot be raised from here: a test's `$` carries
// engine events only, no op nouns (`$.mcp` is undefined in the kit), so its red test is a validate check in
// apps/bridge/test/review-c2.test.ts.
import { expect, mock, test } from 'claude-code/testing'

const HELLO = 'mcp__talos-app__talos_mod_hello' as const
const SYNC = 'mcp__talos-app__talos_mod_sync' as const
const KEY = 'k'.repeat(43)

test('the model on the main loop (a real call, tool_use_id set) is denied on both tools', async ($, on) => {
  let ran = 0
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => {
    ran++
    return { result: { mod_key: KEY } }
  })
  for (const tool of [HELLO, SYNC] as const) {
    const call = await $.tool.call({ tool, tool_use_id: `toolu_${tool.length}` })
    expect(JSON.stringify(call)).not.toContain(KEY)
  }
  expect(ran).toBe(0)
})

test('the guard stays on when the mod is idle (Claude Code too old)', async ($, on) => {
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({ value: [] }))
  on('command.list', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 's' }))
  on('session.version', () => ({ value: { version: '2.1.100' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1 }, rateLimits: [] } }))
  on('tool.check', () => ({ decision: 'allow' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const check = await $.tool.check({ tool: HELLO, input: {} })
  expect(check.decision).toBe('deny')
})

// Regression test for the mod end of the Claude Code session controls; it names the bug it guards.
import { expect, test } from 'claude-code/testing'
import { ControlRunner } from '../hooks/lib/controls.ts'
import type { EngineLike } from '../hooks/lib/engine.ts'
import { EventQueue, SessionFlags } from '../hooks/lib/events.ts'
import type { ControlResult } from '../hooks/lib/link.ts'

const ID = '01JBF3V7Q8K2M4N6P8R0S2T4R2'
const until = async (done: () => boolean, ms = 3000) => {
  for (let waited = 0; !done() && waited < ms; waited += 5) await new Promise((r) => setTimeout(r, 5))
}

// R2. The engine d.ts lists what makes `$.command.run` REJECT: "an unknown name, inside a hook the turn waits on, past
// a Stop or a host's limit". A PreModelSwitch deny is not on that list: `/model` prints its refusal and the run
// resolves. The same goes for a warm-cache confirmation the person cancels at the Mac. controls.ts treats any
// resolve as success ("Switched.", with the comment "PostModelSwitch already pushed model_switched"), but nothing checks
// that a PostModelSwitch came. Spec C4.4 steps 3-4: success is the PostModelSwitch (or the model in state); a hook deny
// is model_switch_denied with its reason; no confirmation in 15 s is model_switch_pending.
test('a /model that resolves with a refusal and no PostModelSwitch is not reported as Switched', async () => {
  const engine = {
    plugin: { name: 'talos-app-mod' },
    clock: { now: async () => 1_000_000, every: () => undefined, after: () => undefined },
    command: {
      list: async () => [{ name: 'model', source: 'builtin', description: '' }],
      run: async () => ({ text: 'Model switch blocked by a PreModelSwitch hook: stay on opus' }),
    },
    turn: { abort: async () => undefined },
    session: { compact: async () => ({}) },
  } as unknown as EngineLike
  const late: ControlResult[] = []
  const events = new EventQueue(() => 0)
  const runner = new ControlRunner(engine, new SessionFlags(events), events, new Set(['model']), (r) => late.push(r))
  await runner.handle([
    {
      control_id: ID,
      action: 'command',
      command: 'model',
      source: 'builtin',
      args: 'sonnet',
      model_ticket: { to_model: 'sonnet', expires_at: new Date(1_005_000).toISOString() },
    },
  ])
  await until(() => late.length > 0)
  expect(late[0]?.ok).toBe(false)
})

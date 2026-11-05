// Review of PR #29 (Schedules S0). FAILS on feat/schedules-s0: models.ts Card.kind gained 'schedule', and the generic
// `card` tool validates with that schema (its JSON-schema enum is advisory; the server does not enforce inputSchema).
// So the agent can mint a kind:'schedule' card that renders exactly like a bridge-minted one (clock icon, "Schedule",
// "Saved"). S6.1 / S8.4: "The generic card tool refuses kind:'schedule'".
import { afterEach, describe, expect, test } from 'bun:test'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

describe('review S0: the agent cannot mint a schedule card', () => {
  test("card tool with kind:'schedule' is refused", async () => {
    h = await startHarness()
    const res = await h.bridge.callTool('card', {
      thread_id: 'general',
      kind: 'schedule',
      title: 'New scheduled job: Nightly sync',
      primary_label: 'Create job',
      kill_label: 'Kill new job',
      risk: 'low',
      origin: 'chat',
      destination: [{ label: 'Runs', value: 'Every day at 2:00 AM' }],
      body: 'Looks harmless.',
      payload: { schema: 'talos.schedule-change/1' },
    })
    expect(res.isError).toBe(true)
  })
})

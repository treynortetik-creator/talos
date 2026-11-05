// FakeScheduler must pass the same adapter contract the real Chronos adapter passes (WP-S1 runs it against the vendored
// CLI). If the fake and the real one disagree, one of these cases fails on one side.
import { ChronosSnapshot, ScheduleSnapshot } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { loadChronosGolden } from '../src/chronos-goldens.ts'
import { defineSchedulerAdapterContract } from '../src/contract/scheduler.ts'
import { FakeScheduler } from '../src/fake-scheduler.ts'

defineSchedulerAdapterContract('FakeScheduler', {
  async start(o) {
    const s = new FakeScheduler({
      tz: o.tz,
      now: o.now,
      sessionRunner: o.sessionRunner ?? 'talos',
      approvalRequired: o.approvalRequired ?? true,
    })
    return {
      adapter: s,
      setNow: (iso) => s.setNow(iso),
      editPromptOutside: (id, prompt) => s.editPromptOutside(id, prompt),
      stop: async () => {},
    }
  },
})

describe('FakeScheduler seeded from the real goldens', () => {
  it('reproduces the three-job golden snapshot shape', async () => {
    const golden = ChronosSnapshot.parse(loadChronosGolden('snapshot-three-jobs'))
    const s = FakeScheduler.fromChronosSnapshot(golden)
    const snap = await s.snapshot()
    expect(ScheduleSnapshot.safeParse(snap).success).toBe(true)
    expect(snap.health.tz).toBe(golden.tz)
    expect(snap.schedules.map((x) => x.id)).toEqual(golden.schedules.map((x) => x.id))
    for (const j of golden.schedules) {
      if ('error' in j) continue
      const mine = snap.schedules.find((x) => x.id === j.id)
      expect(mine?.when_text, j.id).toBe(j.when_text)
      expect(mine?.runner, j.id).toBe(j.runner)
      expect(mine?.today, j.id).toBe(j.today)
      expect(mine?.next_run, j.id).toBe(j.next_run)
      expect(mine?.window_ends, j.id).toBe(j.window_ends)
    }
  })
})

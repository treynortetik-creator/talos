// The adapter contract against the REAL Chronos CLI (third_party/chronos, tag v0.3.0), in a temp HOME with a fixed
// CHRONOS_NOW. FakeScheduler runs the same assertions in fake-scheduler.test.ts. Needs python3 >= 3.9; without it the
// suite is skipped (CI has it). Set TALOS_SKIP_REAL_CHRONOS=1 to skip on purpose.
import { describe, it } from 'vitest'
import { ChronosCliAdapter, hasPython3 } from '../src/chronos-cli-adapter.ts'
import { defineSchedulerAdapterContract } from '../src/contract/scheduler.ts'

const run = process.env.TALOS_SKIP_REAL_CHRONOS !== '1' && hasPython3()

if (run) {
  defineSchedulerAdapterContract(
    'real Chronos CLI (vendored)',
    {
      async start(o) {
        const a = new ChronosCliAdapter({ tz: o.tz, now: o.now })
        a.configure({ sessionRunner: o.sessionRunner ?? 'talos', approvalRequired: o.approvalRequired ?? true })
        return {
          adapter: a,
          setNow: (iso) => a.setNow(iso),
          editPromptOutside: (id, prompt) => a.editPromptOutside(id, prompt),
          stop: async () => a.dispose(),
        }
      },
    },
    { timeoutMs: 60_000 },
  )
} else {
  describe.skip('scheduler adapter contract: real Chronos CLI (python3 >= 3.9 not found or TALOS_SKIP_REAL_CHRONOS=1)', () => {
    it('skipped', () => {})
  })
}

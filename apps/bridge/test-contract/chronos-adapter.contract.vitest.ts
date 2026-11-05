// defineSchedulerAdapterContract against the PRODUCTION Chronos adapter (apps/bridge/src/schedules/chronos-adapter.ts)
// driving the real vendored Chronos CLI (third_party/chronos, v0.4.0) in a temp HOME. The same assertions run against
// FakeScheduler and the testkit's thin ChronosCliAdapter; this is the one the bridge ships (docs/SCHEDULES.md S9, WP-S1).
import { defineSchedulerAdapterContract } from '@talos-app/testkit'
import { describe, it } from 'vitest'
import { ChronosAdapter } from '../src/schedules/chronos-adapter.ts'
import { ChronosBox } from '../test/schedules/chronos-box.ts'

const hasPython = (() => {
  try {
    return new ChronosBox('2026-10-05T11:00:00Z').cli(['--version']).out.startsWith('chronos')
  } catch {
    return false
  }
})()

if (hasPython && process.env.TALOS_SKIP_REAL_CHRONOS !== '1') {
  defineSchedulerAdapterContract(
    'production ChronosAdapter (vendored Chronos v0.4.0)',
    {
      async start(o) {
        const box = new ChronosBox(o.now, o.tz)
        box.configure({ sessionRunner: o.sessionRunner ?? 'talos', approvalRequired: o.approvalRequired ?? true })
        let now = o.now
        const adapter = new ChronosAdapter({
          bin: box.bin,
          timeoutMs: 30_000,
          chronosNow: () => now,
          hostLabel: 'Example Mac',
        })
        return {
          adapter,
          setNow: (iso) => {
            now = iso
            adapter.invalidate()
          },
          editPromptOutside: (id, prompt) => {
            box.editPromptOutside(id, prompt)
            adapter.invalidate()
          },
          stop: async () => box.dispose(),
        }
      },
    },
    { timeoutMs: 60_000 },
  )
} else {
  describe.skip('production ChronosAdapter contract (python3 not found or TALOS_SKIP_REAL_CHRONOS=1)', () => {
    it('skipped', () => {})
  })
}

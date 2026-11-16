// defineSchedulerAdapterContract against the PRODUCTION Chronos adapter (apps/bridge/src/schedules/chronos-adapter.ts)
// driving the real vendored Chronos CLI (third_party/chronos, v0.5.0) in a temp HOME. The same assertions run against
// FakeScheduler and the testkit's thin ChronosCliAdapter; this is the one the bridge ships (docs/SCHEDULES.md S9, WP-S1).
import { defineSchedulerAdapterContract } from '@talos-app/testkit'
import { describe, expect, it } from 'vitest'
import { ChronosAdapter } from '../src/schedules/chronos-adapter.ts'
import { ChronosBox, draft } from '../test/schedules/chronos-box.ts'

const hasPython = (() => {
  try {
    return new ChronosBox('2026-10-05T11:00:00Z').cli(['--version']).out.startsWith('chronos')
  } catch {
    return false
  }
})()

if (hasPython && process.env.TALOS_SKIP_REAL_CHRONOS !== '1') {
  defineSchedulerAdapterContract(
    'production ChronosAdapter (vendored Chronos v0.5.0)',
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
          // the contract's expectations are a Mac's (background and restricted jobs run there); off a Mac they are refused,
          // which the case below checks
          ownerHost: 'mac',
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

  describe('production ChronosAdapter off a Mac (no background timer there yet)', () => {
    it.each(['linux', 'windows'] as const)(
      'on %s, validate refuses a background job and a restricted one',
      async (host) => {
        const box = new ChronosBox('2026-10-05T11:00:00Z')
        try {
          box.configure({ sessionRunner: 'talos', approvalRequired: true })
          const adapter = new ChronosAdapter({ bin: box.bin, timeoutMs: 30_000, ownerHost: host })
          for (const over of [{ runner: 'headless' }, { runner: 'session', permissions: 'restricted' }] as const) {
            const v = await adapter.validate({ op: 'create', draft: draft(over) } as never)
            expect(v.ok, JSON.stringify(over)).toBe(false)
          }
          const ok = await adapter.validate({
            op: 'create',
            draft: draft({ runner: 'session', permissions: 'full' }),
          } as never)
          expect(ok.ok).toBe(true)
        } finally {
          box.dispose()
        }
      },
    )
  })
} else {
  describe.skip('production ChronosAdapter contract (python3 not found or TALOS_SKIP_REAL_CHRONOS=1)', () => {
    it('skipped', () => {})
  })
}

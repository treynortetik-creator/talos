// A valid `GET /api/status` body (packages/protocol/src/health.ts HealthStatus) for the Health specs, with overrides.
import type { HealthStatusT } from '@talos-app/protocol'

export const AT = '2026-10-29T20:00:00.000Z'

export function statusOf(over: Partial<HealthStatusT> = {}): HealthStatusT {
  return {
    at: AT,
    relay_ok: true,
    relay_problems: [],
    relay: { version: '0.4.1', up_since: '2026-10-29T14:02:00.000Z' },
    mac_problems: [],
    bridge: { online: true, last_seen: AT, down_since: null },
    mod: { state: 'alive', last_seen: '2026-10-29T19:59:57.000Z', expected: true },
    push: { subscriptions: 1, last_ok_at: '2026-10-29T18:00:00.000Z', last_error_at: null },
    ntfy: false,
    beat: { mod: { state: 'alive', last_seen: AT, expected: true }, tts: true, stt: true, sqlite: { fts5: true } },
    ...over,
  }
}

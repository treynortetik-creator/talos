// TALOS_APP_SCHEDULE_RUNNER_S / _REFRESH_S: the browser suite's real bridge runs the schedule loops faster (e2e
// harness/schedules.ts). Never slower than the defaults (60 s and 30 s), never under 5 s, and junk falls back to the default.
import { describe, expect, test } from 'bun:test'
import { loadEnv } from '../src/config.ts'
import { tempHome } from './helpers.ts'

const env = (extra: Record<string, string> = {}) => loadEnv({ TALOS_APP_HOME: tempHome('talos-env-'), ...extra })

describe('schedule loop intervals', () => {
  test('default: the runner every 60 s, the refresh every 30 s', () => {
    expect(env()).toMatchObject({ scheduleRunnerMs: 60_000, scheduleRefreshMs: 30_000 })
  })

  test('a test can make them faster', () => {
    const e = env({ TALOS_APP_SCHEDULE_RUNNER_S: '5', TALOS_APP_SCHEDULE_REFRESH_S: '7' })
    expect(e).toMatchObject({ scheduleRunnerMs: 5000, scheduleRefreshMs: 7000 })
  })

  test('never under 5 s, never slower than the default, and junk is the default', () => {
    expect(env({ TALOS_APP_SCHEDULE_RUNNER_S: '0.1', TALOS_APP_SCHEDULE_REFRESH_S: '1' })).toMatchObject({
      scheduleRunnerMs: 5000,
      scheduleRefreshMs: 5000,
    })
    expect(env({ TALOS_APP_SCHEDULE_RUNNER_S: '600', TALOS_APP_SCHEDULE_REFRESH_S: '3600' })).toMatchObject({
      scheduleRunnerMs: 60_000,
      scheduleRefreshMs: 30_000,
    })
    expect(env({ TALOS_APP_SCHEDULE_RUNNER_S: 'soon', TALOS_APP_SCHEDULE_REFRESH_S: '-4' })).toMatchObject({
      scheduleRunnerMs: 60_000,
      scheduleRefreshMs: 30_000,
    })
  })
})

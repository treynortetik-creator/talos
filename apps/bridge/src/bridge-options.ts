// Test seams and wiring options for the Bridge. Moved out of bridge.ts unchanged; bridge.ts re-exports the type.
import type { AppServiceDeps } from './apps/service.ts'
import type { Clock } from './clock.ts'
import type { BridgeEnv } from './config.ts'
import type { InboundOptions } from './inbound.ts'
import type { Logger } from './log.ts'
import type { FetchFn } from './relay-http.ts'
import type { SpeakOptions } from './speak/service.ts'

export type BridgeOptions = {
  env: BridgeEnv
  clock?: Clock
  fetchFn?: FetchFn
  random?: () => number
  inbound?: InboundOptions
  /** Pass `true` to force headless regardless of env.live (CLI uses it). */
  headless?: boolean
  logger?: Logger
  /** This process's instance id (the pid file's); Chronos stores it in every session claim (N11). Default: random. */
  instance?: string
  /** TEST BUILDS: Chronos's clock (CHRONOS_NOW), e.g. the injected clock's now(). Production uses TALOS_APP_CHRONOS_NOW only in tests. */
  chronosNow?: () => string | undefined
  /** Default true. The capture step turns fs.watch off so its output is deterministic. */
  scheduleWatch?: boolean
  /** MCP apps test seam: Keychain runner, direct connector, switch, tick. Production passes nothing. */
  apps?: Partial<AppServiceDeps>
  /** Tests: swap the read-aloud synthesis or its timing. */
  speak?: SpeakOptions
  /** Test seam (O6): the relay-silence watch's tick, threshold and fetch. Production passes nothing. */
  relaySilence?: { tickMs?: number; silenceMs?: number; fetchFn?: typeof fetch }
  /** Test seam: how long discovery waits for `chronos api version` (ms). */
  discoveryTimeoutMs?: number
  /** Test seams for the heartbeat runner (wake, work gate, time scale, crash hooks, the `gh` path). Production passes nothing. */
  heartbeat?: import('./heartbeat/runner.ts').HeartbeatSeams
  /** Test seam: wraps the scheduler adapter the service discovered. */
  wrapSchedulerAdapter?: (
    a: import('./schedules/adapter.ts').SchedulerAdapter,
  ) => import('./schedules/adapter.ts').SchedulerAdapter
  /** Test seam: the shared-files poll interval in ms (default 10 s). */
  pollMs?: number
  /** Called once per process, the first time the relay says `ready`: this start is healthy (server.ts records the version for `talos-app rollback`). */
  onHealthyStart?: () => void
}

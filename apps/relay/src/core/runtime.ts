// Wires the core pieces into a RelayServices. `createRelayServices` is what index.ts and the tests call; modules reach the
// core's internals (store, hub, media) through `runtimeOf(services)`.
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { RelayEnv } from '../env.ts'
import type { Clock, CryptoService, Logger, PushTransport, RelayServices } from '../services.ts'
import { createNtfySink } from './alerts-ntfy.ts'
import { CardReminder } from './card-reminder.ts'
import { createCryptoService } from './crypto.ts'
import { openDatabase } from './db.ts'
import { HealthWatch } from './health.ts'
import { Hub } from './hub.ts'
import { createLogger } from './log.ts'
import { FileMediaStore } from './media.ts'
import { CorePush, createWebPushTransport, NoopTransport } from './push.ts'
import { type ApnsSender, apnsConfigFromEnv, createApnsSender } from './push-apns.ts'
import { QuietSummary } from './quiet-summary.ts'
import { Store } from './store.ts'

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms)
    h.unref?.()
    return h
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export type CoreRuntime = {
  store: Store
  hub: Hub
  media: FileMediaStore
  push: CorePush
  health: HealthWatch
  transport: PushTransport
  webDir: string | null
  dataDir: string
  start(): void
  stop(): void
  /** A module's own timer or listener: `stop()` calls it, so nothing fires on a closed database afterwards. */
  onStop(fn: () => void): void
}

const runtimes = new WeakMap<RelayServices, CoreRuntime>()

/** The runtime for services built by `createRelayServices`, or undefined for the fakes unit tests use. */
export function findRuntime(services: RelayServices): CoreRuntime | undefined {
  return runtimes.get(services)
}

export function runtimeOf(services: RelayServices): CoreRuntime {
  const r = runtimes.get(services)
  if (!r) throw new Error('core runtime missing: build services with createRelayServices()')
  return r
}

export type CreateOptions = {
  env: RelayEnv
  clock?: Clock
  log?: Logger
  /** Replace the push transport (tests pass a recording one). Default: Web Push when VAPID keys are set, else a no-op. */
  transport?: PushTransport
  /** Built web app to serve (index.html, assets, sw.js). Without it only the API is served. */
  webDir?: string
  db?: Database.Database
  /** The fetch the optional ntfy topic uses (tests point it at a local sink; the env only allows https URLs). */
  ntfyFetch?: typeof fetch
  /** Tests: where the APNs sender connects (a local HTTP/2 fake). Default: Apple's hosts, chosen per device. */
  apnsAuthority?: (env: 'sandbox' | 'production') => string
  /** Tests: replace the APNs sender outright (null = off even if the env is set). */
  apns?: ApnsSender | null
}

const SWEEP_MS = 3_600_000

export function createRelayServices(opts: CreateOptions): RelayServices {
  const { env } = opts
  const clock = opts.clock ?? systemClock
  const log = opts.log ?? createLogger(env.LOG_LEVEL)
  const db = opts.db ?? openDatabase(env.DATA_DIR)
  const crypto = createCryptoService(env.DATA_KEY)
  const store = new Store(db, crypto, clock)
  try {
    checkDataKey(store, crypto)
  } catch (e) {
    if (!opts.db) db.close()
    throw e
  }
  const media = new FileMediaStore(env.DATA_DIR, store, crypto, clock)
  const transport: PushTransport =
    opts.transport ??
    (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
      ? createWebPushTransport({
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT,
        })
      : new NoopTransport())
  const apnsConfig = opts.apns === undefined ? apnsConfigFromEnv(env, log.child({ mod: 'apns' })) : null
  const apns: ApnsSender | null =
    opts.apns !== undefined
      ? opts.apns
      : apnsConfig
        ? createApnsSender({
            config: apnsConfig,
            clock,
            log: log.child({ mod: 'apns' }),
            ...(opts.apnsAuthority ? { authority: opts.apnsAuthority } : {}),
          })
        : null
  let hub!: Hub
  const push = new CorePush({
    apns,
    store,
    clock,
    log: log.child({ mod: 'push' }),
    transport,
    config: () => hub.agentConfig(),
    anyVisible: () => hub.anyVisible(),
    ntfy: env.ALERT_NTFY_URL
      ? createNtfySink({
          url: env.ALERT_NTFY_URL,
          token: env.ALERT_NTFY_TOKEN,
          log: log.child({ mod: 'ntfy' }),
          ...(opts.ntfyFetch ? { fetch: opts.ntfyFetch } : {}),
        })
      : null,
  })
  hub = new Hub({ store, clock, log: log.child({ mod: 'hub' }), env, push, media })

  const health = new HealthWatch({
    store,
    clock,
    log: log.child({ mod: 'health' }),
    env,
    bus: hub,
    push,
    config: () => hub.agentConfig(),
    storageBytes: () => store.totalMediaBytes() + fileSize(join(env.DATA_DIR, 'relay.sqlite')),
  })

  // Never-miss timers (owner calls O2, O7). They use the injected clock and are stopped by `stop()` below, so nothing
  // fires on a closed database. Neither touches the hub: they read the store and push through `CorePush`.
  const cardReminder = new CardReminder({
    store,
    clock,
    log: log.child({ mod: 'card-reminder' }),
    push,
    config: () => hub.agentConfig(),
  })
  const quietSummary = new QuietSummary({
    store,
    clock,
    log: log.child({ mod: 'quiet-summary' }),
    push,
    config: () => hub.agentConfig(),
  })

  const stoppers: Array<() => void> = []
  let sweepTimer: unknown = null
  let stopped = false
  const armSweep = () => {
    if (stopped) return
    sweepTimer = clock.setTimeout(() => {
      runSweep()
      armSweep()
    }, SWEEP_MS)
  }
  let lastCapWarn = 0
  const runSweep = () => {
    try {
      hub.sweep()
      const bytes = store.totalMediaBytes() + fileSize(join(env.DATA_DIR, 'relay.sqlite'))
      if (bytes > env.VOLUME_SOFT_CAP_MB * 1024 * 1024 && clock.now() - lastCapWarn > 86_400_000) {
        lastCapWarn = clock.now()
        log.warn({ mb: Math.round(bytes / 1048576), cap_mb: env.VOLUME_SOFT_CAP_MB }, 'volume soft cap exceeded')
        // The owner hears about it too: a log line nobody reads would let the volume fill and the relay stop writing.
        void push.notify({ template: 'storage_full' }).catch(() => {})
      }
    } catch (e) {
      log.error({ err: e instanceof Error ? e.name : 'error' }, 'retention sweep failed')
    }
  }

  const services: RelayServices = {
    db,
    bus: hub,
    push,
    media,
    crypto,
    agentConfig: () => hub.agentConfig(),
    clock,
    log,
    env,
  }
  runtimes.set(services, {
    store,
    hub,
    media,
    push,
    health,
    transport,
    webDir: opts.webDir ?? null,
    dataDir: env.DATA_DIR,
    start() {
      stopped = false
      hub.start()
      health.start()
      cardReminder.start()
      quietSummary.start()
      runSweep()
      armSweep()
    },
    onStop(fn) {
      stoppers.push(fn)
    },
    stop() {
      stopped = true
      if (sweepTimer) clock.clearTimeout(sweepTimer)
      for (const fn of stoppers.splice(0)) fn()
      cardReminder.stop()
      quietSummary.stop()
      health.stop()
      hub.stop()
      apns?.close()
    },
  })
  return services
}

/**
 * A wrong but well-formed DATA_KEY (a typo, a regenerated key, the wrong password-manager entry) would boot "healthy" and
 * then fail on every read. The first boot stores a known string encrypted under the key; later boots must decrypt it.
 */
const KEY_CHECK = 'talos-data-key-check'
function checkDataKey(store: Store, crypto: CryptoService): void {
  const aad = 'core_state:data_key_check'
  const stored = store.getState('data_key_check')
  if (stored === null) {
    store.setState(
      'data_key_check',
      Buffer.from(crypto.encrypt(new TextEncoder().encode(KEY_CHECK), aad)).toString('base64'),
    )
    return
  }
  let ok = false
  try {
    ok = new TextDecoder().decode(crypto.decrypt(Buffer.from(stored, 'base64'), aad)) === KEY_CHECK
  } catch {
    ok = false
  }
  if (!ok) throw new Error('DATA_KEY does not match the key this volume was created with')
}

function fileSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

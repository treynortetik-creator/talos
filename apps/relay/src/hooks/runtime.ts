// One HooksRuntime per RelayServices, plus the periodic tick (spec 7.1 pollers, 7.3 retention, 7.4 digest).
import { catalog, type IntegrationModule } from '@talos-app/integrations'
import type { IntegrationIdT } from '@talos-app/protocol'
import { findRuntime } from '../core/runtime.ts'
import type { RelayServices } from '../services.ts'
import { flushDigest } from './digest.ts'
import { sealLegacyEvents } from './event-seal.ts'
import { wakeSnoozed } from './inbox.ts'
import { idle, kick } from './ingest.ts'
import { pollDue } from './poller.ts'
import { deliverPending, dropAppCopies, notifyNewItems, wipeRawIfDone } from './route.ts'
import { DAY_MS, HOUR_MS, type HooksRuntime, type RuntimeOptions } from './types.ts'

const runtimes = new WeakMap<RelayServices, HooksRuntime & { timer?: unknown; stopped?: boolean }>()

/** Builds (and remembers) the runtime for a set of services. Tests call this with options; production uses defaults. */
export function createRuntime(services: RelayServices, opts: RuntimeOptions = {}): HooksRuntime {
  const rt: HooksRuntime = {
    services,
    opts,
    module: (id: IntegrationIdT): IntegrationModule => opts.modules?.[id] ?? catalog[id],
    now: () => services.clock.now(),
    iso: (ms: number) => new Date(ms).toISOString(),
  }
  runtimes.set(services, rt)
  return rt
}

export function runtimeFor(services: RelayServices): HooksRuntime {
  return runtimes.get(services) ?? createRuntime(services)
}

/**
 * Passthrough events still held after an hour, delivered or not, are dropped for good (spec 7.1). Quiet-window events are never
 * swept before the digest (Addendum 2026-10-28, PR6 F9): their hour starts when the digest carried them. The 7-day
 * buffer purge is the only bound on a collected event.
 */
export function sweepPassthrough(rt: HooksRuntime): number {
  const { db } = rt.services
  const cutoff = rt.now() - HOUR_MS
  const rows = db
    .prepare(
      `select event_id, raw_id, created_at from hooks_events where passthrough = 1
         and ((collected = 0 and created_at <= ?) or (collected = 1 and digested_at is not null and digested_at <= ?))`,
    )
    .all(cutoff, cutoff) as Array<{ event_id: string; raw_id: string | null; created_at: number }>
  for (const r of rows) {
    db.prepare('delete from hooks_events where event_id = ?').run(r.event_id)
    dropAppCopies(rt, r.event_id, r.created_at)
    if (r.raw_id) wipeRawIfDone(rt, r.raw_id)
  }
  return rows.length
}

/** Retention: dedup keys, events and raw payloads past BUFFER_DAYS, deliveries past 7 days. */
export function purge(rt: HooksRuntime): void {
  const { db, env } = rt.services
  const now = rt.now()
  const keep = now - env.BUFFER_DAYS * DAY_MS
  db.prepare('delete from hooks_dedup where expires_at <= ?').run(now)
  db.prepare('delete from hooks_events where created_at < ?').run(keep)
  db.prepare("delete from hooks_inbound where received_at < ? and state != 'pending'").run(keep)
  db.prepare('delete from hooks_deliveries where at < ?').run(now - 7 * DAY_MS)
  db.prepare('delete from hooks_claims where expires_at < ?').run(now - DAY_MS)
}

/** Everything that happens on a clock rather than on a request. Safe to call at any time and from tests. */
export async function tick(rt: HooksRuntime): Promise<void> {
  // Plain event text from before sealing, or from an older build still running at a deploy. A failure here is logged and
  // must not skip delivery, the digest, the sweep or the purge below.
  try {
    sealLegacyEvents(rt.services)
  } catch (err) {
    rt.services.log.error({ err: err instanceof Error ? err.name : 'error' }, 'sealing stored hook events failed')
  }
  // Each step runs whatever an earlier one did; the first failure is rethrown at the end for the caller to log.
  let failure: { err: unknown } | undefined
  const step = async (run: () => unknown): Promise<void> => {
    try {
      await run()
    } catch (err) {
      failure ??= { err }
    }
  }
  await step(() => kick(rt)) // recovery: rows that were written but not processed when the process last died
  await step(() => pollDue(rt))
  await step(() => idle(rt))
  await step(async () => {
    const sent = await deliverPending(rt) // events stored but not yet sent (crash or failed send)
    if (sent.pushThread) await notifyNewItems(rt, sent.pushThread)
  })
  await step(() => wakeSnoozed(rt))
  await step(() => flushDigest(rt))
  await step(() => sweepPassthrough(rt))
  await step(() => purge(rt))
  if (failure) throw failure.err
}

const TICK_MS = 30_000

/** Starts the recurring tick on the services' clock. */
export function startTicking(rt: HooksRuntime): void {
  const { clock, log } = rt.services
  const slot = runtimes.get(rt.services) as HooksRuntime & { timer?: unknown; stopped?: boolean }
  const loop = () => {
    if (slot.stopped) return
    tick(rt)
      .catch((err) => log.error({ err: err instanceof Error ? err.name : 'error' }, 'hooks tick failed'))
      .finally(() => {
        if (!slot.stopped) slot.timer = clock.setTimeout(loop, TICK_MS)
      })
  }
  slot.timer = clock.setTimeout(loop, 1000)
  findRuntime(rt.services)?.onStop(() => stopTicking(rt.services))
}

export function stopTicking(services: RelayServices): void {
  const slot = runtimes.get(services) as (HooksRuntime & { timer?: unknown; stopped?: boolean }) | undefined
  if (!slot) return
  slot.stopped = true
  if (slot.timer !== undefined) services.clock.clearTimeout(slot.timer)
}

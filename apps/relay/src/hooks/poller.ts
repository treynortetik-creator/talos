// Pollers (Jira later, GitHub notifications, RSS): a jittered schedule with persisted cursors. Ten failures in a row pause
// the connection and drop a system item in the Inbox (spec 7.1).
import type { PollContext } from '@talos-app/integrations'
import { newId } from '@talos-app/protocol'
import { ingestPolled, integrationEnabled } from './ingest.ts'
import { type RouteInput, routeEvents } from './route.ts'
import { addDelivery, credsFor, getConn, listConns, updateConn } from './store.ts'
import { type ConnRow, type HooksRuntime, POLL_PAUSE_AFTER } from './types.ts'

const running = new WeakMap<HooksRuntime, Set<string>>()
const BACKOFF_CAP_S = 3600

type PollState = { cursor: string | null; next_at: number; fail_count: number }

function stateOf(rt: HooksRuntime, id: string): PollState {
  const r = rt.services.db
    .prepare('select cursor, next_at, fail_count from hooks_poll_state where conn_id = ?')
    .get(id) as PollState | undefined
  return r ?? { cursor: null, next_at: 0, fail_count: 0 }
}

function saveState(rt: HooksRuntime, id: string, s: PollState, lastError: string | null): void {
  rt.services.db
    .prepare(
      `insert into hooks_poll_state (conn_id, cursor, next_at, fail_count, last_error) values (?, ?, ?, ?, ?)
       on conflict(conn_id) do update set cursor = excluded.cursor, next_at = excluded.next_at,
         fail_count = excluded.fail_count, last_error = excluded.last_error`,
    )
    .run(id, s.cursor, s.next_at, s.fail_count, lastError)
}

/** Resets the schedule so the next tick polls (used when a connection is resumed or its credentials change). */
export function pollSoon(rt: HooksRuntime, id: string): void {
  const s = stateOf(rt, id)
  saveState(rt, id, { ...s, next_at: 0, fail_count: 0 }, null)
}

function scrub(message: string, secrets: Record<string, string>): string {
  let m = message
  for (const v of Object.values(secrets)) if (v.length >= 6) m = m.split(v).join('***')
  return m.replace(/\s+/g, ' ').slice(0, 120)
}

export type PollOutcome = { ok: true; count: number } | { ok: false; error: string }

/** One poll of one connection. Never throws. */
export async function pollConnection(rt: HooksRuntime, conn: ConnRow): Promise<PollOutcome> {
  const mod = rt.module(conn.integration)
  if (!mod.poll || !integrationEnabled(rt, conn.integration)) return { ok: true, count: 0 }
  const set = running.get(rt) ?? new Set<string>()
  running.set(rt, set)
  if (set.has(conn.id)) return { ok: true, count: 0 }
  set.add(conn.id)
  const secrets = credsFor(rt, conn.id)
  const state = stateOf(rt, conn.id)
  try {
    const ctx: PollContext = {
      cursor: state.cursor,
      secrets,
      extra: conn.extra,
      now: rt.now(),
      fetch: rt.opts.fetch ?? globalThis.fetch,
    }
    const res = await mod.poll(ctx)
    const stored = await ingestPolled(rt, conn, res.deliveries)
    if (stored > 0) {
      // Poll deliveries are logged by persistRaw; a truncated page is noted once so the owner can see it.
      if (res.truncated) addDelivery(rt, conn.id, 200, 'truncated')
    }
    const jitter = 1 + (rt.opts.random ?? Math.random)() * 0.2
    saveState(
      rt,
      conn.id,
      { cursor: res.cursor, next_at: rt.now() + Math.ceil(res.nextInS * jitter * 1000), fail_count: 0 },
      null,
    )
    return { ok: true, count: stored }
  } catch (err) {
    const msg = scrub(err instanceof Error ? err.message : 'poll failed', secrets)
    const fails = state.fail_count + 1
    const backoff = Math.min(BACKOFF_CAP_S, 2 ** Math.min(fails, 12) * 30)
    saveState(rt, conn.id, { cursor: state.cursor, next_at: rt.now() + backoff * 1000, fail_count: fails }, msg)
    rt.services.log.warn({ conn: conn.id, integration: conn.integration, fails }, 'poll failed')
    if (fails >= POLL_PAUSE_AFTER) await pauseAfterFailures(rt, conn, msg)
    return { ok: false, error: msg }
  } finally {
    set.delete(conn.id)
  }
}

async function pauseAfterFailures(rt: HooksRuntime, conn: ConnRow, msg: string): Promise<void> {
  const mod = rt.module(conn.integration)
  const hint = /\b40[13]\b/.test(msg) ? 'Re-paste the token.' : 'Open the connection to fix it.'
  updateConn(rt, conn.id, { status: 'paused', paused_reason: `poll_failed: ${msg}` })
  const work = mod.setup.category === 'work'
  const title = `${mod.setup.name} polling paused`
  const event = {
    id: newId('e'),
    source: conn.integration,
    connection: conn.id,
    kind: 'generic.event',
    title,
    summary: `${title}: ${msg}. ${hint}`.slice(0, 280),
    actor: { name: 'Talos' },
    ts: rt.iso(rt.now()),
    thread: conn.thread,
    work,
    priority: 'high' as const,
    dedup_key: `system:poll_paused:${conn.id}:${rt.now()}`,
  }
  await routeEvents(rt, [{ event, rawId: null } satisfies RouteInput])
}

/** Polls every active connection whose time has come. */
export async function pollDue(rt: HooksRuntime): Promise<void> {
  for (const c of listConns(rt)) {
    const mod = rt.module(c.integration)
    if (!mod.poll || c.status !== 'active') continue
    if (!integrationEnabled(rt, c.integration)) continue // the global kill switch AND this integration's own flag
    const fresh = getConn(rt, c.id)
    if (fresh?.status !== 'active') continue
    if (stateOf(rt, c.id).next_at > rt.now()) continue
    await pollConnection(rt, fresh)
  }
}

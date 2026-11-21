// The bridge keeps its own online relay on the newest release (docs/deploy-railway.md "Keeping the relay up to date").
//
// On the bridge's poll (bridge.ts `notes`), when the owner connected the relay (`talos-app relay connect`, or the Mac app set it up)
// and auto-update is on:
//   - at most once an hour it asks the relay which release it is on and compares it with the published releases;
//   - only when the relay is `behind` (never a relay built from main, one ahead of the list, or when nothing can be told), and this
//     release was not already tried, it sends ONE redeploy request and says so in the default thread ("updating to X");
//   - it then follows that one attempt (a look at most every 20 s): "is on X" when the relay says so, or "didn't update" with the plain
//     reason when Railway or the app said no, or when the relay did not move in ten minutes;
//   - a failed release is not tried again by itself for 24 hours (`talos-app relay update` still can).
// The rows are fixed sentences; the only variable text is a version that passed the strict X.Y.Z check and one of our own reasons.
// The state is relay-auto.json (files.ts), so a restart neither repeats a request nor loses the attempt it was following.
import type { RelayConnectFileT, SecretStore } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice } from '../context.ts'
import { RelayHttp } from '../relay-http.ts'
import { compareSemver, feedDeps, loadReleases, relayReleaseState } from '../release-feed.ts'
import { openSecretStore } from '../secrets/store.ts'
import { type Attempt, type AutoState, readConnection, readState, writeState } from './files.ts'
import { appDetail, appFailureText, appResult, requestRedeploy } from './redeploy.ts'

const HOUR_MS = 3_600_000
export const AUTO_RETRY_MS = 24 * HOUR_MS
export const AUTO_WINDOW_MS = 10 * 60_000
const FOLLOW_EVERY_MS = 20_000
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/

export type AutoDeps = { secrets?: SecretStore }
type Post = (text: string) => Promise<unknown>

const running = new WeakMap<object, Promise<unknown>>()

/** One look. Calls on the same store run one after the other (the poll can overlap itself). Returns how many rows it posted. */
export function noteRelay(
  ctx: BridgeContext,
  post: Post = (t) => postSystemNotice(ctx, t, { silent: true }),
  deps: AutoDeps = {},
): Promise<number> {
  const prev = running.get(ctx.store) ?? Promise.resolve()
  const next = prev.then(() => look(ctx, post, deps))
  running.set(
    ctx.store,
    next.catch(() => undefined),
  )
  return next
}

const failedRow = (release: string, why: string): string =>
  `Your online relay didn't update to ${release}: ${why}. Run talos-app relay update to try again.`
const noTrailingDot = (s: string): string => s.replace(/[.\s]+$/, '')

async function look(ctx: BridgeContext, post: Post, deps: AutoDeps): Promise<number> {
  if (ctx.mode !== 'live' || ctx.worker) return 0
  const home = ctx.env.home
  const conn = readConnection(home)?.file
  if (!conn || !ctx.env.relayUrl) return 0
  const state = readState(home)
  const now = ctx.clock.now()
  // an attempt already sent is followed to its end even if auto-update was turned off since (it only stops new ones)
  if (state.attempt?.state === 'sent') return follow(ctx, conn, state, state.attempt, now, post)
  if (!conn.auto_update) return 0
  // looked within the hour (a clock that went back is not "within")
  if (state.checked_at !== undefined && now >= state.checked_at && now - state.checked_at < HOUR_MS) return 0
  writeState(home, { ...state, checked_at: now })

  const http = new RelayHttp(ctx.env.relayUrl, () => {
    throw new Error('no key needed')
  })
  let health: Awaited<ReturnType<RelayHttp['healthz']>>
  try {
    health = await http.healthz()
  } catch {
    return 0 // not reachable now: the next look, in an hour
  }
  if (typeof health.release !== 'string') return 0 // a relay from main (or too old to say): never redeployed from releases
  const got = await loadReleases(feedDeps(ctx.env, ctx.clock.now))
  const verdict = relayReleaseState({ release: health.release, version: health.version }, got.versions, got.failure)
  if (verdict.state !== 'behind') return 0
  const target = verdict.latest
  const last = state.attempt
  if (last?.release === target && (last.state !== 'failed' || now < last.at || now - last.at < AUTO_RETRY_MS)) return 0

  // the attempt is on disk BEFORE the request goes out: a crash in between never sends a second one
  const attempt: Attempt = { release: target, at: now, state: 'sent', by: 'auto', via: conn.via }
  writeState(home, { v: 1, checked_at: now, attempt })
  const secrets = async () => deps.secrets ?? (await openSecretStore({ home }))
  const out = await requestRedeploy(conn, target, {
    home,
    now: ctx.clock.now,
    secrets,
  })
  if (!out.ok) {
    writeState(home, { v: 1, checked_at: now, attempt: { ...attempt, state: 'failed', reason: out.short } })
    return tell(ctx, post, failedRow(target, out.short))
  }
  writeState(home, {
    v: 1,
    checked_at: now,
    attempt: { ...attempt, ...(out.id ? { id: out.id } : {}), polled_at: now },
  })
  return tell(ctx, post, `Your online relay is updating to ${target}.`)
}

/** Follows the attempt that was sent: the app's answer, the relay's own release, or the ten minutes running out. */
async function follow(
  ctx: BridgeContext,
  conn: RelayConnectFileT,
  state: AutoState,
  a: Attempt,
  now: number,
  post: Post,
): Promise<number> {
  const home = ctx.env.home
  if (a.polled_at !== undefined && now >= a.polled_at && now - a.polled_at < FOLLOW_EVERY_MS) return 0
  const quiet = a.by !== 'auto' // an update the owner ran himself is not announced again
  const save = (next: Attempt) => writeState(home, { ...state, attempt: next })
  const result = appResult(conn, home, a.id, a.release)
  if (result.state === 'failed') {
    const why = noTrailingDot(appFailureText(result.code))
    const detail = appDetail(result.detail)
    save({ ...a, state: 'failed', reason: why, ...(detail ? { detail } : {}) })
    return quiet ? 0 : tell(ctx, post, failedRow(a.release, why))
  }
  let on: string | undefined
  try {
    const h = await new RelayHttp(ctx.env.relayUrl as string, () => {
      throw new Error('no key needed')
    }).healthz()
    if (typeof h.release === 'string' && SEMVER.test(h.release)) on = h.release
  } catch {
    // restarting: still waiting
  }
  if (on !== undefined && compareSemver(on, a.release) >= 0) {
    save({ ...a, state: 'on', polled_at: now })
    return quiet ? 0 : tell(ctx, post, `Your online relay is on ${on}.`)
  }
  if (Math.max(0, now - a.at) > AUTO_WINDOW_MS) {
    const why = on !== undefined ? `it was still on ${on} ten minutes later` : 'it did not come back within ten minutes'
    save({ ...a, state: 'failed', reason: why })
    return quiet ? 0 : tell(ctx, post, failedRow(a.release, why))
  }
  save({ ...a, polled_at: now })
  return 0
}

async function tell(ctx: BridgeContext, post: Post, text: string): Promise<number> {
  try {
    await post(text)
    return 1
  } catch (e) {
    ctx.log.warn('relay update row not posted', { error: (e as Error).message })
    return 0
  }
}

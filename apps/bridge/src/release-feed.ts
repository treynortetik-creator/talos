// Which releases exist, and how far behind a relay is (docs/bridge.md "talos-app doctor", docs/deploy-railway.md).
//
// A relay that runs from the release image says its release (`/healthz` `release`, a strict X.Y.Z). The releases are
// squashed snapshots on the public release repo, tagged `mac-v<X.Y.Z>`, so the only way to say "N behind" is to count them:
// this reads the repo's GitHub releases list, caches it in the Talos home, and compares. One anonymous request at most every
// 6 hours (GitHub allows 60 an hour per address); a failed one keeps using a cache up to 7 days old; none ever blocks a
// command for longer than its 10 second limit.
import { join } from 'node:path'
import { createGuardedFetch, type GuardedFetch } from '@talos-app/protocol/guarded-fetch'
import { readJsonFile, writeJsonAtomic } from './fsutil.ts'

/** The public release repo (the same one the Mac app updates from), as GitHub's releases API names it. */
export const RELEASE_FEED_URL = 'https://api.github.com/repos/treynortetik-creator/talos/releases?per_page=100'
export const FEED_FRESH_MS = 6 * 3_600_000
export const FEED_STALE_MAX_MS = 7 * 86_400_000
export const FEED_TIMEOUT_MS = 10_000
export const FEED_MAX_BYTES = 2 * 1024 * 1024
/** Generic on purpose: no user, machine or address of the owner goes out. */
const USER_AGENT = 'talos-app-release-check'

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const TAG = /^mac-v(.+)$/

const parts = (v: string): [number, number, number] => v.split('.').map(Number) as [number, number, number]
export function compareSemver(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** The published versions in a GitHub releases list: `mac-v<X.Y.Z>` tags, no drafts or prereleases, sorted, once each. */
export function parseReleaseFeed(body: unknown): string[] {
  if (!Array.isArray(body)) return []
  const out = new Set<string>()
  for (const r of body) {
    if (typeof r !== 'object' || r === null) continue
    const { tag_name, draft, prerelease } = r as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
    if (typeof tag_name !== 'string' || draft === true || prerelease === true) continue
    const v = TAG.exec(tag_name)?.[1]
    if (v !== undefined && SEMVER.test(v)) out.add(v)
  }
  return [...out].sort(compareSemver)
}

/** What is kept in release-feed.json: the last good list, and the last failure (so a failure is not asked again at once). */
type Cache = { fetched_at: number; versions: string[]; failed_at?: number; failure?: FeedFailure }

/** Why no list could be had: no network (or any other answer), GitHub's rate limit, or a list with no release in it. */
export type FeedFailure = 'offline' | 'rate-limited' | 'empty'
const FAILURES: readonly string[] = ['offline', 'rate-limited', 'empty']

/** After a failed fetch nothing asks again for this long, so repeated doctor/status runs neither re-request nor wait 10 s each. */
export const FEED_FAILURE_MEMORY_MS = 15 * 60_000

/**
 * TESTS ONLY: another feed address, set from test code. Never read from the environment or a file: a caller that can set an
 * environment variable (an agent's shell) must not be able to point this at a server of its own.
 */
export const releaseFeedTestSeam: { url?: string | undefined } = {}

export type ReleaseFeedDeps = {
  /** The Talos home: the cache is `release-feed.json` in it. */
  home: string
  now: () => number
  /** TESTS ONLY (set through `releaseFeedTestSeam`, never the environment): another feed address; a loopback server is then allowed, and the real cache is neither read nor written. */
  url?: string | undefined
  /** Tests: a stand-in for the guarded fetch. */
  fetch?: GuardedFetch
  /** Tests: the guarded fetch's name lookup. */
  resolve?: (host: string) => Promise<readonly string[]>
  timeoutMs?: number
}

function readCache(file: string): Cache | undefined {
  const c = readJsonFile<Partial<Cache>>(file)
  if (!c || typeof c !== 'object' || !Array.isArray(c.versions)) return undefined
  const versions = c.versions.filter((v): v is string => typeof v === 'string' && SEMVER.test(v))
  const out: Cache = {
    fetched_at: typeof c.fetched_at === 'number' ? c.fetched_at : Number.NEGATIVE_INFINITY,
    versions: versions.sort(compareSemver),
  }
  if (typeof c.failed_at === 'number' && typeof c.failure === 'string' && FAILURES.includes(c.failure)) {
    out.failed_at = c.failed_at
    out.failure = c.failure as FeedFailure
  }
  return out
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new Error('the releases list is too big')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

class FeedError extends Error {
  constructor(
    message: string,
    readonly why: FeedFailure,
  ) {
    super(message)
  }
}

/**
 * The published release versions, oldest first, or why there are none (no network and no cache under 7 days old). Never throws.
 * A failure is remembered for 15 minutes; inside that time (and after a fetch that fails) a cache up to 7 days old is still used.
 * With `url` set (tests) nothing is read from or written to the real cache.
 */
export async function loadReleases(
  d: ReleaseFeedDeps,
): Promise<{ versions: string[] | undefined; failure?: FeedFailure }> {
  const file = d.url ? undefined : join(d.home, 'release-feed.json')
  const cache = file ? readCache(file) : undefined
  const now = d.now()
  const age = cache ? now - cache.fetched_at : Number.POSITIVE_INFINITY
  if (cache && age >= 0 && age < FEED_FRESH_MS) return { versions: cache.versions }
  const stale = cache && age >= 0 && age <= FEED_STALE_MAX_MS && cache.versions.length > 0 ? cache.versions : undefined
  if (cache?.failed_at !== undefined && cache.failure) {
    const since = now - cache.failed_at
    if (since >= 0 && since < FEED_FAILURE_MEMORY_MS)
      return stale ? { versions: stale } : { versions: undefined, failure: cache.failure }
  }
  const timeoutMs = d.timeoutMs ?? FEED_TIMEOUT_MS
  try {
    const send =
      d.fetch ??
      createGuardedFetch({
        timeoutMs,
        ...(d.url ? { allowLoopback: true } : {}),
        ...(d.resolve ? { resolve: d.resolve } : {}),
      })
    // no Authorization header, no cookie: a public list, asked anonymously. A redirect is an answer, not followed (guarded fetch).
    const res = await send(d.url ?? RELEASE_FEED_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status !== 200)
      throw new FeedError(
        `the releases list answered ${res.status}`,
        res.status === 403 || res.status === 429 ? 'rate-limited' : 'offline',
      )
    const versions = parseReleaseFeed(JSON.parse(await readCapped(res, FEED_MAX_BYTES)))
    if (versions.length === 0) throw new FeedError('the releases list has no release in it', 'empty')
    if (file)
      try {
        writeJsonAtomic(file, { fetched_at: now, versions } satisfies Cache, 0o600)
      } catch {
        // a cache that cannot be written only costs the next call another request
      }
    return { versions }
  } catch (e) {
    const failure: FeedFailure = e instanceof FeedError ? e.why : 'offline'
    if (file)
      try {
        // keep the last good list and its time; only the failure is new
        writeJsonAtomic(
          file,
          {
            fetched_at: cache?.fetched_at ?? 0,
            versions: cache?.versions ?? [],
            failed_at: now,
            failure,
          } satisfies Cache,
          0o600,
        )
      } catch {
        // see above
      }
    return stale ? { versions: stale } : { versions: undefined, failure }
  }
}

/** The versions only (see loadReleases). */
export async function loadReleaseList(d: ReleaseFeedDeps): Promise<string[] | undefined> {
  return (await loadReleases(d)).versions
}

export type RelayReleaseState =
  | { state: 'latest'; relay: string; latest: string }
  | { state: 'behind'; n: number; relay: string; latest: string }
  | { state: 'ahead'; relay: string; latest: string }
  | { state: 'not-a-release'; commit?: string }
  | { state: 'unknown'; relay: string; why?: FeedFailure }

/**
 * What a relay's /healthz says (`release`, and `version` = its commit) against the published releases. No `release` (or one
 * that is not X.Y.Z) is a build from main, or a relay too old to say: never "behind". A release with no list is unknown.
 */
export function relayReleaseState(
  relay: { release?: string | undefined; version?: string | undefined },
  releases: readonly string[] | undefined,
  why?: FeedFailure,
): RelayReleaseState {
  const r = relay.release
  if (typeof r !== 'string' || !SEMVER.test(r)) {
    // what a relay sends is data: a version that is not a string is no commit
    const commit =
      typeof relay.version === 'string'
        ? /^([0-9a-f]{7,40})(-dirty)?$/.exec(relay.version.trim())?.[1]?.slice(0, 7)
        : undefined
    return commit ? { state: 'not-a-release', commit } : { state: 'not-a-release' }
  }
  if (!releases || releases.length === 0)
    return why ? { state: 'unknown', relay: r, why } : { state: 'unknown', relay: r }
  const latest = releases.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b))
  const c = compareSemver(r, latest)
  if (c === 0) return { state: 'latest', relay: r, latest }
  if (c > 0) return { state: 'ahead', relay: r, latest }
  return { state: 'behind', n: releases.filter((v) => compareSemver(v, r) > 0).length, relay: r, latest }
}

/** What `status --json` carries: `relay_release`. */
export type RelayReleaseJson = { state: RelayReleaseState['state']; relay?: string; latest?: string; behind?: number }

export type ReleaseReport = { level: 'ok' | 'warn'; text: string; json: RelayReleaseJson }

/** Whether this install can update its relay itself (`talos-app relay connect`): the "behind" sentence names the command that does it. */
export type UpdateHint = { connected: boolean }

/** The sentence for a state, in the words `doctor` and `status` both use. */
export function describeReleaseState(
  s: RelayReleaseState,
  hint: UpdateHint = { connected: false },
): { level: 'ok' | 'warn'; text: string } {
  switch (s.state) {
    case 'latest':
      return { level: 'ok', text: `on ${s.relay} (the latest release)` }
    case 'behind':
      return {
        level: 'warn',
        text: `your online relay is ${s.n} release${s.n === 1 ? '' : 's'} behind (on ${s.relay}, latest ${s.latest}): ${
          hint.connected
            ? 'run talos-app relay update to update it now'
            : 'Railway updates an image relay within a few hours; to update now, redeploy it in Railway, or run talos-app relay connect once so Talos can do it'
        }`,
      }
    case 'ahead':
      return { level: 'ok', text: `on ${s.relay}, newer than the latest published release (${s.latest})` }
    case 'not-a-release':
      return {
        level: 'ok',
        text: `not a release build${s.commit ? ` (commit ${s.commit})` : ''}: a relay that deploys from main, or one too old to report its release`,
      }
    case 'unknown':
      return {
        level: 'ok',
        text: `can't check releases right now (${
          s.why === 'rate-limited'
            ? 'GitHub is rate-limiting this computer, try later'
            : s.why === 'empty'
              ? 'no releases listed'
              : 'offline'
        })`,
      }
  }
}

/**
 * The whole check for a relay that answered /healthz. Asks for the releases only when the relay says it is on one: a build from
 * main needs no list (and costs no request).
 */
export async function relayReleaseReport(
  d: ReleaseFeedDeps,
  relay: { release?: string | undefined; version?: string | undefined },
  hint?: UpdateHint,
): Promise<ReleaseReport> {
  const says = typeof relay.release === 'string' && SEMVER.test(relay.release)
  const got = says ? await loadReleases(d) : undefined
  const s = relayReleaseState(relay, got?.versions, got?.failure)
  const { level, text } = describeReleaseState(s, hint)
  const json: RelayReleaseJson = { state: s.state }
  if ('relay' in s) json.relay = s.relay
  if ('latest' in s) json.latest = s.latest
  if (s.state === 'behind') json.behind = s.n
  return { level, text, json }
}

/** The feed's inputs from the bridge's environment and clock. */
export function feedDeps(env: { home: string }, now: () => number): ReleaseFeedDeps {
  return { home: env.home, now, url: releaseFeedTestSeam.url }
}

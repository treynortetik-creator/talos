// `talos-app facts`: what is true right now, in one place (docs/bridge.md "talos-app facts").
//
// READ-ONLY, strictly. It writes no file (not the release list's cache, not a key store choice, not a request for the Mac app), reads
// the key store only to learn whether an item is there (the value is never shown), and opens history.sqlite without ever making a
// -wal or -shm file. Every field is `{value, source, as_of}`, or `{state: 'unknown', reason}`: a source that cannot be read is said so,
// never guessed. Each source that can wait (the relay, GitHub, the key store) gets 5 seconds, all at once, so the whole command is back in
// about 5 seconds even when everything is down. No secret, token, keyed address or message or card text ever reaches the output.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { CliIO } from './cli-main.ts'
import { realClock } from './clock.ts'
import { type BridgeEnv, paths } from './config.ts'
import { parseConfig } from './config-file.ts'
import { type GitRun, mainRow, realGh, realRunAsync, sourceCheckoutRepo } from './facts-dev.ts'
import {
  appField,
  type ConfigRead,
  type Ctx,
  cardsField,
  DEADLINE_MS,
  type Facts,
  type FactsDeps,
  type Field,
  isoOf,
  isUnknown,
  type Known,
  LATE,
  no,
  peersField,
  plainFile,
  readHistory,
  within,
} from './facts-parts.ts'
import { readJsonFile } from './fsutil.ts'
import { connectionFileBroken, readConnection, readState } from './relay/files.ts'
import { type FetchFn, RelayHttp, RelayHttpError } from './relay-http.ts'
import { compareSemver, FEED_FRESH_MS, loadReleases, relayReleaseState, releaseFeedTestSeam } from './release-feed.ts'
import { type BridgeLiveness, bridgeLiveness, runningBridge } from './status-file.ts'
import { BRIDGE_COMMIT, BRIDGE_VERSION, commitReport } from './version.ts'

export { type GhRun, MAIN_CI_CONTEXTS, parseGitHubRepo } from './facts-dev.ts'
export type { Facts, FactsDeps } from './facts-parts.ts'

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

type FeedRes = { versions: string[] | undefined; failure?: string; fetched_at?: number; from?: 'cache' | 'fetch' }
type Feed = { late: true } | { late: false; value: FeedRes }
type HealthRes =
  | { late: true }
  | { late: false; h: { ok: boolean; version?: string; release?: string } }
  | { late: false; error: string }

export async function collectFacts(env: BridgeEnv, deps: FactsDeps = {}): Promise<Facts> {
  const now = deps.now ?? (() => Date.now())
  const clock = deps.clock ?? realClock
  const platform = deps.platform ?? process.platform
  const nowMs = now()
  const iso = isoOf(nowMs)
  const p = paths(env.home)
  const ok = (value: unknown, source: string, as_of: string = iso, extra: Record<string, unknown> = {}): Known => ({
    value,
    source,
    as_of,
    ...extra,
  })
  const ctx: Ctx = { env, deps, clock, nowMs, iso, platform, ok }
  const guarded = async (fn: () => Promise<Field> | Field, why: string): Promise<Field> => {
    try {
      return await fn()
    } catch {
      return no(why)
    }
  }

  // ---- shared sources
  // A file of the home that is a pipe (or any non-regular file) would block a plain read forever: its fields say so instead.
  const plain = (name: string, dir: string = env.home) => plainFile(join(dir, name))
  const NOT_REGULAR = (name: string) => `${name} is not a regular file`
  const statusPlain = plain('status.json')
  const live: BridgeLiveness = statusPlain ? bridgeLiveness(p.status, nowMs, deps.alive) : { state: 'none' }
  const config = ((): ConfigRead => {
    if (!existsSync(p.configJson)) return { ok: false, reason: 'no config.json in this Talos home' }
    if (!plain('config.json')) return { ok: false, reason: NOT_REGULAR('config.json') }
    const raw = readJsonFile(p.configJson)
    if (raw === undefined) return { ok: false, reason: 'config.json cannot be read' }
    const parsed = parseConfig(raw)
    return parsed.ok ? { ok: true, config: parsed } : { ok: false, reason: 'config.json is not valid' }
  })()
  const feedP: Promise<Feed> = (
    plain('release-feed.json')
      ? within<FeedRes>(clock, () =>
          loadReleases({
            home: env.home,
            now,
            timeoutMs: DEADLINE_MS,
            readOnly: true,
            url: releaseFeedTestSeam.url,
            ...(deps.releaseFetch ? { fetch: deps.releaseFetch } : {}),
          }),
        )
      : Promise.resolve({ late: false, value: { versions: undefined, failure: 'unreadable' } } as Feed)
  ).catch((): { late: false; value: FeedRes } => ({ late: false, value: { versions: undefined, failure: 'offline' } }))
  const feedVersions = (f: Feed): string[] | undefined => (f.late ? undefined : f.value.versions)
  const feedReason = (f: Feed): string => {
    if (f.late) return LATE
    const why = (f.value as { failure?: string }).failure
    if (why === 'unreadable') return `the release list's cache ${NOT_REGULAR('release-feed.json')}`
    return `the release list is unavailable: ${
      why === 'rate-limited'
        ? 'GitHub is rate-limiting this computer, try later'
        : why === 'empty'
          ? 'no releases listed'
          : 'offline'
    }`
  }
  const health: Promise<HealthRes> | undefined = env.relayUrl
    ? within(clock, () =>
        new RelayHttp(
          env.relayUrl as string,
          () => {
            throw new Error('no key needed')
          },
          deps.fetch,
          DEADLINE_MS,
        ).healthz(),
      ).then(
        (r): HealthRes => (r.late ? { late: true } : { late: false, h: r.value }),
        (e): HealthRes => ({
          late: false,
          error: e instanceof RelayHttpError ? `answered ${e.status}` : 'did not answer',
        }),
      )
    : undefined
  const history = readHistory(p.historyDb, deps.scratch)

  // ---- bridge
  const cr = commitReport(runningBridge(live), (deps.bridge ?? { commit: BRIDGE_COMMIT }).commit)
  const bridge = ok(
    {
      version: (deps.bridge ?? { version: BRIDGE_VERSION }).version,
      commit: cr.commit ?? null,
      liveness: live.state,
      needs_restart: cr.note !== undefined,
    },
    'status.json',
    live.state === 'none' ? iso : live.status.updated_at,
  )
  const bridgeOut: Field = statusPlain ? bridge : no(NOT_REGULAR('status.json'))

  // ---- app (a Mac) / supervisor (elsewhere)
  const appP = appField(ctx)
  const supervisor: Field | undefined =
    platform === 'darwin'
      ? undefined
      : await guarded(() => {
          const file = join(env.home, 'supervisor-status.json')
          if (!existsSync(file)) return no('no supervisor has run here yet (no supervisor-status.json)')
          if (!plainFile(file)) return no(NOT_REGULAR('supervisor-status.json'))
          const s = (readJsonFile(file) as { supervisor?: { version?: unknown; updated?: unknown } } | undefined)
            ?.supervisor
          if (typeof s?.version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(s.version))
            return no('supervisor-status.json names no version')
          return ok({ version: s.version }, 'supervisor-status.json', typeof s.updated === 'string' ? s.updated : iso)
        }, 'supervisor-status.json cannot be read')

  // ---- peers
  const peersP = peersField(ctx, config, history)

  // ---- main (a developer's checkout only)
  const mainP: Promise<Field> = (async (): Promise<Field> => {
    const checkout = deps.checkout ?? join(import.meta.dir, '..', '..', '..')
    const git: GitRun = deps.git ?? ((args, cwd, o) => realRunAsync('git', args, { cwd, signal: o.signal }))
    try {
      // the git calls and gh share one 5 s limit; at it every child is killed (their signal)
      const r = await within(clock, async (signal) => {
        const found = await sourceCheckoutRepo({ checkout, git, signal })
        if ('unknown' in found) return found
        return mainRow(found.repo, { checkout, git, gh: deps.gh ?? realGh, now, signal })
      })
      if (r.late) return no(LATE)
      return 'unknown' in r.value ? no(r.value.unknown) : ok(r.value.value, 'gh api commit statuses')
    } catch {
      return no('GitHub could not be read')
    }
  })()

  const app = await appP
  // ---- the release list
  const feed = await feedP
  const versions = feedVersions(feed)
  const latest = versions?.length ? versions.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b)) : undefined
  const latestField: Field =
    latest === undefined || feed.late
      ? no(feedReason(feed))
      : ok(
          latest,
          feed.value.from === 'fetch' ? 'GitHub releases' : 'release-feed.json',
          isoOf(feed.value.fetched_at ?? nowMs),
          {
            ...(feed.value.from === 'cache' && nowMs - (feed.value.fetched_at ?? 0) >= FEED_FRESH_MS
              ? { stale: true }
              : {}),
          },
        )
  const appBehind: Field = ((): Field => {
    if (isUnknown(app)) return no(app.reason)
    const v = (app as Known).value as { version: string }
    if (!SEMVER.test(v.version)) return no("the installed app's version is not a release version")
    if (!versions?.length) return no(feedReason(feed))
    return ok(
      versions.filter((x) => compareSemver(x, v.version) > 0).length,
      'Talos.app Info.plist and the release list',
    )
  })()
  // "not a Mac" says it better than a second reason
  const appBehindOut: Field = platform !== 'darwin' ? no('no desktop app here') : appBehind

  // ---- relay
  const h = health ? await health : undefined
  const reachable: Field = !health
    ? no('no relay URL is set')
    : h && 'h' in h
      ? ok(h.h.ok === true, 'GET /healthz', iso, h.h.ok === true ? {} : { why: 'answered, but not ok' })
      : ok(false, 'GET /healthz', iso, { why: h && 'error' in h ? h.error : LATE })
  const up = h && 'h' in h && h.h.ok === true ? h.h : undefined
  const state = up ? relayReleaseState({ release: up.release, version: up.version }, versions) : undefined
  const why = !health ? 'no relay URL is set' : 'the relay is not reachable'
  let relayRelease: Field = no(why)
  let relayBehind: Field = no(why)
  if (state) {
    const src = 'GET /healthz'
    switch (state.state) {
      case 'latest':
        relayRelease = ok({ state: 'latest', version: state.relay, latest: state.latest }, src)
        relayBehind = ok(0, src)
        break
      case 'ahead':
        relayRelease = ok({ state: 'ahead', version: state.relay, latest: state.latest }, src)
        relayBehind = ok(0, src)
        break
      case 'behind':
        relayRelease = ok({ state: 'behind', version: state.relay, latest: state.latest }, src)
        relayBehind = ok(state.n, src)
        break
      case 'not-a-release':
        relayRelease = ok({ state: 'not-a-release', ...(state.commit ? { commit: state.commit } : {}) }, src)
        relayBehind = no('not a release build, so "behind" does not apply')
        break
      case 'unknown':
        relayRelease = ok({ state: 'unknown', version: state.relay }, src)
        relayBehind = no(feedReason(feed))
        break
    }
  }
  const connected: Field =
    live.state === 'live'
      ? ok(live.relayConnected, 'status.json', live.status.updated_at)
      : no('no live bridge (status.json is missing, stale or dead)')
  const connPlain = plain('relay-connect.json')
  const conn = connPlain ? readConnection(env.home) : undefined
  const broken = !connPlain || (!conn && connectionFileBroken(env.home))
  const via: Field = conn
    ? ok(conn.file.via, 'relay-connect.json')
    : broken
      ? no('relay-connect.json cannot be read')
      : ok('none', 'relay-connect.json (not there)')
  const relayAuto: Field = conn
    ? ok(conn.file.auto_update, 'relay-connect.json')
    : broken
      ? no('relay-connect.json cannot be read')
      : no('not connected to Railway, so the bridge does not update the relay')
  const statePlain = plain('relay-auto.json')
  const attempt = statePlain ? readState(env.home).attempt : undefined
  const lastAttempt: Field = !statePlain
    ? no(NOT_REGULAR('relay-auto.json'))
    : attempt
      ? ok(
          { state: attempt.state, release: attempt.release, by: attempt.by, at: isoOf(attempt.at) },
          'relay-auto.json',
          isoOf(attempt.at),
        )
      : ok({ state: 'none' }, 'relay-auto.json')

  // ---- updates
  const appAuto = await guarded(() => {
    if (platform !== 'darwin') return no('this computer has no app auto-update setting')
    const file = join(env.userHome, 'Library', 'Application Support', 'Talos', 'desktop.json')
    if (!existsSync(file)) return no('no desktop.json: the Talos app has not been set up here')
    if (!plainFile(file)) return no(NOT_REGULAR('desktop.json'))
    const o = readJsonFile(file) as Record<string, unknown> | undefined
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return no('desktop.json cannot be read')
    if (o.auto_update === undefined)
      return ok(false, 'desktop.json', iso, { note: 'no auto_update key: the app reads that as off' })
    if (typeof o.auto_update !== 'boolean') return no('desktop.json auto_update is not true or false')
    return ok(o.auto_update, 'desktop.json')
  }, 'desktop.json cannot be read')

  // ---- cards
  const cards = cardsField(ctx, history)

  // ---- lock
  const lock: Field = config.ok ? ok(config.config.config.settings_lock === true, 'config.json') : no(config.reason)
  // ---- the extra lock on protected files (OS sandbox)
  const osSandbox: Field = config.ok ? ok(config.config.config.os_sandbox === true, 'config.json') : no(config.reason)

  const peers = await peersP
  const main = await mainP
  return {
    v: 1,
    as_of: iso,
    bridge: bridgeOut,
    app,
    ...(supervisor ? { supervisor } : {}),
    latest_release: latestField,
    app_behind: appBehindOut,
    relay: {
      reachable,
      release: relayRelease,
      behind: relayBehind,
      connected,
      via,
      auto: relayAuto,
      last_attempt: lastAttempt,
    },
    updates: { app_auto_update: appAuto, relay_auto: relayAuto },
    cards,
    peers,
    lock,
    os_sandbox: osSandbox,
    main,
  }
}

// ---- the words -------------------------------------------------------------------------------------------------------------------

const val = (f: Field, say: (v: any, f: Known) => string): string =>
  isUnknown(f) ? `unknown (${f.reason})` : say(f.value, f)
const yes = (b: unknown) => (b === true ? 'yes' : 'no')
const onOff = (b: unknown) => (b === true ? 'on' : 'off')
function ageWords(s: number): string {
  if (s < 90) return `${s} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}

export function factsLines(f: Facts): string[] {
  const g = f as Record<string, any>
  const out: string[] = []
  const liveness: Record<string, string> = {
    live: 'live',
    stale: 'stale (it stopped updating)',
    dead: 'not running',
    superseded: 'replaced by another bridge',
    none: 'no status.json',
  }
  out.push(
    `bridge: ${val(g.bridge, (v) => `${v.version}${v.commit ? ` (${v.commit})` : ''}, ${liveness[v.liveness] ?? v.liveness}, ${v.needs_restart ? 'restart needed (the code on disk is newer)' : 'no restart needed'}`)}`,
  )
  out.push(`app: ${val(g.app, (v) => `${v.version}${v.commit ? ` (${v.commit})` : ''} installed`)}`)
  if (g.supervisor) out.push(`supervisor: ${val(g.supervisor, (v) => v.version)}`)
  out.push(
    `latest release: ${val(g.latest_release, (v, k) => `${v} (as of ${k.as_of}, from ${k.source}${k.stale ? ', stale' : ''})`)}`,
  )
  out.push(`app behind: ${val(g.app_behind, (v) => `${v} release${v === 1 ? '' : 's'}`)}`)
  const r = g.relay
  out.push(`relay reachable: ${val(r.reachable, (v, k) => (v ? 'yes' : `no (${k.why})`))}`)
  out.push(
    `relay release: ${val(r.release, (v) =>
      v.state === 'latest'
        ? `on ${v.version} (the latest release)`
        : v.state === 'behind'
          ? `on ${v.version}, latest ${v.latest}`
          : v.state === 'ahead'
            ? `on ${v.version}, newer than the latest published (${v.latest})`
            : v.state === 'not-a-release'
              ? `not a release build${v.commit ? ` (commit ${v.commit})` : ''}`
              : `on ${v.version} (the latest release is not known)`,
    )}`,
  )
  out.push(`relay behind: ${val(r.behind, (v) => `${v} release${v === 1 ? '' : 's'}`)}`)
  out.push(`relay connected: ${val(r.connected, yes)}`)
  out.push(`relay via: ${val(r.via, (v) => v)}`)
  out.push(`relay auto-update: ${val(r.auto, onOff)}`)
  out.push(
    `relay last update: ${val(r.last_attempt, (v) => (v.state === 'none' ? 'none yet' : `${v.state} ${v.release} (${v.by}, ${v.at})`))}`,
  )
  out.push(`app auto-update: ${val(g.updates.app_auto_update, (v, k) => `${onOff(v)}${k.note ? ` (${k.note})` : ''}`)}`)
  out.push(
    `cards: ${val(g.cards, (v) => {
      const late = v.expired_pending ? ` (${v.expired_pending} more past their expiry, not swept yet)` : ''
      return v.pending === 0
        ? `none pending${late}`
        : `${v.pending} pending${late}, oldest ${ageWords(v.oldest_age_s ?? 0)}, kinds: ${Object.entries(v.kinds)
            .map(([k, n]) => `${k} ${n}`)
            .join(', ')}`
    })}`,
  )
  if (g.peers?.state === 'locked') out.push(`peers: locked (${g.peers.reason}), ${g.peers.count} linked`)
  else if (isUnknown(g.peers)) out.push(`peers: unknown (${g.peers.reason})`)
  else if (g.peers.value.length === 0) out.push('peers: none')
  else
    for (const p of g.peers.value)
      out.push(
        `peer ${p.name}: sends ${yes(p.sends)}, receives ${yes(p.receives)}, linked ${yes(p.linked)}, secret present ${val(p.secret_present, yes)}, needs re-link ${val(p.needs_relink, yes)}, copied from a legacy item ${val(p.copied_legacy, yes)}, last send ${val(p.last_send, (v) => `${v.state}${v.at ? ` (${v.at})` : ''}`)}`,
      )
  out.push(`lock: ${val(g.lock, onOff)}`)
  out.push(`os sandbox: ${val(g.os_sandbox, onOff)}`)
  out.push(
    `main: ${val(g.main, (v) => {
      const n = v.newest_finished
      const head = n
        ? `newest finished ${n.sha} ${n.verdict}, ${ageWords(n.age_s)} old${n.failed.length ? ` (failed: ${n.failed.join(', ')})` : ''}`
        : `no finished commit in the last ${v.looked_at}`
      const newer = v.newer.length ? `; newer: ${v.newer.map((c: any) => `${c.sha} ${c.state}`).join(', ')}` : ''
      return head + newer
    })}`,
  )
  return out
}

export async function cmdFacts(env: BridgeEnv, args: string[], io: CliIO, deps: FactsDeps = {}): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true })
  const facts = await collectFacts(env, { now: io.now, agent: io.isTerminal === false, ...deps })
  if (values.json) io.out(JSON.stringify(facts, null, 2))
  else for (const line of factsLines(facts)) io.out(line)
  return 0
}

// `talos-app facts` (docs/bridge.md "talos-app facts"): one read-only command that says what is true right now. Every field is
// known (value, source, as_of) or unknown (a reason); nothing is guessed; nothing is written; no secret, no card text, no
// keyed address ever comes out; the time is bounded even when every source hangs.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { runCli } from '../src/cli.ts'
import { loadEnv, paths } from '../src/config.ts'
import { parseConfig } from '../src/config-file.ts'
import {
  cmdFacts,
  collectFacts,
  type FactsDeps,
  factsLines,
  type GhRun,
  MAIN_CI_CONTEXTS,
  parseGitHubRepo,
} from '../src/facts.ts'
import { realRunAsync } from '../src/facts-dev.ts'
import { HISTORY_COPY_MAX, readHistory } from '../src/facts-parts.ts'
import { openHistory } from '../src/history-store.ts'
import { PeerLedger } from '../src/peer/ledger.ts'
import { PEER_SECRET_SERVICE, peerSecretAccount } from '../src/peer/records.ts'
import { COMMANDS } from '../src/talos.ts'
import { workerCliRefusal } from '../src/worker/cli-refusal.ts'
import { tempHome } from './helpers.ts'
import { memorySecrets } from './peer/helpers.ts'

const AT = '@' // an address with an at-sign in a source line reads as an email address to the personal check
const NOW = '2026-11-20T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const HOUR = 3_600_000
const SECRET = 'whsec_SEEDEDSECRETVALUE0123456789abcdef'
const CARD_TEXT = 'CARD-TEXT-PRIVATE-do-not-print'
const KEYED = 'https://relay.example.com/k_KEYEDPATH0123456789'
const rel = (v: string) => ({ tag_name: `mac-v${v}`, draft: false, prerelease: false })
const FEED = [rel('0.1.8'), rel('0.1.9'), rel('0.1.10')]
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

// ---- a world ------------------------------------------------------------------------------------------------------

type World = ReturnType<typeof world>
function world(o: { platform?: NodeJS.Platform; relayUrl?: string | null } = {}) {
  const root = realpathSync(tempHome('talos-facts-')) // macOS's /tmp is /private/tmp: the one real path
  const home = join(root, 'home')
  const user = join(root, 'user')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(user, { recursive: true })
  const clock = fakeClock(NOW)
  const secrets = memorySecrets()
  const calls = { health: 0, feed: 0, gh: [] as string[][], git: [] as string[][], plutil: 0 }
  const relayUrl = o.relayUrl === null ? undefined : (o.relayUrl ?? 'https://relay.example.com')
  const env = loadEnv({
    TALOS_APP_HOME: home,
    HOME: user,
    ...(relayUrl ? { TALOS_APP_RELAY_URL: relayUrl } : {}),
  })
  const deps: FactsDeps = {
    now: clock.now,
    clock,
    platform: o.platform ?? 'linux',
    alive: () => true,
    bridge: { version: '0.1.9', commit: 'abc1234' },
    fetch: async () => {
      calls.health++
      return Response.json({ ok: true, version: 'abc1234', release: '0.1.9' })
    },
    releaseFetch: async () => {
      calls.feed++
      return Response.json(FEED)
    },
    secrets,
    scratch: realpathSync(tempHome('talos-facts-scratch-')), // where the history copy is made: outside the snapshotted root
    checkout: root,
    git: async (args) => {
      calls.git.push(args)
      return undefined // not a git work tree
    },
    gh: async (args) => {
      calls.gh.push(args)
      return { code: 1, out: '' }
    },
  }
  const w = (name: string, v: unknown) =>
    writeFileSync(join(home, name), typeof v === 'string' ? v : JSON.stringify(v), { mode: 0o600 })
  return { root, home, user, clock, env, deps, secrets, calls, w }
}

const status = (over: Record<string, unknown> = {}) => ({
  v: 1,
  pid: 4242,
  instance: 'i1',
  started_at: '2026-11-20T09:00:00.000Z',
  mode: 'live',
  relay: { connected: true, last_connect_at: '2026-11-20T09:00:05.000Z', last_close_code: null },
  queue_depth: 0,
  unseen_oldest_at: null,
  permission_relay: false,
  permission_relay_declared: false,
  bridge_commit: 'abc1234',
  claude_session_marker_inherited: false,
  governor: null,
  last_owner_at: null,
  main_resend: false,
  last_stop_at: null,
  talos_channel: 'on',
  updated_at: NOW,
  ...over,
})

function writeConfig(home: string, patch: Record<string, unknown> = {}) {
  const example = JSON.parse(readFileSync(join(REPO_ROOT, 'examples', 'config.default.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const ok = parseConfig({ ...example, ...patch })
  if (!ok.ok) throw new Error(ok.message)
  writeFileSync(join(home, 'config.json'), JSON.stringify(ok.config), { mode: 0o600 })
}
const peer = (name: string) => ({ name, url: `https://${name}.example.com/hook/peer/cn_x`, daily_cap: 50 })

type SeedCard = { kind?: string; state?: string; created_at: string; title?: string; expires_at?: string }
type SeedSend = { peer: string; state: string; created_at: number }
/** history.sqlite as the bridge leaves it: made by the real opener, then closed (no -wal or -shm left). */
function seedHistory(home: string, o: { cards?: SeedCard[]; sends?: SeedSend[] }) {
  const store = openHistory(paths(home).historyDb)
  new PeerLedger(store.db)
  let n = 0
  for (const c of o.cards ?? [])
    store.db
      .query(
        "INSERT INTO cards (id, thread_id, binding_json, payload_hash, state, origin, risk, created_at, expires_at, actor) VALUES (?, 'general', ?, 'h', ?, 'agent', 'low', ?, ?, 'agent')",
      )
      .run(
        `card_${n++}`,
        JSON.stringify({ kind: c.kind ?? 'email', title: c.title ?? CARD_TEXT }),
        c.state ?? 'pending',
        c.created_at,
        c.expires_at ?? '2099-01-01T00:00:00.000Z',
      )
  for (const s of o.sends ?? [])
    store.db
      .query(
        'INSERT INTO peer_outbox (id, peer, body, label, created_at, next_at, attempts, state, detail) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)',
      )
      .run(`out_${n++}`, s.peer, CARD_TEXT, s.created_at, s.created_at, s.state, CARD_TEXT)
  store.close()
}

const PLIST = (extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>app.talos.desktop</string>
  <key>CFBundleShortVersionString</key><string>0.1.7</string>
  <key>CFBundleVersion</key><string>0.1.7.12</string>
  <key>TalosCheckout</key><string>/home/alex/checkout-path-never-printed</string>
${extra}</dict>
</plist>
`
/** Puts a Talos.app under <root>/<where>/ and makes the running process (ps) name it; returns the app folder. */
function installApp(w: World, plist: string | Buffer, where = 'Applications'): string {
  const app = join(w.root, where, 'Talos.app')
  mkdirSync(join(app, 'Contents'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'), plist)
  w.deps.ps = async () => `/usr/sbin/cron\n${app}/Contents/MacOS/Talos\n`
  return app
}

const hang = () => new Promise<never>(() => {})
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r))
}

// ---- reading the result -------------------------------------------------------------------------------------------

type Known = {
  value: any
  source: string
  as_of: string
  stale?: boolean
  why?: string
  note?: string
  found_by?: string
}
type Unknown = { state: 'unknown'; reason: string }
const isField = (x: unknown): x is Known | Unknown =>
  typeof x === 'object' && x !== null && ('value' in x || (x as Unknown).state === 'unknown')
const F = (x: unknown) => x as any
const known = (x: unknown): Known => {
  expect(isField(x) && (x as Unknown).state !== 'unknown', JSON.stringify(x)).toBe(true)
  return x as Known
}
const unknown = (x: unknown): Unknown => {
  expect(F(x)?.state, JSON.stringify(x)).toBe('unknown')
  expect(typeof F(x).reason).toBe('string')
  expect(F(x).reason.length).toBeGreaterThan(3)
  return x as Unknown
}

/** Every leaf field in the tree, with its path. */
function leaves(x: unknown, path = ''): Array<[string, Known | Unknown]> {
  if (isField(x)) {
    const out: Array<[string, Known | Unknown]> = [[path, x]]
    // a field's value may hold more fields (one per link)
    if ('value' in x && typeof x.value === 'object' && x.value !== null)
      for (const [k, v] of Object.entries(x.value)) out.push(...leaves(v, `${path}.value.${k}`))
    return out
  }
  if (Array.isArray(x)) return x.flatMap((v, i) => leaves(v, `${path}[${i}]`))
  if (typeof x === 'object' && x !== null)
    return Object.entries(x).flatMap(([k, v]) =>
      k === 'v' || k === 'as_of' ? [] : leaves(v, path ? `${path}.${k}` : k),
    )
  return []
}

const run = (w: World, over: Partial<FactsDeps> = {}) => collectFacts(w.env, { ...w.deps, ...over }) as Promise<any>

afterEach(() => {})

// ---- the shape ----------------------------------------------------------------------------------------------------

describe('the shape', () => {
  test('one object {v:1, as_of, fields}; every field is known with source and as_of, or unknown with a reason', async () => {
    const w = world()
    w.w('status.json', status())
    writeConfig(w.home, { peers: [peer('work')] })
    const f = await run(w)
    expect(f.v).toBe(1)
    expect(f.as_of).toBe(NOW)
    for (const k of ['bridge', 'latest_release', 'app_behind', 'relay', 'updates', 'cards', 'peers', 'lock', 'main'])
      expect(f, k).toHaveProperty(k)
    const all = leaves(f)
    expect(all.length).toBeGreaterThan(15)
    for (const [path, x] of all) {
      if ((x as Unknown).state === 'unknown') {
        expect(typeof (x as Unknown).reason, path).toBe('string')
        expect(Object.keys(x).sort(), path).toEqual(['reason', 'state'])
      } else {
        const k = x as Known
        expect(typeof k.source, path).toBe('string')
        expect(k.source.length, path).toBeGreaterThan(2)
        expect(Date.parse(k.as_of), `${path} as_of`).not.toBeNaN()
        expect(k.value, path).not.toBeUndefined()
      }
    }
  })

  test('the plain form is one line per field, in plain words', async () => {
    const w = world()
    w.w('status.json', status())
    writeConfig(w.home)
    const out: string[] = []
    const code = await cmdFacts(
      w.env,
      [],
      { out: (l) => out.push(l), err: () => {}, prompt: async () => '', sleep: async () => {}, now: w.clock.now },
      w.deps,
    )
    expect(code).toBe(0)
    const text = out.join('\n')
    expect(text).toMatch(/^bridge: 0\.1\.9 \(abc1234\), live, no restart needed$/m)
    expect(text).toMatch(/^lock: off$/m)
    expect(text).toMatch(/^relay reachable: yes$/m)
    expect(text).toMatch(/^cards: none pending$/m)
    expect(text).toMatch(/^app: unknown \(no desktop app here\)$/m)
    expect(text).toMatch(/^main: unknown \(not a source checkout\)$/m)
    expect(out.every((l) => !l.includes('\n'))).toBe(true)
    expect(out.length).toBeGreaterThanOrEqual(15)
  })
})

// ---- bridge -------------------------------------------------------------------------------------------------------

describe('bridge', () => {
  test('the version, the running commit, liveness, no restart needed', async () => {
    const w = world()
    w.w('status.json', status())
    const b = known((await run(w)).bridge)
    expect(b.value).toEqual({ version: '0.1.9', commit: 'abc1234', liveness: 'live', needs_restart: false })
    expect(b.source).toBe('status.json')
    expect(b.as_of).toBe(NOW)
  })

  test('the code on disk moved after the bridge started: needs_restart, and the running commit is named', async () => {
    const w = world()
    w.w('status.json', status({ bridge_commit: '1111111' }))
    const b = known((await run(w)).bridge)
    expect(b.value).toMatchObject({ commit: '1111111', needs_restart: true, liveness: 'live' })
  })

  test('no status.json: liveness none, the commit on disk, nothing to restart', async () => {
    const w = world()
    const b = known((await run(w)).bridge)
    expect(b.value).toEqual({ version: '0.1.9', commit: 'abc1234', liveness: 'none', needs_restart: false })
  })

  test('a status.json whose pid is gone is dead, whatever its stamp says', async () => {
    const w = world()
    w.w('status.json', status())
    const b = known((await run(w, { alive: () => false })).bridge)
    expect(b.value.liveness).toBe('dead')
  })

  test('a running bridge that never said its commit: the commit is unknown (null), never the disk one', async () => {
    const w = world()
    w.w('status.json', status({ bridge_commit: null }))
    const b = known((await run(w)).bridge)
    expect(b.value.commit).toBeNull()
  })
})

// ---- app (Mac) and the supervisor (elsewhere) ---------------------------------------------------------------------

describe('app', () => {
  test('off a Mac the field says so, and the supervisor is looked at instead', async () => {
    const w = world({ platform: 'linux' })
    const f = await run(w)
    expect(unknown(f.app).reason).toBe('no desktop app here')
    expect(f).toHaveProperty('supervisor')
  })

  test('a Mac reads CFBundleShortVersionString and the stamped commit from the XML plist', async () => {
    const w = world({ platform: 'darwin' })
    installApp(w, PLIST('  <key>TalosGitSha</key><string>abc1234</string>\n'))
    const a = known((await run(w)).app)
    expect(a.value).toEqual({ version: '0.1.7', commit: 'abc1234' })
    expect(a.source).toBe('Talos.app Info.plist')
  })

  test('the release commit (40 digits) wins over the build sha and is cut to 7; neither: no commit, said', async () => {
    const w = world({ platform: 'darwin' })
    const full = 'a'.repeat(7) + 'b'.repeat(33)
    installApp(
      w,
      PLIST(
        `  <key>TalosGitSha</key><string>1234567</string>\n  <key>TalosSourceCommit</key><string>${full}</string>\n`,
      ),
    )
    expect(known((await run(w)).app).value.commit).toBe('aaaaaaa')
    installApp(w, PLIST())
    const bare = known((await run(w)).app)
    expect(bare.value).toEqual({ version: '0.1.7', commit: null })
  })

  test('no app named by status.json, the running process or Spotlight: unknown, said', async () => {
    const w = world({ platform: 'darwin' })
    w.deps.ps = async () => '/usr/sbin/cron\n'
    w.deps.mdfind = async () => ''
    expect(unknown((await run(w)).app).reason).toMatch(/Talos\.app was not found/)
  })

  test('a binary plist goes through plutil (a Mac only); without it the version is unknown', async () => {
    const w = world({ platform: 'darwin' })
    const app = installApp(w, Buffer.concat([Buffer.from('bplist00'), Buffer.from([1, 2, 3, 4])]))
    let asked = ''
    const ok = await run(w, {
      plutil: async (p) => {
        asked = p
        return JSON.stringify({ CFBundleShortVersionString: '0.1.7', TalosGitSha: 'fedcba9' })
      },
    })
    expect(known(ok.app).value).toEqual({ version: '0.1.7', commit: 'fedcba9' })
    expect(asked).toBe(join(app, 'Contents', 'Info.plist'))
    expect(unknown((await run(w, { plutil: async () => undefined })).app).reason).toMatch(/binary plist/)
  })

  test('a plist with no version, or a version that is not a version, is unknown', async () => {
    const w = world({ platform: 'darwin' })
    installApp(w, PLIST().replace(/<key>CFBundleShortVersionString<\/key><string>[^<]*<\/string>/, ''))
    expect(unknown((await run(w)).app).reason).toMatch(/no version/)
    installApp(w, PLIST().replace('0.1.7<', '$(rm -rf)<'))
    expect(unknown((await run(w)).app).reason).toMatch(/no version/)
  })

  test('the build folder stamped in the plist is never printed', async () => {
    const w = world({ platform: 'darwin' })
    installApp(w, PLIST())
    expect(JSON.stringify(await run(w))).not.toContain('checkout-path-never-printed')
  })

  test('app_behind counts the releases newer than the installed app', async () => {
    const w = world({ platform: 'darwin' })
    installApp(w, PLIST().replace('0.1.7', '0.1.8'))
    const f = await run(w)
    expect(known(f.app_behind).value).toBe(2)
    installApp(w, PLIST().replace('0.1.7', '0.1.10'))
    expect(known((await run(w)).app_behind).value).toBe(0)
    installApp(w, PLIST().replace('0.1.7', '0.2.0'))
    expect(known((await run(w)).app_behind).value).toBe(0) // newer than the list: not behind
  })

  test('app_behind is unknown off a Mac, with no list, or for an app whose version is not X.Y.Z', async () => {
    const w = world({ platform: 'linux' })
    expect(unknown((await run(w)).app_behind).reason).toMatch(/no desktop app here/)
    const m = world({ platform: 'darwin' })
    installApp(m, PLIST())
    expect(
      unknown((await run(m, { releaseFetch: async () => new Response('no', { status: 500 }) })).app_behind).reason,
    ).toMatch(/release list/)
    const odd = world({ platform: 'darwin' })
    installApp(odd, PLIST().replace('0.1.7', '0.1.7-dev'))
    expect(unknown((await run(odd)).app_behind).reason).toMatch(/not a release version/)
  })

  test('the supervisor: no file, a file that names no version, a file that does', async () => {
    const w = world({ platform: 'linux' })
    expect(unknown((await run(w)).supervisor).reason).toMatch(/no supervisor has run/)
    w.w('supervisor-status.json', { state: 'running', supervisor: { pid: 7, updated: NOW } })
    expect(unknown((await run(w)).supervisor).reason).toMatch(/names no version/)
    w.w('supervisor-status.json', { state: 'running', supervisor: { pid: 7, updated: NOW, version: '0.1.9' } })
    const s = known((await run(w)).supervisor)
    expect(s.value).toEqual({ version: '0.1.9' })
    expect(s.source).toBe('supervisor-status.json')
  })
})

// ---- the release feed ---------------------------------------------------------------------------------------------

describe('latest_release', () => {
  const cache = (w: World, ageMs: number, versions = ['0.1.8', '0.1.9']) =>
    w.w('release-feed.json', { fetched_at: NOW_MS - ageMs, versions })

  test('a fresh cache answers with no request at all, as_of its own time', async () => {
    const w = world()
    cache(w, HOUR)
    const r = known((await run(w)).latest_release)
    expect(r.value).toBe('0.1.9')
    expect(r.source).toBe('release-feed.json')
    expect(r.as_of).toBe(new Date(NOW_MS - HOUR).toISOString())
    expect(r.stale).toBeUndefined()
    expect(w.calls.feed).toBe(0)
  })

  test('a stale cache is refreshed from GitHub for this answer, and the cache file is NOT rewritten', async () => {
    const w = world()
    cache(w, 7 * HOUR)
    const before = readFileSync(join(w.home, 'release-feed.json'), 'utf8')
    const mtime = statSync(join(w.home, 'release-feed.json')).mtimeMs
    const r = known((await run(w)).latest_release)
    expect(r.value).toBe('0.1.10')
    expect(r.source).toBe('GitHub releases')
    expect(r.as_of).toBe(NOW)
    expect(w.calls.feed).toBe(1)
    expect(readFileSync(join(w.home, 'release-feed.json'), 'utf8')).toBe(before)
    expect(statSync(join(w.home, 'release-feed.json')).mtimeMs).toBe(mtime)
  })

  test('no cache and a fetch that works: the list, and still no file written', async () => {
    const w = world()
    known((await run(w)).latest_release)
    expect(readdirSync(w.home)).not.toContain('release-feed.json')
  })

  test('feed stale and GitHub down: the old list, marked stale with its own date', async () => {
    const w = world()
    cache(w, 2 * 24 * HOUR)
    const r = known((await run(w, { releaseFetch: async () => new Response('no', { status: 503 }) })).latest_release)
    expect(r.value).toBe('0.1.9')
    expect(r.stale).toBe(true)
    expect(r.source).toBe('release-feed.json')
    expect(r.as_of).toBe(new Date(NOW_MS - 48 * HOUR).toISOString())
  })

  test('a cache older than 7 days is no answer: unknown, with why GitHub did not give one', async () => {
    const w = world()
    cache(w, 8 * 24 * HOUR)
    const r = unknown((await run(w, { releaseFetch: async () => new Response('no', { status: 403 }) })).latest_release)
    expect(r.reason).toMatch(/rate-limiting/)
    const o = world()
    expect(
      unknown(
        (
          await run(o, {
            releaseFetch: async () => {
              throw new Error(`boom ${KEYED}`)
            },
          })
        ).latest_release,
      ).reason,
    ).toMatch(/offline/)
  })
})

// ---- relay --------------------------------------------------------------------------------------------------------

describe('relay', () => {
  test('up, on the latest release, behind none, connected (a live bridge), via and auto from relay-connect.json', async () => {
    const w = world()
    w.w('status.json', status())
    w.w('relay-connect.json', {
      v: 1,
      via: 'token',
      kind: 'project',
      project_id: 'proj-0001',
      environment_id: 'env-0001',
      service_id: 'svc-0001',
      auto_update: true,
    })
    w.w('release-feed.json', { fetched_at: NOW_MS - HOUR, versions: ['0.1.8', '0.1.9'] })
    const r = (await run(w)).relay
    expect(known(r.reachable).value).toBe(true)
    expect(known(r.release).value).toEqual({ state: 'latest', version: '0.1.9', latest: '0.1.9' })
    expect(known(r.behind).value).toBe(0)
    expect(known(r.connected).value).toBe(true)
    expect(known(r.via).value).toBe('token')
    expect(known(r.auto).value).toBe(true)
    expect(known(r.last_attempt).value).toEqual({ state: 'none' })
    expect(known(r.reachable).source).toBe('GET /healthz')
  })

  test('behind: how many releases, and the last attempt (state, release, who, when)', async () => {
    const w = world()
    w.w('relay-connect.json', {
      v: 1,
      via: 'app',
      project_id: 'proj-0001',
      environment_id: 'env-0001',
      service_id: 'svc-0001',
      auto_update: false,
    })
    w.w('relay-auto.json', {
      v: 1,
      checked_at: NOW_MS - 5000,
      attempt: { release: '0.1.10', at: NOW_MS - 60_000, state: 'failed', by: 'auto', via: 'app', reason: 'a reason' },
    })
    const r = (await run(w, { fetch: async () => Response.json({ ok: true, version: 'abc1234', release: '0.1.8' }) }))
      .relay
    expect(known(r.release).value).toEqual({ state: 'behind', version: '0.1.8', latest: '0.1.10' })
    expect(known(r.behind).value).toBe(2)
    expect(known(r.via).value).toBe('app')
    expect(known(r.auto).value).toBe(false)
    expect(known(r.last_attempt).value).toEqual({
      state: 'failed',
      release: '0.1.10',
      by: 'auto',
      at: new Date(NOW_MS - 60_000).toISOString(),
    })
  })

  test('down: reachable is false (with why), and what needs it is unknown, not guessed', async () => {
    const w = world()
    const r = (
      await run(w, {
        fetch: async () => {
          throw new Error(`connect failed ${KEYED}`)
        },
      })
    ).relay
    const reach = known(r.reachable)
    expect(reach.value).toBe(false)
    expect(reach.why).toBe('did not answer')
    expect(unknown(r.release).reason).toMatch(/not reachable/)
    expect(unknown(r.behind).reason).toMatch(/not reachable/)
    expect(w.calls.feed).toBeLessThanOrEqual(1)
  })

  test('answers, but not ok (a 502): reachable false with the code', async () => {
    const w = world()
    const r = (await run(w, { fetch: async () => new Response('bad gateway', { status: 502 }) })).relay
    expect(known(r.reachable).value).toBe(false)
    expect(known(r.reachable).why).toBe('answered 502')
  })

  test('no relay URL is set: reachable is unknown', async () => {
    const w = world({ relayUrl: null })
    const r = (await run(w)).relay
    expect(unknown(r.reachable).reason).toMatch(/no relay URL/)
    expect(w.calls.health).toBe(0)
  })

  test('a relay built from main is not "behind", and a release newer than the list is not either', async () => {
    const w = world()
    w.w('release-feed.json', { fetched_at: NOW_MS - HOUR, versions: ['0.1.8', '0.1.9'] })
    const main = (await run(w, { fetch: async () => Response.json({ ok: true, version: 'abc1234' }) })).relay
    expect(known(main.release).value).toEqual({ state: 'not-a-release', commit: 'abc1234' })
    expect(unknown(main.behind).reason).toMatch(/not a release build/)
    const ahead = (await run(w, { fetch: async () => Response.json({ ok: true, release: '0.3.0' }) })).relay
    expect(known(ahead.release).value.state).toBe('ahead')
    expect(known(ahead.behind).value).toBe(0)
  })

  test('the relay says a release but the list cannot be had: the release is known, "behind" is not', async () => {
    const w = world()
    const r = (await run(w, { releaseFetch: async () => new Response('no', { status: 500 }) })).relay
    expect(known(r.release).value).toEqual({ state: 'unknown', version: '0.1.9' })
    expect(unknown(r.behind).reason).toMatch(/release list/)
  })

  test('connected needs a live bridge: no, stale or dead status.json is unknown', async () => {
    const w = world()
    expect(unknown((await run(w)).relay.connected).reason).toMatch(/no live bridge/)
    w.w('status.json', status({ relay: { connected: false, last_connect_at: null, last_close_code: 1006 } }))
    expect(known((await run(w)).relay.connected).value).toBe(false)
    expect(unknown((await run(w, { alive: () => false })).relay.connected).reason).toMatch(/no live bridge/)
  })

  test('no relay-connect.json: via is none and auto does not apply; a broken one is unknown, not "none"', async () => {
    const w = world()
    const r = (await run(w)).relay
    expect(known(r.via).value).toBe('none')
    expect(unknown(r.auto).reason).toMatch(/not connected/)
    w.w('relay-connect.json', '{not json')
    const b = (await run(w)).relay
    expect(unknown(b.via).reason).toMatch(/cannot be read/)
    expect(unknown(b.auto).reason).toMatch(/cannot be read/)
  })

  test('the relay address (it may carry a key) is in no field and no reason', async () => {
    const w = world({ relayUrl: KEYED })
    const down = await run(w, {
      fetch: async () => {
        throw new Error(`failed to fetch ${KEYED}`)
      },
    })
    expect(JSON.stringify(down)).not.toContain('KEYEDPATH')
    expect(JSON.stringify(await run(w))).not.toContain('KEYEDPATH')
  })
})

// ---- updates ------------------------------------------------------------------------------------------------------

describe('updates', () => {
  const desktop = (w: World, body: unknown) => {
    mkdirSync(join(w.user, 'Library', 'Application Support', 'Talos'), { recursive: true })
    writeFileSync(
      join(w.user, 'Library', 'Application Support', 'Talos', 'desktop.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
    )
  }

  test('on a Mac: the switch is desktop.json auto_update', async () => {
    const w = world({ platform: 'darwin' })
    desktop(w, { v: 1, auto_update: true, update_feed_url: 'https://feed.example.com/k_FEEDKEY' })
    const u = (await run(w)).updates
    expect(known(u.app_auto_update).value).toBe(true)
    expect(known(u.app_auto_update).source).toBe('desktop.json')
    desktop(w, { v: 1, auto_update: false })
    expect(known((await run(w)).updates.app_auto_update).value).toBe(false)
  })

  test('a desktop.json with no auto_update key reads as OFF (the app does the same); its feed address is never printed', async () => {
    const w = world({ platform: 'darwin' })
    desktop(w, { v: 1, update_feed_url: 'https://feed.example.com/k_FEEDKEY' })
    const f = await run(w)
    expect(known(f.updates.app_auto_update).value).toBe(false)
    expect(JSON.stringify(f)).not.toContain('FEEDKEY')
  })

  test('a desktop.json that is missing, not JSON, or has a switch that is not true/false is unknown', async () => {
    const w = world({ platform: 'darwin' })
    expect(unknown((await run(w)).updates.app_auto_update).reason).toMatch(/no desktop\.json/)
    desktop(w, '{oops')
    expect(unknown((await run(w)).updates.app_auto_update).reason).toMatch(/cannot be read/)
    desktop(w, { v: 1, auto_update: 'yes' })
    expect(unknown((await run(w)).updates.app_auto_update).reason).toMatch(/not true or false/)
  })

  test('off a Mac there is no app switch: unknown, said', async () => {
    const w = world({ platform: 'linux' })
    expect(unknown((await run(w)).updates.app_auto_update).reason).toMatch(/no app auto-update setting/)
  })

  test('the relay switch is the same file the relay section reads', async () => {
    const w = world()
    w.w('relay-connect.json', {
      v: 1,
      via: 'token',
      kind: 'account',
      project_id: 'proj-0001',
      environment_id: 'env-0001',
      service_id: 'svc-0001',
      auto_update: true,
    })
    const f = await run(w)
    expect(known(f.updates.relay_auto).value).toBe(true)
    expect(known(f.updates.relay_auto).source).toBe('relay-connect.json')
  })
})

// ---- cards --------------------------------------------------------------------------------------------------------

describe('cards', () => {
  test("pending count, the oldest one's age, and the kinds: counts only, never a card's text", async () => {
    const w = world()
    seedHistory(w.home, {
      cards: [
        { kind: 'email', created_at: new Date(NOW_MS - 3 * HOUR).toISOString() },
        { kind: 'email', created_at: new Date(NOW_MS - HOUR).toISOString() },
        { kind: 'permission', created_at: new Date(NOW_MS - 2 * HOUR).toISOString() },
        { kind: 'email', state: 'approved', created_at: new Date(NOW_MS - 9 * HOUR).toISOString() },
        { kind: 'not-a-kind-we-know', created_at: new Date(NOW_MS - 60_000).toISOString() },
      ],
    })
    const c = known((await run(w)).cards)
    expect(c.value).toEqual({
      pending: 4,
      expired_pending: 0,
      oldest_age_s: 3 * 3600,
      kinds: { other: 1, email: 2, permission: 1 },
    })
    expect(c.source).toBe('history.sqlite')
    expect(JSON.stringify(c)).not.toContain(CARD_TEXT)
  })

  test('no history.sqlite yet: nothing pending, said', async () => {
    const w = world()
    const c = known((await run(w)).cards)
    expect(c.value).toEqual({ pending: 0, expired_pending: 0, oldest_age_s: null, kinds: {} })
    expect(c.source).toBe('history.sqlite (not created yet)')
    expect(readdirSync(w.home)).not.toContain('history.sqlite')
  })

  test('a history.sqlite that is not a database is unknown', async () => {
    const w = world()
    w.w('history.sqlite', 'this is not a sqlite file at all, padding padding padding')
    expect(unknown((await run(w)).cards).reason).toMatch(/cannot be read/)
  })

  test('a live bridge (its -wal and -shm are there) is read through them, and sees what is not checkpointed yet', async () => {
    const w = world()
    seedHistory(w.home, { cards: [] })
    const live = new Database(paths(w.home).historyDb)
    live.exec('PRAGMA journal_mode = WAL')
    live.exec('PRAGMA wal_autocheckpoint = 0')
    live
      .query(
        "INSERT INTO cards (id, thread_id, binding_json, payload_hash, state, origin, risk, created_at, expires_at, actor) VALUES ('c1', 't', ?, 'h', 'pending', 'agent', 'low', ?, '2099-01-01T00:00:00.000Z', 'agent')",
      )
      .run(JSON.stringify({ kind: 'email', title: CARD_TEXT }), new Date(NOW_MS - 120_000).toISOString())
    try {
      expect(readdirSync(w.home)).toContain('history.sqlite-wal')
      const c = known((await run(w)).cards)
      expect(c.value.pending).toBe(1)
      expect(c.value.oldest_age_s).toBe(120)
    } finally {
      live.close()
    }
  })

  test('a -wal with no -shm (a writer mid-start or a crash) is unknown, never a read that would make files', async () => {
    const w = world()
    seedHistory(w.home, { cards: [{ created_at: NOW }] })
    // macOS leaves a closed database's -wal and -shm in place; this case is "a -wal and no -shm", whatever the platform did
    for (const f of ['history.sqlite-wal', 'history.sqlite-shm']) rmSync(join(w.home, f), { force: true })
    writeFileSync(join(w.home, 'history.sqlite-wal'), '')
    const c = unknown((await run(w)).cards)
    expect(c.reason).toMatch(/in use/)
    expect(readdirSync(w.home)).not.toContain('history.sqlite-shm')
  })
})

// ---- peers --------------------------------------------------------------------------------------------------------

describe('peers', () => {
  const inbound = (w: World, names: string[]) =>
    w.w('peers-inbound.json', { v: 1, peers: names.map((name) => ({ name, conn_id: `cn_${name}` })) })
  const setSecret = (w: World, name: string) =>
    w.secrets.data.set(`${PEER_SECRET_SERVICE}\u0000${peerSecretAccount(name)}`, SECRET)

  test('each link: name, sends/receives, linked, the secret present yes/no, no re-link, no copy mark', async () => {
    const w = world()
    writeConfig(w.home, { peers: [peer('work'), peer('home')] })
    inbound(w, ['work', 'home', 'atlas'])
    setSecret(w, 'work')
    seedHistory(w.home, {
      sends: [
        { peer: 'work', state: 'sent', created_at: NOW_MS - 3 * HOUR },
        { peer: 'work', state: 'refused', created_at: NOW_MS - 2 * HOUR },
        { peer: 'work', state: 'sent', created_at: NOW_MS - HOUR },
      ],
    })
    const p = known((await run(w)).peers)
    expect(p.source).toBe('config.json')
    const by = Object.fromEntries((p.value as any[]).map((x) => [x.name, x]))
    expect(Object.keys(by).sort()).toEqual(['atlas', 'home', 'work'])
    expect(by.work).toMatchObject({ name: 'work', sends: true, receives: true, linked: true })
    expect(known(by.work.secret_present).value).toBe(true)
    expect(known(by.work.needs_relink).value).toBe(false)
    expect(known(by.work.copied_legacy).value).toBe(false)
    expect(known(by.work.last_send).value).toEqual({ state: 'ok', at: new Date(NOW_MS - HOUR).toISOString() })
    expect(by.atlas).toMatchObject({ sends: false, receives: true, linked: false })
    expect(unknown(by.atlas.secret_present).reason).toMatch(/does not send/)
  })

  test('a link whose secret is missing needs re-linking (the same rule as peer list and doctor)', async () => {
    const w = world()
    writeConfig(w.home, { peers: [peer('work')] })
    inbound(w, ['work'])
    const by = (known((await run(w)).peers).value as any[])[0]
    expect(known(by.secret_present).value).toBe(false)
    expect(known(by.needs_relink).value).toBe(true)
  })

  test('the copied-legacy mark, and a copy the other side rejected, which needs re-linking', async () => {
    const w = world()
    writeConfig(w.home, { peers: [peer('work'), peer('home')] })
    inbound(w, ['work', 'home'])
    setSecret(w, 'work')
    setSecret(w, 'home')
    w.w('peer-copied.json', {
      v: 1,
      copied: [
        { name: 'work', copied_at: 1 },
        { name: 'home', copied_at: 1, rejected_at: 2 },
      ],
    })
    const by = Object.fromEntries((known((await run(w)).peers).value as any[]).map((x) => [x.name, x]))
    expect(known(by.work.copied_legacy).value).toBe(true)
    expect(known(by.work.needs_relink).value).toBe(false)
    expect(known(by.home.copied_legacy).value).toBe(true)
    expect(known(by.home.needs_relink).value).toBe(true)
  })

  test("the last send: pending, gave up, none yet; a message's text is never read out", async () => {
    const w = world()
    writeConfig(w.home, { peers: [peer('work'), peer('home'), peer('atlas')] })
    setSecret(w, 'work')
    seedHistory(w.home, {
      sends: [
        { peer: 'work', state: 'pending', created_at: NOW_MS - 1000 },
        { peer: 'home', state: 'gave_up', created_at: NOW_MS - 5000 },
      ],
    })
    const f = await run(w)
    const by = Object.fromEntries((known(f.peers).value as any[]).map((x) => [x.name, x]))
    expect(known(by.work.last_send).value.state).toBe('pending')
    expect(known(by.home.last_send).value).toEqual({ state: 'gave_up', at: new Date(NOW_MS - 5000).toISOString() })
    expect(known(by.atlas.last_send).value).toEqual({ state: 'none' })
    expect(JSON.stringify(f)).not.toContain(CARD_TEXT)
  })

  test('a key store that cannot be read: the secret and the re-link verdict are unknown for each link, the rest still answers', async () => {
    const w = world()
    writeConfig(w.home, { peers: [peer('work')] })
    inbound(w, ['work'])
    const broken: SecretStore = {
      backend: 'file_0600',
      strength: 'file',
      get: async () => {
        throw new Error('facts must not read a value')
      },
      set: async () => {},
      delete: async () => {},
      has: async () => {
        throw new Error(`the keyring said ${SECRET}`)
      },
    }
    const f = await run(w, { secrets: broken })
    const by = (known(f.peers).value as any[])[0]
    expect(unknown(by.secret_present).reason).toMatch(/key store/)
    expect(unknown(by.needs_relink).reason).toMatch(/key store/)
    expect(by.linked).toBe(true)
    expect(JSON.stringify(f)).not.toContain(SECRET)
  })

  test('no links: an empty list; an unreadable config.json: unknown', async () => {
    const w = world()
    writeConfig(w.home)
    expect(known((await run(w)).peers).value).toEqual([])
    const bad = world()
    bad.w('config.json', '{"version": 9}')
    expect(unknown((await run(bad)).peers).reason).toMatch(/config\.json/)
    const none = world()
    expect(unknown((await run(none)).peers).reason).toMatch(/no config\.json/)
  })

  test('a store with no item for the home but a legacy one: present (the first real read moves or copies it); asked with has() only', async () => {
    const w = world()
    writeConfig(w.home, { peers: [peer('work')] })
    const scoped: SecretStore = {
      backend: 'secret_service',
      strength: 'os_keyring',
      get: async () => {
        throw new Error('facts never reads a secret value')
      },
      set: async () => {
        throw new Error('facts never writes the key store')
      },
      delete: async () => {
        throw new Error('facts never writes the key store')
      },
      has: async (service) => (service === PEER_SECRET_SERVICE ? true : false),
    }
    const by = (known((await run(w, { secrets: scoped })).peers).value as any[])[0]
    expect(known(by.secret_present).value).toBe(true)
  })
})

// ---- lock ---------------------------------------------------------------------------------------------------------

describe('lock', () => {
  test('Lock Talos settings on or off, from config.json', async () => {
    const w = world()
    writeConfig(w.home, { settings_lock: true })
    expect(known((await run(w)).lock).value).toBe(true)
    writeConfig(w.home, { settings_lock: false })
    const l = known((await run(w)).lock)
    expect(l.value).toBe(false)
    expect(l.source).toBe('config.json')
  })

  test('no config.json, or one that does not parse: unknown, with the reason', async () => {
    const w = world()
    expect(unknown((await run(w)).lock).reason).toMatch(/no config\.json/)
    w.w('config.json', '{"version": 9}')
    expect(unknown((await run(w)).lock).reason).toMatch(/not valid/)
  })
})

describe('os sandbox (the extra lock on protected files)', () => {
  test('on, off or absent (off) from config.json, with the text line; unknown when the config cannot be read', async () => {
    const w = world()
    expect(unknown((await run(w)).os_sandbox).reason).toMatch(/no config\.json/)
    writeConfig(w.home, {})
    expect(known((await run(w)).os_sandbox).value).toBe(false)
    writeConfig(w.home, { os_sandbox: true })
    const f = await run(w)
    expect(known(f.os_sandbox).value).toBe(true)
    expect(known(f.os_sandbox).source).toBe('config.json')
    expect(factsLines(f)).toContain('os sandbox: on')
  })
})

// ---- main (a source checkout only) --------------------------------------------------------------------------------

const CONTEXTS = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString()
type St = { context: string; state: string; description?: string }
const allSix = (state = 'success'): St[] =>
  CONTEXTS.map((c) => ({ context: `local-ci/${c}`, state, description: `passed on ci-runner in 400s` }))

/** A stub `gh`: signed in unless told not; the commit list and each commit's statuses (newest first, as GitHub lists them). */
function stubGh(o: {
  commits: Array<{ sha: string; age: number; statuses: St[] }>
  signedIn?: boolean
  missing?: boolean
  noList?: boolean
}) {
  const calls: string[][] = []
  const gh: GhRun = async (args) => {
    calls.push(args)
    if (o.missing) return { code: null, out: '', missing: true }
    if (args[0] === 'auth')
      return {
        code: o.signedIn === false ? 1 : 0,
        out: 'Logged in to github.com account PRIVATE-NAME (keyring)\nToken: gho_SECRETTOKEN',
      }
    const url = args.find((a) => a.startsWith('repos/')) ?? ''
    if (/\/commits\?/.test(url)) {
      if (o.noList) return { code: 1, out: 'HTTP 404' }
      return {
        code: 0,
        out: JSON.stringify(
          o.commits.map((c) => ({
            sha: c.sha,
            commit: {
              message: CARD_TEXT,
              committer: { date: ago(c.age), name: 'Private Name' },
              author: { email: 'alex@example.com' },
            },
          })),
        ),
      }
    }
    const m = /\/commits\/([0-9a-f]+)\/statuses/.exec(url)
    const c = o.commits.find((x) => x.sha === m?.[1])
    return c
      ? {
          code: 0,
          out: JSON.stringify(
            c.statuses.map((s) => ({
              ...s,
              creator: { login: 'someone' },
              target_url: 'https://ci.example.com/x?token=T',
            })),
          ),
        }
      : { code: 1, out: 'HTTP 404' }
  }
  return { gh, calls }
}
const sha = (n: number) => `${String(n).repeat(7)}${'0'.repeat(33)}`.slice(0, 40)

function checkoutWorld(gh: GhRun, remote = `https://x-access-token:ghp_SECRETTOKEN${AT}github.com/acme/widgets.git`) {
  const w = world()
  const git: FactsDeps['git'] = async (args) => {
    w.calls.git.push(args)
    if (args[0] === 'rev-parse') return w.root
    if (args[0] === 'remote') return remote
    return undefined
  }
  mkdirSync(join(w.root, 'apps', 'bridge', 'src'), { recursive: true })
  writeFileSync(join(w.root, 'apps', 'bridge', 'src', 'version.ts'), '')
  mkdirSync(join(w.root, 'docs'), { recursive: true })
  writeFileSync(join(w.root, 'docs', 'CI-MACHINES.md'), '')
  return { w, deps: { git, gh } satisfies Partial<FactsDeps> }
}

describe('main', () => {
  test('the six contexts are the ones the CI runner reads (scripts/ci-runner.sh CI_CONTEXTS)', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'ci-runner.sh'), 'utf8')
    const line = /^CI_CONTEXTS="([^"]+)"/m.exec(src)?.[1]
    expect(line?.split(' ')).toEqual([...MAIN_CI_CONTEXTS])
    expect([...MAIN_CI_CONTEXTS]).toEqual(CONTEXTS)
  })

  test('all six succeeded: the newest finished commit is green, with its age', async () => {
    const { gh, calls } = stubGh({
      commits: [
        { sha: sha(1), age: 2 * HOUR, statuses: allSix() },
        { sha: sha(2), age: 5 * HOUR, statuses: allSix() },
      ],
    })
    const { w, deps } = checkoutWorld(gh)
    const m = known((await run(w, deps)).main)
    expect(m.source).toBe('gh api commit statuses')
    expect(m.value).toEqual({
      newest_finished: { sha: '1111111', age_s: 7200, verdict: 'green', failed: [] },
      newer: [],
      last_green: { sha: '1111111', age_s: 7200 },
      looked_at: 2,
    })
    // read-only: only GETs of commit lists and statuses
    for (const a of calls) {
      expect(a[0] === 'auth' || a[0] === 'api').toBe(true)
      expect(a).not.toContain('--method')
      expect(a).not.toContain('-X')
      expect(a).not.toContain('POST')
    }
  })

  test('one status red: the commit is red and names the failed one; the last green is the one before', async () => {
    const red = allSix().map((s) =>
      s.context === 'local-ci/desktop' ? { ...s, state: 'failure', description: 'failed on ci-runner' } : s,
    )
    const { gh } = stubGh({
      commits: [
        { sha: sha(1), age: HOUR, statuses: red },
        { sha: sha(2), age: 3 * HOUR, statuses: allSix() },
      ],
    })
    const { w, deps } = checkoutWorld(gh)
    const m = known((await run(w, deps)).main)
    expect(m.value.newest_finished).toEqual({ sha: '1111111', age_s: 3600, verdict: 'red', failed: ['desktop'] })
    expect(m.value.last_green).toEqual({ sha: '2222222', age_s: 10800 })
  })

  test('newer commits still pending (or with no status yet) are listed; the newest FINISHED one is still reported', async () => {
    const pending = allSix().map((s, i) => (i < 3 ? { ...s, state: 'pending', description: 'running' } : s))
    const { gh } = stubGh({
      commits: [
        { sha: sha(1), age: 60_000, statuses: [] },
        { sha: sha(2), age: 600_000, statuses: pending },
        { sha: sha(3), age: 2 * HOUR, statuses: allSix() },
      ],
    })
    const { w, deps } = checkoutWorld(gh)
    const m = known((await run(w, deps)).main)
    expect(m.value.newest_finished.sha).toBe('3333333')
    expect(m.value.newest_finished.verdict).toBe('green')
    expect(m.value.newer).toEqual([
      { sha: '1111111', age_s: 60, state: 'no status yet' },
      { sha: '2222222', age_s: 600, state: 'pending', pending: ['check', 'mod', 'browser'] },
    ])
  })

  test('five of six reported, or an extra local-ci/linux: only the six count (the newest status of each wins)', async () => {
    const five = allSix().slice(0, 5)
    const extra = [
      { context: 'local-ci/linux', state: 'failure' },
      ...allSix(),
      { context: 'local-ci/check', state: 'failure', description: 'older, listed later' },
    ]
    const { gh } = stubGh({
      commits: [
        { sha: sha(1), age: HOUR, statuses: five },
        { sha: sha(2), age: 2 * HOUR, statuses: extra },
      ],
    })
    const { w, deps } = checkoutWorld(gh)
    const m = known((await run(w, deps)).main)
    expect(m.value.newer).toEqual([{ sha: '1111111', age_s: 3600, state: 'partial' }])
    expect(m.value.newest_finished).toMatchObject({ sha: '2222222', verdict: 'green' })
  })

  test('looks at 10 commits at most, one request each, in parallel', async () => {
    const commits = Array.from({ length: 14 }, (_, i) => ({
      sha: sha((i % 9) + 1),
      age: (i + 1) * HOUR,
      statuses: [] as St[],
    }))
    // distinct shas
    commits.forEach((c, i) => {
      c.sha = `${(i + 10).toString(16).padStart(2, '0')}${'a'.repeat(38)}`
    })
    const { gh, calls } = stubGh({ commits })
    const { w, deps } = checkoutWorld(gh)
    const m = known((await run(w, deps)).main)
    expect(m.value.looked_at).toBe(10)
    expect(m.value.newest_finished).toBeNull()
    expect(calls.filter((a) => a.some((x) => /\/statuses/.test(x))).length).toBe(10)
  })

  test('not a source checkout: unknown, and gh is never run', async () => {
    const stub = stubGh({ commits: [] })
    const w = world()
    const f = await run(w, { gh: stub.gh })
    expect(unknown(f.main).reason).toBe('not a source checkout')
    expect(stub.calls).toEqual([])
    // a git work tree that is not this repo (no CI marker: a user's clone of the public tree)
    const { w: u, deps } = checkoutWorld(stub.gh)
    require('node:fs').rmSync(join(u.root, 'docs', 'CI-MACHINES.md'))
    expect(unknown((await run(u, deps)).main).reason).toBe('not a source checkout')
    expect(stub.calls).toEqual([])
  })

  test('gh not signed in, gh missing, origin not on GitHub, GitHub refusing: each is unknown with its own words', async () => {
    const a = stubGh({ commits: [], signedIn: false })
    const x = checkoutWorld(a.gh)
    expect(unknown((await run(x.w, x.deps)).main).reason).toBe('gh not signed in')
    const b = stubGh({ commits: [], missing: true })
    const y = checkoutWorld(b.gh)
    expect(unknown((await run(y.w, y.deps)).main).reason).toBe('gh is not installed')
    const c = stubGh({ commits: [] })
    const z = checkoutWorld(c.gh, 'https://git.example.com/acme/widgets.git')
    expect(unknown((await run(z.w, z.deps)).main).reason).toBe('origin is not a GitHub repository')
    expect(c.calls).toEqual([])
    const d = stubGh({ commits: [], noList: true })
    const q = checkoutWorld(d.gh)
    expect(unknown((await run(q.w, q.deps)).main).reason).toBe('GitHub did not give the commit list')
  })

  test('parseGitHubRepo: https, ssh and scp forms; a token in the address is dropped; anything else is nothing', () => {
    expect(parseGitHubRepo('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(parseGitHubRepo(`https://user:tok${AT}github.com/acme/widgets`)).toBe('acme/widgets')
    expect(parseGitHubRepo(`git${AT}github.com:acme/widgets.git`)).toBe('acme/widgets')
    expect(parseGitHubRepo(`ssh://git${AT}github.com/acme/widgets.git`)).toBe('acme/widgets')
    expect(parseGitHubRepo('https://gitlab.com/acme/widgets.git')).toBeUndefined()
    expect(parseGitHubRepo('https://github.com/acme/widgets/extra')).toBeUndefined()
    expect(parseGitHubRepo('https://github.com/ac me/widgets')).toBeUndefined()
    expect(parseGitHubRepo('')).toBeUndefined()
  })

  test('with a real git work tree: the origin is read with git (token in it never leaves), the checkout markers decide', async () => {
    const w = world()
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const g = (...a: string[]) => spawnSync('git', a, { cwd: w.root, encoding: 'utf8' })
    expect(g('init', '-q').status).toBe(0)
    expect(
      g('remote', 'add', 'origin', `https://x-access-token:ghp_REALTOKENVALUE${AT}github.com/acme/widgets.git`).status,
    ).toBe(0)
    mkdirSync(join(w.root, 'apps', 'bridge', 'src'), { recursive: true })
    writeFileSync(join(w.root, 'apps', 'bridge', 'src', 'version.ts'), '')
    mkdirSync(join(w.root, 'docs'), { recursive: true })
    writeFileSync(join(w.root, 'docs', 'CI-MACHINES.md'), '')
    const stub = stubGh({ commits: [{ sha: sha(1), age: HOUR, statuses: allSix() }] })
    const f = await collectFacts(w.env, { ...w.deps, git: undefined, gh: stub.gh })
    expect(known(f.main as never).value.newest_finished.verdict).toBe('green')
    expect(stub.calls.some((a) => a.includes('repos/acme/widgets/commits?sha=main&per_page=10'))).toBe(true)
    expect(JSON.stringify(f)).not.toContain('REALTOKEN')
  })

  test('what gh prints (a name, a token, a commit message, an email, a link with a token) is never in the output', async () => {
    const { gh } = stubGh({ commits: [{ sha: sha(1), age: HOUR, statuses: allSix() }] })
    const { w, deps } = checkoutWorld(gh)
    const s = JSON.stringify(await run(w, deps))
    for (const bad of [
      'PRIVATE-NAME',
      'SECRETTOKEN',
      CARD_TEXT,
      'Private Name',
      'alex@example.com',
      'token=T',
      'someone',
      'acme',
      'widgets',
    ])
      expect(s, bad).not.toContain(bad)
  })
})

// ---- read-only ----------------------------------------------------------------------------------------------------

/** Every file and folder under `dir`: path, kind, size and mtime. A new file, a deleted one, a rewrite: all show. */
function snapshot(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const n of readdirSync(join(dir, rel)).sort()) {
    const p = join(rel, n)
    const st = require('node:fs').lstatSync(join(dir, p))
    out.push(`${p}|${st.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`)
    if (st.isDirectory()) out.push(...snapshot(dir, p))
  }
  return out
}

describe('read-only', () => {
  function fullHome(platform: NodeJS.Platform) {
    const w = world({ platform })
    w.w('status.json', status())
    writeConfig(w.home, { peers: [peer('work'), peer('home')], settings_lock: true })
    w.w('peers-inbound.json', { v: 1, peers: [{ name: 'work', conn_id: 'cn_work' }] })
    w.w('peer-copied.json', { v: 1, copied: [{ name: 'home', copied_at: 1 }] })
    w.w('relay-connect.json', {
      v: 1,
      via: 'token',
      kind: 'project',
      project_id: 'proj-0001',
      environment_id: 'env-0001',
      service_id: 'svc-0001',
      auto_update: true,
    })
    w.w('relay-auto.json', { v: 1, checked_at: NOW_MS - 1000 })
    w.w('release-feed.json', { fetched_at: NOW_MS - 9 * HOUR, versions: ['0.1.8', '0.1.9'] }) // stale: a fetch is tried
    w.w('supervisor-status.json', { supervisor: { pid: 1, updated: NOW } })
    w.secrets.data.set(`${PEER_SECRET_SERVICE}\u0000${peerSecretAccount('work')}`, SECRET)
    seedHistory(w.home, {
      cards: [{ created_at: ago(HOUR) }],
      sends: [{ peer: 'work', state: 'sent', created_at: NOW_MS - HOUR }],
    })
    mkdirSync(join(w.user, 'Library', 'Application Support', 'Talos'), { recursive: true })
    writeFileSync(
      join(w.user, 'Library', 'Application Support', 'Talos', 'desktop.json'),
      JSON.stringify({ v: 1, auto_update: true }),
    )
    installApp(w, PLIST())
    return w
  }

  for (const platform of ['darwin', 'linux'] as const)
    test(`${platform}: no file under the home, the user folder or the app folder changes (path, size, mtime: all the same)`, async () => {
      const w = fullHome(platform)
      const before = snapshot(w.root)
      const f = await run(w)
      expect(known(f.cards).value.pending).toBe(1)
      expect(snapshot(w.root)).toEqual(before)
      // asked twice, and as the command: still the same
      await cmdFacts(
        w.env,
        ['--json'],
        { out: () => {}, err: () => {}, prompt: async () => '', sleep: async () => {}, now: w.clock.now },
        w.deps,
      )
      expect(snapshot(w.root)).toEqual(before)
    })

  test('with a live bridge holding history.sqlite open (-wal and -shm there): nothing changes either', async () => {
    const w = fullHome('linux')
    const live = new Database(paths(w.home).historyDb)
    live.exec('PRAGMA journal_mode = WAL')
    live.exec("INSERT INTO kv (key, value) VALUES ('x', 'y')")
    try {
      const before = snapshot(w.root)
      expect(known((await run(w)).cards).value.pending).toBe(1)
      expect(snapshot(w.root)).toEqual(before)
    } finally {
      live.close()
    }
  })

  test('no home at all: it still answers (unknown fields) and creates no folder or file', async () => {
    const w = world()
    require('node:fs').rmSync(w.home, { recursive: true })
    const before = snapshot(w.root)
    const f = await run(w)
    expect(known(f.bridge).value.liveness).toBe('none')
    expect(snapshot(w.root)).toEqual(before)
  })

  test('the key store is only asked whether an item is there: facts never calls set or delete, and a Linux home with no chosen store is not given one', async () => {
    const w = fullHome('linux')
    let wrote = 0
    const store: SecretStore = {
      backend: 'secret_service',
      strength: 'os_keyring',
      get: async () => {
        wrote++ // a read of a value is as forbidden as a write
        return SECRET
      },
      set: async () => void wrote++,
      delete: async () => void wrote++,
      has: async () => true,
    }
    await run(w, { secrets: store })
    expect(wrote).toBe(0)
    // the real opener, with nothing chosen yet: it must not probe, write secret-backend, or make a folder
    const bare = world({ platform: 'linux' })
    writeConfig(bare.home, { peers: [peer('work')] })
    const before = snapshot(bare.root)
    const f = await collectFacts(bare.env, { ...bare.deps, secrets: undefined })
    expect(unknown((known(f.peers as never).value as any[])[0].secret_present).reason).toMatch(
      /no key store has been chosen/,
    )
    expect(snapshot(bare.root)).toEqual(before)
  })
})

// ---- no secret, no text -------------------------------------------------------------------------------------------

describe('nothing private comes out', () => {
  test("a seeded secret, a card's text, a message body and a keyed relay address are in neither form", async () => {
    const w = world({ relayUrl: KEYED })
    w.w('status.json', status())
    writeConfig(w.home, { peers: [peer('work')] })
    w.w('peers-inbound.json', { v: 1, peers: [{ name: 'work', conn_id: 'cn_SECRETCONNID' }] })
    w.secrets.data.set(`${PEER_SECRET_SERVICE}\u0000${peerSecretAccount('work')}`, SECRET)
    w.w('relay-connect.json', {
      v: 1,
      via: 'token',
      kind: 'project',
      project_id: 'PROJECTID123',
      environment_id: 'env-0001',
      service_id: 'svc-0001',
      domain: 'relay.example.com',
      auto_update: true,
    })
    seedHistory(w.home, {
      cards: [{ created_at: ago(HOUR), title: CARD_TEXT }],
      sends: [{ peer: 'work', state: 'refused', created_at: NOW_MS - 1000 }],
    })
    const f = await run(w, {
      fetch: async () => Response.json({ ok: true, version: 'abc1234', release: '0.1.9', secret: SECRET }),
    })
    const out: string[] = []
    await cmdFacts(
      w.env,
      [],
      {
        out: (l) => out.push(l),
        err: (l) => out.push(l),
        prompt: async () => '',
        sleep: async () => {},
        now: w.clock.now,
      },
      w.deps,
    )
    const json: string[] = []
    await cmdFacts(
      w.env,
      ['--json'],
      {
        out: (l) => json.push(l),
        err: (l) => json.push(l),
        prompt: async () => '',
        sleep: async () => {},
        now: w.clock.now,
      },
      w.deps,
    )
    for (const text of [JSON.stringify(f), out.join('\n'), json.join('\n')])
      for (const bad of [
        SECRET,
        'SEEDEDSECRET',
        CARD_TEXT,
        'KEYEDPATH',
        'SECRETCONNID',
        'PROJECTID123',
        'conn_id',
        'cn_x',
      ])
        expect(text, bad).not.toContain(bad)
  })
})

// ---- time ---------------------------------------------------------------------------------------------------------

describe('time', () => {
  test('every source hangs: each is cut at 5 s (parallel), so the whole command is back at 5 s, not 8', async () => {
    const { gh } = stubGh({ commits: [] })
    const { w, deps } = checkoutWorld(async (args, o) => {
      void gh
      void args
      void o
      return hang()
    })
    writeConfig(w.home, { peers: [peer('work')] })
    w.w('peers-inbound.json', { v: 1, peers: [{ name: 'work', conn_id: 'cn_w' }] })
    const hungSecrets: SecretStore = {
      backend: 'secret_service',
      strength: 'os_keyring',
      get: hang,
      set: hang,
      delete: hang,
      has: hang,
    }
    let done = false
    const p = run(w, { ...deps, fetch: hang, releaseFetch: hang, secrets: hungSecrets }).then((f) => {
      done = true
      return f
    })
    await settle()
    expect(done).toBe(false)
    w.clock.advance(4999)
    await settle()
    expect(done).toBe(false)
    w.clock.advance(1) // 5 000 ms in all
    const f = await p
    expect(done).toBe(true)
    expect(f.as_of).toBe(NOW)
    expect(known(f.relay.reachable).value).toBe(false)
    expect(known(f.relay.reachable).why).toBe('no answer in 5 s')
    expect(unknown(f.latest_release).reason).toBe('no answer in 5 s')
    expect(unknown(f.main).reason).toBe('no answer in 5 s')
    expect(unknown((known(f.peers).value as any[])[0].secret_present).reason).toBe('no answer in 5 s')
    // what needs no network still answers
    expect(known(f.bridge).value.liveness).toBe('none')
    expect(f.lock).toBeDefined()
    expect(w.clock.pending).toBe(0) // no timer left behind
  })

  test('sources that answer at once leave no timer behind and do not wait for the deadline', async () => {
    const w = world()
    await run(w)
    expect(w.clock.pending).toBe(0)
  })

  test('one source slow, the others fast: the fast ones are not held back by it', async () => {
    const w = world()
    let release: (() => void) | undefined
    const slow = new Promise<Response>((r) => {
      release = () => r(Response.json({ ok: true, version: 'abc1234', release: '0.1.9' }))
    })
    let done = false
    const p = run(w, { fetch: () => slow }).then((f) => {
      done = true
      return f
    })
    await settle()
    expect(done).toBe(false)
    w.clock.advance(3000)
    release?.()
    const f = await p
    expect(known(f.relay.reachable).value).toBe(true)
  })
})

// ---- the command --------------------------------------------------------------------------------------------------

describe('the command', () => {
  const io = (isTerminal?: boolean) => {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      io: {
        ...(isTerminal === undefined ? {} : { isTerminal }),
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        prompt: async () => '',
        sleep: async () => {},
        now: () => NOW_MS,
      },
    }
  }
  const envFor = (w: World) => ({
    TALOS_APP_HOME: w.home,
    HOME: w.user,
    TALOS_APP_RELAY_URL: 'https://relay.example.com',
  })

  test('--json prints one object, v:1', async () => {
    const w = world()
    const c = io()
    expect(await runCli(['facts', '--json'], c.io, envFor(w), { facts: w.deps })).toBe(0)
    expect(c.out.length).toBe(1)
    const f = JSON.parse(c.out[0] as string)
    expect(f.v).toBe(1)
    expect(f).toHaveProperty('bridge')
  })

  test('an unknown flag is refused like status does, with the same exit code', async () => {
    const w = world()
    const c = io()
    expect(await runCli(['facts', '--no-such-flag'], c.io, envFor(w), { facts: w.deps })).toBe(1)
    expect(c.err.join('\n')).toMatch(/Unknown option/)
  })

  test('the agent runs it (no terminal), as it runs status: no gate, no card', async () => {
    const w = world()
    const c = io(false)
    expect(await runCli(['facts'], c.io, envFor(w), { facts: w.deps })).toBe(0)
    expect(c.out.join('\n')).toMatch(/^bridge: /m)
    expect(c.err).toEqual([])
  })

  test('a thread session (lead) runs it too, like status, doctor and logs', () => {
    const asThread = { TALOS_APP_WORKER_THREAD: 'trip', TALOS_SESSION_ROLE: 'worker' }
    expect(workerCliRefusal(['facts'], asThread, '/')).toBeUndefined()
    expect(workerCliRefusal(['facts', '--json'], asThread, '/')).toBeUndefined()
    expect(workerCliRefusal(['status'], asThread, '/')).toBeUndefined()
  })

  test("it is in the command list, as the agent's", () => {
    const c = COMMANDS.find((x) => x.name === 'facts')
    expect(c?.who).toBeUndefined()
    expect(c?.needs_terminal).toBeUndefined()
    expect(c?.effects).toEqual(['read'])
    expect(c?.args).toBe('[--json]')
  })
})

// ---- the review's fixes ---------------------------------------------------------------------------------------------

describe('cards past their expiry', () => {
  test('only a card that can still be answered is pending; one past its expiry and not swept is counted apart', async () => {
    const w = world()
    seedHistory(w.home, {
      cards: [
        { kind: 'email', created_at: ago(2 * HOUR) },
        { kind: 'email', created_at: ago(5 * HOUR), expires_at: ago(HOUR) },
        { kind: 'permission', created_at: ago(6 * HOUR), expires_at: ago(2 * HOUR) },
      ],
    })
    const c = known((await run(w)).cards)
    expect(c.value).toEqual({ pending: 1, expired_pending: 2, oldest_age_s: 2 * 3600, kinds: { email: 1 } })
  })
})

describe("the last send keeps the ledger's own states", () => {
  test('revoked, refused and gave_up stay apart; sent is ok', async () => {
    const w = world()
    writeConfig(w.home, { peers: [peer('a1'), peer('b1'), peer('c1'), peer('d1')] })
    seedHistory(w.home, {
      sends: [
        { peer: 'a1', state: 'revoked', created_at: NOW_MS - 1000 },
        { peer: 'b1', state: 'refused', created_at: NOW_MS - 2000 },
        { peer: 'c1', state: 'gave_up', created_at: NOW_MS - 3000 },
        { peer: 'd1', state: 'sent', created_at: NOW_MS - 4000 },
      ],
    })
    const by = Object.fromEntries(
      (known((await run(w)).peers).value as Array<{ name: string; last_send: unknown }>).map((p) => [p.name, p]),
    )
    expect(known(by.a1?.last_send).value.state).toBe('revoked')
    expect(known(by.b1?.last_send).value.state).toBe('refused')
    expect(known(by.c1?.last_send).value.state).toBe('gave_up')
    expect(known(by.d1?.last_send).value.state).toBe('ok')
  })
})

describe('the key store is asked has(), never get()', () => {
  test('a store whose get() throws still answers: present, absent and "could not tell"', async () => {
    const w = world()
    writeConfig(w.home, { peers: [peer('here'), peer('gone'), peer('lost')] })
    let gets = 0
    const store: SecretStore = {
      backend: 'file_0600',
      strength: 'file',
      get: async () => {
        gets++
        throw new Error('facts must never read a value')
      },
      set: async () => {
        throw new Error('no write')
      },
      delete: async () => {
        throw new Error('no write')
      },
      has: async (_service, account) => (account === 'peer:here' ? true : account === 'peer:gone' ? false : undefined),
    }
    const by = Object.fromEntries(
      (
        known((await run(w, { secrets: store })).peers).value as Array<{
          name: string
          secret_present: unknown
          needs_relink: unknown
        }>
      ).map((p) => [p.name, p]),
    )
    expect(known(by.here?.secret_present).value).toBe(true)
    expect(known(by.gone?.secret_present).value).toBe(false)
    expect(known(by.gone?.needs_relink).value).toBe(true)
    expect(unknown(by.lost?.secret_present).reason).toMatch(/could not tell/)
    expect(unknown(by.lost?.needs_relink).reason).toMatch(/could not tell/)
    expect(gets).toBe(0)
  })
})

describe('Lock Talos settings, from an agent session', () => {
  const linked = (w: World) => {
    writeConfig(w.home, { peers: [peer('work'), peer('home')], settings_lock: true })
    w.w('peers-inbound.json', { v: 1, peers: [{ name: 'atlas', conn_id: 'cn_a' }] })
    w.secrets.data.set(`${PEER_SECRET_SERVICE}\u0000${peerSecretAccount('work')}`, SECRET)
  }

  test('an agent session with the lock on sees the link count and nothing about the links', async () => {
    const w = world()
    linked(w)
    const f = await run(w, { agent: true })
    expect(f.peers).toEqual({ state: 'locked', reason: 'Lock Talos settings is on', count: 3 })
    for (const bad of ['work', 'atlas', 'secret_present', 'needs_relink'])
      expect(JSON.stringify(f.peers), bad).not.toContain(bad)
    expect(known(f.lock).value).toBe(true)
  })

  test('from a terminal, or with the lock off, the links are shown as before', async () => {
    const w = world()
    linked(w)
    expect(known((await run(w, { agent: false })).peers).value).toHaveLength(3)
    writeConfig(w.home, { peers: [peer('work')], settings_lock: false })
    expect(known((await run(w, { agent: true })).peers).value).toHaveLength(2)
  })

  test('the command decides "agent" from the terminal check: no terminal is an agent session, in both forms', async () => {
    const w = world()
    linked(w)
    const go = async (isTerminal: boolean | undefined, args: string[]) => {
      const out: string[] = []
      await cmdFacts(
        w.env,
        args,
        {
          ...(isTerminal === undefined ? {} : { isTerminal }),
          out: (l) => out.push(l),
          err: () => {},
          prompt: async () => '',
          sleep: async () => {},
          now: w.clock.now,
        },
        { ...w.deps },
      )
      return out.join('\n')
    }
    expect(await go(false, [])).toMatch(/^peers: locked \(Lock Talos settings is on\), 3 linked$/m)
    expect(JSON.parse(await go(false, ['--json'])).peers.state).toBe('locked')
    expect(await go(true, [])).toMatch(/^peer work: /m)
    expect(await go(undefined, [])).toMatch(/^peer work: /m)
  })
})

describe('Info.plist and the child processes cannot hold the command', () => {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')

  test('a FIFO at the plist path reads as unknown at once (it is never read), a folder too', async () => {
    const w = world({ platform: 'darwin' })
    const app = installApp(w, PLIST())
    const fifo = join(app, 'Contents', 'Info.plist')
    require('node:fs').rmSync(fifo)
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    expect(unknown((await run(w)).app).reason).toMatch(/not a regular file/)
    require('node:fs').rmSync(fifo)
    mkdirSync(fifo)
    expect(unknown((await run(w)).app).reason).toMatch(/not a regular file/)
  })

  test('a plist over the size cap is unknown, never read', async () => {
    const w = world({ platform: 'darwin' })
    installApp(w, Buffer.alloc(300 * 1024, 32))
    expect(unknown((await run(w)).app).reason).toMatch(/too big/)
  })

  test('plutil that never answers is cut at 5 s, and told to stop (its signal aborts)', async () => {
    const w = world({ platform: 'darwin' })
    installApp(w, Buffer.concat([Buffer.from('bplist00'), Buffer.from([1, 2])]))
    let sig: AbortSignal | undefined
    let done = false
    const p = run(w, {
      plutil: (_f, o) => {
        sig = o.signal
        return hang()
      },
    }).then((f) => {
      done = true
      return f
    })
    await settle()
    expect(done).toBe(false)
    w.clock.advance(5000)
    const f = await p
    expect(unknown(f.app).reason).toBe('no answer in 5 s')
    expect(sig?.aborted).toBe(true)
    expect(w.clock.pending).toBe(0)
  })

  test('git that never answers is cut at 5 s, told to stop, and gh is never run', async () => {
    const w = world()
    mkdirSync(join(w.root, 'apps', 'bridge', 'src'), { recursive: true })
    let sig: AbortSignal | undefined
    const gh = stubGh({ commits: [] })
    const p = run(w, {
      git: (_a, _c, o) => {
        sig = o.signal
        return hang()
      },
      gh: gh.gh,
    })
    await settle()
    w.clock.advance(5000)
    const f = await p
    expect(unknown(f.main).reason).toBe('no answer in 5 s')
    expect(sig?.aborted).toBe(true)
    expect(gh.calls).toEqual([])
  })

  test('the real runner kills its child when the signal aborts (a sleeping child ends at once, not in 30 s)', async () => {
    const ac = new AbortController()
    const p = realRunAsync('sleep', ['30'], { signal: ac.signal })
    await settle()
    ac.abort()
    expect(await p).toBeUndefined()
  })

  test('the real runner returns the output of a program that exits 0, and nothing for one that fails', async () => {
    const ac = new AbortController()
    expect(await realRunAsync('echo', ['hello'], { signal: ac.signal })).toBe('hello')
    expect(await realRunAsync('false', [], { signal: ac.signal })).toBeUndefined()
    expect(await realRunAsync('no-such-program-xyz', [], { signal: ac.signal })).toBeUndefined()
  })
})

describe('where the app is: status.json, the running process, Spotlight, in that order', () => {
  const bundle = (w: World, where: string, version: string) => {
    const app = join(w.root, where, 'Talos.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Info.plist'), PLIST().replace('0.1.7', version))
    return app
  }
  const darwin = () => {
    const w = world({ platform: 'darwin' })
    w.deps.ps = async () => '/usr/sbin/cron\n'
    w.deps.mdfind = async () => ''
    return w
  }
  const found = async (w: World) => known((await run(w)).app)

  test('1. app_path in status.json wins; the other two are not even asked', async () => {
    const w = darwin()
    let asked = 0
    w.deps.ps = async () => void asked++
    w.deps.mdfind = async () => void asked++
    w.w('status.json', status({ app_path: bundle(w, 'A', '0.1.1') }))
    const a = await found(w)
    expect(a.value.version).toBe('0.1.1')
    expect(a.found_by).toBe('status.json')
    expect(asked).toBe(0)
  })

  test('2. the running process (ps -axo comm=), cut back to the .app, when status.json names none', async () => {
    const w = darwin()
    const app = bundle(w, 'B', '0.1.2')
    w.deps.ps = async () =>
      `/usr/sbin/cron\n  ${app}/Contents/MacOS/Talos  \n${join(w.root, 'X', 'Other.app', 'Contents', 'MacOS', 'Talos')}\n`
    w.deps.mdfind = async () => {
      throw new Error('Spotlight is the third step')
    }
    const a = await found(w)
    expect(a.value.version).toBe('0.1.2')
    expect(a.found_by).toBe('the running process')
  })

  test('3. Spotlight: ~/Applications first, then /Applications, then any other', async () => {
    const w = darwin()
    const other = bundle(w, 'Elsewhere', '0.1.3')
    const system = bundle(w, 'Applications', '0.1.4')
    const mine = bundle(w, join('user', 'Applications'), '0.1.5')
    w.deps.systemApps = join(w.root, 'Applications')
    w.deps.mdfind = async () => `${other}\n${system}\n${mine}\n`
    // the user folder of this world is <root>/user: the one facts reads from the environment
    const a = await found(w)
    expect(a.found_by).toBe('Spotlight')
    expect(a.value.version).toBe('0.1.5')
    w.deps.mdfind = async () => `${other}\n${system}\n`
    expect((await found(w)).value.version).toBe('0.1.4')
    w.deps.mdfind = async () => `${other}\n`
    expect((await found(w)).value.version).toBe('0.1.3')
  })

  test('4. none of the three: not found', async () => {
    const w = darwin()
    expect(unknown((await run(w)).app).reason).toMatch(/was not found/)
  })

  test('a path from any step that is not an absolute .app folder (before and after links) is refused and the next step is tried', async () => {
    const w = darwin()
    const good = bundle(w, 'Applications', '0.1.9')
    const notApp = join(w.root, 'plain-file')
    writeFileSync(notApp, 'x')
    mkdirSync(join(w.root, 'Other', 'Contents'), { recursive: true })
    writeFileSync(join(w.root, 'Other', 'Contents', 'Info.plist'), PLIST())
    const etc = join(w.root, 'etc')
    mkdirSync(join(etc, 'Contents'), { recursive: true })
    writeFileSync(join(etc, 'Contents', 'Info.plist'), PLIST())
    require('node:fs').symlinkSync(etc, join(w.root, 'Sneaky.app'))
    require('node:fs').symlinkSync('/etc', join(w.root, 'Etc.app'))
    for (const named of [
      notApp,
      'relative/Mine.app',
      join(w.root, 'Other'),
      join(w.root, 'missing.app'),
      7,
      join(w.root, 'Sneaky.app'),
      join(w.root, 'Etc.app'),
    ]) {
      w.w('status.json', status({ app_path: named }))
      w.deps.ps = async () => `${join(w.root, 'Sneaky.app')}/Contents/MacOS/Talos\n${notApp}/Contents/MacOS/Talos\n`
      w.deps.mdfind = async () => `${notApp}\n${join(w.root, 'Etc.app')}\n${good}\n`
      const a = await found(w)
      expect(a.value.version, String(named)).toBe('0.1.9')
      expect(a.found_by, String(named)).toBe('Spotlight')
    }
  })

  test('ps and mdfind run on a Mac only, and a Mac step that hangs is cut at 5 s with its signal aborted', async () => {
    const lin = world({ platform: 'linux' })
    let asked = 0
    lin.deps.ps = async () => void asked++
    lin.deps.mdfind = async () => void asked++
    expect(unknown((await run(lin)).app).reason).toBe('no desktop app here')
    expect(asked).toBe(0)
    const w = darwin()
    let sig: AbortSignal | undefined
    w.deps.ps = (o) => {
      sig = o.signal
      return hang()
    }
    const p = run(w)
    await settle()
    w.clock.advance(5000)
    expect(unknown((await p).app).reason).toBe('no answer in 5 s')
    expect(sig?.aborted).toBe(true)
  })

  test('the real runner reads ps and mdfind output the way the steps use it (a program that prints lines)', async () => {
    const ac = new AbortController()
    expect((await realRunAsync('printf', ['a\\nb\\n'], { signal: ac.signal }))?.split('\n')).toEqual(['a', 'b'])
  })
})

describe('main: names and states', () => {
  test('a path segment of . or .. is never an owner or a repo', () => {
    for (const bad of [
      'https://github.com/./widgets',
      'https://github.com/acme/..',
      'https://github.com/../widgets',
      `git${AT}github.com:acme/..`,
    ])
      expect(parseGitHubRepo(bad), bad).toBeUndefined()
    expect(parseGitHubRepo('https://github.com/acme/.github')).toBe('acme/.github')
  })

  test('a job in the error state is red, and is listed with the failed ones', async () => {
    const errored = allSix().map((s) =>
      s.context === 'local-ci/mobile' ? { ...s, state: 'error', description: 'cancelled' } : s,
    )
    const { gh } = stubGh({ commits: [{ sha: sha(1), age: HOUR, statuses: errored }] })
    const { w, deps } = checkoutWorld(gh)
    const m = known((await run(w, deps)).main)
    expect(m.value.newest_finished).toEqual({ sha: '1111111', age_s: 3600, verdict: 'red', failed: ['mobile'] })
  })
})

// ---- history.sqlite is read from a copy -------------------------------------------------------------------------------

describe('history.sqlite is read from a copy, made outside the home and always removed', () => {
  test('the copy is in the scratch folder, not the home; nothing is left there afterwards, and the home is untouched', async () => {
    const w = world()
    seedHistory(w.home, { cards: [{ created_at: ago(HOUR) }] })
    const before = snapshot(w.home)
    expect(known((await run(w)).cards).value.pending).toBe(1)
    expect(readdirSync(w.deps.scratch as string)).toEqual([])
    expect(snapshot(w.home)).toEqual(before)
  })

  test('removed even when the open or a query throws (a file that is not a database)', async () => {
    const w = world()
    w.w('history.sqlite', 'this is not a sqlite file at all, padding padding padding padding')
    expect(unknown((await run(w)).cards).reason).toMatch(/cannot be read/)
    expect(readdirSync(w.deps.scratch as string)).toEqual([])
    // and for a copy that could not be made at all (a scratch folder that is not there)
    const r = readHistory(join(w.home, 'history.sqlite'), join(w.root, 'no-such-scratch'))
    expect(r.ok).toBe(false)
  })

  test('the copy carries the -wal: what a live bridge has not checkpointed is counted, and the live files are not touched', async () => {
    const w = world()
    seedHistory(w.home, { cards: [] })
    const live = new Database(paths(w.home).historyDb)
    live.exec('PRAGMA journal_mode = WAL')
    live.exec('PRAGMA wal_autocheckpoint = 0')
    live
      .query(
        "INSERT INTO cards (id, thread_id, binding_json, payload_hash, state, origin, risk, created_at, expires_at, actor) VALUES ('c1', 't', ?, 'h', 'pending', 'agent', 'low', ?, '2099-01-01T00:00:00.000Z', 'agent')",
      )
      .run(JSON.stringify({ kind: 'email', title: CARD_TEXT }), ago(60_000))
    try {
      const before = snapshot(w.home)
      expect(known((await run(w)).cards).value.pending).toBe(1)
      expect(snapshot(w.home)).toEqual(before)
      expect(readdirSync(w.deps.scratch as string)).toEqual([])
    } finally {
      live.close()
    }
  })

  test('over the size cap (the database plus its -wal) it is not copied: unknown, with the reason', async () => {
    const w = world()
    seedHistory(w.home, { cards: [{ created_at: NOW }] })
    const r = readHistory(join(w.home, 'history.sqlite'), w.deps.scratch, 1000)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/too big/)
    expect(readdirSync(w.deps.scratch as string)).toEqual([])
    expect(HISTORY_COPY_MAX).toBe(200 * 1024 * 1024)
  })
})

describe('the key store, on a Mac, is never the real one in a test', () => {
  test('a darwin run with no store given uses the injected runner: has() asks without -w, and nothing real starts', async () => {
    const w = world({ platform: 'darwin' })
    writeConfig(w.home, { peers: [peer('work')] })
    const calls: string[][] = []
    const f = await run(w, {
      secrets: undefined,
      secretSpawn: async (argv) => {
        calls.push(argv)
        return { code: 0, stdout: 'attributes only', stderr: '' }
      },
    })
    const by = (known(f.peers).value as Array<{ secret_present: unknown }>)[0]
    expect(known(by?.secret_present).value).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c[0]).toBe('/usr/bin/security')
      expect(c).not.toContain('-w')
    }
  })
})

// ---- a pipe, a link or the home itself where a file is expected --------------------------------------------------------
// (If one of these ever hangs, the whole test file hangs: a blocking read cannot be timed out. That is what they guard.)

describe('a FIFO or a link where a file is read cannot hang the command or leave a copy', () => {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
  const mkfifo = (p: string) => expect(spawnSync('mkfifo', [p]).status).toBe(0)
  const noCopyLeft = (w: World) => expect(readdirSync(w.deps.scratch as string)).toEqual([])

  test('a FIFO at history.sqlite: cards and last sends are unknown, nothing is left in the scratch folder', async () => {
    const w = world()
    mkfifo(join(w.home, 'history.sqlite'))
    const f = await run(w)
    expect(unknown(f.cards).reason).toMatch(/not a plain file/)
    noCopyLeft(w)
  })

  test('a FIFO at the -wal (with its -shm): unknown too, and no half copy', async () => {
    const w = world()
    seedHistory(w.home, { cards: [{ created_at: NOW }] })
    for (const f of ['history.sqlite-wal', 'history.sqlite-shm']) rmSync(join(w.home, f), { force: true })
    mkfifo(join(w.home, 'history.sqlite-wal'))
    writeFileSync(join(w.home, 'history.sqlite-shm'), '')
    expect(unknown((await run(w)).cards).reason).toMatch(/not a plain file/)
    noCopyLeft(w)
  })

  test('a link at history.sqlite (to a real database) is not followed: unknown', async () => {
    const w = world()
    const real = join(w.root, 'elsewhere')
    mkdirSync(real)
    seedHistory(real, { cards: [{ created_at: NOW }] })
    for (const f of ['history.sqlite-wal', 'history.sqlite-shm']) rmSync(join(real, f), { force: true })
    require('node:fs').symlinkSync(join(real, 'history.sqlite'), join(w.home, 'history.sqlite'))
    expect(unknown((await run(w)).cards).reason).toMatch(/not a plain file/)
    noCopyLeft(w)
  })

  test('a FIFO at status.json: the bridge field is unknown, the app step reads no app_path from it, and the command returns', async () => {
    const w = world({ platform: 'darwin' })
    mkfifo(join(w.home, 'status.json'))
    const app = installApp(w, PLIST())
    w.deps.ps = async () => `${app}/Contents/MacOS/Talos\n`
    const f = await run(w)
    expect(unknown(f.bridge).reason).toMatch(/status\.json is not a regular file/)
    expect(known(f.app).value.version).toBe('0.1.7')
    expect(known(f.app).found_by).toBe('the running process')
  })

  test('a FIFO at any other file of the home that is read plainly says so, in its own field', async () => {
    const w = world()
    for (const name of [
      'config.json',
      'release-feed.json',
      'relay-connect.json',
      'relay-auto.json',
      'peers-inbound.json',
    ])
      mkfifo(join(w.home, name))
    const f = await run(w)
    expect(unknown(f.lock).reason).toMatch(/config\.json is not a regular file/)
    expect(unknown(f.latest_release).reason).toMatch(/release-feed\.json is not a regular file/)
    expect(unknown(f.relay.via).reason).toMatch(/cannot be read/)
    expect(unknown(f.relay.last_attempt).reason).toMatch(/relay-auto\.json is not a regular file/)
    const g = world()
    writeConfig(g.home, { peers: [peer('work')] })
    mkfifo(join(g.home, 'peers-inbound.json'))
    expect(unknown((await run(g)).peers).reason).toMatch(/peers-inbound\.json is not a regular file/)
  })

  test('a temporary folder inside the Talos home is never used: unknown, and the home is untouched', async () => {
    const w = world()
    seedHistory(w.home, { cards: [{ created_at: NOW }] })
    const inside = join(w.home, 'tmp')
    mkdirSync(inside)
    const before = snapshot(w.root)
    const f = await run(w, { scratch: inside })
    expect(unknown(f.cards).reason).toMatch(/temporary folder is inside the Talos home/)
    expect(snapshot(w.root)).toEqual(before)
    expect(readdirSync(inside)).toEqual([])
    // the home itself, and a link into it
    require('node:fs').symlinkSync(w.home, join(w.root, 'into-home'))
    expect(unknown((await run(w, { scratch: join(w.root, 'into-home') })).cards).reason).toMatch(
      /inside the Talos home/,
    )
    expect(snapshot(w.root).filter((l) => l.includes('talos-facts-'))).toEqual([])
  })

  test('a file that grows past the cap while it is copied stops the copy: unknown, nothing left', async () => {
    const w = world()
    seedHistory(w.home, { cards: [{ created_at: NOW }] })
    const size = statSync(join(w.home, 'history.sqlite')).size
    const r = readHistory(join(w.home, 'history.sqlite'), w.deps.scratch, size - 1)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/too big/)
    noCopyLeft(w)
  })
})

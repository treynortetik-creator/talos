// Before a Mac install: wait until the relay serves this build or a newer one. Called by install.sh, never on its own.
// Why: the web app the relay serves notes "Talos on your phone or Mac is newer than this app" when the Mac sends something
// that web build does not know yet. A Mac install that lands before the relay deploy shows that note to the owner.
//   node relay-wait.mjs <build git sha> <the clone it was built from>
// The relay address is read here, from the Mac's own Talos settings, the way the app reads it (WebWindow.resolveRelay and
// RelayConfig in TalosDesktopCore): desktop.json `relay_url`, unless it is empty, "auto" or the generic placeholder; then
// TALOS_APP_RELAY_URL in $TALOS_APP_HOME/bridge.env. The address never goes on a command line, into output or into a file.
// "Same or newer" is decided by git: the relay's version (scripts/version.mjs, baked into /healthz and the web bundle) names a
// commit, and the relay is new enough when this build's commit is that commit or one of its ancestors. Only a sha (7-40 hex)
// or a `git describe` (<tag>-N-g<hex>, maybe -dirty) counts as a commit, and only its hex is resolved: a tag, a branch, HEAD
// or the package-version fallback is never looked up, and the wait is skipped with a line saying the two can't be compared.
// A relay on another line than the build (neither older nor newer) stops at once: waiting would not change that.
// Exit codes: 0 go ahead (same, newer, no relay set, or a version that is not a commit); 8 stop (timed out, unreachable, a
// bad answer, another line, or git could not compare).
// TALOS_RELAY_WAIT_INTERVAL and TALOS_RELAY_WAIT_LIMIT (seconds) shorten the 15 s poll and the 10 min limit for tests.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const PLACEHOLDER = 'https://relay.example.com'
// What scripts/version.mjs can print: a sha, a `git describe` (tag-N-gsha, maybe -dirty), a tag or a package version.
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,79}$/
const HEX = /^[0-9a-f]{7,40}$/
const MAX_BODY = 64 * 1024
const AGAIN = 'run this again later, or pass --no-relay-wait to install anyway'

const say = (line) => process.stdout.write(`install: ${line}\n`)
const stop = (line) => {
  process.stderr.write(`install: stopped, nothing was installed: ${line}\n`)
  process.exit(8)
}

function seconds(name, fallback) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v * 1000 : fallback
}

/** `KEY=value` lines, as RelayConfig.envValue reads bridge.env: `export`, quotes and a ` #` comment allowed; last one wins. */
function envValue(key, text) {
  let found
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()
    const eq = line.indexOf('=')
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue
    let v = line.slice(eq + 1).trim()
    const q = v[0]
    const end = q === '"' || q === "'" ? v.indexOf(q, 1) : -1
    if (end > 0) v = v.slice(1, end)
    else if (v.includes(' #')) v = v.slice(0, v.indexOf(' #')).trim()
    found = v === '' ? undefined : v
  }
  return found
}

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : undefined)
const expandTilde = (p, home) => (p === '~' ? home : p.startsWith('~/') ? home + p.slice(1) : p)

/** The relay address this Mac's Talos uses, or undefined when none is set. */
function configuredRelay(home, processEnv) {
  let cfg
  try {
    cfg = JSON.parse(readText(`${home}/Library/Application Support/Talos/desktop.json`) ?? 'null')
  } catch {
    cfg = null // the app sets an unreadable desktop.json aside and runs on defaults: the placeholder
  }
  const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  const configured = isObj(cfg) && typeof cfg.relay_url === 'string' ? cfg.relay_url.trim() : ''
  if (configured !== '' && configured !== 'auto' && configured.replace(/^\/+|\/+$/g, '') !== PLACEHOLDER)
    return configured
  const cfgEnv = isObj(cfg) && isObj(cfg.env) ? cfg.env : {}
  const appHome = nonEmpty(cfgEnv.TALOS_APP_HOME) ?? nonEmpty(processEnv.TALOS_APP_HOME) ?? `${home}/.config/talos/app`
  const env = readText(`${expandTilde(appHome, home)}/bridge.env`)
  return env === undefined ? undefined : envValue('TALOS_APP_RELAY_URL', env)
}

/** The /healthz address, or undefined for one the app would refuse too (https only; plain http only on this machine). */
function healthzUrl(relay) {
  let u
  try {
    u = new URL(relay.trim())
  } catch {
    return undefined
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase())
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) || u.hostname === '') return undefined
  return new URL('/healthz', u.origin).href
}

/** One look at /healthz: {version} on a good answer, {fail: 'unreachable' | 'bad'} otherwise. Errors are never printed. */
async function askRelay(url, timeoutMs) {
  let res
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
  } catch {
    return { fail: 'unreachable' }
  }
  try {
    if (res.status !== 200 || !res.body) return { fail: 'bad' }
    const chunks = []
    let size = 0
    for await (const c of res.body) {
      size += c.length
      if (size > MAX_BODY) return { fail: 'bad' }
      chunks.push(c)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof body !== 'object' || body === null || body.ok !== true) return { fail: 'bad' }
    if (typeof body.version !== 'string' || !VERSION_RE.test(body.version)) return { fail: 'bad' }
    return { version: body.version }
  } catch {
    return { fail: 'bad' }
  }
}

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
    .toString()
    .trim()

/** The hex a version names: a bare sha, or the g<hex> of a `git describe`; `-dirty` dropped. Undefined for anything else. */
function hexOf(version) {
  const v = version.replace(/-dirty$/, '')
  if (HEX.test(v)) return v
  return /^.+-\d+-g([0-9a-f]{7,40})$/.exec(v)?.[1]
}

/** The full commit a hex names in this clone, or undefined. Never given a ref name: only `hexOf` output reaches here. */
function commitOf(repo, hex) {
  if (!HEX.test(hex)) return undefined
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${hex}^{commit}`])
  } catch {
    return undefined
  }
}

/**
 * A public clone is the squashed public repo: the build (TalosGitSha) and the relay's version name PRIVATE commits it does not
 * have, and each snapshot commit names the private commit it was made from in a `Talos-Source:` trailer (publish-public.sh).
 * The snapshot commits by the private hex they were made from, or undefined when this clone has no such trailers (a private
 * clone). One `git log` for the whole history; a hex that two snapshots match (a short prefix) maps to neither.
 */
function snapshots(repo) {
  let out
  try {
    out = git(repo, ['log', '--all', '--format=%H%x09%(trailers:key=Talos-Source,valueonly,separator=%x20)'])
  } catch {
    return undefined
  }
  const map = []
  for (const line of out.split('\n')) {
    const [pub, src] = line.split('\t')
    const s = (src ?? '').trim()
    if (HEX.test(pub ?? '') && /^[0-9a-f]{40}$/.test(s)) map.push([s, pub])
  }
  return map.length ? map : undefined
}

function snapshotOf(map, hex) {
  if (!map || !HEX.test(hex)) return undefined
  const hits = new Set(map.filter(([src]) => src.startsWith(hex)).map(([, pub]) => pub))
  return hits.size === 1 ? [...hits][0] : undefined
}

/** Is a an ancestor of b? A git failure (anything but "no") throws. */
function isAncestor(repo, a, b) {
  try {
    git(repo, ['merge-base', '--is-ancestor', a, b])
    return true
  } catch (e) {
    if (e?.status === 1) return false
    throw e
  }
}

/** 'same', 'newer' (the relay has this build's commit in its history), 'behind' (the build has the relay's) or 'apart'. */
function compare(repo, build, relay) {
  if (build === relay) return 'same'
  if (isAncestor(repo, build, relay)) return 'newer'
  if (isAncestor(repo, relay, build)) return 'behind'
  return 'apart'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const [buildSha, repo] = process.argv.slice(2)
  const relay = configuredRelay(process.env.HOME || homedir(), process.env)
  if (relay === undefined) {
    say("no relay is set in this Mac's Talos settings (not paired), so the wait for the relay's version is skipped")
    return
  }
  const url = healthzUrl(relay)
  if (url === undefined) stop(`the relay address in this Mac's Talos settings is not one Talos can use; ${AGAIN}`)
  if (!buildSha)
    stop(`this build carries no git sha (TalosGitSha), so it can't be compared with the relay's version; ${AGAIN}`)
  const buildHex = hexOf(buildSha) ?? ''
  let build = commitOf(repo, buildHex)
  // in a public clone, the snapshot made from the build's private commit
  const snaps = build === undefined ? snapshots(repo) : undefined
  if (build === undefined) build = snapshotOf(snaps, buildHex)
  if (build === undefined) stop(`this build's commit ${buildSha} is not in the clone it was built from; ${AGAIN}`)

  const interval = seconds('TALOS_RELAY_WAIT_INTERVAL', 15_000)
  const limit = seconds('TALOS_RELAY_WAIT_LIMIT', 600_000)
  const parent = process.ppid
  const deadline = Date.now() + limit
  let seen // the last good answer
  let told = false
  for (;;) {
    const left = deadline - Date.now()
    const got = await askRelay(url, Math.max(1000, Math.min(10_000, left > 0 ? left : 10_000)))
    if ('fail' in got) {
      // Before any good answer, a failure stops at once; once the relay has answered, a blip (a deploy swapping it) is waited out.
      if (seen === undefined && got.fail === 'unreachable')
        stop(`the relay couldn't be reached to check its version; ${AGAIN}`)
      if (seen === undefined) stop(`the relay's /healthz answer was not {ok: true, version}; ${AGAIN}`)
    } else {
      seen = got.version
      const hex = hexOf(got.version)
      if (hex === undefined)
        return say(`the relay reports version ${got.version}, not a commit, so it can't be compared; installing`)
      const relayCommit = commitOf(repo, hex) ?? snapshotOf(snaps, hex)
      if (relayCommit === undefined && snaps)
        // a relay deployed from a private commit no snapshot was made from: this public clone cannot order it, and fetching
        // would not help (the public repo never has private commits)
        return say(
          `the relay is on version ${got.version}, a commit with no snapshot in this public clone, so it can't be compared; installing`,
        )
      if (relayCommit === undefined)
        stop(
          `the relay is on version ${got.version}, which this clone does not have, so it can't tell which is newer; fetch, then ${AGAIN}`,
        )
      let how
      try {
        how = compare(repo, build, relayCommit)
      } catch {
        stop(`git couldn't compare the relay's version ${got.version} with this build (${buildSha}); ${AGAIN}`)
      }
      if (how === 'apart')
        stop(
          `the relay is on ${got.version}, which is not on this build's line (${buildSha}), so waiting would not help; ${AGAIN}`,
        )
      if (how === 'same') return say(`the relay is on ${got.version}, the same commit as this build`)
      if (how === 'newer') return say(`the relay is on ${got.version}, newer than this build (${buildSha})`)
      if (!told) {
        const upTo = limit >= 60_000 ? `${Math.round(limit / 60_000)} min` : `${limit / 1000} s`
        say(
          `the relay is on ${got.version}, behind this build (${buildSha}); waiting for it, checking every ${interval / 1000} s for up to ${upTo}. It does not move by itself: redeploy the relay in Railway (its project, Deployments, Redeploy), or stop now and run this again with --no-relay-wait`,
        )
        told = true
      }
    }
    const now = Date.now()
    if (now >= deadline || process.ppid !== parent) break
    await sleep(Math.min(interval, deadline - now))
  }
  stop(
    `the relay is still on version ${seen} while this build is ${buildSha}, so the web app would show the "newer than this app" note; ${AGAIN}`,
  )
}

await main()

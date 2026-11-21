// `talos-app relay connect | disconnect | update | auto on|off | status` (docs/deploy-railway.md "Keeping the relay up to date").
//   connect      the owner's, in a terminal only: reads a Railway token hidden (never from the command line), finds out which kind it is
//                and which service is the relay, asks to confirm, and keeps the token in the key store.
//   update       the agent may run it unless "Lock Talos settings" is on (agent-cli.ts decides): one redeploy, then it watches /healthz.
//   auto on|off  whether the bridge redeploys by itself when a new release appears (relay/auto.ts). `off` is always allowed.
//   disconnect   removes what connect (or the Mac app) left here; runs again with nothing to do.
// The token is never printed, logged or written to a file of the Talos home; the only place it goes besides Railway's one header is
// the key store (files.ts names the item).
import { RelayConnectFile, type RelayConnectFileT, type SecretStore } from '@talos-app/protocol'
import type { CliIO } from '../cli-main.ts'
import type { BridgeEnv } from '../config.ts'
import { RelayHttp } from '../relay-http.ts'
import { compareSemver, feedDeps, loadReleases, relayReleaseState } from '../release-feed.ts'
import { openSecretStore } from '../secrets/store.ts'
import {
  connectionFileBroken,
  RAILWAY_ACCOUNT,
  RAILWAY_SERVICE,
  railwayStore,
  readConnection,
  readState,
  removeConnectionFiles,
  writeConnection,
  writeState,
} from './files.ts'
import { identifyToken, Railway, type RailwayAuth, RailwayError } from './railway.ts'
import { appDetail, appFailureText, appResult, requestRedeploy } from './redeploy.ts'

export type RelayCliDeps = { secrets?: SecretStore }

export const RELAY_USAGE = `usage: talos-app relay connect | status | update | auto on|off | disconnect
  connect      let this computer update your online relay (you paste a Railway token; terminal only)
  status       what is connected, whether auto-update is on, and the last update
  update       move your online relay to the newest release now
  auto on|off  update the relay by itself when a new release appears
  disconnect   forget the token and stop updating the relay`

export const POLL_MS = 10_000
export const POLL_LIMIT = 60 // ten minutes of ten-second looks

const NOT_CONNECTED_HINT =
  "this relay isn't connected for updates: run talos-app relay connect once, in a terminal. Railway updates an image relay within a few hours; to update now, redeploy it in Railway."
const ID_SHAPE = /^[A-Za-z0-9_-]{8,80}$/
const TOKEN_SHAPE = /^[A-Za-z0-9_.-]{8,200}$/

const fail = (io: Pick<CliIO, 'err'>, text: string): number => {
  io.err(`talos-app: ${text}`)
  return 1
}

export async function cmdRelay(env: BridgeEnv, args: string[], io: CliIO, deps: RelayCliDeps = {}): Promise<number> {
  const [sub, ...rest] = args
  const secrets = async (): Promise<SecretStore> => deps.secrets ?? (await openSecretStore({ home: env.home }))
  try {
    switch (sub) {
      case 'connect':
        return await connect(env, rest, io, secrets)
      case 'status':
        return status(env, io)
      case 'update':
        return await update(env, io, secrets)
      case 'auto':
        return autoSwitch(env, rest, io)
      case 'disconnect':
        return await disconnect(env, io, secrets)
      default:
        io.err(RELAY_USAGE)
        return 2
    }
  } catch (e) {
    return fail(io, e instanceof RailwayError ? e.message : (e as Error).message)
  }
}

// ---- connect --------------------------------------------------------------------------------------------------------------------

const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

async function ask(io: CliIO, question: string): Promise<string> {
  return (await io.prompt(question)).trim()
}

async function connect(
  env: BridgeEnv,
  args: string[],
  io: CliIO,
  secrets: () => Promise<SecretStore>,
): Promise<number> {
  if (args.length > 0)
    return fail(
      io,
      'a Railway token never goes on the command line (it would stay in your shell history and show in the process list). Run "talos-app relay connect" with nothing after it; the token is asked for, and not shown as you type.',
    )
  const existing = readConnection(env.home)?.file
  if (existing?.via === 'app')
    return fail(
      io,
      'your relay was set up by the Talos app, which holds its own Railway login. Run "talos-app relay disconnect" first if you want to use a pasted token instead.',
    )
  if (connectionFileBroken(env.home))
    return fail(
      io,
      `${env.home}/relay-connect.json is there but not readable (a symlink, or not what this version writes). Remove it, then connect again.`,
    )
  io.out('To let this computer update your relay, make a Railway project token for it:')
  io.out("  1. Open your relay's project in the Railway dashboard.")
  io.out(
    "  2. Project → Settings → Tokens, choose the relay's environment (for example production), and create a token.",
  )
  io.out(
    "  3. Copy it and paste it below. It is not shown as you type, and it is kept in this computer's key store only.",
  )
  const token = (await (io.readSecret ? io.readSecret('Railway token: ') : io.prompt('Railway token: '))).trim()
  if (!TOKEN_SHAPE.test(token))
    return fail(io, "that doesn't look like a Railway token (letters, digits, - and _ only). Nothing was stored.")

  const ident = await identifyToken(token)
  let auth: RailwayAuth
  if (ident.kind === 'project') {
    auth = { kind: 'project', token }
    io.out(
      "That is a project token: this token can read your relay's settings. Talos uses it to redeploy the relay, and for nothing else.",
    )
  } else {
    auth = { kind: 'account', token }
    io.out(
      'That is an account or workspace token: this key can change every project in your Railway account; a project key is safer.',
    )
    io.out('Make a project token as above instead, unless you really want this one kept here.')
    if ((await ask(io, 'Type yes to keep it anyway: ')).toLowerCase() !== 'yes')
      return fail(io, 'not kept. Nothing was stored.')
  }
  const rw = new Railway(auth)
  const picked = await pickService(rw, ident, env, io)
  if (typeof picked === 'number') return picked
  io.out(`relay service: ${picked.serviceName}, environment ${picked.environmentName}`)
  const sure = (await ask(io, 'Is that your relay? [y/N]: ')).toLowerCase()
  if (sure !== 'y' && sure !== 'yes') return fail(io, 'not connected. Nothing was stored.')

  const record = RelayConnectFile.parse({
    v: 1,
    via: 'token',
    kind: ident.kind,
    project_id: picked.projectId,
    environment_id: picked.environmentId,
    service_id: picked.serviceId,
    service_name: picked.serviceName,
    environment_name: picked.environmentName,
    ...(picked.domain ? { domain: picked.domain } : {}),
    auto_update: true,
    connected_at: io.now(),
  })
  const store = railwayStore(await secrets(), env.home)
  await store.set(RAILWAY_SERVICE, RAILWAY_ACCOUNT, token)
  try {
    writeConnection(env.home, record)
  } catch (e) {
    await store.delete(RAILWAY_SERVICE, RAILWAY_ACCOUNT).catch(() => {})
    return fail(io, `${(e as Error).message} Nothing was kept.`)
  }
  io.out(
    'Connected: auto-update is on, so your online relay moves to each new release by itself (talos-app relay auto off turns it off).',
  )
  io.out('talos-app relay update updates it now; talos-app relay disconnect forgets the token.')
  return 0
}

type Picked = {
  projectId: string
  environmentId: string
  serviceId: string
  serviceName: string
  environmentName: string
  domain?: string
}

/** Which service is the relay: matched by this home's relay address against the services' domains, else the owner pastes its id. */
async function pickService(
  rw: Railway,
  ident: Awaited<ReturnType<typeof identifyToken>>,
  env: BridgeEnv,
  io: CliIO,
): Promise<Picked | number> {
  const host = hostOf(env.relayUrl)
  const askId = async (what: string): Promise<string | undefined> => {
    const id = await ask(io, `${what} (Railway: the service's Settings, "Service ID"): `)
    return ID_SHAPE.test(id) ? id : undefined
  }
  let projectId: string
  let environmentId: string
  let serviceId: string | undefined
  let serviceName = ''
  let domain: string | undefined
  if (ident.kind === 'project') {
    projectId = ident.projectId
    environmentId = ident.environmentId
    const proj = await rw.project(projectId)
    const matches: Array<{ id: string; name: string }> = []
    if (host)
      for (const s of proj.services.slice(0, 25)) {
        const doms = await rw.domains(projectId, environmentId, s.id).catch(() => [] as string[])
        if (doms.includes(host)) matches.push(s)
      }
    if (matches.length === 1) {
      serviceId = (matches[0] as { id: string }).id
      serviceName = (matches[0] as { name: string }).name
      domain = host
    } else {
      const id = await askId("Paste your relay's service ID")
      const found = id ? proj.services.find((s) => s.id === id) : undefined
      if (!id) return fail(io, "that isn't a service ID. Nothing was stored.")
      if (!found) return fail(io, "that service isn't in this token's project. Nothing was stored.")
      serviceId = id
      serviceName = found.name
    }
    const envName = proj.environments.find((e) => e.id === environmentId)?.name ?? "this token's environment"
    return { projectId, environmentId, serviceId, serviceName, environmentName: envName, ...(domain ? { domain } : {}) }
  }
  const id = await askId("Paste your relay's service ID")
  if (!id) return fail(io, "that isn't a service ID. Nothing was stored.")
  const svc = await rw.service(id)
  projectId = svc.projectId
  const proj = await rw.project(projectId)
  let envId = svc.environmentIds.length === 1 ? svc.environmentIds[0] : undefined
  if (!envId && host)
    for (const e of svc.environmentIds)
      if ((await rw.domains(projectId, e, id).catch(() => [] as string[])).includes(host)) envId = e
  if (!envId)
    return fail(
      io,
      'that service runs in more than one environment. Make a project token for the environment your relay uses and connect with that. Nothing was stored.',
    )
  if (host && (await rw.domains(projectId, envId, id).catch(() => [] as string[])).includes(host)) domain = host
  return {
    projectId,
    environmentId: envId,
    serviceId: id,
    serviceName: svc.name,
    environmentName: proj.environments.find((e) => e.id === envId)?.name ?? "the relay's environment",
    ...(domain ? { domain } : {}),
  }
}

// ---- status, disconnect, auto ---------------------------------------------------------------------------------------------------

const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

export function describeConnection(c: RelayConnectFileT): string {
  return c.via === 'app' ? 'set up by the Talos app' : `connected through a pasted ${c.kind ?? 'project'} token`
}

function status(env: BridgeEnv, io: CliIO): number {
  const c = readConnection(env.home)?.file
  if (!c) {
    io.out(
      connectionFileBroken(env.home)
        ? 'relay updates: relay-connect.json is not readable'
        : 'relay updates: not connected (talos-app relay connect)',
    )
    return 0
  }
  io.out(`relay updates: ${describeConnection(c)}`)
  if (c.service_name || c.environment_name)
    io.out(
      `  ${c.service_name ? `service ${c.service_name}` : ''}${c.service_name && c.environment_name ? ', ' : ''}${c.environment_name ? `environment ${c.environment_name}` : ''}`,
    )
  io.out(`  auto-update: ${c.auto_update ? 'on' : 'off'}`)
  const a = readState(env.home).attempt
  io.out(
    `  last attempt: ${a ? `to ${a.release} on ${when(a.at)}, ${a.state === 'on' ? 'it worked' : a.state === 'sent' ? 'not confirmed yet' : `it didn't work${a.reason ? ` (${a.reason}${a.detail ? `; the app said: ${a.detail}` : ''})` : ''}`}` : 'none'}`,
  )
  return 0
}

async function disconnect(env: BridgeEnv, io: CliIO, secrets: () => Promise<SecretStore>): Promise<number> {
  const c = readConnection(env.home)?.file
  const hadFile = c !== undefined || connectionFileBroken(env.home)
  let code = 0
  let hadToken = false
  if (c?.via !== 'app') {
    // the token is looked for even with no file (a connect that stopped half way); it is deleted only if it is there
    try {
      const store = railwayStore(await secrets(), env.home)
      hadToken = (await store.get(RAILWAY_SERVICE, RAILWAY_ACCOUNT)) !== undefined
      if (hadToken) await store.delete(RAILWAY_SERVICE, RAILWAY_ACCOUNT)
    } catch (e) {
      code = 1
      io.err(
        `talos-app: the Railway token could not be checked or removed in the key store (${(e as Error).message}). Remove it by hand, or run this again.`,
      )
    }
  }
  if (!hadFile && !hadToken && code === 0) {
    io.out('relay updates: not connected, nothing to remove.')
    return 0
  }
  removeConnectionFiles(env.home)
  if (c?.via === 'app')
    io.out("Forgot this relay's connection here. The Talos app's Railway login is removed in the Talos app.")
  else
    io.out(
      `Disconnected: ${hadToken ? 'the token is forgotten' : 'there was no token to forget'}${hadFile ? ' and the connection file is removed' : ''}; your relay is no longer updated from here.`,
    )
  return code
}

function autoSwitch(env: BridgeEnv, args: string[], io: CliIO): number {
  const want = args[0]
  if ((want !== 'on' && want !== 'off') || args.length !== 1) {
    io.err('usage: talos-app relay auto on|off')
    return 2
  }
  const c = readConnection(env.home)
  if (!c) return fail(io, 'not connected. Run talos-app relay connect first.')
  const on = want === 'on'
  // the file as it is, with only this one field changed: a field a newer version (or the Talos app) put there is kept
  writeConnection(env.home, { ...c.raw, auto_update: on })
  io.out(
    `auto-update is ${want}${on ? ': your relay moves to each new release by itself.' : ': your relay is only updated by talos-app relay update.'}`,
  )
  return 0
}

// ---- update ---------------------------------------------------------------------------------------------------------------------

async function update(env: BridgeEnv, io: CliIO, secrets: () => Promise<SecretStore>): Promise<number> {
  const c = readConnection(env.home)?.file
  if (!c) return fail(io, NOT_CONNECTED_HINT)
  if (!env.relayUrl) return fail(io, 'this install has no relay URL, so there is no relay to update.')
  const http = new RelayHttp(env.relayUrl, () => {
    throw new Error('no key needed')
  })
  let health: Awaited<ReturnType<RelayHttp['healthz']>>
  try {
    health = await http.healthz()
  } catch (e) {
    return fail(io, `your relay didn't answer (${(e as Error).message}), so it wasn't updated.`)
  }
  const got = typeof health.release === 'string' ? await loadReleases(feedDeps(env, io.now)) : undefined
  const state = relayReleaseState({ release: health.release, version: health.version }, got?.versions, got?.failure)
  if (state.state === 'not-a-release') return fail(io, "your relay deploys from main; it isn't updated from releases.")
  if (state.state === 'unknown')
    return fail(
      io,
      "can't tell which release is the newest right now (the releases list isn't reachable). Try again in a few minutes.",
    )
  if (state.state !== 'behind') {
    io.out(
      `your relay is already on ${state.relay}${state.state === 'latest' ? ', the latest release' : ', newer than the latest published release'}. Nothing to do.`,
    )
    return 0
  }
  const target = state.latest
  const out = await requestRedeploy(c, target, {
    home: env.home,
    now: io.now,
    secrets,
  })
  if (!out.ok) {
    record(env.home, { release: target, at: io.now(), state: 'failed', by: 'cli', via: c.via, reason: out.text })
    return fail(io, `your relay didn't update to ${target}: ${out.text}`)
  }
  record(env.home, {
    release: target,
    at: io.now(),
    state: 'sent',
    by: 'cli',
    via: c.via,
    ...(out.id ? { id: out.id } : {}),
  })
  io.out(`redeploying your relay (on ${state.relay}, moving to ${target})…`)
  let shown = `on ${state.relay}`
  for (let i = 0; i < POLL_LIMIT; i++) {
    await io.sleep(POLL_MS)
    const result = appResult(c, env.home, out.id, target)
    if (result.state === 'failed') {
      const text = appFailureText(result.code)
      const detail = appDetail(result.detail)
      record(env.home, {
        release: target,
        at: io.now(),
        state: 'failed',
        by: 'cli',
        via: c.via,
        reason: text,
        ...(detail ? { detail } : {}),
      })
      return fail(io, `your relay didn't update to ${target}: ${text}`)
    }
    let now: string
    try {
      const h = await http.healthz()
      now =
        typeof h.release === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(h.release)
          ? `on ${h.release}`
          : 'back, but not on a release'
      if (now.startsWith('on ') && compareSemver(h.release as string, target) >= 0) {
        io.out(`relay is on ${h.release}`)
        record(env.home, { release: target, at: io.now(), state: 'on', by: 'cli', via: c.via })
        return 0
      }
    } catch {
      now = 'restarting'
    }
    if (now !== shown) {
      io.out(`relay is ${now === 'restarting' ? 'restarting…' : now}`)
      shown = now
    }
  }
  const text = `it was still ${shown} after 10 minutes. Railway may still be deploying: run talos-app doctor in a little while.`
  record(env.home, {
    release: target,
    at: io.now(),
    state: 'failed',
    by: 'cli',
    via: c.via,
    reason: 'still not on it after 10 minutes',
  })
  return fail(io, `your relay didn't update to ${target}: ${text}`)
}

function record(home: string, attempt: NonNullable<ReturnType<typeof readState>['attempt']>): void {
  try {
    writeState(home, { ...readState(home), attempt })
  } catch {
    // the record is for status and the backoff only; an update that ran is not undone because it could not be written
  }
}

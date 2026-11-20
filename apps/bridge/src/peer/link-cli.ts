// `talos-app peer link <name>` (this install shows a one-paste code) and `talos-app peer accept <code> --name <name>` (this install pastes one).
// docs/LINKED-AGENTS.md. Neither prints, writes or takes a signing secret: A never sees its own inbox secret at all (the relay hands it to
// the other install at redeem), and B keeps what it gets in the key store. The code is a bearer credential for 15 minutes: it is printed
// once by `link`, read once by `accept`, and never logged, never echoed back in an error, never part of the audit line.
import {
  checkPeerInboxUrl,
  PEER_DAILY_CAP_DEFAULT,
  PEER_DAILY_CAP_MAX,
  PEER_LINK_TTL_MS,
  PEER_LINK_UNUSABLE,
  PEER_MAX,
  PeerConfig,
  PeerLinkRedeemed,
  PeerName,
  parsePeerLinkCode,
  peerInboxUrl,
  type SecretStore,
} from '@talos-app/protocol'
import { BlockedAddressError, createGuardedFetch } from '@talos-app/protocol/guarded-fetch'
import type { CliIO } from '../cli-main.ts'
import type { BridgeEnv } from '../config.ts'
import type { ConfigFile } from '../config-file.ts'
import { type RelayHttp, RelayHttpError } from '../relay-http.ts'
import {
  addInboundPeer,
  PEER_SECRET_SERVICE,
  peerSecretAccount,
  readInboundPeers,
  removeInboundPeer,
} from './records.ts'

/** The redeem call: a fetch that takes a url and init (the real one is the guarded fetch). */
export type RedeemFetch = (url: string, init: RequestInit) => Promise<Response>
export type LinkCliDeps = { fetch?: RedeemFetch; resolve?: (host: string) => Promise<readonly string[]> }

export type LinkEnv = {
  env: BridgeEnv
  io: Pick<CliIO, 'out' | 'err'>
  agent: boolean
  http: () => Promise<RelayHttp>
  secrets: () => Promise<SecretStore>
  config: () => ConfigFile
  clearRevoked: (name: string) => void
  deps: LinkCliDeps
}

const fail = (io: Pick<CliIO, 'err'>, text: string): number => {
  io.err(`talos-app: ${text}`)
  return 1
}

const REDEEM_TIMEOUT_MS = 10_000
const REDEEM_BODY_MAX = 4096
const TOO_MANY = (n: number): string => `this Talos already has ${n} linked agents.`

export const UNUSABLE_LINE =
  "this link code can't be used: it expired, was already used, or is wrong. Ask for a new one with talos-app peer link on the other Talos."

/** `peer link <name> [--cap N]` */
export async function cmdPeerLink(e: LinkEnv, name: string, cap: number | undefined): Promise<number> {
  const { env, io } = e
  const existing = readInboundPeers(env.home).find((p) => p.name === name)
  // an inbox made some other way (peer create, a finished link) is not ours to re-code
  if (existing && existing.link?.by !== 'link')
    return fail(
      io,
      `there is already an inbox named "${name}". Run "talos-app peer remove ${name}" first, or pick another name.`,
    )
  // only a code that was never used is minted again for the same inbox: a used, taken or failed one must not hand the secret out twice
  const used = `${name} was already linked or its code was used; run talos-app peer remove ${name} and link again.`
  if (
    existing?.link &&
    (existing.link.state === 'done' ||
      existing.link.taken ||
      (existing.link.state === 'closed' && !existing.link.expired))
  )
    return fail(io, used)
  const http = await e.http()
  if (e.agent) await e.secrets() // the agent only runs this on a key store it may use (the bridge stores the secret later)
  if (existing) {
    const seen = await http.getPeerLink(name).catch(() => undefined)
    if (seen && (seen.state === 'redeemed' || seen.state === 'collected' || seen.replayed)) return fail(io, used)
  }
  let made = false
  let connId = existing?.conn_id
  if (!existing) {
    try {
      // the secret in the answer is dropped here: the relay holds it for the redeem, and nothing on this computer ever has it
      connId = (await http.createPeer({ name, ...(cap ? { daily_cap: cap } : {}) })).conn_id
      made = true
    } catch (err) {
      if (err instanceof RelayHttpError && err.status === 409)
        return fail(
          io,
          `there is already an inbox named "${name}" (or ${PEER_MAX} inboxes). Run "talos-app peer remove ${name}" first, or pick another name.`,
        )
      throw err
    }
  }
  let code: string
  try {
    code = (await http.mintPeerLink(name)).code
  } catch (err) {
    if (made) await http.deletePeer(name).catch(() => undefined) // nothing is left behind
    if (err instanceof RelayHttpError && err.status === 409) {
      if (err.detail === 'link_pending')
        return fail(
          io,
          `the last code for "${name}" was used and is still being picked up. Wait a few seconds and run this again.`,
        )
      return fail(
        io,
        "this Talos's relay is not on a public https address, so it cannot make a link code. Use the two-step link instead (talos-app peer create).",
      )
    }
    throw err
  }
  addInboundPeer(env.home, {
    name,
    conn_id: connId as string,
    link: { by: 'link', state: 'open', until: Date.now() + PEER_LINK_TTL_MS, ...(cap ? { cap } : {}) },
  })
  io.out(code)
  io.out('Give this code to your other Talos; it works once, for 15 minutes.')
  return 0
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    n += r.value.byteLength
    if (n > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('answer too long')
    }
    parts.push(r.value)
  }
  return Buffer.concat(parts).toString('utf8')
}

/** `peer accept <code> --name <name> [--cap N]` */
export async function cmdPeerAccept(
  e: LinkEnv,
  codeText: string,
  name: string,
  cap: number | undefined,
): Promise<number> {
  const { env, io } = e
  const parsed = parsePeerLinkCode(codeText)
  if (!parsed.ok)
    return fail(
      io,
      'that is not a link code. It looks like talos-link:<host>/<id>/<token>, from "talos-app peer link" on the other Talos.',
    )
  const code = parsed.value
  // all local refusals come before any network call
  const file = e.config()
  const cfg = file.load()
  if (cfg.peers.some((p) => p.name === name) || readInboundPeers(env.home).some((p) => p.name === name))
    return fail(
      io,
      `this Talos already has a linked agent named "${name}". Pick another name with --name, or run "talos-app peer remove ${name}" first.`,
    )
  if (cfg.peers.length >= PEER_MAX) return fail(io, TOO_MANY(PEER_MAX))
  const theirs = peerInboxUrl(`https://${code.host}`, code.conn_id)
  if (!PeerConfig.safeParse({ name, url: theirs }).success || checkPeerInboxUrl(theirs) === null)
    return fail(io, 'that link code does not name a usable address.')
  const store = await e.secrets()
  const http = await e.http()

  // 1. our own inbox, on our own relay
  let made: Awaited<ReturnType<RelayHttp['createPeer']>>
  try {
    made = await http.createPeer({ name, ...(cap ? { daily_cap: cap } : {}) })
  } catch (err) {
    if (err instanceof RelayHttpError && err.status === 409)
      return fail(
        io,
        `there is already an inbox named "${name}" on your relay (or ${PEER_MAX} inboxes). Run "talos-app peer remove ${name}" first, or pick another name.`,
      )
    throw err
  }
  const undo = async (): Promise<void> => {
    await http.deletePeer(name).catch(() => undefined) // nothing is left behind on our relay
  }
  if (checkPeerInboxUrl(made.inbox_url) === null) {
    await undo()
    return fail(
      io,
      "your relay's address cannot be used for a link code (it must be a public https address). Use the two-step link instead (talos-app peer create).",
    )
  }

  // 2. redeem at the other relay: https only, no redirects, no private addresses, ten seconds
  const send: RedeemFetch =
    e.deps.fetch ??
    createGuardedFetch({ timeoutMs: REDEEM_TIMEOUT_MS, ...(e.deps.resolve ? { resolve: e.deps.resolve } : {}) })
  let status = 0
  let answer = ''
  try {
    const res = await send(`https://${code.host}/peer-link/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conn_id: code.conn_id,
        token: code.token,
        back: { url: made.inbox_url, secret: made.secret },
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    })
    status = res.status
    answer = await readCapped(res, REDEEM_BODY_MAX)
  } catch (err) {
    await undo()
    // only the host and the kind of failure: never the code, never what was sent
    const why =
      err instanceof BlockedAddressError
        ? 'that host resolves to an address Talos will not contact'
        : 'it could not be reached'
    return fail(io, `could not use the link code at ${code.host}: ${why}. Nothing was linked.`)
  }
  let their: string | undefined
  if (status === 200) {
    try {
      their = PeerLinkRedeemed.parse(JSON.parse(answer)).secret
    } catch {
      their = undefined
    }
  }
  if (their === undefined) {
    await undo()
    if (status === 404 && answer.includes(PEER_LINK_UNUSABLE)) return fail(io, UNUSABLE_LINE)
    return fail(
      io,
      `could not use the link code at ${code.host} (it answered ${status}). Nothing was linked. Ask for a new code with talos-app peer link on the other Talos.`,
    )
  }

  // 3. store: the secret in the key store, the inbox record, then the config entry (the last write is what the owner's rows watch)
  try {
    addInboundPeer(env.home, { name, conn_id: made.conn_id, link: { by: 'accept', state: 'done', until: 0 } })
    await store.set(PEER_SECRET_SERVICE, peerSecretAccount(name), their)
    file.update((c) => ({
      ...c,
      peers: [
        ...c.peers.filter((p) => p.name !== name),
        { name, url: theirs, daily_cap: cap ?? PEER_DAILY_CAP_DEFAULT },
      ],
    }))
  } catch (err) {
    removeInboundPeer(env.home, name)
    await store.delete(PEER_SECRET_SERVICE, peerSecretAccount(name)).catch(() => undefined)
    await undo()
    return fail(
      io,
      `the link was made but could not be stored (${(err as Error).message}). The code is used up: ask for a new one with talos-app peer link on the other Talos.`,
    )
  }
  e.clearRevoked(name)
  io.out(`linked with ${name}; messages work both ways once the other side has collected.`)
  return 0
}

const parseCap = (v: string | undefined): number | undefined | 'bad' => {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= PEER_DAILY_CAP_MAX ? n : 'bad'
}

/** The `link` and `accept` words of `peer`: the arguments are checked here, before anything is read or called. Returns the exit code. */
export async function runLink(
  sub: 'link' | 'accept',
  positionals: string[],
  values: {
    cap?: string | undefined
    url?: string | undefined
    'secret-file'?: string | undefined
    name?: string | undefined
  },
  e: LinkEnv,
  usage: string,
): Promise<number> {
  const cap = parseCap(values.cap)
  const only = positionals.length === 1 && positionals[0]
  if (!only || cap === 'bad' || values.url !== undefined || values['secret-file'] !== undefined) {
    e.io.err(usage)
    return 2
  }
  const badName = (n: string): number | undefined => {
    if (PeerName.safeParse(n).success) return undefined
    return fail(
      e.io,
      `"${n}" is not a name a linked agent can have: lower case letters, digits and hyphens, starting with a letter, and not a reserved word such as owner or agent.`,
    )
  }
  if (sub === 'link') {
    if (values.name !== undefined) {
      e.io.err(usage)
      return 2
    }
    return badName(only) ?? (await cmdPeerLink(e, only, cap))
  }
  if (!values.name)
    return fail(
      e.io,
      'say what you call the other Talos: talos-app peer accept <code> --name <name> (for example --name home).',
    )
  return badName(values.name) ?? (await cmdPeerAccept(e, only, values.name, cap))
}

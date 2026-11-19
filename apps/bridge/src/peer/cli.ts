// `talos-app peer create|add|list|remove|rotate` (docs/LINKED-AGENTS.md): linking this Talos to another of the owner's own.
// Typed by the owner in Terminal only (the command is `needs_terminal`): the agent cannot link, unlink or rotate a peer. A secret
// is shown once on create/rotate and is read on `add` from the terminal (no echo), never from the command line.
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  PEER_DAILY_CAP_DEFAULT,
  PEER_DAILY_CAP_MAX,
  PEER_MAX,
  PeerConfig,
  PeerName,
  type SecretStore,
} from '@talos-app/protocol'
import type { CliIO } from '../cli-main.ts'
import { type BridgeEnv, paths } from '../config.ts'
import { ConfigFile } from '../config-file.ts'
import { openHistory } from '../history-store.ts'
import { type RelayHttp, RelayHttpError } from '../relay-http.ts'
import { openSecretStore } from '../secrets/store.ts'
import { PeerLedger } from './ledger.ts'
import {
  addInboundPeer,
  PEER_SECRET_SERVICE,
  peerSecretAccount,
  readInboundPeers,
  removeInboundPeer,
} from './records.ts'
import { utcDayStart } from './service.ts'
import { validPeerSecret } from './sign.ts'

export const PEER_USAGE = `usage: talos-app peer create <name> [--cap N]
       talos-app peer add <name> --url <https inbox url> [--cap N]   (the secret is asked for, never typed on the command line)
       talos-app peer list | peer remove <name> | peer rotate <name>
Linking two Talos installs takes both directions. On each install: "peer create <name>" prints an inbox url and a secret once; give
both to the OTHER install, which runs "peer add <name> --url <url>" and pastes the secret when asked. <name> is what this install
calls the other one (for example work).`

export type PeerCliDeps = { secrets?: SecretStore }

const fail = (io: Pick<CliIO, 'err'>, text: string): number => {
  io.err(`talos-app: ${text}`)
  return 1
}

const parseCap = (v: string | undefined): number | undefined | 'bad' => {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= PEER_DAILY_CAP_MAX ? n : 'bad'
}

export async function cmdPeer(
  env: BridgeEnv,
  args: string[],
  io: CliIO,
  http: () => Promise<RelayHttp>,
  deps: PeerCliDeps = {},
): Promise<number> {
  const [sub, ...rest] = args
  // a secret on the command line is in the shell history and the process list: refused wherever it appears
  if (args.some((a) => a.includes('whsec_')))
    return fail(
      io,
      'a secret never goes on the command line. Run "peer add <name> --url <url>" and paste it when asked.',
    )
  let parsed: ReturnType<
    typeof parseArgs<{ options: { cap: { type: 'string' }; url: { type: 'string' } }; allowPositionals: true }>
  >
  try {
    parsed = parseArgs({
      args: rest,
      options: { cap: { type: 'string' }, url: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}`)
    io.err(PEER_USAGE)
    return 2
  }
  const { positionals, values } = parsed
  const name = positionals[0]
  const needName = (): string | number => {
    if (positionals.length !== 1 || !name) {
      io.err(PEER_USAGE)
      return 2
    }
    if (!PeerName.safeParse(name).success)
      return fail(
        io,
        `"${name}" is not a name a linked agent can have: lower case letters, digits and hyphens, starting with a letter, and not a reserved word such as owner or agent.`,
      )
    return name
  }
  const secrets = async (): Promise<SecretStore> => deps.secrets ?? openSecretStore({ home: env.home })
  const config = () => new ConfigFile(paths(env.home).configJson, { log: { warn: (m) => io.err(`talos-app: ${m}`) } })

  const hasConfigPeer = (nm: string): boolean => {
    try {
      return config()
        .load()
        .peers.some((p) => p.name === nm)
    } catch {
      return true // no readable config: nothing to say about it
    }
  }

  switch (sub) {
    case 'create': {
      const n = needName()
      if (typeof n === 'number') return n
      const cap = parseCap(values.cap)
      if (cap === 'bad' || values.url !== undefined) {
        io.err(PEER_USAGE)
        return 2
      }
      try {
        const made = await (await http()).createPeer({ name: n, ...(cap ? { daily_cap: cap } : {}) })
        addInboundPeer(env.home, { name: n, conn_id: made.conn_id })
        io.out(`Made the inbox "${n}" on your relay. It is shown once:`)
        io.out(`  url:    ${made.inbox_url}`)
        io.out(`  secret: ${made.secret}`)
        io.out(
          `Give both to the other Talos install and run there: talos-app peer add <the name it calls this one> --url ${made.inbox_url}`,
        )
        if (!hasConfigPeer(n))
          io.out(
            `Note: there is no peer named "${n}" set up to send from here yet; both sides must use the same name for each other, so run: talos-app peer add ${n} --url <the other install's inbox url>`,
          )
        return 0
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 409)
          return fail(
            io,
            `there is already an inbox named "${n}" (or ${PEER_MAX} inboxes). Run "talos-app peer remove ${n}" first, or pick another name.`,
          )
        throw e
      }
    }
    case 'add': {
      const n = needName()
      if (typeof n === 'number') return n
      const cap = parseCap(values.cap)
      if (cap === 'bad' || !values.url) {
        io.err(PEER_USAGE)
        return 2
      }
      const file = config()
      const existing = file.load().peers.find((p) => p.name === n)
      const entry = PeerConfig.safeParse({
        name: n,
        url: values.url,
        daily_cap: cap ?? existing?.daily_cap ?? PEER_DAILY_CAP_DEFAULT,
      })
      if (!entry.success) return fail(io, 'the url must be an https address (the inbox url the other install printed).')
      if (!existing && file.load().peers.length >= PEER_MAX)
        return fail(io, `this Talos already has ${PEER_MAX} linked agents.`)
      const ask = 'Paste the secret the other install printed (it is not shown): '
      const secret = (await (io.readSecret ? io.readSecret(ask) : io.prompt(ask))).trim()
      if (!validPeerSecret(secret))
        return fail(io, 'that is not a secret (it starts with whsec_). Nothing was changed.')
      await (await secrets()).set(PEER_SECRET_SERVICE, peerSecretAccount(n), secret)
      file.update((c) => ({ ...c, peers: [...c.peers.filter((p) => p.name !== n), entry.data] }))
      withLedger(env, (l) => l.clearRevoked(n)) // linked again: sending is allowed once more
      io.out(
        `Linked "${n}" (${new URL(entry.data.url).host}), up to ${entry.data.daily_cap} messages a day. Your agent can message it now.`,
      )
      if (!readInboundPeers(env.home).some((p) => p.name === n))
        io.out(
          `Note: there is no inbox named "${n}" here yet; both sides must use the same name for each other, so run: talos-app peer create ${n}`,
        )
      return 0
    }
    case 'list': {
      if (positionals.length > 0 || values.cap || values.url) {
        io.err(PEER_USAGE)
        return 2
      }
      const cfg = config().load().peers
      const store = await secrets()
      const inbox = await (await http()).listPeers()
      const p = paths(env.home)
      let ledger: PeerLedger | undefined
      let history: ReturnType<typeof openHistory> | undefined
      if (existsSync(p.historyDb)) {
        history = openHistory(p.historyDb)
        ledger = new PeerLedger(history.db)
      }
      try {
        const names = [...new Set([...cfg.map((c) => c.name), ...inbox.map((r) => r.name)])].sort()
        if (names.length === 0) io.out('No linked agents. See: talos-app peer create')
        for (const nm of names) {
          const out = cfg.find((c) => c.name === nm)
          const inb = inbox.find((r) => r.name === nm)
          let has = 'no'
          if (out) {
            try {
              has = (await store.get(PEER_SECRET_SERVICE, peerSecretAccount(nm))) ? 'yes' : 'no'
            } catch {
              has = 'unreadable'
            }
          }
          const sent = out ? (ledger?.sentSince(nm, utcDayStart(Date.now())) ?? 0) : 0
          io.out(
            `${nm}  sends to: ${out ? `${new URL(out.url).host}, cap ${out.daily_cap}/day, sent today ${sent}, secret ${has}` : 'not set up (peer add)'}  |  inbox: ${inb ? `cap ${inb.daily_cap}/day, received today ${inb.received_today}` : 'none (peer create)'}`,
          )
        }
      } finally {
        history?.close()
      }
      return 0
    }
    case 'remove': {
      const n = needName()
      if (typeof n === 'number') return n
      const found: string[] = []
      let code = 0
      try {
        await (await http()).deletePeer(n)
        found.push('the inbox on your relay')
      } catch (e) {
        code = 1
        io.err(
          `talos-app: could not reach the relay to remove the inbox "${n}" (${e instanceof RelayHttpError ? `relay said ${e.status}` : (e as Error).message}). Run this again when it is reachable.`,
        )
      }
      try {
        await (await secrets()).delete(PEER_SECRET_SERVICE, peerSecretAccount(n))
        found.push('its secret')
      } catch (e) {
        code = 1
        io.err(`talos-app: could not delete the secret of "${n}" (${(e as Error).message}).`)
      }
      try {
        const file = config()
        if (file.load().peers.some((p) => p.name === n)) {
          file.update((c) => ({ ...c, peers: c.peers.filter((p) => p.name !== n) }))
          found.push('the link in config.json')
        }
      } catch (e) {
        code = 1
        io.err(`talos-app: config.json was not changed (${(e as Error).message}).`)
      }
      if (removeInboundPeer(env.home, n)) found.push('the local record')
      withLedger(env, (l) => l.clearRevoked(n))
      io.out(
        code === 0
          ? `Removed "${n}": nothing more is sent to it and nothing more is taken from it.`
          : `Removed what could be reached for "${n}".`,
      )
      return code
    }
    case 'rotate': {
      const n = needName()
      if (typeof n === 'number') return n
      try {
        const r = await (await http()).rotatePeer(n)
        io.out(`A new secret for the inbox "${n}". It is shown once:`)
        io.out(`  secret: ${r.secret}`)
        io.out(
          `Give it to the other install: talos-app peer add <name> --url <the same inbox url>. The old secret keeps working for 24 hours. If the old one leaked, run "talos-app peer remove ${n}" and then "talos-app peer create ${n}" instead.`,
        )
        return 0
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 404)
          return fail(io, `there is no inbox named "${n}" on your relay.`)
        throw e
      }
    }
    default:
      io.err(PEER_USAGE)
      return sub === undefined || sub === 'help' ? 0 : 2
  }
}

/** Runs `fn` on the peer ledger in this home's history, when there is one (a fresh home has nothing to clear). */
function withLedger(env: BridgeEnv, fn: (l: PeerLedger) => void): void {
  const p = paths(env.home)
  if (!existsSync(p.historyDb)) return
  const history = openHistory(p.historyDb)
  try {
    fn(new PeerLedger(history.db))
  } finally {
    history.close()
  }
}

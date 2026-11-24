// `talos-app peer create|add|list|remove|rotate` (docs/LINKED-AGENTS.md): linking this Talos to another of the owner's own.
// The agent runs these itself unless "Lock Talos settings" is on (agent-cli.ts decides; owner ruling 2026-11-19). In a terminal a
// secret is shown once on create/rotate and is read on `add` (no echo). From an agent run it is never printed: create/rotate write it
// to <home>/peer-secrets/<name>.secret and `add --secret-file` reads that file. Never from the command line.
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
import { type LinkCliDeps, type LinkEnv, runLink } from './link-cli.ts'
import {
  addInboundPeer,
  PEER_SECRET_SERVICE,
  peerSecretAccount,
  readInboundPeers,
  removeInboundPeer,
} from './records.ts'
import { relinkLine } from './relink.ts'
import {
  checkPeerSecretPath,
  deleteIfSame,
  deletePeerSecretFile,
  type FileId,
  readSecretFile,
  writePeerSecretFile,
} from './secret-file.ts'
import { peerScopedStore } from './secret-store.ts'
import { utcDayStart } from './service.ts'
import { validPeerSecret } from './sign.ts'

export const PEER_USAGE = `usage: talos-app peer link <name> [--cap N]          (shows ONE code; give it to your other Talos)
       talos-app peer accept <code> --name <name> [--cap N]   (on the other Talos: paste the code; <name> is what you call the first one)
       talos-app peer create <name> [--cap N]
       talos-app peer add <name> --url <https inbox url> [--cap N] [--secret-file <file>]   (the secret is asked for, or read from the file; never typed on the command line)
       talos-app peer list | peer remove <name> | peer rotate <name> | peer secret-forget <name>
The one-paste link: on the first Talos run "peer link work" (work is what it calls the second one) and give the code it prints to the
second Talos, which runs "peer accept <code> --name home" (home is what the second one calls the first). The code works once, for 15 minutes.
The manual two-step link, if that cannot be used, takes both directions. On each install: "peer create <name>" makes an inbox: in a terminal it prints an inbox
url and a secret once; run by your agent it prints the url and writes the secret to a file (<talos home>/peer-secrets/<name>.secret).
Give both to the OTHER install, which runs "peer add <name> --url <url>" and pastes the secret when asked, or "--secret-file <file>"
(the file is deleted once stored). The creator's file is deleted when the first message arrives; "peer secret-forget <name>" deletes it by
hand. <name> is what this install calls the other one (for example work).`

const OPTIONS = {
  cap: { type: 'string' },
  url: { type: 'string' },
  'secret-file': { type: 'string' },
  name: { type: 'string' },
} as const

export type PeerCliDeps = {
  /** `peer accept`: the redeem call and the name lookup behind it (tests). */
  link?: LinkCliDeps
  secrets?: SecretStore /** Run with no terminal (an agent): no secret is printed or read from stdin. */
  agent?: boolean
}

const fail = (io: Pick<CliIO, 'err'>, text: string): number => {
  io.err(`talos-app: ${text}`)
  return 1
}

/** The one line an agent run of `create` ends with: what to carry where. */
const secretCarryLine = (name: string, url: string): string =>
  `Carry the inbox URL and that file to the other install and run there: talos-app peer add <the name it calls this one> --url ${url} --secret-file <file>. The file is deleted when the first message arrives (or run: talos-app peer secret-forget ${name}).`

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
  return runPeer(env, args, io, http, deps)
}

async function runPeer(
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
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}`)
    io.err(PEER_USAGE)
    return 2
  }
  const { positionals, values } = parsed
  const given = positionals[0]
  const name = sub === 'link' || sub === 'accept' ? given : given?.toLowerCase()
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
    if (given !== name) io.out(`Using the name "${name}" (names are lower case).`)
    return name
  }
  const secrets = async (): Promise<SecretStore> => {
    const store = deps.secrets ?? (await openSecretStore({ home: env.home }))
    // a keychain-wide store keeps this home's items under its own name (secrets/home-scope.ts), so any home may use it
    return peerScopedStore(store, env.home, { log: (m) => io.err(`talos-app: ${m}`) })
  }
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
    case 'link':
    case 'accept':
      return runLink(sub, positionals, values, linkEnvOf(env, io, http, deps, secrets, config), PEER_USAGE)
    case 'create': {
      const n = needName()
      if (typeof n === 'number') return n
      const cap = parseCap(values.cap)
      if (cap === 'bad' || values.url !== undefined || values['secret-file'] !== undefined) {
        io.err(PEER_USAGE)
        return 2
      }
      try {
        // an agent run writes the secret to its file before anything is made: a path that can't be written stops it here
        if (deps.agent) {
          try {
            checkPeerSecretPath(env.home, n)
          } catch (e) {
            return fail(io, (e as Error).message)
          }
        }
        const made = await (await http()).createPeer({ name: n, ...(cap ? { daily_cap: cap } : {}) })
        if (deps.agent) {
          // the file first, then the local record: a write that fails leaves no record, and the inbox on the relay is removed by `peer remove`
          let path: string
          try {
            path = writePeerSecretFile(env.home, n, made.secret)
          } catch (e) {
            return fail(
              io,
              `the inbox "${n}" was made on your relay but its secret could not be written (${(e as Error).message}). Run "talos-app peer remove ${n}" and then "talos-app peer create ${n}" again.`,
            )
          }
          addInboundPeer(env.home, { name: n, conn_id: made.conn_id, secret_file: { kind: 'create', at: Date.now() } })
          io.out(`Made the inbox "${n}" on your relay. Its secret is in ${path} (it is not shown).`)
          io.out(`  url:    ${made.inbox_url}`)
          io.out(secretCarryLine(n, made.inbox_url))
        } else {
          addInboundPeer(env.home, { name: n, conn_id: made.conn_id })
          io.out(`Made the inbox "${n}" on your relay. It is shown once:`)
          io.out(`  url:    ${made.inbox_url}`)
          io.out(`  secret: ${made.secret}`)
          io.out(
            `Give both to the other Talos install and run there: talos-app peer add <the name it calls this one> --url ${made.inbox_url}`,
          )
        }
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
      const secretFile = values['secret-file']
      let secret: string
      let fileId: FileId | undefined
      if (secretFile !== undefined) {
        try {
          const read = readSecretFile(secretFile)
          secret = read.secret
          fileId = read.id
        } catch (e) {
          return fail(io, `${(e as Error).message} Nothing was changed.`)
        }
      } else if (deps.agent) {
        return fail(
          io,
          'a secret is not read from the terminal when your agent runs this. Run "peer add <name> --url <url> --secret-file <file>" with the secret file the other install\'s "peer create" wrote.',
        )
      } else {
        const ask = 'Paste the secret the other install printed (it is not shown): '
        secret = (await (io.readSecret ? io.readSecret(ask) : io.prompt(ask))).trim()
      }
      if (!validPeerSecret(secret))
        return fail(io, 'that is not a secret (it starts with whsec_). Nothing was changed.')
      await (await secrets()).set(PEER_SECRET_SERVICE, peerSecretAccount(n), secret)
      file.update((c) => ({ ...c, peers: [...c.peers.filter((p) => p.name !== n), entry.data] }))
      withLedger(env, (l) => l.clearRevoked(n)) // linked again: sending is allowed once more
      if (secretFile !== undefined && fileId) {
        try {
          if (deleteIfSame(secretFile, fileId) === 'changed')
            io.err(
              `talos-app: the secret is stored, but ${secretFile} is no longer the file that was read (it was replaced), so it was not deleted.`,
            )
        } catch (e) {
          io.err(
            `talos-app: the secret is stored, but ${secretFile} could not be deleted (${(e as Error).message}); delete it yourself.`,
          )
        }
      }
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
      await listPeers(env, io, config().load().peers, await secrets(), await (await http()).listPeers())
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
      // the config entry goes first: a copy of a legacy secret needs a config entry, so nothing can bring the secret back after this
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
      try {
        await (await secrets()).delete(PEER_SECRET_SERVICE, peerSecretAccount(n))
        found.push('its secret')
      } catch (e) {
        code = 1
        io.err(`talos-app: could not delete the secret of "${n}" (${(e as Error).message}).`)
      }
      try {
        if (deletePeerSecretFile(env.home, n)) found.push('its secret file')
      } catch (e) {
        code = 1
        io.err(`talos-app: could not delete the secret file of "${n}" (${(e as Error).message}).`)
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
        if (deps.agent) checkPeerSecretPath(env.home, n)
        const r = await (await http()).rotatePeer(n)
        const old = `The old secret keeps working for 24 hours. If the old one leaked, run "talos-app peer remove ${n}" and then "talos-app peer create ${n}" instead.`
        if (deps.agent) {
          let path: string
          try {
            path = writePeerSecretFile(env.home, n, r.secret)
          } catch (e) {
            return fail(
              io,
              `the inbox "${n}" was rotated on your relay but the new secret could not be written (${(e as Error).message}). Run "talos-app peer remove ${n}" and then "talos-app peer create ${n}" again.`,
            )
          }
          const rec = readInboundPeers(env.home).find((x) => x.name === n)
          if (rec) addInboundPeer(env.home, { ...rec, secret_file: { kind: 'rotate', at: Date.now() } })
          io.out(`A new secret for the inbox "${n}" is in ${path} (it is not shown).`)
          io.out(
            'The file is deleted on the first message that arrives after the old secret stops working (24 hours), or by "talos-app peer secret-forget".',
          )
          io.out(
            `Give that file to the other install: talos-app peer add <name> --url <the same inbox url> --secret-file <file>. ${old}`,
          )
        } else {
          io.out(`A new secret for the inbox "${n}". It is shown once:`)
          io.out(`  secret: ${r.secret}`)
          io.out(`Give it to the other install: talos-app peer add <name> --url <the same inbox url>. ${old}`)
        }
        return 0
      } catch (e) {
        if (e instanceof RelayHttpError && e.status === 404)
          return fail(io, `there is no inbox named "${n}" on your relay.`)
        throw e
      }
    }
    case 'secret-forget': {
      const n = needName()
      if (typeof n === 'number') return n
      try {
        io.out(
          deletePeerSecretFile(env.home, n)
            ? `Deleted the secret file for "${n}".`
            : `There was no secret file for "${n}" (nothing to delete).`,
        )
        return 0
      } catch (e) {
        return fail(io, `could not delete the secret file of "${n}" (${(e as Error).message}).`)
      }
    }
    default:
      io.err(PEER_USAGE)
      return sub === undefined || sub === 'help' ? 0 : 2
  }
}

const linkEnvOf = (
  env: BridgeEnv,
  io: CliIO,
  http: () => Promise<RelayHttp>,
  deps: PeerCliDeps,
  secrets: () => Promise<SecretStore>,
  config: () => ConfigFile,
): LinkEnv => ({
  env,
  io,
  agent: deps.agent === true,
  http,
  secrets,
  config,
  clearRevoked: (n) => withLedger(env, (l) => l.clearRevoked(n)),
  deps: deps.link ?? {},
})

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

/** `peer list`: one line per name, from the config, the relay's inboxes, the secret store and today's ledger. */
async function listPeers(
  env: BridgeEnv,
  io: CliIO,
  cfg: ReturnType<ConfigFile['load']>['peers'],
  store: SecretStore,
  inbox: Awaited<ReturnType<RelayHttp['listPeers']>>,
): Promise<void> {
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
      const row = `${nm}  sends to: ${out ? `${new URL(out.url).host}, cap ${out.daily_cap}/day, sent today ${sent}, secret ${has}` : 'not set up (peer add)'}  |  inbox: ${inb ? `cap ${inb.daily_cap}/day, received today ${inb.received_today}` : 'none (peer create)'}`
      io.out(row)
      if (out && has === 'no') io.out(`  ${relinkLine(nm)}`)
    }
  } finally {
    history?.close()
  }
}

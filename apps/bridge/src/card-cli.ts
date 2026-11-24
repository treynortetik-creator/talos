// A card that names `talos-app peer ...` / `talos-app devices ...` commands (`cli` on the agent's `card` tool). The agent never runs
// them: when the owner presses the card's primary button in the app (his signed card.resolve, accepted once by the ledger), the BRIDGE
// runs each command itself, in this process, in order, once, and stops at the first one that fails. There is no CLI path for a session
// to trigger a run, no grant and no stored permission: nothing but his signed tap in the app starts one.
//
// What the owner is shown, all inside the payload hash he approves (three read-only fields the bridge writes from the argvs; an agent
// cannot write them): "What will happen" in plain words, "Details" with the exact commands, and a check code, the hash of those
// commands. Before running, the bridge checks the stored card still hashes to what he approved, that the commands, the plain words and
// the check code still agree, and that the commands are on the allowlist.
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type CardBinding,
  CLI_FIELD_KEY,
  clipUnits,
  DeviceId,
  PEER_DAILY_CAP_MAX,
  PeerName,
  parsePeerLinkCode,
  payloadHash,
} from '@talos-app/protocol'
import { revokeRefusal } from './agent-cli.ts'
import type { LedgerRow } from './cards-ledger.ts'
import type { CliIO } from './cli-main.ts'
import type { BridgeContext } from './context.ts'
import { AGENT_UNLESS_LOCKED, agentUnlessLocked } from './talos.ts'
import { SETTINGS_LOCKED } from './trust.ts'

export const CLI_PLAIN_KEY = 'talos_cli_plain'
export { CLI_FIELD_KEY }
export const CLI_HASH_KEY = 'talos_cli_hash'
const RESERVED_KEYS: readonly string[] = [CLI_PLAIN_KEY, CLI_FIELD_KEY, CLI_HASH_KEY]
export const CLI_PLAIN_LABEL = 'What will happen'
export const CLI_DETAILS_LABEL = 'Details'
export const CLI_HASH_LABEL = 'Commands check'
const RESERVED_LABELS = ['what will happen', 'details', 'commands check', 'lets your agent run', 'what it removes']
/** A resolve whose signed tap is older than this runs nothing (the ledger refuses it too: MAX_RESOLVE_AGE_MS). */
export const CLI_RUN_WINDOW_MS = 10 * 60_000
const MAX_COMMANDS = 8
const MAX_WORDS = 8

/**
 * The only commands a card may carry. Nothing that prints or writes a one-time code or a secret is on it (`peer link`, `peer create`,
 * `peer rotate`), and neither is `peer add`, which cannot succeed without a secret file a card is not allowed to name: a code shown on a
 * card is copied into the web app's and the Mac app's stores and the relay's log, which a card cannot keep it out of yet.
 */
export const CARD_CLI_ALLOWED = [
  'peer accept',
  'peer list',
  'peer remove',
  'peer secret-forget',
  'devices list',
  'devices revoke',
] as const
/** Commands that exist for the agent but not on a card, and the plain reason a card is refused for them. */
const NOT_ON_A_CARD: Record<string, string> = {
  'peer link': 'makes a one-time code',
  'peer create': 'makes a secret',
  'peer rotate': 'makes a secret',
  'peer add': 'needs a secret file',
}

/** One word of a command: no spaces (so the line on the card reads back as the same words), no quotes, no shell characters. */
const WORD = /^[A-Za-z0-9-][A-Za-z0-9._:@/=+-]{0,299}$/
const LINE_START = 'talos-app '
/** A flag that names a file, folder or path: a card never points a command at one. */
const FILE_FLAG = /^-+[A-Za-z0-9-]*(?:file|path|dir|folder)(?:=|$)/i
const URL_WORD = /^(?:https?:\/\/|talos-link:)/i
const looksLikePath = (w: string): boolean =>
  FILE_FLAG.test(w) ||
  (!URL_WORD.test(w) && (w.includes('/') || w.includes('..'))) ||
  /^file:/i.test(w) ||
  w.startsWith('.')

/** True when the agent's own field would pass for one of the bridge's (by key, or, on a card with commands, by label). */
export function isReservedField(f: unknown, cardHasCli: boolean): boolean {
  const x = f as { key?: unknown; label?: unknown } | null
  if (typeof x?.key === 'string' && RESERVED_KEYS.includes(x.key)) return true
  return cardHasCli && typeof x?.label === 'string' && RESERVED_LABELS.includes(x.label.trim().toLowerCase())
}

/** The agent's `cli` argument, checked. The error names what is wrong in words the agent can fix. */
export function parseCliArg(v: unknown): { ok: true; argvs: string[][] } | { ok: false; error: string } {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_COMMANDS)
    return { ok: false, error: `cli must be a list of 1 to ${MAX_COMMANDS} commands, each a list of words` }
  const argvs: string[][] = []
  for (const a of v) {
    if (
      !Array.isArray(a) ||
      a.length === 0 ||
      a.length > MAX_WORDS ||
      a.some((w) => typeof w !== 'string' || !WORD.test(w))
    )
      return {
        ok: false,
        error: 'each cli command must be a list of plain words (letters, digits and . _ : @ / = + -)',
      }
    const argv = a as string[]
    const pathy = argv.find(looksLikePath)
    if (pathy !== undefined)
      return {
        ok: false,
        error: `cli word \`${pathy.slice(0, 40)}\` names a file or folder: a card cannot carry a command that reads one`,
      }
    const name = agentUnlessLocked(argv)
    const why = name ? NOT_ON_A_CARD[name] : undefined
    if (name && why)
      return { ok: false, error: `talos-app ${name} ${why}, so it can't run from a card yet. Run it in Terminal.` }
    if (!name || !(CARD_CLI_ALLOWED as readonly string[]).includes(name))
      return {
        ok: false,
        error: `cli names \`${argv.join(' ')}\`, which a card cannot carry: only ${CARD_CLI_ALLOWED.join(', ')} can be`,
      }
    const read = parseCommand(argv)
    if (!read.ok) return { ok: false, error: `cli ${read.error}` }
    if (argvs.some((x) => x.join(' ') === argv.join(' '))) continue
    argvs.push(argv)
  }
  return { ok: true, argvs }
}

const argvLine = (a: readonly string[]) => `${LINE_START}${a.join(' ')}`

/** The check code of a list of commands. */
export function argvHash(argvs: readonly (readonly string[])[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(argvs)).digest('hex')}`
}

const REVOKE_PREFIX = 'Removes access for '

type Parsed = { name?: string; host?: string; cap?: number }
const OPTION_SETS: Record<string, { opts: readonly string[]; positionals: number; need?: string }> = {
  'peer accept': { opts: ['name', 'cap'], positionals: 1, need: 'name' },
  'peer list': { opts: [], positionals: 0 },
  'peer remove': { opts: [], positionals: 1 },
  'peer secret-forget': { opts: [], positionals: 1 },
  'devices list': { opts: [], positionals: 0 },
  'devices revoke': { opts: [], positionals: 1 },
}

/**
 * What a command's own words mean, read the way the CLI reads them (the same option names, strict): the name or code, the host a code or
 * url points at, and a cap. An option the sentence writer does not know, a missing required part or a value the CLI would refuse is an
 * error, so a card never shows words that leave out something the command does.
 */
function parseCommand(argv: readonly string[]): { ok: true; p: Parsed } | { ok: false; error: string } {
  const name = agentUnlessLocked(argv)
  const spec = name ? OPTION_SETS[name] : undefined
  if (!name || !spec) return { ok: false, error: `\`${argv.join(' ')}\` is not a command a card can describe` }
  const bad = (why: string) => ({ ok: false as const, error: `\`${argv.join(' ')}\`: ${why}` })
  const all = { cap: { type: 'string' }, name: { type: 'string' } } as const
  const options = Object.fromEntries(spec.opts.map((o) => [o, all[o as keyof typeof all]]))
  let parsed: ReturnType<typeof parseArgs<{ options: typeof all; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: argv.slice(2), options, allowPositionals: true, strict: true }) as typeof parsed
  } catch (e) {
    return bad(`an option a card cannot describe (${(e as Error).message.split('.')[0]})`)
  }
  const { positionals, values } = parsed
  if (positionals.length !== spec.positionals) return bad('the wrong number of words')
  if (spec.need && values[spec.need as 'name'] === undefined) return bad(`it needs --${spec.need}`)
  const p: Parsed = {}
  const subject = positionals[0]
  if (name === 'devices revoke') {
    if (!subject || !DeviceId.safeParse(subject).success) return bad('that is not a device id')
  } else if (name === 'peer accept') {
    const code = parsePeerLinkCode(subject ?? '')
    if (!code.ok) return bad('that is not a link code')
    p.host = code.value.host
    const n = values.name
    if (!n || !PeerName.safeParse(n).success) return bad('--name is not a name a linked agent can have')
    p.name = n
  } else if (subject !== undefined) {
    if (!PeerName.safeParse(subject).success) return bad('that is not a name a linked agent can have')
    p.name = subject
  }
  if (values.cap !== undefined) {
    const n = Number(values.cap)
    if (!/^\d+$/.test(values.cap) || !Number.isInteger(n) || n < 1 || n > PEER_DAILY_CAP_MAX)
      return bad(`--cap must be a whole number from 1 to ${PEER_DAILY_CAP_MAX}`)
    p.cap = n
  }
  return { ok: true, p }
}

/** Commands whose cards are always high risk: they connect this install to another agent, or take a device's access away. */
export const isHighRiskCommand = (argv: readonly string[]): boolean => {
  const n = agentUnlessLocked(argv)
  return n === 'peer accept' || n === 'devices revoke'
}

/**
 * What one command does, in plain words, written from what it was PARSED to mean (names, hosts, caps). A device revoke names the device
 * (looked up when the card is made). A command that does not parse reads as itself: it never reaches a card.
 */
export function plainSentence(argv: readonly string[], deviceNote?: string): string {
  const r = parseCommand(argv)
  if (!r.ok) return `Runs talos-app ${argv.join(' ')}.`
  const { name = '', host = '', cap } = r.p
  const perDay = cap ? `, up to ${cap} messages a day` : ''
  switch (agentUnlessLocked(argv)) {
    case 'peer accept':
      return `Connects to the agent at ${host} and calls it ${name}${perDay}.`
    case 'peer list':
      return 'Lists the agents you have linked.'
    case 'peer remove':
      return `Removes the link to ${name}.`
    case 'peer secret-forget':
      return `Forgets the stored secret for ${name}.`
    case 'devices list':
      return 'Lists your approved devices.'
    case 'devices revoke':
      return `${REVOKE_PREFIX}${deviceNote ?? argv[2] ?? ''}.`
    default:
      return `Runs talos-app ${argv.join(' ')}.`
  }
}

/** The three fields the bridge puts first on the card, written from the argvs. `notes` maps a revoked device id to "name (added date)". */
export function cliFields(argvs: readonly (readonly string[])[], notes: Record<string, string> = {}) {
  const plain = argvs.map((a, i) => `${i + 1}. ${plainSentence(a, a[2] ? notes[a[2]] : undefined)}`).join('\n')
  const f = (key: string, label: string, value: string) => ({ key, label, value, editable: false, multiline: true })
  return [
    f(CLI_PLAIN_KEY, CLI_PLAIN_LABEL, plain),
    f(CLI_FIELD_KEY, CLI_DETAILS_LABEL, argvs.map(argvLine).join('\n')),
    f(CLI_HASH_KEY, CLI_HASH_LABEL, argvHash(argvs)),
  ]
}

/** True when the card carries the bridge's command field at all (whether or not it still checks out). */
export const hasCliField = (b: Pick<CardBinding, 'fields'>): boolean => b.fields.some((f) => f.key === CLI_FIELD_KEY)

/**
 * What a card's binding says to run, or undefined when the three fields do not agree (the commands, the plain words and the check code),
 * a field is editable, or a command is off the allowlist. A card with no command field gives [].
 */
export function cliOfBinding(binding: Pick<CardBinding, 'fields'>): string[][] | undefined {
  if (!hasCliField(binding)) return []
  const get = (k: string) => binding.fields.filter((f) => f.key === k)
  const [plain, details, check] = [get(CLI_PLAIN_KEY), get(CLI_FIELD_KEY), get(CLI_HASH_KEY)]
  if (plain.length !== 1 || details.length !== 1 || check.length !== 1) return undefined
  if ([plain[0], details[0], check[0]].some((f) => f?.editable !== false)) return undefined
  const argvs: string[][] = []
  for (const line of (details[0]?.value ?? '').split('\n')) {
    if (!line.startsWith(LINE_START)) return undefined
    argvs.push(line.slice(LINE_START.length).split(' '))
  }
  const ok = parseCliArg(argvs)
  if (!ok.ok || ok.argvs.length !== argvs.length) return undefined
  if (check[0]?.value !== argvHash(argvs)) return undefined
  const lines = (plain[0]?.value ?? '').split('\n')
  if (lines.length !== argvs.length) return undefined
  for (const [i, argv] of argvs.entries()) {
    const want = `${i + 1}. ${plainSentence(argv)}`
    const got = lines[i] ?? ''
    const revoke = argv[0] === 'devices' && argv[1] === 'revoke'
    if (revoke ? !got.startsWith(`${i + 1}. ${REVOKE_PREFIX}`) || got.includes('\n') : got !== want) return undefined
  }
  return argvs
}

export type RunCli = (
  argv: string[],
  io: CliIO,
  env: Record<string, string | undefined>,
  deps: { cwd?: string; peerAgentProfile?: boolean; bridgeCaller?: boolean },
) => Promise<number>

/**
 * `text` is the short summary: it goes to the thread and never carries a code or secret. `owner` is the card's own result in the app:
 * the summary, then what the commands printed. Both are redacted: nothing on a card prints a code or secret (see CARD_CLI_ALLOWED), so
 * this only catches what should never be there.
 */
export type CardCliResult = { ok: boolean; ran: number; text: string; owner: string }

const hide = (s: string) => s.replace(/talos-link:\S+|whsec_\S+/g, '(hidden)')
const RESULT_MAX = 500

/**
 * Runs the approved card's commands with the owner's authority, in order, once each, stopping at the first failure. Refused, running
 * nothing, when: the stored card no longer hashes to what he approved, the three fields disagree, the lock is on, or his tap is older
 * than ten minutes. A `devices revoke` still never takes the last approved device nor the one his latest message came from.
 * They run with the AGENT profile of the CLI (no secret is printed or read) in a fresh 0700 folder removed afterwards. (An agent session reaches none of this: the only caller is the owner's signed card.resolve in inbound-cards.ts.)
 */
export async function runCardCli(ctx: BridgeContext, row: LedgerRow, run: RunCli): Promise<CardCliResult> {
  const stop = (text: string): CardCliResult => ({ ok: false, ran: 0, text, owner: text })
  if (payloadHash(row.binding) !== row.payload_hash)
    return stop('The card no longer matches what you approved, so nothing was run.')
  const argvs = cliOfBinding(row.binding)
  if (!argvs || argvs.length === 0) return stop('The commands on this card could not be checked, so nothing was run.')
  const tap = Date.parse(row.resolution?.at ?? '')
  if (row.resolution?.action !== 'primary' || !Number.isFinite(tap))
    return stop('This card was not approved, so nothing was run.')
  if (ctx.clock.now() - tap > CLI_RUN_WINDOW_MS)
    return stop('Your approval is more than 10 minutes old, so nothing was run. Ask your agent for a new card.')
  // the same relay and home this bridge was started with: the commands see what the owner's own terminal would
  const raw: Record<string, string | undefined> = { ...process.env, TALOS_APP_HOME: ctx.paths.home }
  if (ctx.env.relayUrl) raw.TALOS_APP_RELAY_URL = ctx.env.relayUrl
  for (const k of ['TALOS_APP_WORKER_THREAD', 'TALOS_APP_WORKER_NONCE', 'TALOS_SESSION_ROLE']) delete raw[k]
  // a folder of its own (0700, made by mkdtemp), so nothing the run reads or writes by a relative path is anyone else's
  const cwd = mkdtempSync(join(tmpdir(), 'talos-cardcli-'))
  const shown: string[] = []
  const summary = (text: string): CardCliResult => {
    const t = hide(clipUnits(text, 300))
    return {
      ok: false,
      ran: 0,
      text: t,
      owner: clipUnits([t, ...(shown.length ? [shown.join('\n')] : [])].join('\n\n'), RESULT_MAX),
    }
  }
  try {
    for (const [i, argv] of argvs.entries()) {
      const line = argvLine(argv)
      // the lock is read live before every command; the last-device rule is the one `devices revoke` has for an agent
      const no =
        ctx.config.config.settings_lock === true
          ? SETTINGS_LOCKED
          : agentUnlessLocked(argv) === 'devices revoke'
            ? revokeRefusal(ctx.paths.devicesJson, argv[2], ctx.store)
            : undefined
      if (no) {
        shown.push(`${hide(line)}\n${no}`)
        return { ...summary(`${i ? `Ran ${i} of ${argvs.length}. ` : ''}Stopped at ${line}: ${no}`), ran: i }
      }
      const lines: string[] = []
      const io: CliIO = {
        isTerminal: true,
        out: (l) => lines.push(l),
        err: (l) => lines.push(l),
        prompt: async () => {
          throw new Error('this command needs something typed in a terminal, so it cannot run from a card')
        },
        readSecret: async () => {
          throw new Error('this command needs a secret typed in a terminal, so it cannot run from a card')
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => ctx.clock.now(),
      }
      let code: number
      try {
        code = await run(argv, io, raw, { cwd, peerAgentProfile: true, bridgeCaller: true })
      } catch (e) {
        lines.push((e as Error).message)
        code = 1
      }
      shown.push(hide(`${line}${lines.length ? `\n${lines.join('\n')}` : ''}`))
      if (code !== 0) {
        const why = lines[lines.length - 1] ?? `it exited with ${code}`
        return { ...summary(`Stopped at ${line}: ${why}`), ran: i + 1 }
      }
    }
    return {
      ...summary(`Ran ${argvs.length === 1 ? '1 command' : `${argvs.length} commands`}.`),
      ok: true,
      ran: argvs.length,
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

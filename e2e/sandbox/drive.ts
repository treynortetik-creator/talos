// `sandbox drive <id> <action>`: the owner's side of a sandbox, one action per call, JSON in and JSON out.
//
// App actions go over the relay protocol as the enrolled phone: every owner frame is signed with the phone's device key,
// exactly as the app signs it, so the Mac checks it the same way. Machine actions (kill Main, freeze the bridge, damage a
// file) touch only what the sandbox itself started or wrote, found through its own record, tmux server and folders.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindingFrom, type CardT, newUlid, payloadHash } from '@talos-app/protocol'
import type { FakeApp } from '@talos-app/testkit'
import { BRIDGE_CLI, BRIDGE_DIR } from '../harness/paths.ts'
import { type Raw, rowsAfterAck } from './frames.ts'
import { connectPhone, type Phone } from './phone.ts'
import {
  cleanEnv,
  files,
  groupAlive,
  isAlive,
  loadRecord,
  procOf,
  SandboxError,
  type SandboxRecord,
  saveRecord,
  signal,
  signalGroup,
  sleep,
  stopProc,
  waitUntil,
} from './state.ts'
import {
  answerStartDialog,
  bridgeStatus,
  mainReady,
  relayHealthy,
  screen,
  startRelay,
  supervisorStatus,
  tmux,
} from './up.ts'

export type Params = Record<string, unknown>
type Result = Record<string, unknown>

const str = (p: Params, key: string, fallback?: string): string => {
  const v = p[key]
  if (typeof v === 'string' && v !== '') return v
  if (typeof v === 'number') return String(v)
  if (fallback !== undefined) return fallback
  throw new SandboxError('bad_args', `this action needs --${key}`)
}
const num = (p: Params, key: string, fallback: number): number => {
  const v = p[key]
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new SandboxError('bad_args', `--${key} must be a number`)
  return n
}
const flag = (p: Params, key: string, fallback: boolean): boolean => {
  const v = p[key]
  if (v === undefined) return fallback
  return !(v === false || v === 'false' || v === '0' || v === 'no' || v === 'off')
}

/**
 * Every frame the phone received, with the ones a catch-up batch carried unpacked in place. `live` leaves the batches
 * out: what is left arrived as it happened, not as history from before this visit.
 */
function received(app: FakeApp, since = 0, live = false): Raw[] {
  const out: Raw[] = []
  for (const r of app.rec.frames) {
    if (r.direction !== 'in' || r.n < since) continue
    if (r.raw.type === 'catchup.batch' && Array.isArray(r.raw.frames)) {
      const to = r.raw.to_seq
      if (typeof to === 'number') app.lastSeq = Math.max(app.lastSeq, to)
      if (!live) out.push(...(r.raw.frames as Raw[]))
    } else out.push(r.raw)
  }
  return out
}

const mark = (app: FakeApp): number => app.rec.frames.length

const batches = (app: FakeApp) => app.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'catchup.batch')

/**
 * The relay hands a backlog over in pages (CATCHUP_PAGE frames each, `more` while another follows). Asks for every next
 * page, so a visit reads the whole backlog and not only its first 200 frames.
 */
async function readWholeBacklog(app: FakeApp): Promise<number> {
  for (let pages = 1; ; pages++) {
    const seen = batches(app)
    const last = seen.at(-1)?.raw
    if (!last || last.more !== true || typeof last.to_seq !== 'number') return seen.length
    app.send({ type: 'catchup.request', since_seq: last.to_seq })
    await waitUntil(() => batches(app).length > seen.length, `catch-up page ${pages + 1}`, 15_000, 50)
  }
}

async function until<T>(
  app: FakeApp,
  since: number,
  ms: number,
  pick: (frames: Raw[]) => T | undefined,
  live = false,
): Promise<T | undefined> {
  const end = Date.now() + ms
  for (;;) {
    const got = pick(received(app, since, live))
    if (got !== undefined) return got
    if (Date.now() >= end || !app.connected) return pick(received(app, since, live))
    await sleep(25)
  }
}

const errorsFor = (frames: Raw[], ref?: string): Raw[] =>
  frames.filter((f) => f.type === 'error' && (ref === undefined || f.ref === ref || f.ref === undefined))

const briefMessage = (m: Raw | undefined) =>
  m === undefined
    ? null
    : {
        id: m.id,
        thread_id: m.thread_id,
        author: m.author,
        kind: m.kind,
        text: m.text,
        created_at: m.created_at,
        seq: m.seq,
      }

async function withPhone<T>(rec: SandboxRecord, f: (phone: Phone) => Promise<T>, fromSeq?: number): Promise<T> {
  const phone = await connectPhone(rec, fromSeq === undefined ? {} : { fromSeq })
  try {
    return await f(phone)
  } finally {
    await phone.close()
  }
}

// ---- config (the owner path: a signed config.patch, answered by the Mac) -------------------------------------------

type Config = { rev: number; config: Raw; threads: Raw[] }

/** The config as this phone was told it: the `ready` frame, then any `config.sync` that followed. */
async function currentConfig(phone: Phone, since = 0): Promise<Config> {
  await sleep(150) // a config.sync sent right behind `ready` lands here
  let config = (phone.ready.agent_config as Raw | undefined) ?? {}
  let threads = (phone.ready.threads as Raw[] | undefined) ?? []
  let rev = typeof config.rev === 'number' ? config.rev : 0
  for (const f of received(phone.app, since)) {
    if (f.type !== 'config.sync') continue
    config = f.config as Raw
    if (Array.isArray((config as { threads?: unknown }).threads)) threads = (config as { threads: Raw[] }).threads
    if (typeof f.rev === 'number') rev = f.rev
  }
  if (Array.isArray((config as { threads?: unknown }).threads)) threads = (config as { threads: Raw[] }).threads
  return { rev, config, threads }
}

async function patchConfig(phone: Phone, patch: Raw, timeoutMs: number): Promise<Result> {
  const cfg = await currentConfig(phone)
  const at = mark(phone.app)
  const sent = (await phone.app.sendConfigPatch(cfg.rev, patch)) as Raw
  const id = sent.id as string
  const answer = await until(phone.app, at, timeoutMs, (frames) => {
    const applied = frames.find((f) => f.type === 'config.sync' && f.applied === id)
    if (applied) return { applied: true as const, rev: applied.rev, config: applied.config }
    const refused = frames.find((f) => f.type === 'error' && f.ref === id)
    if (refused) return { applied: false as const, error: { code: refused.code, message: refused.message } }
    return undefined
  })
  const acked = received(phone.app, at).some((f) => f.type === 'ack' && f.ref === id)
  if (!answer)
    return {
      ok: false,
      patch_id: id,
      base_rev: cfg.rev,
      relay_acked: acked,
      error: { code: 'no_answer', message: `the Mac did not confirm or refuse the change within ${timeoutMs} ms` },
    }
  return { ok: answer.applied, patch_id: id, base_rev: cfg.rev, relay_acked: acked, ...answer }
}

const threadId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 32) || `t_${newUlid().slice(-6).toLowerCase()}`

async function changeThreads(
  phone: Phone,
  p: Params,
  change: (threads: Raw[]) => { threads: Raw[]; extra?: Raw },
): Promise<Result> {
  const cfg = await currentConfig(phone)
  const next = change(cfg.threads.map((t) => ({ ...t })))
  return patchConfig(phone, { threads: next.threads, ...(next.extra ?? {}) }, num(p, 'timeout_s', 20) * 1000)
}

const findThread = (threads: Raw[], id: string): Raw => {
  const t = threads.find((x) => x.id === id)
  if (!t)
    throw new SandboxError(
      'no_thread',
      `no thread ${JSON.stringify(id)} (threads: ${threads.map((x) => x.id).join(', ')})`,
    )
  return t
}

// ---- machine side ---------------------------------------------------------------------------------------------------

function mainPane(rec: SandboxRecord): number {
  const pid = supervisorStatus(rec)?.panePid
  if (!pid || !groupAlive(pid)) throw new SandboxError('no_main', 'Main is not running in this sandbox (see: status)')
  // the pid must be a pane of the sandbox's own tmux server: nothing outside it is ever signalled
  const panes = tmux(rec, ['list-panes', '-a', '-F', '#{pane_pid}'])
    .stdout.split('\n')
    .map((l) => Number(l.trim()))
  if (!panes.includes(pid)) throw new SandboxError('no_main', `pid ${pid} is not a pane of tmux -L ${rec.tmux.socket}`)
  return pid
}

const SIGNALS: Record<string, NodeJS.Signals> = {
  KILL: 'SIGKILL',
  TERM: 'SIGTERM',
  INT: 'SIGINT',
  HUP: 'SIGHUP',
  STOP: 'SIGSTOP',
  CONT: 'SIGCONT',
}
const sig = (p: Params, fallback: string): NodeJS.Signals => {
  const name = str(p, 'signal', fallback).toUpperCase().replace(/^SIG/, '')
  const s = SIGNALS[name]
  if (!s) throw new SandboxError('bad_args', `--signal must be one of ${Object.keys(SIGNALS).join(', ')}`)
  return s
}

/** The live bridge of this sandbox: the pid its status file names, and only while it sits in Main's process group. */
function bridgeProc(rec: SandboxRecord): number {
  const pid = bridgeStatus(rec)?.pid
  const pane = supervisorStatus(rec)?.panePid
  if (!pid || !pane) throw new SandboxError('no_bridge', 'no live bridge is recorded for this sandbox')
  const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())
  if (pgid !== pane)
    throw new SandboxError('no_bridge', `pid ${pid} is not in Main's process group (${pane}); the bridge has gone`)
  return pid
}

/** The sandbox's own files a break test may damage, by name. Nothing outside the sandbox root is reachable here. */
function damageable(rec: SandboxRecord): Record<string, string> {
  const f = files(rec.root)
  return {
    config: join(rec.home, 'config.json'),
    devices: join(rec.home, 'devices.json'),
    supervisor: join(rec.home, 'supervisor.json'),
    'supervisor-status': join(rec.home, 'supervisor-status.json'),
    status: join(rec.home, 'status.json'),
    'bridge-env': join(rec.home, 'bridge.env'),
    'bridge-key': join(rec.home, 'bridge.key'),
    'bridge-pid': join(rec.home, 'bridge.pid'),
    workers: join(rec.home, 'workers.json'),
    history: join(rec.home, 'history.sqlite'), // the bridge's paths(home).historyDb

    mcp: join(rec.agent_dir, '.mcp.json'),
    phone: f.phone,
  }
}

const backupOf = (path: string) => `${path}.sandbox-backup`

function tailFile(path: string, lines: number): { path: string; lines: string[]; exists: boolean } {
  if (!existsSync(path)) return { path, lines: [], exists: false }
  const all = readFileSync(path, 'utf8').split('\n')
  if (all[all.length - 1] === '') all.pop()
  return { path, lines: all.slice(-lines), exists: true }
}

async function waitRestart(rec: SandboxRecord, oldPid: number, ms: number): Promise<Result> {
  const before = supervisorStatus(rec)?.restarts?.length ?? 0
  let timedOut = false
  await waitUntil(
    () => {
      if (rec.auto_dev_channels) answerStartDialog(rec) // the restarted Main stops at the warning until someone answers
      const s = supervisorStatus(rec)
      return Boolean(s?.panePid && s.panePid !== oldPid && mainReady(rec)) || s?.phase === 'stopped'
    },
    'Main to be restarted',
    ms,
    250,
  ).catch(() => {
    timedOut = true
  })
  const s = supervisorStatus(rec)
  return {
    restarted: !timedOut && s?.phase === 'running' && s.panePid !== oldPid,
    old_pid: oldPid,
    new_pid: s?.panePid ?? null,
    phase: s?.phase ?? null,
    stop_reason: s?.stopReason ?? null,
    restarts_recorded: (s?.restarts?.length ?? 0) - before,
    bridge_live: mainReady(rec),
  }
}

// ---- the actions ----------------------------------------------------------------------------------------------------

type Action = { about: string; args: string; run: (rec: SandboxRecord, p: Params) => Promise<Result> }

export const ACTIONS: Record<string, Action> = {
  send: {
    about: 'send an owner message to a thread, then wait for the agent’s reply',
    args: '--thread <id> --text <text> | --text-file <path> | --chars <n>  [--wait false] [--replies <n>] [--timeout_s <n>]',
    run: async (rec, p) => {
      const thread = str(p, 'thread', 'general')
      const text =
        p['text-file'] !== undefined
          ? readFileSync(str(p, 'text-file'), 'utf8')
          : p.chars !== undefined
            ? 'x'.repeat(Math.max(0, num(p, 'chars', 0)))
            : str(p, 'text')
      const wait = flag(p, 'wait', true)
      const want = Math.max(1, num(p, 'replies', 1))
      const timeoutMs = num(p, 'timeout_s', rec.mode === 'real' ? 180 : 30) * 1000
      return withPhone(rec, async (phone) => {
        const at = mark(phone.app)
        const sent = (await phone.app.sendMessage(thread, text)) as Raw
        const id = sent.id as string
        const msgId = sent.client_msg_id as string
        const settled = await until(phone.app, at, 10_000, (frames) =>
          frames.some(
            (f) => (f.type === 'ack' && f.ref === id) || (f.type === 'error' && (f.ref === id || f.ref === undefined)),
          )
            ? true
            : undefined,
        )
        const inThread = (frames: Raw[], author: 'agent' | 'system') => rowsAfterAck(frames, id, thread, author)
        const replies = (frames: Raw[]) => inThread(frames, 'agent')
        if (wait && settled)
          await until(
            phone.app,
            at,
            timeoutMs,
            (frames) => (replies(frames).length >= want || errorsFor(frames, id).length > 0 ? true : undefined),
            true,
          )
        const frames = received(phone.app, at, true)
        const got = replies(frames)
        const errors = errorsFor(frames, id).map((f) => ({ code: f.code, message: f.message, ref: f.ref }))
        const acked = frames.some((f) => f.type === 'ack' && f.ref === id)
        return {
          ok: acked && errors.length === 0 && (!wait || got.length >= want),
          thread,
          frame_id: id,
          message_id: msgId,
          chars: text.length,
          relay_acked: acked,
          receipts: frames.filter((f) => f.type === 'receipt' && f.message_id === msgId).map((f) => f.state),
          reply: briefMessage(got[0]),
          replies: got.map(briefMessage),
          // rows the Mac or the relay added to the thread on their own (a notice, a fallback)
          system_rows: inThread(frames, 'system').map(briefMessage),
          errors,
          // the relay hung up on the phone (an oversized or malformed frame, too many frames): its close code says why
          ...(phone.closed ? { socket_closed: phone.closed } : {}),
          ...(wait && got.length < want && errors.length === 0 && !phone.closed
            ? { timed_out_after_ms: timeoutMs }
            : {}),
        }
      })
    },
  },
  threads: {
    about: 'list the threads',
    args: '',
    run: (rec) =>
      withPhone(rec, async (phone) => {
        const cfg = await currentConfig(phone)
        return {
          ok: true,
          rev: cfg.rev,
          default_thread: cfg.config.default_thread ?? null,
          unread: phone.ready.unread ?? {},
          threads: cfg.threads,
        }
      }),
  },
  'thread-create': {
    about: 'create a thread',
    args: '--name <name> [--id <id>] [--topic <text>]',
    run: (rec, p) =>
      withPhone(rec, (phone) =>
        changeThreads(phone, p, (threads) => {
          const name = str(p, 'name')
          const id = str(p, 'id', threadId(name))
          const order = Math.max(-1, ...threads.map((t) => (typeof t.order === 'number' ? t.order : 0))) + 1
          return {
            threads: [
              ...threads,
              {
                id,
                name,
                kind: 'fixed',
                order,
                notify: 'all',
                archived: false,
                created_at: new Date().toISOString(),
                ...(p.topic !== undefined ? { topic: str(p, 'topic') } : {}),
              },
            ],
          }
        }),
      ),
  },
  'thread-rename': {
    about: 'rename a thread (its id never changes)',
    args: '--thread <id> --name <name>',
    run: (rec, p) =>
      withPhone(rec, (phone) =>
        changeThreads(phone, p, (threads) => {
          findThread(threads, str(p, 'thread')).name = str(p, 'name')
          return { threads }
        }),
      ),
  },
  'thread-archive': {
    about: 'archive a thread, or restore it with --archived false',
    args: '--thread <id> [--archived false]',
    run: (rec, p) =>
      withPhone(rec, (phone) =>
        changeThreads(phone, p, (threads) => {
          findThread(threads, str(p, 'thread')).archived = flag(p, 'archived', true)
          return { threads }
        }),
      ),
  },
  'thread-dedicated': {
    about: 'give a thread its own session (and turn the master switch on), or back to shared with --on false',
    args: '--thread <id> [--on false]',
    run: (rec, p) =>
      withPhone(rec, (phone) =>
        changeThreads(phone, p, (threads) => {
          const on = flag(p, 'on', true)
          findThread(threads, str(p, 'thread')).session = on ? 'dedicated' : 'shared'
          return { threads, ...(on ? { extra: { dedicated: { enabled: true } } } : {}) }
        }),
      ),
  },
  'thread-session': {
    about: "set a thread's parent and session options (a sub-thread: --parent; --parent null takes it out)",
    args: '--thread <id> [--parent <id>|null] [--cwd <path>] [--mcp_allow <json list>|null]',
    run: (rec, p) =>
      withPhone(rec, (phone) =>
        changeThreads(phone, p, (threads) => {
          const t = findThread(threads, str(p, 'thread'))
          if (p.parent !== undefined) {
            if (p.parent === 'null') delete t.parent_id
            else t.parent_id = str(p, 'parent')
          }
          const opts = { ...((t.session_opts as Raw | undefined) ?? {}) }
          if (p.cwd !== undefined) opts.cwd = str(p, 'cwd')
          if (p.mcp_allow !== undefined) {
            if (p.mcp_allow === 'null') delete opts.mcp_allow
            else opts.mcp_allow = JSON.parse(str(p, 'mcp_allow')) as unknown
          }
          t.session_opts = opts
          return { threads }
        }),
      ),
  },
  config: {
    about: 'read the config, or change it with a signed config.patch (the owner path)',
    args: '[--patch <json merge patch>] [--timeout_s <n>]',
    run: (rec, p) =>
      withPhone(rec, async (phone) => {
        if (p.patch === undefined) {
          const cfg = await currentConfig(phone)
          return { ok: true, rev: cfg.rev, config: cfg.config }
        }
        const patch = typeof p.patch === 'string' ? (JSON.parse(p.patch) as Raw) : (p.patch as Raw)
        return patchConfig(phone, patch, num(p, 'timeout_s', 20) * 1000)
      }),
  },
  cards: {
    about: 'list the open cards',
    args: '',
    run: (rec) =>
      withPhone(rec, async (phone) => {
        const cards = openCards(phone)
        return { ok: true, count: cards.length, cards }
      }),
  },
  'card-answer': {
    about: 'answer an open card: primary (approve), secondary (the kill button) or revise',
    args: '--card <id> [--action primary|secondary|revise] [--note <text>] [--times <n>] [--timeout_s <n>]',
    run: (rec, p) =>
      withPhone(rec, async (phone) => {
        const id = str(p, 'card')
        const card = openCards(phone).find((c) => c.id === id)
        if (!card)
          throw new SandboxError(
            'no_card',
            `no open card ${id} (open: ${
              openCards(phone)
                .map((c) => c.id)
                .join(', ') || 'none'
            })`,
          )
        const word = str(p, 'action', 'primary')
        const action = word === 'secondary' ? 'kill' : word
        if (action !== 'primary' && action !== 'kill' && action !== 'revise')
          throw new SandboxError('bad_args', '--action must be primary, secondary or revise')
        const times = Math.max(1, num(p, 'times', 1))
        const hash = payloadHash(bindingFrom(card as unknown as CardT))
        const at = mark(phone.app)
        const sent: string[] = []
        // --times 2 is a double tap: the same decision signed and sent twice, as two frames
        for (let i = 0; i < times; i++) {
          const f = (await phone.app.resolveCard(
            { id: id as CardT['id'] },
            action,
            hash,
            action === 'revise' ? { note: str(p, 'note', 'please revise') } : {},
          )) as Raw
          sent.push(f.id as string)
        }
        const timeoutMs = num(p, 'timeout_s', rec.mode === 'real' ? 120 : 20) * 1000
        const done = (frames: Raw[]) => {
          const updates = frames.filter((f) => f.type === 'card.update' && f.card_id === id)
          const last = updates[updates.length - 1]
          // an approved card is finished when its result lands; a killed or revised one when its resolution does
          if (
            last &&
            (action === 'primary' ? last.result !== undefined && last.result !== null : last.resolution !== undefined)
          )
            return last
          return undefined
        }
        const update = await until(
          phone.app,
          at,
          timeoutMs,
          (frames) =>
            done(frames) ??
            (frames.some((f) => f.type === 'error' && sent.includes(f.ref as string)) && times === 1
              ? ({} as Raw)
              : undefined),
        )
        if (times > 1) await sleep(500) // let the answer to the second tap land too
        const frames = received(phone.app, at)
        const last = done(frames) ?? frames.filter((f) => f.type === 'card.update' && f.card_id === id).pop()
        return {
          ok: Boolean(update && last && errorsFor(frames).filter((f) => sent.includes(f.ref as string)).length < times),
          card: id,
          decision: action,
          frames_sent: sent,
          payload_hash: hash,
          update: last
            ? {
                state: last.state,
                resolution: last.resolution ?? null,
                result: last.result ?? null,
                reason: last.reason ?? null,
              }
            : null,
          updates_seen: frames.filter((f) => f.type === 'card.update' && f.card_id === id).length,
          errors: frames
            .filter((f) => f.type === 'error')
            .map((f) => ({ code: f.code, message: f.message, ref: f.ref })),
        }
      }),
  },
  history: {
    about: 'read a thread’s history (a signed history.request, answered by the relay’s buffer or the Mac)',
    args: '--thread <id> [--limit <1-100>] [--before_seq <n>]',
    run: (rec, p) =>
      withPhone(rec, async (phone) => {
        const thread = str(p, 'thread', 'general')
        const at = mark(phone.app)
        const sent = (await phone.app.sendHistoryRequest(thread, {
          limit: Math.min(100, Math.max(1, num(p, 'limit', 50))),
          ...(p.before_seq !== undefined ? { before_seq: num(p, 'before_seq', 0) } : {}),
        })) as Raw
        const page = await until(phone.app, at, num(p, 'timeout_s', 20) * 1000, (frames) =>
          frames.find(
            (f) =>
              (f.type === 'history.page' && f.request_id === sent.request_id) ||
              (f.type === 'error' && f.ref === sent.id),
          ),
        )
        if (!page) return { ok: false, thread, error: { code: 'no_answer', message: 'no history page came back' } }
        if (page.type === 'error') return { ok: false, thread, error: { code: page.code, message: page.message } }
        const messages = (page.messages as Raw[]).map((m) => ({
          ...briefMessage(m),
          receipt: m.receipt ?? null,
          attachments: m.attachments ?? [],
        }))
        return {
          ok: true,
          thread,
          count: messages.length,
          has_more: page.has_more,
          unavailable: page.unavailable ?? null,
          messages,
        }
      }),
  },
  catchup: {
    about: 'reconnect the phone and print what arrived since its last visit (what an app that was offline would see)',
    args: '[--from_seq <n>] [--settle_ms <n>]   (--from_seq 1 replays everything the relay still holds; 0 is a brand-new device and gets nothing older)',
    run: (rec, p) =>
      withPhone(
        rec,
        async (phone) => {
          await sleep(num(p, 'settle_ms', 1500))
          const pages = await readWholeBacklog(phone.app)
          const frames = received(phone.app)
          return {
            ok: true,
            pages,
            from_seq: p.from_seq !== undefined ? num(p, 'from_seq', 0) : phone.record.last_seq,
            server_seq: phone.ready.server_seq,
            presence: phone.ready.presence,
            unread: phone.ready.unread ?? {},
            not_delivered: phone.ready.not_delivered ?? [],
            frames: frames
              .filter((f) => f.type !== 'ready' && f.type !== 'ping')
              .map((f) =>
                f.type === 'reply' || f.type === 'message.stored'
                  ? { type: f.type, seq: (f.relay as Raw | undefined)?.seq, message: briefMessage(f.message as Raw) }
                  : {
                      type: f.type,
                      seq: (f.relay as Raw | undefined)?.seq,
                      ...(f.type === 'card.create' ? { card: (f.card as Raw).id } : {}),
                      ...(f.type === 'error' ? { code: f.code, message: f.message } : {}),
                    },
              ),
          }
        },
        p.from_seq !== undefined ? num(p, 'from_seq', 0) : undefined,
      ),
  },
  ready: {
    about:
      'print the whole `ready` frame the relay hands the phone on connect (presence, config, cards, session state)',
    args: '',
    run: (rec) => withPhone(rec, async (phone) => ({ ok: true, ready: phone.ready })),
  },
  raw: {
    about:
      'send any frame as the phone, signed or not (a forged, unknown or oversized frame), and print what comes back',
    args: '--frame <json> [--sign true] [--repeat <n>] [--wait_ms <n>]   (v, id and ts are filled in when missing)',
    run: (rec, p) =>
      withPhone(rec, async (phone) => {
        const given = typeof p.frame === 'string' ? (JSON.parse(p.frame) as Raw) : (p.frame as Raw | undefined)
        if (!given || typeof given.type !== 'string')
          throw new SandboxError('bad_args', '--frame must be a JSON object with a "type"')
        const at = mark(phone.app)
        const ids: string[] = []
        for (let i = 0; i < Math.max(1, num(p, 'repeat', 1)); i++) {
          const base = { v: 1, id: newUlid(), ts: new Date().toISOString(), ...given }
          const frame = flag(p, 'sign', false) ? await phone.app.sign(base) : base
          phone.app.sendRaw(JSON.stringify(frame))
          ids.push(frame.id as string)
        }
        await sleep(num(p, 'wait_ms', 2000))
        return {
          ok: true,
          sent: ids,
          still_connected: phone.app.connected,
          ...(phone.closed ? { socket_closed: phone.closed } : {}),
          received: received(phone.app, at),
        }
      }),
  },
  offline: {
    about: 'take the relay down: every socket drops, the phone’s and the Mac’s (a network loss)',
    args: '',
    run: async (rec) => {
      const was = isAlive(rec.relay.proc)
      const gone = await stopProc(rec.relay.proc, 10_000)
      return { ok: gone, was_running: was, relay_running: !gone }
    },
  },
  online: {
    about: 'bring the relay back on the same port, database and keys',
    args: '',
    run: async (rec) => {
      if (isAlive(rec.relay.proc)) return { ok: true, already_running: true, relay_healthy: await relayHealthy(rec) }
      rec.relay.proc = startRelay(rec)
      saveRecord(rec)
      await waitUntil(() => relayHealthy(rec), 'the relay to answer again', 30_000)
      let bridgeBack = true
      await waitUntil(() => bridgeStatus(rec)?.relay?.connected === true, 'the bridge to reconnect', 60_000, 250).catch(
        () => {
          bridgeBack = false
        },
      )
      return { ok: true, relay_pid: rec.relay.proc.pid, relay_healthy: true, bridge_reconnected: bridgeBack }
    },
  },
  'freeze-bridge': {
    about: 'stop the bridge process in place (SIGSTOP): a Mac that went to sleep with its socket open',
    args: '',
    run: async (rec) => {
      const pid = bridgeProc(rec)
      process.kill(pid, 'SIGSTOP')
      return { ok: true, bridge_pid: pid, frozen: true }
    },
  },
  'thaw-bridge': {
    about: 'let a frozen bridge run again (SIGCONT)',
    args: '',
    run: async (rec) => {
      const pid = bridgeProc(rec)
      process.kill(pid, 'SIGCONT')
      return { ok: true, bridge_pid: pid, frozen: false }
    },
  },
  'kill-bridge': {
    about: 'kill the bridge process only (Main’s MCP server dies under it)',
    args: '[--signal KILL|TERM]',
    run: async (rec, p) => {
      const pid = bridgeProc(rec)
      const s = sig(p, 'KILL')
      process.kill(pid, s)
      await sleep(1500)
      return {
        ok: true,
        bridge_pid: pid,
        signal: s,
        bridge_alive: procOf(pid) !== null,
        supervisor: supervisorStatus(rec),
      }
    },
  },
  'kill-main': {
    about: 'kill Main’s claude and (by default) wait for the supervisor to restart it',
    args: '[--signal KILL|TERM|INT|HUP] [--wait false] [--timeout_s <n>]   (STOP is refused: tmux resumes a stopped pane)',
    run: async (rec, p) => {
      const s = sig(p, 'KILL')
      // Main is a tmux pane's process, and tmux's server sends SIGCONT to a pane's whole process group the moment its
      // process stops (any stop signal: STOP, TSTP, TTIN): a stopped Main is running again within milliseconds. So this
      // refuses, rather than report a stop that did not hold.
      if (s === 'SIGSTOP' || s === 'SIGCONT')
        throw new SandboxError(
          'stop_not_possible',
          'Main runs in a tmux pane, and tmux resumes a stopped pane at once, so SIGSTOP cannot hold it. For a Mac that went to sleep use freeze-bridge / thaw-bridge; for an agent that stops answering, send !hang (fake claude).',
        )
      const pid = mainPane(rec)
      process.kill(pid, s)
      if (!flag(p, 'wait', true)) return { ok: true, pid, signal: s, waited: false }
      const r = await waitRestart(rec, pid, num(p, 'timeout_s', rec.mode === 'real' ? 180 : 60) * 1000)
      return { ok: r.restarted === true, signal: s, ...r }
    },
  },
  'kill-worker': {
    about: 'kill a thread’s own session (its pane on the sandbox’s tmux server)',
    args: '--thread <id> [--signal KILL|TERM]',
    run: async (rec, p) => {
      const thread = str(p, 'thread')
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(thread)) throw new SandboxError('bad_args', 'not a thread id')
      const r = tmux(rec, ['list-panes', '-t', `=t-${thread}`, '-F', '#{pane_pid}'])
      const pid = Number(r.stdout.split('\n')[0]?.trim())
      if (r.status !== 0 || !Number.isInteger(pid) || pid <= 1)
        throw new SandboxError(
          'no_worker',
          `no session t-${thread} on tmux -L ${rec.tmux.socket}. Thread sessions are started by the Mac app's supervisor; the cross-platform supervisor this sandbox runs starts Main only, so a thread set to its own session here falls back to Main.`,
        )
      const s = sig(p, 'KILL')
      signalGroup(pid, s)
      await sleep(1000)
      return { ok: true, thread, pid, signal: s, alive: groupAlive(pid) }
    },
  },
  corrupt: {
    about: 'damage one of the sandbox’s own files on purpose (a copy is kept for `restore`)',
    args: '--file <name> [--how garbage|truncate|empty|delete|bad-json|append]   (names: `corrupt` with no --file lists them)',
    run: async (rec, p) => {
      const known = damageable(rec)
      if (p.file === undefined)
        return {
          ok: true,
          files: Object.fromEntries(Object.entries(known).map(([k, v]) => [k, { path: v, exists: existsSync(v) }])),
        }
      const name = str(p, 'file')
      const path = known[name]
      if (!path)
        throw new SandboxError(
          'bad_args',
          `unknown file ${JSON.stringify(name)}; one of: ${Object.keys(known).join(', ')}`,
        )
      const how = str(p, 'how', 'garbage')
      const existed = existsSync(path)
      if (existed && !existsSync(backupOf(path))) copyFileSync(path, backupOf(path))
      const before = existed ? statSync(path).size : 0
      if (how === 'delete') rmSync(path, { force: true })
      else if (how === 'empty') writeFileSync(path, '')
      else if (how === 'truncate') {
        if (!existed) throw new SandboxError('no_file', `${path} does not exist yet`)
        truncateSync(path, Math.floor(before / 2))
      } else if (how === 'bad-json') writeFileSync(path, '{"threads": [')
      else if (how === 'append')
        writeFileSync(path, `${existed ? readFileSync(path, 'utf8') : ''}\n\u0000\u0000}}garbage`)
      else if (how === 'garbage')
        writeFileSync(path, Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 131 + 7) % 256)))
      else throw new SandboxError('bad_args', '--how must be garbage, truncate, empty, delete, bad-json or append')
      return {
        ok: true,
        file: name,
        path,
        how,
        size_before: before,
        size_after: existsSync(path) ? statSync(path).size : null,
        backup: existed ? backupOf(path) : null,
      }
    },
  },
  restore: {
    about: 'put back a file that `corrupt` damaged',
    args: '--file <name>',
    run: async (rec, p) => {
      const name = str(p, 'file')
      const path = damageable(rec)[name]
      if (!path) throw new SandboxError('bad_args', `unknown file ${JSON.stringify(name)}`)
      if (!existsSync(backupOf(path)))
        throw new SandboxError('no_backup', `${name} has no backup (it was never damaged, or did not exist then)`)
      copyFileSync(backupOf(path), path)
      rmSync(backupOf(path))
      return { ok: true, file: name, path, size: statSync(path).size }
    },
  },
  log: {
    about: 'read the end of a log',
    args: '[--which supervisor|bridge|relay|claude|supervisor-out] [--lines <n>]',
    run: async (rec, p) => {
      const f = files(rec.root)
      const logs: Record<string, string> = {
        supervisor: join(rec.home, 'supervisor.log'),
        bridge: join(rec.home, 'bridge.log'),
        relay: f.relayLog,
        claude: f.fakeClaudeLog,
        'supervisor-out': f.supervisorOut,
      }
      const which = str(p, 'which', 'supervisor')
      const path = logs[which]
      if (!path) throw new SandboxError('bad_args', `--which must be one of ${Object.keys(logs).join(', ')}`)
      return { ok: true, which, ...tailFile(path, Math.max(1, num(p, 'lines', 50))) }
    },
  },
  supervisor: {
    about: 'the supervisor’s status, or ask it to stop / start Main',
    args: '[--do status|stop|start]',
    run: async (rec, p) => {
      const what = str(p, 'do', 'status')
      if (what === 'status')
        return {
          ok: true,
          alive: isAlive(rec.supervisor.proc),
          pid: rec.supervisor.proc?.pid ?? null,
          status: supervisorStatus(rec),
          bridge: bridgeStatus(rec),
          ready: mainReady(rec),
        }
      if (what !== 'stop' && what !== 'start') throw new SandboxError('bad_args', '--do must be status, stop or start')
      // as the owner's `talos-app supervise stop|start` does (terminal-only, so the harness writes the word itself)
      writeFileSync(join(rec.home, 'supervisor-control'), `${what}\n`, { mode: 0o600 })
      await sleep(2500)
      const taken = !existsSync(join(rec.home, 'supervisor-control'))
      return { ok: taken, asked: what, output: taken ? 'taken' : 'not taken yet', status: supervisorStatus(rec) }
    },
  },
  'kill-supervisor': {
    about: 'kill the supervisor itself (Main keeps running, unsupervised, until `supervisor-start`)',
    args: '[--signal KILL|TERM]',
    run: async (rec, p) => {
      const s = sig(p, 'KILL')
      const sent = signal(rec.supervisor.proc, s)
      await sleep(1000)
      return {
        ok: sent,
        signal: s,
        supervisor_alive: isAlive(rec.supervisor.proc),
        main_alive: groupAlive(supervisorStatus(rec)?.panePid ?? 0),
      }
    },
  },
  'supervisor-start': {
    about: 'start a supervisor again after `kill-supervisor` (it adopts a Main that is still running)',
    args: '',
    run: async (rec) => {
      if (isAlive(rec.supervisor.proc)) return { ok: true, already_running: true, pid: rec.supervisor.proc?.pid }
      const { startSupervisor } = await import('./up.ts')
      rec.supervisor.proc = startSupervisor(rec)
      saveRecord(rec)
      await sleep(3000)
      return { ok: isAlive(rec.supervisor.proc), pid: rec.supervisor.proc.pid, status: supervisorStatus(rec) }
    },
  },
  screen: {
    about: 'what is on Main’s terminal right now',
    args: '[--scrollback <rows>]',
    run: async (rec, p) => {
      const rows = screen(rec, Math.max(0, num(p, 'scrollback', 0)))
      return {
        ok: rows !== null,
        rows: rows ?? [],
        ...(rows === null ? { error: { code: 'no_pane', message: 'Main has no pane' } } : {}),
      }
    },
  },
  keys: {
    about: 'type into Main’s terminal: literal text, or named keys (Enter, Up, Down, Escape, C-c)',
    args: '--text <text> | --keys <Key,Key,…>',
    run: async (rec, p) => {
      mainPane(rec)
      const target = ['-t', '=agent:']
      if (p.text !== undefined) tmux(rec, ['send-keys', ...target, '-l', '--', str(p, 'text')])
      if (p.keys !== undefined)
        for (const k of str(p, 'keys').split(',')) {
          if (!/^(Enter|Up|Down|Left|Right|Escape|Tab|BSpace|Space|C-[a-z]|[0-9])$/.test(k.trim()))
            throw new SandboxError('bad_args', `not a key this action sends: ${k}`)
          tmux(rec, ['send-keys', ...target, k.trim()])
        }
      await sleep(400)
      return { ok: true, rows: screen(rec) ?? [] }
    },
  },
}

function openCards(phone: Phone): Raw[] {
  const cards = new Map<string, Raw>()
  for (const c of (phone.ready.open_cards as Raw[] | undefined) ?? []) cards.set(c.id as string, c)
  for (const f of received(phone.app)) {
    if (f.type === 'card.create') cards.set((f.card as Raw).id as string, f.card as Raw)
    if (f.type === 'card.update' && f.state !== 'pending') cards.delete(f.card_id as string)
  }
  return [...cards.values()]
}

export async function drive(id: string, action: string, params: Params): Promise<Result> {
  const a = ACTIONS[action]
  if (!a)
    throw new SandboxError(
      'bad_args',
      `unknown action ${JSON.stringify(action)}; one of: ${Object.keys(ACTIONS).join(', ')}`,
    )
  const rec = loadRecord(id)
  // `up --auto-dev-channels`: a Main the supervisor restarted since the last command may be waiting on the warning
  const answered = rec.auto_dev_channels ? answerStartDialog(rec) : null
  return {
    id,
    action,
    ...(answered === 'dev_channels' ? { answered_dev_channels: true } : {}),
    ...(await a.run(rec, params)),
  }
}

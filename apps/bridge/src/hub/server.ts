// The hub socket on main's live bridge (docs/OPTION-C.md "The hub socket"). Worker-mode bridges connect here; this is
// the only place their frames reach the relay over the socket, so
// ordering, acks and the outbox stay in one process. The socket is 0600 in the 0700 data folder; each
// `hello` must also name a pid in the recorded worker pane's process group and the nonce the supervisor wrote.
import { execFileSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  type Frame,
  HUB_MAX_LINE_BYTES,
  HUB_RPC_MAX_TEXT,
  type HubAskRuleT,
  type HubPermT,
  type HubRuleNoticeT,
  type HubRuleTakeT,
  HubWorkerLine,
  MAX_FRAME_BYTES,
  parseFrame,
  supervisorFresh,
  threadSessionMode,
} from '@talos-app/protocol'
import { inspectRuleFile, ruleFileNotice, ruleKillSwitchPath } from '../action-rule-asks.ts'
import { settingsReadText } from '../config-propose/settings-read.ts'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import { workerScheduleTool } from '../schedules/worker-scope.ts'
import { setInstructionsAs } from '../tools/thread-setup.ts'
import { runCreateThread } from '../tools/threads.ts'
import { frameBytes } from '../transport.ts'
import { readNonce, WorkersReader, writeReady } from '../worker/files.ts'
import {
  type CheckedFolder,
  type ProjectCheck,
  plainPath,
  readProjectCheck,
  sessionSettingsFolders,
  sessionSettingsProblem,
} from '../worker/project-settings.ts'
import type { WorkerStore } from '../worker/store.ts'
import { type FenceDeps, workerFrameProblem } from './worker-fence.ts'

/** Frames a worker may hand the hub. */
export const HUB_OUT_TYPES = new Set(['reply', 'card.create', 'card.update', 'status', 'receipt'])
const DURABLE = new Set(['reply', 'card.create', 'card.update'])
const HELLO_WAIT_MS = 5_000

/** The process group of a pid, or undefined when it is gone. */
export function pgidOf(pid: number): number | undefined {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const n = Number(out.trim())
    return Number.isInteger(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

export { workerReplyProblem } from './worker-fence.ts'

export type HubServerOptions = {
  store: WorkerStore
  workers?: WorkersReader
  /** Test seam: process-group lookup. */
  pgidOf?: (pid: number) => number | undefined
}

type Conn = {
  sock: Socket
  buf: string
  thread?: string
  features?: readonly string[]
  /** A PermissionRequest hook's connection: one `perm` request, no hello, closed after the answer. */
  perm?: AbortController
}

/** Constant-time compare (the nonce is the real gate on `hello`; the pid is self-reported). */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class HubServer {
  private server: Server | undefined
  private conns = new Set<Conn>()
  private readonly workers: WorkersReader
  private readonly pgid: (pid: number) => number | undefined

  constructor(
    private readonly ctx: BridgeContext,
    private readonly o: HubServerOptions,
  ) {
    this.workers = o.workers ?? new WorkersReader(ctx.paths.home)
    this.pgid = o.pgidOf ?? pgidOf
  }

  get path(): string {
    return this.ctx.paths.hubSock
  }

  /** What the connected worker for this thread said it can do (an older worker says nothing: `[]`), or undefined with no connection. */
  featuresOf(thread: string): readonly string[] | undefined {
    for (const c of this.conns) if (c.thread === thread) return c.features ?? []
    return undefined
  }

  /** Open connections, welcomed or not. */
  get connections(): number {
    return this.conns.size
  }

  /** Threads with a welcomed worker connection. */
  connectedThreads(): string[] {
    return [...this.conns].flatMap((c) => (c.thread ? [c.thread] : []))
  }

  async start(): Promise<void> {
    if (this.server) return
    const p = this.path
    // its own folder, 0700 and a real folder (not a link to somewhere else), so the socket never sits in the watched home
    const dir = this.ctx.paths.hubDir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
    chmodSync(dir, 0o700)
    // the live bridge took over bridge.pid before this runs, so a socket file left here, or where it used to be, is a dead
    // bridge's (the old one in home would also keep home unwatchable on Linux)
    for (const old of [p, this.ctx.paths.hubSockLegacy])
      if (existsSync(old) && lstatSync(old).isSocket()) unlinkSync(old)
    const server = createServer((sock) => this.onConn(sock))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(p, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(p, 0o600)
    server.on('error', (e) => this.ctx.log.warn('hub socket error', { error: e.message }))
    this.server = server
    this.ctx.log.info('hub socket up')
  }

  async close(): Promise<void> {
    const s = this.server
    this.server = undefined
    for (const c of this.conns) c.sock.destroy()
    this.conns.clear()
    if (s) await new Promise<void>((r) => s.close(() => r()))
    try {
      if (existsSync(this.path) && lstatSync(this.path).isSocket()) unlinkSync(this.path)
    } catch {
      // gone already
    }
  }

  private onConn(sock: Socket) {
    const c: Conn = { sock, buf: '' }
    this.conns.add(c)
    sock.setEncoding('utf8')
    const t = setTimeout(() => {
      if (!c.thread && !c.perm) sock.destroy()
    }, HELLO_WAIT_MS)
    sock.on('data', (chunk: string) => {
      c.buf += chunk
      if (c.buf.length > HUB_MAX_LINE_BYTES) {
        this.ctx.log.security('hub: oversized line, connection dropped', { thread: c.thread })
        sock.destroy()
        return
      }
      let nl = c.buf.indexOf('\n')
      while (nl >= 0) {
        const line = c.buf.slice(0, nl)
        c.buf = c.buf.slice(nl + 1)
        void this.onLine(c, line).catch((e) => {
          // A line that was already running when stop began wakes after the store closed and throws (a closed database); that is
          // the stop, not a fault, and an `error` here would be filed as a problem report.
          if (this.ctx.closing) this.ctx.log.warn('hub line ended by stop', { error: (e as Error).message })
          else this.ctx.log.error('hub line failed', { error: (e as Error).message })
        })
        nl = c.buf.indexOf('\n')
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      clearTimeout(t)
      this.conns.delete(c)
      c.perm?.abort() // the hook died or was stopped (the owner answered at the Mac): its card closes
    })
  }

  private write(c: Conn, msg: Record<string, unknown>) {
    if (!c.sock.destroyed) c.sock.write(`${JSON.stringify(msg)}\n`)
  }

  private refuse(c: Conn, code: string, message: string) {
    this.ctx.log.security('hub: hello refused', { code })
    this.write(c, { t: 'refused', code, message })
    c.sock.end()
  }

  private async onLine(c: Conn, line: string) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return c.thread ? undefined : this.refuse(c, 'bad_frame', 'not JSON')
    }
    const m = HubWorkerLine.safeParse(raw)
    if (!m.success) return c.thread ? undefined : this.refuse(c, 'bad_frame', 'not a hub line')
    const msg = m.data
    if (msg.t === 'perm') return this.onPerm(c, msg)
    if (msg.t === 'ask_rule' || msg.t === 'rule_take') return this.onRule(c, msg)
    if (msg.t === 'rule_notice') return this.onRuleNotice(c, msg)
    if (msg.t === 'hello') {
      if (c.thread) return // one hello per connection
      const why = this.checkHello(msg)
      if (why) return this.refuse(c, why.code, why.message)
      c.thread = msg.thread_id
      c.features = msg.features ?? []
      try {
        writeReady(this.ctx.paths.home, {
          v: 1,
          thread_id: msg.thread_id,
          pid: msg.pid,
          ...(msg.session_id ? { session_id: msg.session_id } : {}),
          at: new Date(this.ctx.clock.now()).toISOString(),
        })
      } catch (e) {
        this.ctx.log.warn('hub: ready file not written', { error: (e as Error).message })
      }
      this.ctx.log.info('hub: thread session connected', { thread: msg.thread_id })
      return this.write(c, { t: 'welcome', thread_id: msg.thread_id })
    }
    if (!c.thread) return this.refuse(c, 'unauthorized', 'say hello first')
    // P1 (WP-OC5): the worker's mod state; forwarded per scope once OC5 lands, ignored until then
    if (msg.t === 'mod') return
    if (msg.t === 'rpc') return this.onRpc(c, c.thread, msg)
    const frameId = typeof msg.frame.id === 'string' ? msg.frame.id.slice(0, 64) : ''
    const r = await this.onOut(c.thread, msg.frame)
    if (DURABLE.has(String(msg.frame.type)) || !r.ok)
      this.write(c, {
        t: 'ack',
        frame_id: frameId,
        state: r.ok ? r.state : 'refused',
        ...(r.ok ? {} : { code: r.code, message: r.message.slice(0, 300) }),
      })
  }

  /**
   * A thread session asks for one of the Schedules tools (docs/OPTION-C.md "Thread schedules"). The thread is the one this
   * connection proved at `hello`; nothing in the request can name another. Always answered, so the worker never waits on silence.
   */
  private async onRpc(c: Conn, thread: string, msg: { id: string; tool: string; args: Record<string, unknown> }) {
    const { ctx } = this
    const answer = (ok: boolean, text: string) =>
      this.write(c, { t: 'rpc_result', id: msg.id, ok, text: text.slice(0, HUB_RPC_MAX_TEXT) })
    // Screen consent: the session hands over only the Mac's opaque id for an app it measured; the main bridge asks the Mac
    // what that app is, so nothing the session sends can name the app on the owner's card.
    if (msg.tool === 'screen_ask') {
      const ask = typeof msg.args.ask === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(msg.args.ask) ? msg.args.ask : null
      const hint = typeof msg.args.app === 'string' ? msg.args.app.slice(0, 80) : 'That app'
      if (!ask) return answer(false, 'screen_ask needs the id the Mac gave. Nothing was asked.')
      if (!ctx.screenConsent)
        return answer(
          false,
          `${hint} isn't on this Mac's allowed list yet, and the main bridge can't ask the owner right now. Nothing was done.`,
        )
      try {
        const r = await ctx.screenConsent.ask(ask, hint)
        return answer(r.ok, r.text)
      } catch (e) {
        ctx.log.warn('hub: screen_ask failed', { error: (e as Error).message })
        return answer(false, `The main bridge could not ask the owner: ${(e as Error).message}`.slice(0, 300))
      }
    }
    // The settings cards: the thread is the one this connection proved, never one the request names. The proposal is judged as the
    // thread's own (its fields only, the card in its thread), by the same service that judges main's.
    if (msg.tool === 'settings_read') {
      if (threadSessionMode(ctx.config.config, thread) !== 'dedicated')
        return answer(
          false,
          `Thread "${thread}" no longer has its own session; the main session handles it now. Stop here.`,
        )
      return answer(true, settingsReadText(ctx, thread))
    }
    if (msg.tool === 'config_propose') {
      if (threadSessionMode(ctx.config.config, thread) !== 'dedicated')
        return answer(
          false,
          `Thread "${thread}" no longer has its own session; the main session handles it now. Stop here.`,
        )
      if (!ctx.configProposals)
        return answer(false, 'Settings proposals are not available on the main bridge right now.')
      if (msg.args.thread_id !== thread)
        return answer(
          false,
          `This session belongs to thread "${thread}" and can only propose into it. Nothing was proposed.`,
        )
      try {
        const r = await ctx.configProposals.propose(msg.args, { scope: thread })
        return answer(r.ok, r.text)
      } catch (e) {
        ctx.log.warn('hub: config_propose failed', { error: (e as Error).message })
        return answer(false, `The main bridge could not run config_propose: ${(e as Error).message}`.slice(0, 300))
      }
    }
    // Setting up its sub-threads: the same tools Main has, run as the thread this connection proved (never one the request names).
    if (msg.tool === 'create_thread' || msg.tool === 'set_thread_instructions') {
      if (threadSessionMode(ctx.config.config, thread) !== 'dedicated')
        return answer(
          false,
          `Thread "${thread}" no longer has its own session; the main session handles it now. Stop here.`,
        )
      try {
        const r =
          msg.tool === 'create_thread'
            ? await runCreateThread(ctx, msg.args, thread)
            : await setInstructionsAs(ctx, msg.args, thread)
        return answer(!r.isError, r.content.map((c) => ('text' in c ? c.text : '')).join('\n'))
      } catch (e) {
        ctx.log.warn('hub: thread setup failed', { tool: msg.tool, error: (e as Error).message })
        return answer(false, `The main bridge could not run ${msg.tool}: ${(e as Error).message}`.slice(0, 300))
      }
    }
    // Switched back to shared since its hello: main owns its jobs again. Finishing a run the session already claimed still lands (like
    // a card.update): the run would otherwise sit open until it timed out, and the owner would be told the agent never reported.
    if (msg.tool !== 'schedule_run_done' && threadSessionMode(ctx.config.config, thread) !== 'dedicated')
      return answer(
        false,
        `Thread "${thread}" no longer has its own session; the main session handles its schedules now. Stop here.`,
      )
    if (!ctx.schedules) return answer(false, 'Schedules are not available on the main bridge right now.')
    try {
      const r = await workerScheduleTool(
        {
          schedules: ctx.schedules,
          store: this.o.store,
          thread,
          now: () => ctx.clock.now(),
          kv: { get: (k) => ctx.store.kvGet(k), set: (k, v) => ctx.store.kvSet(k, v) },
        },
        msg.tool,
        msg.args,
      )
      answer(r.ok, r.text)
    } catch (e) {
      ctx.log.warn('hub: schedule tool failed', { tool: msg.tool.slice(0, 40), error: (e as Error).message })
      answer(false, `The main bridge could not run ${msg.tool.slice(0, 40)}: ${(e as Error).message}`.slice(0, 300))
    }
  }

  /**
   * A PermissionRequest hook asks for a card (docs/CLAUDE-CODE.md C3.9). With `thread_id` it must prove it is that thread's
   * session exactly as `hello` does (nonce, and a pid inside the recorded pane's process group); the card then goes to that
   * thread and nowhere else. Without one it is the main session's, and the card goes to the default thread. Every refusal is
   * answered `none`, which leaves the prompt at the Mac. One request per connection; the connection closing closes the card.
   */
  private async onPerm(c: Conn, msg: HubPermT) {
    const answer = (decision: 'allow' | 'deny' | 'none', reason: string) => {
      this.write(c, { t: 'perm_result', id: msg.id, decision, reason: reason.slice(0, 120) })
      c.sock.end()
    }
    if (c.perm || c.thread) return // one request per connection, and a worker's own connection never carries one
    const ac = new AbortController()
    c.perm = ac
    if (this.ctx.mode !== 'live') return answer('none', 'not_live')
    const refused = this.proveAsker(msg, 'permission request')
    if (refused) return answer('none', refused)
    const r = await this.ctx.permission.onHookRequest(
      {
        ...(msg.thread_id !== undefined ? { thread: msg.thread_id } : {}),
        tool_name: msg.tool_name,
        tool_input: msg.tool_input,
        ...(msg.pid !== undefined ? { pid: msg.pid } : {}),
        ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
      },
      ac.signal,
    )
    if (!ac.signal.aborted) answer(r.decision, r.reason)
  }

  /**
   * WHO is asking, for a hook's one-shot request (`perm`, `ask_rule`, `rule_take`): with `thread_id` it must prove it is that
   * thread's session exactly as `hello` does, and that session's project settings are checked again; without one it is the main
   * session's, which shows no nonce. Returns the refusal code, or null.
   */
  private proveAsker(msg: { thread_id?: string; pid?: number; nonce?: string }, what: string): string | null {
    if (msg.thread_id !== undefined) {
      const why =
        msg.pid === undefined || msg.nonce === undefined
          ? { code: 'not_owner', message: 'a thread session names its pid and nonce' }
          : this.checkWorkerProof({ thread_id: msg.thread_id, pid: msg.pid, nonce: msg.nonce }, true)
      if (why) {
        this.ctx.log.security(`hub: ${what} refused`, { code: why.code, thread: msg.thread_id })
        return why.code
      }
      // the project settings the session loads, again at every request, from the folders its start recorded: a file changed
      // mid-session gets no card (the prompt stays at the session's terminal, the safe side) and the owner a line. This stops only
      // an honest hook (a hijacked one never asks): the start's check and the hook's clean environment are the controls. On
      // Linux every start writes the record, so a session without one (started before it existed) is refused the same way; the
      // Mac's supervisor does not write it yet, so there it is not judged.
      const check = readProjectCheck(this.ctx.paths.home, msg.thread_id)
      const settingsWhy = check
        ? recheckSettings(check)
        : process.platform === 'linux'
          ? 'this session was started before its folder check existed (restart the thread to check its folder)'
          : null
      if (settingsWhy) {
        this.ctx.log.security(`hub: ${what} refused`, { code: 'project_settings', thread: msg.thread_id })
        this.tellProjectSettings(msg.thread_id, settingsWhy)
        return 'project_settings'
      }
    } else if (msg.nonce !== undefined) {
      // a main-session hook has no nonce to show; one that sends one is not the shape of anything we ship
      return 'bad_frame'
    }
    return null
  }

  /**
   * The kit's ask rules (kit/hooks/action-rules.py; action-rule-asks.ts). `ask_rule` waits for the owner's tap on the "Allow once"
   * card (the card stays open if this connection closes); `rule_take` takes the one-use approval for exactly this call. Proof as
   * for `perm`: the approval is bound to the session that asked. Every refusal is `none`, which leaves the action asking.
   */
  private async onRule(c: Conn, msg: HubAskRuleT | HubRuleTakeT) {
    const answer = (decision: 'allow' | 'deny' | 'none', reason: string) => {
      this.write(c, { t: 'rule_result', id: msg.id, decision, reason: reason.slice(0, 120) })
      c.sock.end()
    }
    if (c.perm || c.thread) return // one request per connection, and a worker's own connection never carries one
    const ac = new AbortController()
    c.perm = ac
    const asks = this.ctx.actionRuleAsks
    if (this.ctx.mode !== 'live' || !asks) return answer('none', 'not_live')
    const refused = this.proveAsker(msg, 'action rule request')
    if (refused) return answer('none', refused)
    const call = {
      ...(msg.thread_id !== undefined ? { thread: msg.thread_id } : {}),
      rule: msg.rule,
      tool_name: msg.tool_name,
      tool_input: msg.tool_input,
      ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
    }
    if (msg.t === 'rule_take') {
      const r = await asks.take(call)
      return answer(r.decision, r.reason)
    }
    const r = await asks.ask(
      {
        ...call,
        ...(msg.why !== undefined ? { why: msg.why } : {}),
      },
      ac.signal,
      msg.wait_ms ?? 110_000,
    )
    if (!ac.signal.aborted) answer(r.decision, r.reason)
  }

  /** The (file, content) pairs the owner was told about: one notice each until the file changes (a restart forgets; the hook asks again then). */
  private readonly ruleFilesTold = new Set<string>()
  /** When notices were posted: at most 3 an hour, however many files change. */
  private ruleNoticeAt: number[] = []

  /**
   * The kit's action-rules hook says it could not read a rule file and is asking (denying, unattended) about every call. That is
   * only a request to LOOK: this reads the named rule file itself (the agent's starter file or the owner's own, never a path from
   * the hook), hashes it itself, and posts only if `action-rules.py test` finds it broken. Then ONE line to the owner's thread per
   * file and content, at most 3 an hour, in words written here from what this found (the line is its own too), never the hook's own
   * text. Proof of who asks is as for `perm`; every answer is `none` (nothing here approves anything). `told` only once the line
   * is posted; `failed` when it could not be (the hook asks again later).
   */
  private async onRuleNotice(c: Conn, msg: HubRuleNoticeT) {
    const answer = (reason: string) => {
      this.write(c, { t: 'rule_result', id: msg.id, decision: 'none', reason: reason.slice(0, 120) })
      c.sock.end()
    }
    if (c.perm || c.thread) return
    if (this.ctx.mode !== 'live') return answer('not_live')
    const refused = this.proveAsker(msg, 'action rule notice')
    if (refused) return answer(refused)
    const seen = await inspectRuleFile(msg.file)
    if (seen.state === 'unknown') return answer('unknown')
    if (seen.state === 'fine') return answer('fine')
    const now = this.ctx.clock.now()
    const key = `${msg.file}:${seen.hash}`
    if (this.ruleFilesTold.has(key)) return answer('dup')
    this.ruleNoticeAt = this.ruleNoticeAt.filter((t) => now - t < 3_600_000)
    if (this.ruleNoticeAt.length >= 3) return answer('capped')
    if (this.ruleFilesTold.size >= 200) this.ruleFilesTold.clear()
    this.ruleFilesTold.add(key) // taken before the post, so a second notice at the same moment is a dup
    this.ruleNoticeAt.push(now)
    const offPath = ruleKillSwitchPath() // the kit's switch for THIS agent folder, worked out here, not taken from the hook
    const text = ruleFileNotice({
      file: msg.file,
      ...(seen.line !== undefined ? { line: seen.line } : {}),
      ...(msg.unattended !== undefined ? { unattended: msg.unattended } : {}),
      ...(offPath ? { offPath } : {}),
    })
    try {
      await postSystemNotice(this.ctx, text)
    } catch (e) {
      this.ruleFilesTold.delete(key) // not posted: the hook is told so, and tries again
      this.ruleNoticeAt.pop()
      this.ctx.log.warn('hub: rule file notice not posted', { error: (e as Error).message })
      return answer('failed')
    }
    answer('told')
  }

  /** Per thread: the reason last told, and when lines were posted (one line per reason, at most 3 an hour). */
  private readonly settingsTold = new Map<string, { why: string; at: number[] }>()

  private tellProjectSettings(thread: string, why: string) {
    const now = this.ctx.clock.now()
    const told = this.settingsTold.get(thread) ?? { why: '', at: [] }
    told.at = told.at.filter((t) => now - t < 3_600_000)
    if (told.why === why || told.at.length >= 3) return
    told.why = why
    told.at.push(now)
    this.settingsTold.set(thread, told)
    const text = `This thread's session asked for a permission, and it was not sent to your phone: ${plainPath(why)}. Then restart the thread's session.`
    void postSystemNotice(this.ctx, text, { thread: threadRef(this.ctx, thread) }).catch((e) =>
      this.ctx.log.warn('hub: project settings notice not posted', { error: (e as Error).message }),
    )
  }

  /** null when the hello is good, else why not. */
  checkHello(h: { thread_id: string; pid: number; nonce: string }): { code: string; message: string } | null {
    return this.checkWorkerProof(h, false)
  }

  /**
   * The proof a thread session gives: live bridge, a dedicated thread, a fresh supervisor, a recorded pane, the supervisor's
   * nonce, and a pid in that pane's process group. A `hello` also refuses a second connection for the thread; a hook's request
   * is made while the worker's own connection is up, so it does not.
   */
  private checkWorkerProof(
    h: { thread_id: string; pid: number; nonce: string },
    allowConnected: boolean,
  ): { code: string; message: string } | null {
    const { ctx } = this
    if (ctx.mode !== 'live') return { code: 'worker_unavailable', message: 'this bridge is not live' }
    if (threadSessionMode(ctx.config.config, h.thread_id) !== 'dedicated')
      return { code: 'not_owner', message: `thread ${h.thread_id} does not have its own session` }
    const file = this.workers.read()
    if (!supervisorFresh(file, ctx.clock.now()))
      return { code: 'worker_unavailable', message: 'the desktop supervisor is not running' }
    const entry = file?.threads[h.thread_id]
    if (!entry || entry.pane_pid <= 0)
      return { code: 'not_owner', message: `no worker is recorded for thread ${h.thread_id}` }
    const nonce = readNonce(ctx.paths.home, h.thread_id)
    if (!nonce || !sameText(nonce, h.nonce)) return { code: 'not_owner', message: 'wrong nonce' }
    const g = this.pgid(h.pid)
    if (g === undefined || g !== entry.pane_pid)
      return { code: 'not_owner', message: `pid ${h.pid} is not in thread ${h.thread_id}'s pane group` }
    // one worker per thread: a second start connects only after the first one's socket closed
    if (!allowConnected && this.connectedThreads().includes(h.thread_id))
      return { code: 'worker_unavailable', message: `thread ${h.thread_id} already has a connected session` }
    return null
  }

  /** Validates a worker's frame (schema, size, thread) and sends it as the live bridge's own. */
  async onOut(
    thread: string,
    raw: Record<string, unknown>,
  ): Promise<{ ok: true; state: 'sent' | 'queued' } | { ok: false; code: string; message: string }> {
    const { ctx } = this
    if (!HUB_OUT_TYPES.has(String(raw.type))) return { ok: false, code: 'bad_frame', message: 'frame type not allowed' }
    if (frameBytes(raw) > MAX_FRAME_BYTES) return { ok: false, code: 'too_large', message: 'frame too large' }
    const p = parseFrame(raw, { direction: 'bridge_to_relay' })
    if (!p.ok) return { ok: false, code: 'bad_frame', message: p.message }
    const f = p.frame
    const why = workerFrameProblem(f, thread, this.fenceDeps())
    if (why) return { ok: false, ...why }
    if (f.type === 'card.create') ctx.expiry?.sync()
    // A worker's final word on a card: the hub outlives the worker, so it settles the claim here, before the send waits for the
    // relay. A worker that dies between this and recording the result must not have its finished card failed by the sweep.
    if (f.type === 'card.update' && (f.state === 'done' || f.state === 'failed'))
      this.o.store.settleClaims([f.card_id], ctx.clock.now())
    if (!DURABLE.has(f.type)) {
      ctx.transport.sendEphemeral(f)
      return { ok: true, state: 'sent' }
    }
    try {
      const r = await ctx.transport.sendDurable(f)
      return { ok: true, state: r.state === 'acked' ? 'sent' : 'queued' }
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'internal'
      return { ok: false, code: String(code).slice(0, 40), message: (e as Error).message }
    }
  }

  private fenceDeps(): FenceDeps {
    const { ctx } = this
    return {
      config: ctx.config.config,
      cardRaiser: (id) => this.o.store.cardRaiser(id),
      ledgerThread: (id) => ctx.ledger.get(id)?.thread_id,
      messageThread: (id) =>
        (ctx.store.db.query('SELECT thread_id FROM messages WHERE id = ?').get(id) as { thread_id: string } | null)
          ?.thread_id,
    }
  }
}

/**
 * The folders a start recorded, checked again, and the session's folder's repo roots found again: a `.git` pointer written
 * after the start (a root the start never saw) is refused too, never only the folders the start knew.
 */
export function recheckSettings(check: ProjectCheck): string | null {
  const own = check.folders[0] as CheckedFolder
  // a session that loads only the user's settings (--setting-sources=user) loads none of its folders' files: what they say was
  // told at its start, and nothing here walks a tree at a request. Any other (the agent folder's, or one started before the
  // sources were recorded) is held to them.
  if (check.sources === 'user') return null
  // the agent folder's session loads them as Main does: its settings files again (a few small files), and its repo roots found
  // again; the skills, commands and subagents under it are the hook's to read again (with its own cache)
  const now = sessionSettingsFolders(own.folder, own.agent_folder ? own.folder : '/nonexistent-agent-folder')
  if ('problem' in now) return now.problem
  // compared as the strings the start recorded: a start records real paths (workers-wiring.ts), so a folder that resolves
  // anywhere else now (a link swapped in since) reads as new, never as the same one
  const known = new Set(check.folders.map((f) => f.folder))
  const added = now.folders.filter((f) => !known.has(f.folder))
  if (added.length > 0)
    return `the session's folder now loads settings from ${added[0]?.folder} as well, which its start did not check (a .git written since): remove it or move this thread's folder`
  return sessionSettingsProblem(check.folders)
}

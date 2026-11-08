// The hub socket on main's live bridge (docs/OPTION-C.md "The hub socket"). Worker-mode bridges connect here; this is
// the only place their frames reach the relay over the socket, so
// ordering, acks and the outbox stay in one process. The socket is 0600 in the 0700 data folder; each
// `hello` must also name a pid in the recorded worker pane's process group and the nonce the supervisor wrote.
import { execFileSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  type Frame,
  HUB_MAX_LINE_BYTES,
  HUB_RPC_MAX_TEXT,
  type HubPermT,
  HubWorkerLine,
  MAX_FRAME_BYTES,
  parseFrame,
  supervisorFresh,
  threadSessionMode,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { workerScheduleTool } from '../schedules/worker-scope.ts'
import { frameBytes } from '../transport.ts'
import { readNonce, WorkersReader, writeReady } from '../worker/files.ts'
import type { WorkerStore } from '../worker/store.ts'

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
    // the live bridge took over bridge.pid before this runs, so a socket file left here is a dead bridge's
    if (existsSync(p) && lstatSync(p).isSocket()) unlinkSync(p)
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
        void this.onLine(c, line).catch((e) => this.ctx.log.error('hub line failed', { error: (e as Error).message }))
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
    if (msg.thread_id !== undefined) {
      const why =
        msg.pid === undefined || msg.nonce === undefined
          ? { code: 'not_owner', message: 'a thread session names its pid and nonce' }
          : this.checkWorkerProof({ thread_id: msg.thread_id, pid: msg.pid, nonce: msg.nonce }, true)
      if (why) {
        this.ctx.log.security('hub: permission request refused', { code: why.code, thread: msg.thread_id })
        return answer('none', why.code)
      }
    } else if (msg.nonce !== undefined) {
      // a main-session hook has no nonce to show; one that sends one is not the shape of anything we ship
      return answer('none', 'bad_frame')
    }
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
    const own = this.frameThread(f)
    if (own !== thread)
      return { ok: false, code: 'not_owner', message: `this session can only post to thread ${thread}` }
    // switched off since its hello: main answers this thread now. A card.update still lands: it reports work the owner
    // already approved, on a card this worker raised (frameThread), and nothing else can close that card honestly.
    if (f.type !== 'card.update' && threadSessionMode(ctx.config.config, thread) !== 'dedicated')
      return { ok: false, code: 'worker_unavailable', message: `thread ${thread} no longer has its own session` }
    if (f.type === 'reply' && f.message.author !== 'agent')
      return { ok: false, code: 'bad_frame', message: 'only agent messages' }
    if (f.type === 'card.create') {
      if (f.card.kind === 'permission') return { ok: false, code: 'bad_frame', message: 'no permission cards' }
      // only a card this worker's `card` tool minted: the ledger row must be in its thread and already raised by it, so
      // re-announcing someone else's card id can never move that card or its answer
      if (ctx.ledger.get(f.card.id)?.thread_id !== thread || this.o.store.cardRaiser(f.card.id) !== thread)
        return { ok: false, code: 'not_owner', message: `card ${f.card.id} was not raised by this session` }
      ctx.expiry?.sync()
    }
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

  private frameThread(f: Frame): string | undefined {
    switch (f.type) {
      case 'reply':
        return f.message.thread_id
      case 'card.create':
        return f.card.thread_id
      case 'card.update':
        return this.o.store.cardRaiser(f.card_id) // only the worker that raised it, whatever thread the card is in
      case 'status':
        return f.thread_id
      case 'receipt': {
        const r = this.ctx.store.db.query('SELECT thread_id FROM messages WHERE id = ?').get(f.message_id) as {
          thread_id: string
        } | null
        return r?.thread_id
      }
      default:
        return undefined
    }
  }
}

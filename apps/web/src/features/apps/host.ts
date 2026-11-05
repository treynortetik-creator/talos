// MCP Apps host (M2.2, M2.3): the protocol between the PWA and ONE sandboxed view. Plain TypeScript with every effect
// injected through `HostEnv`, so it runs the same against a real iframe and against a test double.
//
// The view is third-party code. Everything it sends goes through `parseViewMessage` (never throws), is rate limited per
// view, and can reach the Mac only as a signed `app.request` that the bridge authorises on its own. The host answers a
// view with Talos-built strings; a tool's own text only ever travels inside a result.
import {
  type AppCspT,
  type AppErrorCodeT,
  type AppViewT,
  type McpCallToolResultT,
  newUlid,
  parseViewMessage,
  RPC_ERR,
  toSpecCsp,
  UI_PROTOCOL_VERSION,
  uiMessageText,
  type ViewMessageResult,
} from '@talos-app/protocol'
import {
  CLIENT_CEILING_MS,
  LOG_ENTRIES,
  LOG_ENTRY_CHARS,
  MIN_HEIGHT,
  PER_MINUTE,
  PROGRESS_INTERVAL_MS,
  RateWindow,
  TEARDOWN_WAIT_MS,
} from './limits.ts'

export type DisplayMode = 'inline' | 'fullscreen'
/** What the owner did on a Talos chip: allow it, say no once, or say no and stop being asked until the view reopens. */
export type ChipAnswer = 'allow' | 'no' | 'mute'
export type HostPhase = 'loading' | 'ready' | 'closed'
/** What the chrome says while requests are open. */
export type HostStatus = 'idle' | 'agent' | 'approval'
/** navigated: the view left its frame. teardown: the view asked to close. retired: Talos closed it (update, slot lost). */
export type ClosedReason = 'navigated' | 'teardown' | 'retired' | 'disposed'
export type LogEntry = { n: number; level: string; logger: string; text: string }

type Json = Record<string, unknown>
type MessageParams = Parameters<typeof uiMessageText>[0]
type Target = { postMessage(message: unknown, targetOrigin: string): void }

export type HostEnv = {
  view: AppViewT
  /** The frame's window, or null once it is gone. Messages are accepted from this window only. */
  getWindow(): Target | null
  /** Signs and sends an `app.request` (client.sendAppRequest). Rejects with an Error that may carry `.code`. */
  sendRequest(frame: Json): Promise<void>
  /** Spends the owner's gesture inside THIS view, if there is one (gesture.ts): true at most once per gesture. */
  claimGesture(): boolean
  /** The Send / Dismiss / Stop asking chip showing the message text, drawn by Talos outside the frame. 'allow' only on [Send]. */
  confirmMessage(text: string): Promise<ChipAnswer>
  /** The "wants to go full screen" chip (Allow / No / Stop asking), drawn by Talos outside the frame. */
  confirmFullscreen(): Promise<ChipAnswer>
  /** The "Open a link from {label}?" sheet. Resolves true only on [Open]. */
  confirmOpenLink(url: string): Promise<boolean>
  openExternal(url: string): void
  getDisplayMode(): DisplayMode
  /** Moves the SAME container between inline and fullscreen; resolves after layout. */
  setDisplayMode(mode: DisplayMode): Promise<void>
  dimensions(mode: DisplayMode): Json
  safeAreaInsets(): Json
  /** The `ui/initialize` result (M2.4), built fresh at the call. */
  initializeResult(declaredModes: string[]): Json
  setHeight(px: number): void
  maxHeight(): number
  /** `tool_result_media` -> the parsed result. Rejects when it cannot be fetched or does not parse. */
  fetchResult(media: { media_id: string }): Promise<McpCallToolResultT>
  /** Monotonic milliseconds (rate windows). */
  now(): number
  /** Wall clock milliseconds (`calls_until`). */
  wallNow(): number
  raf(cb: () => void): void
  /** Called after any visible change (phase, status, log). */
  onChange(): void
}

type Pending = {
  rpcId: string | number
  method: 'tools/call' | 'ui/message'
  progressToken?: string | number
  progress: number
  card: boolean
  timer: ReturnType<typeof setTimeout>
  beat?: ReturnType<typeof setInterval>
}

const TALOS_ERRORS: ReadonlySet<string> = new Set([
  'mac_offline',
  'rate_limited',
  'sig_invalid',
  'view_closed',
  'timeout',
  'tool_failed',
  'needs_confirm',
])

export class AppHost {
  phase: HostPhase = 'loading'
  closedReason: ClosedReason | undefined
  status: HostStatus = 'idle'
  /** The frame loaded and the view finished `ui/initialize`. */
  initialized = false
  /** Per-view ring buffer shown under App log; never leaves the device. */
  readonly log: LogEntry[] = []
  logDropped = 0
  /** Set when `tool_result_media` could not be loaded. */
  resultFailed = false

  private loads = 0
  private ready = false
  private declaredModes = new Set<string>()
  private pending = new Map<string, Pending>()
  private nextLog = 0
  private teardownId = 0
  private teardownWaiter: { id: string; done: () => void } | undefined
  private linkOpen = false
  /** One Talos question sheet (message or fullscreen) per view at a time. */
  private chipOpen = false
  /** [Stop asking]: no more chips from this view until it is closed and reopened (a new host). */
  private muted = false
  private deferredContext: Json | undefined
  private pendingHeight: number | undefined
  private heightScheduled = false
  private readonly rates: Record<'toolsCall' | 'uiMessage' | 'openLink' | 'displayMode' | 'log', RateWindow>

  constructor(private readonly env: HostEnv) {
    this.rates = {
      toolsCall: new RateWindow(PER_MINUTE.toolsCall, env.now),
      uiMessage: new RateWindow(PER_MINUTE.uiMessage, env.now),
      openLink: new RateWindow(PER_MINUTE.openLink, env.now),
      displayMode: new RateWindow(PER_MINUTE.displayMode, env.now),
      log: new RateWindow(PER_MINUTE.log, env.now),
    }
  }

  // ---- frame lifecycle -------------------------------------------------------------------------------------------

  /** The iframe's `load` event. The first one is the page; a second means the view navigated itself away. */
  onFrameLoad() {
    if (this.phase === 'closed') return
    this.loads++
    if (this.loads > 1) {
      this.addLog('host', 'host', 'The app tried to leave its frame and was stopped.')
      this.dispose('navigated')
    }
  }

  /** Every `message` event for the page; only the frame's own window is believed. */
  handleMessage(source: unknown, data: unknown) {
    if (this.phase === 'closed') return
    const win = this.env.getWindow()
    if (!win || source !== win) return
    if (this.teardownWaiter && isTeardownAnswer(data, this.teardownWaiter.id)) {
      this.teardownWaiter.done()
      return
    }
    const r = parseViewMessage(data)
    if (!r.ok) return this.rejected(r)
    if (r.kind === 'notification') return this.onNotification(r.method, r.params)
    void this.onRequest(r.id, r.method, r.params)
  }

  /** The signed request's answer from the Mac (relay -> `app.response`). Ignores anything it did not ask for. */
  handleResponse(f: {
    view_id: string
    request_id: string
    state: 'pending_card' | 'done' | 'failed'
    result?: McpCallToolResultT
    result_media?: { media_id: string }
    error?: { code: AppErrorCodeT; message: string }
  }) {
    if (this.phase === 'closed' || f.view_id !== this.env.view.view_id) return
    const p = this.pending.get(f.request_id)
    if (!p) return
    if (f.state === 'pending_card') {
      p.card = true
      this.refreshStatus()
      return
    }
    this.settle(f.request_id)
    if (f.state === 'failed') {
      const code = f.error?.code ?? 'tool_failed'
      if (p.method === 'ui/message') this.reply(p.rpcId, { isError: true })
      else this.fail(p.rpcId, f.error?.message ?? 'The request failed.', code)
      return
    }
    if (p.method === 'ui/message') return this.reply(p.rpcId, {})
    if (f.result) return this.reply(p.rpcId, f.result)
    if (f.result_media) {
      this.env
        .fetchResult(f.result_media)
        .then((result) => this.phase !== 'closed' && this.reply(p.rpcId, result))
        .catch(() => this.phase !== 'closed' && this.fail(p.rpcId, 'The result could not be loaded.', 'tool_failed'))
      return
    }
    this.reply(p.rpcId, { content: [] })
  }

  /** `host-context-changed` with a partial context. Held until the view says `initialized`, then sent once. */
  sendContext(partial: Json) {
    if (this.phase === 'closed') return
    if (!this.ready) {
      this.deferredContext = { ...this.deferredContext, ...partial }
      return
    }
    this.notify('ui/notifications/host-context-changed', partial)
  }

  /** Before any teardown: tell the view (<= 500 ms for its answer), then drop everything. */
  async teardown(reason: ClosedReason = 'retired') {
    if (this.phase === 'closed') return
    if (!this.initialized) return this.dispose(reason)
    const id = `talos-td-${++this.teardownId}`
    const answered = new Promise<void>((resolve) => {
      this.teardownWaiter = { id, done: resolve }
    })
    this.post({ jsonrpc: '2.0', id, method: 'ui/resource-teardown', params: {} })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      answered,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TEARDOWN_WAIT_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
    this.dispose(reason)
  }

  /** `pagehide`: best effort, no waiting. */
  teardownNow(reason: ClosedReason = 'disposed') {
    if (this.phase === 'closed') return
    if (this.initialized)
      this.post({ jsonrpc: '2.0', id: `talos-td-${++this.teardownId}`, method: 'ui/resource-teardown', params: {} })
    this.dispose(reason)
  }

  /** Stops everything without a word to the view. Open requests are dropped (their view is gone). */
  dispose(reason: ClosedReason = 'disposed') {
    if (this.phase === 'closed') return
    this.phase = 'closed'
    this.closedReason = reason
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      if (p.beat) clearInterval(p.beat)
    }
    this.pending.clear()
    this.teardownWaiter?.done()
    this.teardownWaiter = undefined
    this.status = 'idle'
    this.env.onChange()
  }

  // ---- view -> host ----------------------------------------------------------------------------------------------

  private rejected(r: Extract<ViewMessageResult, { ok: false }>) {
    if (r.id !== undefined) this.error(r.id, r.code, r.message)
    else if (r.drop) this.viewLog('host', `dropped a message: ${r.message}`)
  }

  private onNotification(method: string, params: unknown) {
    if (!this.initialized) return
    switch (method) {
      case 'ui/notifications/initialized':
        return this.onReady()
      case 'ui/notifications/size-changed': {
        const h = (params as { height?: number } | undefined)?.height
        if (typeof h !== 'number' || this.env.getDisplayMode() === 'fullscreen') return
        this.pendingHeight = Math.max(MIN_HEIGHT, Math.min(this.env.maxHeight(), Math.round(h)))
        if (!this.heightScheduled) {
          this.heightScheduled = true
          this.env.raf(() => {
            this.heightScheduled = false
            const next = this.pendingHeight
            this.pendingHeight = undefined
            if (next !== undefined && this.phase !== 'closed' && this.env.getDisplayMode() === 'inline')
              this.env.setHeight(next)
          })
        }
        return
      }
      case 'ui/notifications/request-teardown':
        void this.teardown('teardown') // the view's own wish, so the card stays closed
        return
      case 'notifications/message': {
        const p = params as { level?: string; logger?: string; data?: unknown }
        this.viewLog(p.level ?? 'info', stringify(p.data), p.logger ?? '')
        return
      }
    }
  }

  /** Runs one chip. A chip that throws is a No. Resolves 'no' without asking when the view is muted or one is up. */
  private async askChip(ask: () => Promise<ChipAnswer>): Promise<ChipAnswer> {
    if (this.muted || this.chipOpen) return 'no'
    this.chipOpen = true
    let answer: ChipAnswer = 'no'
    try {
      answer = await ask()
    } catch {
      answer = 'no'
    } finally {
      this.chipOpen = false
    }
    if (answer === 'mute') this.muted = true
    return answer
  }

  private async onRequest(id: string | number, method: string, params: unknown): Promise<void> {
    if (method === 'ui/initialize') {
      const p = params as { appCapabilities?: { availableDisplayModes?: string[] } }
      this.declaredModes = new Set(p.appCapabilities?.availableDisplayModes ?? [])
      this.initialized = true
      this.reply(id, this.env.initializeResult([...this.declaredModes]))
      this.env.onChange()
      return
    }
    if (!this.initialized) return this.error(id, RPC_ERR.NOT_INITIALIZED, 'ui/initialize has not completed')
    switch (method) {
      case 'ping':
        return this.reply(id, {})
      case 'tools/call':
        return this.toolsCall(
          id,
          params as { name: string; arguments?: Json; _meta?: { progressToken?: string | number } },
        )
      case 'ui/message':
        return this.uiMessage(id, params as MessageParams)
      case 'ui/open-link':
        return this.openLink(id, (params as { url: string }).url)
      case 'ui/request-display-mode':
        return this.displayMode(id, params as { mode: 'inline' | 'fullscreen' | 'pip' })
      default:
        return this.error(id, RPC_ERR.METHOD_NOT_FOUND, 'method not found')
    }
  }

  private onReady() {
    if (this.ready) return
    this.ready = true
    this.phase = 'ready'
    this.env.onChange()
    // Nothing went to the view before this line; now, once: context that changed meanwhile, the input, the result.
    if (this.deferredContext) this.notify('ui/notifications/host-context-changed', this.deferredContext)
    this.deferredContext = undefined
    this.notify('ui/notifications/tool-input', { arguments: this.env.view.tool_input })
    const v = this.env.view
    if (v.tool_result) return void this.notify('ui/notifications/tool-result', v.tool_result)
    if (v.tool_result_media) {
      this.env
        .fetchResult(v.tool_result_media)
        .then((result) => {
          if (this.phase !== 'closed') this.notify('ui/notifications/tool-result', result)
        })
        .catch(() => {
          this.resultFailed = true
          if (this.phase === 'closed') return
          this.addLog('host', 'host', 'The result could not be loaded.')
          this.notify('ui/notifications/tool-cancelled', { reason: 'The result could not be loaded.' })
        })
    }
  }

  private toolsCall(
    id: string | number,
    p: { name: string; arguments?: Json; _meta?: { progressToken?: string | number } },
  ) {
    const why = this.refuse('toolsCall')
    if (why) return this.fail(id, REFUSALS[why] ?? 'Refused.', why)
    this.send(
      id,
      'tools/call',
      { method: 'tools/call', tool_name: p.name, arguments: p.arguments ?? {} },
      p._meta?.progressToken,
    )
  }

  /** Every message waits for the owner's tap on a Talos chip showing its text; one chip per view at a time. */
  private async uiMessage(id: string | number, p: MessageParams) {
    const text = uiMessageText(p)
    if (text === undefined || this.muted || this.chipOpen || this.refuse('uiMessage'))
      return this.reply(id, { isError: true })
    const answer = await this.askChip(() => this.env.confirmMessage(text))
    if (this.phase === 'closed') return
    if (answer !== 'allow') return this.reply(id, { isError: true })
    this.send(id, 'ui/message', { method: 'ui/message', text, owner_confirmed: true })
  }

  private async openLink(id: string | number, url: string) {
    if (!this.rates.openLink.take() || this.linkOpen) return this.reply(id, { isError: true })
    this.linkOpen = true
    let yes = false
    try {
      yes = await this.env.confirmOpenLink(url)
    } catch {
      yes = false
    } finally {
      this.linkOpen = false
    }
    if (this.phase === 'closed') return
    if (!yes) return this.reply(id, { isError: true })
    this.env.openExternal(url)
    this.reply(id, {})
  }

  private async displayMode(id: string | number, p: { mode: 'inline' | 'fullscreen' | 'pip' }) {
    let cur = this.env.getDisplayMode()
    let next: DisplayMode = cur
    // 6 a minute, every ask: a view polling for a tap cannot keep trying (and each fullscreen try puts up a chip)
    if (!this.rates.displayMode.take()) return this.reply(id, { mode: cur })
    if (p.mode === 'inline') next = 'inline'
    // fullscreen needs the view to have declared it AND the owner's tap on a Talos chip (a self-focus makes a gesture
    // look real, so a gesture is never enough); pip is never granted
    else if (p.mode === 'fullscreen' && this.declaredModes.has('fullscreen') && cur !== 'fullscreen') {
      if (this.muted || this.chipOpen) return this.reply(id, { mode: cur })
      const answer = await this.askChip(() => this.env.confirmFullscreen())
      if (this.phase === 'closed') return
      cur = this.env.getDisplayMode() // the owner may have used Expand while the chip was up
      if (answer === 'allow') next = 'fullscreen'
      else next = cur
    }
    if (next !== cur) {
      await this.env.setDisplayMode(next)
      if (this.phase === 'closed') return
    }
    this.reply(id, { mode: next })
    if (next !== cur)
      this.sendContext({
        displayMode: next,
        containerDimensions: this.env.dimensions(next),
        ...(next === 'fullscreen' ? { safeAreaInsets: this.env.safeAreaInsets() } : {}),
      })
  }

  // ---- signed requests -------------------------------------------------------------------------------------------

  private refuse(kind: 'toolsCall' | 'uiMessage'): AppErrorCodeT | undefined {
    if (Date.parse(this.env.view.calls_until) < this.env.wallNow()) return 'view_closed'
    if (!this.rates[kind].take()) return 'rate_limited'
    return undefined
  }

  private send(
    rpcId: string | number,
    method: 'tools/call' | 'ui/message',
    fields: Json,
    progressToken?: string | number,
  ) {
    const request_id = `ar_${newUlid()}`
    const p: Pending = {
      rpcId,
      method,
      progress: 0,
      card: false,
      timer: setTimeout(() => {
        if (!this.pending.has(request_id)) return
        this.settle(request_id)
        if (method === 'ui/message') this.reply(rpcId, { isError: true })
        else this.fail(rpcId, 'No answer arrived in time.', 'timeout')
      }, CLIENT_CEILING_MS),
      ...(progressToken !== undefined ? { progressToken } : {}),
    }
    if (progressToken !== undefined && method === 'tools/call') {
      p.beat = setInterval(() => {
        p.progress++
        this.notify('notifications/progress', { progressToken, progress: p.progress })
      }, PROGRESS_INTERVAL_MS)
    }
    this.pending.set(request_id, p)
    this.refreshStatus()
    const v = this.env.view
    this.env
      .sendRequest({
        type: 'app.request',
        thread_id: v.thread_id,
        view_id: v.view_id,
        request_id,
        user_gesture: this.env.claimGesture(),
        ...fields,
      })
      .catch((e: unknown) => {
        if (!this.pending.has(request_id) || this.phase === 'closed') return
        this.settle(request_id)
        const code = (e as { code?: string } | null)?.code
        const talos: AppErrorCodeT = code && TALOS_ERRORS.has(code) ? (code as AppErrorCodeT) : 'tool_failed'
        if (method === 'ui/message') this.reply(rpcId, { isError: true })
        else this.fail(rpcId, REFUSALS[talos] ?? 'The request could not be sent.', talos)
      })
  }

  private settle(requestId: string) {
    const p = this.pending.get(requestId)
    if (!p) return
    clearTimeout(p.timer)
    if (p.beat) clearInterval(p.beat)
    this.pending.delete(requestId)
    this.refreshStatus()
  }

  private refreshStatus() {
    const all = [...this.pending.values()]
    const next: HostStatus = all.some((p) => p.card) ? 'approval' : all.length > 0 ? 'agent' : 'idle'
    if (next !== this.status) {
      this.status = next
      this.env.onChange()
    }
  }

  // ---- logging and wire ------------------------------------------------------------------------------------------

  /** A view-originated entry: more than 60 a minute are dropped and counted, never stored. */
  private viewLog(level: string, text: string, logger = '') {
    if (!this.rates.log.take()) {
      this.logDropped++
      return
    }
    this.addLog(level, logger, text)
  }

  private addLog(level: string, logger: string, text: string) {
    this.log.push({
      n: ++this.nextLog,
      level: level.slice(0, 20),
      logger: logger.slice(0, 100),
      text: text.slice(0, LOG_ENTRY_CHARS),
    })
    if (this.log.length > LOG_ENTRIES) this.log.shift()
    this.env.onChange()
  }

  private post(msg: Json) {
    try {
      this.env.getWindow()?.postMessage(msg, '*') // an opaque origin cannot be named
    } catch {}
  }
  private reply(id: string | number, result: unknown) {
    this.post({ jsonrpc: '2.0', id, result })
  }
  private error(id: string | number, code: number, message: string, data?: Json) {
    this.post({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
  }
  private fail(id: string | number, message: string, talos: AppErrorCodeT) {
    this.error(id, RPC_ERR.SERVER, message.slice(0, 200), { talos })
  }
  private notify(method: string, params: Json | McpCallToolResultT) {
    this.post({ jsonrpc: '2.0', method, params })
  }
}

/** Plain, Talos-written reasons a view can be told (never a server's text). */
const REFUSALS: Partial<Record<AppErrorCodeT, string>> = {
  rate_limited: 'Too many requests from this app. Try again in a minute.',
  view_closed: 'This app can no longer make requests.',
  mac_offline: 'Your Mac is offline.',
  timeout: 'No answer arrived in time.',
  tool_failed: 'The request could not be sent.',
  needs_confirm: 'Tap Send on the card.',
  sig_invalid: 'This device could not be verified.',
}

function isTeardownAnswer(data: unknown, id: string) {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Json).jsonrpc === '2.0' &&
    (data as Json).id === id &&
    !('method' in data)
  )
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

/** The `ui/initialize` result (M2.4), exactly. `safeAreaInsets` is fullscreen only, so it is never in this one. */
export function buildInitializeResult(o: {
  csp: AppCspT
  theme: 'light' | 'dark'
  variables: Record<string, string>
  width: number
  maxHeight: number
  locale: string
  phone: boolean
  touch: boolean
  hover: boolean
  appVersion: string
}): Json {
  return {
    protocolVersion: UI_PROTOCOL_VERSION,
    hostInfo: { name: 'talos-app', version: o.appVersion },
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      logging: {},
      message: { text: {} },
      sandbox: { permissions: {}, csp: toSpecCsp(o.csp) },
    },
    hostContext: {
      theme: o.theme,
      styles: { variables: o.variables },
      displayMode: 'inline',
      availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: { width: o.width, maxHeight: o.maxHeight },
      locale: o.locale,
      platform: o.phone ? 'mobile' : 'web',
      deviceCapabilities: { touch: o.touch, hover: o.hover },
    },
  }
}

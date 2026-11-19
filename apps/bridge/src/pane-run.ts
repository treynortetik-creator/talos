// A Run the owner asked to have run in the terminal pane (the owner's own shell in the Talos window of the Mac app), not by the
// agent. The signed tap says so in `run_where` (`isPaneRun`, protocol). This file is the whole bridge side of that path: the one
// request to the Mac app, and whether that channel is up (the `run-pane/1` feature). The app does the real check, and is the only
// thing that can write to the shell: the owner's own click in its window must have vouched for this exact message id
// (`run_witness`). Every failure here is a plain sentence for the owner in the thread; a pane Run is never handed to the agent.
import { lstatSync } from 'node:fs'
import type { BridgeContext } from './context.ts'
import { type ScreenAnswer, screenRequest, screenSockPath } from './screen.ts'

/**
 * The most one pane Run takes in the Mac app, from taking it to the last byte it may write (witness wait, pane wait, clearing the line:
 * `PaneRun.totalBudgetSeconds` in TalosDesktopCore; a drift test holds the two equal). The app writes nothing after it.
 */
export const PANE_RUN_APP_BUDGET_MS = 10_000
/** How long the bridge waits for the app: its whole budget and a margin, so the bridge never gives up on a Run that is still going. */
export const PANE_RUN_TIMEOUT_MS = PANE_RUN_APP_BUDGET_MS + 2_000

/** What the Mac app is told. `client_msg_id` is the signed tap's own message id, unchanged: the app looks for a witness for it. */
export type PaneRunRequest = { thread_id: string; script: string; client_msg_id: string }

/** `unsure`: the app may have run the script (no answer in time, an answer that could not be read), so the line must not say it did not. */
export type PaneRunResult = { ok: true } | { ok: false; why: string; unsure?: boolean }

/** The request goes over the Mac app's own local socket (screen.ts). Tests replace it. */
export const paneTransport = {
  request: (ctx: BridgeContext, req: Record<string, unknown>): Promise<ScreenAnswer> =>
    screenRequest(ctx.paths.home, req, { timeoutMs: PANE_RUN_TIMEOUT_MS }),
}

const one = (s: string, max = 200) => s.replace(/\s+/g, ' ').trim().slice(0, max)

/** `app_closed`: the bridge could not reach the Mac app's run channel, so nothing was sent (the app's own refusals come in its words). */
export const PANE_APP_CLOSED = "the Talos Mac app isn't open on this Mac"

/** The words for each way the app can say no. An unknown code says what the app said, clipped, never "ok". */
export function paneWhy(a: Extract<ScreenAnswer, { ok: false }>): string {
  switch (a.code) {
    case 'not_mac':
      return 'the terminal pane is only in the Talos Mac app'
    case 'not_running':
    case 'pane_unavailable':
      return PANE_APP_CLOSED
    case 'not_ours':
      return "the Mac app's socket isn't this user's own"
    case 'no_answer':
      return "Talos.app didn't answer in time; check the terminal pane before running it again"
    case 'bad_answer':
      return "Talos.app's answer couldn't be read; check the terminal pane before running it again"
    case 'unknown_op':
      return 'this Talos.app is older and cannot run a script in the pane. Update it'
    default:
      return a.text ? one(a.text) : `Talos.app refused (${one(a.code, 60) || 'no reason given'})`
  }
}

/** Sends one script to the pane. Never throws and never reports success unless the app said ok. */
export async function sendPaneRun(ctx: BridgeContext, r: PaneRunRequest): Promise<PaneRunResult> {
  let a: ScreenAnswer
  try {
    a = await paneTransport.request(ctx, { op: 'pane_run', id: r.client_msg_id, ...r })
  } catch (e) {
    return { ok: false, why: one((e as Error).message) || 'the request failed' }
  }
  // a channel that is not there (not running, an older app) leaves the feature list now; a refusal means it is there
  if (!a.ok && ['not_running', 'not_mac', 'not_ours', 'unknown_op', 'pane_unavailable'].includes(a.code))
    ctx.paneRun?.seen(false)
  if (a.ok) return { ok: true }
  return { ok: false, why: paneWhy(a), ...(a.code === 'no_answer' || a.code === 'bad_answer' ? { unsure: true } : {}) }
}

/** The line the owner reads in the thread when a pane Run did not run. */
export const paneFailLine = (why: string, unsure = false): string =>
  unsure
    ? `Run couldn't reach the terminal pane: ${why}.`
    : `Run couldn't reach the terminal pane: ${why}. Nothing was run.`

/** How often the bridge looks whether the Mac app's run channel is there, and so whether `run-pane/1` is listed. */
export const PANE_PROBE_MS = 15_000

/**
 * Whether the Mac app's run channel is connected, for the `run-pane/1` feature. A real answer (`pane_status`, which the app
 * answers ok only while its run channel is installed) is kept; until the first one, a socket that is there is the guess. A change
 * makes the relay hello again (`onChange`), so the list the web app sees is what is true now: the feature leaves when the channel
 * does. A pane Run that finds the channel down also marks it down at once.
 */
export class PaneChannel {
  private up: boolean | null = null
  private timer: ReturnType<BridgeContext['clock']['setTimeout']> | null = null
  private stopped = true

  constructor(
    private readonly ctx: BridgeContext,
    private readonly onChange: () => void,
    private readonly everyMs: number = PANE_PROBE_MS,
  ) {}

  get available(): boolean {
    return this.up ?? socketThere(this.ctx.paths.home)
  }

  /** Starts looking. Idempotent; it ends by itself when the bridge begins to stop (`ctx.closing`). */
  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop() {
    this.stopped = true
    if (this.timer) this.ctx.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** What a pane Run learned: the channel answered, or it did not. */
  seen(up: boolean) {
    const was = this.available
    this.up = up
    if (was !== up) this.onChange()
  }

  /** Asks the app now whether its run channel answers, and keeps the answer. */
  async probe(): Promise<boolean> {
    let up = false
    try {
      up = (await paneTransport.request(this.ctx, { op: 'pane_status', id: 'status' })).ok
    } catch {
      up = false
    }
    this.seen(up)
    return up
  }

  /** Whether a pane Run may be routed now: the feature is listed, or a fresh look says the channel is there. */
  async check(): Promise<boolean> {
    return this.available || (await this.probe())
  }

  private async tick() {
    if (this.stopped || this.ctx.closing) return
    await this.probe()
    if (this.stopped || this.ctx.closing) return
    this.timer = this.ctx.clock.setTimeout(() => void this.tick(), this.everyMs)
    ;(this.timer as { unref?: () => void } | null)?.unref?.()
  }
}

function socketThere(home: string): boolean {
  try {
    const st = lstatSync(screenSockPath(home))
    return st.isSocket() && (process.getuid?.() === undefined || st.uid === process.getuid())
  } catch {
    return false
  }
}

/**
 * The context with its run channel made and looking (once). Called where the hello's feature list is read, so the channel starts with
 * the first hello and needs no start or stop call in the bridge's own lifecycle: it ends when `ctx.closing`.
 */
export function withPaneRun(ctx: BridgeContext, onChange: () => void): BridgeContext {
  if (!ctx.paneRun) {
    ctx.paneRun = new PaneChannel(ctx, onChange)
    ctx.paneRun.start()
  }
  return ctx
}

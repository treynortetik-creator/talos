// A live bridge wired to the FakeRelay with the MCP-apps service on, an approved catalog on disk, and helpers that sign and
// send real `app.request` frames through the relay into the real inbound pipeline.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Frame, newUlid } from '@talos-app/protocol'
import { type FakeClock, fakeClock, mkFrame, waitFor } from '@talos-app/testkit'
import type { DirectConnector } from '../../src/apps/direct.ts'
import { runHook } from '../../src/apps/hooks.ts'
import { createLogger } from '../../src/log.ts'
import { advanceSteps, type Harness, startHarness } from '../helpers.ts'
import { approvedFixture, memSecrets } from './helpers.ts'

export const THREAD = 'general'

export type AppsHarness = Awaited<ReturnType<typeof mkApps>>

export async function mkApps(
  o: {
    fx?: Parameters<typeof approvedFixture>[1]
    clock?: FakeClock
    connector?: DirectConnector
    pinApp?: boolean
    logs?: string[]
    /** Edits the starting config.json (trust mode, say). */
    config?: NonNullable<Parameters<typeof startHarness>[0]>['config']
  } = {},
) {
  const sec = memSecrets()
  const flag = { on: true }
  const logs = o.logs ?? []
  const h: Harness = await startHarness({
    env: { TALOS_APP_APPS: '1' },
    ...(o.config ? { config: o.config } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.pinApp === false ? { pinApp: false } : {}),
    bridge: {
      logger: createLogger(null, 'debug', (line) => void logs.push(line)),
      apps: {
        secrets: sec.secrets,
        ...(o.connector ? { connector: o.connector } : {}),
        watch: false,
        tickMs: 3600_000,
        isEnabled: () => flag.on,
      },
    },
  })
  const fx = await approvedFixture(h.home, o.fx)
  const svc = h.bridge.ctx.apps
  if (!svc) throw new Error('apps service missing')
  const nowMs = () => (o.clock ? o.clock.now() : Date.now())
  const tsNow = () => new Date(nowMs()).toISOString()
  const puts: Array<{ id: string; mime: string; headers: Record<string, string>; bytes: Uint8Array }> = []
  const http = h.bridge.ctx.http
  const realPut = http.putMedia.bind(http)
  http.putMedia = async (id, bytes, sha, mime, name, extra = {}) => {
    puts.push({ id, mime, headers: extra, bytes })
    return realPut(id, bytes, sha, mime, name, extra)
  }
  const hook = (event: 'pre-tool-use' | 'post-tool-use' | 'post-tool-use-failure', input: Record<string, unknown>) =>
    runHook(
      event,
      JSON.stringify({
        session_id: 'sess_1',
        transcript_path: join(h.home, 'proj', 'sess_1.jsonl'),
        mcp_server: { name: 'probe', source: 'local' },
        ...input,
      }),
      { paths: fx.P, now: nowMs, live: true },
    ) as { hookSpecificOutput: Record<string, unknown> } | undefined

  /** The agent called a UI tool for the owner; the post hook ran; then app_show. Returns the view id. */
  async function showView(opts: { toolUseId?: string; response?: string; caption?: string; tool?: string } = {}) {
    const id = opts.toolUseId ?? `toolu_ui_${newUlid().slice(-6)}`
    const nudge = hook('post-tool-use', {
      tool_name: `mcp__probe__${opts.tool ?? 'show_widget'}`,
      tool_input: {},
      tool_use_id: id,
      tool_response: opts.response ?? '{"tool":"show_widget","ok":true}',
    })
    const r = await h.bridge.callTool('app_show', {
      thread_id: THREAD,
      capture_id: id,
      ...(opts.caption ? { caption: opts.caption } : {}),
    })
    const text = r.content[0]?.text ?? ''
    return {
      nudge,
      result: r,
      text,
      viewId: /view (av_[0-9A-HJKMNP-TV-Z]{26})/.exec(text)?.[1] as string,
      captureId: id,
    }
  }

  async function signReq(fields: Record<string, unknown>, ts = tsNow()) {
    return h.app.sign({
      ...mkFrame('app.request', {}, ts),
      thread_id: THREAD,
      request_id: `ar_${newUlid()}`,
      user_gesture: true,
      ...fields,
    } as never) as Promise<Record<string, unknown> & { id: string; request_id: string; view_id: string }>
  }
  async function call(
    viewId: string,
    tool: string,
    args: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) {
    const f = await signReq({ view_id: viewId, method: 'tools/call', tool_name: tool, arguments: args, ...extra })
    h.app.send(f) // through the app socket and the relay's routing, like the PWA
    return f
  }
  async function message(viewId: string, text: string, extra: Record<string, unknown> = {}) {
    const f = await signReq({ view_id: viewId, method: 'ui/message', text, owner_confirmed: true, ...extra })
    h.app.send(f)
    return f
  }
  /** The first answer for a request; pass `final` to skip a `pending_card` and wait for the outcome. */
  const response = (requestId: string, o: { timeoutMs?: number; final?: boolean } | number = {}) => {
    const opts = typeof o === 'number' ? { timeoutMs: o } : o
    return h.relay.expectFrame(
      'app.response',
      (f) => f.request_id === requestId && (!opts.final || f.state !== 'pending_card'),
      { direction: 'from_bridge', timeoutMs: opts.timeoutMs ?? 3000 },
    ) as Promise<Extract<Frame, { type: 'app.response' }>>
  }
  const responses = (requestId: string) =>
    h.relay.frames
      .filter(
        (r) =>
          r.direction === 'from_bridge' &&
          r.frame.type === 'app.response' &&
          (r.frame as { request_id?: string }).request_id === requestId,
      )
      .map((r) => r.frame as Extract<Frame, { type: 'app.response' }>)
  const updates = (viewId: string) =>
    h.relay.frames
      .filter(
        (r) =>
          r.direction === 'from_bridge' &&
          r.frame.type === 'app.update' &&
          (r.frame as { view_id?: string }).view_id === viewId,
      )
      .map((r) => r.frame as Extract<Frame, { type: 'app.update' }>)
  const cardFor = async (requestId: string) => {
    const card = (
      await h.relay.expectFrame(
        'card.create',
        (f) => (f.card.payload as { request_id?: string } | undefined)?.request_id === requestId,
        { direction: 'from_bridge' },
      )
    ).card
    return card
  }
  async function resolve(card: { id: string; payload_hash: string; risk: string }, action: 'primary' | 'kill') {
    const token = action === 'primary' && card.risk === 'high' ? h.relay.mintStepup(`card:${card.id}`) : undefined
    await h.app.resolveCard(card as never, action, card.payload_hash, token ? { stepup_token: token } : {})
  }
  const notesOf = (kind: string) => h.notes.filter((n) => n.meta.kind === kind)
  const idle = async () => {
    await h.bridge.inbound?.appsIdle()
    await new Promise((r) => setTimeout(r, 15))
  }
  const enable = (on: boolean) => {
    flag.on = on
  }
  const writeCatalog = (c: unknown) => writeFileSync(fx.P.catalog, JSON.stringify(c))
  return {
    advance: (ms: number) => advanceSteps(o.clock as FakeClock, ms),
    h,
    fx,
    svc,
    sec,
    hook,
    showView,
    signReq,
    call,
    message,
    response,
    responses,
    updates,
    cardFor,
    resolve,
    notesOf,
    idle,
    enable,
    writeCatalog,
    puts,
    logs,
    nowMs,
    tsNow,
    waitFor,
    clock: o.clock,
    flag,
  }
}

export { fakeClock }

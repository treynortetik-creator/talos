// Shared by the AP3 tests: the committed AP0 view fixture, and a HostEnv double that records what the host does.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AppView, type AppViewT, newId, newUlid } from '@talos-app/protocol'
import { vi } from 'vitest'
import { AppHost, buildInitializeResult, type DisplayMode, type HostEnv } from '../../src/features/apps/host.ts'

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../../../packages/protocol/fixtures/frames/${name}.json`), 'utf8'),
  ) as { message: Record<string, unknown> & { app: Record<string, unknown> } }

/** A valid view row (the AP0 fixture) with fresh ids, and any field overridden. */
export function makeView(over: Record<string, unknown> = {}): AppViewT {
  const base = fixture('reply.app_view').message.app
  return AppView.parse({
    ...base,
    view_id: `av_${newUlid()}`,
    page: { ...(base.page as object), media_id: newId('md') },
    ...over,
  })
}

/** The whole `reply` frame for a view (what the bridge sends). */
export function viewReply(view: AppViewT, over: Record<string, unknown> = {}) {
  const f = fixture('reply.app_view')
  return { ...f, id: newUlid(), message: { ...f.message, id: newId('m'), app: view, ...over } }
}

export type Json = Record<string, unknown>

export function makeHost(over: Partial<HostEnv> = {}, view: AppViewT = makeView()) {
  const posted: Json[] = []
  const win = { postMessage: vi.fn((m: Json) => void posted.push(m)) }
  const sent: Json[] = []
  const state = {
    mode: 'inline' as DisplayMode,
    gesture: false,
    mono: 0,
    wall: Date.parse('2026-10-28T16:00:00Z'),
    height: 0,
    links: [] as string[],
  }
  const confirms: Array<(v: boolean) => void> = []
  const rafs: Array<() => void> = []
  const env: HostEnv = {
    view,
    getWindow: () => win,
    sendRequest: async (f) => void sent.push(f),
    claimGesture: () => state.gesture,
    confirmMessage: async () => 'allow',
    confirmFullscreen: async () => 'allow',
    confirmOpenLink: () => new Promise<boolean>((r) => confirms.push(r)),
    openExternal: (u) => void state.links.push(u),
    getDisplayMode: () => state.mode,
    setDisplayMode: async (m) => {
      state.mode = m
    },
    dimensions: (m) => (m === 'fullscreen' ? { width: 800, height: 500 } : { width: 400, maxHeight: 640 }),
    safeAreaInsets: () => ({ top: 1, right: 2, bottom: 3, left: 4 }),
    initializeResult: () =>
      buildInitializeResult({
        csp: view.csp,
        theme: 'light',
        variables: { '--font-sans': 'system-ui' },
        width: 400,
        maxHeight: 640,
        locale: 'en-US',
        phone: false,
        touch: false,
        hover: true,
        appVersion: '1.2.3',
      }),
    setHeight: (px) => {
      state.height = px
    },
    maxHeight: () => 640,
    fetchResult: async () => ({ content: [{ type: 'text', text: 'big' }] }),
    now: () => state.mono,
    wallNow: () => state.wall,
    raf: (cb) => void rafs.push(cb),
    onChange: () => {},
    ...over,
  }
  const host = new AppHost(env)
  const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise<void>((r) => setTimeout(r, 0)))
  return {
    host,
    view,
    win,
    posted,
    sent,
    state,
    confirms,
    rafs,
    flush,
    /** What the view said, from its window. */
    say: (data: unknown, source: unknown = win) => host.handleMessage(source, data),
    req: (id: number | string, method: string, params?: unknown) => ({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
    note: (method: string, params?: unknown) => ({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }),
    /** The view's handshake, answered. */
    async start(modes: string[] = ['inline', 'fullscreen']) {
      host.handleMessage(win, {
        jsonrpc: '2.0',
        id: 'i',
        method: 'ui/initialize',
        params: { protocolVersion: '2026-01-26', appCapabilities: { availableDisplayModes: modes } },
      })
      host.handleMessage(win, { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} })
      await flush()
    },
    replies: (id: number | string) => posted.filter((m) => m.id === id),
    methods: () => posted.filter((m) => typeof m.method === 'string').map((m) => m.method as string),
  }
}

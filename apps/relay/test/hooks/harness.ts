// Shared setup for the WP3 relay tests: fake services, test auth, a configured hooks runtime, and request helpers.

import type { IntegrationModule } from '@talos-app/integrations'
import { signStandard, verifyStandard } from '@talos-app/integrations'
import { type AgentConfigT, type IntegrationIdT, newId, parseFrame } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import type { Hono } from 'hono'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { openEvent } from '../../src/hooks/event-seal.ts'
import * as hooks from '../../src/hooks/index.ts'
import { stopTicking } from '../../src/hooks/runtime.ts'
import type { RuntimeOptions } from '../../src/hooks/types.ts'
import { buildApp } from '../../src/routes.ts'
import type { AppEnv } from '../../src/services.ts'
import { createFakeServices, type FakeServices } from '../helpers/fake-services.ts'
import { installTestAuth } from '../helpers/test-auth.ts'

// biome-ignore lint/suspicious/noExplicitAny: test assertions walk loosely-shaped JSON from frames and rows
export type Loose = Record<string, any>

export type Setup = {
  f: FakeServices
  app: Hono<AppEnv>
  rt: ReturnType<typeof hooks.runtimeFor>
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
  /** POST /api/connections and return the parsed 201 body. */
  create(integration: IntegrationIdT, extra?: Record<string, unknown>): Promise<Loose>
  /** A correctly signed Standard Webhooks POST. */
  send(
    integration: IntegrationIdT,
    connId: string,
    secret: string,
    body: unknown,
    over?: { id?: string; tsS?: number; headers?: Record<string, string> },
  ): Promise<Response>
  /** A raw POST with arbitrary headers. */
  post(
    integration: string,
    connId: string,
    body: string | Uint8Array,
    headers?: Record<string, string>,
  ): Promise<Response>
  drain(): Promise<void>
  tick(): Promise<void>
  /** Event rows currently in the database, exactly as stored (event text is sealed in `event_enc`). */
  events(): Array<Loose>
  /** The events those rows hold, opened. */
  eventBodies(): Array<Loose>
  count(table: string): number
  config(over: (c: AgentConfigT) => void): void
}

export function setup(
  opts: RuntimeOptions & { env?: Record<string, string>; config?: (c: AgentConfigT) => void } = {},
): Setup {
  resetAuthImplementation()
  installTestAuth()
  const f = createFakeServices({ env: opts.env })
  const cfg = loadExampleConfig('default')
  opts.config?.(cfg)
  f.setAgentConfig(cfg)
  const rt = hooks.createRuntime(f.services, {
    ...(opts.modules ? { modules: opts.modules } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.autoProcess !== undefined ? { autoProcess: opts.autoProcess } : {}),
    ...(opts.bodyIdleMs !== undefined ? { bodyIdleMs: opts.bodyIdleMs } : {}),
    ...(opts.bodyTotalMs !== undefined ? { bodyTotalMs: opts.bodyTotalMs } : {}),
  })
  hooks.register(f.services)
  stopTicking(f.services) // tests call tick() themselves
  const app = buildApp(f.services)
  const origin = f.services.env.PUBLIC_ORIGIN
  const api: Setup['api'] = async (method, path, body, headers = {}) =>
    await app.request(`${origin}${path}`, {
      method,
      headers: { 'x-test-session': 'none', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const post: Setup['post'] = async (integration, connId, body, headers = {}) =>
    await app.request(`${origin}/hook/${integration}/${connId}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : Buffer.from(body),
    })
  return {
    f,
    app,
    rt,
    api,
    post,
    async create(integration, extra = {}) {
      const res = await api('POST', '/api/connections', { integration, name: `${integration} test`, ...extra })
      if (res.status !== 201) throw new Error(`create ${integration}: ${res.status} ${await res.text()}`)
      return (await res.json()) as Loose
    },
    send(integration, connId, secret, body, over = {}) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body)
      const headers = signStandard({
        secret,
        id: over.id ?? `msg_${crypto.randomUUID()}`,
        timestampS: over.tsS ?? Math.floor(f.clock.now() / 1000),
        body: raw,
      })
      return post(integration, connId, raw, { 'content-type': 'application/json', ...headers, ...over.headers })
    },
    drain: () => hooks.idle(rt),
    tick: () => hooks.tick(rt),
    events: () => f.db.prepare('select * from hooks_events order by created_at, event_id').all() as Array<Loose>,
    eventBodies: () =>
      (f.db.prepare('select * from hooks_events order by created_at, event_id').all() as Array<Loose>).map((r) =>
        openEvent(f.services, r as never),
      ),
    count: (table) => (f.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n,
    config: (over) => {
      const c = f.services.agentConfig()
      if (c) over(c)
    },
  }
}

/** Every frame the relay produced parses as the right direction (spec 10.2). */
export function expectValidFrames(f: FakeServices): void {
  for (const { frame } of f.bus.toAppsLog) {
    const r = parseFrame(frame, { direction: 'relay_to_app' })
    if (!r.ok) throw new Error(`invalid relay->app frame ${String(frame.type)}: ${r.message}`)
  }
  for (const { frame } of f.bus.toBridgeLog) {
    const r = parseFrame(frame, { direction: 'relay_to_bridge' })
    if (!r.ok) throw new Error(`invalid relay->bridge frame ${String(frame.type)}: ${r.message}`)
  }
}

export const framesOf = (log: Array<{ frame: Record<string, unknown> }>, type: string) =>
  log.map((l) => l.frame).filter((fr) => fr.type === type) as Array<Loose>

/** A work-category module the tests use in place of a WP3b stub: Standard Webhooks, with a pre-filter on `skip`. */
export function fakeWork(id: IntegrationIdT = 'slack'): IntegrationModule {
  return {
    id,
    setup: {
      id,
      name: 'Fake work app',
      category: 'work',
      icon: 'briefcase',
      blurb: 'A stand-in for a work source.',
      default_thread: 'work',
      filters: [],
      connect: [{ type: 'text', md: 'n/a' }],
      test_hint: 'n/a',
    },
    verify: (req, conn) => verifyStandard(req, conn),
    prefilter: (raw) => !(raw.json as { skip?: boolean } | undefined)?.skip,
    normalize: (raw, conn) => {
      const j = (raw.json ?? {}) as { title?: string; id?: string }
      return [
        {
          id: newId('e'),
          source: id,
          connection: conn.id,
          kind: 'slack.dm',
          title: j.title ?? 'work item',
          summary: 'summary',
          actor: {},
          ts: new Date(raw.receivedAt).toISOString(),
          thread: conn.thread,
          work: conn.work,
          priority: 'high',
          dedup_key: `fake:${j.id ?? raw.receivedAt}`,
        },
      ]
    },
  }
}

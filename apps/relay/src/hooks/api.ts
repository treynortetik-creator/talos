// /api/integrations/catalog, /api/connections*, /api/inbox (spec 3.8, 7.7). Every route needs a session; writes also CSRF.
import { assertPublicFeedUrl, type IntegrationModule, moduleExtras, signStandard } from '@talos-app/integrations'
import { ConnectionCreate, IntegrationId, type RouteRes, routes, type SetupSpecT, ThreadId } from '@talos-app/protocol'
import { Hono } from 'hono'
import { requireCsrf, requireSession } from '../auth/contract.ts'
import type { AppEnv } from '../services.ts'
import { claimsSecret, issueClaim } from './claim.ts'
import { AdvancedFilters, defaultToggles, effectiveToggles } from './filters.ts'
import { listInbox } from './inbox.ts'
import { handleHookRequest, idle, integrationEnabled } from './ingest.ts'
import { pollConnection, pollSoon } from './poller.ts'
import { knownThreads } from './route.ts'
import { runtimeFor } from './runtime.ts'
import {
  countConns,
  credsFor,
  deleteConn,
  getConn,
  insertConn,
  listConns,
  rotateSecret,
  saveCreds,
  secretsFor,
  stats24h,
  updateConn,
} from './store.ts'
import {
  type ConnRow,
  type HooksRuntime,
  MAX_CONNECTIONS,
  OLD_SECRET_GRACE_MS,
  PREV_SECRET,
  PREV_SECRET_UNTIL,
} from './types.ts'

/** Connection `extra` key listing the setup secrets the relay used once and then deleted. */
const PROVISIONED = 'provisioned_forgot'

type ProvisionResult = { ok: true; forgot: string[] } | { ok: false; error: string }

/** Runs the module's one-time vendor provisioning when setup secrets were just supplied. Returns the secret fields to forget. */
async function provisionOnce(
  r: HooksRuntime,
  conn: Pick<ConnRow, 'id' | 'integration'>,
  mod: IntegrationModule,
  secrets: Record<string, string>,
  extra: Record<string, string>,
): Promise<ProvisionResult> {
  const provision = moduleExtras(mod).provision
  if (!provision || Object.keys(secrets).length === 0) return { ok: true, forgot: [] }
  const done = await provision({
    fetch: r.opts.fetch ?? globalThis.fetch,
    hookUrl: `${r.services.env.PUBLIC_ORIGIN}/hook/${conn.integration}/${conn.id}`,
    secret: secretsFor(r, conn.id)[0] as string,
    secrets,
    extra,
  })
  return done.ok ? { ok: true, forgot: done.forget } : { ok: false, error: done.error ?? 'failed' }
}

function connectionJson(rt: HooksRuntime, c: ConnRow) {
  const mod = rt.module(c.integration)
  const s = stats24h(rt, c.id)
  return {
    id: c.id,
    integration: c.integration,
    name: c.name,
    thread: c.thread,
    status: c.status,
    filters: effectiveToggles(mod, c.filters),
    advanced: c.advanced,
    created_at: rt.iso(c.created_at),
    last_event_at: c.last_event_at ? rt.iso(c.last_event_at) : null,
    kept_24h: s.kept,
    received_24h: s.received,
  }
}

/** The spec's default thread (7.1 routing), checked against the configured threads. Null = no such thread. */
function resolveThread(rt: HooksRuntime, spec: SetupSpecT, requested: string | undefined): string | null {
  const cfg = rt.services.agentConfig()
  const fallback = spec.default_thread === 'work' ? (cfg?.work.thread ?? 'inbox') : 'inbox'
  const t = requested ?? fallback
  return ThreadId.safeParse(t).success && knownThreads(rt).has(t) ? t : null
}

type Split = { ok: true; extra: Record<string, string>; secrets: Record<string, string> } | { ok: false; error: string }

/** Sorts submitted wizard fields into plain settings and secrets, checking each against the setup spec. */
function splitFields(spec: SetupSpecT, fields: Record<string, string>): Split {
  const extra: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  const specs = new Map(spec.connect.flatMap((s) => (s.type === 'field' ? ([[s.key, s]] as const) : [])))
  for (const [k, v] of Object.entries(fields)) {
    const f = specs.get(k)
    if (!f) return { ok: false, error: `unknown field: ${k.slice(0, 40)}` }
    if (v === '') continue
    if (v.length > 2000) return { ok: false, error: `${k} is too long` }
    if (f.pattern && !new RegExp(f.pattern).test(v)) return { ok: false, error: `${k} does not look right` }
    ;(f.secret ? secrets : extra)[k] = v
  }
  if (extra.feed_url) {
    try {
      assertPublicFeedUrl(extra.feed_url)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'bad feed address' }
    }
  }
  return { ok: true, extra, secrets }
}

/** First required field (one whose help text does not start with "Optional") that is still empty. */
function missingRequired(spec: SetupSpecT, have: Set<string>): string | null {
  for (const s of spec.connect)
    if (s.type === 'field' && !/^optional/i.test(s.help ?? '') && !have.has(s.key)) return s.key
  return null
}

export function apiRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const rt = (c: { get(k: 'services'): AppEnv['Variables']['services'] }) => runtimeFor(c.get('services'))

  for (const path of ['/api/integrations/*', '/api/connections', '/api/connections/*', '/api/inbox'])
    app.use(path, requireSession)
  for (const path of ['/api/connections', '/api/connections/*'])
    app.use(path, (c, next) => (c.req.method === 'GET' ? next() : requireCsrf(c, next)))

  app.get(routes.catalog.path, (c) => {
    const r = rt(c)
    return c.json(IntegrationId.options.map((id) => r.module(id).setup))
  })

  app.get(routes.connectionsList.path, (c) => {
    const r = rt(c)
    return c.json(listConns(r).map((x) => connectionJson(r, x)))
  })

  app.get(routes.inboxList.path, (c) =>
    c.json(
      listInbox(
        rt(c),
        c.req.query('tab') === 'other' ? 'other' : 'priority',
        c.req.query('state') === 'done' ? 'done' : undefined,
      ),
    ),
  )

  app.post(routes.connectionCreate.path, async (c) => {
    const r = rt(c)
    const raw = await c.req.json().catch(() => null)
    const body = ConnectionCreate.safeParse(raw)
    if (!body.success) return c.json({ error: 'bad_request' }, 400)
    // `advanced` is an extension the shared schema does not carry yet (see PR, Protocol requests).
    const advIn = (raw as { advanced?: unknown }).advanced
    const adv = advIn === undefined ? { success: true as const, data: [] } : AdvancedFilters.safeParse(advIn)
    if (!adv.success) return c.json({ error: 'bad_advanced_filters' }, 400)
    const input = body.data
    const mod = r.module(input.integration)
    if (!integrationEnabled(r, input.integration)) return c.json({ error: 'integration_disabled' }, 403)
    if (countConns(r) >= MAX_CONNECTIONS) return c.json({ error: 'too_many_connections' }, 409)
    const thread = resolveThread(r, mod.setup, input.thread)
    if (!thread) return c.json({ error: 'unknown_thread' }, 400)
    const known = defaultToggles(mod)
    for (const k of Object.keys(input.filters ?? {}))
      if (!(k in known)) return c.json({ error: `unknown filter: ${k.slice(0, 40)}` }, 400)
    const split = splitFields(mod.setup, input.fields ?? {})
    if (!split.ok) return c.json({ error: split.error }, 400)
    const made = insertConn(r, {
      integration: input.integration,
      name: input.name,
      thread,
      filters: effectiveToggles(mod, input.filters ?? {}),
      advanced: adv.data,
      extra: split.extra,
      creds: split.secrets,
    })
    const done = await provisionOnce(
      r,
      { id: made.id, integration: input.integration },
      mod,
      split.secrets,
      split.extra,
    )
    if (!done.ok) {
      deleteConn(r, made.id)
      return c.json({ error: 'provision_failed', detail: done.error }, 400)
    }
    if (done.forgot.length) {
      const kept = { ...split.secrets }
      for (const k of done.forgot) delete kept[k]
      saveCreds(r, made.id, kept)
      updateConn(r, made.id, { extra: { ...split.extra, [PROVISIONED]: done.forgot.join(',') } })
    }
    const claims = claimsSecret(r, input.integration)
    const out: RouteRes<'connectionCreate'> = {
      ...connectionJson(r, getConn(r, made.id) as ConnRow),
      hook_url: `${r.services.env.PUBLIC_ORIGIN}/hook/${input.integration}/${made.id}`,
      // Apps Script connections get their secret through /claim, so a pasted script never holds it.
      ...(claims ? { claim_code: issueClaim(r, made.id) } : { secret: made.secret }),
    }
    if (mod.poll) pollSoon(r, made.id)
    return c.json(out, 201)
  })

  app.get(routes.connectionGet.path, (c) => {
    const r = rt(c)
    const conn = getConn(r, c.req.param('id'))
    return conn ? c.json(connectionJson(r, conn)) : c.json({ error: 'not_found' }, 404)
  })

  app.patch(routes.connectionPatch.path, async (c) => {
    const r = rt(c)
    const conn = getConn(r, c.req.param('id'))
    if (!conn) return c.json({ error: 'not_found' }, 404)
    const mod = r.module(conn.integration)
    const raw = await c.req.json().catch(() => null)
    const body = routes.connectionPatch.req.safeParse(raw)
    if (!body.success) return c.json({ error: 'bad_request' }, 400)
    const patch: Parameters<typeof updateConn>[2] = {}
    if (body.data.name) patch.name = body.data.name
    if (body.data.thread) {
      if (!knownThreads(r).has(body.data.thread)) return c.json({ error: 'unknown_thread' }, 400)
      patch.thread = body.data.thread
    }
    if (body.data.status) {
      if (body.data.status === 'active' && !integrationEnabled(r, conn.integration))
        return c.json({ error: 'integration_disabled' }, 403)
      patch.status = body.data.status
      patch.paused_reason = null
      if (body.data.status === 'active' && mod.poll) pollSoon(r, conn.id)
    }
    if (body.data.filters) {
      const known = defaultToggles(mod)
      for (const k of Object.keys(body.data.filters))
        if (!(k in known)) return c.json({ error: `unknown filter: ${k.slice(0, 40)}` }, 400)
      patch.filters = { ...effectiveToggles(mod, conn.filters), ...body.data.filters }
    }
    const advIn = (raw as { advanced?: unknown }).advanced
    if (advIn !== undefined) {
      const adv = AdvancedFilters.safeParse(advIn)
      if (!adv.success) return c.json({ error: 'bad_advanced_filters' }, 400)
      patch.advanced = adv.data
    }
    updateConn(r, conn.id, patch)
    return c.json(connectionJson(r, getConn(r, conn.id) as ConnRow))
  })

  app.delete(routes.connectionDelete.path, (c) => {
    const r = rt(c)
    if (!getConn(r, c.req.param('id'))) return c.json({ error: 'not_found' }, 404)
    deleteConn(r, c.req.param('id'))
    return c.body(null, 204)
  })

  app.post(routes.connectionRotate.path, (c) => {
    const r = rt(c)
    const conn = getConn(r, c.req.param('id'))
    if (!conn) return c.json({ error: 'not_found' }, 404)
    const secret = rotateSecret(r, conn.id)
    // The new secret of an Apps Script connection reaches a fresh script through its claim code, not this response.
    if (claimsSecret(r, conn.integration)) return c.json({ secret: '', claim_code: issueClaim(r, conn.id) })
    return c.json({ secret })
  })

  app.get(routes.connectionDeliveries.path, (c) => {
    const r = rt(c)
    const conn = getConn(r, c.req.param('id'))
    if (!conn) return c.json({ error: 'not_found' }, 404)
    const rows = r.services.db
      .prepare('select at, status, reason from hooks_deliveries where conn_id = ? order by id desc limit 20')
      .all(conn.id) as Array<{ at: number; status: number; reason: string | null }>
    return c.json(rows.map((x) => ({ at: r.iso(x.at), status: x.status, ...(x.reason ? { reason: x.reason } : {}) })))
  })

  app.post(routes.connectionCredentials.path, async (c) => {
    const r = rt(c)
    const conn = getConn(r, c.req.param('id'))
    if (!conn) return c.json({ error: 'not_found' }, 404)
    const mod = r.module(conn.integration)
    const body = routes.connectionCredentials.req.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'bad_request' }, 400)
    const split = splitFields(mod.setup, body.data.fields)
    if (!split.ok) return c.json({ ok: false, detail: split.error })
    const creds = { ...credsFor(r, conn.id), ...split.secrets }
    // A re-pasted vendor signing secret: the old value keeps verifying for 24 h (same grace as a rotated secret).
    const vf = moduleExtras(mod).verifySecretField
    const before = vf ? credsFor(r, conn.id)[vf] : undefined
    if (vf && before && split.secrets[vf] && split.secrets[vf] !== before) {
      creds[PREV_SECRET] = before
      creds[PREV_SECRET_UNTIL] = String(r.now() + OLD_SECRET_GRACE_MS)
    }
    const extra = { ...conn.extra, ...split.extra }
    const already = (extra[PROVISIONED] ?? '').split(',').filter(Boolean) // keys the relay used once and then forgot
    const missing = missingRequired(mod.setup, new Set([...Object.keys(creds), ...Object.keys(extra), ...already]))
    if (missing) return c.json({ ok: false, detail: `${missing} is missing` })
    // Linear and Calendly: use the pasted key once to register the webhook with the vendor, then drop it (spec 7.5).
    const done = await provisionOnce(r, conn, mod, split.secrets, extra)
    if (!done.ok) return c.json({ ok: false, detail: `Could not set up the webhook (${done.error}).` })
    for (const k of done.forgot) delete creds[k]
    if (done.forgot.length) extra[PROVISIONED] = [...new Set([...already, ...done.forgot])].join(',')
    saveCreds(r, conn.id, creds)
    updateConn(r, conn.id, { extra, status: conn.status === 'paused' ? 'active' : conn.status, paused_reason: null })
    if (!mod.poll) return c.json({ ok: true })
    pollSoon(r, conn.id)
    const out = await pollConnection(r, getConn(r, conn.id) as ConnRow)
    await idle(r)
    return c.json(
      out.ok ? { ok: true, detail: `Connected. ${out.count} new item(s).` } : { ok: false, detail: out.error },
    )
  })

  app.post(routes.connectionTest.path, async (c) => {
    const r = rt(c)
    const conn = getConn(r, c.req.param('id'))
    if (!conn) return c.json({ error: 'not_found' }, 404)
    const mod = r.module(conn.integration)
    if (!integrationEnabled(r, conn.integration))
      return c.json({ ok: false, detail: 'This integration is switched off.' })
    if (mod.poll) {
      const out = await pollConnection(r, conn)
      await idle(r)
      return c.json(
        out.ok ? { ok: true, detail: `Checked just now. ${out.count} new item(s).` } : { ok: false, detail: out.error },
      )
    }
    const sample = moduleExtras(mod).sample
    if (!sample)
      return c.json({
        ok: false,
        detail: 'This connection cannot send itself a test. Do the thing in the app instead.',
      })
    // A synthesized, correctly signed event through the same pipeline a real one takes.
    const body = new TextEncoder().encode(
      JSON.stringify(
        sample({
          id: conn.id,
          integration: conn.integration,
          thread: conn.thread,
          work: mod.setup.category === 'work',
          extra: conn.extra,
        }),
      ),
    )
    const secret = secretsFor(r, conn.id)[0] as string
    const headers = {
      'content-type': 'application/json',
      ...signStandard({ secret, id: `test_${crypto.randomUUID()}`, timestampS: Math.floor(r.now() / 1000), body }),
    }
    const res = await handleHookRequest(r, {
      integration: conn.integration,
      connId: conn.id,
      method: 'POST',
      headers,
      url: `${r.services.env.PUBLIC_ORIGIN}/hook/${conn.integration}/${conn.id}`,
      ip: 'self',
      declaredLength: body.length,
      readBody: async () => body,
    })
    await idle(r)
    return c.json(res.status === 200 ? { ok: true } : { ok: false, detail: `The test was refused (${res.status}).` })
  })

  return app
}

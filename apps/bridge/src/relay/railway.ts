// The ONLY place the bridge talks to Railway (docs/deploy-railway.md "Keeping the relay up to date", docs/SECURITY.md).
//
// A closed list of GraphQL operations, each an exact string: the queries `relay connect` needs to find out which token this is and
// which service is the relay (read-only), and the one mutation, `serviceInstanceRedeploy`. Nothing here builds a query from input:
// values go in `variables`. test/relay/allowlist.test.ts fails on any other operation in this file, and on any other bridge file
// that names the endpoint or an operation.
//
// The token goes in one header and nowhere else: `Project-Access-Token` for a project token, `Authorization: Bearer` for an
// account or workspace token. The request is made with the guarded fetch (no redirect is followed), 15 s at most, and the answer is
// read up to 256 KB. Errors become one plain line; the line never holds the token and holds Railway's own short message only after
// control characters are taken out and it is cut.
import type { RelayRedeployErrorCodeT } from '@talos-app/protocol'
import { createGuardedFetch, type GuardedFetch } from '@talos-app/protocol/guarded-fetch'

export const RAILWAY_ENDPOINT = 'https://backboard.railway.com/graphql/v2'

export const RAILWAY_OPERATIONS = Object.freeze({
  projectToken: 'query ProjectToken { projectToken { projectId environmentId } }',
  me: 'query Me { me { id } }',
  project:
    'query Project($id: String!) { project(id: $id) { id name environments { edges { node { id name } } } services { edges { node { id name } } } } }',
  service:
    'query Service($id: String!) { service(id: $id) { id name projectId serviceInstances { edges { node { environmentId } } } } }',
  domains:
    'query Domains($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { domain } customDomains { domain } } }',
  serviceInstanceRedeploy:
    'mutation Redeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }',
})
type Operation = keyof typeof RAILWAY_OPERATIONS

export const RAILWAY_TIMEOUT_MS = 15_000
const MAX_BYTES = 256 * 1024
/** Generic on purpose: nothing about the owner or the machine goes out. */
const USER_AGENT = 'talos-app-relay-update'

export type TokenKind = 'project' | 'account'
export type RailwayAuth = { kind: TokenKind; token: string }
const HEADER_NAME: Record<TokenKind, string> = { project: 'Project-Access-Token', account: 'Authorization: Bearer' }
const KIND_WORDS: Record<TokenKind, string> = { project: 'project token', account: 'account or workspace token' }

/** What went wrong, in the one plain line the owner is shown, with the closed code the Mac app's result file uses too. */
export class RailwayError extends Error {
  constructor(
    message: string,
    readonly code: RelayRedeployErrorCodeT,
  ) {
    super(message)
  }
}

/**
 * TESTS ONLY: another address for Railway's API, set from test code. Never read from the environment or a file: the token is sent
 * to this address, so a caller that can set an environment variable (an agent's shell) must not be able to choose it.
 */
export const railwayTestSeam: { url?: string | undefined } = {}

export type RailwayOptions = {
  /** Tests: a stand-in for the guarded fetch. */
  fetch?: GuardedFetch
}

const isLoopbackUrl = (u: string): boolean => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname)
  } catch {
    return false
  }
}

/** A Railway answer's text as one short plain line: no control characters, no token, at most 160 characters. */
export function plainLine(text: string, token?: string): string {
  const stripped = Array.from(text, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('')
  const noToken = token && token.length > 3 ? stripped.split(token).join('[token]') : stripped
  return noToken.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function refusal(kind: TokenKind): RailwayError {
  return new RailwayError(
    `Railway refused the token (sent as ${HEADER_NAME[kind]}). Make a new ${KIND_WORDS[kind]} in Railway (a project token: Project, Settings, Tokens, for the relay's environment), copy it whole, and run talos-app relay connect again.`,
    'not_signed_in',
  )
}
const DOWN = () => new RailwayError("Railway isn't answering. Try again in a few minutes.", 'railway_down')

function fromMessage(message: string, kind: TokenKind, token: string): RailwayError {
  if (/not authori[sz]ed|unauthori[sz]ed|forbidden|invalid token|access denied/i.test(message)) return refusal(kind)
  const line = plainLine(message, token)
  if (/not found|does not exist/i.test(message)) return new RailwayError(`Railway says: ${line}`, 'not_found')
  if (/payment|card|billing|trial|credit|plan/i.test(message))
    return new RailwayError(`Railway says: ${line}`, 'no_card')
  return new RailwayError(`Railway says: ${line}`, 'other')
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new RailwayError("Railway's answer was too big to read.", 'other')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export class Railway {
  private readonly send: GuardedFetch
  private readonly url: string
  constructor(
    private readonly auth: RailwayAuth,
    opts: RailwayOptions = {},
  ) {
    const loopback = railwayTestSeam.url !== undefined && isLoopbackUrl(railwayTestSeam.url)
    this.url = loopback ? (railwayTestSeam.url as string) : RAILWAY_ENDPOINT
    this.send =
      opts.fetch ?? createGuardedFetch({ timeoutMs: RAILWAY_TIMEOUT_MS, ...(loopback ? { allowLoopback: true } : {}) })
  }

  private async call(op: Operation, variables: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const { kind, token } = this.auth
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(kind === 'project' ? { 'project-access-token': token } : { authorization: `Bearer ${token}` }),
    }
    let res: Response
    let text: string
    try {
      res = await this.send(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: RAILWAY_OPERATIONS[op], variables }),
        redirect: 'manual',
        signal: AbortSignal.timeout(RAILWAY_TIMEOUT_MS),
      })
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {})
        throw refusal(kind)
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => {})
        throw DOWN()
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        throw new RailwayError(`Railway answered ${res.status}, which this does not understand.`, 'other')
      }
      text = await readCapped(res)
    } catch (e) {
      if (e instanceof RailwayError) throw e
      throw DOWN() // no network, a timeout, a refused address: the owner's words never include the cause (it can hold the address)
    }
    let body: { data?: unknown; errors?: unknown }
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      throw new RailwayError("Railway's answer could not be read.", 'other')
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const m = (body.errors[0] as { message?: unknown } | null)?.message
      throw fromMessage(typeof m === 'string' ? m : 'an error', kind, token)
    }
    if (typeof body.data !== 'object' || body.data === null)
      throw new RailwayError("Railway's answer had no data.", 'other')
    return body.data as Record<string, unknown>
  }

  /** The project and environment a project token belongs to. */
  async projectToken(): Promise<{ projectId: string; environmentId: string }> {
    const t = (await this.call('projectToken')).projectToken as { projectId?: unknown; environmentId?: unknown } | null
    if (typeof t?.projectId !== 'string' || typeof t.environmentId !== 'string') throw refusal('project')
    return { projectId: t.projectId, environmentId: t.environmentId }
  }

  /** Is this an account or workspace token Railway knows? */
  async me(): Promise<void> {
    const me = (await this.call('me')).me as { id?: unknown } | null
    if (typeof me?.id !== 'string') throw refusal('account')
  }

  async project(id: string): Promise<{
    name: string
    environments: Array<{ id: string; name: string }>
    services: Array<{ id: string; name: string }>
  }> {
    const p = (await this.call('project', { id })).project as {
      name?: unknown
      environments?: { edges?: Array<{ node?: { id?: unknown; name?: unknown } }> }
      services?: { edges?: Array<{ node?: { id?: unknown; name?: unknown } }> }
    } | null
    if (!p) throw new RailwayError("Railway has no such project (or this token can't see it).", 'not_found')
    const list = (e: typeof p.services) =>
      (e?.edges ?? []).flatMap((x) =>
        typeof x.node?.id === 'string' && typeof x.node.name === 'string'
          ? [{ id: x.node.id, name: plainLine(x.node.name) }]
          : [],
      )
    return { name: plainLine(String(p.name ?? '')), environments: list(p.environments), services: list(p.services) }
  }

  async service(id: string): Promise<{ id: string; name: string; projectId: string; environmentIds: string[] }> {
    const s = (await this.call('service', { id })).service as {
      id?: unknown
      name?: unknown
      projectId?: unknown
      serviceInstances?: { edges?: Array<{ node?: { environmentId?: unknown } }> }
    } | null
    if (!s || typeof s.id !== 'string' || typeof s.projectId !== 'string')
      throw new RailwayError("Railway has no such service (or this token can't see it).", 'not_found')
    const environmentIds = (s.serviceInstances?.edges ?? []).flatMap((x) =>
      typeof x.node?.environmentId === 'string' ? [x.node.environmentId] : [],
    )
    return { id: s.id, name: plainLine(String(s.name ?? '')), projectId: s.projectId, environmentIds }
  }

  /** The hostnames a service answers on in an environment (lower case). */
  async domains(projectId: string, environmentId: string, serviceId: string): Promise<string[]> {
    const d = (await this.call('domains', { projectId, environmentId, serviceId })).domains as {
      serviceDomains?: Array<{ domain?: unknown }>
      customDomains?: Array<{ domain?: unknown }>
    } | null
    return [...(d?.serviceDomains ?? []), ...(d?.customDomains ?? [])].flatMap((x) =>
      typeof x.domain === 'string' ? [x.domain.toLowerCase()] : [],
    )
  }

  /** The one mutation: Railway pulls the image tag again and restarts the service. */
  async redeploy(serviceId: string, environmentId: string): Promise<void> {
    const data = await this.call('serviceInstanceRedeploy', { serviceId, environmentId })
    if (!('serviceInstanceRedeploy' in data) || data.serviceInstanceRedeploy === false)
      throw new RailwayError("Railway didn't take the redeploy request.", 'other')
  }
}

export type Identified = { kind: 'project'; projectId: string; environmentId: string } | { kind: 'account' }

/**
 * Which kind of token this is: tried as a project token first (the project header and the read-only token query), else as an
 * account or workspace token (the bearer header and the identity query). A token neither accepts says so naming both headers.
 */
export async function identifyToken(token: string, opts: RailwayOptions = {}): Promise<Identified> {
  try {
    return { kind: 'project', ...(await new Railway({ kind: 'project', token }, opts).projectToken()) }
  } catch (e) {
    if (e instanceof RailwayError && e.code === 'railway_down') throw e
  }
  try {
    await new Railway({ kind: 'account', token }, opts).me()
    return { kind: 'account' }
  } catch (e) {
    if (e instanceof RailwayError && e.code === 'railway_down') throw e
  }
  throw new RailwayError(
    "Railway refused the token. I tried it as a project token (the Project-Access-Token header) and as an account or workspace token (the Authorization: Bearer header), and neither was accepted. Check it was copied whole, then make a new project token in Railway (Project, Settings, Tokens, for the relay's environment) and run talos-app relay connect again.",
    'not_signed_in',
  )
}

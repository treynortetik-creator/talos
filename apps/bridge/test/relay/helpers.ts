// A fake Railway GraphQL server, a fake relay and a fake releases feed, all on loopback; fake tokens only.
import { afterEach } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { runCli } from '../../src/cli.ts'
import { RAILWAY_OPERATIONS, railwayTestSeam } from '../../src/relay/railway.ts'
import { releaseFeedTestSeam } from '../../src/release-feed.ts'
import { tempHome } from '../helpers.ts'

export const FAKE_PROJECT_TOKEN = 'rw_FAKE_project_0123456789abcdef'
export const FAKE_ACCOUNT_TOKEN = 'rw_FAKE_account_0123456789abcdef'
export const PROJECT_ID = '5b1f2c3a-0d4e-4f6a-8b7c-9d0e1f2a3b4c'
export const ENV_ID = '7c2d3e4f-1a5b-4c7d-9e8f-0a1b2c3d4e5f'
export const OTHER_ENV_ID = '8d3e4f5a-2b6c-4d8e-8f9a-1b2c3d4e5f6a'
export const RELAY_SERVICE_ID = '9d3e4f5a-2b6c-4d8e-8f9a-1b2c3d4e5f6a'
export const OTHER_SERVICE_ID = 'ad4f5a6b-3c7d-4e9f-9a0b-2c3d4e5f6a7b'

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
  railwayTestSeam.url = undefined
  releaseFeedTestSeam.url = undefined
})

export type Call = { op: string; variables: Record<string, unknown>; projectHeader?: string; authHeader?: string }

/** What the fake Railway does. `domains` are per service id. */
export function fakeRailway(o: { relayDomain?: string; redeployError?: string; redeployStatus?: number } = {}) {
  const calls: Call[] = []
  const world = {
    calls,
    redeploys: () => calls.filter((c) => c.op === 'serviceInstanceRedeploy'),
    onRedeploy: () => {},
    redeployError: o.redeployError,
    redeployStatus: o.redeployStatus,
    domains: {
      [RELAY_SERVICE_ID]: [o.relayDomain ?? '127.0.0.1'],
      [OTHER_SERVICE_ID]: ['other.example.test'],
    } as Record<string, string[]>,
    url: '',
  }
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { query: string; variables?: Record<string, unknown> }
      // the exact listed text, or the call is flagged: a query that is not on the list never gets an answer
      const op = Object.entries(RAILWAY_OPERATIONS).find(([, q]) => q === body.query)?.[0] ?? `UNLISTED ${body.query}`
      const projectHeader = req.headers.get('project-access-token') ?? undefined
      const authHeader = req.headers.get('authorization') ?? undefined
      const call: Call = {
        op,
        variables: body.variables ?? {},
        ...(projectHeader ? { projectHeader } : {}),
        ...(authHeader ? { authHeader } : {}),
      }
      calls.push(call)
      const isProject = projectHeader === FAKE_PROJECT_TOKEN
      const isAccount = authHeader === `Bearer ${FAKE_ACCOUNT_TOKEN}`
      if (!isProject && !isAccount) return Response.json({ errors: [{ message: 'Not Authorized' }] })
      const gql = (data: unknown) => Response.json({ data })
      switch (op) {
        case 'projectToken':
          return isProject
            ? gql({ projectToken: { projectId: PROJECT_ID, environmentId: ENV_ID } })
            : Response.json({ errors: [{ message: 'Not Authorized' }] })
        case 'me':
          return isAccount ? gql({ me: { id: 'u_fake' } }) : Response.json({ errors: [{ message: 'Not Authorized' }] })
        case 'project':
          return gql({
            project: {
              id: PROJECT_ID,
              name: 'my-project',
              environments: {
                edges: [{ node: { id: ENV_ID, name: 'production' } }, { node: { id: OTHER_ENV_ID, name: 'staging' } }],
              },
              services: {
                edges: [
                  { node: { id: RELAY_SERVICE_ID, name: 'relay' } },
                  { node: { id: OTHER_SERVICE_ID, name: 'worker' } },
                ],
              },
            },
          })
        case 'service':
          return gql({
            service: {
              id: call.variables.id,
              name: call.variables.id === RELAY_SERVICE_ID ? 'relay' : 'worker',
              projectId: PROJECT_ID,
              serviceInstances: { edges: [{ node: { environmentId: ENV_ID } }] },
            },
          })
        case 'domains':
          return gql({
            domains: {
              serviceDomains: (world.domains[String(call.variables.serviceId)] ?? []).map((domain) => ({ domain })),
              customDomains: [],
            },
          })
        case 'serviceInstanceRedeploy':
          if (world.redeployStatus) return new Response('nope', { status: world.redeployStatus })
          if (world.redeployError) return Response.json({ errors: [{ message: world.redeployError }] })
          world.onRedeploy()
          return gql({ serviceInstanceRedeploy: true })
        default:
          return Response.json({ errors: [{ message: `unknown operation ${op}` }] })
      }
    },
  })
  servers.push(srv)
  world.url = `http://127.0.0.1:${srv.port}/graphql/v2`
  return world
}

/** A relay whose /healthz reports `release` (undefined: a build from main). `moveTo` makes the next redeploy take effect after `after` answers. */
export function fakeRelay(release: string | undefined) {
  const w = { release, hits: 0, moveTo: undefined as string | undefined, after: 0, down: 0, url: '' }
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname !== '/healthz') return new Response('no', { status: 404 })
      w.hits++
      if (w.moveTo !== undefined) {
        if (w.after > 0) {
          w.after--
          w.down++
          return new Response('deploying', { status: 503 })
        }
        w.release = w.moveTo
        w.moveTo = undefined
      }
      return Response.json({ ok: true, version: 'abc1234', ...(w.release ? { release: w.release } : {}) })
    },
  })
  servers.push(srv)
  w.url = `http://127.0.0.1:${srv.port}`
  return w
}

const rel = (v: string) => ({ tag_name: `mac-v${v}`, draft: false, prerelease: false })
export function fakeFeed(versions: string[]) {
  const w = { versions, hits: 0, url: '' }
  const srv = Bun.serve({
    port: 0,
    fetch() {
      w.hits++
      return Response.json(w.versions.map(rel))
    },
  })
  servers.push(srv)
  w.url = `http://127.0.0.1:${srv.port}/releases`
  return w
}

export function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  const k = (s: string, a: string) => `${s}\u0000${a}`
  // a keychain-wide store (shared by every Talos home), so the per-home naming of the Railway item is exercised
  return {
    backend: 'secret_service',
    strength: 'file',
    data,
    async get(s, a) {
      return data.get(k(s, a))
    },
    async set(s, a, v) {
      data.set(k(s, a), v)
    },
    async delete(s, a) {
      data.delete(k(s, a))
    },
  }
}

export type World = ReturnType<typeof world>
export function world(
  o: { relayRelease?: string | undefined; feed?: string[]; railway?: Parameters<typeof fakeRailway>[0] } = {},
) {
  const home = tempHome()
  const railway = fakeRailway(o.railway)
  const relay = fakeRelay('relayRelease' in o ? o.relayRelease : '0.1.6')
  const feed = fakeFeed(o.feed ?? ['0.1.6', '0.1.7', '0.1.8'])
  const secrets = memorySecrets()
  const env: Record<string, string> = {
    TALOS_APP_HOME: home,
    TALOS_APP_RELAY_URL: relay.url,
  }
  // the addresses of the fakes go in through the code seams, never the environment
  railwayTestSeam.url = railway.url
  releaseFeedTestSeam.url = feed.url
  return { home, railway, relay, feed, secrets, env }
}

export async function cli(
  w: Pick<World, 'env' | 'secrets'> & Partial<Pick<World, 'railway' | 'feed'>>,
  argv: string[],
  o: {
    terminal?: boolean
    secret?: string
    answers?: string[]
    env?: Record<string, string>
    onSleep?: () => void
    /** The releases list address for this run (default: the world's fake). */
    feedUrl?: string
  } = {},
) {
  if (w.railway) railwayTestSeam.url = w.railway.url
  releaseFeedTestSeam.url = o.feedUrl ?? w.feed?.url ?? releaseFeedTestSeam.url
  const out: string[] = []
  const err: string[] = []
  const answers = [...(o.answers ?? [])]
  const asked: string[] = []
  const sleeps: number[] = []
  const code = await runCli(
    argv,
    {
      isTerminal: o.terminal ?? true,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async (q) => {
        asked.push(q)
        return answers.shift() ?? ''
      },
      readSecret: async (q) => {
        asked.push(q)
        return o.secret ?? ''
      },
      sleep: async (ms) => {
        sleeps.push(ms)
        o.onSleep?.()
      },
      now: () => Date.now(),
    },
    { ...w.env, ...o.env },
    { relay: { secrets: w.secrets } },
  )
  return {
    code,
    out: out.join('\n'),
    err: err.join('\n'),
    all: `${out.join('\n')}\n${err.join('\n')}\n${asked.join('\n')}`,
    asked,
    sleeps,
  }
}

/** Connects the world's home with a project token, through the real command. */
export async function connectProject(w: World) {
  const r = await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
  if (r.code !== 0) throw new Error(`connect failed: ${r.all}`)
}

/** Every file under `dir`, as text (to look for a token). */
export function allFiles(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const s = statSync(p)
      if (s.isDirectory()) walk(p)
      else out.push({ path: p, text: readFileSync(p, 'utf8') })
    }
  }
  walk(dir)
  return out
}

// Default-deny for the guarded URL spaces. Every route a module registers under /api, /bridge, /hook, /media or /.well-known
// must appear in the protocol's route table (`packages/protocol/src/http.ts`, spec 3.8) with the same method and path.
// `buildApp` runs this at boot, so a route added without a table entry (and therefore without a declared auth mode)
// stops the relay from starting instead of shipping open.
import { ROUTE_LIST } from '@talos-app/protocol'
import type { Hono } from 'hono'
import type { AppEnv } from './services.ts'

const GUARDED = /^\/(api|bridge|hook|media|\.well-known)(\/|$)/
const norm = (p: string) => p.replace(/:[A-Za-z_]+/g, ':p')

/** Guarded routes the app registers that the route table does not list, as "METHOD /path". Empty = default-deny holds. */
export function unlistedRoutes(app: Hono<AppEnv>): string[] {
  const listed = new Set(ROUTE_LIST.map((r) => `${r.method} ${norm(r.path)}`))
  const listedPaths = new Set(ROUTE_LIST.map((r) => norm(r.path)))
  const out = new Set<string>()
  for (const r of app.routes) {
    if (!GUARDED.test(r.path) || r.path.includes('*')) continue
    const path = norm(r.path)
    // `app.all` (the hook receiver accepts any method and answers 405 itself) is checked by path only.
    const ok = r.method === 'ALL' ? listedPaths.has(path) : listed.has(`${r.method} ${path}`)
    if (!ok) out.add(`${r.method} ${r.path}`)
  }
  return [...out].sort()
}

export function assertRouteTable(app: Hono<AppEnv>): void {
  const bad = unlistedRoutes(app)
  if (bad.length) throw new Error(`routes missing from the protocol route table (default-deny): ${bad.join(', ')}`)
}

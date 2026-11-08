// Mounts every module's routes. Seam: frozen after WP0 (WP8 may edit).
import { Hono } from 'hono'
import type { HTTPResponseError } from 'hono/types'
import { rateLimit } from './auth/contract.ts'
import { routes as authRoutes } from './auth/index.ts'
import { globalBodyCap } from './core/body-guard.ts'
import { routes as coreRoutes } from './core/index.ts'
import { isClientHangup, recorderOf } from './core/problems.ts'
import { routes as dictateRoutes } from './dictate/index.ts'
import { routes as hookRoutes } from './hooks/index.ts'
import { assertRouteTable } from './route-table.ts'
import type { AppEnv, RelayServices } from './services.ts'
import { routes as v2Routes } from './v2/index.ts'
import { routes as voiceRoutes } from './voice/index.ts'

export function buildApp(services: RelayServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services)
    await next()
  })
  // A blanket request-size cap: routes that take big bodies (media, share, frames, hooks) cap themselves and are skipped.
  app.onError((err, c) => {
    // Today's answer, unchanged: hono's own handler (an HTTPException keeps its response, anything else is a plain 500
    // and a line on stderr). The only addition is telling the Mac, which never changes what the caller sees. A client that
    // hung up mid-request is the exception: a debug line, not a report.
    if ('getResponse' in err) {
      const res = (err as HTTPResponseError).getResponse()
      return c.newResponse(res.body, res)
    }
    if (isClientHangup(err)) {
      services.log.debug({ err: (err as Error).message }, 'client hung up mid-request')
      return c.text('Internal Server Error', 500)
    }
    console.error(err)
    recorderOf(services).record(err)
    return c.text('Internal Server Error', 500)
  })
  app.use('*', globalBodyCap())
  // Signed bridge HTTP is rate limited before any body is read or any signature checked (the WebSocket has its own bucket).
  app.use('/bridge/*', (c, next) =>
    new URL(c.req.url).pathname === '/bridge' ? next() : rateLimit('bridge_http')(c, next),
  )
  app.route('/', coreRoutes)
  app.route('/', authRoutes)
  app.route('/', hookRoutes)
  app.route('/', voiceRoutes)
  app.route('/', dictateRoutes)
  app.route('/', v2Routes) // docs/V2-FEATURES.md V1.4: declared-guard placeholders until WP-V1 / WP-V4 land
  assertRouteTable(app)
  return app
}

export { authRoutes, coreRoutes, hookRoutes, v2Routes, voiceRoutes }

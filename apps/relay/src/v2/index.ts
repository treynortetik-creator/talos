// v2 feature routes (docs/V2-FEATURES.md V1.4) that WP-V0 declares before their owners build them. Every route keeps its
// declared guard, so default-deny holds from day one:
//   - health (WP-V1): the real handlers below;
//   - share (WP-V4): mounted from core/share.ts.
import { Hono } from 'hono'
import { requireCsrf, requireSession } from '../auth/contract.ts'
import { problemRoutes } from '../core/problems.ts'
import { runtimeOf } from '../core/runtime.ts'
import { shareRoutes } from '../core/share.ts'
import type { AppEnv } from '../services.ts'

export const routes = new Hono<AppEnv>()

// WP-V1 (health): GET /api/status (Settings -> Health) and POST /api/health/test (the test button). Relay features, so
// they answer with the Mac offline.
routes.get('/api/status', requireSession, (c) => c.json(runtimeOf(c.get('services')).health.status()))
routes.post('/api/health/test', requireSession, requireCsrf, async (c) => {
  const rt = runtimeOf(c.get('services'))
  // nobody to alert: say so instead of reporting success (the button is the owner's one proof that the path works). A
  // subscription row that no longer opens still counts as somebody: the test must try it and report it as failed.
  let unreadable = 0
  const readable = rt.store.listSubs(() => void unreadable++).length
  if (readable + unreadable === 0 && !rt.push.hasNtfy)
    return c.json({ error: 'no_alert_path', message: 'Nobody to alert: no subscribed device and ntfy off.' }, 409)
  return c.json(await rt.push.sendTest())
})

// WP-V4 (share): the real handlers live in core/share.ts
routes.route('/', shareRoutes)

// Problem reports (docs/ERRORS.md): core/problems.ts
routes.route('/', problemRoutes)

// WP-N0: setup-code sign-in for native shells. A web view cannot do passkeys, so a Mac or iPhone shell signs in with the
// one-time code `talos-app enroll` printed. This route trades a live, unused code for an UNPINNED session (credential_id
// null) and does not burn the code; the page then runs the ordinary device/verify, which burns it, and the owner confirms
// the four words at the Mac. Until the Mac says y the session reaches nothing but the pairing routes (requireSession
// answers 403 device_not_pinned), exactly like a passkey session the Mac has not pinned.
//
// Rules: wrong, used and expired codes count toward the five-failures-burn-all rule (checkCode); a code that already
// registered a passkey is refused; a second call with the same live code deletes the session the first one made; the
// route is rate limited under `auth` and sits behind CSRF + Origin like every /api change; the code is never logged and
// only its hash is ever stored.
import { routes as R } from '@talos-app/protocol'
import { type Context, Hono } from 'hono'
import type { AppEnv } from '../services.ts'
import { implFor, sessionFor } from './impl.ts'
import { authState } from './state.ts'
import { sessionCookie, sessionTtlMs } from './util.ts'

export const enrollSessionRoutes = new Hono<AppEnv>()

const state = (c: Context<AppEnv>) => authState(c.get('services'))

enrollSessionRoutes.post(
  R.enrollSession.path,
  (c, next) => implFor(state(c)).rateLimit('auth')(c, next),
  (c, next) => implFor(state(c)).requireCsrf(c, next),
  async (c) => {
    const st = state(c)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'bad_request' }, 400)
    }
    const b = R.enrollSession.req.safeParse(raw)
    if (!b.success) return c.json({ error: 'bad_request' }, 400)

    const code = st.core.checkCode(b.data.code_auth) // a miss is counted here; the fifth burns every code
    if (!code || code.registeredCredentialId) return c.json({ error: 'code_invalid' }, 410)

    st.core.purge()
    // Rotate like enroll/verify: the session that came with this request (if any) dies.
    const old = sessionFor(st, c)
    if (old) st.core.deleteSession(old.sessionId, 'signed_in_again')
    const token = st.core.createSessionForCode(code.codeId)
    c.header('Set-Cookie', sessionCookie(token, sessionTtlMs(st.services.env) / 1000))
    return c.json({ ok: true })
  },
)

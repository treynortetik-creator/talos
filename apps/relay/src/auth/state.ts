// One AuthState per RelayServices: the core, the rate limiter and the hello guard share a clock and a database.
import type { RelayServices } from '../services.ts'
import { AuthCore } from './core.ts'
import { HelloGuard, RateLimiter } from './limits.ts'

export type AuthState = {
  services: RelayServices
  core: AuthCore
  limiter: RateLimiter
  helloGuard: HelloGuard
}

const states = new WeakMap<RelayServices, AuthState>()

export function authState(services: RelayServices): AuthState {
  let s = states.get(services)
  if (!s) {
    s = {
      services,
      core: new AuthCore(services),
      limiter: new RateLimiter(services.clock, {
        media: [{ capacity: services.env.MEDIA_UPLOADS_PER_HOUR, windowMs: 3600_000 }],
      }),
      helloGuard: new HelloGuard(services.clock),
    }
    states.set(services, s)
  }
  return s
}

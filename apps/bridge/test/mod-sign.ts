// Test helper: what the mod does to its calls (docs/CLAUDE-CODE.md C2.3). The key never travels; hello sends
// HMAC(key, "hello\n" + ts) and each sync HMAC(key, "sync\n" + seq + "\n" + canonical body) in `mod_key`.
import { createHmac } from 'node:crypto'
import { canonicalJson } from '../src/mod/canonical.ts'
import type { ModLink } from '../src/mod/link.ts'

export const mac = (key: string, message: string) => createHmac('sha256', key).update(message).digest('base64url')
export const helloArgs = (key: string, ts: number) => ({ ts, proof: mac(key, `hello\n${ts}`) })
export const signedSync = (key: string, seq: number, body: Record<string, unknown>) => {
  const { mod_key: _ignored, seq: _seq, ...rest } = body
  return { ...rest, seq, mod_key: mac(key, `sync\n${seq}\n${canonicalJson(rest)}`) }
}

/**
 * A ModLink whose `hello(key)` and `sync({ mod_key: key, ... })` take the raw key (a wrong one stays wrong) and send what
 * the real mod would send in its place. Anything that is not a key string (an object, null) goes through untouched.
 */
export function signingLink(link: ModLink, now: () => number): ModLink {
  let seq = 0
  return new Proxy(link, {
    get(target, prop, recv) {
      if (prop === 'hello')
        return (arg: unknown) => {
          const r = target.hello(typeof arg === 'string' ? helloArgs(arg, now()) : arg)
          if (r.ok) seq = 0
          return r
        }
      if (prop === 'sync')
        return (req: unknown) => {
          if (
            typeof req === 'object' &&
            req !== null &&
            !Array.isArray(req) &&
            typeof (req as { mod_key?: unknown }).mod_key === 'string'
          )
            return target.sync(signedSync((req as { mod_key: string }).mod_key, ++seq, req as Record<string, unknown>))
          return target.sync(req)
        }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

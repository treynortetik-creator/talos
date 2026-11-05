// Small helpers shared by the auth module: cookies, client IP, tokens, JSON errors.
import { getConnInfo } from '@hono/node-server/conninfo'
import { b64urlEncode, randomBytes, sha256Hex } from '@talos-app/protocol'
import type { Context } from 'hono'
import { pickClientIp } from '../client-ip.ts'
import type { AppEnv } from '../services.ts'

export const COOKIE_NAME = '__Host-talos_s'
/** How long a sign-in lasts and how long it may sit unused: SESSION_TTL_DAYS and SESSION_IDLE_DAYS (30 and 14 by default). */
export const sessionTtlMs = (env: { SESSION_TTL_DAYS: number }): number => env.SESSION_TTL_DAYS * 24 * 3600_000
export const sessionIdleMs = (env: { SESSION_IDLE_DAYS: number }): number => env.SESSION_IDLE_DAYS * 24 * 3600_000
export const STEPUP_TTL_MS = 120_000
export const CHALLENGE_TTL_MS = 5 * 60_000
export const ENROLL_CODE_MAX_TTL_MS = 10 * 60_000
export const ENROLL_FAILURE_WINDOW_MS = 10 * 60_000
export const ENROLL_FAILURE_LIMIT = 5
export const BRIDGE_NONCE_TTL_MS = 10 * 60_000
export const BRIDGE_PREVIOUS_KEY_MS = 5 * 60_000

export const sha256 = (s: string | Uint8Array): string => sha256Hex(s)

export function newToken(bytes = 32): string {
  return b64urlEncode(randomBytes(bytes))
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export function sessionCookie(token: string, maxAgeS: number): string {
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAgeS}; Path=/; Secure; HttpOnly; SameSite=Strict`
}

export function clearedCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`
}

/** The client address (see `pickClientIp`): X-Real-IP behind a proxy, else the socket peer. */
export function clientIp(c: Context<AppEnv>): string {
  let remote: string | undefined
  try {
    remote = getConnInfo(c).remote.address ?? undefined
  } catch {
    remote = undefined
  }
  return pickClientIp({
    realIp: c.req.header('x-real-ip'),
    xff: c.req.header('x-forwarded-for'),
    remote,
    hops: c.get('services').env.TRUST_PROXY_HOPS,
  })
}

export const relayHost = (publicOrigin: string): string => new URL(publicOrigin).host

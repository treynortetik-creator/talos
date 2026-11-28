// Structured logs without content (spec 5.4) and without who-or-where (item 0.20): callers pass ids, types, counts and
// codes, never message text, hook bodies, tokens, codes or cookies, and never an address, a user agent, a URL or a
// device's details. Every call goes through `sanitize`, the one place that enforces it, so a call site that passes a
// raw value by mistake still prints nothing sensitive:
//  - address keys (`ip`, `clientIP`, `x-forwarded-for`, `remote_addr`, ...) keep a short keyed hash, so an operator can tell
//    two clients apart;
//  - keys that are URLs, paths, user agents, headers, push tokens or device details lose their value (a device count or a
//    flag stays), and secret-named keys (token, code, cookie, password, api key, ...) lose theirs at any depth;
//  - every remaining string (and the message) is scrubbed for addresses, URLs, emails, query strings, user agents, paths
//    and long tokens; bytes print as `[bytes N]`; dates as ISO text;
//  - an Error is reduced to its name, its code, a scrubbed message and its scrubbed cause (no stack).
// A device name written into free text is the call site's job: no pattern can know it.
// The hash key is `RELAY_LOG_HASH_KEY` when set, else derived from DATA_KEY (stable across restarts and instances).
import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { type DestinationStream, type Logger as PinoLogger, pino } from 'pino'
import type { Logger } from '../services.ts'

const SENSITIVE = ['text', 'body', 'token', 'stepup_token', 'cookie', 'authorization', 'sig', 'osig', 'secret', 'code']

const norm = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '')
const words = (k: string): string[] =>
  k
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const ADDRESS_NORM = new Set([
  'xforwardedfor',
  'forwardedfor',
  'xrealip',
  'remoteaddr',
  'remoteaddress',
  'clientaddr',
  'peeraddr',
])
function isAddressKey(k: string): boolean {
  const w = words(k)
  const last = w[w.length - 1] ?? ''
  if (last === 'ip' || last === 'ips' || last === 'addr' || last === 'ipaddress' || last === 'ipaddr') return true
  if (last === 'address' && w[w.length - 2] === 'ip') return true
  return ADDRESS_NORM.has(norm(k))
}

const SECRET_NORM = new Set([
  ...SENSITIVE.map(norm),
  'password',
  'passwd',
  'apikey',
  'session',
  'sessionid',
  'credential',
  'credentials',
])
const secretKey = (k: string): boolean => {
  const n = norm(k)
  return SECRET_NORM.has(n) || /(token|secret|cookie|password|apikey|authorization)$/.test(n)
}

const DROP_EXACT = new Set(
  [
    'ua',
    'useragent',
    'url',
    'uri',
    'href',
    'link',
    'endpoint',
    'path',
    'pathname',
    'route',
    'query',
    'querystring',
    'search',
    'referer',
    'referrer',
    'origin',
    'host',
    'hostname',
    'headers',
    'header',
    'req',
    'request',
    'res',
    'response',
    'os',
    'osversion',
    'osname',
    'platform',
    'model',
    'manufacturer',
    'brand',
    'locale',
    'timezone',
    'tz',
    'carrier',
    'regid',
    'registrationid',
    'fcmtoken',
    'apnstoken',
    'pushtoken',
    'devicetoken',
    'subscription',
    'p256dh',
    'auth',
  ].map(norm),
)
/** `device_name`, `deviceModel`, `device_os`...: a device detail. The opaque `device_id` stays, and so do counts and flags. */
const deviceKey = (k: string): boolean => {
  const n = norm(k)
  return n.startsWith('device') && n !== 'deviceid' && !DROP_EXACT.has(n)
}
const dropKey = (k: string): boolean => {
  const n = norm(k)
  return DROP_EXACT.has(n) || /(useragent|pushtoken|devicetoken|osversion|devicename|devicemodel|endpoint)$/.test(n)
}

const V4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)/g
const DASHED_V4 = /(?<!\d)\d{1,3}(?:-\d{1,3}){3}(?!\d)/g
const V6_CANDIDATE = /[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?/g
const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>)]*/gi
const HOST_PATH_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s"'<>)]*/gi
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const QUERY_RE = /[?&][\w.-]+=[^\s&#]*/g
const UA_RE =
  /\b(?:Mozilla|Dalvik|okhttp|CFNetwork|curl|Safari|Chrome|Firefox|Edg|node-fetch|undici)\/[\w.]+(?:\s*\([^)]*\))?[^\n"]*/gi
const PATH_RE = /(?<![\w:.<])\/(?:[\w.~%+@=-]+\/)+[\w.~%+@=-]*/g
const TOKEN_RE = /(?<![A-Za-z0-9])(?:[0-9a-fA-F]{64,}|[A-Za-z0-9_:-]{100,})(?![A-Za-z0-9])/g

/** IPv6 text inside a string, tolerating a glued prefix (`peer:2001:db8::1`), a zone id, brackets and a trailing colon. */
function scrubV6(s: string): string {
  return s.replace(V6_CANDIDATE, (m) => {
    const body = m.split('%')[0] as string
    if (!/[0-9A-Fa-f]/.test(body) || !body.includes(':')) return m
    // try the run as is, then without one leading or one trailing separator
    const trims: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]
    for (const [a, b] of trims) {
      if (a && !(body.startsWith(':') && !body.startsWith('::'))) continue
      const core = body.slice(a, body.length - b)
      if (b && !/[:.]$/.test(body)) continue
      if (isIP(core) === 6) return `${body.slice(0, a)}[ip]${body.slice(body.length - b)}`
    }
    return m
  })
}

/** Replace addresses, URLs, emails, query strings, user agents, paths and long token-looking runs inside one string. */
export function scrubText(s: string): string {
  return scrubV6(
    s
      .replace(URL_RE, '[url]')
      .replace(HOST_PATH_RE, '[url]')
      .replace(EMAIL_RE, '[email]')
      .replace(QUERY_RE, '[query]')
      .replace(UA_RE, '[ua]'),
  )
    .replace(V4, '[ip]')
    .replace(DASHED_V4, '[ip]')
    .replace(PATH_RE, '[path]')
    .replace(TOKEN_RE, '[token]')
}

/** An error as one scrubbed line (name and message, never the stack): for `console.error` sites. */
export function scrubError(e: unknown): string {
  if (e instanceof Error) return scrubText(`${e.name}: ${e.message}`)
  return typeof e === 'string' ? scrubText(e) : `non-error (${typeof e})`
}

export type LogOptions = { hashKey?: string; destination?: DestinationStream }

/** The key address hashes use: the explicit override, else HMAC(DATA_KEY, fixed label), so it is stable and never the key. */
export function logHashKeyFor(dataKey: string, override: string | undefined): string {
  if (override && override.length > 0) return override
  return createHmac('sha256', dataKey).update('relay-log-hash-v1').digest('hex')
}

function hasher(key: string | undefined): (v: string) => string {
  const k = key && key.length > 0 ? key : randomBytes(32).toString('hex')
  return (v) => `h:${createHmac('sha256', k).update(v).digest('hex').slice(0, 10)}`
}

const MAX_DEPTH = 6
const ERR_CODE = /^[A-Z0-9_]{1,40}$/

function makeSanitizer(hash: (v: string) => string): (value: unknown) => unknown {
  const walk = (v: unknown, depth: number, hashed: boolean): unknown => {
    if (typeof v === 'string') return hashed ? hash(v) : scrubText(v)
    if (v === null || v === undefined || typeof v === 'boolean') return v
    if (typeof v === 'number') return hashed ? hash(String(v)) : v
    if (typeof v === 'bigint') return hashed ? hash(String(v)) : Number(v)
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `[bytes ${v.byteLength}]`
    if (hashed) return Array.isArray(v) ? v.map((x) => walk(x, depth + 1, true)) : '[redacted]'
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'invalid-date' : v.toISOString()
    if (depth >= MAX_DEPTH) return '[deep]'
    if (v instanceof Error) {
      const out: Record<string, unknown> = { name: v.name, message: scrubText(v.message) }
      const code = (v as { code?: unknown }).code
      if (typeof code === 'string' && ERR_CODE.test(code)) out.code = code
      if ('cause' in v && v.cause !== undefined) out.cause = walk(v.cause, depth + 1, false)
      const members = (v as { errors?: unknown }).errors
      if (Array.isArray(members)) out.errors = members.map((x) => walk(x, depth + 1, false))
      return out
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, false))
    if (v instanceof Set) return [...v].map((x) => walk(x, depth + 1, false))
    if (typeof v === 'object') {
      const entries =
        v instanceof Map
          ? [...v.entries()].map(([k, x]) => [String(k), x] as const)
          : Object.entries(v as Record<string, unknown>)
      const out: Record<string, unknown> = {}
      for (const [k, val] of entries) {
        if (isAddressKey(k)) out[k] = val == null ? val : walk(val, depth + 1, true)
        else if (secretKey(k)) out[k] = '[redacted]'
        else if (deviceKey(k) && typeof val !== 'number' && typeof val !== 'boolean') out[k] = '[redacted]'
        else if (dropKey(k)) out[k] = '[redacted]'
        else out[k] = walk(val, depth + 1, false)
      }
      return out
    }
    return '[redacted]'
  }
  return (v) => walk(v, 0, false)
}

export function createLogger(level: string, opts: LogOptions = {}): Logger {
  const sanitize = makeSanitizer(hasher(opts.hashKey))
  const config = {
    level,
    // a belt for the keys the sanitizer already removes; `code` is left to it, so an error's own code (ECONNREFUSED) survives
    redact: { paths: SENSITIVE.filter((k) => k !== 'code').flatMap((k) => [k, `*.${k}`]), censor: '[redacted]' },
    serializers: { err: (e: unknown) => e }, // already reduced by the sanitizer; the default adds a type and an empty stack
    base: undefined,
  }
  const base = (opts.destination ? pino(config, opts.destination) : pino(config)) as PinoLogger<string>
  return wrap(base, sanitize)
}

function wrap(l: PinoLogger<string>, sanitize: (v: unknown) => unknown): Logger {
  const call =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (obj: object | string, msg?: string): void => {
      if (typeof obj === 'string') l[level](scrubText(obj))
      else {
        const clean = (obj instanceof Error ? sanitize({ err: obj }) : sanitize(obj)) as object
        l[level](clean, msg === undefined ? undefined : scrubText(msg))
      }
    }
  return {
    debug: call('debug'),
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
    child: (bindings) => wrap(l.child(sanitize(bindings) as Record<string, unknown>), sanitize),
  }
}

/**
 * Wraps the console methods once, so anything that prints (a dependency's own `console.error(e)`, a default handler) is
 * scrubbed too: strings and errors through `scrubText`, other values through the sanitizer. Returns a function that puts the
 * originals back. Installing twice on one console does nothing the second time.
 */
const installed = new WeakSet<object>()
export function installConsoleScrub(target: Console = console, hashKey?: string): () => void {
  if (installed.has(target)) return () => {}
  installed.add(target)
  const sanitize = makeSanitizer(hasher(hashKey))
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const originals = methods.map((m) => target[m])
  for (const m of methods) {
    const original = target[m].bind(target)
    target[m] = (...args: unknown[]): void =>
      original(
        ...args.map((a) => (typeof a === 'string' ? scrubText(a) : a instanceof Error ? scrubError(a) : sanitize(a))),
      )
  }
  return () => {
    methods.forEach((m, i) => {
      target[m] = originals[i] as never
    })
    installed.delete(target)
  }
}

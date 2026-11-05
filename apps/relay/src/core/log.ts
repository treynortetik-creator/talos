// Structured logs without content (spec 5.4): callers pass ids, types, counts and codes, never message text, hook
// bodies, tokens, codes or cookies. As a second line of defence the logger redacts well-known sensitive keys.
import { type Logger as PinoLogger, pino } from 'pino'
import type { Logger } from '../services.ts'

const SENSITIVE = ['text', 'body', 'token', 'stepup_token', 'cookie', 'authorization', 'sig', 'osig', 'secret', 'code']

export function createLogger(level: string): Logger {
  const base: PinoLogger<string> = pino({
    level,
    redact: { paths: SENSITIVE.flatMap((k) => [k, `*.${k}`]), censor: '[redacted]' },
    base: undefined,
  }) as PinoLogger<string>
  return wrap(base)
}

function wrap(l: PinoLogger<string>): Logger {
  const call =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (obj: object | string, msg?: string): void => {
      if (typeof obj === 'string') l[level](obj)
      else l[level](obj, msg)
    }
  return {
    debug: call('debug'),
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
    child: (bindings) => wrap(l.child(bindings)),
  }
}

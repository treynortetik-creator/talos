import { describe, expect, it } from 'vitest'
import { appCsp } from '../src/index.ts'

describe('appCsp (the page policy shared by the relay and the service worker)', () => {
  it('is the exact policy for an https origin, with a wss connect-src', () => {
    expect(appCsp('https://relay.example.com')).toBe(
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "connect-src 'self' wss://relay.example.com",
        "manifest-src 'self'",
        "worker-src 'self'",
        "frame-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    )
  })

  it('uses ws:// and keeps the port for an http origin', () => {
    expect(appCsp('http://localhost:8080')).toContain("connect-src 'self' ws://localhost:8080;")
  })

  it('refuses an unreadable origin instead of emitting a policy', () => {
    expect(() => appCsp('not an origin')).toThrow()
  })
})

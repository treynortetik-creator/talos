// `talos-app report` / `logs` redaction must catch short secrets by NAME, not only 32+ character blobs.
import { describe, expect, test } from 'bun:test'
import { redact } from '../src/redact.ts'

describe('redact: secret names with a prefix, JSON keys, header names, Basic auth', () => {
  const cases: Array<[string, string]> = [
    ['BOT_TOKEN=abc123short', 'abc123short'],
    ['client_secret=abc123short', 'abc123short'],
    ['{"access_token":"abc123short"}', 'abc123short'],
    ['api_key=abc123short', 'abc123short'],
    ['x-api-key: abc123short', 'abc123short'],
    ['ANTHROPIC_API_KEY=abc123short', 'abc123short'],
    ['db_password = abc123short', 'abc123short'],
    ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['authorization: Bearer abc123short', 'abc123short'],
    ['set-cookie: sid=abc123short', 'abc123short'],
  ]
  for (const [line, secret] of cases) {
    test(line, () => {
      const out = redact(line)
      expect(out).not.toContain(secret)
      expect(out).toContain('[redacted]')
    })
  }

  test('ordinary lines are left alone', () => {
    const line = 'bridge started pid 4242 relay https://relay.example.com ok'
    expect(redact(line)).toBe(line)
  })
})

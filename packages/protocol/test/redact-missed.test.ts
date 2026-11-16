// Bug hunt (Fable, 2026-11-11), MEDIUM: redact() let these through into bug reports and the relay's bug webhook. Each case is
// a secret that must go, beside ordinary text of the same shape that must stay (redaction that eats normal words makes a report
// useless). Example values only.
import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.ts'

const gone = (line: string, ...secrets: string[]) => {
  const out = redact(line)
  for (const s of secrets) expect(out, `${JSON.stringify(line)} -> ${JSON.stringify(out)}`).not.toContain(s)
  expect(out).toContain('[redacted]')
  return out
}
const kept = (line: string) => expect(redact(line)).toBe(line)

describe('secrets redact() used to miss', () => {
  it('a password in a URL, keeping the user and the host', () => {
    const out = gone('fetch https://alex:hunter2pass@example.com/api failed', 'hunter2pass')
    expect(out).toContain('https://alex:[redacted]@example.com/api')
    gone('postgres://app:Sup3r-s3cret!@db.example.com:5432/talos', 'Sup3r-s3cret!')
  })

  it('every cookie in a Cookie header, not only the first', () => {
    gone('Cookie: sid=abc123short; csrf=def456short; theme=dark', 'abc123short', 'def456short')
    gone('cookie: __Host-talos=tok1short;__Host-talos_v=tok2short', 'tok1short', 'tok2short')
  })

  it('the credential after any auth scheme: Token, Digest, a made-up one', () => {
    gone('Authorization: Token abc123short', 'abc123short')
    gone('authorization: Digest username="alex", response="6629fae49393a05397450978507c4ef1"', '6629fae4')
    gone('{"Authorization":"Zapier-Key abc123short"}', 'abc123short')
  })

  it('a password with spaces, quoted or to the end of its line', () => {
    gone('password: "correct horse battery staple"', 'horse', 'battery staple')
    gone('{"db_password":"my secret pass","user":"alex"}', 'secret pass')
    gone('PASSWORD=correct horse battery staple', 'horse battery')
  })

  it('a Zapier hook address (its path is the secret)', () => {
    gone('webhook https://hooks.zapier.com/hooks/catch/1234567/abcdefg/ ok', '1234567/abcdefg')
  })

  it("AWS keys: the access key id, the secret by name, and the secret on the id's line", () => {
    gone('using AKIAIOSFODNN7EXAMPLE for s3', 'AKIAIOSFODNN7EXAMPLE')
    gone('session ASIAY34FZKBOKMUTVV7A', 'ASIAY34FZKBOKMUTVV7A')
    gone('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI')
    gone('AKIAIOSFODNN7EXAMPLE,wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AKIAIOSFODNN7EXAMPLE', 'bPxRfiCY')
  })
})

describe('and ordinary text stays as it is', () => {
  it('words, addresses and paths that only look like the cases above', () => {
    for (const line of [
      'the password field is empty',
      'Token count: 42 of 200k',
      'Authorization header missing on GET /api/me',
      'the cookie banner was dismissed',
      'relay https://relay.example.com:8443/healthz ok',
      'git@example.com:alex/talos-app.git',
      'https://hooks.example.com/catch/this',
      'apps/web/src/features/pages/PagesList.tsx: 12 lines',
      'AKIA is how an AWS access key starts',
    ])
      kept(line)
  })

  it('a 40-character path segment with slashes is left alone when no AWS key id is on the line', () => {
    kept('copied apps/web/src/features/threads/MessageViewXY to the build')
  })
})

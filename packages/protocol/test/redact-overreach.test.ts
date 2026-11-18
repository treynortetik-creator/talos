// What redact() must leave alone (over-redaction makes a report useless) and a few one-line joins it must still catch.
import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.ts'

const kept = (line: string) => expect(redact(line)).toBe(line)

describe('redact leaves ordinary text alone', () => {
  it('a URL password stops at ? and #: an address in the query is not a password', () => {
    kept('see https://localhost:3000?email=a@example.com for the form')
  })
  it('--password does not eat a single-letter flag that follows', () => {
    kept('mysql --password -h db.local -u root')
    expect(redact('mysql --password -hunter2 db')).not.toContain('hunter2')
  })
  it('an AWS key id must stand alone as capitals and digits; glued lower-case letters still hide it', () => {
    kept('ASIAPACIFICREGION2026X is the region tag')
    expect(redact('keyAKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).not.toContain('AKIAIOSFODNN7')
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted]')
  })
})

describe('a URL password that holds ? or #, and a port is not a password', () => {
  it.each([
    ['postgres://app:pa?ss9word@db/x', 'pa?ss9word'],
    ['redis://:pw#Q7wErTy12@cache', 'Q7wErTy12'],
    ['postgres://app:p@ssW0rd9@example.com/app', 'ssW0rd9'],
    ['redis://:Hunter2pass@example.com:6379/0', 'Hunter2pass'],
    ['postgres://app:2024#Q7wErTy12@example.com/app', 'Q7wErTy12'],
    ['postgres://app:1234?Q7wErTy12@example.com/x', 'Q7wErTy12'],
  ])('%s', (line, secret) => {
    expect(redact(line)).not.toContain(secret)
  })
  it('the host and the user stay', () => {
    expect(redact('postgres://app:pa?ss9word@db/x')).toContain('postgres://app:')
    expect(redact('postgres://app:pa?ss9word@db/x')).toContain('@db/x')
  })
  it('a port with a query is not a password', () => {
    kept('see https://localhost:3000?email=a@example.com for the form')
    kept('see https://localhost:3000/x@y for the form')
    kept('see https://example.com:8080/x?u=a@example.com for the form')
  })
})

describe('an AWS secret next to its key id, with a separator around it', () => {
  const SEC = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  const KEY = 'AKIAIOSFODNN7EXAMPLE'
  it.each([`${KEY} ${SEC}=`, `${KEY} ${SEC} =`, `${SEC}:${KEY}`, `${SEC}: ${KEY}`, `${KEY}:${SEC}:us-east-1`])(
    '%s',
    (line) => {
      const out = redact(line)
      expect(out).not.toContain('wJalrXUtnFEMI')
      expect(out).not.toContain('AKIAIOSFODNN7')
    },
  )
  // the next shape on the line is not taken as the pair's value, leaving its own secret behind
  it.each([
    [`${KEY} ${SEC}= Authorization: Basic dXNlcjpwYXNzd29yZA`, 'dXNlcjpwYXNzd29yZA'],
    [`${KEY} ${SEC}: Cookie: sid=Q7wErTy12abc`, 'Q7wErTy12abc'],
    [`${KEY} ${SEC}= password: hunter2horse`, 'hunter2horse'],
    [`${KEY} ${SEC}= curl -u sk_test_Q7wErTy12abc:`, 'Q7wErTy12abc'],
  ])('%s', (line, secret) => {
    const out = redact(line)
    expect(out).not.toContain('wJalrXUtnFEMI')
    expect(out).not.toContain(secret)
  })
})

describe('known limits (the bounds that keep redact linear)', () => {
  // A name longer than 256 characters before the keyword is not read as a secret name, so its value stays. Pinned, so a change
  // to the bound shows up here. The 32+ rule still removes the name itself.
  it('a setting name of more than 256 characters before the keyword leaves its value', () => {
    const out = redact(`${'a'.repeat(300)}token=Q7wErTy12`)
    expect(out).toContain('Q7wErTy12')
  })
  it('a query name of more than 16 dotted groups before sig leaves its value', () => {
    const out = redact(`?${'ab.'.repeat(20)}sig=Q7wErTy12`)
    expect(out).toContain('Q7wErTy12')
  })
})

describe('long names and unclosed quotes', () => {
  it.each([
    'spring.cloud.config.server.git.repos.team-a.properties.override.x.password=Q7wErTy12',
    `APP_${'X'.repeat(70)}_TOKEN=Q7wErTy12`,
    'token="Q7w ErTy12',
    "password='Q7w ErTy12 more",
    '{"token": "Q7w ErTy12',
  ])('%s', (line) => {
    const out = redact(line)
    expect(out).not.toContain('Q7w')
    expect(out).not.toContain('ErTy12')
  })
})

describe('a second secret on the same line as an Authorization header or a Cookie', () => {
  it.each([
    [`Authorization: Basic Zm9vOmJhcg== token="top secret value"`, ['top secret', 'Zm9vOmJhcg']],
    [`Authorization: Basic abc, client_secret: 'Q7w "x" ErTy12'`, ['ErTy12', 'abc,']],
    [`Cookie: sid="Xy7hQ2kPz9"; theme=dark token='a b'`, ['Xy7hQ2kPz9', 'a b']],
    [`Cookie: sid=Xy7hQ2kPz9"stray; x=Ab3dE5fG7h`, ['Xy7hQ2kPz9', 'Ab3dE5fG7h']],
  ])('%s', (line, secrets) => {
    const out = redact(line)
    for (const s of secrets) expect(out).not.toContain(s)
  })
  it('the quote that closes a curl -H header still ends the cookie value', () => {
    expect(redact('curl --header "Cookie: sid=v8shortval" https://example.com')).toContain('https://example.com')
  })
})

// A command line can carry a credential (the always-allow pass record keeps commands): query-string secrets, curl/wget
// credentials, secret-named headers and env prefixes. Example values only.
import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.ts'

const gone = (line: string, ...secrets: string[]) => {
  const out = redact(line)
  for (const s of secrets) expect(out, `${JSON.stringify(line)} -> ${JSON.stringify(out)}`).not.toContain(s)
  expect(out).toContain('[redacted]')
  return out
}
const kept = (line: string) => expect(redact(line)).toBe(line)

describe('query-string secrets', () => {
  it('keeps the name and the rest of the query', () => {
    expect(gone('curl "https://api.example.com/x?key=abc123&x=1"', 'abc123')).toContain('?key=[redacted]&x=1')
  })
  it.each([
    'token',
    'secret',
    'password',
    'passwd',
    'pwd',
    'sig',
    'signature',
    'access_token',
    'api_key',
    'apikey',
    'auth',
    'client_secret',
    'code',
    'session',
    'x-api-key',
    'refresh_token',
    'X-Amz-Credential',
    'X-Amz-Signature',
    'Key',
  ])('%s=', (name) => {
    const out = gone(`https://example.com/p?a=1&${name}=zz9short#frag`, 'zz9short')
    expect(out).toContain('a=1&')
    expect(out).toContain('#frag')
  })
  it('stops at a quote or whitespace', () => {
    const out = gone(`wget 'https://example.com/p?token=zz9short' -O out`, 'zz9short')
    expect(out).toContain("' -O out")
  })
  it('code only counts inside a query', () => {
    kept('the code=5 in prose stays')
    kept('exit code=1')
  })
  it('diagnostic names that only end in code or key stay; real key names go', () => {
    kept('https://example.com/a?error_code=500&status_code=404&sort_key=name')
    gone('https://example.com/a?access_key=zz9short', 'zz9short')
    gone('https://example.com/a?secret_key=zz9short', 'zz9short')
    gone('https://example.com/a?private_key=zz9short', 'zz9short')
    gone('https://example.com/a?api_key=zz9short', 'zz9short')
  })
  it('ordinary queries and commands stay', () => {
    kept('https://example.com/list?page=2&sort=asc')
    kept('git push origin main')
    kept('curl https://example.com/path')
    kept('ls /Users/alex/token-tools/x')
    kept('https://example.com/a?keyboard=us&codec=h264')
  })
})

describe('curl / wget credentials', () => {
  it.each([
    ['curl -u alex:hunter2 https://example.com', '-u alex:[redacted] https'],
    ['curl --user alex:hunter2 https://example.com', '--user alex:[redacted] https'],
    ['curl --user=alex:hunter2 https://example.com', '--user=alex:[redacted] https'],
    ['curl -ualex:hunter2 https://example.com', 'alex:[redacted] https'],
  ])('%s', (line, expected) => {
    expect(gone(line, 'hunter2')).toContain(expected)
  })
  it('a password with a colon in it goes entirely', () => {
    gone('curl -u alex:hun:ter2 https://example.com', 'hun:ter2', 'ter2')
  })
  it('a quoted value is taken whole, spaces and all', () => {
    expect(gone('curl -u "user:pass word" https://example.com', 'pass', 'word')).toContain('-u "user:[redacted]" https')
    expect(gone("wget --user 'user:pass word' https://example.com", 'word')).toContain("--user 'user:[redacted]' https")
  })
  it('an empty user or an empty password: the whole value goes (an API key as the user)', () => {
    gone('curl -u :tok123 https://example.com', 'tok123')
    gone('curl -u key123: https://example.com', 'key123')
    gone('curl --user=key123: https://example.com', 'key123')
    gone('http https://example.com/x -u key123:', 'key123')
  })
  it('only after curl, wget or http in the same command', () => {
    kept('docker run -u 1000:1000 img')
    kept('ls -u foo:bar')
    kept('curl https://example.com; docker run -u 1000:1000 img')
    kept('curl https://example.com | ssh -u 1000:1000 host')
    gone('cd x && sudo curl -s https://example.com -u alex:hunter2', 'hunter2')
    gone('http -u alex:hunter2 https://example.com', 'hunter2')
  })
  it('a separator or an escaped quote inside the quoted value does not end it', () => {
    expect(gone("curl -u 'u:p;w' https://example.com", 'p;w', 'w')).toContain("-u 'u:[redacted]' https")
    expect(gone('curl -u "u:a|b" https://example.com', 'a|b')).toContain('-u "u:[redacted]" https')
    expect(gone('curl -u "u:p\\"q" https://example.com', 'p\\"q', 'q"')).toContain('-u "u:[redacted]" https')
    kept("echo 'a;b' ; docker run -u 1000:1000 img")
  })
  it('a path in front of the tool name still counts', () => {
    expect(gone('/usr/bin/curl -u u:pw1 https://example.com', 'pw1')).toContain('-u u:[redacted]')
    expect(gone('./curl -u u:pw1 https://example.com', 'pw1')).toContain('-u u:[redacted]')
    kept('/usr/bin/docker run -u 1000:1000 img')
  })
  it('a user with no password stays', () => {
    kept('curl -u alex https://example.com')
    kept('curl --user alex https://example.com')
  })
  it.each([
    'wget --password hunter2 https://example.com',
    'wget --password=hunter2 https://example.com',
    'tool --pass hunter2 run',
    'tool --pass=hunter2 run',
    'tool --token hunter2 run',
    'tool --token=hunter2 run',
  ])('%s', (line) => {
    const out = gone(line, 'hunter2')
    expect(out).toMatch(/\[redacted\]/)
    expect(out.startsWith(line.split(' ')[0] as string)).toBe(true)
  })
  it('a --pass flag with no value after it stays', () => {
    kept('tool --passthrough run')
  })
})

describe('secret-named headers', () => {
  it.each([
    `curl -H "X-Api-Key: v8shortval" https://example.com`,
    `curl -H 'Private-Token: v8shortval' https://example.com`,
    `curl --header "Cookie: sid=v8shortval" https://example.com`,
    `curl -H "X-Auth-Token: v8shortval" https://example.com`,
    `curl -H 'X-Client-Secret: v8shortval' https://example.com`,
    `curl --header "X-Api-Key: v8shortval" https://example.com`,
  ])('%s', (line) => {
    const out = gone(line, 'v8shortval')
    expect(out).toContain('https://example.com')
  })
  it('a plain header stays', () => {
    kept(`curl -H "Content-Type: application/json" https://example.com`)
  })
})

describe('env prefixes', () => {
  it.each([
    ['GITHUB_TOKEN=ghp_x1short git push', 'ghp_x1short'],
    ['export GITHUB_TOKEN=ghp_x1short', 'ghp_x1short'],
    ['OPENAI_API_KEY="sk-x1short" node x.js', 'sk-x1short'],
    ["OPENAI_API_KEY='sk-x1short' node x.js", 'sk-x1short'],
    ['AWS_SECRET_ACCESS_KEY=x1short/abc aws s3 ls', 'x1short'],
    ['export DB_PASSWORD=x1short', 'x1short'],
  ])('%s', (line, secret) => {
    gone(line, secret)
  })
  it('keeps the command after the prefix', () => {
    expect(gone('GITHUB_TOKEN=ghp_x1short git push', 'ghp_x1short')).toContain('git push')
  })
})

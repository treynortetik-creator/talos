// The bug report webhook as an owner setting: one address rule for the app and the relay, the patch rules (the passkey step
// every time), devices told only the host, and the report's text redacted before it leaves.
import { describe, expect, it } from 'vitest'
import {
  BugReportBody,
  type BugReportBodyT,
  bugWebhookUrlOk,
  checkConfigPatch,
  redactReport,
  stripDeviceHidden,
} from '../src/index.ts'

describe('bugWebhookUrlOk', () => {
  it('takes a public https address, with a path and a query', () => {
    for (const ok of [
      'https://hooks.example.com/services/T/B/x',
      'https://example.org/hook?k=v',
      'https://93.184.216.34/x',
    ])
      expect(bugWebhookUrlOk(ok), ok).not.toBeNull()
  })
  it('refuses http, credentials, local names and private or special addresses, and junk', () => {
    for (const bad of [
      'http://hooks.example.com/x',
      'https://user:pass@example.com/x',
      'https://localhost/x',
      'https://localhost./x',
      'https://box.local/x',
      'https://svc.internal/x',
      'https://intranet/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest',
      'https://[::1]/x',
      'https://0x7f000001/x',
      'ftp://hooks.example.com/x',
      'not an address',
      '',
    ])
      expect(bugWebhookUrlOk(bad), bad).toBeNull()
  })
})

describe('checkConfigPatch: bug_webhook_url', () => {
  it('a string or null is a plain patch (no passkey since 2026-11-14), flagged so the relay checks the address', () => {
    for (const v of ['https://hooks.example.com/x', null])
      expect(checkConfigPatch({ bug_webhook_url: v })).toEqual({ ok: true, setsBugWebhook: true })
  })
  it('anything else, or a very long string, is refused at that path', () => {
    for (const v of [7, true, { url: 'x' }, ['https://a.example.com'], `https://a.example.com/${'x'.repeat(2100)}`])
      expect(checkConfigPatch({ bug_webhook_url: v })).toEqual({ ok: false, path: 'bug_webhook_url' })
  })
  it('the derived host is never settable', () => {
    expect(checkConfigPatch({ bug_webhook_host: 'evil.example.com' })).toEqual({ ok: false, path: 'bug_webhook_host' })
  })
})

describe('stripDeviceHidden', () => {
  it('drops the address and gives the host; a host a config file claims is replaced', () => {
    const out = stripDeviceHidden({
      rev: 1,
      bug_webhook_url: 'https://hooks.example.com/services/T/B/secret',
      bug_webhook_host: 'claimed.example.com',
    }) as Record<string, unknown>
    expect(out).not.toHaveProperty('bug_webhook_url')
    expect(out.bug_webhook_host).toBe('hooks.example.com')
    expect(JSON.stringify(out)).not.toContain('secret')
    const off = stripDeviceHidden({ rev: 1, bug_webhook_host: 'claimed.example.com' }) as Record<string, unknown>
    expect(off).not.toHaveProperty('bug_webhook_host')
  })
})

describe('the second look of 2026-11-11', () => {
  it('a host label that could be the secret is masked; plain names stay readable', () => {
    const host = (u: string) =>
      (stripDeviceHidden({ rev: 1, bug_webhook_url: u }) as Record<string, unknown>).bug_webhook_host
    expect(host('https://eo1a2b3c4d5e6f7.m.pipedream.net/')).toBe('….m.pipedream.net')
    expect(host('https://abcdefghijklmnopqrst.example.com/x')).toBe('….example.com')
    expect(host('https://hooks.slack.com/services/T/B/x')).toBe('hooks.slack.com')
  })
  it('only the https ports, and names that live only inside a network, are refused', () => {
    for (const ok of ['https://hooks.example.com:443/x', 'https://hooks.example.com:8443/x'])
      expect(bugWebhookUrlOk(ok), ok).not.toBeNull()
    for (const bad of [
      'https://hooks.example.com:6379/x',
      'https://hooks.example.com:25/x',
      'https://1.1.1.1:22/x',
      'https://router.lan/x',
      'https://x.corp/x',
      'https://a.home.arpa/x',
      'https://wiki.intranet/x',
    ])
      expect(bugWebhookUrlOk(bad), bad).toBeNull()
  })
  it('redaction never makes a report too long for its limits', () => {
    const err = `token=${'[redac'.padStart(394, 'x')}` // a cut that landed inside "[redacted]"
    const r = redactReport({
      what_went_wrong: 'x',
      versions: { app: '1', bridge: '1', relay: '1', claude_code: '1' },
      recent_errors: [err.slice(0, 400)],
      logs: 'k=a '.repeat(15_360),
    })
    expect(BugReportBody.safeParse(r).success).toBe(true)
  })
  it('a webhook address in a log or the notes is redacted, and signed-URL values too', () => {
    const out = JSON.stringify(
      redactReport({
        what_went_wrong: 'posted to https://hooks.slack.com/services/T0AAA/B0BBB/abcdefghijklmnopqrstuvwx',
        versions: { app: '1', bridge: '1', relay: '1', claude_code: '1' },
        recent_errors: ['https://discord.com/api/webhooks/123/tok-en_value'],
        logs: 'GET https://bucket.example.com/f?X-Amz-Signature=deadbeef&x=1',
      }),
    )
    for (const leaked of ['abcdefghijklmnopqrstuvwx', 'tok-en_value', 'deadbeef'])
      expect(out, leaked).not.toContain(leaked)
  })
})

describe('redactReport', () => {
  it("runs `talos-app report`'s redaction over every text of the report", () => {
    const token = 'A'.repeat(40)
    const r: BugReportBodyT = {
      what_went_wrong: `it said Bearer ${token}`,
      expected: 'api_key=sk-live-123',
      versions: { app: '1', bridge: '1', relay: '1', claude_code: '1' },
      recent_errors: [`TELEGRAM 123456789:${'b'.repeat(35)}`],
      logs: `password: hunter2\nsetup link /enroll#${'c'.repeat(20)}`,
      messages: [{ role: 'you', text: `secret=${token}` }],
    }
    const out = JSON.stringify(redactReport(r))
    for (const leaked of [token, 'sk-live-123', 'hunter2', 'b'.repeat(35), 'c'.repeat(20)])
      expect(out, leaked).not.toContain(leaked)
    expect(redactReport(r).versions).toEqual(r.versions)
  })
})

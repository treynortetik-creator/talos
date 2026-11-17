// The report is built once: owner words cleaned, messages off by default and at most 5, and the preview is the exact payload.
import { BugReportBody } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { buildReport, cleanWords, NO_MAC_NOTE, previewText, screenOf } from '../../src/features/bugreport/payload.ts'

const base = {
  wentWrong: 'Send did nothing',
  expected: '',
  includeMessages: false,
  versions: { app: '1.0.0', relay: '2.0.0' },
  context: { bridgeVersion: '3.0.0', claudeCode: '4.0.0', recentErrors: ['web: TypeError: x'], logs: 'a\nb' },
  threadId: 'trip',
  screen: 'thread',
  client: 'iphone_app' as const,
  routes: ['home', 'thread', 'memory'],
  messages: [] as Array<{ author: string; text: string }>,
}

describe('buildReport client and routes', () => {
  it('always names the app, and sends the screens visited with the thread part', () => {
    const r = buildReport(base)
    expect(r.client).toBe('iphone_app')
    expect(r.routes).toEqual(['home', 'thread', 'memory'])
    expect(BugReportBody.safeParse(r).success).toBe(true)
  })
  it('leaves the routes out when the thread part is unticked, but still names the app', () => {
    const r = buildReport({ ...base, attach: { thread: false } })
    expect(r.routes).toBeUndefined()
    expect(r.client).toBe('iphone_app')
  })
  it('keeps the newest routes within the limit, each cut to its length', () => {
    const many = Array.from({ length: 14 }, (_, i) => `r${i}`)
    expect(buildReport({ ...base, routes: many }).routes).toEqual(many.slice(-10))
    expect(buildReport({ ...base, routes: ['x'.repeat(90)] }).routes).toEqual(['x'.repeat(60)])
  })
})

describe('buildReport', () => {
  it('fills the four versions, the thread and screen, the errors and the logs, and parses as a BugReportBody', () => {
    const r = buildReport(base)
    expect(BugReportBody.safeParse(r).success).toBe(true)
    expect(r.versions).toEqual({ app: '1.0.0', bridge: '3.0.0', relay: '2.0.0', claude_code: '4.0.0' })
    expect(r.thread_id).toBe('trip')
    expect(r.recent_errors).toEqual(['web: TypeError: x'])
    expect(r.logs).toBe('a\nb')
    expect(r.expected).toBeUndefined()
  })
  it('leaves out each automatic part the owner unticked, and still parses', () => {
    const r = buildReport({ ...base, attach: { versions: false, thread: false, errors: false, logs: false } })
    expect(BugReportBody.safeParse(r).success).toBe(true)
    expect(r.versions).toEqual({ app: 'unknown', bridge: 'unknown', relay: 'unknown', claude_code: 'unknown' })
    expect(r.thread_id).toBeUndefined()
    expect(r.screen).toBeUndefined()
    expect(r.recent_errors).toEqual([])
    expect(r.logs).toBe('')
  })
  it('says in the log field that it went without Mac details when the Mac did not answer', () => {
    const r = buildReport({ ...base, context: null, macMissing: true })
    expect(r.logs).toBe(NO_MAC_NOTE)
    expect(buildReport({ ...base, context: null, macMissing: true, attach: { logs: false } }).logs).toBe(NO_MAC_NOTE)
    expect(r.recent_errors).toEqual([])
    expect(BugReportBody.safeParse(r).success).toBe(true)
  })
  it('says "unknown" for what the Mac did not report, and sends no errors or logs', () => {
    const r = buildReport({ ...base, context: null })
    expect(r.versions.bridge).toBe('unknown')
    expect(r.versions.claude_code).toBe('unknown')
    expect(r.recent_errors).toEqual([])
    expect(r.logs).toBe('')
  })
  it('leaves the thread messages out unless asked, and then sends only the last 5', () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({ author: i % 2 ? 'agent' : 'owner', text: `m${i}` }))
    expect(buildReport({ ...base, messages }).messages).toBeUndefined()
    const r = buildReport({ ...base, messages, includeMessages: true })
    expect(r.messages?.map((m) => m.text)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7'])
    expect(r.messages?.[0]?.role).toBe('agent')
  })
  it('takes keys, tokens and the home folder out of the owner’s words and messages', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
    const r = buildReport({
      ...base,
      wentWrong: `It failed in /home/alex/Projects with Bearer ${token}`,
      includeMessages: true,
      messages: [{ author: 'owner', text: `my key is ${token}` }],
    })
    const all = JSON.stringify(r)
    expect(all).not.toContain(token)
    expect(all).not.toContain('/home/alex')
    expect(r.what_went_wrong).toContain('~/Projects')
  })
  it('cleanWords keeps ordinary sentences', () => {
    expect(cleanWords('Plain words, nothing secret.', 100)).toBe('Plain words, nothing secret.')
  })
})

describe('previewText', () => {
  it('is the exact report as JSON, so what is shown is what is posted', () => {
    const r = buildReport(base)
    const text = previewText(r, { type: 'image/png', bytes: 2048 })
    expect(text.startsWith(JSON.stringify(r, null, 2))).toBe(true)
    expect(text).toContain('image/png, 2 KB')
    expect(previewText(r, null)).toContain('Screenshot: none')
  })
})

describe('screenOf', () => {
  it('names a screen without any id', () => {
    expect(screenOf('/')).toBe('home')
    expect(screenOf('/t/trip')).toBe('thread')
    expect(screenOf('/card/c_123')).toBe('card')
    expect(screenOf('/settings/shortcuts')).toBe('settings/shortcuts')
  })
})

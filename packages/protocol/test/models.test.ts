import { describe, expect, it } from 'vitest'
import {
  AgentConfig,
  bindingFrom,
  Card,
  CardBinding,
  ConnId,
  DeviceId,
  HttpsUrl,
  IntegrationId,
  isBodyEditable,
  MsgId,
  newConnectionId,
  newId,
  newUlid,
  payloadHash,
  SetupSpec,
  ThreadId,
  Ulid,
  validateAgentConfig,
} from '../src/index.ts'
import { loadExample, loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const card = (fixtures['card.create'] as { card: unknown }).card

describe('ids', () => {
  it('generates ids that match their own regex', () => {
    for (let i = 0; i < 100; i++) {
      expect(Ulid.safeParse(newUlid()).success).toBe(true)
      expect(MsgId.safeParse(newId('m')).success).toBe(true)
      expect(ConnId.safeParse(newConnectionId()).success).toBe(true)
    }
    expect(newId('c')).toMatch(/^c_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(newId('md')).toMatch(/^md_/)
  })
  it('ulids sort by creation time', () => {
    const a = newUlid()
    const b = newUlid()
    expect([b, a].sort()[0]).toBe(a)
  })
  it('ThreadId rejects "all" and bad shapes', () => {
    expect(ThreadId.safeParse('general').success).toBe(true)
    for (const bad of ['all', 'General', '1abc', '', 'a'.repeat(33), 'a-b'])
      expect(ThreadId.safeParse(bad).success, bad).toBe(false)
  })
  it('HttpsUrl rejects javascript: and data:', () => {
    expect(HttpsUrl.safeParse('https://example.com/x').success).toBe(true)
    expect(HttpsUrl.safeParse('http://example.com/x').success).toBe(true)
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'JAVASCRIPT:alert(1)'])
      expect(HttpsUrl.safeParse(bad).success, bad).toBe(false)
  })
  it('HttpsUrl rejects whitespace, control characters and smuggled second URLs, and stores the normalized href', () => {
    for (const bad of [
      ' https://x.com',
      'https://x.com ',
      'https://x.com\njavascript:1',
      'https://x.com\t',
      'https://x.com/\u0000',
      'vbscript:1',
      'https://',
      'not a url',
    ]) {
      expect(HttpsUrl.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(HttpsUrl.parse('https://example.com')).toBe('https://example.com/')
    expect(HttpsUrl.parse('HTTPS://Example.com/a b'.replace(' ', '%20'))).toBe('https://example.com/a%20b')
  })
  it('DeviceId / IntegrationId shapes', () => {
    expect(DeviceId.safeParse('d_k3j2h4g5f6d7s2a7q2w3').success).toBe(true)
    expect(DeviceId.safeParse('d_K3j2h4g5f6d7s2a7q2w3').success).toBe(false)
    expect(IntegrationId.options).toHaveLength(18)
  })
})

describe('cards', () => {
  it('fixture card parses and its payload_hash equals payloadHash(bindingFrom(card))', () => {
    const c = Card.parse(card)
    expect(c.payload_hash).toBe(payloadHash(bindingFrom(c)))
    expect(CardBinding.safeParse(bindingFrom(c)).success).toBe(true)
  })
  it('result.ran reads true, false and "unknown"; a value nobody knows reads as unset, not as a bad card', () => {
    const at = '2026-11-02T10:00:00.000Z'
    for (const ran of [true, false, 'unknown'] as const)
      expect(Card.parse({ ...(card as object), result: { ok: false, text: 't', at, ran } }).result?.ran).toBe(ran)
    expect(
      Card.parse({ ...(card as object), result: { ok: false, text: 't', at, ran: 'maybe' } }).result?.ran,
    ).toBeUndefined()
    expect(Card.parse({ ...(card as object), result: { ok: false, text: 't', at } }).result?.ran).toBeUndefined()
  })
  it('the hash changes when anything the owner sees changes', () => {
    const c = Card.parse(card)
    const h = payloadHash(bindingFrom(c))
    for (const edit of [
      { title: 'x' },
      { body: 'x' },
      { warning: 'x' },
      { primary_label: 'Send' },
      { kill_label: 'Kill x' },
      { risk: 'low' as const },
      { payload: { a: 1 } },
      { fields: [{ key: 'k', label: 'K', value: 'v', editable: true, multiline: false }] },
    ]) {
      expect(payloadHash(bindingFrom({ ...c, ...edit })), JSON.stringify(edit)).not.toBe(h)
    }
  })
  it('L3: the hash covers allow_edit, allow_revise, origin and attachment kind (a relay cannot flip them unseen)', () => {
    const att = {
      media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      kind: 'image' as const,
      role: 'attachment' as const,
      mime: 'image/png',
      name: 'a.png',
      size: 1,
      sha256: 'a'.repeat(64),
    }
    const c = Card.parse({ ...(card as object), attachments: [att] })
    const h = payloadHash(bindingFrom(c))
    expect(payloadHash(bindingFrom({ ...c, allow_edit: !c.allow_edit }))).not.toBe(h)
    expect(payloadHash(bindingFrom({ ...c, allow_revise: !c.allow_revise }))).not.toBe(h)
    expect(payloadHash(bindingFrom({ ...c, origin: c.origin === 'chat' ? 'background' : 'chat' }))).not.toBe(h)
    expect(payloadHash(bindingFrom({ ...c, attachments: [{ ...att, kind: 'file' }] }))).not.toBe(h)
    const b = bindingFrom(c)
    expect(b).toMatchObject({ allow_edit: c.allow_edit, allow_revise: c.allow_revise, origin: c.origin })
    expect(b.attachments[0]).toMatchObject({ kind: 'image' })
    expect(CardBinding.safeParse(b).success).toBe(true)
  })
  it('the hash ignores state and other non-rendered fields', () => {
    const c = Card.parse(card)
    expect(payloadHash(bindingFrom({ ...c, state: 'done' }))).toBe(payloadHash(bindingFrom(c)))
  })
  it('hash is stable across key order and explicit undefined', () => {
    const c = Card.parse(card)
    const withUndef = { ...c, summary: undefined, payload: undefined }
    expect(payloadHash(bindingFrom(withUndef))).toBe(payloadHash(bindingFrom(c)))
  })
  it('body is editable iff allow_edit and kind is email, message or publish', () => {
    expect(isBodyEditable({ allow_edit: true, kind: 'email' })).toBe(true)
    expect(isBodyEditable({ allow_edit: true, kind: 'publish' })).toBe(true)
    expect(isBodyEditable({ allow_edit: false, kind: 'email' })).toBe(false)
    expect(isBodyEditable({ allow_edit: true, kind: 'deploy' })).toBe(false)
  })
})

describe('config and examples', () => {
  for (const name of ['default', 'five-threads'] as const) {
    it(`examples/config.${name}.json is a valid, self-consistent AgentConfig`, () => {
      const raw = loadExample(name) as Record<string, unknown>
      const parsed = AgentConfig.parse(raw)
      expect(validateAgentConfig(parsed)).toEqual([])
      // The example files carry every field, so loading adds and drops nothing.
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(raw)
    })
  }
  it('default example: general + inbox, quiet window off, UTC', () => {
    const c = AgentConfig.parse(loadExample('default'))
    expect(c.threads.map((t) => t.id)).toEqual(['general', 'inbox'])
    expect(c.quiet_window).toBeNull()
    expect(c.timezone).toBe('UTC')
  })
  it('five-threads example matches the spec', () => {
    const c = AgentConfig.parse(loadExample('five-threads'))
    expect(c.threads.map((t) => t.name)).toEqual(['Projects', 'Work', 'Errands', 'Reading', 'Inbox'])
    expect(c.quiet_window).toEqual({ start: '22:00', end: '06:00' })
    expect(c.timezone).toBe('Europe/Berlin')
    expect(c.work.thread).toBe('work')
    expect(c.work.ask_note).toBe('Check with your IT team first')
  })
  it('rejects a bad zone, a bad HH:MM and a missing inbox', () => {
    const raw = loadExample('default')
    expect(AgentConfig.safeParse({ ...raw, timezone: 'Nowhere/Land' }).success).toBe(false)
    expect(AgentConfig.safeParse({ ...raw, quiet_window: { start: '25:00', end: '06:00' } }).success).toBe(false)
    const noInbox = AgentConfig.parse({ ...raw, threads: [raw.threads[0]] })
    expect(validateAgentConfig(noInbox)).toContain("threads must contain the system thread 'inbox'")
  })
  it('an old config with the removed mirror setting and per-thread mirror field still loads, and both are stripped', () => {
    const raw = loadExample('default')
    const old = {
      ...raw,
      mirror: { telegram: 'on', telegram_chat_id: '12345' },
      threads: raw.threads.map((t: Record<string, unknown>) => ({ ...t, mirror: false })),
    }
    const r = AgentConfig.safeParse(old)
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data).not.toHaveProperty('mirror')
    for (const t of r.data.threads) expect(t).not.toHaveProperty('mirror')
    expect(JSON.stringify(r.data)).not.toMatch(/mirror|telegram|12345/)
  })
})

describe('SetupSpec', () => {
  it('accepts every connect-step variant', () => {
    const spec = {
      id: 'generic',
      name: 'Any app',
      category: 'personal',
      icon: 'webhook',
      blurb: 'Anything that can send a webhook.',
      default_thread: 'inbox',
      filters: [{ key: 'all', label: 'Everything', default: true }],
      connect: [
        { type: 'text', md: 'hi' },
        { type: 'link', label: 'Open', href_template: '{{HOOK_URL}}' },
        { type: 'copy', label: 'URL', value_template: '{{HOOK_URL}}', secret: false },
        { type: 'field', key: 't', label: 'Token', secret: true },
        { type: 'script', template_id: 'gmail' },
        { type: 'repo_picker' },
      ],
      test_hint: 'Send a test.',
    }
    expect(SetupSpec.safeParse(spec).success).toBe(true)
    expect(SetupSpec.safeParse({ ...spec, blurb: 'x'.repeat(141) }).success).toBe(false)
  })
})

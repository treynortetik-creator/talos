import { describe, expect, it } from 'vitest'
import {
  ACT_QUEUE_MAX_MS,
  type ActBodyT,
  b64urlDecode,
  buildApnsBody,
  buildPushPayload,
  cardNotice,
  checkGrant,
  checkNativeAct,
  clipUtf8,
  composePermissionCard,
  createDeviceKey,
  createPhoneKeys,
  DIRECTION_TYPES,
  frameSchemas,
  GRANT_MAX_LIFETIME_MS,
  grantScopes,
  isFrameFor,
  NATIVE_ACT_FEATURE,
  NativeActWire,
  nativeReplyMessageId,
  openPush,
  permissionCardAllowsPrimary,
  RichContent,
  richContentFor,
  SealEnvelope,
  sealPush,
  shownHash,
  signNativeAct,
  signNativeGrant,
} from '../src/index.ts'

const NOW = Date.parse('2026-11-01T18:00:00.000Z')
const ACT_ID = '01JBF3V7Q8K2M4N6P8R0S2T4V6'
const CARD = 'c_01JBF3V7Q8K2M4N6P8R0S2T4V7'
const HASH = `sha256:${'a'.repeat(64)}`
const SHOWN = `sha256:${'b'.repeat(64)}`

async function setup(over: { ttlMs?: number; scopes?: string[]; nowMs?: number } = {}) {
  const device = await createDeviceKey()
  const phone = await createPhoneKeys()
  const grant = await signNativeGrant({
    deviceId: device.deviceId,
    devicePrivateKey: device.privateKey,
    encPub: phone.encPub,
    actPub: phone.actPub,
    nowMs: over.nowMs ?? NOW,
    ...(over.ttlMs !== undefined ? { ttlMs: over.ttlMs } : {}),
    ...(over.scopes ? { scopes: over.scopes } : {}),
  })
  return { device, phone, grant }
}
async function act(
  s: Awaited<ReturnType<typeof setup>>,
  body: ActBodyT,
  ts = new Date(NOW).toISOString(),
  id = ACT_ID,
) {
  return signNativeAct({
    deviceId: s.device.deviceId,
    id,
    ts,
    grant: s.grant,
    body,
    actPrivateKey: s.phone.act.privateKey,
  })
}

describe('native.grant', () => {
  it('is accepted when the pinned device key signed it', async () => {
    const s = await setup()
    const r = await checkGrant(s.grant, s.device.publicJwk, NOW)
    expect(r.ok).toBe(true)
  })

  it('is refused when another device key is pinned (a second caller cannot reuse the first grant)', async () => {
    const s = await setup()
    const other = await createDeviceKey()
    expect(await checkGrant(s.grant, other.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('is refused when any signed field is changed after signing', async () => {
    const s = await setup()
    const swapped = await createPhoneKeys()
    const forged = { ...s.grant, act_pub: swapped.actPub }
    expect(await checkGrant(forged, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
    const widened = { ...s.grant, scopes: ['reply', 'approve_low', 'everything'] }
    expect(await checkGrant(widened, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('expires, and cannot be signed for longer than 30 days', async () => {
    const short = await setup({ ttlMs: 60_000 })
    expect((await checkGrant(short.grant, short.device.publicJwk, NOW + 30_000)).ok).toBe(true)
    expect(await checkGrant(short.grant, short.device.publicJwk, NOW + 61_000)).toEqual({
      ok: false,
      reason: 'expired',
    })
    const long = await setup({ ttlMs: GRANT_MAX_LIFETIME_MS + 1000 })
    expect(await checkGrant(long.grant, long.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'too_long' })
  })

  it('is refused when it is dated in the future (a phone clock far ahead, or a replayed capture of one)', async () => {
    const s = await setup({ nowMs: NOW + 3_600_000 })
    expect(await checkGrant(s.grant, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'stale' })
  })

  it('degrades on a scope this build does not know instead of failing the grant', async () => {
    const s = await setup({ scopes: ['reply', 'teleport'] })
    const r = await checkGrant(s.grant, s.device.publicJwk, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(grantScopes(r.grant)).toEqual(['reply'])
  })

  it('refuses extra fields and malformed keys', async () => {
    const s = await setup()
    expect((await checkGrant({ ...s.grant, extra: 1 }, s.device.publicJwk, NOW)).ok).toBe(false)
    expect((await checkGrant({ ...s.grant, enc_pub: 'short' }, s.device.publicJwk, NOW)).ok).toBe(false)
    expect((await checkGrant(null, s.device.publicJwk, NOW)).ok).toBe(false)
  })
})

describe('native.act', () => {
  it('accepts a reply and an approve signed by the granted action key', async () => {
    const s = await setup()
    const reply = await act(s, { a: 'reply', thread_id: 'general', text: 'on my way' })
    const r = await checkNativeAct(reply, s.device.publicJwk, NOW)
    expect(r.ok).toBe(true)
    const ok = await act(
      s,
      { a: 'approve', card_id: CARD, payload_hash: HASH, shown: SHOWN },
      new Date(NOW).toISOString(),
      '01JBF3V7Q8K2M4N6P8R0S2T4V8',
    )
    const r2 = await checkNativeAct(ok, s.device.publicJwk, NOW)
    expect(r2.ok && r2.act).toEqual({ a: 'approve', card_id: CARD, payload_hash: HASH, shown: SHOWN })
  })

  it('refuses an action signed by any key the device did not grant', async () => {
    const s = await setup()
    const rogue = await createPhoneKeys()
    const f = await signNativeAct({
      deviceId: s.device.deviceId,
      id: ACT_ID,
      ts: new Date(NOW).toISOString(),
      grant: s.grant,
      body: { a: 'reply', thread_id: 'general', text: 'hi' },
      actPrivateKey: rogue.act.privateKey,
    })
    expect(await checkNativeAct(f, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_act_signature' })
  })

  it("refuses a second device's frame that carries the first device's grant", async () => {
    const a = await setup()
    const b = await setup()
    // B signs with A's grant: the grant names A's device id, so the frame's device id must match it...
    const f = await signNativeAct({
      deviceId: b.device.deviceId,
      id: ACT_ID,
      ts: new Date(NOW).toISOString(),
      grant: a.grant,
      body: { a: 'reply', thread_id: 'general', text: 'hi' },
      actPrivateKey: a.phone.act.privateKey,
    })
    expect(await checkNativeAct(f, b.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await checkNativeAct(f, a.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'grant_mismatch' })
  })

  it('binds every part: a changed body, id or timestamp breaks the signature', async () => {
    const s = await setup()
    const f = await act(s, { a: 'reply', thread_id: 'general', text: 'yes' })
    const bodyChanged = { ...f, body: JSON.stringify({ a: 'reply', thread_id: 'general', text: 'no' }) }
    expect(await checkNativeAct(bodyChanged, s.device.publicJwk, NOW)).toEqual({
      ok: false,
      reason: 'bad_act_signature',
    })
    const idChanged = { ...f, id: '01JBF3V7Q8K2M4N6P8R0S2T4V9' }
    expect(await checkNativeAct(idChanged, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_act_signature' })
    const tsChanged = { ...f, ts: new Date(NOW + 1000).toISOString() }
    expect(await checkNativeAct(tsChanged, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_act_signature' })
  })

  it('refuses a stale action, and one from the future, but allows a retry inside ten minutes', async () => {
    const s = await setup()
    const f = await act(s, { a: 'reply', thread_id: 'general', text: 'hi' })
    expect((await checkNativeAct(f, s.device.publicJwk, NOW + 9 * 60_000)).ok).toBe(true)
    expect(await checkNativeAct(f, s.device.publicJwk, NOW + 11 * 60_000)).toEqual({ ok: false, reason: 'act_stale' })
    // a verifier whose clock is behind the phone's by more than the skew: the grant itself reads as dated in the future
    expect((await checkNativeAct(f, s.device.publicJwk, NOW - 5 * 60_000)).ok).toBe(false)
    const old = await setup({ nowMs: NOW - 3_600_000 })
    const future = await act(
      old,
      { a: 'reply', thread_id: 'general', text: 'hi' },
      new Date(NOW + 5 * 60_000).toISOString(),
    )
    expect(await checkNativeAct(future, old.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'act_future' })
  })

  it('refuses an action when the grant had run out by then', async () => {
    const s = await setup({ ttlMs: 60_000 })
    const f = await act(s, { a: 'reply', thread_id: 'general', text: 'hi' }, new Date(NOW + 2 * 60_000).toISOString())
    expect(await checkNativeAct(f, s.device.publicJwk, NOW + 2 * 60_000)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses an action the grant has no scope for', async () => {
    const s = await setup({ scopes: ['reply'] })
    const f = await act(s, { a: 'approve', card_id: CARD, payload_hash: HASH, shown: SHOWN })
    expect(await checkNativeAct(f, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'scope' })
  })

  it('degrades on an action it does not know, without throwing', async () => {
    const s = await setup()
    const f = await act(s, { a: 'delete_everything' } as unknown as ActBodyT)
    expect(await checkNativeAct(f, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_body' })
  })

  it('refuses a blank reply and a reply past the size limit', async () => {
    const s = await setup()
    const blank = await act(s, { a: 'reply', thread_id: 'general', text: ' \n\t ' })
    expect(await checkNativeAct(blank, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_body' })
    const big = await act(s, { a: 'reply', thread_id: 'general', text: 'x'.repeat(4001) })
    expect(await checkNativeAct(big, s.device.publicJwk, NOW)).toEqual({ ok: false, reason: 'bad_body' })
  })

  it('carries hostile text byte for byte (quotes, newlines, emoji, line separators, a prototype key)', async () => {
    const s = await setup()
    const text = 'say "hi"\n\\   \u{1F600} <script>alert(1)</script> __proto__ \u0000'
    const f = await act(s, { a: 'reply', thread_id: 'general', text })
    const r = await checkNativeAct(JSON.parse(JSON.stringify(f)), s.device.publicJwk, NOW)
    expect(r.ok && r.act.a === 'reply' && r.act.text).toBe(text)
  })

  it('refuses unknown fields on the frame and a DER-length signature', async () => {
    const s = await setup()
    const f = await act(s, { a: 'reply', thread_id: 'general', text: 'hi' })
    expect((await checkNativeAct({ ...f, extra: true }, s.device.publicJwk, NOW)).ok).toBe(false)
    expect((await checkNativeAct({ ...f, asig: 'A'.repeat(90) }, s.device.publicJwk, NOW)).ok).toBe(false)
    expect((await checkNativeAct('nope', s.device.publicJwk, NOW)).ok).toBe(false)
  })

  it('is a relay-to-bridge frame only: an app socket cannot send it', () => {
    expect(isFrameFor('relay_to_bridge', { type: 'native.act' })).toBe(true)
    expect(isFrameFor('app_to_relay', { type: 'native.act' })).toBe(false)
    expect(isFrameFor('relay_to_app', { type: 'native.act' })).toBe(false)
    expect(isFrameFor('bridge_to_relay', { type: 'native.act' })).toBe(false)
    expect(frameSchemas['native.act']).toBe(NativeActWire)
    expect(DIRECTION_TYPES.relay_to_bridge).toContain('native.act')
  })

  it('stores a reply under an id that follows the action, so a retry cannot post twice', () => {
    expect(nativeReplyMessageId(ACT_ID)).toBe(`m_${ACT_ID}`)
  })
})

describe('native.act while the Mac was asleep', () => {
  it('judges freshness at the moment the relay took the tap, so a tap queued for an hour still runs', async () => {
    const s = await setup()
    const f = await act(s, { a: 'reply', thread_id: 'general', text: 'hi' })
    const wake = NOW + 60 * 60_000
    // the same bytes, checked with only the Mac's wake-up clock, are stale (the old, wrong behaviour)
    expect(await checkNativeAct(f, s.device.publicJwk, wake)).toEqual({ ok: false, reason: 'act_stale' })
    const r = await checkNativeAct(f, s.device.publicJwk, wake, { receivedAtMs: NOW + 30_000 })
    expect(r.ok).toBe(true)
  })

  it('still takes a tap whose grant ran out while it waited, because the grant was in force when it was queued', async () => {
    const s = await setup({ ttlMs: 5 * 60_000 })
    const f = await act(s, { a: 'reply', thread_id: 'general', text: 'hi' })
    const wake = NOW + 3 * 3_600_000
    expect((await checkNativeAct(f, s.device.publicJwk, wake)).ok).toBe(false)
    expect((await checkNativeAct(f, s.device.publicJwk, wake, { receivedAtMs: NOW + 60_000 })).ok).toBe(true)
  })

  it('does not let a relay stamp stretch the window: old, future or unreadable stamps and an old signed ts are refused', async () => {
    const s = await setup()
    const f = await act(s, { a: 'reply', thread_id: 'general', text: 'hi' })
    const wake = NOW + ACT_QUEUE_MAX_MS + 60_000
    expect(await checkNativeAct(f, s.device.publicJwk, wake, { receivedAtMs: NOW })).toEqual({
      ok: false,
      reason: 'act_stale',
    })
    expect(await checkNativeAct(f, s.device.publicJwk, NOW, { receivedAtMs: NOW + 10 * 60_000 })).toEqual({
      ok: false,
      reason: 'act_stale',
    })
    expect(await checkNativeAct(f, s.device.publicJwk, NOW, { receivedAtMs: Number.NaN })).toEqual({
      ok: false,
      reason: 'act_stale',
    })
    // signed an hour before the relay says it arrived: a replay, not a tap that waited
    expect(await checkNativeAct(f, s.device.publicJwk, NOW + 3_600_000, { receivedAtMs: NOW + 3_600_000 })).toEqual({
      ok: false,
      reason: 'act_stale',
    })
  })

  it('advertises its feature name so a relay can refuse a tap for a Mac that lacks it', () => {
    expect(NATIVE_ACT_FEATURE).toBe('native_act/1')
  })
})

describe('what a card notification shows, and what Approve is bound to', () => {
  const base = {
    kind: 'generic' as const,
    risk: 'low' as const,
    body_format: 'plain' as const,
    allow_edit: false,
    allow_revise: false,
    title: 'Archive old drafts',
    summary: 'Moves 12 drafts',
    destination: [],
    body: 'Folder: Drafts',
    fields: [{ key: 'n', label: 'Count', value: '12', editable: false, multiline: false }],
    warning: undefined,
    primary_label: 'Archive',
    attachments: [],
    payload: undefined,
  }
  it('is complete for a small decision card and carries every part a person decides on', () => {
    const n = cardNotice(base)
    expect(n.complete).toBe(true)
    for (const part of ['Archive old drafts', 'Moves 12 drafts', 'Folder: Drafts', 'Count: 12', 'Button: Archive'])
      expect(n.text).toContain(part)
  })
  it('changes the hash when ANY shown part changes (destination, body, field, button)', () => {
    const h = shownHash(cardNotice(base).text)
    const variants = [
      { ...base, destination: [{ label: 'To', value: 'ceo@example.com' }] },
      { ...base, body: 'Folder: Inbox' },
      { ...base, fields: [{ ...base.fields[0]!, value: '13' }] },
      { ...base, primary_label: 'Delete' },
      { ...base, title: 'Tidy up' },
    ]
    for (const v of variants) expect(shownHash(cardNotice(v).text)).not.toBe(h)
  })
  it('is never complete for a card that leaves the app, whatever risk the agent gave it', () => {
    for (const kind of ['email', 'message', 'deploy', 'publish', 'purchase', 'schedule', 'app_action'] as const)
      expect(cardNotice({ ...base, kind }).complete, kind).toBe(false)
  })
  it('is never complete for a card that names a destination, whatever kind and risk the agent chose', () => {
    const to = [{ label: 'To', value: 'ceo@example.com' }]
    for (const kind of ['generic', 'decision', 'permission'] as const)
      expect(cardNotice({ ...base, kind, destination: to }).complete, kind).toBe(false)
    // the words are still shown (the owner reads where it goes), only the Approve gate is closed
    expect(cardNotice({ ...base, destination: to }).text).toContain('To: ceo@example.com')
    expect(cardNotice({ ...base, destination: [] }).complete).toBe(true) // the control
  })
  it('is not complete when something would be hidden: an attachment, a payload, or text past the limit', () => {
    expect(cardNotice({ ...base, attachments: [{}] }).complete).toBe(false)
    expect(cardNotice({ ...base, payload: { to: 'x' } }).complete).toBe(false)
    const long = cardNotice({ ...base, body: 'x'.repeat(2000) })
    expect(long.complete).toBe(false)
    expect(new TextEncoder().encode(long.text).length).toBeLessThanOrEqual(1200)
  })
  const permCard = (over: Partial<Parameters<typeof composePermissionCard>[0]> = {}) =>
    composePermissionCard({
      request: {
        request_id: 'abcde',
        tool_name: 'Read',
        description: 'Read a file',
        input_preview: '/home/alex/notes.txt',
      },
      card_id: CARD,
      thread_id: 't_01JBF3V7Q8K2M4N6P8R0S2T4V7',
      now: NOW,
      client_version: '2.1.234',
      ...over,
    })
  it('lets a verified low-risk permission card keep its payload and shows the path', () => {
    const n = cardNotice(permCard())
    expect(n.complete).toBe(true)
    expect(n.text).toContain('/home/alex/notes.txt')
  })
  it('is complete for a permission card even without a state field (the Mac binding has none)', () => {
    const { state: _state, ...binding } = permCard()
    expect(cardNotice(binding).complete).toBe(true)
  })
  const denyOnlyCases: Array<[string, () => ReturnType<typeof permCard>]> = [
    ['old client', () => permCard({ client_version: '2.1.233' })],
    ['no client version', () => permCard({ client_version: undefined })],
    ['repeated prompt', () => permCard({ repeated: true })],
    [
      'hidden part',
      () =>
        permCard({
          request: { request_id: 'abcde', tool_name: 'Read', description: 'Read', input_preview: 'a\u22EFb' },
        }),
    ],
  ]
  it.each(denyOnlyCases)(
    'is never complete for a deny-only permission card (%s), so no Approve is offered',
    (_n, mk) => {
      const c = mk()
      expect(permissionCardAllowsPrimary(c)).toBe(false)
      expect(cardNotice(c).complete).toBe(false)
    },
  )
  it('makes invisible and direction-changing characters visible instead of hiding them', () => {
    const n = cardNotice({ ...base, body: 'safe\u202Egnp.exe\u200B' })
    expect(n.text).not.toMatch(/[\u202e\u200b]/)
    expect(n.text).toContain('[U+202E]')
  })
  it('is exactly the text that ends up sealed, so what is hashed is what is shown', () => {
    const n = cardNotice(base)
    expect(richContentFor({ kind: 'card', text: n.text }).b).toBe(n.text)
  })
})

describe('sealed push text', () => {
  const kind = 'reply'
  async function pair() {
    const phone = await createPhoneKeys()
    return phone
  }

  it('opens with the phone key and carries the text the alert does not', async () => {
    const phone = await pair()
    const content = richContentFor({
      kind: 'reply',
      text: 'The build is green.',
      subtitle: 'Groceries',
      threadId: 'general',
    })
    const env = await sealPush({ encPub: phone.encPub, deviceId: 'd_aaaaaaaaaaaaaaaaaaaa', kind, content })
    expect(JSON.stringify(env)).not.toContain('green')
    const opened = await openPush({
      envelope: env,
      encPrivate: phone.enc.privateKey,
      deviceId: 'd_aaaaaaaaaaaaaaaaaaaa',
      kind,
    })
    expect(opened?.b).toBe('The build is green.')
    expect(opened?.s).toBe('Groceries')
    expect(opened?.t).toBe('general')
  })

  it('does not open with another phone key, a changed kind, card, device or push id', async () => {
    const phone = await pair()
    const other = await pair()
    const dev = 'd_aaaaaaaaaaaaaaaaaaaa'
    const content = richContentFor({
      kind: 'card',
      text: 'Send the invoice',
      card: { id: CARD, risk: 'low', payload_hash: HASH },
    })
    const env = await sealPush({ encPub: phone.encPub, deviceId: dev, kind: 'card', cardId: CARD, content })
    const ok = (e: unknown, o: Partial<{ k: string; c: string; d: string; key: CryptoKey }> = {}) =>
      openPush({
        envelope: e,
        encPrivate: o.key ?? phone.enc.privateKey,
        deviceId: o.d ?? dev,
        kind: o.k ?? 'card',
        cardId: o.c ?? CARD,
      })
    expect(await ok(env)).not.toBeNull()
    expect(await ok(env, { key: other.enc.privateKey })).toBeNull()
    expect(await ok(env, { k: 'reply' })).toBeNull()
    expect(await ok(env, { c: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V9' })).toBeNull()
    expect(await ok(env, { d: 'd_bbbbbbbbbbbbbbbbbbbb' })).toBeNull()
    expect(await ok({ ...env, id: 'A'.repeat(22) })).toBeNull()
    const ct = b64urlDecode(env.ct)
    ct[0] = (ct[0] ?? 0) ^ 1
    expect(await ok({ ...env, ct: Buffer.from(ct).toString('base64url') })).toBeNull()
  })

  it('uses a fresh key and iv for every push', async () => {
    const phone = await pair()
    const content = richContentFor({ kind: 'reply', text: 'same' })
    const a = await sealPush({ encPub: phone.encPub, deviceId: 'd_aaaaaaaaaaaaaaaaaaaa', kind, content })
    const b = await sealPush({ encPub: phone.encPub, deviceId: 'd_aaaaaaaaaaaaaaaaaaaa', kind, content })
    expect(a.epk).not.toBe(b.epk)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('stays inside the APNs size limit for the longest text, in any script, and never splits a character', async () => {
    const phone = await pair()
    for (const text of ['x'.repeat(9000), '\u{1F600}'.repeat(2000), '漢'.repeat(3000), 'a\nb '.repeat(1500)]) {
      const content = richContentFor({ kind: 'reply', text })
      expect(RichContent.safeParse(content).success).toBe(true)
      const env = await sealPush({ encPub: phone.encPub, deviceId: 'd_aaaaaaaaaaaaaaaaaaaa', kind, content })
      const body = { ...buildApnsBody(buildPushPayload({ template: 'reply', thread_id: 'general' }, CFG)), enc: env }
      expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(3800)
      expect(SealEnvelope.safeParse(env).success).toBe(true)
      const opened = await openPush({
        envelope: env,
        encPrivate: phone.enc.privateKey,
        deviceId: 'd_aaaaaaaaaaaaaaaaaaaa',
        kind,
      })
      expect(opened).not.toBeNull()
      expect(opened?.b.includes('�')).toBe(false)
    }
    expect(clipUtf8('\u{1F600}\u{1F600}\u{1F600}', 8)).toBe('\u{1F600}...')
  })

  it('refuses a key that is not a P-256 point', async () => {
    const content = richContentFor({ kind: 'reply', text: 'x' })
    await expect(
      sealPush({ encPub: 'A'.repeat(87), deviceId: 'd_aaaaaaaaaaaaaaaaaaaa', kind, content }),
    ).rejects.toThrow()
  })

  it('leaves the fixed APNs template exactly as it was: no field of the plain alert can hold text', () => {
    const body = buildApnsBody(buildPushPayload({ template: 'reply', thread_id: 'general' }, CFG))
    expect(Object.keys(body.aps).sort()).toEqual(['alert', 'category', 'sound', 'thread-id'].sort())
    expect(body.aps.alert.body).toBe('New reply in General')
  })
})

const CFG = {
  agent: { name: 'Talos' },
  notifications: { show_thread_names: 'fixed_only' as const },
  threads: [{ id: 'general', name: 'General', kind: 'fixed' as const }],
}

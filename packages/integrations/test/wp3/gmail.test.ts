import { NormalizedEvent } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { GMAIL_SCRIPT_TEMPLATE } from '../../src/gmail/apps-script.ts'
import { getIntegration, renderGmailScript } from '../../src/index.ts'
import { newWebhookSecret, verifyStandard } from '../../src/standard-webhooks.ts'
import { makeGas, thread } from './gas-fake.ts'
import { conn, fixture, OTHER_SECRET, raw, SECRET, signedReq, stable } from './helpers.ts'

const gmail = getIntegration('gmail')
const VARS = {
  hookUrl: 'https://relay.example.com/hook/gmail/cn_aaaaaaaaaaaaaaaaaaaaaa',
  claimCode: 'cc_abcdefghijklmnopqrstuv',
}

describe('gmail verifier', () => {
  const body = fixture('gmail/fixtures/batch.json')
  it('is Standard Webhooks: valid, tampered, wrong secret, stale, rotated', async () => {
    const c = { secrets: [SECRET], extra: {} }
    expect((await gmail.verify(signedReq(body), c)).ok).toBe(true)
    expect((await gmail.verify({ ...signedReq(body), rawBody: new TextEncoder().encode(`${body} `) }, c)).ok).toBe(
      false,
    )
    expect((await gmail.verify(signedReq(body, OTHER_SECRET), c)).ok).toBe(false)
    expect((await gmail.verify(signedReq(body, SECRET, { tsS: 5 }), c)).ok).toBe(false)
    expect((await gmail.verify(signedReq(body), { secrets: [OTHER_SECRET, SECRET], extra: {} })).ok).toBe(true)
  })
})

describe('gmail normalizer', () => {
  const batch = fixture('gmail/fixtures/batch.json')
  it('turns the batch fixture into the expected events', async () => {
    const events = await gmail.normalize(raw(batch), conn({ integration: 'gmail', extra: { vips: 'vip@example.com' } }))
    expect(stable(events)).toMatchSnapshot()
    for (const e of events) expect(NormalizedEvent.safeParse(e).success).toBe(true)
  })
  it('drops a javascript: link and still yields the event', async () => {
    const events = await gmail.normalize(raw(batch), conn({ integration: 'gmail' }))
    const receipt = events.find((e) => e.title === 'Your receipt')
    expect(receipt).toBeDefined()
    expect(receipt?.url).toBeUndefined()
  })
  it('notes when the script had to skip mail, once per hour', async () => {
    const body = JSON.stringify({ v: 1, truncated: true, items: [] })
    const [a] = await gmail.normalize(raw(body, {}, Date.parse('2026-10-28T15:01:00Z')), conn())
    const [b] = await gmail.normalize(raw(body, {}, Date.parse('2026-10-28T15:50:00Z')), conn())
    expect(a?.title).toBe('Some mail was skipped')
    expect(a?.dedup_key).toBe(b?.dedup_key)
  })
  it('ignores junk', async () => {
    expect(await gmail.normalize(raw('nope'), conn())).toEqual([])
    expect(await gmail.normalize(raw('{"items":[1,null,{"message_id":5}]}'), conn())).toEqual([])
  })
  it('toggles: primary off keeps only VIP and forwarded mail', async () => {
    const c = conn({
      integration: 'gmail',
      extra: { vips: 'vip@example.com', 'filter:vips': '1', 'filter:primary': '0' },
    })
    const events = await gmail.normalize(raw(batch), c)
    const toggle = (await import('../../src/index.ts')).moduleExtras(gmail).toggle
    const kept = events.filter((e) => toggle?.('primary', false, e, c)).map((e) => e.title)
    expect(kept).toEqual(['Contract draft', 'Fwd: Flight confirmation'])
  })
})

describe('gmail Apps Script template', () => {
  it('renders with the claim code and no live secret', () => {
    const s = renderGmailScript(VARS)
    expect(s).toContain("CLAIM_CODE: 'cc_abcdefghijklmnopqrstuv'")
    expect(s).toContain("HOOK_URL: 'https://relay.example.com/hook/gmail/cn_aaaaaaaaaaaaaaaaaaaaaa'")
    expect(s).not.toContain('whsec_')
    expect(s).not.toContain('{{')
    expect(GMAIL_SCRIPT_TEMPLATE).not.toContain('whsec_')
  })
  it('escapes hostile query and label values into string literals', () => {
    const s = renderGmailScript({ ...VARS, query: "x'; evil(); //", forwardLabel: 'a\nb\\c</script>' })
    expect(s).toContain("QUERY: 'x\\'; evil(); //'")
    expect(s).toContain("FORWARD_LABEL: 'a\\nb\\\\c\\x3C/script>'")
    expect(() => makeGas({ script: s })).not.toThrow()
  })
  it('refuses a bad hook url or claim code', () => {
    expect(() => renderGmailScript({ ...VARS, hookUrl: 'javascript:alert(1)' })).toThrow()
    expect(() => renderGmailScript({ ...VARS, hookUrl: 'nope' })).toThrow()
    expect(() => renderGmailScript({ ...VARS, claimCode: "x'; y" })).toThrow()
  })
})

describe('gmail tick (the rendered script, run in a vm)', () => {
  const script = renderGmailScript(VARS)
  const secret = newWebhookSecret()
  // an installed script past its first run (TALOS_FWD_SENT exists: the first run only records what is labelled)
  const props = () => ({
    TALOS_SECRET: secret,
    TALOS_CURSOR: String(Math.floor(Date.now() / 1000) - 3600),
    TALOS_FWD_SENT: '[]',
  })
  const mainSearches = (g: ReturnType<typeof makeGas>) => g.searches.filter((s) => !s.query.startsWith('label:'))
  const post = (g: ReturnType<typeof makeGas>) => g.fetched.filter((f) => f.url === VARS.hookUrl)

  it('signs exactly the bytes it sends, for a non-ASCII subject', () => {
    const g = makeGas({
      script,
      props: props(),
      main: [thread(1, { subject: 'Réunion à 15 h — 会議 🎉', from: 'Zoë <zoe@example.com>' })],
    })
    g.tick()
    const [p] = post(g)
    expect(p).toBeDefined()
    expect(p?.body).toContain('Réunion à 15 h — 会議 🎉')
    const res = verifyStandard(
      { headers: p?.headers ?? {}, rawBody: p?.payload ?? new Uint8Array(), url: VARS.hookUrl, now: Date.now() },
      { secrets: [secret] },
    )
    expect(res.ok).toBe(true)
    expect(p?.headers['webhook-id']).toMatch(/^gm_/)
  })

  it('pages through 120 threads (4 searches) and sends 3 chunks, then moves the cursor', () => {
    const g = makeGas({ script, props: props(), main: Array.from({ length: 120 }, (_v, i) => thread(i)) })
    const before = g.props.get('TALOS_CURSOR')
    g.tick()
    expect(mainSearches(g).map((s) => s.start)).toEqual([0, 40, 80, 120])
    const sent = post(g).map((p) => JSON.parse(p.body) as { items: unknown[]; truncated: boolean })
    expect(sent.map((s) => s.items.length)).toEqual([50, 50, 20])
    expect(sent.every((s) => s.truncated === false)).toBe(true)
    expect(g.props.get('TALOS_CURSOR')).not.toBe(before)
  })

  it('250 threads: stops at 200 and says truncated', () => {
    const g = makeGas({ script, props: props(), main: Array.from({ length: 250 }, (_v, i) => thread(i)) })
    g.tick()
    expect(mainSearches(g)).toHaveLength(5)
    const sent = post(g).map((p) => JSON.parse(p.body) as { items: unknown[]; truncated: boolean })
    expect(sent.reduce((n, s) => n + s.items.length, 0)).toBe(200)
    expect(sent.every((s) => s.truncated === true)).toBe(true)
  })

  it('a failed chunk leaves the cursor where it was and stops sending', () => {
    const g = makeGas({
      script,
      props: props(),
      main: Array.from({ length: 120 }, (_v, i) => thread(i)),
      status: (n) => (n === 1 ? 500 : 200),
    })
    const before = g.props.get('TALOS_CURSOR')
    g.tick()
    expect(post(g)).toHaveLength(2)
    expect(g.props.get('TALOS_CURSOR')).toBe(before)
  })

  it('a forwarded message goes out in full and flagged', () => {
    const long = 'x'.repeat(5000)
    const g = makeGas({
      script,
      props: props(),
      main: [thread(1, { body: long })],
      forwarded: [thread(2, { subject: 'Fwd: tickets', body: long }, ['Talos/Inbound'])],
    })
    g.tick()
    const items = post(g).flatMap(
      (p) => (JSON.parse(p.body) as { items: Array<{ forwarded: boolean; text: string; subject: string }> }).items,
    )
    const fwd = items.find((i) => i.subject === 'Fwd: tickets')
    const normal = items.find((i) => i.subject === 'Subject 1')
    expect(fwd).toMatchObject({ forwarded: true })
    expect(fwd?.text.length).toBe(4000)
    expect(normal).toMatchObject({ forwarded: false })
    expect(normal?.text.length).toBe(300)
    expect(g.searches.some((s) => s.query.startsWith('label:"Talos/Inbound"'))).toBe(true)
  })

  type Item = { message_id: string; forwarded: boolean; text: string }
  const items = (g: ReturnType<typeof makeGas>) =>
    post(g).flatMap((p) => (JSON.parse(p.body) as { items: Item[] }).items)

  // RELAY-9: the relay keeps the first copy of a message, and the inbox's 300-character preview used to go first
  it('a labelled message also in the inbox goes out once, in full: the label search runs first', () => {
    const t = thread(1, { body: 'y'.repeat(5000) }, ['Talos/Inbound'])
    const g = makeGas({ script, props: props(), main: [t], forwarded: [t] })
    g.tick()
    expect(g.searches[0]?.query.startsWith('label:"Talos/Inbound"')).toBe(true)
    expect(items(g)).toEqual([expect.objectContaining({ message_id: 'm1', forwarded: true })])
    expect(items(g)[0]?.text.length).toBe(4000)
  })

  // RELAY-8: labelling is the owner's act whenever the mail came; the label search had the inbox's cursor and date check
  it('older mail labelled by hand goes out in full, once: the label search has no cursor, and sent ids are remembered', () => {
    const old = thread(7, { date: new Date(Date.now() - 30 * 86_400_000), subject: 'Old receipt' }, ['Talos/Inbound'])
    const g = makeGas({ script, props: props(), main: [], forwarded: [old] })
    g.tick()
    const label = g.searches.find((s) => s.query.startsWith('label:'))
    expect(label?.query).toBe('label:"Talos/Inbound"')
    expect(items(g)).toEqual([expect.objectContaining({ message_id: 'm7', forwarded: true })])
    expect(JSON.parse(g.props.get('TALOS_FWD_SENT') ?? '[]')).toEqual(['m7'])
    // the next run sends nothing more for it
    g.fetched.length = 0
    g.tick()
    expect(post(g)).toHaveLength(0)
    // the inbox search keeps its cursor: an old inbox message is still not sent
    const h = makeGas({ script, props: props(), main: [thread(8, { date: new Date(Date.now() - 30 * 86_400_000) })] })
    h.tick()
    expect(post(h)).toHaveLength(0)
    expect(mainSearches(h)[0]?.query).toMatch(/ after:\d+$/)
  })

  it('a failed post remembers no labelled message as sent, and a long label never reports mail as skipped', () => {
    const g = makeGas({
      script,
      props: props(),
      forwarded: Array.from({ length: 250 }, (_v, i) => thread(i, {}, ['Talos/Inbound'])),
      status: () => 500,
    })
    g.tick()
    expect(g.props.get('TALOS_FWD_SENT')).toBe('[]')
    const ok = makeGas({ script, props: props(), forwarded: Array.from({ length: 250 }, (_v, i) => thread(i)) })
    ok.tick()
    const sent = post(ok).map((p) => JSON.parse(p.body) as { truncated: boolean })
    expect(sent.every((s) => s.truncated === false)).toBe(true)
    // the label reads 2 pages a run (no cursor): its 80 newest conversations
    expect(ok.searches.filter((s) => s.query.startsWith('label:')).map((s) => s.start)).toEqual([0, 40])
    expect(JSON.parse(ok.props.get('TALOS_FWD_SENT') ?? '[]')).toHaveLength(80)
  })

  // Opus review on 924d204f: a labelled message the label search had sent before came back next run as an inbox preview
  it('a labelled message still in the inbox is never previewed on a later run', () => {
    const t = thread(1, {}, ['Talos/Inbound'])
    const g = makeGas({ script, props: props(), main: [t], forwarded: [t] })
    g.tick()
    expect(items(g)).toEqual([expect.objectContaining({ message_id: 'm1', forwarded: true })])
    g.fetched.length = 0
    g.tick()
    expect(post(g)).toHaveLength(0)
  })

  it('the first run records what is labelled and sends none of it; then only newly labelled mail goes', () => {
    const fwd = [thread(1, {}, ['Talos/Inbound']), thread(2, {}, ['Talos/Inbound'])]
    const { TALOS_FWD_SENT: _drop, ...fresh } = props()
    const g = makeGas({ script, props: fresh, main: [...fwd, thread(3)], forwarded: fwd })
    g.tick()
    // the inbox mail goes; the labelled mail is recorded, neither sent in full nor previewed
    expect(items(g).map((i) => i.message_id)).toEqual(['m3'])
    expect(JSON.parse(g.props.get('TALOS_FWD_SENT') ?? '')).toEqual(['m1', 'm2'])
    // nothing labelled at all: the empty record is still kept, so the next run is not a first run again
    const none = makeGas({ script, props: fresh, main: [] })
    none.tick()
    expect(none.props.get('TALOS_FWD_SENT')).toBe('[]')
    // later a new message is labelled: it goes in full
    fwd.unshift(thread(9, { subject: 'Fwd: new' }, ['Talos/Inbound']))
    g.fetched.length = 0
    g.tick()
    // (the inbox's own 2-minute overlap sends m3 again, as before; the relay dedups it)
    expect(
      items(g)
        .filter((i) => i.forwarded)
        .map((i) => i.message_id),
    ).toEqual(['m9'])
    expect(items(g).some((i) => !i.forwarded && ['m1', 'm2', 'm9'].includes(i.message_id))).toBe(false)
  })

  it('a forwarded copy has its own dedup key, so mail labelled after its preview still comes in full', async () => {
    const body = JSON.stringify({
      v: 1,
      account: 'a@example.com',
      items: [
        { message_id: 'abc', from: 'x@example.com', subject: 's', text: 't', date: new Date().toISOString() },
        {
          message_id: 'abc',
          from: 'x@example.com',
          subject: 's',
          text: 't',
          date: new Date().toISOString(),
          forwarded: true,
        },
      ],
    })
    const evs = await gmail.normalize(raw(body), conn())
    expect(evs.map((e) => e.dedup_key)).toEqual(['gmail:abc', 'gmail:fwd:abc'])
  })

  it('claims once on install and stores the secret it is given', () => {
    const g = makeGas({ script, props: { TALOS_CURSOR: '1' }, main: [] })
    g.run('install()')
    expect(g.fetched[0]?.url).toBe(`${VARS.hookUrl}/claim`)
    expect(JSON.parse(g.fetched[0]?.body ?? '{}')).toEqual({ claim_code: VARS.claimCode })
    expect(g.props.get('TALOS_SECRET')).toBe('whsec_x')
  })
})

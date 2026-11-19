import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AgentConfig,
  CHANNEL_KINDS,
  ChannelMeta,
  CONSUMABLE_FRAME_TYPES,
  DIRECTION_TYPES,
  DURABLE_FRAME_TYPES,
  IntegrationId,
  PEER_CHAIN_MAX,
  PEER_DAILY_CAP_DEFAULT,
  PEER_DAILY_CAP_MAX,
  PEER_LABELS,
  PEER_MAX,
  PEER_RETRY_HOURS,
  PEER_TEXT_MAX_BYTES,
  PeerCreate,
  PeerCreated,
  PeerLabel,
  PeerList,
  PeerMessageFrame,
  PeerMessageId,
  PeerName,
  PeerRotated,
  parseFrame,
  parsePeerMessage,
  peerTextBytes,
  routes,
  stripDeviceHidden,
} from '../src/index.ts'

type Vec = { name: string; ok: boolean; reason: string; body?: unknown; body_json?: string }
const vectors = (
  JSON.parse(readFileSync(new URL('../fixtures/peer-message/vectors.json', import.meta.url), 'utf8')) as {
    cases: Vec[]
  }
).cases

describe('peer constants', () => {
  it('are the agreed values', () => {
    expect(PEER_LABELS).toEqual(['TASK', 'RESULT', 'BLOCK'])
    expect(PeerLabel.options).toEqual([...PEER_LABELS])
    expect([
      PEER_TEXT_MAX_BYTES,
      PEER_CHAIN_MAX,
      PEER_DAILY_CAP_DEFAULT,
      PEER_DAILY_CAP_MAX,
      PEER_MAX,
      PEER_RETRY_HOURS,
    ]).toEqual([8192, 6, 50, 500, 8, 24])
  })
  it('PeerName and PeerMessageId patterns', () => {
    for (const ok of ['work', 'a', 'home-2', `a${'b'.repeat(31)}`])
      expect(PeerName.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['', 'Work', '1work', '-a', 'a_b', `a${'b'.repeat(32)}`, 'a b'])
      expect(PeerName.safeParse(bad).success, bad).toBe(false)
    expect(PeerMessageId.safeParse('msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD').success).toBe(true)
    expect(PeerMessageId.safeParse('m_01HZX3K9M2Q4R5T6V7W8Y9ABCD').success).toBe(false)
  })
  it('peerTextBytes counts UTF-8 bytes, not chars', () => {
    expect(peerTextBytes('abc')).toBe(3)
    expect(peerTextBytes('€')).toBe(3)
    expect(peerTextBytes('\u{1F600}')).toBe(4)
  })
})

describe('PeerMessage vectors', () => {
  it('has both accepted and refused cases', () => {
    expect(vectors.filter((v) => v.ok).length).toBeGreaterThan(5)
    expect(vectors.filter((v) => !v.ok).length).toBeGreaterThan(50)
  })
  for (const v of vectors)
    it(`${v.ok ? 'accepts' : 'refuses'}: ${v.name}`, () => {
      expect(parsePeerMessage(v.body_json !== undefined ? JSON.parse(v.body_json) : v.body).success, v.reason).toBe(
        v.ok,
      )
    })
})

describe('peers in config', () => {
  const parse = (extra: Record<string, unknown>) => AgentConfig.parse({ ...defaultConfig, ...extra })
  it('defaults to none, and a peer gets the default cap', () => {
    expect(parse({}).peers).toEqual([])
    const p = parse({ peers: [{ name: 'work', url: 'https://relay.example.com/hook/peer/cn_x' }] }).peers
    expect(p).toHaveLength(1)
    expect(p[0]?.daily_cap).toBe(PEER_DAILY_CAP_DEFAULT)
  })
  it('a bad entry is dropped, the good ones and the whole config survive', () => {
    const cfg = parse({
      peers: [
        { name: 'work', url: 'https://relay.example.com/a' },
        { name: 'Bad Name', url: 'https://relay.example.com/b' },
        { name: 'ftp', url: 'ftp://relay.example.com/c' },
        { name: 'big', url: 'https://relay.example.com/d', daily_cap: 501 },
        'nonsense',
        null,
      ],
    })
    expect(cfg.peers.map((p) => p.name)).toEqual(['work'])
    expect(parse({ peers: 'nope' }).peers).toEqual([])
    expect(parse({ peers: { name: 'x' } }).peers).toEqual([])
  })
  it('names are unique: the first of a duplicate wins', () => {
    const cfg = parse({
      peers: [
        { name: 'work', url: 'https://relay.example.com/a' },
        { name: 'work', url: 'https://relay.example.com/b' },
      ],
    })
    expect(cfg.peers).toHaveLength(1)
    expect(cfg.peers[0]?.url).toBe('https://relay.example.com/a')
  })
  it('at most PEER_MAX peers are kept', () => {
    const many = Array.from({ length: PEER_MAX + 3 }, (_, i) => ({ name: `p${i}`, url: 'https://relay.example.com/x' }))
    expect(parse({ peers: many }).peers).toHaveLength(PEER_MAX)
  })
  it('a peer URL must be https', () => {
    const cfg = parse({
      peers: [
        { name: 'plain', url: 'http://relay.example.com/a' },
        { name: 'secure', url: 'https://relay.example.com/b' },
      ],
    })
    expect(cfg.peers.map((p) => p.name)).toEqual(['secure'])
  })
  it('a reserved name is dropped from config', () => {
    expect(parse({ peers: [{ name: 'owner', url: 'https://relay.example.com/a' }] }).peers).toEqual([])
  })
  it('the name of a dropped entry stays taken: a later entry cannot take it over', () => {
    const cfg = parse({
      peers: [
        { name: 'work', url: 'ftp://bad.example.com/a' },
        { name: 'work', url: 'https://relay.example.com/b' },
        { name: 'other', url: 'https://relay.example.com/c' },
      ],
    })
    expect(cfg.peers.map((p) => p.name)).toEqual(['other'])
  })
  it('stripDeviceHidden removes peers (the URL may carry a token)', () => {
    const out = stripDeviceHidden({
      rev: 1,
      peers: [{ name: 'work', url: 'https://relay.example.com/t0k3n' }],
    }) as Record<string, unknown>
    expect(out).not.toHaveProperty('peers')
    expect(JSON.stringify(out)).not.toContain('t0k3n')
  })
})

describe('peer ids and notification kind', () => {
  it('IntegrationId accepts peer', () => {
    expect(IntegrationId.safeParse('peer').success).toBe(true)
  })
  it('peer_message is a channel kind with its meta fields', () => {
    expect(CHANNEL_KINDS).toContain('peer_message')
    const meta = {
      chat_id: 'general',
      thread_id: 'general',
      thread_name: 'General',
      message_id: 'm_x',
      ts: '2026-11-18T10:00:00.000Z',
      kind: 'peer_message',
      trust: 'external',
      peer: 'work',
      label: 'TASK',
      peer_msg_id: 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD',
      in_reply_to: 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCE',
      chain: '1',
      from_peer_task: 'false',
    }
    expect(ChannelMeta.safeParse(meta).success).toBe(true)
    expect(ChannelMeta.safeParse({ ...meta, label: 'task' }).success).toBe(false)
    expect(ChannelMeta.safeParse({ ...meta, from_peer_task: 'yes' }).success).toBe(false)
    expect(ChannelMeta.safeParse({ ...meta, chain: 1 }).success).toBe(false)
    // peer_message is always external and names its peer; the peer keys mean nothing on another kind
    expect(ChannelMeta.safeParse({ ...meta, trust: 'owner' }).success).toBe(false)
    expect(ChannelMeta.safeParse({ ...meta, trust: 'agent' }).success).toBe(false)
    for (const k of ['peer', 'peer_msg_id', 'chain'] as const) {
      const { [k]: _gone, ...without } = meta
      expect(ChannelMeta.safeParse(without).success, k).toBe(false)
    }
    expect(ChannelMeta.safeParse({ ...meta, kind: 'text' }).success).toBe(false)
    expect(
      ChannelMeta.safeParse({
        ...meta,
        kind: 'text',
        trust: 'owner',
        peer: undefined,
        label: undefined,
        peer_msg_id: undefined,
        in_reply_to: undefined,
        chain: undefined,
        from_peer_task: undefined,
      }).success,
    ).toBe(true)
    expect(ChannelMeta.safeParse({ ...meta, kind: 'text', trust: 'owner', peer: 'work' }).success).toBe(false)
  })
})

describe('the peer setup routes (the Mac to its own relay)', () => {
  const conn = 'cn_8fK2aBcDeFgHiJkLmNoPqR'
  it('are bridge-signed and have the documented paths', () => {
    expect(routes.peerCreate).toMatchObject({ method: 'POST', path: '/bridge/peers', auth: 'bridge-sig' })
    expect(routes.peersList).toMatchObject({ method: 'GET', path: '/bridge/peers', auth: 'bridge-sig' })
    expect(routes.peerDelete).toMatchObject({ method: 'DELETE', path: '/bridge/peers/:name', auth: 'bridge-sig' })
    expect(routes.peerRotate).toMatchObject({ method: 'POST', path: '/bridge/peers/:name/rotate', auth: 'bridge-sig' })
  })
  it('PeerCreate: a name, an optional daily cap from 1 to the maximum, nothing else', () => {
    expect(PeerCreate.safeParse({ name: 'work' }).success).toBe(true)
    expect(PeerCreate.safeParse({ name: 'work', daily_cap: 1 }).success).toBe(true)
    expect(PeerCreate.safeParse({ name: 'work', daily_cap: PEER_DAILY_CAP_MAX }).success).toBe(true)
    for (const bad of [
      { name: 'work', daily_cap: 0 },
      { name: 'work', daily_cap: PEER_DAILY_CAP_MAX + 1 },
      { name: 'work', daily_cap: 2.5 },
      { name: 'owner' },
      { name: 'work', url: 'https://example.com' },
      {},
    ])
      expect(PeerCreate.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
  it('PeerCreated: the connection, the url and the secret; PeerList carries no secret field at all', () => {
    const ok = { conn_id: conn, inbox_url: `https://relay.example.com/hook/peer/${conn}`, secret: 'whsec_x' }
    expect(PeerCreated.safeParse(ok).success).toBe(true)
    expect(PeerCreated.safeParse({ ...ok, inbox_url: 'ftp://relay.example.com/x' }).success).toBe(false)
    const row = {
      conn_id: conn,
      name: 'work',
      daily_cap: 50,
      created_at: '2026-11-18T12:00:00.000Z',
      received_today: 0,
    }
    expect(PeerList.safeParse([row]).success).toBe(true)
    expect(PeerList.safeParse([{ ...row, secret: 'whsec_x' }]).success).toBe(false)
    expect(PeerRotated.safeParse({ secret: 'whsec_x' }).success).toBe(true)
  })
})

describe('the peer.message frame', () => {
  const msg = {
    v: 1,
    id: 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD',
    from: 'home',
    text: 'hello',
    chain: 0,
    from_peer_task: false,
    sent_at: '2026-11-18T10:00:00.000Z',
  }
  const frame = {
    v: 1,
    type: 'peer.message',
    id: '01JBF3V7Q8K2M4N6P8R0S2T4AA',
    ts: '2026-11-18T10:00:01.000Z',
    conn_id: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
    peer: 'work',
    msg,
    received_at: '2026-11-18T10:00:01.000Z',
  }
  it('is relay -> bridge only, durable and consumable', () => {
    expect(DIRECTION_TYPES.relay_to_bridge).toContain('peer.message')
    expect(DIRECTION_TYPES.relay_to_app).not.toContain('peer.message')
    expect(DIRECTION_TYPES.app_to_relay).not.toContain('peer.message')
    expect(DIRECTION_TYPES.bridge_to_relay).not.toContain('peer.message')
    expect(DURABLE_FRAME_TYPES).toContain('peer.message')
    expect(CONSUMABLE_FRAME_TYPES).toContain('peer.message')
  })
  it('parses, and carries the message as a PeerMessage', () => {
    expect(PeerMessageFrame.safeParse(frame).success).toBe(true)
    expect(parseFrame(frame, { direction: 'relay_to_bridge' }).ok).toBe(true)
    expect(parseFrame(frame, { direction: 'relay_to_app' }).ok).toBe(false)
  })
  it('refuses a message that is not a PeerMessage, a reserved connection name and a missing connection', () => {
    expect(PeerMessageFrame.safeParse({ ...frame, msg: { ...msg, text: 'a\u202eb' } }).success).toBe(false)
    expect(PeerMessageFrame.safeParse({ ...frame, msg: { ...msg, extra: 1 } }).success).toBe(false)
    expect(PeerMessageFrame.safeParse({ ...frame, peer: 'owner' }).success).toBe(false)
    const { conn_id: _c, ...noConn } = frame
    expect(PeerMessageFrame.safeParse(noConn).success).toBe(false)
  })
})

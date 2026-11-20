import { describe, expect, it } from 'vitest'
import {
  checkPeerInboxUrl,
  formatPeerLinkCode,
  isPeerSecret,
  PeerLinkRedeem,
  parsePeerLinkCode,
  peerInboxUrl,
} from '../src/index.ts'

const CONN = 'cn_abcdefghijklmnopqrstuv'
const AT = String.fromCharCode(64) // userinfo separator, kept out of the source text
const TOKEN = 'A'.repeat(43)
const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`

describe('link code', () => {
  it('formats and parses', () => {
    const code = formatPeerLinkCode('https://relay.example.com', CONN, TOKEN)
    expect(code).toBe(`talos-link:relay.example.com/${CONN}/${TOKEN}`)
    expect(parsePeerLinkCode(code as string)).toEqual({
      ok: true,
      value: { host: 'relay.example.com', conn_id: CONN, token: TOKEN },
    })
    expect(parsePeerLinkCode(`  ${code}\n`).ok).toBe(true)
    expect(parsePeerLinkCode(`talos-link:relay.example.com:443/${CONN}/${TOKEN}`).ok).toBe(true)
  })
  it('refuses an origin that cannot make a code', () => {
    for (const o of [
      'http://relay.example.com',
      'https://relay.example.com:8443',
      'https://127.0.0.1',
      'https://localhost',
    ])
      expect(formatPeerLinkCode(o, CONN, TOKEN), o).toBeNull()
  })
  it('refuses a wrong host, scheme, shape or token', () => {
    const bad = [
      `talos-link:127.0.0.1/${CONN}/${TOKEN}`,
      `talos-link:8.8.8.8/${CONN}/${TOKEN}`,
      `talos-link:[::1]/${CONN}/${TOKEN}`,
      `talos-link:relay.example.com:8443/${CONN}/${TOKEN}`,
      `talos-link:relay.example.com:80/${CONN}/${TOKEN}`,
      `talos-link:user${AT}relay.example.com/${CONN}/${TOKEN}`,
      `talos-link:localhost/${CONN}/${TOKEN}`,
      `talos-link:intranet/${CONN}/${TOKEN}`,
      `talos-link:2130706433/${CONN}/${TOKEN}`,
      `talos-link:Relay.Example.com/${CONN}/${TOKEN}`,
      `http://relay.example.com/${CONN}/${TOKEN}`,
      `talos-link:relay.example.com/${CONN}/${TOKEN}/x`,
      `talos-link:relay.example.com/${CONN}/${TOKEN}?a=1`,
      `talos-link:relay.example.com/${CONN}`,
      `talos-link:relay.example.com/cn_short/${TOKEN}`,
      `talos-link:relay.example.com/${CONN}/short`,
      `talos-link:relay.example.com/${CONN}/${TOKEN} x`,
      '',
    ]
    for (const b of bad) expect(parsePeerLinkCode(b).ok, b).toBe(false)
  })
})

describe('inbox url rule', () => {
  it('builds and accepts only the https inbox shape', () => {
    const u = peerInboxUrl('https://relay.example.com', CONN)
    expect(u).toBe(`https://relay.example.com/hook/peer/${CONN}`)
    expect(checkPeerInboxUrl(u)).toBe(u)
    for (const b of [
      `http://relay.example.com/hook/peer/${CONN}`,
      `https://127.0.0.1/hook/peer/${CONN}`,
      `https://10.0.0.5/hook/peer/${CONN}`,
      `https://localhost/hook/peer/${CONN}`,
      `https://relay.example.com:8443/hook/peer/${CONN}`,
      `https://u:p${AT}relay.example.com/hook/peer/${CONN}`,
      `https://relay.example.com/hook/peer/${CONN}?x=1`,
      `https://relay.example.com/other/${CONN}`,
      `https://relay.example.com/hook/peer/${CONN}/claim`,
    ])
      expect(checkPeerInboxUrl(b), b).toBeNull()
  })
})

describe('secret and redeem body', () => {
  it('checks the secret format', () => {
    expect(isPeerSecret(SECRET)).toBe(true)
    for (const b of ['whsec_', 'whsec_abc', 'x', `whsec_${'!'.repeat(40)}`]) expect(isPeerSecret(b)).toBe(false)
  })
  it('is strict', () => {
    const ok = {
      conn_id: CONN,
      token: TOKEN,
      back: { url: peerInboxUrl('https://b.example.com', CONN), secret: SECRET },
    }
    expect(PeerLinkRedeem.safeParse(ok).success).toBe(true)
    expect(PeerLinkRedeem.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    expect(PeerLinkRedeem.safeParse({ ...ok, back: { ...ok.back, url: 'http://b.example.com/x' } }).success).toBe(false)
    expect(PeerLinkRedeem.safeParse({ ...ok, back: { ...ok.back, secret: 'nope' } }).success).toBe(false)
  })
})

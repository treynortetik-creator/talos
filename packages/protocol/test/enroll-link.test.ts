import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  b64urlEncode,
  bridgeKeyFingerprint,
  bridgeKeyFingerprintFromB64,
  formatEnrollLink,
  newEnrollCode,
  parseEnrollFragment,
  parseEnrollLink,
} from '../src/index.ts'

const FP = 'A'.repeat(42) + 'b'
const code = newEnrollCode()

describe('bridge key fingerprint', () => {
  const raw = Uint8Array.from({ length: 32 }, (_, i) => i)
  test('is the full sha256 of the raw key, base64url, 43 chars', () => {
    const want = createHash('sha256').update(raw).digest('base64url')
    expect(bridgeKeyFingerprint(raw)).toBe(want)
    expect(want).toHaveLength(43)
    expect(bridgeKeyFingerprintFromB64(b64urlEncode(raw))).toBe(want)
  })
  test('the B64 form refuses a key that is not 32 bytes', () => {
    expect(() => bridgeKeyFingerprintFromB64(b64urlEncode(new Uint8Array(31)))).toThrow()
    expect(() => bridgeKeyFingerprintFromB64('')).toThrow()
  })
})

describe('parseEnrollFragment', () => {
  test('a plain code', () => expect(parseEnrollFragment(code)).toEqual({ ok: true, code }))
  test('code and fp', () => expect(parseEnrollFragment(`${code}&fp=${FP}`)).toEqual({ ok: true, code, fp: FP }))
  test('a whole link', () =>
    expect(parseEnrollFragment(`https://relay.example/enroll#${code}&fp=${FP}`)).toEqual({ ok: true, code, fp: FP }))
  test('a lowercase hyphenated code is normalised as before', () => {
    const loose = `${code.slice(0, 13)}-${code.slice(13)}`.toLowerCase()
    expect(parseEnrollFragment(loose)).toEqual({ ok: true, code })
  })
  test('an unknown key is ignored, as is an empty segment', () =>
    expect(parseEnrollFragment(`${code}&x=1&&fp=${FP}&y`)).toEqual({ ok: true, code, fp: FP }))
  test('an empty fp is bad', () => expect(parseEnrollFragment(`${code}&fp=`)).toEqual({ ok: false, error: 'bad_fp' }))
  test('42 and 44 chars are bad', () => {
    expect(parseEnrollFragment(`${code}&fp=${FP.slice(1)}`)).toEqual({ ok: false, error: 'bad_fp' })
    expect(parseEnrollFragment(`${code}&fp=${FP}A`)).toEqual({ ok: false, error: 'bad_fp' })
  })
  test('+ and / are bad (base64, not base64url)', () => {
    expect(parseEnrollFragment(`${code}&fp=${'A'.repeat(42)}+`)).toEqual({ ok: false, error: 'bad_fp' })
    expect(parseEnrollFragment(`${code}&fp=${'A'.repeat(42)}/`)).toEqual({ ok: false, error: 'bad_fp' })
  })
  test('two fps fail, even equal ones', () => {
    expect(parseEnrollFragment(`${code}&fp=${FP}&fp=${FP}`)).toEqual({ ok: false, error: 'dup_fp' })
    expect(parseEnrollFragment(`${code}&fp=${FP}&fp=${'B'.repeat(43)}`)).toEqual({ ok: false, error: 'dup_fp' })
  })
  test('nothing is percent-decoded: an encoded fp is bad, not decoded', () => {
    expect(parseEnrollFragment(`${code}&fp=${FP.slice(0, 42)}%62`)).toEqual({ ok: false, error: 'bad_fp' })
    expect(parseEnrollFragment(`${code}&fp=%E0%A4%A`)).toEqual({ ok: false, error: 'bad_fp' })
  })
  test('a mangled fp key fails closed: FP, " fp", fp%3D, %66p', () => {
    for (const k of ['FP=', ' fp=', 'fp%3D', '%66p=', 'fp ='])
      expect(parseEnrollFragment(`${code}&${k}${FP}`), k).toEqual({ ok: false, error: 'bad_fp' })
    expect(parseEnrollFragment(`${code}&fp`)).toEqual({ ok: false, error: 'bad_fp' })
  })
  test('a second # is a bad link; a leading # (location.hash) is stripped', () => {
    expect(parseEnrollFragment(`https://relay.example/enroll#${code}#x`)).toEqual({ ok: false, error: 'bad_link' })
    expect(parseEnrollFragment(`https://relay.example/x#y#${code}`)).toEqual({ ok: false, error: 'bad_link' })
    expect(parseEnrollFragment(`#${code}&fp=${FP}`)).toEqual({ ok: true, code, fp: FP })
  })
  test('empty input, and a bad code with a good fp, are no_code', () => {
    expect(parseEnrollFragment('')).toEqual({ ok: false, error: 'no_code' })
    expect(parseEnrollFragment('#')).toEqual({ ok: false, error: 'no_code' })
    expect(parseEnrollFragment(`NOTACODE&fp=${FP}`)).toEqual({ ok: false, error: 'no_code' })
  })
  test('formatEnrollLink round-trips, and refuses a bad fp', () => {
    expect(formatEnrollLink('https://relay.example', code)).toBe(`https://relay.example/enroll#${code}`)
    const link = formatEnrollLink('https://relay.example', code, FP)
    expect(parseEnrollFragment(link)).toEqual({ ok: true, code, fp: FP })
    expect(() => formatEnrollLink('https://relay.example', code, 'short')).toThrow()
  })
})

// The shared cases (the iPhone app's Swift parser runs the same file): every one, exactly.
describe('enroll link vectors', () => {
  const { cases } = JSON.parse(
    readFileSync(new URL('../fixtures/enroll-link/vectors.json', import.meta.url), 'utf8'),
  ) as { cases: { name: string; link: string; ok: boolean; code?: string; fp?: string; error?: string }[] }
  test('the file has cases, each named once', () => {
    expect(cases.length).toBeGreaterThan(30)
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length)
  })
  test.each(cases)('$name', ({ link, ok, code, fp, error }) => {
    const want = ok ? { ok, code, ...(fp ? { fp } : {}) } : { ok, error }
    expect(parseEnrollFragment(link)).toEqual(want)
  })
})

// The whole link, origin and all, as the iPhone app scans it (parseEnrollLink): the same file's `links`.
describe('enroll link vectors: whole links', () => {
  const { links } = JSON.parse(
    readFileSync(new URL('../fixtures/enroll-link/vectors.json', import.meta.url), 'utf8'),
  ) as {
    links: { name: string; link: string; ok: boolean; origin?: string; code?: string; fp?: string; error?: string }[]
  }
  test('the file has links, each named once', () => {
    expect(links.length).toBeGreaterThan(40)
    expect(new Set(links.map((c) => c.name)).size).toBe(links.length)
  })
  test.each(links)('$name', ({ link, ok, origin, code, fp, error }) => {
    const want = ok ? { ok, origin, code, ...(fp ? { fp } : {}) } : { ok, error }
    expect(parseEnrollLink(link)).toEqual(want)
    // and the origin is the one a browser's URL parser (so the web view) gives the same link
    if (ok) expect(new URL(link.trim()).origin, 'WHATWG origin').toBe(origin)
  })
  test('a formatted link reads back with its origin', () => {
    const link = formatEnrollLink('https://relay.example:8443', code, FP)
    expect(parseEnrollLink(link)).toEqual({ ok: true, origin: 'https://relay.example:8443', code, fp: FP })
  })
})

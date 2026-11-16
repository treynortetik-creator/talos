// The signed release manifest: the shared vectors (which the Mac's ReleaseManifestTests reads too) against hand-written expectations,
// the rotation rules, the signature's one form (raw, low-S), the vectors' freshness, and the pinned list's placeholder.
import { spawnSync } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyKeyUpdate,
  compareSemver,
  highS,
  lowS,
  RELEASE_KEYS,
  RELEASE_TEST_KEYS,
  type ReleaseTrust,
  releaseKid,
  releaseManifestJson,
  releasePublicKey,
  signReleaseManifest,
  verifyReleaseManifest,
} from '../src/release-manifest.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'fixtures', 'release-manifest')
type Vec = { name: string; json: string; sig: string; expect: string }
const vectors = JSON.parse(readFileSync(join(dir, 'vectors.json'), 'utf8')) as {
  trust: ReleaseTrust
  manifests: Vec[]
  rotations: {
    name: string
    before: ReleaseTrust
    update: never
    expect: { ok: boolean; why?: string; after?: ReleaseTrust }
  }[]
  decisions: { version: string; min_app_version: string; running: string; expect: string }[]
}
type Key = { private_pkcs8_pem: string; public_key: string; kid: string }
const keys = JSON.parse(readFileSync(join(dir, 'test-key.json'), 'utf8')) as Record<
  'test' | 'other' | 'next' | 'old',
  Key
>
const pin = (k: Key) => ({ kid: k.kid, publicKey: k.public_key })

// Written by hand, not read from the file: the file's own `expect` is what the Swift side is held to.
const expected: Record<string, string> = {
  good: 'ok',
  'good, the signature file ends with a newline': 'ok',
  'good, a key this build does not know is ignored': 'ok',
  'good, with a key update': 'ok',
  'tampered: the version changed after signing': 'bad_signature',
  'tampered: the zip sha256 changed after signing': 'bad_signature',
  'the same manifest pretty-printed keeps the signature of the compact bytes': 'bad_signature',
  'wrong kid: names the trusted key, signed by another': 'bad_signature',
  'unknown kid: a key that is not trusted, naming itself': 'unknown_kid',
  'retired kid: the retired key, naming itself': 'retired_kid',
  'high-S: the twin of a good signature': 'non_canonical_signature',
  'DER: a good signature written as DER': 'bad_signature_encoding',
  'the signature is cut short': 'bad_signature_encoding',
  'the signature is not base64': 'bad_signature_encoding',
  'no signature': 'bad_signature_encoding',
  'too large': 'too_large',
  'signed bytes that are not JSON': 'not_json',
  'signed JSON that is not an object': 'not_json',
  'no kid': 'bad_field:kid',
  'a newer manifest version': 'unsupported_version',
  'git_sha is short': 'bad_field:git_sha',
  'zip_url is plain http': 'bad_field:zip_url',
  'zip_url names another file': 'bad_field:zip_url',
  'size over the cap': 'bad_field:size',
  'size is not an integer': 'bad_field:size',
  'team_id is lowercase': 'bad_field:team_id',
  'version has a leading zero': 'bad_field:version',
  'version with a line break': 'bad_field:version',
  'zip_name with a slash': 'bad_field:zip_name',
  'a key update whose kid is not its key': 'bad_field:keys',
}

describe('release manifest vectors', () => {
  it('cover every hand-written case and nothing else, against the test key with the old key retired', () => {
    expect(vectors.manifests.map((v) => v.name).sort()).toEqual(Object.keys(expected).sort())
    expect(vectors.trust).toEqual({ keys: [pin(keys.test)], retired: [keys.old.kid] })
    expect(RELEASE_TEST_KEYS).toEqual([pin(keys.test)])
  })

  for (const v of vectors.manifests) {
    it(`${v.name}: ${expected[v.name]}`, () => {
      const got = verifyReleaseManifest(Buffer.from(v.json, 'utf8'), v.sig, vectors.trust)
      expect(got.ok ? 'ok' : got.why).toBe(expected[v.name])
      expect(v.expect).toBe(expected[v.name])
    })
  }

  it('the good manifest is refused once its key is retired, and under a trust that lacks it', () => {
    const good = vectors.manifests.find((v) => v.name === 'good') as Vec
    const b = Buffer.from(good.json, 'utf8')
    expect(verifyReleaseManifest(b, good.sig, { keys: [pin(keys.test)], retired: [keys.test.kid] })).toEqual({
      ok: false,
      why: 'retired_kid',
    })
    expect(verifyReleaseManifest(b, good.sig, { keys: [pin(keys.other)], retired: [] })).toEqual({
      ok: false,
      why: 'unknown_kid',
    })
    // a pinned entry whose kid is not its own key's is no key at all
    expect(
      verifyReleaseManifest(b, good.sig, {
        keys: [{ kid: keys.test.kid, publicKey: keys.other.public_key }],
        retired: [],
      }),
    ).toEqual({ ok: false, why: 'unknown_kid' })
  })

  it('a signature over the bare bytes, without the domain line, is refused', () => {
    const good = vectors.manifests.find((v) => v.name === 'good') as Vec
    const raw = sign('sha256', Buffer.from(good.json, 'utf8'), {
      key: createPrivateKey(keys.test.private_pkcs8_pem),
      dsaEncoding: 'ieee-p1363',
    })
    expect(verifyReleaseManifest(Buffer.from(good.json, 'utf8'), lowS(raw).toString('base64'), vectors.trust)).toEqual({
      ok: false,
      why: 'bad_signature',
    })
  })

  it('the signer always writes the low-S form, and its twin is the high one', () => {
    const json = (vectors.manifests[0] as Vec).json
    for (let i = 0; i < 20; i++) {
      const sig = Buffer.from(signReleaseManifest(json, keys.test.private_pkcs8_pem), 'base64')
      expect(verifyReleaseManifest(Buffer.from(json), sig.toString('base64'), vectors.trust).ok).toBe(true)
      expect(lowS(sig)).toEqual(sig)
      expect(verifyReleaseManifest(Buffer.from(json), highS(sig).toString('base64'), vectors.trust)).toEqual({
        ok: false,
        why: 'non_canonical_signature',
      })
    }
  })

  it('rotation: adds join, retires leave for good, never empty, never a retired kid back', () => {
    const t = pin(keys.test)
    const n = pin(keys.next)
    const want: Record<string, unknown> = {
      'add next, retire test': { ok: true, after: { keys: [n], retired: [t.kid] } },
      'retire the only key': { ok: false, why: 'would_empty' },
      'add a retired kid back': { ok: false, why: 'adds_retired' },
      'add a key already trusted': { ok: true, after: { keys: [t], retired: [] } },
    }
    for (const r of vectors.rotations) expect(r.expect).toEqual(want[r.name])
    expect(vectors.rotations).toHaveLength(Object.keys(want).length)
    for (const r of vectors.rotations) {
      const got = applyKeyUpdate(r.before, r.update)
      expect(got.ok ? { ok: true, after: got.trust } : { ok: false, why: got.why }).toEqual(r.expect)
    }
  })

  it('after a rotation the new key verifies and the retired one is refused', () => {
    const update = vectors.manifests.find((v) => v.name === 'good, with a key update') as Vec
    const v = verifyReleaseManifest(Buffer.from(update.json), update.sig, vectors.trust)
    if (!v.ok || !v.manifest.keys) throw new Error('the update vector does not verify')
    const r = applyKeyUpdate(vectors.trust, v.manifest.keys)
    if (!r.ok) throw new Error(r.why)
    const next = releaseManifestJson({ ...JSON.parse((vectors.manifests[0] as Vec).json), kid: keys.next.kid })
    expect(
      verifyReleaseManifest(Buffer.from(next), signReleaseManifest(next, keys.next.private_pkcs8_pem), r.trust).ok,
    ).toBe(true)
    const good = vectors.manifests[0] as Vec
    expect(verifyReleaseManifest(Buffer.from(good.json), good.sig, r.trust)).toEqual({ ok: false, why: 'retired_kid' })
  })

  it('the decisions: newer installs, equal and older do not, below min_app_version needs a hand install', () => {
    const want: Record<string, string> = {
      '1.4.0|1.3.9': 'install',
      '1.4.0|1.4.0': 'up_to_date',
      '1.4.0|1.10.0': 'downgrade',
      '1.10.0|1.9.0': 'install',
      '2.0.0|1.4.9': 'too_old',
      '2.0.0|1.5.0': 'install',
      '1.4.0|unknown': 'unknown_running',
      '1.4.0|': 'unknown_running',
    }
    for (const d of vectors.decisions) expect(d.expect).toBe(want[`${d.version}|${d.running}`])
    expect(vectors.decisions).toHaveLength(Object.keys(want).length)
  })

  it('compares versions as numbers, never as text', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1)
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1)
    expect(compareSemver('1.0', '1.0.0')).toBeNull()
  })

  it('a key is a 65-byte P-256 point; its kid is the first 16 hex of its sha256', () => {
    expect(releaseKid(keys.test.public_key)).toBe(keys.test.kid)
    expect(releasePublicKey('')).toBeNull()
    expect(releasePublicKey(Buffer.alloc(65, 4).toString('base64'))).toBeNull()
    expect(releaseKid(Buffer.alloc(32).toString('base64'))).toBeNull()
  })

  it('the real release keys are pinned (the Secure Enclave key), never a test key, each kid its own key', () => {
    expect(RELEASE_KEYS.every((k) => !RELEASE_TEST_KEYS.some((t) => t.kid === k.kid))).toBe(true)
    expect(RELEASE_KEYS.map((k) => k.kid)).toEqual(['a2602db8dcbc13c5'])
    for (const k of RELEASE_KEYS) expect(releaseKid(k.publicKey)).toBe(k.kid)
  })

  it('the committed vectors are the cases the generator makes now, each still verifying as written', () => {
    const r = spawnSync(
      'node',
      ['--disable-warning=ExperimentalWarning', 'scripts/gen-release-manifest-vectors.ts', '--check'],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    )
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  }, 70_000)
})

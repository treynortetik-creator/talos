// Writes fixtures/release-manifest/vectors.json: signed release manifests (good, tampered, wrong or retired kid, high-S, DER,
// malformed), key-rotation cases and version decisions, read by the protocol's test and by the Mac's ReleaseManifestTests. ECDSA
// signatures carry fresh randomness, so a new run writes other signature bytes; `--check` therefore holds the committed file to what
// matters: the same cases, and each one still verifying (or being refused) exactly as the file says.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyKeyUpdate,
  highS,
  RELEASE_MANIFEST_MAX_BYTES,
  type ReleaseKeyUpdate,
  type ReleaseManifest,
  type ReleaseTrust,
  releaseDecision,
  releaseManifestJson,
  signReleaseManifest,
  verifyReleaseManifest,
} from '../src/release-manifest.ts'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'release-manifest')
type Key = { private_pkcs8_pem: string; public_key: string; kid: string }
const keys = JSON.parse(readFileSync(join(dir, 'test-key.json'), 'utf8')) as Record<
  'test' | 'other' | 'next' | 'old',
  Key
>
const pin = (k: Key) => ({ kid: k.kid, publicKey: k.public_key })
/** The trust every manifest case is checked against: the test key, with the old key retired. */
const trust: ReleaseTrust = { keys: [pin(keys.test)], retired: [keys.old.kid] }

const base: ReleaseManifest = {
  v: 1,
  kid: keys.test.kid,
  version: '1.4.0',
  git_sha: '0123456789abcdef0123456789abcdef01234567',
  tag: 'v1.4.0',
  min_app_version: '1.0.0',
  zip_url: 'https://example.com/releases/download/v1.4.0/Talos-1.4.0-universal.zip',
  zip_name: 'Talos-1.4.0-universal.zip',
  zip_sha256: 'aa'.repeat(32),
  size: 41_234_567,
  team_id: 'ABCDE12345',
  published_at: '2026-11-14T20:00:00Z',
}

type Case = { name: string; json: string; sig: string }
const signed = (name: string, json: string, key: keyof typeof keys = 'test'): Case => ({
  name,
  json,
  sig: signReleaseManifest(json, keys[key].private_pkcs8_pem),
})
const with_ = (m: Partial<ReleaseManifest> | Record<string, unknown>) =>
  releaseManifestJson({ ...base, ...m } as ReleaseManifest)

export function makeCases(): Case[] {
  const good = releaseManifestJson(base)
  const goodSig = signReleaseManifest(good, keys.test.private_pkcs8_pem)
  const raw = Buffer.from(goodSig, 'base64')
  const der = (() => {
    const int = (b: Buffer) => {
      let x = b
      while (x.length > 1 && x[0] === 0 && (x[1] as number) < 0x80) x = x.subarray(1)
      if ((x[0] as number) >= 0x80) x = Buffer.concat([Buffer.from([0]), x])
      return Buffer.concat([Buffer.from([2, x.length]), x])
    }
    const body = Buffer.concat([int(raw.subarray(0, 32)), int(raw.subarray(32))])
    return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('base64')
  })()
  const update: ReleaseKeyUpdate = { add: [{ kid: keys.next.kid, pub: keys.next.public_key }], retire: [keys.test.kid] }
  return [
    { name: 'good', json: good, sig: goodSig },
    { name: 'good, the signature file ends with a newline', json: good, sig: `${goodSig}\n` },
    signed('good, a key this build does not know is ignored', with_({ notes: 'x' })),
    signed('good, with a key update', with_({ keys: update })),
    { name: 'tampered: the version changed after signing', json: good.replace('"1.4.0"', '"9.4.0"'), sig: goodSig },
    { name: 'tampered: the zip sha256 changed after signing', json: good.replace('aaaa', 'bbbb'), sig: goodSig },
    {
      name: 'the same manifest pretty-printed keeps the signature of the compact bytes',
      json: JSON.stringify(base, null, 2),
      sig: goodSig,
    },
    signed('wrong kid: names the trusted key, signed by another', good, 'other'),
    signed('unknown kid: a key that is not trusted, naming itself', with_({ kid: keys.other.kid }), 'other'),
    signed('retired kid: the retired key, naming itself', with_({ kid: keys.old.kid }), 'old'),
    { name: 'high-S: the twin of a good signature', json: good, sig: highS(raw).toString('base64') },
    { name: 'DER: a good signature written as DER', json: good, sig: der },
    { name: 'the signature is cut short', json: good, sig: goodSig.slice(0, 40) },
    { name: 'the signature is not base64', json: good, sig: `${goodSig.slice(0, 86)}!!` },
    { name: 'no signature', json: good, sig: '' },
    signed('too large', `${good}${' '.repeat(RELEASE_MANIFEST_MAX_BYTES)}`),
    signed('signed bytes that are not JSON', 'not json at all'),
    signed('signed JSON that is not an object', '[1,2,3]'),
    signed('no kid', JSON.stringify({ ...base, kid: undefined })),
    signed('a newer manifest version', with_({ v: 2 })),
    signed('git_sha is short', with_({ git_sha: '0123456' })),
    signed('zip_url is plain http', with_({ zip_url: base.zip_url.replace('https:', 'http:') })),
    signed('zip_url names another file', with_({ zip_url: base.zip_url.replace('universal', 'arm64') })),
    signed('size over the cap', with_({ size: 400_000_000 })),
    signed('size is not an integer', with_({ size: 1.5 })),
    signed('team_id is lowercase', with_({ team_id: 'abcde12345' })),
    signed('version has a leading zero', with_({ version: '01.4.0' })),
    signed('version with a line break', with_({ version: '1.4.0\nTalos updated' })),
    signed('zip_name with a slash', with_({ zip_name: '../Talos-1.zip' })),
    signed(
      'a key update whose kid is not its key',
      with_({ keys: { add: [{ kid: keys.test.kid, pub: keys.next.public_key }], retire: [] } }),
    ),
  ]
}

const verdict = (c: Case) => {
  const v = verifyReleaseManifest(Buffer.from(c.json, 'utf8'), c.sig, trust)
  return v.ok ? 'ok' : v.why
}

const rotations = (() => {
  const t = pin(keys.test)
  const n = pin(keys.next)
  const cases: { name: string; before: ReleaseTrust; update: ReleaseKeyUpdate }[] = [
    {
      name: 'add next, retire test',
      before: { keys: [t], retired: [] },
      update: { add: [{ kid: n.kid, pub: n.publicKey }], retire: [t.kid] },
    },
    { name: 'retire the only key', before: { keys: [t], retired: [] }, update: { add: [], retire: [t.kid] } },
    {
      name: 'add a retired kid back',
      before: { keys: [t], retired: [n.kid] },
      update: { add: [{ kid: n.kid, pub: n.publicKey }], retire: [] },
    },
    {
      name: 'add a key already trusted',
      before: { keys: [t], retired: [] },
      update: { add: [{ kid: t.kid, pub: t.publicKey }], retire: [] },
    },
  ]
  return cases.map((c) => {
    const r = applyKeyUpdate(c.before, c.update)
    return { ...c, expect: r.ok ? { ok: true, after: r.trust } : { ok: false, why: r.why } }
  })
})()

const decisions = [
  ['1.4.0', '1.0.0', '1.3.9'],
  ['1.4.0', '1.0.0', '1.4.0'],
  ['1.4.0', '1.0.0', '1.10.0'],
  ['1.10.0', '1.0.0', '1.9.0'],
  ['2.0.0', '1.5.0', '1.4.9'],
  ['2.0.0', '1.5.0', '1.5.0'],
  ['1.4.0', '1.0.0', 'unknown'],
  ['1.4.0', '1.0.0', ''],
].map(([version, min, running]) => ({
  version,
  min_app_version: min,
  running,
  expect: releaseDecision({ ...base, version: version as string, min_app_version: min as string }, running as string),
}))

const target = join(dir, 'vectors.json')
if (process.argv.includes('--check')) {
  const now = JSON.parse(readFileSync(target, 'utf8')) as { manifests: (Case & { expect: string })[] }
  const names = makeCases().map((c) => c.name)
  const bad = now.manifests.filter((c) => verdict(c) !== c.expect).map((c) => c.name)
  if (JSON.stringify(now.manifests.map((c) => c.name)) !== JSON.stringify(names) || bad.length > 0) {
    process.stderr.write(
      `fixtures/release-manifest/vectors.json is stale (${bad.join('; ') || 'the cases differ'}): run scripts/gen-release-manifest-vectors.ts\n`,
    )
    process.exit(1)
  }
} else {
  const out = {
    _comment:
      'Made by scripts/gen-release-manifest-vectors.ts from the TEST keys in test-key.json. Read by test/release-manifest.test.ts and apps/desktop ReleaseManifestTests.swift.',
    trust,
    manifests: makeCases().map((c) => ({ ...c, expect: verdict(c) })),
    rotations,
    decisions,
  }
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`)
}

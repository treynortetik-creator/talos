// The signed release manifest the Mac app's updater reads (`latest.json` and its detached `latest.json.sig`), node and bun only:
// import it as `@talos-app/protocol/release-manifest`. The Mac's twin is apps/desktop/Sources/TalosDesktopCore/ReleaseManifest.swift;
// both run the shared vectors in fixtures/release-manifest/vectors.json.
//
// What is signed: the exact bytes of latest.json, which the publisher writes as the JCS form of the manifest, prefixed with a fixed
// domain line, so a signature made for anything else can never pass for a release. The verifier checks the bytes it received, never a
// re-serialization of what it parsed: a manifest rewritten in any other form no longer matches its signature.
//
// The key: ECDSA P-256 with SHA-256 (the release key lives in the publishing Mac's Secure Enclave). A public key is its 65-byte
// uncompressed point (X9.63, 0x04 || x || y) in base64; its `kid` is the first 16 hex characters of the sha256 of those 65 bytes.
// The signature is the RAW form, r || s, 32 bytes each, 64 bytes in base64 (CryptoKit's rawRepresentation, node's ieee-p1363), never
// DER: a fixed length, one way to write it. And only LOW-S: an ECDSA signature (r, s) is also valid as (r, n - s), so each signature
// has a twin; the signer writes the one with s <= n/2 and both verifiers refuse the other, so one (key, manifest) has exactly one
// signature that passes, on the Mac and in node alike, and a vectors file can pin it.
//
// The app trusts a LIST of keys, by kid (`RELEASE_KEYS`, empty = the updater is inert). A manifest names its signer's kid. A manifest
// that verifies under a currently trusted key may carry `keys: {add: [{kid, pub}], retire: [kid]}`, the rotation path: the app keeps
// the result (`applyKeyUpdate`), never lets it go empty, and a retired kid is refused from then on.
import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto'
import { jcs } from './canonical.ts'
import { compareSemver, SEMVER } from './semver.ts'

// re-exported: the updater and the relay's env read them from here
export { compareSemver, SEMVER }

/** Put in front of the manifest bytes before signing and verifying. */
export const RELEASE_MANIFEST_DOMAIN = 'talos-release-manifest/v1\n'
/** latest.json is a few hundred bytes; anything past this is refused before it is parsed. */
export const RELEASE_MANIFEST_MAX_BYTES = 16 * 1024
/** latest.json.sig: one base64 raw P-256 signature (88 characters) and maybe a newline. */
export const RELEASE_SIG_MAX_BYTES = 1024
/** The largest zip a release may name (install.sh's own download cap, 300 MiB). */
export const RELEASE_ZIP_MAX_BYTES = 314_572_800
/** A key update may name this many keys at most, each way. */
export const RELEASE_KEY_UPDATE_MAX = 8

export type ReleaseKey = { kid: string; publicKey: string }
/** The keys the app trusts now, and the kids retired for good. */
export type ReleaseTrust = { keys: ReleaseKey[]; retired: string[] }
export type ReleaseKeyUpdate = { add: { kid: string; pub: string }[]; retire: string[] }

/**
 * The release keys the updater trusts. RELEASE KEY PLACEHOLDER: empty until the owner creates the real Secure Enclave key
 * (apps/desktop/scripts/release-key.swift create) and pins what it prints here and in ReleaseManifest.swift (`ReleaseTrust.keys`).
 * While it is empty the updater installs nothing.
 */
// The owner's release key, created 2026-11-15 in Delphi's Secure Enclave (cannot be copied; see docs/desktop.md for the loss case).
export const RELEASE_KEYS: readonly ReleaseKey[] = [
  {
    kid: 'a2602db8dcbc13c5',
    publicKey: 'BL4AZLKsJrNlosGGjWiDg4LXEP0H1elOWpYdJRJQk40MZ00bAeQblxPelC7aaWEsDRUxfAaaTKlcOcTWfu6pem8=',
  },
]
/** The committed TEST keys' public halves (fixtures/release-manifest/test-key.json). Tests only; never trusted by a real updater. */
export const RELEASE_TEST_KEYS: readonly ReleaseKey[] = [
  {
    kid: '6525d5cf268c7497',
    publicKey: 'BCXinZCnOOOafAOfzAsuRKfBGVxzRuna+9MWEFfmVp/gPjz4od8odDfwWt0q62XszgXr07SXFEdyBQI4Vr0k23o=',
  },
]

export type ReleaseManifest = {
  v: 1
  kid: string
  version: string
  git_sha: string
  tag: string
  min_app_version: string
  zip_url: string
  zip_name: string
  zip_sha256: string
  size: number
  team_id: string
  published_at: string
  keys?: ReleaseKeyUpdate
}

/** Why a manifest was refused. `bad_field:<name>` names the first field that does not check out. */
export type ReleaseRefusal =
  | 'too_large'
  | 'bad_signature_encoding'
  | 'non_canonical_signature'
  | 'unknown_kid'
  | 'retired_kid'
  | 'bad_signature'
  | 'not_json'
  | 'unsupported_version'
  | `bad_field:${string}`

export type ReleaseVerdict = { ok: true; manifest: ReleaseManifest } | { ok: false; why: ReleaseRefusal }

const KID = /^[0-9a-f]{16}$/
const FIELDS = {
  kid: KID,
  version: SEMVER,
  git_sha: /^[0-9a-f]{40}$/,
  tag: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  min_app_version: SEMVER,
  zip_url: /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~%/+-]{1,512}$/,
  zip_name: /^Talos-[A-Za-z0-9._-]{1,96}\.zip$/,
  zip_sha256: /^[0-9a-f]{64}$/,
  team_id: /^[A-Z0-9]{10}$/,
  published_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
} as const
const ORDER = Object.keys(FIELDS) as (keyof typeof FIELDS)[]

/** P-256's group order n, and n / 2 (the low-S bound), as big-endian hex. */
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const HALF_N = N >> 1n

/** The kid of a public key (65-byte X9.63 point in base64): the first 16 hex characters of its sha256; null when it is not one. */
export function releaseKid(publicKeyBase64: string): string | null {
  const raw = Buffer.from(publicKeyBase64, 'base64')
  if (
    raw.length !== 65 ||
    raw[0] !== 4 ||
    raw.toString('base64') !== publicKeyBase64 ||
    !releasePublicKey(publicKeyBase64)
  )
    return null
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** A public key from its 65-byte X9.63 point in base64; null when it is not a point on P-256. */
export function releasePublicKey(publicKeyBase64: string): KeyObject | null {
  const raw = Buffer.from(publicKeyBase64, 'base64')
  if (raw.length !== 65 || raw[0] !== 4 || raw.toString('base64') !== publicKeyBase64) return null
  try {
    return createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    })
  } catch {
    return null
  }
}

function parseKeyUpdate(v: unknown): ReleaseKeyUpdate | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const add = o.add ?? []
  const retire = o.retire ?? []
  if (!Array.isArray(add) || !Array.isArray(retire)) return null
  if (add.length > RELEASE_KEY_UPDATE_MAX || retire.length > RELEASE_KEY_UPDATE_MAX) return null
  const out: ReleaseKeyUpdate = { add: [], retire: [] }
  for (const a of add) {
    if (typeof a !== 'object' || a === null) return null
    const { kid, pub } = a as Record<string, unknown>
    if (typeof kid !== 'string' || typeof pub !== 'string' || releaseKid(pub) !== kid) return null
    out.add.push({ kid, pub })
  }
  for (const r of retire) {
    if (typeof r !== 'string' || !KID.test(r)) return null
    out.retire.push(r)
  }
  return out
}

/** The manifest's fields checked one by one. Keys it does not know are ignored (they were signed, so a newer publisher may add one). */
export function parseReleaseManifest(value: unknown): ReleaseVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, why: 'not_json' }
  const o = value as Record<string, unknown>
  if (o.v !== 1) return { ok: false, why: 'unsupported_version' }
  for (const k of ORDER) {
    const s = o[k]
    if (typeof s !== 'string' || !FIELDS[k].test(s)) return { ok: false, why: `bad_field:${k}` }
  }
  const size = o.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > RELEASE_ZIP_MAX_BYTES) {
    return { ok: false, why: 'bad_field:size' }
  }
  if (!(o.zip_url as string).endsWith(`/${o.zip_name as string}`)) return { ok: false, why: 'bad_field:zip_url' }
  const m = { v: 1, size } as ReleaseManifest
  for (const k of ORDER) m[k] = o[k] as string
  if (o.keys !== undefined) {
    const u = parseKeyUpdate(o.keys)
    if (!u) return { ok: false, why: 'bad_field:keys' }
    m.keys = u
  }
  return { ok: true, manifest: m }
}

/** The bytes a publisher writes as latest.json: the JCS form of the manifest. */
export function releaseManifestJson(m: ReleaseManifest): string {
  return jcs(m)
}

function signingInput(bytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(RELEASE_MANIFEST_DOMAIN, 'utf8'), Buffer.from(bytes)])
}

/** The low-S twin of a raw signature (s replaced by n - s when s > n/2). */
export function lowS(raw: Buffer): Buffer {
  const s = BigInt(`0x${raw.subarray(32).toString('hex')}`)
  if (s <= HALF_N) return raw
  return Buffer.concat([raw.subarray(0, 32), Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex')])
}

/** The high-S twin (tests only: the form every verifier must refuse). */
export function highS(raw: Buffer): Buffer {
  const s = BigInt(`0x${raw.subarray(32).toString('hex')}`)
  return Buffer.concat([raw.subarray(0, 32), Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex')])
}

/** The detached signature (base64, one line) over latest.json's bytes, raw and low-S. `privateKeyPem`: a PKCS8 P-256 key (tests). */
export function signReleaseManifest(json: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  const raw = sign('sha256', signingInput(Buffer.from(json, 'utf8')), { key, dsaEncoding: 'ieee-p1363' })
  return lowS(raw).toString('base64')
}

/**
 * latest.json as received (`bytes`) and latest.json.sig's text, against the trusted keys: sizes, the signature's form (64 raw bytes,
 * low-S), the signer's kid (read from the bytes only to pick the key: a kid that is retired or not trusted is refused before anything
 * else is believed), the signature over exactly those bytes, then the fields.
 */
export function verifyReleaseManifest(bytes: Uint8Array, sigText: string, trust: ReleaseTrust): ReleaseVerdict {
  if (bytes.length > RELEASE_MANIFEST_MAX_BYTES || sigText.length > RELEASE_SIG_MAX_BYTES)
    return { ok: false, why: 'too_large' }
  const sigLine = sigText.endsWith('\n') ? sigText.slice(0, -1) : sigText
  const sig = Buffer.from(sigLine, 'base64')
  if (sig.length !== 64 || sig.toString('base64') !== sigLine) return { ok: false, why: 'bad_signature_encoding' }
  if (BigInt(`0x${sig.subarray(32).toString('hex')}`) > HALF_N) return { ok: false, why: 'non_canonical_signature' }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return { ok: false, why: 'not_json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, why: 'not_json' }
  const kid = (parsed as Record<string, unknown>).kid
  if (typeof kid !== 'string' || !KID.test(kid)) return { ok: false, why: 'bad_field:kid' }
  if (trust.retired.includes(kid)) return { ok: false, why: 'retired_kid' }
  const entry = trust.keys.find((k) => k.kid === kid)
  const key = entry && releaseKid(entry.publicKey) === kid ? releasePublicKey(entry.publicKey) : null
  if (!key) return { ok: false, why: 'unknown_kid' }
  let good = false
  try {
    good = verify('sha256', signingInput(bytes), { key, dsaEncoding: 'ieee-p1363' }, sig)
  } catch {
    good = false
  }
  if (!good) return { ok: false, why: 'bad_signature' }
  return parseReleaseManifest(parsed)
}

/**
 * The trusted keys after a verified manifest's `keys` update: its adds (never a retired kid) joined, its retires removed and remembered
 * for good. Refused, with the trust unchanged, when it would leave no key, or adds a retired kid.
 */
export function applyKeyUpdate(
  trust: ReleaseTrust,
  update: ReleaseKeyUpdate,
): { ok: true; trust: ReleaseTrust } | { ok: false; why: 'would_empty' | 'adds_retired' } {
  const retired = new Set([...trust.retired, ...update.retire])
  if (update.add.some((a) => retired.has(a.kid))) return { ok: false, why: 'adds_retired' }
  const keys = [...trust.keys]
  for (const a of update.add) if (!keys.some((k) => k.kid === a.kid)) keys.push({ kid: a.kid, publicKey: a.pub })
  const left = keys.filter((k) => !retired.has(k.kid))
  if (left.length === 0) return { ok: false, why: 'would_empty' }
  return { ok: true, trust: { keys: left, retired: [...retired].sort() } }
}

/**
 * What the updater does with a verified manifest, given the version it runs: `install` only for a newer version this app may update
 * to by itself. `too_old`: this app is older than the release's `min_app_version` (it needs an install by hand). `unknown_running`:
 * the running version cannot be read, so nothing is installed.
 */
export type ReleaseDecision = 'install' | 'up_to_date' | 'downgrade' | 'too_old' | 'unknown_running'

export function releaseDecision(m: ReleaseManifest, running: string): ReleaseDecision {
  const c = compareSemver(m.version, running)
  if (c === null) return 'unknown_running'
  if (c === 0) return 'up_to_date'
  if (c < 0) return 'downgrade'
  return compareSemver(running, m.min_app_version) === -1 ? 'too_old' : 'install'
}

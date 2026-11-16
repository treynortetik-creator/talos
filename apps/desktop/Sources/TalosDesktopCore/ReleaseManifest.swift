import CryptoKit
import Foundation

/// The signed release manifest the updater reads (`latest.json` and its detached `latest.json.sig`), word for word the protocol's
/// `release-manifest.ts`; both run packages/protocol/fixtures/release-manifest/vectors.json (ReleaseManifestTests).
///
/// The signature covers the exact bytes of latest.json behind a fixed domain line, never a re-serialization of what was parsed: the
/// publisher writes the JCS form, and anything rewritten after signing no longer matches. ECDSA P-256 with SHA-256 (CryptoKit P256;
/// the release key lives in the publishing Mac's Secure Enclave): the signature RAW (r || s, 64 bytes, base64), never DER, and only
/// its low-S form (an ECDSA signature has a twin with s' = n - s; refusing the high one leaves exactly one signature that passes, the
/// same on the Mac and in node). Keys are trusted by kid (`ReleaseTrust.keys`, then the updater's stored list after rotations); no
/// feed address takes part.
public struct ReleaseManifest: Equatable, Sendable {
  public var kid: String
  public var version: String
  public var gitSha: String
  public var tag: String
  public var minAppVersion: String
  public var zipUrl: String
  public var zipName: String
  public var zipSha256: String
  public var size: Int
  public var teamId: String
  public var publishedAt: String
  /// A rotation this manifest carries (applied only because the manifest verified under a key trusted now).
  public var keys: KeyUpdate?

  public struct KeyUpdate: Equatable, Sendable {
    public var add: [ReleaseKey]
    public var retire: [String]
    public init(add: [ReleaseKey], retire: [String]) {
      self.add = add
      self.retire = retire
    }
  }

  public static let domain = "talos-release-manifest/v1\n"
  public static let maxBytes = 16 * 1024
  public static let maxSigBytes = 1024
  /// install.sh's own download cap, 300 MiB.
  public static let maxZipBytes = 314_572_800

  /// Why a manifest was refused, as the protocol spells it (`bad_field:<name>` for the first field that does not check out).
  public enum Refusal: Error, Equatable, Sendable, CustomStringConvertible {
    case tooLarge, badSignatureEncoding, nonCanonicalSignature, unknownKid, retiredKid, badSignature, notJson, unsupportedVersion
    case badField(String)
    public var description: String {
      switch self {
      case .tooLarge: return "too_large"
      case .badSignatureEncoding: return "bad_signature_encoding"
      case .nonCanonicalSignature: return "non_canonical_signature"
      case .unknownKid: return "unknown_kid"
      case .retiredKid: return "retired_kid"
      case .badSignature: return "bad_signature"
      case .notJson: return "not_json"
      case .unsupportedVersion: return "unsupported_version"
      case .badField(let f): return "bad_field:\(f)"
      }
    }
  }

  // ASCII classes only: Swift's \d also matches other scripts' digits.
  nonisolated(unsafe) static let semver = #/(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})/#
  nonisolated(unsafe) static let kidPattern = try! Regex("[0-9a-f]{16}")
  nonisolated(unsafe) static let fields: [(String, Regex<AnyRegexOutput>)] = [
    ("kid", try! Regex("[0-9a-f]{16}")),
    ("version", try! Regex(#"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})"#)),
    ("git_sha", try! Regex("[0-9a-f]{40}")),
    ("tag", try! Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")),
    ("min_app_version", try! Regex(#"(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})"#)),
    ("zip_url", try! Regex(#"https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~%/+-]{1,512}"#)),
    ("zip_name", try! Regex("Talos-[A-Za-z0-9._-]{1,96}\\.zip")),
    ("zip_sha256", try! Regex("[0-9a-f]{64}")),
    ("team_id", try! Regex("[A-Z0-9]{10}")),
    ("published_at", try! Regex(#"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z"#)),
  ]

  /// A JSON number that is an integer (not a boolean, which JSONSerialization also hands back as a number).
  static func integer(_ v: Any?) -> Int? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let d = n.doubleValue
    guard d.isFinite, d == d.rounded(), abs(d) < 1e15 else { return nil }
    return Int(d)
  }

  /// The fields checked one by one; keys this build does not know are ignored (they were signed).
  public static func parse(_ data: Data) -> Result<ReleaseManifest, Refusal> {
    guard let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return .failure(.notJson) }
    guard let o = any as? [String: Any] else { return .failure(.notJson) }
    guard integer(o["v"]) == 1 else { return .failure(.unsupportedVersion) }
    var s: [String: String] = [:]
    for (k, re) in fields {
      guard let v = o[k] as? String, (try? re.wholeMatch(in: v)) != nil else { return .failure(.badField(k)) }
      s[k] = v
    }
    guard let size = integer(o["size"]), size > 0, size <= maxZipBytes else { return .failure(.badField("size")) }
    guard s["zip_url"]!.hasSuffix("/" + s["zip_name"]!) else { return .failure(.badField("zip_url")) }
    var update: KeyUpdate?
    if let k = o["keys"] {
      guard let u = keyUpdate(k) else { return .failure(.badField("keys")) }
      update = u
    }
    return .success(
      ReleaseManifest(
        kid: s["kid"]!, version: s["version"]!, gitSha: s["git_sha"]!, tag: s["tag"]!, minAppVersion: s["min_app_version"]!, zipUrl: s["zip_url"]!,
        zipName: s["zip_name"]!, zipSha256: s["zip_sha256"]!, size: size, teamId: s["team_id"]!, publishedAt: s["published_at"]!,
        keys: update))
  }

  static let keyUpdateMax = 8

  static func keyUpdate(_ v: Any) -> KeyUpdate? {
    guard let o = v as? [String: Any] else { return nil }
    let add = o["add"] ?? [Any]()
    let retire = o["retire"] ?? [Any]()
    guard let a = add as? [Any], let r = retire as? [Any], a.count <= keyUpdateMax, r.count <= keyUpdateMax else { return nil }
    var out = KeyUpdate(add: [], retire: [])
    for x in a {
      guard let e = x as? [String: Any], let kid = e["kid"] as? String, let pub = e["pub"] as? String, ReleaseKey.kid(of: pub) == kid
      else { return nil }
      out.add.append(ReleaseKey(kid: kid, publicKey: pub))
    }
    for x in r {
      guard let kid = x as? String, (try? kidPattern.wholeMatch(in: kid)) != nil else { return nil }
      out.retire.append(kid)
    }
    return out
  }

  /// P-256's n / 2, big-endian: a signature whose s is above it is the high twin.
  static let halfN: [UInt8] = [
    0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
  ]

  /// P-256's group order n, big-endian.
  static let n: [UInt8] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
  ]

  /// The low-S form of a raw signature: s replaced by n - s when s is above n / 2 (the signer's last step; CryptoKit, like the
  /// Secure Enclave, may give either twin).
  public static func lowS(_ raw: Data) -> Data {
    guard raw.count == 64, !isLowS(raw) else { return raw }
    let s = Array(raw.suffix(32))
    var out = [UInt8](repeating: 0, count: 32)
    var borrow = 0
    for i in stride(from: 31, through: 0, by: -1) {
      var d = Int(n[i]) - Int(s[i]) - borrow
      borrow = d < 0 ? 1 : 0
      if d < 0 { d += 256 }
      out[i] = UInt8(d)
    }
    return raw.prefix(32) + Data(out)
  }

  /// s (the last 32 bytes) at most n / 2.
  public static func isLowS(_ raw: Data) -> Bool {
    let s = Array(raw.suffix(32))
    for (a, b) in zip(s, halfN) where a != b { return a < b }
    return true
  }

  /// latest.json as received and latest.json.sig's text, against the trusted keys: sizes, the signature's form (64 raw bytes, low-S),
  /// the signer's kid (read from the bytes only to pick the key: retired or untrusted is refused before anything else is believed),
  /// the signature over exactly these bytes, then the fields. As `verifyReleaseManifest` in the protocol, step for step.
  public static func verify(_ bytes: Data, sig: Data, trust: ReleaseKeyring) -> Result<ReleaseManifest, Refusal> {
    guard bytes.count <= maxBytes, sig.count <= maxSigBytes else { return .failure(.tooLarge) }
    var line = String(decoding: sig, as: UTF8.self)
    if line.hasSuffix("\n") { line.removeLast() }
    guard let raw = Data(base64Encoded: line), raw.count == 64, raw.base64EncodedString() == line else {
      return .failure(.badSignatureEncoding)
    }
    guard isLowS(raw) else { return .failure(.nonCanonicalSignature) }
    guard let any = try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]), let o = any as? [String: Any] else {
      return .failure(.notJson)
    }
    guard let kid = o["kid"] as? String, (try? kidPattern.wholeMatch(in: kid)) != nil else { return .failure(.badField("kid")) }
    if trust.retired.contains(kid) { return .failure(.retiredKid) }
    guard let entry = trust.keys.first(where: { $0.kid == kid }), ReleaseKey.kid(of: entry.publicKey) == kid,
      let keyRaw = Data(base64Encoded: entry.publicKey), let key = try? P256.Signing.PublicKey(x963Representation: keyRaw)
    else { return .failure(.unknownKid) }
    guard let signature = try? P256.Signing.ECDSASignature(rawRepresentation: raw),
      key.isValidSignature(signature, for: Data(domain.utf8) + bytes)
    else { return .failure(.badSignature) }
    return parse(bytes)
  }

  /// -1, 0 or 1 for two `x.y.z` versions; nil when either is not one.
  public static func compare(_ a: String, _ b: String) -> Int? {
    guard let x = try? semver.wholeMatch(in: a), let y = try? semver.wholeMatch(in: b) else { return nil }
    for (p, q) in [(x.1, y.1), (x.2, y.2), (x.3, y.3)] {
      let (i, j) = (Int(p)!, Int(q)!)
      if i != j { return i < j ? -1 : 1 }
    }
    return 0
  }

  public enum Decision: String, Equatable, Sendable {
    case install, upToDate = "up_to_date", downgrade, tooOld = "too_old", unknownRunning = "unknown_running"
  }

  /// `install` only for a newer version this app may update to by itself (`releaseDecision` in the protocol).
  public func decision(running: String) -> Decision {
    guard let c = Self.compare(version, running) else { return .unknownRunning }
    if c == 0 { return .upToDate }
    if c < 0 { return .downgrade }
    return Self.compare(running, minAppVersion) == -1 ? .tooOld : .install
  }
}

/// A release public key: its 65-byte uncompressed P-256 point (X9.63) in base64, and its kid.
public struct ReleaseKey: Equatable, Codable, Sendable {
  public var kid: String
  public var publicKey: String
  public init(kid: String, publicKey: String) {
    self.kid = kid
    self.publicKey = publicKey
  }

  /// The first 16 hex characters of the sha256 of the 65-byte point; nil when it is not a point on P-256.
  public static func kid(of publicKey: String) -> String? {
    guard let raw = Data(base64Encoded: publicKey), raw.count == 65, raw.first == 4, raw.base64EncodedString() == publicKey,
      (try? P256.Signing.PublicKey(x963Representation: raw)) != nil
    else { return nil }
    return String(SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined().prefix(16))
  }
}

/// The keys trusted now and the kids retired for good (`ReleaseTrust` in the protocol).
public struct ReleaseKeyring: Equatable, Codable, Sendable {
  public var keys: [ReleaseKey]
  public var retired: [String]
  public init(keys: [ReleaseKey], retired: [String]) {
    self.keys = keys
    self.retired = retired
  }

  public enum UpdateRefusal: String, Error, Equatable, Sendable { case wouldEmpty = "would_empty", addsRetired = "adds_retired" }

  /// After a verified manifest's key update: its adds (never a retired kid) joined, its retires removed and remembered for good.
  /// Refused, with the keyring unchanged, when it would leave no key (`applyKeyUpdate` in the protocol).
  public func applying(_ u: ReleaseManifest.KeyUpdate) -> Result<ReleaseKeyring, UpdateRefusal> {
    let retiredNow = Set(retired).union(u.retire)
    if u.add.contains(where: { retiredNow.contains($0.kid) }) { return .failure(.addsRetired) }
    var all = keys
    for a in u.add where !all.contains(where: { $0.kid == a.kid }) { all.append(a) }
    let left = all.filter { !retiredNow.contains($0.kid) }
    guard !left.isEmpty else { return .failure(.wouldEmpty) }
    return .success(ReleaseKeyring(keys: left, retired: retiredNow.sorted()))
  }
}

/// The release keys this build trusts.
public enum ReleaseTrust {
  /// The owner's release key, created 2026-11-15 in Delphi's Secure Enclave with apps/desktop/scripts/release-key.swift create
  /// (cannot be copied; docs/desktop.md has the loss case). Same list as RELEASE_KEYS in packages/protocol/src/release-manifest.ts.
  public static let keys: [ReleaseKey] = [ReleaseKey(kid: "a2602db8dcbc13c5", publicKey: "BL4AZLKsJrNlosGGjWiDg4LXEP0H1elOWpYdJRJQk40MZ00bAeQblxPelC7aaWEsDRUxfAaaTKlcOcTWfu6pem8=")]
  /// The committed TEST key's public half (packages/protocol/fixtures/release-manifest/test-key.json). Tests pass it in; the app never.
  public static let testKeys: [ReleaseKey] = [
    ReleaseKey(kid: "6525d5cf268c7497", publicKey: "BCXinZCnOOOafAOfzAsuRKfBGVxzRuna+9MWEFfmVp/gPjz4od8odDfwWt0q62XszgXr07SXFEdyBQI4Vr0k23o=")
  ]
}

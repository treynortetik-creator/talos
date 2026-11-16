import CryptoKit
import Foundation
import Testing
@testable import TalosDesktopCore

/// The signed release manifest, the Mac's half: the shared vectors (packages/protocol/fixtures/release-manifest/vectors.json, which the
/// protocol's suite holds to hand-written expectations) must give the same answer here, case by case, rotations included.
@Suite("Release manifest")
struct ReleaseManifestTests {
  static func dir() -> URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.appending(path: "packages/protocol/fixtures/release-manifest")
  }

  static func vectors() throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: dir().appending(path: "vectors.json"))) as? [String: Any])
  }

  static func keys() throws -> [String: [String: String]] {
    try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: dir().appending(path: "test-key.json"))) as? [String: Any])
      .compactMapValues { $0 as? [String: String] }
  }

  static func ring(_ v: Any?) throws -> ReleaseKeyring {
    try JSONDecoder().decode(ReleaseKeyring.self, from: JSONSerialization.data(withJSONObject: try #require(v)))
  }

  @Test func everyVectorGivesTheProtocolsAnswer() throws {
    let v = try Self.vectors()
    let trust = try Self.ring(v["trust"])
    #expect(trust.keys == ReleaseTrust.testKeys)
    let cases = try #require(v["manifests"] as? [[String: Any]])
    #expect(cases.count >= 25)
    for c in cases {
      let name = c["name"] as? String ?? "?"
      let json = Data((c["json"] as? String ?? "").utf8)
      let sig = Data((c["sig"] as? String ?? "").utf8)
      let want = c["expect"] as? String
      switch ReleaseManifest.verify(json, sig: sig, trust: trust) {
      case .success(let m):
        #expect(want == "ok", "\(name): accepted, the protocol says \(want ?? "?")")
        let p = try #require(try JSONSerialization.jsonObject(with: json) as? [String: Any])
        #expect(m.kid == p["kid"] as? String && m.version == p["version"] as? String && m.gitSha == p["git_sha"] as? String)
        #expect(m.size == (p["size"] as? NSNumber)?.intValue && m.zipSha256 == p["zip_sha256"] as? String)
        #expect((m.keys != nil) == (p["keys"] != nil), "\(name): the key update is read")
      case .failure(let r):
        #expect("\(r)" == want, "\(name): \(r), the protocol says \(want ?? "?")")
      }
    }
  }

  @Test func everyRotationGivesTheProtocolsAnswer() throws {
    let rows = try #require(try Self.vectors()["rotations"] as? [[String: Any]])
    #expect(rows.count == 4)
    for r in rows {
      let before = try Self.ring(r["before"])
      let u = try #require(r["update"] as? [String: Any])
      let update = ReleaseManifest.KeyUpdate(
        add: (u["add"] as? [[String: String]] ?? []).map { ReleaseKey(kid: $0["kid"]!, publicKey: $0["pub"]!) },
        retire: u["retire"] as? [String] ?? [])
      let want = try #require(r["expect"] as? [String: Any])
      switch before.applying(update) {
      case .success(let after):
        #expect(want["ok"] as? Bool == true, "\(r["name"] ?? "")")
        #expect(after == (try Self.ring(want["after"])), "\(r["name"] ?? "")")
      case .failure(let why):
        #expect(want["why"] as? String == why.rawValue, "\(r["name"] ?? "")")
      }
    }
  }

  @Test func theKidIsTheFirst16HexOfThePointsSha256() throws {
    for (_, k) in try Self.keys() { #expect(ReleaseKey.kid(of: k["public_key"]!) == k["kid"]) }
    #expect(ReleaseKey.kid(of: "") == nil)
    #expect(ReleaseKey.kid(of: Data(repeating: 4, count: 65).base64EncodedString()) == nil, "not a point")
  }

  @Test func theSignerWritesLowSAndItsTwinIsRefused() throws {
    let k = try #require(try Self.keys()["test"])
    let key = try P256.Signing.PrivateKey(pemRepresentation: k["private_pkcs8_pem"]!)
    let v = try Self.vectors()
    let good = try #require((v["manifests"] as? [[String: Any]])?.first { $0["name"] as? String == "good" })
    let json = Data((good["json"] as! String).utf8)
    let trust = try Self.ring(v["trust"])
    var sawHigh = false
    for _ in 0..<40 {
      let raw = try key.signature(for: Data(ReleaseManifest.domain.utf8) + json).rawRepresentation
      sawHigh = sawHigh || !ReleaseManifest.isLowS(raw)
      let low = ReleaseManifest.lowS(raw)
      #expect(ReleaseManifest.isLowS(low))
      #expect((try? ReleaseManifest.verify(json, sig: Data(low.base64EncodedString().utf8), trust: trust).get()) != nil)
      if !ReleaseManifest.isLowS(raw) {
        #expect(ReleaseManifest.verify(json, sig: Data(raw.base64EncodedString().utf8), trust: trust) == .failure(.nonCanonicalSignature))
      }
    }
    #expect(sawHigh, "CryptoKit gives high-S signatures too, so the signer's low-S step matters")
  }

  @Test func theDecisionsMatch() throws {
    let rows = try #require(try Self.vectors()["decisions"] as? [[String: String]])
    #expect(rows.count == 8)
    for r in rows {
      let m = ReleaseManifest(
        kid: "0000000000000000", version: r["version"]!, gitSha: String(repeating: "0", count: 40), tag: "v1",
        minAppVersion: r["min_app_version"]!, zipUrl: "https://example.com/Talos-1.zip", zipName: "Talos-1.zip",
        zipSha256: String(repeating: "a", count: 64), size: 1, teamId: "ABCDE12345", publishedAt: "2026-11-14T20:00:00Z")
      #expect(m.decision(running: r["running"]!).rawValue == r["expect"], "\(r)")
    }
  }

  @Test func versionsCompareAsNumbers() {
    #expect(ReleaseManifest.compare("1.10.0", "1.9.0") == 1)
    #expect(ReleaseManifest.compare("2.0.0", "10.0.0") == -1)
    #expect(ReleaseManifest.compare("1.0", "1.0.0") == nil)
    #expect(ReleaseManifest.compare("1.0.\u{0661}", "1.0.1") == nil, "a digit of another script is not a digit")
  }

  @Test func theRealKeysArePinnedNeverATestKey() {
    #expect(ReleaseTrust.keys.map(\.kid) == ["a2602db8dcbc13c5"])
    #expect(!ReleaseTrust.keys.contains { k in ReleaseTrust.testKeys.contains { $0.kid == k.kid } })
  }

  /// The pinned lists, read from the protocol's own source: the Mac and the publisher must trust the same keys.
  @Test func theSwiftAndTypeScriptPinsAreTheSame() throws {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    let ts = try String(contentsOf: url.appending(path: "packages/protocol/src/release-manifest.ts"), encoding: .utf8)
    func pinned(_ name: String) throws -> [ReleaseKey] {
      let start = try #require(ts.range(of: "export const \(name): readonly ReleaseKey[] = ["))
      let end = try #require(ts.range(of: "]", range: start.upperBound..<ts.endIndex))
      let body = String(ts[start.upperBound..<end.lowerBound])
      let re = try Regex(#"\{\s*kid:\s*'([0-9a-f]{16})',\s*publicKey:\s*'([A-Za-z0-9+/=]{88})',?\s*\}"#)
      return body.matches(of: re).map { m in
        ReleaseKey(kid: String(m.output[1].substring ?? ""), publicKey: String(m.output[2].substring ?? ""))
      }
    }
    #expect(try pinned("RELEASE_KEYS") == ReleaseTrust.keys)
    #expect(try pinned("RELEASE_TEST_KEYS") == ReleaseTrust.testKeys)
    #expect(!ReleaseTrust.testKeys.isEmpty)
  }
}

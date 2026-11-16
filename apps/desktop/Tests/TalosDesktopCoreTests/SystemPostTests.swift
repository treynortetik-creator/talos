import CryptoKit
import Foundation
import Testing
@testable import TalosDesktopCore

/// The Mac's own signed system row is the bridge's: `Fixtures/bridge-system-post.json` is made by the protocol's own signing code
/// (and `packages/protocol/test/bridge-system-post-fixture.test.ts` checks it still is), with RFC 8032's published test key.
@Suite struct SystemPostTests {
  struct Fixture: Decodable {
    struct KeyFile: Decodable {
      var pkcs8: String
      var `public`: String
      var key_id: String
    }
    var key_file: KeyFile
    var method: String
    var path: String
    var ts: Int
    var nonce: String
    var body: String
    var signing_string: String
    var authorization: String
  }

  static let fixtureURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/bridge-system-post.json")

  private func fixture() throws -> (Fixture, Data) {
    let data = try Data(contentsOf: Self.fixtureURL)
    let o = try #require((try JSONSerialization.jsonObject(with: data)) as? [String: Any])
    let keyFile = try JSONSerialization.data(withJSONObject: ["v": 1].merging(o["key_file"] as? [String: Any] ?? [:]) { a, _ in a })
    return (try JSONDecoder().decode(Fixture.self, from: data), keyFile)
  }

  @Test func theBridgeKeyFileIsReadAsTheBridgeReadsIt() throws {
    let (f, keyFile) = try fixture()
    let key = try #require(SystemPost.key(keyFile))
    #expect(key.keyId == f.key_file.key_id)
    // a file whose public key is not the private key's is refused, never signed with
    var o = try #require((try JSONSerialization.jsonObject(with: keyFile)) as? [String: Any])
    o["public"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    #expect(SystemPost.key(try JSONSerialization.data(withJSONObject: o)) == nil)
    #expect(SystemPost.key(Data("{not json".utf8)) == nil && SystemPost.key(nil) == nil)
  }

  @Test func theSigningStringAndTheHeaderAreTheBridgesAndTheSignatureChecks() throws {
    let (f, keyFile) = try fixture()
    let key = try #require(SystemPost.key(keyFile))
    let body = Data(f.body.utf8)
    #expect(SystemPost.signingString(method: f.method, path: f.path, ts: f.ts, nonce: f.nonce, body: body) == f.signing_string)
    let mine = try #require(SystemPost.authorization(key: key, method: f.method, path: f.path, ts: f.ts, nonce: f.nonce, body: body))
    let prefix = { (h: String) in h.components(separatedBy: ",sig=")[0] }
    #expect(prefix(mine) == prefix(f.authorization))
    let rawPub = try #require(DeviceKeys.base64url(f.key_file.public))
    let pub = try Curve25519.Signing.PublicKey(rawRepresentation: rawPub)
    let sig = { (h: String) in DeviceKeys.base64url(h.components(separatedBy: ",sig=")[1]) ?? Data() }
    #expect(pub.isValidSignature(sig(f.authorization), for: Data(f.signing_string.utf8)), "the bridge's signature checks with the Mac's key")
    #expect(pub.isValidSignature(sig(mine), for: Data(f.signing_string.utf8)), "the Mac's signature checks with the bridge's key")
  }

  @Test func theBodyIsTheBridgesReplyFrame() throws {
    let (f, _) = try fixture()
    let now = Date(timeIntervalSince1970: 1_794_304_800)
    let bodyData = try #require(SystemPost.body(thread: "inbox", text: "Main keeps crashing", now: now))
    let mine = try #require((try JSONSerialization.jsonObject(with: bodyData)) as? [String: Any])
    let theirs = try #require((try JSONSerialization.jsonObject(with: Data(f.body.utf8))) as? [String: Any])
    #expect(Set(mine.keys) == Set(theirs.keys))
    let m = try #require(mine["message"] as? [String: Any])
    let t = try #require(theirs["message"] as? [String: Any])
    #expect(Set(m.keys) == Set(t.keys))
    for k in ["thread_id", "author", "kind", "text", "format", "via", "created_at"] {
      #expect(m[k] as? String == t[k] as? String, "\(k)")
    }
    #expect(mine["type"] as? String == "reply" && mine["ts"] as? String == theirs["ts"] as? String)
    let ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/
    #expect((mine["id"] as? String)?.wholeMatch(of: ulid) != nil)
    #expect((m["id"] as? String).map { $0.hasPrefix("m_") && String($0.dropFirst(2)).wholeMatch(of: ulid) != nil } == true)
  }

  @Test func theRequestGoesOnlyToASecureRelayAndAThreadId() throws {
    let (_, keyFile) = try fixture()
    let key = try #require(SystemPost.key(keyFile))
    let r = try #require(SystemPost.request(relayUrl: "https://relay.example.com/", key: key, thread: "inbox", text: "x", now: Date()))
    #expect(r.url?.absoluteString == "https://relay.example.com/bridge/post" && r.httpMethod == "POST")
    #expect(r.value(forHTTPHeaderField: "authorization")?.hasPrefix("TalosBridge key_id=\(key.keyId),ts=") == true)
    #expect(SystemPost.request(relayUrl: "http://relay.example.com", key: key, thread: "inbox", text: "x", now: Date()) == nil)
    #expect(SystemPost.request(relayUrl: "http://localhost:8787", key: key, thread: "inbox", text: "x", now: Date()) != nil)
    #expect(SystemPost.request(relayUrl: "https://relay.example.com", key: key, thread: "../x", text: "x", now: Date()) == nil)
  }

  @Test func theRelayUrlIsTheBridgesOwn() {
    let file = Data("# relay\nexport TALOS_APP_RELAY_URL=\"https://relay.example.com\"\n".utf8)
    #expect(SystemPost.relayUrl(bridgeEnv: file, env: [:]) == "https://relay.example.com")
    #expect(SystemPost.relayUrl(bridgeEnv: file, env: ["TALOS_APP_RELAY_URL": "https://other.example.com"]) == "https://other.example.com")
    #expect(SystemPost.relayUrl(bridgeEnv: nil, env: [:]) == nil)
  }
}

import CryptoKit
import Foundation

/// A system row in a thread, posted by the Mac itself, signed with the bridge key, with no `talos-app` and no `config.json`: the
/// way to the phone when Main and its bridge are down and `config.json` may be what is broken. The Mac twin of the bridge's
/// `system-post.ts` (Linux supervisor): the same reply frame, the same signed `POST /bridge/post` (`signBridgeHttp`, spec 5.4).
/// `Tests/Fixtures/bridge-system-post.json`, made by the protocol's own code and checked by its test, pins both.
///
/// The key is `$TALOS_APP_HOME/bridge.key`, the file the bridge itself signs with, read by the same user: nothing new is exposed.
/// It has no command line, and its callers give it only the app's own fixed lines (never the agent's name or screen text), so a
/// row it posts says only what the app says.
public enum SystemPost {
  /// Where a line goes when `config.json` names no thread (or cannot be read): every Talos has it.
  public static let fallbackThread = "inbox"
  static let domain = "talos-bridge-http/v1"
  static let path = "/bridge/post"

  public struct Key: Sendable {
    let privateKey: Curve25519.Signing.PrivateKey
    public let keyId: String
  }

  /// `bridge.key`: `{v: 1, pkcs8, public, key_id}`, PKCS8 Ed25519 in base64url. Nil unless the private key, the public key
  /// and the key id all agree.
  public static func key(_ data: Data?) -> Key? {
    guard let data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      let p = o["pkcs8"] as? String, let raw = DeviceKeys.base64url(p), let pub = o["public"] as? String,
      let kid = o["key_id"] as? String
    else { return nil }
    // PKCS8 for Ed25519 is this 16-byte header and the 32-byte seed (RFC 8410)
    let header: [UInt8] = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]
    guard raw.count == 48, Array(raw.prefix(16)) == header,
      let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw.suffix(32))
    else { return nil }
    let pubRaw = k.publicKey.rawRepresentation
    guard DeviceKeys.base64url(pub) == pubRaw, keyId(pubRaw) == kid else { return nil }
    return Key(privateKey: k, keyId: kid)
  }

  /// First 16 hex characters of sha256(raw public key), as `bridgeKeyId`.
  static func keyId(_ rawPublicKey: Data) -> String {
    String(SHA256.hash(data: rawPublicKey).map { String(format: "%02x", $0) }.joined().prefix(16))
  }

  /// `bridgeHttpString`: domain, method, path, unix seconds, nonce and the body's sha256, one per line.
  static func signingString(method: String, path: String, ts: Int, nonce: String, body: Data) -> String {
    let h = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
    return [domain, method.uppercased(), path, String(ts), nonce, h].joined(separator: "\n")
  }

  /// The `Authorization` header: `TalosBridge key_id=<kid>,ts=<unix>,nonce=<b64url>,sig=<b64url>`.
  static func authorization(key: Key, method: String, path: String, ts: Int, nonce: String, body: Data) -> String? {
    let s = signingString(method: method, path: path, ts: ts, nonce: nonce, body: body)
    guard let sig = try? key.privateKey.signature(for: Data(s.utf8)) else { return nil }
    return "TalosBridge key_id=\(key.keyId),ts=\(ts),nonce=\(nonce),sig=\(b64url(sig))"
  }

  /// The `reply` frame of `system-post.ts`: a system text row, `via: headless`.
  static func body(thread: String, text: String, now: Date) -> Data? {
    let at = ISOTime.string(now.timeIntervalSince1970)
    let message: [String: Any] = [
      "id": "m_" + ulid(now), "thread_id": thread, "author": "system", "kind": "text", "text": text, "format": "plain",
      "attachments": [Any](), "via": "headless", "created_at": at,
    ]
    let frame: [String: Any] = ["v": 1, "id": ulid(now), "ts": at, "type": "reply", "message": message]
    return try? JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys, .withoutEscapingSlashes])
  }

  /// The signed request for `text` in `thread`, or nil when it cannot be made (no usable relay URL, key or thread id).
  public static func request(relayUrl: String, key: Key, thread: String, text: String, now: Date) -> URLRequest? {
    guard WorkerSpec.isThreadId(thread), !text.isEmpty, let base = secureBase(relayUrl), let url = URL(string: base + path),
      let body = body(thread: thread, text: text, now: now)
    else { return nil }
    var nonceBytes = [UInt8](repeating: 0, count: 16)
    guard SecRandomCopyBytes(kSecRandomDefault, nonceBytes.count, &nonceBytes) == errSecSuccess,
      let auth = authorization(
        key: key, method: "POST", path: path, ts: Int(now.timeIntervalSince1970), nonce: b64url(Data(nonceBytes)), body: body)
    else { return nil }
    var r = URLRequest(url: url, timeoutInterval: 30)
    r.httpMethod = "POST"
    r.httpBody = body
    r.setValue("application/json", forHTTPHeaderField: "content-type")
    r.setValue(auth, forHTTPHeaderField: "authorization")
    return r
  }

  /// `TALOS_APP_RELAY_URL` without trailing slashes, only https (plain http only for localhost), as `assertSecureRelayUrl`.
  static func secureBase(_ s: String) -> String? {
    var t = s.trimmingCharacters(in: .whitespaces)
    while t.hasSuffix("/") { t.removeLast() }
    guard let u = URL(string: t), let host = u.host, !host.isEmpty else { return nil }
    if u.scheme == "https" { return t }
    if u.scheme == "http", ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) { return t }
    return nil
  }

  /// `TALOS_APP_RELAY_URL` from `bridge.env`, as the bridge reads it (the launch environment wins over the file).
  public static func relayUrl(bridgeEnv: Data?, env: [String: String]) -> String? {
    if let v = env["TALOS_APP_RELAY_URL"], !v.isEmpty { return v }
    return bridgeEnv.flatMap { RelayConfig.envValue("TALOS_APP_RELAY_URL", in: String(decoding: $0, as: UTF8.self)) }
  }

  static func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// A ULID: 48 bits of unix milliseconds and 80 random bits, Crockford base32 (no I, L, O, U).
  static func ulid(_ now: Date) -> String {
    let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)
    var ms = UInt64(max(0, now.timeIntervalSince1970 * 1000))
    var time = [UInt8](repeating: 0, count: 10)
    for i in (0..<10).reversed() {
      time[i] = alphabet[Int(ms & 31)]
      ms >>= 5
    }
    var rnd = [UInt8](repeating: 0, count: 10)
    _ = SecRandomCopyBytes(kSecRandomDefault, rnd.count, &rnd)
    var out = time
    var buffer: UInt32 = 0
    var bits = 0
    for b in rnd {
      buffer = (buffer << 8) | UInt32(b)
      bits += 8
      while bits >= 5 {
        bits -= 5
        out.append(alphabet[Int((buffer >> UInt32(bits)) & 31)])
      }
    }
    return String(decoding: out, as: UTF8.self)
  }
}

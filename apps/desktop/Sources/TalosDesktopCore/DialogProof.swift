import CryptoKit
import Foundation

/// Needs-you prompts: who may answer. An answer file can be written by any program that runs as the owner, the agent included, so its
/// content is never authority. The Mac presses only after the owner's OWN signature on the tap checks out (the steps are the contract's, in
/// packages/protocol/src/dialog-files.ts `DialogAnswer`), against the Mac's own record of the dialog.
///
/// Where the signer's key comes from is `DeviceKeys.pinnedKey`, one function. It reads devices.json, the bridge's file of paired devices.
/// That file is agent-writable like the rest of the owner's home: the guard on it is the bridge's tripwire (it alerts when the file changes
/// outside the app), not the operating system. A different key source changes that one function.
public enum DeviceKeys {
  private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567".utf8)

  /// `d_` and the first 20 characters of the lowercase RFC 4648 base32 (no padding) of SHA-256 of the key's DER SubjectPublicKeyInfo.
  public static func deviceId(of key: P256.Signing.PublicKey) -> String {
    let digest = Array(SHA256.hash(data: key.derRepresentation))
    var out: [UInt8] = []
    var buffer = 0, bits = 0
    for b in digest {
      buffer = (buffer << 8) | Int(b)
      bits += 8
      while bits >= 5 {
        out.append(alphabet[(buffer >> (bits - 5)) & 31])
        bits -= 5
      }
      buffer &= (1 << bits) - 1
    }
    if bits > 0 { out.append(alphabet[(buffer << (5 - bits)) & 31]) }
    return "d_" + String(decoding: out.prefix(20), as: UTF8.self)
  }

  static func base64url(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
  }

  /// A P-256 public key from a JWK's `x` and `y` (base64url, 32 bytes each); nil when they are not a point on the curve.
  public static func publicKey(x: String, y: String) -> P256.Signing.PublicKey? {
    guard let xd = base64url(x), let yd = base64url(y), xd.count == 32, yd.count == 32 else { return nil }
    return try? P256.Signing.PublicKey(x963Representation: Data([4]) + xd + yd)
  }

  /// The key of a device paired and not revoked in devices.json (any object with a `devices` array, as the bridge reads it: `{id, name, pubkey_jwk, pinned_at, revoked_at?}` entries),
  /// and only when it is that id's key. A file that is missing, unreadable, a link, big, or not in that shape has no signer; an id with any
  /// revoked entry (the bridge keeps a tombstone) has none either.
  public static func pinnedKey(_ deviceId: String, devicesPath: String) -> P256.Signing.PublicKey? {
    guard DialogAnswerRequest.isDeviceId(deviceId), case .data(let d) = SmallFile.read(path: devicesPath, maxBytes: 256 * 1024),
      let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      let devices = root["devices"] as? [[String: Any]]
    else { return nil }
    let mine = devices.filter { $0["id"] as? String == deviceId }
    guard !mine.isEmpty, !mine.contains(where: { $0["revoked_at"] != nil && !($0["revoked_at"] is NSNull) }) else { return nil }
    for e in mine {
      guard let jwk = e["pubkey_jwk"] as? [String: Any], jwk["kty"] as? String == "EC", jwk["crv"] as? String == "P-256",
        let x = jwk["x"] as? String, let y = jwk["y"] as? String, let key = publicKey(x: x, y: y), Self.deviceId(of: key) == deviceId
      else { continue }
      return key
    }
    return nil
  }
}

public enum DialogProofCheck {
  /// What the Mac itself recorded of the dialog on a pane (never re-read from workers.json, which anyone can write).
  public struct Pane: Equatable, Sendable {
    public var thread: String
    public var dialogId: String
    public var kind: DialogReader.Kind
    public var subject: String?
    public var options: [String]
    public init(thread: String, dialogId: String, kind: DialogReader.Kind, subject: String?, options: [String]) {
      self.thread = thread
      self.dialogId = dialogId
      self.kind = kind
      self.subject = subject
      self.options = options
    }
  }

  public struct Env {
    public var pinnedKey: (String) -> P256.Signing.PublicKey?
    public var nowMs: Double
    public var pane: Pane
    /// The Mac already pressed something for this dialog id.
    public var alreadyPressed = false
    /// The label the screen shows now at an option's place; nil skips the screen check (the key loop makes it again, key by key).
    public var screenLabel: ((Int) -> String?)?
    public init(pinnedKey: @escaping (String) -> P256.Signing.PublicKey?, nowMs: Double, pane: Pane, alreadyPressed: Bool = false, screenLabel: ((Int) -> String?)? = nil) {
      self.pinnedKey = pinnedKey
      self.nowMs = nowMs
      self.pane = pane
      self.alreadyPressed = alreadyPressed
      self.screenLabel = screenLabel
    }
  }

  public enum Verdict: Equatable, Sendable {
    /// Every step passed. `choice` and `label` are the signed choice and its label from the Mac's own record; nil for a login dialog.
    case ok(choice: Int?, label: String?, deviceId: String)
    /// Nothing is pressed. `step` is the contract's step that failed (0: not for this pane).
    case no(reason: DialogResult.Reason, step: Int)
  }

  static let maxAgeMs: Double = 15 * 60_000
  static let maxFutureMs: Double = 2 * 60_000

  public static func verify(_ a: DialogAnswerRequest, env: Env) -> Verdict {
    let proof = a.proof
    func no(_ step: Int, _ reason: DialogResult.Reason = .unverified) -> Verdict { .no(reason: reason, step: step) }
    guard ExactText.equal(a.dialogId, env.pane.dialogId) else { return no(0) }
    // 1: a device paired and not revoked, and its key is that device's
    guard let key = env.pinnedKey(proof.deviceId), DeviceKeys.deviceId(of: key) == proof.deviceId else { return no(1) }
    // 2: the owner's signature over the exact text
    guard let raw = DeviceKeys.base64url(proof.osig), raw.count == 64, let sig = try? P256.Signing.ECDSASignature(rawRepresentation: raw),
      key.isValidSignature(sig, for: Data("talos-owner/v1\n\(proof.deviceId)\n\(hex(proof.signed))".utf8))
    else { return no(2) }
    // 3: what was signed
    guard let signed = object(proof.signed), signed["type"] as? String == "card.resolve", signed["action"] as? String == "primary",
      signed["edited"] == nil, signed["device_id"] as? String == proof.deviceId
    else { return no(3) }
    var choice: Int?
    if let c = signed["choice"] {
      guard let i = JSONValue.int(c), (0...5).contains(i) else { return no(3) }
      choice = i
    }
    guard let ts = (signed["ts"] as? String).flatMap(ISOTime.parse).map({ $0 * 1000 }), env.nowMs - ts <= maxAgeMs, ts - env.nowMs <= maxFutureMs
    else { return no(3) }
    // 4: the card that was shown is the dialog on the pane
    guard "sha256:" + hex(proof.binding) == signed["payload_hash"] as? String, let binding = object(proof.binding),
      binding["kind"] as? String == "dialog", binding["id"] as? String == signed["card_id"] as? String, binding["id"] is String,
      binding["thread_id"] as? String == env.pane.thread, let payload = binding["payload"] as? [String: Any],
      payload["thread"] as? String == env.pane.thread, ExactText.equal(payload["dialog_id"] as? String, env.pane.dialogId),
      payload["dialog_kind"] as? String == env.pane.kind.rawValue, sameSubject(payload["subject"], env.pane.subject),
      payload["options"] as? [String] != nil, ExactText.equal(payload["options"] as? [String] ?? [], env.pane.options)
    else { return no(4) }
    // 5: the option, on the screen now, once
    var label: String?
    if env.pane.kind == .login {
      guard choice == nil, a.action == .open else { return no(5) }
    } else {
      guard let c = choice, c < env.pane.options.count else { return no(5) }
      label = env.pane.options[c]
    }
    if env.alreadyPressed { return no(5, .alreadyAnswered) }
    if let c = choice, let label, let screen = env.screenLabel, screen(c) != label { return no(5, .screenChanged) }
    return .ok(choice: choice, label: label, deviceId: proof.deviceId)
  }

  private static func sameSubject(_ v: Any?, _ mine: String?) -> Bool {
    guard let mine else { return v is NSNull }
    return ExactText.equal(v as? String, mine)
  }

  private static func hex(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }

  private static func object(_ s: String) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] }
}

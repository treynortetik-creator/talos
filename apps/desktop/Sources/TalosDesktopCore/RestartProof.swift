import CryptoKit
import Foundation

/// The owner's proof in agent-request.json (`proof`, frames.ts `AgentRequestProof`): the device, its signature, and the exact bytes it
/// signed, `ownerSignedString` of the phone's `agent.recover` frame as the bridge received it. The Mac hashes those bytes as they are; it
/// never rebuilds them from fields, so nothing here can come out different from what the phone signed.
public struct RestartProof: Equatable, Sendable {
  public var deviceId: String
  public var osig: String
  public var signed: Data
  public init(deviceId: String, osig: String, signed: Data) {
    self.deviceId = deviceId
    self.osig = osig
    self.signed = signed
  }
}

/// Whether a restart request is the owner's: only when its proof checks out here, against devices.json, for this very request. What it
/// stops: a forged owner request from anything without a paired phone's key (a script, a prompt-injected session, a stray write). What it
/// is not: a wall. devices.json is writable by anything running as the owner, so a process that adds its own device can sign for it.
public enum RestartProofCheck {
  /// The frame's own `ts`, by the clock the caller gives (the wall clock, as the dialog proof's): at most this old,
  public static let maxAgeMs: Double = 5 * 60_000
  /// and at most this far ahead.
  public static let maxFutureMs: Double = 2 * 60_000

  /// The check that failed, for the audit log (`restart_proof_bad step=`). Never carries key or signature material.
  public enum Step: String, Equatable, Sendable {
    /// The `proof` field is not the shape.
    case shape
    /// Not a device paired and not revoked in devices.json, or the key is not that id's.
    case device
    case signature
    /// What was signed is not exactly one canonical `agent.recover` with action `restart` by that device.
    case frame
    /// It was signed for another request.
    case controlId = "control_id"
    /// This proof was already decided on, or it is signed no later than the newest one this app accepted (a replay).
    case used
  }

  /// Why a proof the owner's device really signed for this request, never seen before, is still not taken as the owner's word now. Each
  /// goes the agent's way with a line of its own: none of them is a forgery.
  public enum Unaccepted: String, Equatable, Sendable {
    /// Older than `maxAgeMs` or more than `maxFutureMs` ahead of this Mac's clock (or not a time at all): most likely the phone's clock.
    case skew = "time_skew"
    /// Signed before this app started: nothing from before the launch is remembered for certain, so it is not the owner's word now.
    case beforeLaunch = "time_before_launch"
    /// Signed at or before the newest proof this app accepted (another phone's clock, or one that stepped back): a real tap whose time
    /// cannot be told from a replay's.
    case beforeMark = "time_before_mark"
    /// What was signed holds a value this version does not canonicalise (a nested object or array, a non-integer number): a newer phone,
    /// whose bytes this app cannot check are the canonical ones.
    case unknownForm = "form_unknown"
  }

  public enum Verdict: Equatable, Sendable {
    /// Every check passed. `usedKey` is what to record as used (`DialogProofsUsed`), `signedMs` the frame's own time, before anything is
    /// done for it.
    case ok(deviceId: String, usedKey: String, signedMs: Double)
    /// The device, the signature, what was signed and the request all check out; only the signed time does not.
    case outOfTime(usedKey: String, signedMs: Double?, Unaccepted)
    case no(Step)
  }

  /// The used-proof key: its own namespace (a dialog answer's key starts with its dialog id), and the signed bytes, not the signature's
  /// spelling, so a copy of the same tap spelled another way is the same tap.
  public static func usedKey(_ p: RestartProof) -> String {
    "restart|" + SHA256.hash(data: p.signed).map { String(format: "%02x", $0) }.joined()
  }

  /// `launchedAtMs`: when this app started (wall clock); `markMs`: the newest signed time of a proof this app accepted (0 for none).
  public static func verify(
    _ p: RestartProof, controlId: String, nowMs: Double, launchedAtMs: Double = 0, markMs: Double = 0,
    pinnedKey: (String) -> P256.Signing.PublicKey?, isUsed: (String) -> Bool
  ) -> Verdict {
    switch OwnerSignature.check(signed: p.signed, osig: p.osig, deviceId: p.deviceId, pinnedKey: pinnedKey) {
    case .device?: return .no(.device)
    case .signature?: return .no(.signature)
    case nil: break
    }
    guard let o = (try? JSONSerialization.jsonObject(with: p.signed)) as? [String: Any] else { return .no(.frame) }
    let form = canonical(o)
    if let form, form != p.signed { return .no(.frame) }
    guard JSONValue.int(o["v"]) == 1, exact(o["type"], "agent.recover"), exact(o["action"], "restart"), exact(o["device_id"], p.deviceId)
    else { return .no(.frame) }
    guard exact(o["control_id"], controlId) else { return .no(.controlId) }
    let key = usedKey(p)
    // a key already spent is a true replay; everything below is a real tap this app only does not take as the owner's word
    if isUsed(key) { return .no(.used) }
    let ts = (o["ts"] as? String).flatMap(ISOTime.parse).map { $0 * 1000 }
    if form == nil { return .outOfTime(usedKey: key, signedMs: ts, .unknownForm) }
    guard let ts, nowMs - ts <= maxAgeMs, ts - nowMs <= maxFutureMs else { return .outOfTime(usedKey: key, signedMs: ts, .skew) }
    if ts < launchedAtMs { return .outOfTime(usedKey: key, signedMs: ts, .beforeLaunch) }
    if markMs > 0, ts <= markMs { return .outOfTime(usedKey: key, signedMs: ts, .beforeMark) }
    return .ok(deviceId: p.deviceId, usedKey: key, signedMs: ts)
  }

  /// `restart-proof-mark.json`: `{"v":1,"signed_ms":<n>}`, the newest signed time accepted. Nil for anything else.
  public static func readMark(_ d: Data?) -> Double? {
    guard let d, d.count <= 256, let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      let n = o["signed_ms"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue >= 0
    else { return nil }
    return n.doubleValue
  }

  public static func encodeMark(_ ms: Double) -> Data {
    (try? JSONSerialization.data(withJSONObject: ["v": 1, "signed_ms": Int(ms)], options: [.sortedKeys])) ?? Data()
  }

  /// RFC 8785 (JCS, packages/protocol/src/canonical.ts) for exactly what a signed frame holds: an object of strings, integers, true, false
  /// and null. Keys sorted by UTF-16 code units; strings escaped as JCS does (`"` and `\\`, the short forms of backspace, tab, newline, form
  /// feed and carriage return, other characters below U+0020 as `\\u00xx`, everything else as itself); integers in plain decimal. Nil
  /// when the object holds anything else (a nested object or array, a non-integer number, an integer too big to be exact): this version
  /// cannot say what its canonical bytes are, which is not the same as saying they are wrong.
  public static func canonical(_ o: [String: Any]) -> Data? {
    var out = "{"
    for (i, k) in o.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }).enumerated() {
      guard let v = value(o[k] as Any) else { return nil }
      out += (i == 0 ? "" : ",") + string(k) + ":" + v
    }
    return Data((out + "}").utf8)
  }

  private static func value(_ v: Any) -> String? {
    if v is NSNull { return "null" }
    if let s = v as? String { return string(s) }
    guard let n = v as? NSNumber else { return nil }
    if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
    let d = n.doubleValue
    guard d.isFinite, d.rounded() == d, abs(d) <= 9_007_199_254_740_991 else { return nil }
    if CFNumberIsFloatType(n) {
      return d == 0 ? "0" : String(Int64(d))
    }
    return String(n.int64Value)
  }

  private static func string(_ s: String) -> String {
    var out = "\""
    for u in s.unicodeScalars {
      switch u.value {
      case 0x22: out += "\\\""
      case 0x5C: out += "\\\\"
      case 0x08: out += "\\b"
      case 0x09: out += "\\t"
      case 0x0A: out += "\\n"
      case 0x0C: out += "\\f"
      case 0x0D: out += "\\r"
      case 0..<0x20: out += String(format: "\\u%04x", u.value)
      default: out.unicodeScalars.append(u)
      }
    }
    return out + "\""
  }

  /// Byte for byte (Swift's `==` on strings compares canonically equivalent forms as equal).
  private static func exact(_ v: Any?, _ want: String) -> Bool {
    guard let s = v as? String else { return false }
    return Array(s.utf8) == Array(want.utf8)
  }
}

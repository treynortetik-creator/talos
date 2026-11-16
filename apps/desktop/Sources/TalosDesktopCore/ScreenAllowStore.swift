import CryptoKit
import Foundation

/// The owner's tap on "Let your agent control <app> on this Mac?": the exact text the owner's device signed (the `card.resolve`
/// frame), its signature, the device, and the card's binding (canonical JSON) whose hash the frame commits to. The bridge hands it
/// over on the screen socket (`allow`); the Mac checks it and keeps it with the entry, so every entry proves itself whenever it is read.
public struct ScreenAllowProof: Equatable, Sendable {
  public var signed: String
  public var osig: String
  public var deviceId: String
  public var binding: String
  public init(signed: String, osig: String, deviceId: String, binding: String) {
    self.signed = signed
    self.osig = osig
    self.deviceId = deviceId
    self.binding = binding
  }

  /// `{signed, osig, device_id, binding}`, exactly; nil for anything else.
  public static func parse(_ v: Any?) -> ScreenAllowProof? {
    guard let o = v as? [String: Any], Set(o.keys) == ["signed", "osig", "device_id", "binding"], let s = o["signed"] as? String,
      (1...4096).contains(s.utf8.count), let sig = o["osig"] as? String, sig.utf8.count == 86, let d = o["device_id"] as? String,
      DialogAnswerRequest.isDeviceId(d), let b = o["binding"] as? String, (1...16384).contains(b.utf8.count)
    else { return nil }
    return ScreenAllowProof(signed: s, osig: sig, deviceId: d, binding: b)
  }

  var json: [String: Any] { ["signed": signed, "osig": osig, "device_id": deviceId, "binding": binding] }

  /// The key a removal remembers: the signed bytes, not the signature's spelling (a copy spelled another way is the same tap).
  public var key: String { SHA256.hash(data: Data(signed.utf8)).map { String(format: "%02x", $0) }.joined() }
}

/// Whether a proof is the owner allowing one app. What it stops: an entry written into the file by anything without a paired
/// phone's key (a script, a prompt-injected session). What it is not: a wall. devices.json and this file are both writable by
/// anything running as the owner, so a process that adds its own device can sign for it; the bridge's tripwire on devices.json is
/// the guard there, as for the dialog answers and restart requests.
public enum ScreenAllowProofCheck {
  /// A tap handed over later than this after it was signed is not taken (the card itself lives a day).
  public static let maxAgeMs: Double = 25 * 3600_000
  public static let maxFutureMs: Double = 2 * 60_000

  public enum Step: String, Error, Equatable, Sendable {
    case device, signature
    /// Not one primary, unedited `card.resolve` by that device.
    case frame
    /// Signed too long ago or too far ahead (only when handed over, never when the file is read again).
    case time
    /// The card that was signed is not one screen-allow card, or its app is not complete.
    case binding
    /// Talos itself: never on the list.
    case talos
    /// The owner removed this very approval in Settings.
    case removed
  }

  /// `nowMs` nil: no time check (an entry read back from the file stays good after a day).
  public static func verify(
    _ p: ScreenAllowProof, nowMs: Double?, pinnedKey: (String) -> P256.Signing.PublicKey?
  ) -> Result<ScreenCodeIdentity, Step> {
    switch OwnerSignature.check(signed: Data(p.signed.utf8), osig: p.osig, deviceId: p.deviceId, pinnedKey: pinnedKey) {
    case .device?: return .failure(.device)
    case .signature?: return .failure(.signature)
    case nil: break
    }
    guard let signed = object(p.signed), signed["type"] as? String == "card.resolve", signed["action"] as? String == "primary",
      signed["edited"] == nil, signed["device_id"] as? String == p.deviceId, let cardId = signed["card_id"] as? String
    else { return .failure(.frame) }
    if let nowMs {
      guard let ts = (signed["ts"] as? String).flatMap(ISOTime.parse).map({ $0 * 1000 }), nowMs - ts <= maxAgeMs, ts - nowMs <= maxFutureMs
      else { return .failure(.time) }
    }
    let hash = SHA256.hash(data: Data(p.binding.utf8)).map { String(format: "%02x", $0) }.joined()
    guard signed["payload_hash"] as? String == "sha256:" + hash, let b = object(p.binding), b["kind"] as? String == "config",
      b["id"] as? String == cardId, let payload = b["payload"] as? [String: Any], let id = identity(payload)
    else { return .failure(.binding) }
    guard !ScreenCore.isTalos(id.bundleID) else { return .failure(.talos) }
    return .success(id)
  }

  /// The card's `payload`: `{v: 1, screen_allow: {bundle_id, team_id, requirement, name, signer}}`, exactly.
  static func identity(_ payload: [String: Any]) -> ScreenCodeIdentity? {
    guard Set(payload.keys) == ["v", "screen_allow"], JSONValue.int(payload["v"]) == 1, let a = payload["screen_allow"] as? [String: Any],
      Set(a.keys) == ["bundle_id", "team_id", "requirement", "name", "signer"], let b = a["bundle_id"] as? String,
      (1...255).contains(b.utf8.count), let r = a["requirement"] as? String, (1...4096).contains(r.utf8.count), let n = a["name"] as? String,
      (1...120).contains(n.count), let s = (a["signer"] as? String).flatMap(ScreenCodeIdentity.Signer.init(rawValue:))
    else { return nil }
    let team: String?
    switch a["team_id"] {
    case is NSNull: team = nil
    case let t as String where (1...20).contains(t.utf8.count): team = t
    default: return nil
    }
    return ScreenCodeIdentity(bundleID: b, teamID: team, requirement: r, name: n, signer: s)
  }

  private static func object(_ s: String) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] }
}

/// `<Talos home>/screen/allowed-apps.json`: the apps the owner allowed on this Mac. Talos.app is its only writer (an approval comes in
/// on the screen socket, a removal from Settings), one change at a time, written whole to a temp file and renamed, mode 0600, in a
/// 0700 folder that must not be a link. Not desktop.json.
///
/// Every process of the owner's can write that file, so it is sealed (review R1-3): `{"v":2,"body":"<json>","mac":"<base64>"}`, an
/// HMAC-SHA256 over the body with a key kept in the Keychain the way the launch seal keeps its key (`KeychainItem`). The same sealed
/// record holds the file's generation and the removal memory, so nothing a session can write decides what was removed: an edited
/// file, a copy from more than one change back, a deleted list or a record that can't be read allows no app, and Settings says so.
/// Every entry also keeps the owner's signed tap and is checked again on every read.
public final class ScreenAllowStore: ScreenAllowListProvider, @unchecked Sendable {
  public static func path(talosHome: String) -> String { talosHome + "/screen/allowed-apps.json" }
  public static let maxBytes = 512 * 1024
  /// Removals remembered (newest kept).
  public static let keepRemoved = 256
  public static let maxApps = 200

  public struct Snapshot: Equatable, Sendable {
    public var apps: [ScreenAllowedApp]
    /// Entries in the file that did not check out (a phone unpaired since). Not used.
    public var unverified: Int
    /// The file cannot be read or does not check out: nothing on it is used.
    public var unreadable: Bool
  }

  public enum AddError: Error, Equatable, Sendable {
    case proof(ScreenAllowProofCheck.Step)
    case full
    case write(String)

    public var text: String {
      switch self {
      case .proof(.talos): return "Talos itself can never be on the allowed list."
      case .proof(.removed): return "The owner removed or replaced that approval since; it is not used again."
      case .proof(.time): return "The approval came too late to use. Use the app again to ask the owner."
      case .proof(let s): return "The approval did not check out on this Mac (\(s.rawValue)), so nothing was allowed."
      case .full: return "This Mac's allowed list is full (\(ScreenAllowStore.maxApps) apps). Remove some in Settings first."
      case .write(let d): return "The allowed list could not be saved (\(d)), so nothing was allowed."
      }
    }
  }

  public let path: String
  let pinnedKey: (String) -> P256.Signing.PublicKey?
  let nowMs: () -> Double
  let keys: any ScreenListKeyStore
  /// The key store's name for this list: the file's path, hashed, so each Talos home has its own key and generation.
  let account: String
  private let lock = NSLock()
  /// Every approval this process removed or replaced: kept even when the file is replaced by a new list.
  private var removedHere: [String] = []

  public init(
    path: String, pinnedKey: @escaping (String) -> P256.Signing.PublicKey?, nowMs: @escaping () -> Double, keys: any ScreenListKeyStore
  ) {
    self.path = path
    self.pinnedKey = pinnedKey
    self.nowMs = nowMs
    self.keys = keys
    self.account = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// The real one: `devices.json` in the same home holds the phones' keys; the seal's key is in the Keychain.
  public static func live(talosHome: String) -> ScreenAllowStore {
    let devices = talosHome + "/devices.json"
    return ScreenAllowStore(
      path: path(talosHome: talosHome), pinnedKey: { DeviceKeys.pinnedKey($0, devicesPath: devices) },
      nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: KeychainListKeyStore())
  }

  public func allowedApps() -> [ScreenAllowedApp] { snapshot().apps }

  public func snapshot() -> Snapshot {
    lock.withLock { check(read()) }
  }

  /// Checks a tap and puts its app on the list. An earlier approval for the same app is remembered as replaced, so it cannot be
  /// handed over again later. Never throws.
  @discardableResult
  public func add(_ proof: ScreenAllowProof) -> Result<ScreenAllowedApp, AddError> {
    lock.withLock {
      var f = read()
      if f.unreadable { return .failure(.write("the list on this Mac doesn't check out; start a new list in Settings")) }
      if f.removed.contains(proof.key) || removedHere.contains(proof.key) { return .failure(.proof(.removed)) }
      let id: ScreenCodeIdentity
      switch ScreenAllowProofCheck.verify(proof, nowMs: nowMs(), pinnedKey: pinnedKey) {
      case .failure(let s): return .failure(.proof(s))
      case .success(let i): id = i
      }
      let replaced = f.entries.filter { ($0["bundle_id"] as? String) == id.bundleID }.compactMap { ScreenAllowProof.parse($0["proof"])?.key }
        .filter { $0 != proof.key }
      f.entries.removeAll { ($0["bundle_id"] as? String) == id.bundleID }
      guard f.entries.count < Self.maxApps else { return .failure(.full) }
      let at = ISOTime.string(nowMs() / 1000)
      f.entries.append(["bundle_id": id.bundleID, "added_at": at, "proof": proof.json])
      if let e = commit(f, removing: replaced) { return .failure(.write(e)) }
      return .success(Self.app(id, addedAt: at))
    }
  }

  /// Takes an app off the list, and remembers each of its approvals (in the sealed record, not the file) so a saved copy of one
  /// cannot put it back. On a list that does not check out, this starts a new, empty one (the owner asked for less, never more).
  public func remove(bundleID: String) throws(AddError) {
    let failed: String? = lock.withLock {
      var f = read()
      if f.unreadable { f.entries = [] }
      let gone = f.entries.filter { ($0["bundle_id"] as? String) == bundleID }.compactMap { ScreenAllowProof.parse($0["proof"])?.key }
      f.entries.removeAll { ($0["bundle_id"] as? String) == bundleID }
      return commit(f, removing: gone)
    }
    if let failed { throw .write(failed) }
  }

  /// Settings → Start a new list: an empty list sealed with a NEW key, so no earlier file (not even the one just before, which
  /// `read` would take as one change behind) can be put back; and every approval found in the file there now is remembered as
  /// removed. Asks the owner for nothing; the owner allows apps again card by card.
  public func startNewList() throws(AddError) {
    let failed: String? = lock.withLock {
      var found: [String] = []
      if case .data(let d) = SmallFile.read(path: path, maxBytes: Self.maxBytes),
        let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
        let body = (o["body"] as? String).flatMap({ try? JSONSerialization.jsonObject(with: Data($0.utf8)) }) as? [String: Any]
          ?? (o["apps"] != nil ? o : nil)
      {
        for e in (body["apps"] as? [Any]) ?? [] {
          // only an approval the owner really gave is worth remembering (the file is unsealed: anyone may have written it)
          if let p = ScreenAllowProof.parse((e as? [String: Any])?["proof"]),
            case .success = ScreenAllowProofCheck.verify(p, nowMs: nil, pinnedKey: pinnedKey)
          {
            found.append(p.key)
          }
        }
      }
      return commit(File(entries: [], removed: [], unreadable: false), removing: found, newKey: true, onlyRoomLeft: true)
    }
    if let failed { throw .write(failed) }
  }

  // MARK: file

  struct File {
    var entries: [[String: Any]]
    /// The removal memory, from the sealed record.
    var removed: [String]
    var unreadable: Bool
  }

  static let sealTag = "talos-screen-allow/v2\n"

  func sealed(_ body: Data) -> Data { Data((Self.sealTag + account + "\n").utf8) + body }

  func read() -> File {
    let bad = File(entries: [], removed: [], unreadable: true)
    guard case .success(let st) = keys.load(account: account) else { return bad }
    let ok = { (entries: [[String: Any]]) in File(entries: entries, removed: st.removed, unreadable: false) }
    switch SmallFile.read(path: path, maxBytes: Self.maxBytes) {
    case .absent:
      // a list was written before (the generation moved): a missing file is a removed one, not an empty list
      return st.generation == 0 ? ok([]) : bad
    case .invalid: return bad
    case .data(let d):
      guard let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], JSONValue.int(o["v"]) == 2,
        let bodyText = o["body"] as? String, let mac = (o["mac"] as? String).flatMap({ Data(base64Encoded: $0) })
      else { return bad }
      let body = Data(bodyText.utf8)
      guard HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: sealed(body), using: st.key),
        let b = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let g = JSONValue.int(b["generation"]), g >= 0,
        let apps = b["apps"] as? [Any]
      else { return bad }
      // the record's generation, or the one before it: the record is saved first, so a stop before the file was written leaves
      // the file one behind, and every approval that change took away is already in the removal memory. Anything older is refused.
      guard UInt64(g) == st.generation || UInt64(g) + 1 == st.generation else { return bad }
      return ok(apps.map { ($0 as? [String: Any]) ?? [:] })
    }
  }

  func check(_ f: File) -> Snapshot {
    var apps: [ScreenAllowedApp] = []
    var bad = 0
    for e in f.entries {
      guard let p = ScreenAllowProof.parse(e["proof"]), !f.removed.contains(p.key), !removedHere.contains(p.key),
        case .success(let id) = ScreenAllowProofCheck.verify(p, nowMs: nil, pinnedKey: pinnedKey),
        e["bundle_id"] as? String == id.bundleID, !apps.contains(where: { $0.bundleID == id.bundleID }),
        let added = (e["added_at"] as? String).flatMap(ISOTime.parse).map({ $0 * 1000 }), Self.timely(p, addedMs: added, nowMs: nowMs())
      else {
        bad += 1
        continue
      }
      apps.append(Self.app(id, addedAt: (e["added_at"] as? String) ?? ""))
    }
    return Snapshot(apps: apps.sorted { $0.name.lowercased() < $1.name.lowercased() }, unverified: bad, unreadable: f.unreadable)
  }

  /// An entry's times hang together: the tap was signed before it was added (by at most the tap's own window) and it was not added
  /// in the future.
  static func timely(_ p: ScreenAllowProof, addedMs: Double, nowMs: Double) -> Bool {
    guard let o = (try? JSONSerialization.jsonObject(with: Data(p.signed.utf8))) as? [String: Any],
      let ts = (o["ts"] as? String).flatMap(ISOTime.parse).map({ $0 * 1000 })
    else { return false }
    return addedMs - ts <= ScreenAllowProofCheck.maxAgeMs && ts - addedMs <= ScreenAllowProofCheck.maxFutureMs
      && addedMs - nowMs <= ScreenAllowProofCheck.maxFutureMs
  }

  /// Saves a change: the sealed record first (the new generation and the approvals taken away), then the file. nil when both were
  /// written; the reason when not. A stop between the two leaves the file one generation behind, which `read` accepts.
  /// `onlyRoomLeft`: what `removing` adds never pushes out a removal already remembered (it fills the room left, if any).
  func commit(_ f: File, removing: [String], newKey: Bool = false, onlyRoomLeft: Bool = false) -> String? {
    let dir = (path as NSString).deletingLastPathComponent
    mkdir(dir, 0o700)
    guard SafePath.isRealFolder(dir) else { return "\(dir) is not a folder of Talos's" }
    var st: ScreenListState
    switch keys.load(account: account) {
    case .failure(let e): return "the record that seals it can't be read: \(e.why)"
    case .success(let v): st = v
    }
    st.generation += 1
    if newKey { st.key = SymmetricKey(size: .bits256) }
    if onlyRoomLeft {
      let fresh = Self.dedup(removing).filter { !st.removed.contains($0) }
      st.removed += fresh.prefix(max(0, Self.keepRemoved - st.removed.count))
    } else {
      st.removed = Array(Self.dedup(st.removed + removing).suffix(Self.keepRemoved))
    }
    let body: [String: Any] = ["generation": NSNumber(value: st.generation), "apps": f.entries]
    guard let bodyData = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes]) else {
      return "it could not be encoded"
    }
    let mac = Data(HMAC<SHA256>.authenticationCode(for: sealed(bodyData), using: st.key))
    let o: [String: Any] = ["v": 2, "body": String(decoding: bodyData, as: UTF8.self), "mac": mac.base64EncodedString()]
    guard let data = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]) else {
      return "it could not be encoded"
    }
    if case .failure(let e) = keys.save(st, account: account) { return "the record that seals it could not be saved: \(e.why)" }
    removedHere += removing
    do { try AtomicFile.write(data, to: path, mode: 0o600) } catch { return "\(error)" }
    return nil
  }

  static func dedup(_ list: [String]) -> [String] {
    var seen = Set<String>()
    return list.filter { seen.insert($0).inserted }
  }

  static func app(_ id: ScreenCodeIdentity, addedAt: String) -> ScreenAllowedApp {
    ScreenAllowedApp(bundleID: id.bundleID, teamID: id.teamID, designatedRequirement: id.requirement, name: id.name, addedAt: addedAt)
  }
}

/// The apps the Mac measured when it refused one, by a random id the bridge asks back with (`ask_info`): the card's app, team and
/// requirement always come from the Mac's own measurement, never from what a session sends. Kept in memory for ten minutes.
public final class ScreenAskBook: @unchecked Sendable {
  public static let keepSeconds: Double = 600
  public static let maxAsks = 64
  private let lock = NSLock()
  private var asks: [(id: String, identity: ScreenCodeIdentity, at: Double)] = []
  let now: () -> Double

  public init(now: @escaping () -> Double = { Date().timeIntervalSince1970 }) { self.now = now }

  /// A new id for a measured app (the same app asked again gets a new id; both work until they age out).
  public func record(_ identity: ScreenCodeIdentity) -> String {
    let id = DialogOffer.newId()
    lock.withLock {
      let t = now()
      asks.removeAll { t - $0.at > Self.keepSeconds }
      asks.append((id, identity, t))
      if asks.count > Self.maxAsks { asks.removeFirst(asks.count - Self.maxAsks) }
    }
    return id
  }

  public func identity(_ id: String) -> ScreenCodeIdentity? {
    lock.withLock {
      let t = now()
      return asks.first { ExactText.equal($0.id, id) && t - $0.at <= Self.keepSeconds }?.identity
    }
  }
}

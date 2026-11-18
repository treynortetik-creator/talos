import CryptoKit
import Foundation
import Security
import TalosTestSupport
import Testing
@testable import TalosDesktopCore

/// Signed owner taps for the consent tests: a phone key made per run, pinned only through `pinned`.
enum ProofKit {
  static let phone = P256.Signing.PrivateKey()
  static let stranger = P256.Signing.PrivateKey()
  static var device: String { DeviceKeys.deviceId(of: phone.publicKey) }
  static func pinned(_ id: String) -> P256.Signing.PublicKey? { id == device ? phone.publicKey : nil }

  nonisolated(unsafe) static let notesApp: [String: Any] = [
    "bundle_id": "com.example.notes", "team_id": "ABCDE12345",
    "requirement": "anchor apple generic and identifier \"com.example.notes\" and certificate leaf[subject.OU] = ABCDE12345",
    "name": "Notes Example", "signer": "developer",
  ]

  static func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
  static func json(_ o: Any) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
  }
  static func hex(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }

  /// A tap on the card for `app`. Every part can be bent to make a bad one.
  static func proof(
    app: [String: Any] = notesApp, cardId: String = "c_screen1", kind: String = "config", action: String = "primary",
    ts: String = ISOTime.string(Date().timeIntervalSince1970), signer: P256.Signing.PrivateKey = phone, claimDevice: String? = nil,
    edited: Bool = false, payload: [String: Any]? = nil, hashOf: String? = nil, frameCard: String? = nil
  ) -> ScreenAllowProof {
    let binding = json([
      "id": cardId, "kind": kind, "thread_id": "general", "title": "Let your agent control \(app["name"] ?? "") on this Mac?",
      "payload": payload ?? ["v": 1, "screen_allow": app],
    ])
    let dev = claimDevice ?? DeviceKeys.deviceId(of: signer.publicKey)
    var frame: [String: Any] = [
      "type": "card.resolve", "card_id": frameCard ?? cardId, "action": action, "payload_hash": "sha256:" + hex(hashOf ?? binding),
      "device_id": dev, "ts": ts, "id": "f_\(UUID().uuidString)",
    ]
    if edited { frame["edited"] = true }
    let signed = json(frame)
    let sig = try! signer.signature(for: Data("talos-owner/v1\n\(dev)\n\(hex(signed))".utf8))
    return ScreenAllowProof(signed: signed, osig: b64url(sig.rawRepresentation), deviceId: dev, binding: binding)
  }
}

/// The seal's key store in memory: the real Keychain is never touched by a test.
final class FakeListKeys: ScreenListKeyStore, @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String: ScreenListState] = [:]
  var failure: String?
  var saveFailure: String?
  func load(account: String) -> Result<ScreenListState, ScreenListKeyError> {
    if let failure { return .failure(ScreenListKeyError(failure)) }
    return .success(lock.withLock {
      if let k = items[account] { return k }
      let k = ScreenListState(key: SymmetricKey(size: .bits256), generation: 0)
      items[account] = k
      return k
    })
  }
  func save(_ state: ScreenListState, account: String) -> Result<Void, ScreenListKeyError> {
    if let f = failure ?? saveFailure { return .failure(ScreenListKeyError(f)) }
    lock.withLock { items[account] = state }
    return .success(())
  }
  func state(_ account: String) -> ScreenListState? { lock.withLock { items[account] } }
  func set(_ s: ScreenListState, _ account: String) { lock.withLock { items[account] = s } }
}

struct TempHome {
  let dir: String
  let keys = FakeListKeys()
  init() {
    dir = NSTemporaryDirectory() + "talos-screen-\(UUID().uuidString.prefix(8))"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  }
  var listPath: String { ScreenAllowStore.path(talosHome: dir) }
  func store(now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) -> ScreenAllowStore {
    ScreenAllowStore(path: listPath, pinnedKey: ProofKit.pinned, nowMs: now, keys: keys)
  }
  func cleanup() { try? FileManager.default.removeItem(atPath: dir) }
}

@Suite("Screen consent: the allowed list proves itself")
struct ScreenAllowStoreTests {
  @Test func anOwnerTapPutsTheMeasuredAppOnTheListInAPrivateFile() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let r = s.add(ProofKit.proof())
    let app = try r.get()
    #expect(app.bundleID == "com.example.notes" && app.teamID == "ABCDE12345" && app.name == "Notes Example")
    #expect(app.designatedRequirement?.contains("ABCDE12345") == true)
    #expect(s.allowedApps() == [app])
    let st = try FileManager.default.attributesOfItem(atPath: h.listPath)
    #expect((st[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    let dst = try FileManager.default.attributesOfItem(atPath: (h.listPath as NSString).deletingLastPathComponent)
    #expect((dst[.posixPermissions] as? NSNumber)?.intValue == 0o700)
    #expect(!h.listPath.contains("desktop.json"))
  }

  @Test(arguments: [
    ("signed by a phone that is not paired", ProofKit.proof(signer: ProofKit.stranger), ScreenAllowProofCheck.Step.device),
    ("names the paired phone but another key signed", ProofKit.proof(signer: ProofKit.stranger, claimDevice: ProofKit.device), .signature),
    ("Not now, not Allow", ProofKit.proof(action: "kill"), .frame),
    ("an edited tap", ProofKit.proof(edited: true), .frame),
    ("a tap from three days ago", ProofKit.proof(ts: ISOTime.string(Date().timeIntervalSince1970 - 3 * 86400)), .time),
    ("another card's kind", ProofKit.proof(kind: "dialog"), .binding),
    ("the frame names another card", ProofKit.proof(frameCard: "c_other"), .binding),
    ("signed over another binding", ProofKit.proof(hashOf: "{}"), .binding),
    ("an app with a field missing", ProofKit.proof(payload: ["v": 1, "screen_allow": ["bundle_id": "com.example.notes"]]), .binding),
    ("a settings card's own payload", ProofKit.proof(payload: ["v": 1, "changes": []]), .binding),
  ])
  func aTapThatIsNotTheOwnerAllowingThatAppAllowsNothing(why: String, proof: ScreenAllowProof, step: ScreenAllowProofCheck.Step) {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    #expect(s.add(proof) == .failure(.proof(step)), "\(why)")
    #expect(s.allowedApps().isEmpty, "\(why)")
    #expect(!FileManager.default.fileExists(atPath: h.listPath), "\(why): nothing written")
  }

  /// R1-3: the file is sealed with a key only Talos.app can read. Any edit, an older copy put back, or the file deleted after a
  /// list existed allows nothing, and Settings says the list can't be read.
  @Test func anEditedFileAllowsNothing() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    _ = try s.add(ProofKit.proof()).get()
    // a session adds its own entry, a copy of the real one under another id
    var o = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: h.listPath))) as? [String: Any])
    var body = try #require(try JSONSerialization.jsonObject(with: Data((o["body"] as! String).utf8)) as? [String: Any])
    var apps = body["apps"] as! [[String: Any]]
    var copy = apps[0]
    copy["bundle_id"] = "com.example.secret"
    apps.append(copy)
    body["apps"] = apps
    o["body"] = String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
    try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: h.listPath))
    #expect(s.snapshot() == .init(apps: [], unverified: 0, unreadable: true))
    #expect(ScreenAllowedAppsModel(store: s).notes == [ScreenAllowedAppsModel.unreadableLine])
    // control: the lane 3 file with no seal at all is refused too
    try Data(#"{"v":1,"apps":[],"removed":[]}"#.utf8).write(to: URL(fileURLWithPath: h.listPath))
    #expect(s.snapshot().unreadable)
  }

  @Test func anOlderSealedCopyPutBackAfterARemovalAllowsNothing() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    _ = try s.add(ProofKit.proof()).get()
    let saved = try Data(contentsOf: URL(fileURLWithPath: h.listPath))
    try s.remove(bundleID: "com.example.notes")
    // one change back: the removal memory lives in the sealed record, so the app stays off
    try saved.write(to: URL(fileURLWithPath: h.listPath))
    let fresh = ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: h.keys)
    #expect(fresh.allowedApps().isEmpty, "a new process: nothing in memory, only the record")
    #expect(fresh.snapshot().unverified == 1)
    // two changes back: refused whole
    _ = try s.add(ProofKit.proof(app: ProofKit.notesApp.merging(["bundle_id": "com.example.other"]) { _, n in n }, cardId: "c_o")).get()
    try saved.write(to: URL(fileURLWithPath: h.listPath))
    #expect(fresh.snapshot() == .init(apps: [], unverified: 0, unreadable: true))
  }

  @Test func theRemovalMemoryIsInTheSealedRecordNotTheFile() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let p = ProofKit.proof()
    _ = try s.add(p).get()
    try s.remove(bundleID: "com.example.notes")
    #expect(h.keys.state(s.account)?.removed == [p.key])
    let file = try String(contentsOfFile: h.listPath, encoding: .utf8)
    #expect(!file.contains(p.key), "the file a session can write holds no removal memory")
    // a new process with the same record still refuses the removed tap
    let fresh = ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: h.keys)
    #expect(fresh.add(p) == .failure(.proof(.removed)))
  }

  @Test func aRecordThatCannotBeSavedChangesNothing() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    _ = try s.add(ProofKit.proof()).get()
    h.keys.saveFailure = "locked"
    #expect(throws: ScreenAllowStore.AddError.write("the record that seals it could not be saved: locked")) { try s.remove(bundleID: "com.example.notes") }
    h.keys.saveFailure = nil
    #expect(s.allowedApps().map(\.bundleID) == ["com.example.notes"], "still allowed, and said so")
  }

  @Test func aDeletedListIsNoticedNotTakenForANewOne() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    #expect(s.snapshot() == .init(apps: [], unverified: 0, unreadable: false), "no list yet is an empty one")
    _ = try s.add(ProofKit.proof()).get()
    try FileManager.default.removeItem(atPath: h.listPath)
    #expect(s.snapshot().unreadable)
    // the owner starts a new list; a tap removed before cannot come back through it
    try s.remove(bundleID: "")
    #expect(s.snapshot() == .init(apps: [], unverified: 0, unreadable: false))
  }

  /// R2-3: starting a new list must not leave the last list one generation behind (which `read` accepts).
  @Test func aNewListCannotBeUndoneByPuttingTheLastFileBack() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let p = ProofKit.proof()
    _ = try s.add(p).get()
    let last = try Data(contentsOf: URL(fileURLWithPath: h.listPath))
    let m = ScreenAllowedAppsModel(store: s)
    m.startNewList()
    #expect(m.rows.isEmpty && m.error == nil)
    try last.write(to: URL(fileURLWithPath: h.listPath))
    let fresh = ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: h.keys)
    #expect(fresh.allowedApps().isEmpty, "the last file came back")
    #expect(fresh.snapshot().unreadable, "sealed with the old key: it does not verify at all")
    // and each approval of that list is remembered: handed over again, it is refused
    try fresh.remove(bundleID: "")
    #expect(fresh.add(p) == .failure(.proof(.removed)))
  }

  /// R3-2: Start a new list reads an unsealed file; what it remembers from there must not push real removals out.
  @Test func plantedEntriesNeverEvictARealRemoval() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let real = ProofKit.proof()
    _ = try s.add(real).get()
    try s.remove(bundleID: "com.example.notes")
    // a session plants an unsealed file full of entries: forged ones, and real-looking ones signed by a phone not paired
    let fakes = (0..<300).map { i in
      ["bundle_id": "com.example.f\(i)", "added_at": "2026-11-12T10:00:00Z",
       "proof": ProofKit.proof(app: ProofKit.notesApp.merging(["bundle_id": "com.example.f\(i)"]) { _, n in n }, cardId: "c_f\(i)", signer: ProofKit.stranger).json] as [String: Any]
    }
    try JSONSerialization.data(withJSONObject: ["v": 1, "apps": fakes]).write(to: URL(fileURLWithPath: h.listPath))
    try s.startNewList()
    let st = try #require(h.keys.state(s.account))
    #expect(st.removed.contains(real.key), "the real removal is still remembered")
    #expect(st.removed.count == 1, "nothing that does not verify is remembered")
    let fresh = ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: h.keys)
    #expect(fresh.add(real) == .failure(.proof(.removed)))
  }

  @Test func evenVerifiedApprovalsFoundOnANewListOnlyFillTheRoomLeft() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let real = ProofKit.proof(cardId: "c_real")
    _ = try s.add(real).get()
    try s.remove(bundleID: "com.example.notes")
    let many = (0..<(ScreenAllowStore.keepRemoved + 10)).map { i in
      ["bundle_id": "com.example.v\(i)", "added_at": "2026-11-12T10:00:00Z",
       "proof": ProofKit.proof(app: ProofKit.notesApp.merging(["bundle_id": "com.example.v\(i)"]) { _, n in n }, cardId: "c_v\(i)").json] as [String: Any]
    }
    try JSONSerialization.data(withJSONObject: ["v": 1, "apps": many]).write(to: URL(fileURLWithPath: h.listPath))
    try s.startNewList()
    let st = try #require(h.keys.state(s.account))
    #expect(st.removed.first == real.key && st.removed.count == ScreenAllowStore.keepRemoved)
  }

  @Test func aSealWithNoKeyAllowsNothingAndSaysWhy() {
    let h = TempHome()
    defer { h.cleanup() }
    h.keys.failure = "the user denied access"
    let s = h.store()
    #expect(s.snapshot().unreadable)
    #expect(s.add(ProofKit.proof()) == .failure(.write("the list on this Mac doesn't check out; start a new list in Settings")))
  }

  @Test func aStopBetweenTheRecordAndTheFileKeepsTheRemoval() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    _ = try s.add(ProofKit.proof()).get()
    let saved = try Data(contentsOf: URL(fileURLWithPath: h.listPath))
    try s.remove(bundleID: "com.example.notes")
    // as if Talos stopped after saving the record and before writing the file: the file is one behind
    try saved.write(to: URL(fileURLWithPath: h.listPath))
    let fresh = ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: h.keys)
    #expect(!fresh.snapshot().unreadable && fresh.allowedApps().isEmpty)
  }

  @Test func aReplacedApprovalCannotBeHandedOverAgain() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let first = ProofKit.proof(cardId: "c_first")
    _ = try s.add(first).get()
    _ = try s.add(ProofKit.proof(cardId: "c_second")).get()
    #expect(s.add(first) == .failure(.proof(.removed)))
    #expect(s.allowedApps().count == 1)
  }

  @Test func entriesWhoseTimesDoNotHangTogetherAreNotUsed() {
    let tap = Date().timeIntervalSince1970 * 1000
    let p = ProofKit.proof(ts: ISOTime.string(tap / 1000))
    #expect(ScreenAllowStore.timely(p, addedMs: tap + 1000, nowMs: tap + 2000))
    #expect(!ScreenAllowStore.timely(p, addedMs: tap + 3 * 86_400_000, nowMs: tap + 3 * 86_400_000), "added days after the tap")
    #expect(!ScreenAllowStore.timely(p, addedMs: tap - 3_600_000, nowMs: tap), "added before it was tapped")
    #expect(!ScreenAllowStore.timely(p, addedMs: tap + 3_600_000, nowMs: tap), "added in the future")
  }

  @Test func theKeychainRecordsBytesRoundTripWithoutTouchingTheKeychain() {
    let k = ScreenListState(key: SymmetricKey(size: .bits256), generation: 0x0102_0304_0506, removed: ["ab", "cd"])
    let back = KeychainListKeyStore.decode(KeychainListKeyStore.encode(k))
    #expect(back?.generation == 0x0102_0304_0506 && back?.removed == ["ab", "cd"])
    #expect(back.map { $0.key.withUnsafeBytes { Data($0) } } == k.key.withUnsafeBytes { Data($0) })
    #expect(KeychainListKeyStore.decode(Data("{}".utf8)) == nil)
  }

  @Test func anEntryStaysGoodAfterADayButNotAfterItsPhoneIsUnpaired() throws {
    let h = TempHome()
    defer { h.cleanup() }
    var now = Date().timeIntervalSince1970 * 1000
    let s = ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { now }, keys: h.keys)
    _ = try s.add(ProofKit.proof()).get()
    now += 5 * 86_400_000
    #expect(s.allowedApps().count == 1, "read back with no time check")
    let unpaired = ScreenAllowStore(path: h.listPath, pinnedKey: { _ in nil }, nowMs: { now }, keys: h.keys)
    #expect(unpaired.allowedApps().isEmpty)
    #expect(unpaired.snapshot().unverified == 1)
  }

  @Test func removingAnAppKeepsASavedCopyOfItsApprovalFromPuttingItBack() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let p = ProofKit.proof()
    _ = try s.add(p).get()
    let saved = try Data(contentsOf: URL(fileURLWithPath: h.listPath))
    try s.remove(bundleID: "com.example.notes")
    #expect(s.allowedApps().isEmpty)
    // the socket path
    #expect(s.add(p) == .failure(.proof(.removed)))
    // the file path: the older sealed file put back allows nothing (anOlderSealedCopyPutBackAfterARemovalAllowsNothing)
    _ = saved
    // a fresh tap from the owner still works
    #expect((try? s.add(ProofKit.proof(cardId: "c_screen2")).get())?.bundleID == "com.example.notes")
  }

  @Test func anUnreadableFileAllowsNothingAndRemoveStartsANewList() throws {
    let h = TempHome()
    defer { h.cleanup() }
    try FileManager.default.createDirectory(atPath: (h.listPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: URL(fileURLWithPath: h.listPath))
    let s = h.store()
    #expect(s.snapshot() == .init(apps: [], unverified: 0, unreadable: true))
    guard case .failure(.write) = s.add(ProofKit.proof()) else { Issue.record("an add over an unreadable file must fail in words"); return }
    let m = ScreenAllowedAppsModel(store: s)
    #expect(m.notes == [ScreenAllowedAppsModel.unreadableLine])
    m.startNewList()
    #expect(m.notes == [ScreenAllowedAppsModel.empty] && !m.unreadable)
    #expect((try? s.add(ProofKit.proof()).get()) != nil)
  }

  @Test func aLinkedFolderIsNeverWrittenThrough() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let elsewhere = h.dir + "/elsewhere"
    try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: h.dir + "/screen", withDestinationPath: elsewhere)
    let s = h.store()
    guard case .failure(.write(let why)) = s.add(ProofKit.proof()) else { Issue.record("wrote through a link"); return }
    #expect(why.contains("not a folder"))
    #expect(try FileManager.default.contentsOfDirectory(atPath: elsewhere).isEmpty)
  }

  @Test func twoApprovalsAtOnceBothLand() async throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let ids = (0..<12).map { "com.example.app\($0)" }
    await withTaskGroup(of: Void.self) { g in
      for (i, id) in ids.enumerated() {
        g.addTask {
          _ = s.add(ProofKit.proof(app: ProofKit.notesApp.merging(["bundle_id": id, "name": "App \(i)"]) { _, n in n }, cardId: "c_\(i)"))
        }
      }
    }
    #expect(Set(s.allowedApps().map(\.bundleID)) == Set(ids))
  }
}

@Suite("Screen consent: the signature, not the name")
struct ScreenSignatureGateTests {
  static let entry = ScreenAllowedApp(bundleID: "com.example.notes", teamID: "ABCDE12345", designatedRequirement: "x", name: "Notes")

  @Test func anAppClaimingAnAllowedIdWithAnotherSignatureIsAGapAndGetsNoInput() async throws {
    let sig = FakeSigning()
    sig.refusePIDs = [501]  // the "notes" process is an impostor
    let allowed = ScreenAllowed(apps: [Self.entry], signing: sig)
    let input = FakeInput()
    let apps = FakeApps(front: Fx.notes)
    apps.under = { _ in Fx.notes }
    let core = Fx.core(input: input, apps: apps)
    let shot = try await core.agentCapture(allowed: allowed)
    #expect(!(try colours(of: shot)).contains { near($0, .allowed) }, "the impostor's window must be a gap")
    #expect(shot.shownApps == [])
    #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.notes", subject: .running(pid: 501))) {
      try core.perform(.click(CGPoint(x: 50, y: 50)), allowed: allowed)
    }
    #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.notes", subject: .running(pid: 501))) {
      try core.perform(.type("hi"), allowed: allowed)
    }
    #expect(input.posted.isEmpty)
    // control: the real signature passes
    sig.refusePIDs = []
    let ok = ScreenAllowed(apps: [Self.entry], signing: sig)
    #expect(try core.perform(.type("hi"), allowed: ok) == 1)
  }

  @Test func openingChecksTheAppOnDiskAndOpensThatOne() async throws {
    let sig = FakeSigning()
    let apps = FakeApps(front: Fx.notes)
    let core = Fx.core(apps: apps)
    sig.refusePaths = ["/Apps/com.example.notes.app"]
    await #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.notes", subject: .installed(path: "/Apps/com.example.notes.app"))) {
      try await core.openApp(bundleID: "com.example.notes", allowed: ScreenAllowed(apps: [Self.entry], signing: sig))
    }
    #expect(apps.opened.isEmpty)
    sig.refusePaths = []
    try await core.openApp(bundleID: "com.example.notes", allowed: ScreenAllowed(apps: [Self.entry], signing: sig))
    #expect(apps.opened == ["com.example.notes"])
    apps.installed["com.example.notes"] = .some(nil)
    await #expect(throws: ScreenRefusal.openFailed(app: "com.example.notes", detail: "no app with that id is installed")) {
      try await core.openApp(bundleID: "com.example.notes", allowed: ScreenAllowed(apps: [Self.entry], signing: sig))
    }
  }

  @Test func eachProcessIsCheckedOncePerRequest() async throws {
    let sig = FakeSigning()
    var c = Fx.content()
    c.windows.insert(ScreenWindow(id: 21, ownerBundleID: "com.example.notes", ownerPID: 501, frame: CGRect(x: 0, y: 0, width: 10, height: 10)), at: 0)
    let core = Fx.core(capture: FakeCapture(c, colours: Fx.colours))
    _ = try await core.agentCapture(allowed: ScreenAllowed(apps: [Self.entry], signing: sig))
    #expect(sig.checks == [501])
  }
}

/// The real Security framework, on apps that ship with macOS and on throwaway bundles: read-only questions, no prompt.
@Suite("Screen consent: macOS signatures", .serialized)
struct LiveCodeSigningTests {
  static let textEdit = "/System/Applications/TextEdit.app"
  static let calculator = "/System/Applications/Calculator.app"

  func identity(_ path: String) throws -> ScreenCodeIdentity {
    guard case .signed(let id) = LiveCodeSigning().lookup(appPath: path) else { throw ScreenRefusal.badRequest("\(path) not signed") }
    return id
  }

  /// A bundle claiming TextEdit's id, with `/usr/bin/true` inside; ad-hoc signed when `sign`.
  func impostor(sign: Bool) throws -> (String, () -> Void) {
    let h = TempHome()
    let app = h.dir + "/TextEdit.app"
    try FileManager.default.createDirectory(atPath: app + "/Contents/MacOS", withIntermediateDirectories: true)
    let plist: [String: Any] = [
      "CFBundleIdentifier": "com.apple.TextEdit", "CFBundleExecutable": "TextEdit", "CFBundleName": "TextEdit", "CFBundlePackageType": "APPL",
    ]
    try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: URL(fileURLWithPath: app + "/Contents/Info.plist"))
    try FileManager.default.copyItem(atPath: "/usr/bin/true", toPath: app + "/Contents/MacOS/TextEdit")
    if sign {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
      p.arguments = ["--force", "--sign", "-", app]
      p.standardOutput = FileHandle.nullDevice
      p.standardError = FileHandle.nullDevice
      try p.run()
      p.waitUntilExit()
    } else {
      // /usr/bin/true carries Apple's signature: replace it with an unsigned script so nothing in the bundle is signed
      try FileManager.default.removeItem(atPath: app + "/Contents/MacOS/TextEdit")
      try Data("#!/bin/sh\nexit 0\n".utf8).write(to: URL(fileURLWithPath: app + "/Contents/MacOS/TextEdit"))
      chmod(app + "/Contents/MacOS/TextEdit", 0o755)
    }
    return (app, h.cleanup)
  }

  @Test func appleAppsAreMeasuredAsAppleWithTheirOwnRequirement() throws {
    let te = try identity(Self.textEdit)
    #expect(te.bundleID == "com.apple.TextEdit" && te.signer == .apple && te.teamID == nil)
    #expect(te.requirement.contains("com.apple.TextEdit"))
    let entry = ScreenAllowedApp(bundleID: te.bundleID, teamID: te.teamID, designatedRequirement: te.requirement)
    #expect(LiveCodeSigning().matches(appPath: Self.textEdit, app: entry))
    #expect(!LiveCodeSigning().matches(appPath: Self.calculator, app: entry), "another Apple app does not meet TextEdit's requirement")
    var none = entry
    none.designatedRequirement = nil
    #expect(!LiveCodeSigning().matches(appPath: Self.textEdit, app: none), "an entry with no requirement matches nothing")
    var otherTeam = entry
    otherTeam.teamID = "ZZZZZ99999"
    #expect(!LiveCodeSigning().matches(appPath: Self.textEdit, app: otherTeam))
  }

  @Test func anUnsignedAppClaimingTextEditsIdIsUnsignedAndNeverMatches() throws {
    let te = try identity(Self.textEdit)
    let (fake, done) = try impostor(sign: false)
    defer { done() }
    guard case .unsigned = LiveCodeSigning().lookup(appPath: fake) else {
      Issue.record("an unsigned bundle measured as \(LiveCodeSigning().lookup(appPath: fake))")
      return
    }
    let entry = ScreenAllowedApp(bundleID: te.bundleID, teamID: te.teamID, designatedRequirement: te.requirement)
    #expect(!LiveCodeSigning().matches(appPath: fake, app: entry))
  }

  @Test func anAdHocAppIsBoundToItsOwnBuildOnly() throws {
    let te = try identity(Self.textEdit)
    let (fake, done) = try impostor(sign: true)
    defer { done() }
    let me = try identity(fake)
    #expect(me.signer == .adhoc && me.bundleID == "com.apple.TextEdit" && me.requirement.hasPrefix("cdhash"))
    let teEntry = ScreenAllowedApp(bundleID: te.bundleID, teamID: te.teamID, designatedRequirement: te.requirement)
    #expect(!LiveCodeSigning().matches(appPath: fake, app: teEntry), "TextEdit's grant does not cover an app that claims its id")
    let own = ScreenAllowedApp(bundleID: me.bundleID, teamID: me.teamID, designatedRequirement: me.requirement)
    #expect(LiveCodeSigning().matches(appPath: fake, app: own))
    #expect(!LiveCodeSigning().matches(appPath: Self.textEdit, app: own), "and its own grant does not cover the real TextEdit")
  }

  @Test func aRunningProcessIsCheckedByItsPid() throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sleep")
    p.arguments = ["30"]
    try p.run()
    defer { p.terminate(); p.waitUntilExit() }
    let st = try #require(LiveCodeSigning.staticCode(path: "/bin/sleep"))
    var req: SecRequirement?
    var text: CFString?
    #expect(SecCodeCopyDesignatedRequirement(st, SecCSFlags(), &req) == errSecSuccess)
    #expect(SecRequirementCopyString(req!, SecCSFlags(), &text) == errSecSuccess)
    let sleepReq = text! as String
    let te = try identity(Self.textEdit)
    #expect(LiveCodeSigning().matches(pid: p.processIdentifier, app: ScreenAllowedApp(bundleID: "x", designatedRequirement: sleepReq)))
    #expect(!LiveCodeSigning().matches(pid: p.processIdentifier, app: ScreenAllowedApp(bundleID: "x", designatedRequirement: te.requirement)))
    #expect(!LiveCodeSigning().matches(pid: 999_999, app: ScreenAllowedApp(bundleID: "x", designatedRequirement: sleepReq)), "no such pid")
  }
}

@Suite("Screen consent: the socket asks and allows")
struct ScreenConsentProtocolTests {
  static let measured = ScreenCodeIdentity(
    bundleID: "com.example.secret", teamID: "QWERT12345", requirement: "anchor apple generic and identifier \"com.example.secret\"",
    name: "Secret Example", signer: .developer)

  func answer(_ p: ScreenProtocol, _ o: [String: Any]) async -> [String: Any] {
    let line = try! JSONSerialization.data(withJSONObject: o.merging(["v": 1]) { a, _ in a })
    return (try? JSONSerialization.jsonObject(with: await p.answer(line))) as? [String: Any] ?? [:]
  }
  func err(_ a: [String: Any]) -> [String: Any] { a["error"] as? [String: Any] ?? [:] }

  @Test func aRefusalAboutAMeasuredAppCarriesAnAskTheBridgeCanLookUp() async {
    let sig = FakeSigning()
    sig.lookups[502] = .signed(Self.measured)
    let apps = FakeApps(front: Fx.secret)
    let p = ScreenProtocol(service: Fx.core(apps: apps), allowList: EmptyScreenAllowList(), signing: sig)
    let a = await answer(p, ["id": "1", "op": "type", "text": "hi"])
    #expect(a["ok"] as? Bool == false)
    let e = err(a)
    #expect(e["code"] as? String == "app_not_allowed" && e["app"] as? String == "com.example.secret" && e["app_name"] as? String == "Secret Example")
    let ask = try! #require(e["ask"] as? String)
    let info = await answer(p, ["id": "2", "op": "ask_info", "ask": ask])
    #expect(info["ok"] as? Bool == true)
    #expect(info["bundle_id"] as? String == "com.example.secret" && info["team_id"] as? String == "QWERT12345")
    #expect(info["requirement"] as? String == Self.measured.requirement && info["signer"] as? String == "developer")
    // an id nobody was given
    let forged = await answer(p, ["id": "3", "op": "ask_info", "ask": "AAAAAAAAAAAAAAAAAAAAAA"])
    #expect(err(forged)["code"] as? String == "ask_unknown")
  }

  @Test func asksAgeOut() {
    var t = 1000.0
    let book = ScreenAskBook(now: { t })
    let id = book.record(Self.measured)
    #expect(book.identity(id) == Self.measured)
    t += ScreenAskBook.keepSeconds + 1
    #expect(book.identity(id) == nil)
  }

  @Test(arguments: [
    (ScreenCodeLookup.unsigned(name: "Loose Tool"), "app_not_allowable", "Loose Tool isn't signed, so it can't be put on this Mac's allowed list."),
    (.noBundleID(name: "Loose Tool"), "app_not_allowable", "Loose Tool has no app id, so it can't be put on this Mac's allowed list."),
    (.gone, "app_not_allowed", "com.example.secret isn't on this Mac's allowed list yet."),
  ])
  func anAppThatCanNeverBeAllowedIsSaidSoWithNoAsk(found: ScreenCodeLookup, code: String, text: String) async {
    let sig = FakeSigning()
    sig.lookups[502] = found
    let p = ScreenProtocol(service: Fx.core(apps: FakeApps(front: Fx.secret)), allowList: EmptyScreenAllowList(), signing: sig)
    let e = err(await answer(p, ["id": "1", "op": "key", "keys": "return"]))
    #expect(e["code"] as? String == code)
    #expect(e["text"] as? String == text)
    #expect(e["ask"] == nil)
  }

  @Test func theOwnersTapOnTheSocketAllowsTheAppAndInputThenGoesThrough() async throws {
    let h = TempHome()
    defer { h.cleanup() }
    let store = h.store()
    let input = FakeInput()
    let apps = FakeApps(front: Fx.notes)
    let p = ScreenProtocol(service: Fx.core(input: input, apps: apps), allowList: store, signing: FakeSigning(), store: store)
    #expect(err(await answer(p, ["id": "1", "op": "type", "text": "hi"]))["code"] as? String == "app_not_allowed")
    let ok = await answer(p, ["id": "2", "op": "allow", "proof": ProofKit.proof().json])
    #expect(ok["ok"] as? Bool == true && ok["bundle_id"] as? String == "com.example.notes")
    let typed = await answer(p, ["id": "3", "op": "type", "text": "hi"])
    #expect(typed["ok"] as? Bool == true)
    #expect(input.posted == [.text("hi")])
    // a forged tap over the socket allows nothing
    let bad = await answer(p, ["id": "4", "op": "allow", "proof": ProofKit.proof(app: ProofKit.notesApp.merging(["bundle_id": "com.example.secret"]) { _, n in n }, signer: ProofKit.stranger).json])
    #expect(err(bad)["code"] as? String == "allow_refused")
    #expect(store.allowedApps().map(\.bundleID) == ["com.example.notes"])
    let shapeless = await answer(p, ["id": "5", "op": "allow", "proof": ["signed": "x"]])
    #expect(err(shapeless)["code"] as? String == "bad_request")
  }

  @Test func aProcessWithNoStoreRefusesEveryAllow() async {
    let p = ScreenProtocol(service: Fx.core(), allowList: EmptyScreenAllowList(), signing: FakeSigning())
    #expect(err(await answer(p, ["id": "1", "op": "allow", "proof": ProofKit.proof().json]))["code"] as? String == "allow_refused")
  }
}

@Suite("Screen consent: Settings list")
struct ScreenAllowedAppsModelTests {
  @Test func listsTheAppsWithWhoSignedThemAndRemoves() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    let m = ScreenAllowedAppsModel(store: s)
    #expect(m.rows.isEmpty && m.notes == [ScreenAllowedAppsModel.empty])
    _ = try s.add(ProofKit.proof()).get()
    let adhoc = ProofKit.notesApp.merging(["bundle_id": "com.example.home", "name": "Home Build", "team_id": NSNull(), "requirement": "cdhash H\"00ff\"", "signer": "adhoc"]) { _, n in n }
    _ = try s.add(ProofKit.proof(app: adhoc, cardId: "c_2")).get()
    m.refresh()
    #expect(m.rows.map(\.name) == ["Home Build", "Notes Example"])
    #expect(m.rows.map(\.signedBy) == ["No developer signature: this exact build only", "Signed by developer team ABCDE12345"])
    #expect(m.rows.allSatisfy { $0.added.hasPrefix("Allowed ") })
    m.remove("com.example.notes")
    #expect(m.rows.map(\.bundleID) == ["com.example.home"] && m.error == nil)
    #expect(s.allowedApps().map(\.bundleID) == ["com.example.home"])
  }

  @Test func aFailedRemoveIsSaidNotSwallowed() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    _ = try s.add(ProofKit.proof()).get()
    let m = ScreenAllowedAppsModel(store: s)
    // the folder becomes a link: the write is refused
    let dir = (h.listPath as NSString).deletingLastPathComponent
    try FileManager.default.moveItem(atPath: dir, toPath: h.dir + "/moved")
    try FileManager.default.createSymbolicLink(atPath: dir, withDestinationPath: h.dir + "/moved")
    m.remove("com.example.notes")
    #expect(m.error?.hasPrefix("Couldn't remove it:") == true)
    #expect(m.rows.map(\.bundleID) == ["com.example.notes"], "still listed: it is still allowed")
  }

  @Test func theKnownGapIsSaidWhereAppsAreRemoved() {
    #expect(
      ScreenAllowedAppsModel.knownGap
        == "A program already running as you on this Mac could undo a Remove after Talos restarts. Talos asking again per app does not protect against that.")
  }

  @Test func unverifiedEntriesAreCountedInWords() {
    #expect(ScreenAllowedAppsModel.unverifiedLine(1).hasPrefix("1 entry in the list could not be checked"))
    #expect(ScreenAllowedAppsModel.unverifiedLine(2).contains("are not used"))
  }
}

/// The bridge's own output (packages/protocol/fixtures/screen-allow, written by apps/bridge/test/screen-consent.test.ts from a real
/// FakeApp tap through the real bridge): the Mac takes exactly what the bridge hands over, and nothing bent.
@Suite("Screen consent: the bridge's proof")
struct ScreenAllowFixtureTests {
  static let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/protocol/fixtures/screen-allow/allow-proof.json")

  func load() throws -> (ScreenAllowProof, (String) -> P256.Signing.PublicKey?, [String: Any]) {
    let o = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: Self.file)) as? [String: Any])
    let proof = try #require(ScreenAllowProof.parse(o["proof"]))
    let jwk = try #require(o["jwk"] as? [String: Any])
    let key = DeviceKeys.publicKey(x: jwk["x"] as? String ?? "", y: jwk["y"] as? String ?? "")
    return (proof, { $0 == proof.deviceId ? key : nil }, try #require(o["measured"] as? [String: Any]))
  }

  @Test func theBridgesProofChecksOutAndNamesTheMeasuredApp() throws {
    let (p, pinned, m) = try load()
    let id = try ScreenAllowProofCheck.verify(p, nowMs: nil, pinnedKey: pinned).get()
    #expect(id.bundleID == m["bundle_id"] as? String && id.teamID == m["team_id"] as? String)
    #expect(id.requirement == m["requirement"] as? String && id.name == m["name"] as? String && id.signer.rawValue == m["signer"] as? String)
  }

  @Test func anyBentByteIsRefused() throws {
    let (p, pinned, _) = try load()
    var b = p
    b.binding = p.binding.replacingOccurrences(of: "com.example.notes", with: "com.example.notez")
    #expect(ScreenAllowProofCheck.verify(b, nowMs: nil, pinnedKey: pinned) == .failure(.binding))
    var s = p
    s.signed = p.signed.replacingOccurrences(of: "primary", with: "kill")
    #expect(ScreenAllowProofCheck.verify(s, nowMs: nil, pinnedKey: pinned) == .failure(.signature))
    #expect(ScreenAllowProofCheck.verify(p, nowMs: nil, pinnedKey: { _ in nil }) == .failure(.device))
  }
}

/// R1-2: the desktop picture and icons are drawn in every agent capture, so only the real owners count, and only when macOS
/// says the process is Apple's own code. A process claiming a com.apple. id below level 0 is a gap.
@Suite("Screen capture: only macOS's own desktop")
struct ScreenDesktopSpoofTests {
  static let layer = -2_147_483_603

  @Test func onlyTheWallpaperDockAndFinderOwnersCount() {
    for b in ["com.apple.wallpaper.agent", "com.apple.dock", "com.apple.finder"] {
      #expect(ScreenWindow(id: 1, ownerBundleID: b, ownerPID: 1, frame: .zero, layer: Self.layer).isDesktop, "\(b)")
    }
    for b in ["com.apple.notificationcenterui", "com.apple.notreal", "com.apple.dockx", "com.example.dock", "COM.APPLE.DOCK"] {
      #expect(!ScreenWindow(id: 1, ownerBundleID: b, ownerPID: 1, frame: .zero, layer: Self.layer).isDesktop, "\(b)")
    }
    #expect(!ScreenWindow(id: 1, ownerBundleID: nil, ownerPID: 1, frame: .zero, layer: Self.layer).isDesktop)
  }

  @Test func aSpoofedDesktopWindowIsAGapInEveryAgentCapture() async throws {
    // a process that names itself com.apple.dock and draws below level 0, but is not Apple's code
    let spoof = ScreenWindow(id: 70, ownerBundleID: "com.apple.dock", ownerPID: 700, frame: CGRect(x: 0, y: 0, width: 400, height: 300), layer: -2_147_483_620)
    let claimed = ScreenWindow(id: 71, ownerBundleID: "com.apple.notreal", ownerPID: 701, frame: CGRect(x: 0, y: 0, width: 400, height: 300), layer: -2_147_483_620)
    // R2-5: Apple's own code (TextEdit, say) that names itself the Dock is not the Dock either
    let otherApple = ScreenWindow(id: 72, ownerBundleID: "com.apple.dock", ownerPID: 702, frame: CGRect(x: 0, y: 0, width: 400, height: 300), layer: -2_147_483_620)
    var c = Fx.content()
    c.windows.insert(contentsOf: [spoof, claimed, otherApple], at: 0)
    let cap = FakeCapture(c, colours: Fx.colours.merging([70: .magenta, 71: .magenta, 72: .magenta]) { a, _ in a })
    let sig = FakeSigning()
    sig.notApple = [700, 701]
    sig.realIDs[702] = "com.apple.TextEdit"
    let shot = try await Fx.core(capture: cap).agentCapture(allowed: ScreenAllowed(apps: [], signing: sig))
    #expect(!(try colours(of: shot)).contains { near($0, .magenta) }, "the spoofed window showed")
    #expect(try colours(of: shot).contains { near($0, .wallpaper) }, "control: the real wallpaper still shows")
    #expect(shot.hiddenWindows >= 2)
    guard case .display(_, let only?) = cap.plans.last?.source else { Issue.record("not a filtered plan"); return }
    #expect(!only.contains { $0.id == 70 || $0.id == 71 || $0.id == 72 })
  }

  @Test func macOSsOwnCheckOfAppleCode() throws {
    let real = Process()
    real.executableURL = URL(fileURLWithPath: "/bin/sleep")
    real.arguments = ["30"]
    try real.run()
    defer { real.terminate(); real.waitUntilExit() }
    #expect(LiveCodeSigning().isApple(pid: real.processIdentifier, identifier: "com.apple.sleep"))
    // R2-5: Apple's own code claiming another Apple program's id is not that program
    #expect(!LiveCodeSigning().isApple(pid: real.processIdentifier, identifier: "com.apple.dock"))
    #expect(!LiveCodeSigning().isApple(pid: real.processIdentifier, identifier: "com.apple.sleep\" or anchor apple generic and identifier \"x"))
    // the same program re-signed ad hoc is not Apple's code
    let h = TempHome()
    defer { h.cleanup() }
    let copy = h.dir + "/sleep"
    try FileManager.default.copyItem(atPath: "/bin/sleep", toPath: copy)
    let sign = Process()
    sign.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
    sign.arguments = ["--force", "--sign", "-", copy]
    sign.standardError = FileHandle.nullDevice
    try sign.run()
    sign.waitUntilExit()
    let fake = Process()
    fake.executableURL = URL(fileURLWithPath: copy)
    fake.arguments = ["30"]
    try fake.run()
    defer { fake.terminate(); fake.waitUntilExit() }
    #expect(!LiveCodeSigning().isApple(pid: fake.processIdentifier, identifier: "com.apple.sleep"))
    #expect(!LiveCodeSigning().isApple(pid: 999_999, identifier: "com.apple.sleep"))
  }
}

/// The allowed list over a real keychain: a throwaway one made here and deleted after (never the login keychain), as the launch
/// seal's own tests do. The record goes in and comes back, a removal outlives the process, and a new list re-keys.
@Suite("Screen consent: the record in a real (throwaway) keychain", .serialized, .keychainPromptsOff)
struct ScreenListKeychainTests {
  @Test func theRecordHoldsTheSealAndTheRemovalAcrossProcesses() throws {
    let k = try ThrowawayKeychain.make("list")
    defer { k.remove() }
    let kc = k.keychain
    let h = TempHome()
    defer { h.cleanup() }
    let keys = KeychainListKeyStore(service: "com.talos.test.screen-list.\(UUID().uuidString.lowercased())", keychain: kc)
    let make = { ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: keys) }
    let p = ProofKit.proof()
    _ = try make().add(p).get()
    #expect(make().allowedApps().map(\.bundleID) == ["com.example.notes"], "a second store reads the same record")
    try make().remove(bundleID: "com.example.notes")
    #expect(make().add(p) == .failure(.proof(.removed)), "the removal is in the keychain, not in memory")
    let saved = try Data(contentsOf: URL(fileURLWithPath: h.listPath))
    try make().startNewList()
    try saved.write(to: URL(fileURLWithPath: h.listPath))
    #expect(make().snapshot().unreadable, "a new list re-keyed the record")
  }
}

/// R2-1, accepted as a known gap (like the launch seal's): a program running as the owner can rewrite the list's keychain
/// record with Apple's `security` tool, no prompt, and then seal a file of its own; a removed approval comes back after Talos
/// restarts. What this watches is the seam, not the production record: a throwaway keychain made here, through the same
/// KeychainListKeyStore code. It goes red if that store stops being rewritable this way (a different store, or a record the tool
/// can't reach); it does not prove anything about the owner's login keychain.
@Suite("Screen consent: a record rewritten by another program", .keychainPromptsOff)
struct ScreenListRecordSwapTests {
  @Test func aRecordRewrittenByTheSecurityToolLetsARemovedApprovalBack() throws {
    let k = try ThrowawayKeychain.make("list")
    defer { k.remove() }
    let kc = k.keychain
    let h = TempHome()
    defer { h.cleanup() }
    let service = "com.talos.test.screen-list.\(UUID().uuidString.lowercased())"
    let keys = KeychainListKeyStore(service: service, keychain: kc)
    let make = { ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: keys) }
    let p = ProofKit.proof()
    _ = try make().add(p).get()
    try make().remove(bundleID: "com.example.notes")
    #expect(make().allowedApps().isEmpty)

    // the other program: a record it knows (its key, the next generation, nothing removed), then a file sealed with it
    let account = make().account
    let known = ScreenListState(key: SymmetricKey(data: Data((0..<32).map { UInt8($0) })), generation: 1)
    let hex = KeychainListKeyStore.encode(known).map { String(format: "%02x", $0) }.joined()
    let rewrote = try k.security(["add-generic-password", "-U", "-s", service, "-a", account, "-X", hex])
    try #require(rewrote == 0, "the security tool rewrote the record")
    try FileManager.default.removeItem(atPath: h.listPath)
    let forger = FakeListKeys()
    forger.set(ScreenListState(key: known.key, generation: 0), account)
    let forged = ScreenAllowStore(path: h.listPath, pinnedKey: ProofKit.pinned, nowMs: { Date().timeIntervalSince1970 * 1000 }, keys: forger)
    _ = try forged.add(p).get()

    // Talos restarts: a new store over the real record
    let restarted = make()
    withKnownIssue("a program running as the owner can rewrite the record and undo a Remove after a restart") {
      #expect(restarted.allowedApps().isEmpty, "the removed approval is allowed again")
    }
  }
}

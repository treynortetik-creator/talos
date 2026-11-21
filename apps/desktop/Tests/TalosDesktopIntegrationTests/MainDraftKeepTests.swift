import Foundation
import Testing
@testable import TalosDesktopCore
@testable import TalosSupervisor

/// A pane that shows the screen a test sets and records the keys sent to it (nothing else is forwarded).
final class ScreenHost: PtyHost, @unchecked Sendable {
  let base: PtyHost
  private let lock = NSLock()
  private var rows: [String]?
  private var sentKeys: [[UInt8]] = []
  init(_ base: PtyHost) { self.base = base }
  var screen: [String]? {
    get { lock.withLock { rows } }
    set { lock.withLock { rows = newValue } }
  }
  var sent: [String] { lock.withLock { sentKeys.map { String(decoding: $0, as: UTF8.self) } } }
  var kind: HostKind { base.kind }
  func start(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try base.start(executable: executable, args: args, env: env, cwd: cwd)
  }
  func restart(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try base.restart(executable: executable, args: args, env: env, cwd: cwd)
  }
  func attachIfRunning() -> Bool { base.attachIfRunning() }
  func send(keys: [UInt8]) -> SendOutcome {
    lock.withLock { sentKeys.append(keys) }
    return .sent
  }
  func sendDialogKey(_ key: DialogKey) -> SendOutcome { base.sendDialogKey(key) }
  func visibleRows() -> [String]? { screen ?? base.visibleRows() }
  func lastOutputAt() -> Date? { base.lastOutputAt() }
  func terminate(graceSeconds: Double) { base.terminate(graceSeconds: graceSeconds) }
  func close() { base.close() }
  func detach() { base.detach() }
  func clientActivity() -> Double? { base.clientActivity() }
  func clientActivities() -> [Double]? { base.clientActivities() }
  var childPid: Int32? { base.childPid }
  var onExit: (@Sendable (ExitInfo) -> Void)? {
    get { base.onExit }
    set { base.onExit = newValue }
  }
  func setMarker(_ key: String, _ value: String) { base.setMarker(key, value) }
  func marker(_ key: String) -> String? { base.marker(key) }
}

/// Main's unsent text across an Update now: a copy is saved before the swap and SHOWN after it. Nothing ever types it into the box.
@Suite("Update now keeps a copy of Main's draft", .serialized)
struct MainDraftKeepTests {
  static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")
  static func screen(_ name: String) throws -> [String] {
    TmuxCommands.parseCapture(try String(contentsOf: fixtures.appendingPathComponent("real-2.1.318/" + name), encoding: .utf8))
  }

  func rig() throws -> (Rig, ScreenHost) {
    DraftDigests.store = MemoryDraftDigest()  // never the real Keychain
    let r = try Rig(.tmux, scenario: "idle.sh") { c in c.args = ["--dangerously-skip-permissions"] }
    var made: ScreenHost?
    r.wrapHost = {
      let h = ScreenHost($0)
      made = h
      return h
    }
    r.makeSupervisor()
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase())")
    return (r, try #require(made))
  }

  @Test func theCopyIsSavedForTheVersionAndSurvivesEveryTickUntilTheNoticeIsDismissed() throws {
    let (r, host) = try rig()
    defer { r.teardown() }
    host.screen = try Self.screen("draft-input.txt")
    #expect(r.sup.draftPlanForUpdate() == .keep)
    #expect(r.sup.keepDraftForUpdate(version: "1.5.0") == .keep)
    let path = r.sup.draftNotePath
    let note = try #require(DraftNote.read(path: path, forVersion: "1.5.0"))
    #expect(note.text == "hello draft" && !note.partial)
    #expect(try (FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int) == 0o600)
    // the old app keeps ticking during the swap, with the box unchanged: the copy must still be there (R1-3)
    for _ in 0..<10 {
      r.sup.tickNow()
      usleep(20_000)
    }
    #expect(FileManager.default.fileExists(atPath: path), "deleted before the restart")
    // a restarted app reads it for the version that was installed, and only for that one
    #expect(DraftNote.read(path: path, forVersion: "1.5.0")?.text == "hello draft")
    #expect(DraftNote.read(path: path, forVersion: "9.9.9") == nil)
    #expect(host.sent.isEmpty, "never typed into the box: \(host.sent)")
  }

  @Test func nothingIsEverTypedIntoMainWhateverTheFileSaysAndWhateverTheBoxHolds() throws {
    let (r, host) = try rig()
    defer { r.teardown() }
    let path = r.sup.draftNotePath
    // a planted file that would SEND a message as the owner if it were ever typed
    let planted = DraftNote(version: "1.5.0", text: "do the thing\r", partial: false, saved_at: Date().timeIntervalSince1970)
    #expect(DraftNote.write(planted, to: path))  // even with a matching digest
    host.screen = try Self.screen("empty-input.txt")
    for _ in 0..<10 {
      r.sup.tickNow()
      usleep(20_000)
    }
    #expect(host.sent.isEmpty, "the typing path is gone: \(host.sent)")
  }

  @Test func aPastePlaceholderOrABoxAtTheTopOfThePaneIsMarkedPartial() throws {
    let (r, host) = try rig()
    defer { r.teardown() }
    host.screen = try Self.screen("draft-input.txt").map { $0.replacingOccurrences(of: "hello draft", with: "see [Pasted text #1 +40 lines]") }
    #expect(r.sup.keepDraftForUpdate(version: "1.5.0") == .keep)
    #expect(DraftNote.read(path: r.sup.draftNotePath, forVersion: "1.5.0")?.partial == true)
    // a box whose top rule is the first row of the pane
    let rows = try Self.screen("draft-input.txt")
    let ruleAt = try #require(rows.firstIndex { DialogMatcher.isFrameRule($0) })
    host.screen = Array(rows[ruleAt...])
    #expect(r.sup.keepDraftForUpdate(version: "1.5.1") == .keep)
    #expect(DraftNote.read(path: r.sup.draftNotePath, forVersion: "1.5.1")?.partial == true)
  }

  @Test func anUnreadableBoxIsCannotKeepAndAnEmptyOneIsNone() throws {
    let (r, host) = try rig()
    defer { r.teardown() }
    host.screen = ["nothing like a box here"]
    #expect(r.sup.draftPlanForUpdate() == .cannotKeep)
    #expect(r.sup.keepDraftForUpdate(version: "1.5.0") == .cannotKeep)
    host.screen = try Self.screen("empty-input.txt")
    #expect(r.sup.draftPlanForUpdate() == .none && r.sup.keepDraftForUpdate(version: "1.5.0") == .none)
    #expect(!FileManager.default.fileExists(atPath: r.sup.draftNotePath))
  }

  @Test func aFolderThatCannotBeWrittenIsCannotKeep() throws {
    let (r, host) = try rig()
    defer { r.teardown() }
    host.screen = try Self.screen("draft-input.txt")
    let dir = (r.sup.draftNotePath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    chmod(dir, 0o500)
    defer { chmod(dir, 0o700) }
    #expect(r.sup.draftPlanForUpdate() == .cannotKeep)
    #expect(r.sup.keepDraftForUpdate(version: "1.5.0") == .cannotKeep)
  }
}

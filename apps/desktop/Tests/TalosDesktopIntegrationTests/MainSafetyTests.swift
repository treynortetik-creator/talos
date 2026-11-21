import Foundation
import TalosDesktopCore
import Testing
import TalosTestSupport

@testable import TalosSupervisor

/// Main on the MCP server approval and on the Bypass Permissions disclaimer (pane-prompts rows 2 and 4), against `main-safety.sh`, which draws the real
/// captures and logs every key. Both are SAFETY questions: they become a Talos popup with the screen's own rows as buttons, nothing presses them by
/// itself, and only a click (the popup button's action, behind `NeedsYouPopupView.isRealClick`) reaches `popupAnswerMain`. The key goes through the key
/// gate, one arrow at a time from a fresh read.
@Suite("Main's safety questions are a popup", .serialized, .enabled(if: Rig.hasTmux))
struct MainSafetyTests {
  private func make(_ kind: String, quiet: Double? = nil, sticky: Bool = false) throws -> (Rig, KeyLog) {
    let keys = KeyLog()
    var t = Rig.defaultTimings()
    if let quiet { t.devDialogClientQuiet = quiet }
    var env = ["FAKE_DLG_KEYLOG": keys.path, "FAKE_SAFETY": kind]
    if sticky { env["FAKE_SAFETY_STICKY"] = "1" }
    let r = try Rig(.tmux, scenario: "main-safety.sh", env: env, timings: t)
    return (r, keys)
  }

  /// A tmux client attached to Main's pane, as an owner at the keys is (it is a client that `list-clients` reports).
  private func attachClient(_ r: Rig) throws -> Process {
    let client = Process()
    client.executableURL = URL(fileURLWithPath: "/usr/bin/script")
    client.arguments = ["-q", "/dev/null", Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "attach-session", "-t", "=agent"]
    client.environment = ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin", "HOME": r.home]
    client.standardInput = Pipe()
    client.standardOutput = FileHandle.nullDevice
    client.standardError = FileHandle.nullDevice
    try client.run()
    let listed = {
      !ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "list-clients", "-t", "=agent", "-F", "#{client_activity}"], env: ["PATH": "/usr/bin:/bin"]).out
        .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    #expect(r.wait(10) { listed() }, "control: the client attached")
    return client
  }

  private func click(_ r: Rig, _ item: NeedsYouPopupItem, _ choice: Int, label: String? = nil) -> PopupAnswerResult? {
    let box = ResultBox()
    r.sup.popupAnswerMain(dialogId: item.dialog.id, action: .choose(choice, label: label ?? item.dialog.options[choice])) { box.value = $0 }
    _ = r.wait(10) { box.value != nil }
    return box.value
  }

  @Test func theMcpQuestionIsAPopupNamingTheServerAndNothingPressesItByItself() throws {
    let (r, keys) = try make("mcp")
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil }, "audit: \(r.audit)")
    let item = try #require(r.sup.safetyPopupItem())
    let c = NeedsYouPopupContent.make(item)
    #expect(item.thread == Supervisor.mainPopupThread && c.title == "Use harmless?")
    #expect(c.buttons.map(\.text) == ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"])
    #expect(c.footer == "Answer it here.", "the phone was not told: \(c.footer)")
    #expect(FirstStartCheck.state(r.sup.status) == .safetyQuestion)
    #expect(Supervisor.opensTerminal(for: .dialog(DialogMatcher.Screen.mcpConsent.label)) == false, "no terminal beside it")
    Thread.sleep(forTimeInterval: 2)
    #expect(keys.keys.isEmpty, "nothing is pressed on the question by itself: \(keys.keys)")
    #expect(!r.allEvents.contains(.openTerminal))
    #expect(SupervisorNotice.mainDialog(DialogMatcher.Screen.mcpConsent.label) == "Claude is asking whether to trust this project's connected tools. Answer in the Talos popup")
  }

  @Test func aClickOnAllowIsTwoArrowsAndOneEnterEachReadBackAndTheOfferIsOnce() throws {
    let (r, keys) = try make("mcp")
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil }, "audit: \(r.audit)")
    let item = try #require(r.sup.safetyPopupItem())
    // a click that names another label (the offer or the screen changed) presses nothing
    #expect(click(r, item, 0, label: "Use all of them") == .nothing(.screenChanged))
    #expect(keys.keys.isEmpty)
    #expect(click(r, item, 0) == .pressed(choice: 0, label: "Use this MCP server"), "audit: \(r.audit)")
    _ = r.wait(5) { keys.keys.count >= 3 }
    #expect(keys.keys == ["UP", "UP", "ENTER"], "\(keys.keys)")
    // the same offer answered again presses nothing
    #expect(click(r, item, 2) == .nothing(.notOffered))
    #expect(keys.keys == ["UP", "UP", "ENTER"], "\(keys.keys)")
    #expect(r.audit.contains("main_safety_answered"))
  }

  @Test func aClickOnDenyIsJustEnterOnTheContinueWithoutRowAndMainKeepsRunning() throws {
    let (r, keys) = try make("mcp")
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil })
    let item = try #require(r.sup.safetyPopupItem())
    #expect(click(r, item, 2) == .pressed(choice: 2, label: "Continue without using this MCP server"))
    _ = r.wait(5) { !keys.keys.isEmpty }
    #expect(keys.keys == ["ENTER"])
    #expect(r.wait(10) { r.sup.safetyPopupItem() == nil }, "the popup goes once the question is answered")
    #expect(r.phase() != .stopped(.user))
  }

  @Test func theBypassDisclaimerIsAPopupWithTheOwnersWordsAndTheScreensTwoRows() throws {
    let (r, keys) = try make("bypass")
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil }, "audit: \(r.audit)")
    let item = try #require(r.sup.safetyPopupItem())
    let c = NeedsYouPopupContent.make(item)
    #expect(c.title == "Run with permission checks off?" && c.subject == nil)
    #expect(c.buttons.map(\.text) == ["No, exit", "Yes, I accept"])
    #expect(FirstStartCheck.state(r.sup.status) == .safetyQuestion)
    #expect(!r.allEvents.contains(.openTerminal))
    Thread.sleep(forTimeInterval: 2)
    #expect(keys.keys.isEmpty, "never answered by itself: \(keys.keys)")
  }

  @Test func acceptIsOneArrowAndOneEnter() throws {
    let (r, keys) = try make("bypass")
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil })
    let item = try #require(r.sup.safetyPopupItem())
    #expect(click(r, item, 1) == .pressed(choice: 1, label: "Yes, I accept"))
    _ = r.wait(5) { keys.keys.count >= 2 }
    #expect(keys.keys == ["DOWN", "ENTER"], "\(keys.keys)")
    #expect(r.phase() != .stopped(.user))
  }

  /// "No, exit" stops Main cleanly: the owner's own stop, never a crash and never a restart into the same disclaimer.
  @Test func exitStopsMainCleanlyAndItDoesNotComeBackByItself() throws {
    let (r, keys) = try make("bypass")
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil })
    let item = try #require(r.sup.safetyPopupItem())
    #expect(click(r, item, 0) == .pressed(choice: 0, label: "No, exit"))
    #expect(r.wait(20) { r.sup.tickNow(); return r.phase() == .stopped(.user) }, "phase \(r.phase()) audit: \(r.audit)")
    Thread.sleep(forTimeInterval: 3)
    #expect(r.phase() == .stopped(.user), "it does not start itself again: \(r.phase())")
    #expect(keys.keys == ["ENTER"], "\(keys.keys)")
    #expect(r.sup.safetyPopupItem() == nil)
  }

  @Test func aClickWhileATmuxClientIsTypingPressesNothing() throws {
    let (r, keys) = try make("bypass", quiet: 600)
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil })
    let item = try #require(r.sup.safetyPopupItem())
    let client = try attachClient(r)
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    #expect(click(r, item, 1) == .nothing(.typing))
    #expect(keys.keys.isEmpty)
  }

  /// An ATTACHED start (this copy of the app found Main already sitting at the disclaimer) runs on from the first tick; the owner's "No, exit"
  /// must still be his stop when the exit comes, not a crash to restart into the same disclaimer.
  @Test func exitOnAnAttachedStartLeavesMainStoppedWithNoRestart() throws {
    let (r, keys) = try make("bypass")
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil })
    r.sup.detach()
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { s2.status.startKind == .attached }, "\(s2.status.phase), audit: \(r.audit)")
    #expect(r.wait(15) { s2.safetyPopupItem() != nil }, "audit: \(r.audit)")
    let item = try #require(s2.safetyPopupItem())
    let box = ResultBox()
    s2.popupAnswerMain(dialogId: item.dialog.id, action: .choose(0, label: "No, exit")) { box.value = $0 }
    #expect(r.wait(10) { box.value != nil })
    #expect(box.value == .pressed(choice: 0, label: "No, exit"), "\(String(describing: box.value))")
    #expect(r.wait(20) { s2.tickNow(); return s2.status.phase == .stopped(.user) }, "phase \(s2.status.phase) audit: \(r.audit)")
    Thread.sleep(forTimeInterval: 3)
    s2.tickNow()
    #expect(s2.status.phase == .stopped(.user), "it does not start itself again: \(s2.status.phase)")
    #expect(r.starts.count == 1, "no restart: \(r.starts.count)")
    #expect(keys.keys == ["ENTER"], "\(keys.keys)")
  }

  /// After the Enter the screen has not redrawn (or the dead pane still shows its last frame): the same question is not offered again, and no
  /// second audit row is written, until the screen changes.
  @Test func theAnsweredQuestionIsNotOfferedAgainWhileTheScreenIsUnchanged() throws {
    let (r, keys) = try make("mcp", sticky: true)
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil })
    let item = try #require(r.sup.safetyPopupItem())
    #expect(click(r, item, 2) == .pressed(choice: 2, label: "Continue without using this MCP server"))
    Thread.sleep(forTimeInterval: 3)
    #expect(r.sup.safetyPopupItem() == nil, "offered again on the unchanged screen")
    let offered = r.audit.components(separatedBy: "main_safety_offered").count - 1
    #expect(offered == 1, "audit rows: \(offered)")
    #expect(r.audit.components(separatedBy: "main_safety_answered").count - 1 == 1)
    #expect(keys.keys == ["ENTER"], "\(keys.keys)")
  }

  // MARK: an Enter whose delivery is unknown (R2-1)

  private func makeUnknownEnter(_ kind: String, memory: Double) throws -> (Rig, KeyLog, UnknownEnterHost.Box) {
    let keys = KeyLog()
    var t = Rig.defaultTimings()
    t.safetyUnsentMemory = memory
    let r = try Rig(.tmux, scenario: "main-safety.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_SAFETY": kind], timings: t)
    let box = UnknownEnterHost.Box()
    r.sup.detach()
    r.wrapHost = { UnknownEnterHost($0, box) }
    r.makeSupervisor()
    return (r, keys, box)
  }

  /// A timed-out Enter leaves the screen byte-identical: it is quiet for the short memory, then offered again (it used to be hidden for good).
  @Test func aTimedOutEnterOnAnUnchangedScreenIsOfferedAgainAfterTheMemoryExpires() throws {
    let (r, keys, box) = try makeUnknownEnter("mcp", memory: 2)
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil }, "audit: \(r.audit)")
    let first = try #require(r.sup.safetyPopupItem())
    #expect(click(r, first, 2) == .pressed(choice: 2, label: "Continue without using this MCP server"))
    #expect(box.enters == 1)
    #expect(r.wait(5) { r.sup.safetyPopupItem() == nil }, "the popup goes once the Enter is sent")
    Thread.sleep(forTimeInterval: 1.5)
    #expect(r.sup.safetyPopupItem() == nil, "quiet while the Enter may still land")
    r.clock.advance(3)  // past the memory, on the awake clock the supervisor uses
    #expect(r.wait(15) { r.sup.safetyPopupItem() != nil }, "never offered again: \(r.audit)")
    #expect(r.sup.safetyPopupItem()?.dialog.id != first.dialog.id, "a new sighting, a new id")
    #expect(!r.audit.contains("main_safety_answered"), "an unconfirmed Enter is not logged as answered")
    #expect(r.audit.contains("main_safety_send_unconfirmed"))
  }

  /// A confirmed Enter stays answered past the same time: the screen has not redrawn yet, and it is not asked again.
  @Test func aConfirmedEnterIsNotOfferedAgainEvenPastTheMemory() throws {
    let keys = KeyLog()
    var t = Rig.defaultTimings()
    t.safetyUnsentMemory = 1
    let r = try Rig(.tmux, scenario: "main-safety.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_SAFETY": "mcp", "FAKE_SAFETY_STICKY": "1"], timings: t)
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil })
    let item = try #require(r.sup.safetyPopupItem())
    #expect(click(r, item, 2) == .pressed(choice: 2, label: "Continue without using this MCP server"))
    Thread.sleep(forTimeInterval: 1.5)
    r.clock.advance(5)  // past the unconfirmed-Enter memory on the supervisor's awake clock
    Thread.sleep(forTimeInterval: 2.5)
    #expect(r.sup.safetyPopupItem() == nil, "offered again after a confirmed Enter")
    #expect(r.audit.components(separatedBy: "main_safety_offered").count - 1 == 1)
  }

  /// An unconfirmed "No, exit" is not the owner's stop: when Main then dies, it is a crash and restarts as usual.
  @Test func anUnconfirmedExitFollowedByACrashRestartsNormally() throws {
    let (r, keys, box) = try makeUnknownEnter("bypass", memory: 60)
    defer { r.teardown(); keys.remove() }
    r.start()
    #expect(r.wait(25) { r.sup.safetyPopupItem() != nil })
    let item = try #require(r.sup.safetyPopupItem())
    #expect(click(r, item, 0) == .pressed(choice: 0, label: "No, exit"))
    #expect(box.enters == 1)
    let pid = try #require(r.sup.status.childPid)
    kill(pid, SIGKILL)
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count >= 2 }, "no restart: phase \(r.phase()) starts \(r.starts.count) audit: \(r.audit)")
    #expect(r.phase() != .stopped(.user))
    #expect(!r.audit.contains("dev_card_exit_stop"))
  }
}

/// Puts the Enter on a dialog into the state a tmux timeout leaves: nothing reaches the pane (the screen stays as it was) and the result is `.unknown`.
final class UnknownEnterHost: PtyHost, @unchecked Sendable {
  final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var enters: Int { lock.withLock { n } }
    func bump() { lock.withLock { n += 1 } }
  }
  private let base: PtyHost
  private let box: Box
  init(_ base: PtyHost, _ box: Box) {
    self.base = base
    self.box = box
  }
  var kind: HostKind { base.kind }
  func start(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try base.start(executable: executable, args: args, env: env, cwd: cwd)
  }
  func restart(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try base.restart(executable: executable, args: args, env: env, cwd: cwd)
  }
  func attachIfRunning() -> Bool { base.attachIfRunning() }
  func send(keys: [UInt8]) -> SendOutcome { base.send(keys: keys) }
  func sendDialogKey(_ key: DialogKey) -> SendOutcome {
    if key == .enter {
      box.bump()
      return .unknown
    }
    return base.sendDialogKey(key)
  }
  func sendEscape() -> SendOutcome { base.sendEscape() }
  func visibleRows() -> [String]? { base.visibleRows() }
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

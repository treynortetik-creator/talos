import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The pane of a Main whose model request has hung: Claude Code's working line redraws its elapsed counter every second, so the pane
/// is never quiet (the 2026-11-19 incident). The host here reports a pane that prints every tick and whose rows the test sets.
private final class RedrawingHost: PtyHost, @unchecked Sendable {
  private let base: PtyHost
  private let lock = NSLock()
  private var rows: [String]?
  private var prints = 0
  private var keyCount = 0
  init(_ base: PtyHost) { self.base = base }
  func show(_ r: [String]?) { lock.withLock { rows = r } }
  var kind: HostKind { base.kind }
  func start(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try base.start(executable: executable, args: args, env: env, cwd: cwd)
  }
  func restart(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try base.restart(executable: executable, args: args, env: env, cwd: cwd)
  }
  func attachIfRunning() -> Bool { base.attachIfRunning() }
  /// Every key that reaches Main's pane from here on: the alarm must press and send nothing.
  func resetKeys() { lock.withLock { keyCount = 0 } }
  var keys: Int { lock.withLock { keyCount } }
  func send(keys: [UInt8]) -> SendOutcome { lock.withLock { keyCount += 1 }; return base.send(keys: keys) }
  func sendDialogKey(_ key: DialogKey) -> SendOutcome { lock.withLock { keyCount += 1 }; return base.sendDialogKey(key) }
  func sendEscape() -> SendOutcome { lock.withLock { keyCount += 1 }; return base.sendEscape() }
  func visibleRows() -> [String]? { lock.withLock { rows } ?? base.visibleRows() }
  /// Every look finds the pane printed again, long after any message.
  func lastOutputAt() -> Date? { lock.withLock { prints += 1; return rows == nil ? base.lastOutputAt() : Date(timeIntervalSince1970: 4_000_000_000 + Double(prints)) } }
  func terminate(graceSeconds: Double) { base.terminate(graceSeconds: graceSeconds) }
  func close() { base.close() }
  func detach() { base.detach() }
  /// When an attached client last typed (seconds since 1970, the rig's wall clock); nil: nobody attached.
  private var typed: Double?
  func typing(at t: Double?) { lock.withLock { typed = t } }
  func clientActivity() -> Double? { lock.withLock { typed } ?? base.clientActivity() }
  func clientActivities() -> [Double]? { base.clientActivities() }
  var childPid: Int32? { base.childPid }
  var onExit: (@Sendable (ExitInfo) -> Void)? {
    get { base.onExit }
    set { base.onExit = newValue }
  }
  func setMarker(_ key: String, _ value: String) { base.setMarker(key, value) }
  func marker(_ key: String) -> String? { base.marker(key) }
  /// What the live pane showed, to start from a real, ready screen.
  var sawRows: [String]? { base.visibleRows() }
}

@Suite("A Main whose model request stalls is told once", .serialized)
struct MainModelStallTests {
  private func working(_ s: Int, tokens: String = "↓ 77 tokens") -> [String] {
    ["❯ are you there?", "", "✻ Pondering… (\(s)s · \(tokens))", "", String(repeating: "─", count: 80), "❯ ", String(repeating: "─", count: 80),
     "  ⏵⏵ bypass permissions on · esc to interrupt"]
  }
  private func transcript(_ r: Rig) throws -> String {
    let id = try #require(r.sup.status.sessionId)
    return try #require(SessionTranscript.find(sessionId: id, folder: r.agentDir, claudeDir: r.home + "/.claude"), "the fake CLI saves a transcript")
  }
  private func append(_ file: String, _ line: String) throws {
    let h = try FileHandle(forWritingTo: URL(fileURLWithPath: file))
    try h.seekToEnd()
    try h.write(contentsOf: Data((line + "\n").utf8))
    try h.close()
  }
  private func told(_ r: Rig) -> Int { r.allEvents.filter { if case .needsYou(.stalled) = $0 { return true } else { return false } }.count }

  private final class Box: @unchecked Sendable { var host: RedrawingHost? }

  @Test func aFrozenRequestBehindARedrawingCounterIsToldOnceAndNothingIsPressed() throws {
    let box = Box()
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true, configure: { $0.unstickMain = false })
    defer { r.teardown() }
    r.wrapHost = { let h = RedrawingHost($0); box.host = h; return h }
    r.makeSupervisor()
    try r.runningWithLiveBridge()
    let host = try #require(box.host)
    let file = try transcript(r)
    let size = (try FileManager.default.attributesOfItem(atPath: file)[.size] as? NSNumber)?.int64Value
    host.resetKeys()
    let message = Date().addingTimeInterval(1)
    var s = 19
    func step(_ seconds: Double, rows: ((Int) -> [String])? = nil) throws {
      var left = seconds
      while left > 0 {
        s += 15; left -= 15
        host.show(rows?(s) ?? working(s))
        try r.pass(15, unseen: message)
      }
    }
    try step(MainRestartContract.stallS - 30)
    #expect(r.sup.status.needsYou == nil, "a long think is not told before the time: \(String(describing: r.sup.status.needsYou))")
    try step(60)
    guard case .stalled(let at, _)? = r.sup.status.needsYou else {
      Issue.record("no stalled line: \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
      return
    }
    #expect(abs(at.timeIntervalSince(message)) < 1)
    try step(300)
    #expect(told(r) == 1, "told once: \(r.allEvents)")
    #expect(isRunning(r.phase()), "nothing is restarted")
    #expect((try FileManager.default.attributesOfItem(atPath: file)[.size] as? NSNumber)?.int64Value == size, "the supervisor wrote nothing to the transcript")
    // the owner opens the pane: it is resized and redrawn, a token count moves. The line stays.
    try step(60) { ["a rewrapped pane", "✻ Working… (\($0)s · ↓ \($0) tokens)"] + self.working($0) }
    #expect({ if case .stalled? = r.sup.status.needsYou { return true } else { return false } }(), "\(String(describing: r.sup.status.needsYou))")
    // Claude Code gives up with its synthetic API-error record: a failed turn, the message is still unread, the line stays
    try append(file, "{\"type\":\"assistant\",\"isApiErrorMessage\":true,\"message\":{\"model\":\"<synthetic>\",\"content\":[{\"type\":\"text\",\"text\":\"API Error: Request timed out\"}]}}")
    try step(30)
    #expect({ if case .stalled? = r.sup.status.needsYou { return true } else { return false } }(), "\(String(describing: r.sup.status.needsYou))")
    // the model answers: an assistant record after the stall point takes it down, and it is not told again for this message
    try append(file, "{\"type\":\"assistant\",\"timestamp\":\"2026-11-19T02:50:00.000Z\"}")
    try step(15)
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
    try step(400)
    #expect(told(r) == 1, "not again for the same message")
    #expect(host.keys == 0, "no key reached Main: \(host.keys)")
  }

  @Test func aTranscriptThatKeepsGrowingIsNeverStalled() throws {
    let box = Box()
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.wrapHost = { let h = RedrawingHost($0); box.host = h; return h }
    r.makeSupervisor()
    try r.runningWithLiveBridge()
    let host = try #require(box.host)
    let file = try transcript(r)
    host.resetKeys()
    let message = Date().addingTimeInterval(1)
    var s = 19
    for _ in 0..<30 {
      s += 15
      host.show(working(s))
      let h = try FileHandle(forWritingTo: URL(fileURLWithPath: file))
      try h.seekToEnd()
      try h.write(contentsOf: Data("{\"type\":\"assistant\"}\n".utf8))
      try h.close()
      try r.pass(15, unseen: message)
    }
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
    #expect(told(r) == 0)
    #expect(host.keys == 0)
  }

  /// The second stall of 2026-11-19: the model's only record is a thinking block, then nothing. Told after the thinking limit.
  @Test func aThinkingRecordAloneIsNotAnAnswerAndIsToldAtTheThinkingLimit() throws {
    let box = Box()
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true, configure: { $0.unstickMain = false })
    defer { r.teardown() }
    r.wrapHost = { let h = RedrawingHost($0); box.host = h; return h }
    r.makeSupervisor()
    try r.runningWithLiveBridge()
    let host = try #require(box.host)
    let file = try transcript(r)
    for line in [
      "{\"type\":\"queue-operation\",\"operation\":\"enqueue\"}", "{\"type\":\"attachment\"}",
      "{\"type\":\"system\",\"subtype\":\"api_request\"}",
      "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"thinking\"}]}}", "{\"type\":\"frame-link\"}",
    ] { try append(file, line) }
    host.resetKeys()
    let message = Date().addingTimeInterval(1)
    var s = 19
    func step(_ seconds: Double) throws {
      var left = seconds
      while left > 0 {
        s += 15; left -= 15
        host.show(working(s))
        try r.pass(15, unseen: message)
      }
    }
    try step(MainRestartContract.stallThinkingS - 45)
    #expect(r.sup.status.needsYou == nil, "an answered-looking transcript is still quiet before the thinking limit")
    try step(75)
    #expect({ if case .stalled? = r.sup.status.needsYou { return true } else { return false } }(), "\(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(host.keys == 0)
  }

  /// Main running a tool or a sub-agent for minutes: its newest transcript record is the model's own tool_use. No alarm.
  @Test func aMainRunningAToolForMinutesIsNeverTold() throws {
    let box = Box()
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.wrapHost = { let h = RedrawingHost($0); box.host = h; return h }
    r.makeSupervisor()
    try r.runningWithLiveBridge()
    let host = try #require(box.host)
    try append(try transcript(r), "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\"}]}}")
    host.resetKeys()
    let message = Date().addingTimeInterval(1)
    var s = 19
    for _ in 0..<40 {
      s += 15
      host.show(working(s))
      try r.pass(15, unseen: message)
    }
    #expect(r.sup.status.needsYou == nil && told(r) == 0, "\(String(describing: r.sup.status.needsYou))")
    #expect(host.keys == 0)
  }

  /// After /clear the session id changes and a new file starts: the newest-modified file in Main's folder is the one read.
  @Test func aClearedSessionsNewFileIsTheOneWatched() throws {
    let box = Box()
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.wrapHost = { let h = RedrawingHost($0); box.host = h; return h }
    r.makeSupervisor()
    try r.runningWithLiveBridge()
    let host = try #require(box.host)
    let old = try transcript(r)
    try append(old, "{\"type\":\"assistant\"}")  // the old session ended on the model's turn
    let new = (old as NSString).deletingLastPathComponent + "/\(UUID().uuidString.lowercased()).jsonl"
    try "{\"type\":\"user\"}\n".write(toFile: new, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(30)], ofItemAtPath: new)
    let message = Date().addingTimeInterval(1)
    var s = 19
    for _ in 0..<20 {
      s += 15
      host.show(working(s))
      try r.pass(15, unseen: message)
    }
    #expect({ if case .stalled? = r.sup.status.needsYou { return true } else { return false } }(), "\(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
  }

  // MARK: the auto-unstick (setting `unstick_main`, on by default)

  /// A permission question on the pane under the working line: Escape would answer it, so it is never sent.
  private func withPermissionDialog(_ s: Int) -> [String] {
    ["⏺ Bash(ls)", "✻ Pondering… (\(s)s · ↓ 77 tokens)", "", String(repeating: "─", count: 80), " Do you want to proceed?", " ❯ 1. Yes",
     "   2. Yes, and don't ask again", "   3. No", "", " Esc to cancel"]
  }

  private func stall(_ r: Rig, _ host: RedrawingHost, message: Date, rows: ((Int) -> [String])? = nil, for total: Double = 400) throws {
    var s = 19
    var left = total
    while left > 0 {
      s += 15; left -= 15
      host.show(rows?(s) ?? working(s))
      try r.pass(15, unseen: message)
    }
  }

  private func phoneLines(_ r: Rig, containing text: String, wait: Bool = true) -> Int {
    for _ in 0..<(wait ? 50 : 1) {
      let n = r.phonePosts.filter { $0.contains(text) }.count
      if n > 0 { return n }
      Thread.sleep(forTimeInterval: 0.1)
    }
    return 0
  }

  private func rig(_ box: Box, _ configure: @escaping (inout DesktopConfig) -> Void = { _ in }) throws -> Rig {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true, configure: configure)
    r.wrapHost = { let h = RedrawingHost($0); box.host = h; return h }
    r.makeSupervisor()
    try r.runningWithLiveBridge()
    return r
  }

  private func answer(_ r: Rig, _ message: Date, outcome: String) throws {
    let at = ISOTime.string(message.timeIntervalSince1970)
    try "{\"v\":1,\"unseen_at\":\"\(at)\",\"outcome\":\"\(outcome)\",\"delivered\":1}".write(
      toFile: r.talosHome + "/main-resend-result.json", atomically: true, encoding: .utf8)
  }
  private func pressed(_ r: Rig) -> Bool { r.audit.contains("unstick_pressed") }
  private func stallUntilPressed(_ r: Rig, _ host: RedrawingHost, message: Date) throws {
    var s = 19
    for _ in 0..<60 where !pressed(r) {
      s += 15
      host.show(working(s))
      try r.pass(15, unseen: message)
    }
  }

  @Test func aStalledRequestGetsOneEscapeOneRequestAndTheLineWaitsForTheBridgeToSayItSentIt() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    host.resetKeys()
    let message = Date().addingTimeInterval(1)
    try stallUntilPressed(r, host, message: message)
    #expect(pressed(r), "audit: \(r.audit)")
    #expect(host.keys == 1, "one Escape: \(host.keys)")
    let request = try Data(contentsOf: URL(fileURLWithPath: r.talosHome + "/main-resend.json"))  // the bridge was asked
    let body = try #require(try JSONSerialization.jsonObject(with: request) as? [String: Any])
    #expect(body["v"] as? Int == 1)
    let stamp = try #require(body["unseen_at"] as? String)
    let at = try #require(fractionalDate(stamp))
    #expect(abs(at.timeIntervalSince(message)) < 1, "the request names the stalled message")
    #expect((try FileManager.default.attributesOfItem(atPath: r.talosHome + "/main-resend.json")[.posixPermissions] as? Int) == 0o600)
    // asked, not yet answered: no line claims it was sent
    try r.pass(5, unseen: message)
    #expect(phoneLines(r, containing: "sent it again", wait: false) == 0 && phoneLines(r, containing: "pressed Esc", wait: false) == 0, "\(r.phonePosts)")
    // the bridge says it delivered the message again
    try answer(r, message, outcome: "sent")
    try r.pass(15, unseen: message)
    #expect(phoneLines(r, containing: "Talos pressed Esc and sent it again") == 1, "\(r.phonePosts)")
    guard case .stalled(_, .resent(let min))? = r.sup.status.needsYou else {
      Issue.record("the needs-you line says what was done: \(String(describing: r.sup.status.needsYou))")
      return
    }
    #expect(min >= 3)
    try stall(r, host, message: message, for: 700)  // the same message stalls again: no second Esc, no second line
    #expect(host.keys == 1 && phoneLines(r, containing: "pressed Esc", wait: false) == 1, "keys \(host.keys), \(r.phonePosts)")
    #expect(isRunning(r.phase()), "nothing is restarted")
  }

  /// A frozen request with no working line: the idle prompt, the transcript's pending turn. One Escape (the blank intent), and the request says so.
  @Test func aBlankStallSendsItsOneEscapeAndTheRequestSaysItIsTheBlankCase() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    host.resetKeys()
    let message = Date().addingTimeInterval(1)
    let idle = ["❯ hello", "", "⏺ Read(file)", "", String(repeating: "─", count: 80), "❯ ", String(repeating: "─", count: 80), "  ⏵⏵ bypass permissions on"]
    var left = MainRestartContract.stallBlankS + 60
    while left > 0, !pressed(r) {
      host.show(idle)
      try r.pass(15, unseen: message)
      left -= 15
    }
    #expect(pressed(r) && host.keys == 1, "keys \(host.keys), audit: \(r.audit)")
    let body = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: r.talosHome + "/main-resend.json"))) as? [String: Any])
    #expect(body["blank"] as? Bool == true)
  }

  @Test func aSpinnerStallsRequestDoesNotClaimToBeTheBlankCase() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    try stallUntilPressed(r, host, message: Date().addingTimeInterval(1))
    let body = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: r.talosHome + "/main-resend.json"))) as? [String: Any])
    #expect(body["blank"] == nil)
  }

  @Test func aBridgeThatSaysItCouldNotSendTheMessageGetsAnHonestLine() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    let message = Date().addingTimeInterval(1)
    try stallUntilPressed(r, host, message: message)
    try answer(r, message, outcome: "failed")
    try r.pass(15, unseen: message)
    #expect(phoneLines(r, containing: "couldn't send your message again; please resend it") == 1, "\(r.phonePosts)")
    #expect(phoneLines(r, containing: "sent it again", wait: false) == 0, "never claims a resend that did not happen")
    guard case .stalled(_, .failed)? = r.sup.status.needsYou else {
      Issue.record("\(String(describing: r.sup.status.needsYou))")
      return
    }
  }

  @Test func noAnswerWithinTheWaitIsToldAsNotSent() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    let message = Date().addingTimeInterval(1)
    try stallUntilPressed(r, host, message: message)
    try r.pass(MainWatch.answerWithin - 5, unseen: message)
    #expect(phoneLines(r, containing: "pressed Esc", wait: false) == 0, "still within the wait")
    try r.pass(15, unseen: message)
    #expect(phoneLines(r, containing: "couldn't send your message again") == 1, "\(r.phonePosts)")
    #expect(phoneLines(r, containing: "sent it again", wait: false) == 0)
  }

  @Test func anAnswerForAnotherMessageIsNotTakenForThisOnes() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    let message = Date().addingTimeInterval(1)
    try stallUntilPressed(r, host, message: message)
    try answer(r, message.addingTimeInterval(-500), outcome: "sent")  // an answer left by an earlier message
    try r.pass(5, unseen: message)
    #expect(phoneLines(r, containing: "sent it again", wait: false) == 0, "\(r.phonePosts)")
  }

  @Test func aBridgeThatDoesNotSayItAnswersGetsNoEscapeAndTheAlarmLineAlone() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    host.resetKeys()
    let message = Date().addingTimeInterval(1)
    var s = 19
    for _ in 0..<40 {
      s += 15
      host.show(working(s))
      try r.pass(15, unseen: message, mainResend: false)  // an older bridge: status.json has no `main_resend`
    }
    guard case .stalled(_, .none)? = r.sup.status.needsYou else {
      Issue.record("the alarm line: \(String(describing: r.sup.status.needsYou))")
      return
    }
    #expect(host.keys == 0 && !FileManager.default.fileExists(atPath: r.talosHome + "/main-resend.json"))
    #expect(r.audit.contains("bridge_cannot_resend"), "\(r.audit)")
    #expect(phoneLines(r, containing: "pressed Esc", wait: false) == 0)
  }

  @Test func aRefusalSpendsNothingSoTheNextTryAfterTheOwnerStopsTypingSendsTheOneEscape() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    host.resetKeys()
    let message = Date().addingTimeInterval(1)
    host.typing(at: r.clock.wallMs() / 1000 + 100_000)
    try stall(r, host, message: message, for: 400)
    #expect(host.keys == 0 && !pressed(r), "nobody presses over the owner's typing")
    host.typing(at: nil)
    try stall(r, host, message: message, for: 60)
    #expect(host.keys == 1 && pressed(r), "typing stopped: one Escape, \(host.keys), audit: \(r.audit)")
    try stall(r, host, message: message, for: 300)
    #expect(host.keys == 1, "never a second")
  }

  @Test func aNewMessageThatStallsGetsItsOwnOneTry() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    host.resetKeys()
    try stall(r, host, message: Date().addingTimeInterval(1), for: 300)
    #expect(host.keys == 1)
    try r.pass(30, unseen: nil)  // taken in
    try stall(r, host, message: Date().addingTimeInterval(500), for: 300)
    #expect(host.keys == 2, "the second message has its own one try: \(host.keys), audit: \(r.audit)")
  }

  @Test func withTheSettingOffTheLineIsAllThereIs() throws {
    let box = Box()
    let r = try rig(box) { $0.unstickMain = false }
    defer { r.teardown() }
    let host = try #require(box.host)
    host.resetKeys()
    try stall(r, host, message: Date().addingTimeInterval(1))
    guard case .stalled(_, .none)? = r.sup.status.needsYou else {
      Issue.record("\(String(describing: r.sup.status.needsYou))")
      return
    }
    #expect(host.keys == 0 && !FileManager.default.fileExists(atPath: r.talosHome + "/main-resend.json"))
    #expect(phoneLines(r, containing: "pressed Esc", wait: false) == 0)
  }

  @Test func nothingIsPressedWhileSomeoneTypesInMainsWindow() throws {
    let box = Box()
    let r = try rig(box)
    defer { r.teardown() }
    let host = try #require(box.host)
    host.resetKeys()
    host.typing(at: r.clock.wallMs() / 1000 + 100_000)  // an attached client typed "just now", whenever the stall lands
    try stall(r, host, message: Date().addingTimeInterval(1))
    guard case .stalled(_, .none)? = r.sup.status.needsYou else {
      Issue.record("the old line stands: \(String(describing: r.sup.status.needsYou))")
      return
    }
    #expect(host.keys == 0 && !FileManager.default.fileExists(atPath: r.talosHome + "/main-resend.json"))
    #expect(r.audit.contains("unstick_skipped") && r.audit.contains("typing"), "\(r.audit)")
  }

  @Test func nothingIsPressedWhenTheBoxHoldsADraftOrAPermissionQuestionIsUp() throws {
    for (name, shown) in [
      ("draft", { (s: Int) -> [String] in
        ["❯ are you there?", "", "✻ Pondering… (\(s)s · ↓ 77 tokens)", "", String(repeating: "─", count: 80), "❯\u{00A0}half a sentence",
         String(repeating: "─", count: 80), "  ⏵⏵ bypass permissions on · esc to interrupt"] }),
      ("dialog", withPermissionDialog),
    ] as [(String, (Int) -> [String])] {
      let box = Box()
      let r = try rig(box)
      defer { r.teardown() }
      let host = try #require(box.host)
      host.resetKeys()
      try stall(r, host, message: Date().addingTimeInterval(1), rows: shown)
      #expect(host.keys == 0, "\(name): no key reached Main, audit: \(r.audit)")
      #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/main-resend.json"), "\(name)")
      #expect(r.audit.contains("key_refused") || r.audit.contains("unstick_skipped"), "\(name): the refusal is in the log")
    }
  }
}

private func fractionalDate(_ s: String) -> Date? {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f.date(from: s)
}

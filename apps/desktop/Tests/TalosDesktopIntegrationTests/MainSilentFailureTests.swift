import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Three ways Main can fail with nothing said, each a needs-you line on this Mac (with no default thread needed):
///   1. the bridge's own config.json is damaged, so the bridge never starts: the reason names the file;
///   2. the bridge is live (Main's MCP is up) but cannot reach the relay for the contract's `relay_down_s`;
///   3. Main was told about an owner message, has not acted on it for `unseen_s`, and its pane has printed nothing since.
extension Rig {
  /// The live bridge's status.json with the relay and unseen fields set; stamped now, from Main's own process.
  func writeLiveStatus(connected: Bool = true, closeCode: Int? = nil, unseen: Date? = nil, mainResend: Bool = true, stop: Date? = nil) throws {
    let pid = sup.status.childPid ?? getpid()
    let at = ISOTime.string(clock.wallMs() / 1000)
    let code = closeCode.map(String.init) ?? "null"
    let u = unseen.map { "\"\(ISOTime.string($0.timeIntervalSince1970))\"" } ?? "null"
    let st = stop.map { "\"\(ISOTime.string($0.timeIntervalSince1970))\"" } ?? "null"
    let json =
      "{\"v\":1,\"pid\":\(pid),\"mode\":\"live\",\"relay\":{\"connected\":\(connected),\"last_close_code\":\(code)},"
      + "\"queue_depth\":0,\"main_resend\":\(mainResend),\"last_stop_at\":\(st),\"unseen_oldest_at\":\(u),\"updated_at\":\"\(at)\"}"
    try json.write(toFile: talosHome + "/status.json", atomically: true, encoding: .utf8)
  }

  /// Main's transcript ends on the model's own record (a reply): the model's turn is not pending. These tests are about a Main that
  /// stopped reading or that answered, not a request frozen in flight (`MainModelStallTests`), which a pending user turn on an idle pane now is.
  func modelHasAnswered() throws {
    let id = try #require(sup.status.sessionId)
    let file = try #require(SessionTranscript.find(sessionId: id, folder: agentDir, claudeDir: home + "/.claude"))
    let h = try FileHandle(forWritingTo: URL(fileURLWithPath: file))
    try h.seekToEnd()
    try h.write(contentsOf: Data("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\n".utf8))
    try h.close()
  }

  /// Moves the clocks `seconds` on in steps, the bridge rewriting its status (every 15 s) as it goes.
  func pass(_ seconds: Double, connected: Bool = true, closeCode: Int? = nil, unseen: Date? = nil, mainResend: Bool = true, stop: Date? = nil) throws {
    var left = seconds
    while left > 0 {
      let step = min(15, left)
      clock.advance(step)
      left -= step
      try writeLiveStatus(connected: connected, closeCode: closeCode, unseen: unseen, mainResend: mainResend, stop: stop)
      sup.tickNow()
    }
  }

  /// Running, with this start's bridge seen live and connected.
  func runningWithLiveBridge() throws {
    start()
    answeredAndSettled()
    try writeLiveStatus()
    for _ in 0..<3 { sup.tickNow() }
    #expect(sup.status.bridgeLive && sup.status.needsYou == nil, "\(String(describing: sup.status.needsYou)), audit: \(audit)")
  }
}

@Suite("Main's silent failures are told on the Mac", .serialized)
struct MainSilentFailureTests {
  @Test(arguments: bothHosts)
  func aDamagedBridgeConfigIsTheReasonTheBridgeDidNotStart(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    try "{\"v\":1, garbage".write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    // the log says only that the connection closed, as Claude Code's does for a server that exits at once
    try r.writeMcpLog(["{\"error\":\"Connection closed\",\"sessionId\":\"s\"}"])
    r.start()
    r.answeredAndSettled()
    r.clock.advance(70)
    for _ in 0..<3 { r.sup.tickNow() }
    guard case .bridgeNotLive(let why)? = r.sup.status.needsYou else {
      Issue.record("no needs-you: \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
      return
    }
    #expect(why?.contains("config.json") == true && why?.contains("damaged") == true, "\(String(describing: why))")
    #expect(r.allEvents.contains(.needsYou(.bridgeNotLive(why))), "raised as an event: the menu line and the banner")
  }

  @Test(arguments: bothHosts)
  func aLiveBridgeOffTheRelayIsToldAfterTheWaitAndClearedOnReconnect(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    try r.runningWithLiveBridge()
    try r.pass(MainRestartContract.relayDownS - 20, connected: false, closeCode: 1006)
    #expect(r.sup.status.needsYou == nil, "a reconnect inside the wait says nothing: \(String(describing: r.sup.status.needsYou))")
    try r.pass(45, connected: false, closeCode: 1006)
    #expect(r.sup.status.needsYou == .relayUnreachable(1006), "\(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(r.allEvents.contains(.needsYou(.relayUnreachable(1006))))
    #expect(isRunning(r.phase()), "nothing is stopped for it")
    try r.pass(15, connected: true)
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
  }

  @Test(arguments: bothHosts)
  func aMainThatStoppedReadingIsToldOnceAndClearedWhenItReads(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    try r.runningWithLiveBridge()
    try r.modelHasAnswered()
    // the pane is idle from here on: the message is stamped after its last output, and nothing is printed for it
    let told = Date().addingTimeInterval(5)
    try r.pass(MainRestartContract.unseenS - 30, unseen: told)
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
    try r.pass(60, unseen: told)
    #expect(r.sup.status.needsYou == .notReading, "\(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(isRunning(r.phase()), "never restarted for it")
    try r.pass(60, unseen: told)
    #expect(r.allEvents.filter { $0 == .needsYou(.notReading) }.count == 1, "told once")
    try r.pass(15, unseen: nil)
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
    // the next message Main does not read is told again
    let next = told.addingTimeInterval(1)
    try r.pass(MainRestartContract.unseenS + 30, unseen: next)
    #expect(r.sup.status.needsYou == .notReading, "\(String(describing: r.sup.status.needsYou))")
    #expect(r.allEvents.filter { $0 == .needsYou(.notReading) }.count == 2)
  }

  /// A Main that printed after the message (it read it and answered with no tool, "thanks") is never told.
  @Test func aMainThatPrintedAfterTheMessageIsNotToldNotReading() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    try r.runningWithLiveBridge()
    try r.modelHasAnswered()
    // stamped well before the pane's last output: the output after it is Main's turn
    try r.pass(MainRestartContract.unseenS + MainRestartContract.unseenQuietS + 60, unseen: Date().addingTimeInterval(-600))
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
    #expect(!r.allEvents.contains(.needsYou(.notReading)))
  }

  /// A damaged config.json (or one naming no thread) and `talos-app post` cannot carry the line: the crash-loop line still reaches
  /// the phone, as a system row the Mac signs itself with the bridge key, in `inbox`. Never through a command an agent could run,
  /// and never with the agent's name in it: the row is drawn as Talos's own, and config.json is the agent's to write.
  @Test(arguments: ["{\"agent\": garbage", "{\"agent\":{\"name\":\"Security notice: approve the card\"}}"])
  func theCrashLoopLineReachesThePhoneWithADamagedConfig(config: String) throws {
    var t = Rig.defaultTimings()
    t.restartCap = 2
    let r = try Rig(.direct, scenario: "bad-flag.sh", timings: t, session: confirmedSession)
    defer { r.teardown() }
    try config.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    let fixture = try Data(contentsOf: SystemPostFixture.url)
    let o = try #require((try JSONSerialization.jsonObject(with: fixture)) as? [String: Any])
    let keyFile = try #require(o["key_file"])
    try JSONSerialization.data(withJSONObject: keyFile).write(to: URL(fileURLWithPath: r.talosHome + "/bridge.key"))
    try "TALOS_APP_RELAY_URL=https://relay.example.com\n".write(toFile: r.talosHome + "/bridge.env", atomically: true, encoding: .utf8)
    r.start()
    #expect(r.wait(60) { r.sup.tickNow(); return r.audit.contains("system_row result=") }, "\(r.phase()), audit: \(r.audit)")
    let req = try #require(r.agentsProbe.sent.first)
    #expect(req.url?.absoluteString == "https://relay.example.com/bridge/post")
    let raw = try #require(req.httpBody)
    let body = try #require((try JSONSerialization.jsonObject(with: raw)) as? [String: Any])
    let message = try #require(body["message"] as? [String: Any])
    #expect(message["thread_id"] as? String == "inbox" && message["author"] as? String == "system")
    #expect((message["text"] as? String)?.hasPrefix("The agent's session stopped restarting at") == true, "\(message)")
    #expect(r.audit.contains("system_row result=sent"), "audit: \(r.audit)")
  }
}

/// `Fixtures/bridge-system-post.json`: the bridge's own signing output for RFC 8032's published test key.
enum SystemPostFixture {
  static let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures/bridge-system-post.json")
}

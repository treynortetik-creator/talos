import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// The owner's case of 2026-11-11, through the real manager and a real tmux: a background sub-agent's Bash ask (the real 2.1.322
/// capture, `This shell -c script runs rm and could not be checked`) sat in a thread session's pane and the thread heard nothing.
/// What `needsYou()` answered each time it was asked from inside an event.
private final class FlagReads: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String?] = []
  func add(_ v: String?) { lock.withLock { items.append(v) } }
  var all: [String?] { lock.withLock { items } }
}

@Suite("Worker prompts: the 2.1.322 sub-agent ask", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerPrompt322Tests {
  static let ask = "perm-subagent-rm-120x40"

  private func rig(_ extra: [String: String], clock: SkewClock? = nil) throws -> (WorkerRig, NoticeLog) {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: extra)
    if let clock { r.makeManager(awake: clock.read) }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.auditLogPath = r.root + "/audit.log" }
    try WorkerPromptRelayTests.named.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    return (r, log)
  }

  private func audit(_ r: WorkerRig) -> [String] {
    ((try? String(contentsOfFile: r.root + "/audit.log", encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
  }

  /// An attached tmux client with a tty, the way a Terminals window is one; its activity time is the attach.
  private func attach(_ r: WorkerRig) throws -> Process {
    #expect(Rig.pinWindowSize(socket: r.socket, session: "t-trip"), "control: the window is pinned to its size")
    let client = Process()
    client.executableURL = URL(fileURLWithPath: "/usr/bin/script")
    client.arguments = ["-q", "/dev/null", Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "attach-session", "-t", "=t-trip"]
    client.environment = ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin", "HOME": r.root + "/home"]
    client.standardInput = Pipe()
    client.standardOutput = FileHandle.nullDevice
    client.standardError = FileHandle.nullDevice
    try client.run()
    #expect(r.wait(5) { !r.tmuxCmd(["list-clients", "-t", "=t-trip", "-F", "#{client_activity}"]).out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
    return client
  }

  /// Nobody at the keys: the ask is announced once, named as a Bash command, and the log has the two lines Linux writes.
  @Test func theSubAgentsAskGetsItsLineAndItsAuditLines() throws {
    let (r, log) = try rig(["FAKE_REAL_START": "screen:\(Self.ask)"])
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { log.all.count == 1 }, "\(r.why("trip")) \(r.mgr.needsYou())")
    #expect(r.mgr.needsYou()["trip"] == "Bash command")
    #expect(log.all.first?.text.contains("Bash command") == true, "\(log.all)")
    #expect(r.wait(5) { audit(r).contains { $0.contains("worker_notice thread=trip kind=\"prompt: ") && $0.hasSuffix("outcome=sent") } }, "\(audit(r))")
    #expect(audit(r).contains { $0.hasSuffix("worker_needs_you thread=trip prompt=\"Bash command\"") }, "\(audit(r))")
    usleep(1_500_000)
    #expect(log.all.count == 1, "once")
  }

  /// The flag is in `needsYou()` by the time anyone is told of the dialog. The event is raised on the manager's queue in the middle
  /// of a tick, and the thread's line is posted from its own thread while that tick goes on, so a read made on hearing either one
  /// came back empty until the tick ended (CI, 2026-11-11: the line was in, the flag was not). A prompt nobody named, and a known dialog.
  @Test(arguments: [("screen:\(ask)", "Bash command"), ("trust", "trust this folder")])
  func theFlagIsPublishedBeforeTheEventAndTheLine(start: String, name: String) throws {
    let (r, log) = try rig(["FAKE_REAL_START": start])
    defer { r.teardown() }
    let atEvent = FlagReads()
    r.mgr.onEvent = { [weak m = r.mgr] e in
      if case .needsYou(thread: "trip", _) = e { atEvent.add(m?.needsYou()["trip"]) }
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { log.all.count == 1 }, "\(r.why("trip"))")
    #expect(atEvent.all == [name], "what needsYou() said when the event was raised: \(atEvent.all)")
    #expect(r.mgr.needsYou()["trip"] == name, "and it holds after the line")
  }

  /// A client typed lately (`clientQuiet` far longer than the test), so the line is held. A TOOL prompt's hold ends at
  /// `toolPromptHoldMax`; the agent's own question keeps the hold for as long as the typing goes on. The attached client is 80x24,
  /// smaller than the ask, so the ask's header (`Bash command …`) is off the pane, as in a small Terminals window: it is still
  /// known for a tool's ask by its question and footer.
  @Test(arguments: [(ask, 2.0, true), (ask, 600.0, false), ("askuser-select", 2.0, false)])
  func typingHoldsAToolPromptsLineOnlyUpToTheCap(screen: String, cap: Double, notices: Bool) throws {
    let trigger = TestTemp.base + "prm-\(UUID().uuidString.prefix(6))"
    let (r, log) = try rig(["FAKE_REAL_START": "empty", "FAKE_REAL_SWITCH": trigger, "FAKE_REAL_THEN": screen])
    defer {
      r.teardown()
      unlink(trigger)
    }
    r.mgr.tune {
      $0.clientQuiet = 600
      $0.toolPromptHoldMax = cap
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let client = try attach(r)
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    FileManager.default.createFile(atPath: trigger, contents: nil)
    if notices {
      #expect(r.wait(15) { log.all.count == 1 }, "past the cap the thread is told: \(r.mgr.needsYou()) \(audit(r))")
      #expect(audit(r).contains { $0.contains("worker_prompt_held thread=trip prompt=") && $0.hasSuffix("why=client_typing") }, "the hold is in the log: \(audit(r))")
    } else {
      usleep(5_000_000)
      #expect(log.all.isEmpty, "\(log.all)")
      #expect(r.mgr.needsYou().isEmpty)
      #expect(audit(r).contains { $0.contains("worker_prompt_held thread=trip") }, "control: the prompt was seen and held: \(audit(r))")
    }
  }

  /// The owner answers the first ask and the sub-agent's next one shows about a second later, while the first one's flag is still
  /// held (it outlives its prompt by `dialogSettle`). The second ask gets its own line.
  @Test func aSecondAskSoonAfterTheFirstWasAnsweredGetsItsOwnLine() throws {
    let a = TestTemp.base + "prm-\(UUID().uuidString.prefix(6))", b = TestTemp.base + "prm-\(UUID().uuidString.prefix(6))"
    let (r, log) = try rig([
      "FAKE_REAL_START": "screen:bash-permission", "FAKE_REAL_SWITCH": a, "FAKE_REAL_THEN": "empty-input", "FAKE_REAL_SWITCH2": b,
      "FAKE_REAL_THEN2": Self.ask,
    ])
    defer {
      r.teardown()
      unlink(a)
      unlink(b)
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { log.all.count == 1 }, "\(r.why("trip"))")
    r.mgr.tune { $0.dialogSettle = 4 }
    FileManager.default.createFile(atPath: a, contents: nil)  // answered: the idle box
    #expect(r.wait(5) { r.tmuxCmd(["capture-pane", "-p", "-t", "=t-trip:"]).out.contains("auto mode on") }, "control: the idle box is on the pane")
    usleep(1_000_000)  // the manager sees the idle box (the first ask is over), and its flag is still held
    #expect(r.mgr.needsYou()["trip"] == "Bash command", "control: the flag outlives the prompt")
    FileManager.default.createFile(atPath: b, contents: nil)  // the next ask, one to two seconds after the answer
    #expect(r.wait(15) { log.all.count == 2 }, "the second ask: \(log.all.map(\.text)) \(audit(r))")
    #expect(r.mgr.needsYou()["trip"] == "Bash command")
  }

  /// The same ask blinks: another screen for about 3 s (a redraw, a moment of transcript, or the idle box), then the very same prompt
  /// again, while its flag is still held. That is one ask and it keeps its one line, however long ago the line went (past `promptDebounce`,
  /// which would else hide a second post). The test above is the other half: a DIFFERENT prompt gets its own. The awake clock is the
  /// test's: the 3 s of the flicker and the wait past the settle are jumps of it, and the manager looks when the test says (`tickOnce`),
  /// so a loaded machine cannot stretch the flicker past the flag's hold or shorten the wait.
  @Test(arguments: ["busy-transcript", "empty-input"])
  func theSameAskBackAfterAThreeSecondFlickerKeepsItsOneLine(between: String) throws {
    let a = TestTemp.base + "prm-\(UUID().uuidString.prefix(6))", b = TestTemp.base + "prm-\(UUID().uuidString.prefix(6))"
    let clock = SkewClock()
    let (r, log) = try rig(
      ["FAKE_REAL_START": "screen:\(Self.ask)", "FAKE_REAL_SWITCH": a, "FAKE_REAL_THEN": between, "FAKE_REAL_SWITCH2": b, "FAKE_REAL_THEN2": Self.ask],
      clock: clock)
    defer {
      r.teardown()
      unlink(a)
      unlink(b)
    }
    let capture = { r.tmuxCmd(["capture-pane", "-p", "-t", "=t-trip:"]).out }
    let askOnPane = { capture().contains("Do you want to proceed") }
    // The whole ask, drawn and holding still: the same capture twice, a moment apart, that the prompt watch reads as the prompt.
    // Its words alone are not enough: on a loaded machine the manager's next look could catch the ask half drawn, see no prompt,
    // and after the clock's jump let the held flag go or post the ask again (1 run in 6 under load, 11-18).
    let askDrawn = { () -> Bool in
      let one = capture()
      Thread.sleep(forTimeInterval: 0.3)
      return one == capture() && PromptDetector.detect(TmuxCommands.parseCapture(one)) != nil
    }
    // The manager looks only when this test says (`tickOnce`): its own timer would otherwise look at the screens at arbitrary moments between
    // the clock's jumps, which no real run does (a look every second), and 1 run in ~20 posted the ask a second time (2026-11-22).
    r.mgr.tune {
      $0.promptDebounce = 0  // the wall clock never hides a second post here: only the flicker rule can keep it back
      $0.tick = 3600
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(30) { r.mgr.tickOnce(); return log.all.count == 1 }, "\(r.why("trip"))")
    r.mgr.tune { $0.dialogSettle = 60 }  // the flag's hold: far longer than the flicker, however slow the machine
    FileManager.default.createFile(atPath: a, contents: nil)
    #expect(r.wait(30) { !askOnPane() }, "control: the ask is off the pane")
    r.mgr.tickOnce()  // the manager looks at the other screen
    clock.jump(3)  // the flicker: longer than the 2 s after which the watch lets the prompt go, shorter than the flag's hold
    r.mgr.tickOnce()
    #expect(r.mgr.needsYou()["trip"] == "Bash command", "control: the flag is still held")
    FileManager.default.createFile(atPath: b, contents: nil)
    #expect(r.wait(30) { askOnPane() && askDrawn() }, "control: the ask is back, whole and still")
    r.mgr.tickOnce()  // the manager sees it back
    clock.jump(61)  // past the settle: a second line would be posted by the next look
    r.mgr.tickOnce()
    r.mgr.tickOnce()
    #expect(!r.wait(3) { log.all.count != 1 }, "one ask, one line: \(log.all.map(\.text)) \(audit(r))")
    #expect(log.all.count == 1)
    #expect(r.mgr.needsYou()["trip"] == "Bash command")
  }
}

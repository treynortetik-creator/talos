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

  private func rig(_ extra: [String: String]) throws -> (WorkerRig, NoticeLog) {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: extra)
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
  /// again, while its flag is still held (`dialogSettle` 4). That is one ask and it keeps its one line, however long ago the line went
  /// (past `promptDebounce`, which would else hide a second post). The test above is the other half: a DIFFERENT prompt gets its own.
  @Test(arguments: ["busy-transcript", "empty-input"])
  func theSameAskBackAfterAThreeSecondFlickerKeepsItsOneLine(between: String) throws {
    let a = TestTemp.base + "prm-\(UUID().uuidString.prefix(6))", b = TestTemp.base + "prm-\(UUID().uuidString.prefix(6))"
    let (r, log) = try rig([
      "FAKE_REAL_START": "screen:\(Self.ask)", "FAKE_REAL_SWITCH": a, "FAKE_REAL_THEN": between, "FAKE_REAL_SWITCH2": b, "FAKE_REAL_THEN2": Self.ask,
    ])
    defer {
      r.teardown()
      unlink(a)
      unlink(b)
    }
    r.mgr.tune { $0.promptDebounce = 0.5 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { log.all.count == 1 }, "\(r.why("trip"))")
    r.mgr.tune { $0.dialogSettle = 4 }
    usleep(1_000_000)  // past the debounce: only the flicker rule can keep a second line back now
    FileManager.default.createFile(atPath: a, contents: nil)
    #expect(r.wait(5) { !r.tmuxCmd(["capture-pane", "-p", "-t", "=t-trip:"]).out.contains("Do you want to proceed") }, "control: the ask is off the pane")
    usleep(3_000_000)  // the flicker: longer than the 2 s after which the watch lets the prompt go, shorter than the flag's hold
    #expect(r.mgr.needsYou()["trip"] == "Bash command", "control: the flag is still held")
    FileManager.default.createFile(atPath: b, contents: nil)
    #expect(r.wait(5) { r.tmuxCmd(["capture-pane", "-p", "-t", "=t-trip:"]).out.contains("Do you want to proceed") }, "control: the ask is back")
    usleep(7_000_000)  // past the settle (4 s) with room: a second line would have gone by now
    #expect(log.all.count == 1, "one ask, one line: \(log.all.map(\.text)) \(audit(r))")
    #expect(r.mgr.needsYou()["trip"] == "Bash command")
  }
}

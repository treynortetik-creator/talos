import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// An attached tmux client with a tty (`script`), the way a Terminals window is one. Its activity time is the attach.
private func attachClient(socket: String, session: String, home: String, wait r: (Double, () -> Bool) -> Bool) throws -> Process {
  let client = Process()
  client.executableURL = URL(fileURLWithPath: "/usr/bin/script")
  client.arguments = ["-q", "/dev/null", Rig.tmuxPath!, "-L", socket, "-f", Rig.tmuxConf, "attach-session", "-t", "=\(session)"]
  client.environment = ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin", "HOME": home]
  client.standardInput = Pipe()
  client.standardOutput = FileHandle.nullDevice
  client.standardError = FileHandle.nullDevice
  try client.run()
  let listed = {
    !ProcessRunner.run([Rig.tmuxPath!, "-L", socket, "list-clients", "-t", "=\(session)", "-F", "#{client_activity}"], env: ["PATH": "/usr/bin:/bin"]).out
      .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  #expect(r(5, listed), "the client attached")
  return client
}

@Suite("Worker prompts: review fixes", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerPromptReviewTests {
  static let named = WorkerPromptRelayTests.named

  private func rig(_ extra: [String: String]) throws -> (WorkerRig, NoticeLog) {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: extra)
    let log = NoticeLog()
    r.trackNotices(log)
    try Self.named.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    return (r, log)
  }

  /// S3: a picker the owner opened (a client is typing in the pane) is not a notice; once the client has been quiet, it is.
  @Test(arguments: [(60.0, false), (1.0, true)])
  func aPromptWaitsWhileAClientTypedLately(quiet: Double, notices: Bool) throws {
    let trigger = NSTemporaryDirectory() + "prm-\(UUID().uuidString.prefix(6))"
    let (r, log) = try rig(["FAKE_REAL_START": "empty", "FAKE_REAL_SWITCH": trigger, "FAKE_REAL_THEN": "bash-permission"])
    defer {
      r.teardown()
      unlink(trigger)
    }
    r.mgr.tune { $0.clientQuiet = quiet }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let client = try attachClient(socket: r.socket, session: "t-trip", home: r.root + "/home") { t, c in r.wait(t, c) }
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    FileManager.default.createFile(atPath: trigger, contents: nil)
    if notices {
      #expect(r.wait(15) { log.all.count == 1 }, "the client is quiet: \(r.mgr.needsYou())")
    } else {
      usleep(4_000_000)
      #expect(log.all.isEmpty, "\(log.all)")
      #expect(r.mgr.needsYou().isEmpty)
    }
  }

  /// L1: the record is the prompt's own hash. After a relaunch another prompt of the same kind (SYNTHETIC: another command) still
  /// notifies, and the open one does not repeat.
  @Test func aDifferentPromptAfterARelaunchStillNotifies() throws {
    let go = NSTemporaryDirectory() + "prm-\(UUID().uuidString.prefix(6))"
    let (r, log) = try rig(["FAKE_REAL_START": "screen:bash-permission", "FAKE_REAL_SWITCH": go, "FAKE_REAL_THEN": "bash-permission-other"])
    defer {
      r.teardown()
      unlink(go)
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { log.all.count == 1 }, "\(r.why("trip"))")
    usleep(900_000)
    r.mgr.detach()
    let again = r.makeManager()
    r.trackNotices(log, dialogLimit: 900, on: again)
    again.tune { $0.promptDebounce = 0.01 }
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(10) { again.needsYou()["trip"] == "Bash command" })
    usleep(1_500_000)
    #expect(log.all.count == 1, "the open prompt is not announced again")
    FileManager.default.createFile(atPath: go, contents: nil)  // another command
    #expect(r.wait(15) { log.all.count == 2 }, "\(log.all)")
  }

  /// The placeholder is dim (real `-e` capture): the pointer is typed. A draft, even one that reads like the placeholder, holds it.
  @Test(arguments: [("input-e-idle-placeholder", true), ("input-e-cleared", true), ("input-e-real-draft", false), ("input-e-draft-looks-like-placeholder", false)])
  func thePointerIsTypedOnlyWhereThereIsNoDraft(screen: String, typed: Bool) throws {
    let (r, _) = try rig(["FAKE_REAL_START": "screen:\(screen)"])
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    if typed {
      #expect(r.wait(8) { r.typedLines.count == 1 }, "\(screen): the placeholder is not a draft")
    } else {
      usleep(3_000_000)
      #expect(r.typedLines.isEmpty, "\(screen): a draft is the owner's")
    }
  }

  /// Pins the fixture's order: the screen is drawn BEFORE the ready file (a draft cannot exist before Claude's UI is up). With a
  /// 2 s pause between the two (FAKE_REAL_DRAW_DELAY), a draft drawn before ready holds the pointer; a fixture that wrote ready
  /// first would leave the pane blank for those 2 s and the pointer would be typed.
  @Test func aDraftDrawnBeforeReadyHoldsThePointer() throws {
    let (r, _) = try rig(["FAKE_REAL_START": "screen:input-e-real-draft", "FAKE_REAL_DRAW_DELAY": "2"])
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    usleep(3_000_000)
    #expect(r.typedLines.isEmpty, "a draft is the owner's")
  }
}

@Suite("Main prompts: review fixes", .serialized, .enabled(if: Rig.hasTmux))
struct MainPromptReviewTests {
  private static func timings(quiet: Double = 30) -> Supervisor.Timings {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    t.dialogStall = 600
    t.promptSettle = 0.5
    t.promptClientQuiet = quiet
    t.stopGrace = 3
    return t
  }

  /// S2: the dev-channel dialog (no rule above its title) is the cold-start question, never also a generic prompt, however long it waits.
  @Test func theDevChannelDialogIsNotAlsoAGenericPrompt() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", timings: Self.timings())
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) })
    for _ in 0..<12 {
      usleep(250_000)
      r.sup.tickNow()
    }
    #expect(r.phonePosts.isEmpty, "\(r.phonePosts)")
    #expect(!r.audit.contains("prompt_notified"), "audit \(r.audit)")
    #expect(r.sup.status.needsYou == .confirmColdStart, "\(String(describing: r.sup.status.needsYou))")
  }

  /// S3 for Main: a client typing lately holds the notice; a quiet one does not.
  @Test(arguments: [(60.0, false), (1.0, true)])
  func aPromptWaitsWhileAClientTypedLately(quiet: Double, posts: Bool) throws {
    let r = try Rig(.tmux, scenario: "prompt-real.sh", env: ["FAKE_PROMPT_SCREEN": "askuser-select"], timings: Self.timings(quiet: quiet))
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let client = try attachClient(socket: r.socket, session: "agent", home: r.home) { t, c in r.wait(t, c) }
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    r.humanEnter()
    if posts {
      #expect(r.wait(20) { r.sup.tickNow(); return r.phonePosts.count == 1 }, "audit \(r.audit)")
    } else {
      for _ in 0..<20 {
        usleep(200_000)
        r.sup.tickNow()
      }
      #expect(r.phonePosts.isEmpty, "\(r.phonePosts)")
    }
  }
}

import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The awake clock of a manager under test: real time, plus a jump a test adds on every read (`perCall`), so a tick can be made to
/// see "the screen has held still for the settle time" at one exact read, without waiting for it.
private final class SteppedAwake: @unchecked Sendable {
  private let lock = NSLock()
  private var offset = 0.0
  private var perCall = 0.0
  func read() -> Double {
    lock.withLock {
      offset += perCall
      return Double(DispatchTime.now().uptimeNanoseconds) / 1e9 + offset
    }
  }
  func jump(perCall s: Double) { lock.withLock { perCall = s } }
}

extension WorkerRig {
  /// The kinds `notice.json` holds open for a worker.
  func openNoticeKinds(_ id: String) -> Set<String> {
    struct Record: Decodable { var open: Bool }
    let d = FileManager.default.contents(atPath: talosHome + "/workers/\(id)/notice.json") ?? Data()
    let m = (try? JSONDecoder().decode([String: Record].self, from: d)) ?? [:]
    return Set(m.filter { $0.value.open }.keys)
  }

  /// The notice kind of the prompt on a worker's pane now (`prompt: <hash>`), as the manager reads the screen.
  func promptKindOnPane(_ id: String) -> String? {
    let rows = TmuxCommands.parseCapture(tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-\(id):"]).out)
    return PromptDetector.detect(rows).map { "prompt: \($0.hash)" }
  }
}

/// Terminal prompts nobody named reach the owner ("terminal prompts must relay to Talos"): a tool permission, the agent's own
/// question, any Select. Main's notice goes to the default thread, a worker's to its own thread. The screens are REAL Claude Code
/// 2.1.318 captures (Fixtures/real-2.1.318) printed back by the fake `claude`; private `-L talos-test-*` tmux sockets, fake HOME.
@Suite("Worker prompts reach its own thread", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerPromptRelayTests {
  static let named = """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","name":"OC Test","kind":"fixed","session":"dedicated"}]}
    """
  static let bashLine = "OC Test's session is waiting on a 'Bash command' prompt, \"Do you want to proceed?\"; open Terminals \u{2192} OC Test on the Mac to answer."

  private func rig(_ extra: [String: String]) throws -> (WorkerRig, NoticeLog) {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: extra)
    let log = NoticeLog()
    r.trackNotices(log)
    try Self.named.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    return (r, log)
  }

  /// A permission prompt comes up on a live worker: flagged, one line into ITS thread (not the default one), nothing typed.
  @Test func aToolPermissionPromptOnALiveWorkerNotifiesItsOwnThreadOnce() throws {
    let trigger = NSTemporaryDirectory() + "prm-\(UUID().uuidString.prefix(6))"
    let (r, log) = try rig(["FAKE_REAL_START": "empty", "FAKE_REAL_SWITCH": trigger, "FAKE_REAL_THEN": "bash-permission"])
    defer {
      r.teardown()
      unlink(trigger)
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.typedLines.count == 1 })
    FileManager.default.createFile(atPath: trigger, contents: nil)
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "Bash command" }, "\(r.mgr.needsYou())")
    #expect(r.wait(5) { log.all.count == 1 })
    usleep(2_500_000)  // well past the settle time and the debounce of a flap
    #expect(log.all.count == 1, "\(log.all)")
    #expect(log.all.first?.thread == "trip")
    #expect(log.all.first?.text == Self.bashLine)
    #expect(r.allEvents.contains(.needsYou(thread: "trip", prompt: "Bash command")))
    #expect(r.typedLines.count == 1, "nothing was typed into the prompt")
    #expect(r.up("trip"), "a live worker stays live")
  }

  /// A worker that opens on a Select (the agent's own question here) stays up for the owner, is flagged, and the pointer is NOT
  /// typed into it (it would answer the Select).
  @Test func aPromptOnAStartingWorkerHoldsTheStartAndTheTypedPointer() throws {
    let (r, log) = try rig(["FAKE_REAL_START": "screen:askuser-select", "FAKE_REAL_NOT_READY": "1"])
    defer { r.teardown() }
    r.mgr.tune { $0.readyTimeout = 2 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "question" }, "\(r.mgr.needsYou()) \(r.why("trip"))")
    #expect(r.wait(5) { log.all.count == 1 })
    usleep(3_500_000)  // past the ready timeout
    #expect(r.state("trip") == "starting", "\(r.why("trip"))")
    #expect(log.all.count == 1)
    #expect(log.all.first?.text == "OC Test's session is waiting on a 'question' prompt, \"Which color do you prefer?\"; open Terminals \u{2192} OC Test on the Mac to answer.")
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
  }

  /// The pointer waits behind a prompt that appeared while a message was pending, and is typed once the prompt is gone.
  @Test func theAnsweredPromptClearsTheFlagAndTheWorkerTakesItsPointer() throws {
    let go = NSTemporaryDirectory() + "prm-\(UUID().uuidString.prefix(6))"
    let (r, log) = try rig(["FAKE_REAL_START": "screen:bash-permission", "FAKE_REAL_SWITCH": go, "FAKE_REAL_THEN": "empty-input"])
    defer {
      r.teardown()
      unlink(go)
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "Bash command" }, "\(r.why("trip"))")
    #expect(r.wait(5) { log.all.count == 1 })
    #expect(r.typedLines.isEmpty)
    FileManager.default.createFile(atPath: go, contents: nil)  // the owner answered in the pane
    #expect(r.wait(10) { r.mgr.needsYou().isEmpty }, "\(r.mgr.needsYou())")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.typedLines.count == 1 }, "the pointer goes in once the prompt is gone")
    #expect(log.all.count == 1)
  }

  /// A relaunch of the app with the prompt still open keeps the one notice.
  @Test func aRelaunchKeepsOneNoticeForAnOpenPrompt() throws {
    let (r, log) = try rig(["FAKE_REAL_START": "screen:bash-permission"])
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { log.all.count == 1 }, "\(r.why("trip"))")
    let kind = try #require(r.promptKindOnPane("trip"))
    // its record is open and a heartbeat has put the pane pid in workers.json
    #expect(r.wait(5) { r.openNoticeKinds("trip").contains(kind) && (r.fileOnDisk?.threads["trip"]?.pane_pid ?? 0) > 1 }, "\(r.openNoticeKinds("trip"))")
    r.mgr.detach()
    let again = r.makeManager()
    r.trackNotices(log, dialogLimit: 900, on: again)
    again.tune { $0.promptDebounce = 0.01 }  // not the debounce: the open prompt is what holds it
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(10) { again.needsYou()["trip"] == "Bash command" }, "re-adopted and flagged again: \(r.why("trip"))")
    usleep(2_000_000)
    #expect(log.all.count == 1, "re-announced after a relaunch: \(log.all)")
  }

  /// The relaunched manager's first look at a prompt that is still open: the screen has held still for the settle time, the prompt's
  /// own settle clock has only just started. That is not "no dialog": the record stays open and nothing is announced again.
  /// The awake clock jumps 10 s on every read during that one tick, so the tick sees a still screen and an unsettled prompt.
  @Test func aRelaunchTickBeforeThePromptSettlesKeepsTheRecordOpen() throws {
    let (r, log) = try rig(["FAKE_REAL_START": "screen:bash-permission"])
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { log.all.count == 1 }, "\(r.why("trip"))")
    let kind = try #require(r.promptKindOnPane("trip"))
    #expect(r.wait(5) { r.openNoticeKinds("trip").contains(kind) && (r.fileOnDisk?.threads["trip"]?.pane_pid ?? 0) > 1 }, "\(r.openNoticeKinds("trip"))")
    r.mgr.detach()
    let clock = SteppedAwake()
    let again = r.manager(now: { Date().timeIntervalSince1970 }, awake: { clock.read() })
    r.trackNotices(log, on: again)
    again.tune { $0.promptDebounce = 0.01 }  // not the debounce: the open record is what holds it
    // The pointer is still owed (the dialog is on the pane), and it now survives the relaunch, so the first tick starts a "no input box"
    // hold on a screen whose prompt has not settled. The jumping clock would run that hold out in one tick (90 s in the app, by which
    // time the prompt is flagged and the hold is not announced); this test is about the prompt's record, so the hold is given all day.
    again.tune { $0.readyTimeout = 100_000 }
    clock.jump(perCall: 10)
    r.firstTick(again)
    clock.jump(perCall: 0)
    #expect(again.snapshot().threads["trip"]?.state == "live", "the first tick adopted and read the worker: \(r.why("trip"))")
    #expect(r.openNoticeKinds("trip").contains(kind), "a prompt not yet settled closed its record: \(r.openNoticeKinds("trip"))")
    again.startTicking()
    #expect(r.wait(10) { again.needsYou()["trip"] == "Bash command" }, "settled and flagged: \(r.why("trip"))")
    usleep(500_000)
    #expect(log.all.count == 1, "re-announced after a relaunch: \(log.all)")
  }

  /// Ordinary output with the same words, and the idle box, never flag a running worker.
  @Test(arguments: ["reply-quotes-prompt", "idle-input-auto", "idle-input-manual", "turn-done", "after-esc"])
  func notAPromptNeverFlags(screen: String) throws {
    let (r, log) = try rig(["FAKE_REAL_START": "screen:\(screen)"])
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    // The pointer goes in where the box is empty. Not on the plain idle captures (no colours, so their placeholder reads as a draft;
    // the real colours are in PromptRelayReviewTests), and not under the quoted `❯ 1. Yes` of reply-quotes-prompt: the typing guard
    // reads any numbered `❯` on screen as a dialog and holds the line (older, deliberately careful; the owner is not told).
    if screen == "turn-done" || screen == "after-esc" {
      #expect(r.wait(5) { r.typedLines.count == 1 }, "the empty box took the pointer")
    }
    usleep(2_500_000)
    #expect(r.mgr.needsYou().isEmpty, "\(r.mgr.needsYou())")
    #expect(log.all.isEmpty)
    #expect(!r.allEvents.contains { if case .needsYou = $0 { return true } else { return false } })
  }

  /// A known dialog is announced as itself, once, and never also as a generic prompt.
  @Test func aKnownDialogHasNoGenericDouble() throws {
    let (r, log) = try rig(["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "trust this folder" })
    #expect(r.wait(5) { log.all.count == 1 })
    usleep(2_500_000)
    #expect(log.all.count == 1, "\(log.all)")
    #expect(log.all.first?.text == "OC Test's session is waiting on a 'trust this folder' prompt; open Terminals \u{2192} OC Test on the Mac to answer.")
    #expect(r.allEvents.filter { if case .needsYou = $0 { return true } else { return false } }.count == 1)
  }
}

@Suite("Main's prompts reach the default thread", .serialized, .enabled(if: Rig.hasTmux))
struct MainPromptRelayTests {
  private static func timings() -> Supervisor.Timings {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    t.dialogStall = 600  // the older "unknown question" warning must not be what these tests watch
    t.promptSettle = 1.0  // the settle is real time against the 0.2 s tick: leave room for a loaded Mac
    t.stopGrace = 3
    return t
  }

  private func running(_ screen: String) throws -> Rig {
    let r = try Rig(.tmux, scenario: "prompt-real.sh", env: ["FAKE_PROMPT_SCREEN": screen], timings: Self.timings())
    try coldStartConfirmed(r)
    return r
  }

  @Test func aToolPermissionPromptInMainPostsOnceToTheDefaultThread() throws {
    let r = try running("bash-permission")
    defer { r.teardown() }
    r.humanEnter()  // the fake session now shows the prompt
    #expect(r.wait(15) { r.sup.tickNow(); return r.phonePosts.count == 1 }, "posts \(r.phonePosts) audit \(r.audit)")
    #expect(
      r.phonePosts.first
        == "post general Testagent is waiting on a 'Bash command' prompt, \"Do you want to proceed?\"; open Terminal on the Mac to answer.")
    for _ in 0..<15 {
      usleep(200_000)
      r.sup.tickNow()
    }
    #expect(r.phonePosts.count == 1, "\(r.phonePosts)")
    // the owner answers it: the notice is over, and the next prompt would be a new one
    r.humanEnter()
    #expect(r.wait(10) { r.sup.tickNow(); return r.audit.contains("prompt_cleared") }, "audit \(r.audit)")
    #expect(r.phonePosts.count == 1)
  }

  @Test func theAgentsOwnQuestionIsNamedAQuestion() throws {
    let r = try running("askuser-select")
    defer { r.teardown() }
    r.humanEnter()
    #expect(r.wait(15) { r.sup.tickNow(); return r.phonePosts.count == 1 }, "posts \(r.phonePosts) audit \(r.audit)")
    #expect(r.phonePosts.first?.contains("waiting on a 'question' prompt, \"Which color do you prefer?\"") == true)
  }

  /// The app relaunched with the prompt still open: one notice, not two.
  @Test func aRelaunchKeepsOneNoticeForAnOpenPrompt() throws {
    let r = try running("write-permission")
    defer { r.teardown() }
    r.humanEnter()
    #expect(r.wait(15) { r.sup.tickNow(); return r.phonePosts.count == 1 }, "posts \(r.phonePosts) audit \(r.audit)")
    let pid = try #require(r.sup.status.childPid)
    r.sup.detach()
    usleep(500_000)
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(5) { s2.status.childPid == pid })
    for _ in 0..<25 {
      usleep(200_000)
      s2.tickNow()
    }
    #expect(r.phonePosts.count == 1, "\(r.phonePosts)")
    #expect(r.audit.contains("prompt_already_open"), "audit \(r.audit)")
  }

  @Test(arguments: ["reply-quotes-prompt", "idle-input-auto", "after-esc", "turn-done"])
  func notAPromptNeverPosts(screen: String) throws {
    let r = try running(screen)
    defer { r.teardown() }
    r.humanEnter()
    #expect(r.wait(5) { r.screenContains("Crunched") || r.screenContains("Auto mode") || r.screenContains("Cogitated") })
    for _ in 0..<15 {
      usleep(200_000)
      r.sup.tickNow()
    }
    #expect(r.phonePosts.isEmpty, "\(r.phonePosts)")
  }

  /// The known dialogs keep their own handling (a warning in the menu); the generic detector says nothing for them.
  @Test func aKnownDialogInMainIsNotAlsoAGenericPost() throws {
    let r = try running("trust-dialog")
    defer { r.teardown() }
    r.humanEnter()
    #expect(r.wait(5) { r.screenContains("trust this folder") })
    for _ in 0..<15 {
      usleep(200_000)
      r.sup.tickNow()
    }
    #expect(r.phonePosts.isEmpty, "\(r.phonePosts)")
  }
}

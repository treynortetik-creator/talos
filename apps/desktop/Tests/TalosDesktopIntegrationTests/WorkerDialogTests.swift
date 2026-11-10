import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Terminal prompts in a worker's pane reach the owner (Option C smoke O5): the worker is flagged needs-you, its thread gets
/// one plain line, and a pointer held back by the owner's draft says so. Real private tmux server; a fake home folder; the owner's
/// tmux, Claude config and bridge are never touched. The screens are REAL Claude Code 2.1.318 captures (Fixtures/real-2.1.318)
/// printed by `worker-real.sh`; `worker-trust.sh` is hand-drawn (SYNTHETIC) and used only for a login dialog and a flapping one.
final class NoticeLog: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [(thread: String, text: String)] = []
  /// What every post comes to: `.failed` is a clear refusal, `.unknown` a timeout (it may have been sent).
  var outcome: PostOutcome = .sent
  /// How long a post takes before it answers.
  var delay: Double = 0
  func post(_ thread: String, _ text: String) -> PostOutcome {
    lock.withLock { items.append((thread, text)) }
    if delay > 0 { usleep(UInt32(delay * 1_000_000)) }
    return outcome
  }
  var all: [(thread: String, text: String)] { lock.withLock { items } }
}

extension WorkerRig {
  /// The owner pressing Enter in a worker's pane.
  func ownerPressesEnter(_ id: String) {
    #expect(tmuxCmd(["send-keys", "-t", "=t-\(id):", "Enter"]).ok)
  }

  func trackNotices(_ log: NoticeLog, retry: Double = 0.1, dialogLimit: Double = 900, on m: WorkerManager? = nil) {
    let m = m ?? mgr!
    m.postNotice = { log.post($0, $1) }
    m.tune {
      $0.noticeRetry = retry
      $0.dialogLimit = dialogLimit
      $0.dialogSettle = 0.5  // a running worker's dialog counts after the screen holds still (5 s in the app)
      $0.cardAckWait = 0  // these tests are about the line the Mac posts; no bridge mints a card here (NeedsYouTests wait for one)
    }
  }
}

@Suite("Worker dialogs reach the owner", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerDialogTests {
  /// ITEM 2. A worker opens on the trust prompt: it stays up, is flagged needs-you, and its thread gets exactly one line that
  /// names the prompt and where to answer it. Nothing is typed into the dialog.
  @Test func aTrustPromptInAWorkerPaneIsNeedsYouWithExactlyOneNotice() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","name":"OC Test","kind":"fixed","session":"dedicated"}]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    r.mgr.tune { $0.readyTimeout = 2 }  // R2-1: waiting on a dialog must not run out the ready timer
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "trust this folder" }, "flag: \(r.mgr.needsYou()) \(r.why("trip"))")
    #expect(r.wait(5) { log.all.count >= 1 })
    // several more ticks, past the ready timeout: the same dialog is not announced again, and the start was not given up
    usleep(3_500_000)
    #expect(log.all.count == 1, "\(log.all)")
    let n = try #require(log.all.first)
    #expect(n.thread == "trip")
    #expect(n.text == "OC Test's session is waiting on a 'trust this folder' prompt; open Terminals \u{2192} OC Test on the Mac to answer.")
    // it stays up for the owner to answer, and nothing was typed
    #expect(r.state("trip") == "starting", "\(r.why("trip"))")
    #expect(r.typedLines.isEmpty)
    #expect(r.allEvents.contains(.needsYou(thread: "trip", prompt: "trust this folder")))
  }

  /// The owner answers in the pane: the flag clears, the worker goes live, the pointer is typed, and no second notice goes out.
  /// Also the case where the bridge had already connected underneath the dialog (the ready file exists).
  @Test(arguments: [false, true]) func answeringItClearsTheFlagAndTheWorkerGoesLive(readyFirst: Bool) throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: readyFirst ? ["FAKE_REAL_START": "trust", "FAKE_REAL_READY_FIRST": "1"] : ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] != nil })
    #expect(r.wait(5) { log.all.count == 1 })
    r.ownerPressesEnter("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.mgr.needsYou().isEmpty }, "the flag clears once the screen has changed")
    #expect(r.wait(5) { r.typedLines.count == 1 }, "the pointer is typed once the dialog is gone")
    usleep(600_000)
    #expect(log.all.count == 1)
  }

  /// A dialog that comes up on a worker that is already live (a folder or setting changed under it) is flagged the same way.
  @Test func aDialogOnALiveWorkerIsFlaggedToo() throws {
    let trigger = NSTemporaryDirectory() + "dlg-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "empty", "FAKE_REAL_SWITCH": trigger, "FAKE_REAL_THEN": "trust-dialog"])
    defer {
      r.teardown()
      unlink(trigger)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.mgr.needsYou().isEmpty }, "the flag clears once the screen has changed")
    FileManager.default.createFile(atPath: trigger, contents: nil)
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "trust this folder" })
    #expect(r.wait(5) { log.all.count == 1 })
    #expect(r.up("trip"), "a live worker stays live; the flag is separate")
  }

  /// A post that fails is tried again, then the owner is told it never went. It never reads as sent.
  @Test func aNoticeThatCannotBePostedIsRetriedThenReported() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    log.outcome = .failed
    r.trackNotices(log, retry: 0.1)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { r.allEvents.contains(.noticeFailed(thread: "trip")) }, "\(log.all.count) tries")
    #expect(log.all.count == 3)
    usleep(800_000)
    #expect(log.all.count == 3, "it gives up after three")
    #expect(r.mgr.needsYou()["trip"] != nil, "the flag stays: the dialog is still there")
  }

  /// Nobody answers: after the limit the worker is stopped as `needs_mac`, as it was before the pane was kept for the owner.
  @Test func aDialogNobodyAnswersStillEndsAsNeedsMac() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log, dialogLimit: 1.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "needs_mac")
    #expect(r.typedLines.isEmpty)
    #expect(r.mgr.needsYou().isEmpty, "a stopped worker waits on nobody")
    #expect(log.all.count == 1)
  }

  /// Resume from the Terminals window: a parked worker starts again, with the same session.
  @Test func resumeFromTheWindowStartsAParkedWorkerAndKeepsAWakeAlreadyWaiting() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.makeManager(idle: 1.0)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 })
    let sid = try #require(r.entry("trip")?.session_id)
    #expect(r.wait(10) { r.state("trip") == "parked" })
    #expect(r.mgr.requestResume("../x") == .failed, "not a thread id")
    #expect(r.mgr.requestResume("trip") == .asked)
    #expect(r.wait(10) { r.starts.count == 2 }, "\(r.why("trip"))")
    #expect(r.starts.last?.contains("--resume \(sid)") == true)
    // a wake the hub wrote is never replaced by ours
    let wake = r.talosHome + "/workers/trip/wake"
    try "hub-wrote-this".write(toFile: wake, atomically: true, encoding: .utf8)
    #expect(r.mgr.requestResume("trip") == .parkPending, "a wake that can't be read is not a start")
    #expect(try String(contentsOfFile: wake, encoding: .utf8) == "hub-wrote-this")
  }

  // MARK: R1-12, R1-6, R1-8, R1-3, R1-5, preamble

  /// R1-12: a park waiting there means Resume would be swallowed. Say so; never report success.
  @Test func resumeSaysSoWhenAParkIsPendingAndWhenAStartIsAlreadyWaiting() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.mgr.requestResume("trip") == .parkPending)
    try FileManager.default.removeItem(atPath: r.talosHome + "/workers/trip/wake")
    try r.wake("trip")  // a pointer: it starts the session
    #expect(r.mgr.requestResume("trip") == .alreadyPending)
    // the wake that was there is still the one that was there
    let kept = try String(contentsOfFile: r.talosHome + "/workers/trip/wake", encoding: .utf8)
    #expect(kept.contains("\"pointer\""))
  }

  /// R1-6: a worker waiting on the owner is not parked for being quiet.
  @Test func aNeedsYouWorkerIsNotIdleParked() throws {
    let trigger = NSTemporaryDirectory() + "dlg-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "empty", "FAKE_REAL_SWITCH": trigger, "FAKE_REAL_THEN": "trust-dialog"])
    defer {
      r.teardown()
      unlink(trigger)
    }
    r.makeManager(idle: 2.0)
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    FileManager.default.createFile(atPath: trigger, contents: nil)
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] != nil })
    // well past the idle time, and past the busy window: still up
    usleep(5_000_000)
    #expect(r.up("trip"), "parked while waiting on the owner: \(r.why("trip"))")
    #expect(r.starts.count == 1)
    // control: with the dialog answered, the same worker parks for being idle
    r.ownerPressesEnter("trip")
    #expect(r.wait(15) { r.state("trip") == "parked" }, "\(r.why("trip"))")
  }

  /// R1-3 in the running app's own loop: quoted dialog words never flag, whatever is on screen.
  @Test func quotedDialogWordsNeverFlag() throws {
    let r = try WorkerRig(scenario: "worker-quote.sh", extraEnv: ["FAKE_QUOTE_NO_MENU": "1"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    usleep(3_000_000)  // far past the settle time
    #expect(r.mgr.needsYou().isEmpty, "\(r.mgr.needsYou())")
    #expect(log.all.isEmpty)
    #expect(!r.allEvents.contains { if case .needsYou = $0 { return true } else { return false } })
  }

  /// The same screen with a question menu of the agent's own at the bottom is a prompt waiting on the owner (PromptRelayTests), but
  /// the quoted dialog words above it still name no known dialog: the one notice is the generic one, about the question.
  @Test func aWorkersOwnMenuIsAPromptAndTheQuotedWordsAreNotDialogs() throws {
    let r = try WorkerRig(scenario: "worker-quote.sh")
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "prompt" }, "\(r.mgr.needsYou())")
    #expect(r.wait(5) { log.all.count == 1 })
    usleep(2_500_000)
    #expect(log.all.count == 1, "\(log.all)")
    #expect(log.all.first?.text == "trip's session is waiting on a prompt, \"Which way?\"; open Terminals \u{2192} trip on the Mac to answer.")
    #expect(r.typedLines.isEmpty, "nothing is typed into the menu")
  }

  /// R1-3: a login dialog flags a running worker too (control for the false-positive cases).
  @Test func aLoginDialogOnARunningWorkerFlags() throws {
    let trigger = NSTemporaryDirectory() + "dlg-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-trust.sh", extraEnv: ["FAKE_TRUST_LATE": trigger, "FAKE_TRUST_LOGIN": "1"])  // SYNTHETIC login dialog: no real capture
    defer {
      r.teardown()
      unlink(trigger)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    FileManager.default.createFile(atPath: trigger, contents: nil)
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "sign in" })
    #expect(r.wait(5) { log.all.count == 1 })
  }

  /// R1-3: a dialog that is not holding still (output scrolling, a spinner) is not flagged until it does.
  @Test func aDialogThatHasNotHeldStillIsNotFlaggedYet() throws {
    let trigger = NSTemporaryDirectory() + "dlg-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "empty", "FAKE_REAL_SWITCH": trigger, "FAKE_REAL_THEN": "trust-dialog"])
    defer {
      r.teardown()
      unlink(trigger)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.dialogSettle = 3 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    FileManager.default.createFile(atPath: trigger, contents: nil)
    usleep(1_500_000)
    #expect(r.mgr.needsYou().isEmpty, "flagged before the screen held still for 3 s")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] != nil })
  }

  /// R1-3: a dialog that comes and goes is announced once per kind in the debounce window, however often it comes back.
  @Test func aDialogThatFlapsIsAnnouncedOncePerKindPerWindow() throws {
    let trigger = NSTemporaryDirectory() + "flap-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-trust.sh", extraEnv: ["FAKE_TRUST_FLAP": trigger])
    defer {
      r.teardown()
      unlink(trigger)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    FileManager.default.createFile(atPath: trigger, contents: nil)
    let flagged = { r.allEvents.filter { if case .needsYou = $0 { return true } else { return false } }.count }
    #expect(r.wait(20) { flagged() >= 3 }, "the dialog came back \(flagged()) times")
    #expect(log.all.count == 1, "\(log.all.count) notices for one kind in 10 minutes")
  }

  /// R1-8: a relaunch with the same dialog still open does not post again.
  @Test func aRelaunchDoesNotAnnounceTheSameOpenDialogAgain() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { log.all.count == 1 })
    usleep(900_000)  // a heartbeat with the pane pid in workers.json
    r.mgr.detach()
    let again = r.makeManager()
    r.trackNotices(log, dialogLimit: 900, on: again)
    again.tune { $0.noticeDebounce = 0.01 }  // not the debounce: the open dialog is what holds it
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(10) { again.needsYou()["trip"] != nil }, "re-adopted and flagged again: \(r.why("trip"))")
    usleep(1_500_000)
    #expect(log.all.count == 1, "re-announced after a relaunch")
  }

  /// R1-8: a timeout may have been sent, so it is not retried; a clear failure is.
  @Test func aTimedOutPostIsNeverRetried() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    log.outcome = .unknown
    r.trackNotices(log, retry: 0.1)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { log.all.count == 1 })
    usleep(1_500_000)
    #expect(log.all.count == 1)
    #expect(!r.allEvents.contains(.noticeFailed(thread: "trip")))
  }

  /// R2-2: on the REAL idle screen the earlier user message (`❯` + ASCII space) in the history is not the input box, so the pointer is
  /// typed. (The first draft guard latched onto it and held the pointer for ever.)
  @Test func theRealIdleScreenTakesThePointerDespiteHistoryLines() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "empty"])
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "\(r.why("trip"))")
    #expect(r.typedLines.first == "trip \(PointerTyper.text)")
    #expect(r.mgr.needsYou().isEmpty)
  }

  /// R1-5, R2-3, R2-5: the owner's draft in the REAL input box (`❯` + U+00A0) holds the pointer with no client attached; after
  /// the wait the thread is told once and the worker shows Needs you; clearing the box lets the pointer go.
  @Test func aRealDraftHoldsThePointerTellsTheThreadOnceThenReleases() throws {
    let clear = NSTemporaryDirectory() + "clr-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(
      scenario: "worker-real.sh",
      extraEnv: ["FAKE_REAL_START": "draft", "FAKE_REAL_SWITCH": clear, "FAKE_REAL_THEN": "empty-input"])
    defer {
      r.teardown()
      unlink(clear)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.draftNoticeAfter = 1.5 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "unsent text" }, "\(r.mgr.needsYou())")
    usleep(2_000_000)
    #expect(r.typedLines.isEmpty, "typed onto a draft: \(r.typedLines)")
    #expect(r.tmuxCmd(["list-clients"]).out.isEmpty, "no client was attached")
    #expect(log.all.count == 1, "\(log.all)")
    #expect(log.all.first?.text == "trip's session has unsent text in its input box; your message has probably gone to the main session. Open Terminals to finish or clear it.")
    FileManager.default.createFile(atPath: clear, contents: nil)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the pointer goes once the box is clear")
    #expect(r.wait(5) { r.mgr.needsYou().isEmpty })
  }

  /// R2-1: the REAL trust dialog (no numbered options) is flagged on a start that never gets ready, and the start is not killed
  /// by the ready timeout while it waits for the owner.
  @Test func theRealTrustDialogIsNotKilledByTheReadyTimeout() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    r.mgr.tune { $0.readyTimeout = 1.5 }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "trust this folder" })
    usleep(4_000_000)  // far past the ready timeout
    #expect(r.state("trip") == "starting", "\(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    #expect(log.all.count == 1)
  }

  /// R2-6: a relaunch with a dialog that was answered while the app was down closes the open record instead of keeping it.
  @Test func aRelaunchClosesAnOpenRecordWhoseDialogIsGone() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { log.all.count == 1 })
    usleep(900_000)
    r.mgr.detach()
    func open() -> Bool {
      let d = FileManager.default.contents(atPath: r.talosHome + "/workers/trip/notice.json") ?? Data()
      return String(decoding: d, as: UTF8.self).contains("\"open\":true")
    }
    #expect(open(), "control: the record is open while the dialog is")
    r.ownerPressesEnter("trip")  // answered while no Talos is running
    let again = r.makeManager()
    r.trackNotices(log, on: again)
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(10) { !open() }, "the record stayed open for a dialog that is gone")
    #expect(log.all.count == 1)
  }

  /// R2-7: a post that fails after its dialog was answered still gives the debounce slot back.
  @Test func aFailedPostAfterTheEpisodeMovedStillReleasesTheSlot() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    log.outcome = .failed
    log.delay = 1.5
    r.trackNotices(log, retry: 30)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { log.all.count == 1 })
    r.ownerPressesEnter("trip")  // answered while the post is still out
    func recorded() -> Bool {
      let d = FileManager.default.contents(atPath: r.talosHome + "/workers/trip/notice.json") ?? Data()
      return String(decoding: d, as: UTF8.self).contains("trust this folder")
    }
    #expect(recorded(), "control: the slot is taken while the post is out")
    #expect(r.wait(10) { !recorded() }, "the slot stayed taken by a notice that never went")
  }

  /// Thread schedules: the worker's preamble says it owns its own thread's schedules, and not the other things.
  @Test func theWorkerPreambleGivesItsOwnThreadsSchedules() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    let start = try #require(r.starts.first)
    #expect(start.contains("schedule_propose") && start.contains("schedules_list") && start.contains("schedule_run_start") && start.contains("schedule_run_done"))
    #expect(start.contains("You don't own briefs, the inbox, other threads"))
    #expect(!start.contains("You don't own schedules"))
  }
}

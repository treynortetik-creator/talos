import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor

/// An owed pointer survives the app going away (docs/OPTION-C.md). What is owed is the pointer line (a wake was taken, the line is
/// not typed yet) and its Enter (the text is in Claude's input box and the Enter failed). Both are in `workers.json`, so a Quit, a
/// crash or an update relaunch between taking the wake and finishing the line does not lose it. The claim deadline decides whether
/// it is still wanted: past it the hub has given the message to main, so nothing is typed, and our own text is cleared from the
/// box, but only when the box holds exactly that text.
///
/// How "the app is gone" is played: the app has no code that runs when it quits (a normal quit, a crash and an update's relaunch all
/// end the process; `QuitCoordinator` stops no worker unless it is "Quit and stop"), so `detach()`, which writes nothing, is the
/// same thing as far as the files go. `crash` also turns the heartbeat off, so the only writes the file ever got are the ones made
/// at the moment a flag changed. A fake `claude` that draws what is typed into its input box (`FAKE_RV_ECHO_BOX`) stands in for the
/// worker. Real private tmux; never `-L talos`.
private let scenario = "review-worker.sh"

/// The wall clock of the second copy of the app, set ahead to play "the claim deadline has passed".
private final class OwedClock: @unchecked Sendable {
  private let l = NSLock()
  private var offset: Double
  init(ahead: Double = 0) { offset = ahead }
  var now: Double { l.withLock { Date().timeIntervalSince1970 + offset } }
}

extension WorkerRig {
  /// What `workers.json` says about the owed pointer, read as plain JSON: the keys are what the file holds, not what a type calls them.
  func owed(_ id: String = "trip") -> (until: String?, enter: Bool?) {
    guard let d = FileManager.default.contents(atPath: talosHome + "/workers.json"),
      let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      let e = (root["threads"] as? [String: Any])?[id] as? [String: Any]
    else { return (nil, nil) }
    return (e["pointer_owed_until"] as? String, e["enter_owed"] as? Bool)
  }

  func screen(_ id: String = "trip") -> String { tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-\(id):"]).out }

  /// The owner typing into the pane, or clearing it again.
  func ownerTypes(_ s: String) { #expect(tmuxCmd(["send-keys", "-t", "=t-trip:", "-l", "--", s]).ok) }
  func ownerBackspaces(_ n: Int) {
    #expect(tmuxCmd(["send-keys", "-t", "=t-trip:"] + Array(repeating: "BSpace", count: n)).ok)
  }

  /// A tmux client on the thread's session, as the Terminals window is while the owner looks at it. Control mode needs no terminal.
  func attachClient() throws -> Process {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: Rig.tmuxPath!)
    p.arguments = ["-L", socket, "-f", Rig.tmuxConf, "-C", "attach-session", "-t", "=t-trip:"]
    p.environment = env
    p.standardInput = Pipe()  // held open for as long as the client lives
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    #expect(wait(5) { !tmuxCmd(["list-clients"]).out.isEmpty }, "the client never attached")
    return p
  }

  /// `enter_owed` taken out of the file, as if the app had gone between the text and the flag.
  func dropEnterFlagFromDisk() throws {
    let url = URL(fileURLWithPath: talosHome + "/workers.json")
    var root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    var threads = try #require(root["threads"] as? [String: Any])
    var e = try #require(threads["trip"] as? [String: Any])
    e["enter_owed"] = nil
    threads["trip"] = e
    root["threads"] = threads
    try JSONSerialization.data(withJSONObject: root).write(to: url)
  }

  /// The app goes away. `quit` lets one heartbeat go by first; `crash` never has one.
  func appGone(_ how: String) {
    if how == "quit" { usleep(700_000) }
    mgr.detach()
  }

  /// The first copy of the app: `crash` has no heartbeat, so the file is only ever written when something changed.
  func firstCopy(_ how: String, tmux: String? = nil) -> WorkerManager {
    let m = manager(tmux: tmux)
    if how == "crash" { m.tune { $0.heartbeat = 3600 } }
    return m
  }

  /// The copy that comes back: it adopts what the file says, on a wall clock that may be ahead.
  func comeBack(ahead: Double = 0, tmux: String? = nil) -> WorkerManager {
    let c = OwedClock(ahead: ahead)
    let m = manager(tmux: tmux, now: { c.now })
    firstTick(m)
    m.startTicking()
    return m
  }
}

@Suite("An owed pointer survives the app", .serialized, .enabled(if: Rig.hasTmux))
struct PointerOwedTests {
  private let line = "trip \(PointerTyper.text)"

  /// Waits until the pointer is owed, the worker is where the test wants it, and the file says so.
  private func owedAndOnDisk(_ r: WorkerRig, phase: String) -> Bool {
    r.wait(10) {
      r.owed().until != nil && (r.fileOnDisk?.threads["trip"]?.pane_pid ?? 0) > 1
        && (phase == "starting" ? r.state("trip") == "starting" : r.up("trip"))
    }
  }

  private func gated(_ phase: String) throws -> (WorkerRig, String) {
    let r = try WorkerRig(scenario: scenario)
    let gate = r.root + "/gate"
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    r.env[phase == "starting" ? "FAKE_RV_READY_FILE" : "FAKE_RV_BOX_FILE"] = gate
    return (r, gate)
  }

  // MARK: the pointer itself

  /// The wake was taken; the worker is still starting, or live with no input box yet. The app goes. The pointer is typed once.
  @Test(arguments: ["quit", "crash"], ["starting", "noBox"])
  func anOwedPointerIsTypedOnceAfterTheAppComesBack(how: String, phase: String) throws {
    let (r, gate) = try gated(phase)
    defer { r.teardown() }
    r.firstCopy(how).startTicking()
    try r.wake("trip")
    #expect(owedAndOnDisk(r, phase: phase), "the owed pointer never reached workers.json: \(r.why("trip")) \(r.owed())")
    #expect(r.typedLines.isEmpty)
    r.appGone(how)
    _ = r.comeBack()
    FileManager.default.createFile(atPath: gate, contents: nil)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the owed pointer was lost: \(r.typedLines) \(r.why("trip"))")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    usleep(800_000)
    #expect(r.typedLines.count == 1, "typed more than once: \(r.typedLines)")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "still owed on disk: \(r.owed())")
    #expect(r.starts.count == 1, "no second run")
  }

  /// Past the claim deadline the hub has given the message to main: a restored pointer is dropped, never typed.
  @Test(arguments: ["quit", "crash"], ["starting", "noBox"])
  func anOwedPointerPastTheDeadlineIsNotTyped(how: String, phase: String) throws {
    let (r, gate) = try gated(phase)
    defer { r.teardown() }
    r.firstCopy(how).startTicking()
    try r.wake("trip")
    #expect(owedAndOnDisk(r, phase: phase), "\(r.why("trip")) \(r.owed())")
    r.appGone(how)
    _ = r.comeBack(ahead: 400)  // past 120 s, the longest the hub waits
    FileManager.default.createFile(atPath: gate, contents: nil)
    #expect(r.wait(10) { r.up("trip") && r.screen().contains("auto mode") }, "the box never came: \(r.why("trip"))")
    #expect(r.wait(5) { r.owed().until == nil }, "the dropped pointer is still owed on disk: \(r.owed())")
    usleep(1_500_000)
    #expect(r.typedLines.isEmpty, "typed after the deadline: \(r.typedLines)")
    #expect(!r.screen().contains(PointerTyper.text))
  }

  /// A cold start waits 120 s, a warm worker 90 (the hub's `CLAIM_DEADLINE_COLD_MS` and `CLAIM_DEADLINE_MS`). 100 s on, a cold
  /// start's pointer is still wanted and a warm worker's is not.
  @Test func theDeadlineIsTheHubsOwnColdAndWarm() throws {
    let (r, gate) = try gated("noBox")
    defer { r.teardown() }
    r.firstCopy("crash").startTicking()
    try r.wake("trip")  // a cold start: the thread had no worker
    #expect(owedAndOnDisk(r, phase: "noBox"))
    r.appGone("crash")
    _ = r.comeBack(ahead: 100)
    FileManager.default.createFile(atPath: gate, contents: nil)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "a cold start's pointer is wanted until 120 s: \(r.typedLines)")
  }

  @Test func aWarmWorkersPointerIsDroppedAfter90Seconds() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    r.firstCopy("crash").startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "control: the first pointer is typed")
    r.ownerTypes("half a thought")  // a draft holds the next pointer, with the worker warm
    #expect(r.wait(5) { r.screen().contains("half a thought") })
    try r.wake("trip", ids: ["m_01JBF3V7Q8K2M4N6P8R0S2T402"])
    #expect(r.wait(5) { r.owed().until != nil }, "the held pointer is not on disk")
    r.appGone("crash")
    _ = r.comeBack(ahead: 100)
    #expect(r.wait(10) { r.owed().until == nil }, "a warm worker's pointer outlived 90 s: \(r.owed())")
    r.ownerBackspaces("half a thought".count)
    usleep(1_200_000)
    #expect(r.typedLines.count == 1, "a pointer was typed for a message main has: \(r.typedLines)")
  }

  /// A thread whose worker had gone (the file says parked) and whose pointer was owed: it is started for it, or not, by the deadline.
  @Test(arguments: [0.0, 400.0])
  func aParkedWorkerWithAnOwedPointerStartsOrNot(ahead: Double) throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let until = ISOTime.string(Date().timeIntervalSince1970 + 60)
    try """
    {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
     "threads":{"trip":{"state":"parked","tmux":"t-trip","cwd":"\(r.agentDir)","pointer_owed_until":"\(until)"}}}
    """.write(toFile: r.talosHome + "/workers.json", atomically: true, encoding: .utf8)
    _ = r.comeBack(ahead: ahead)
    if ahead == 0 {
      #expect(r.wait(10) { r.typedLines.count == 1 }, "the owed pointer started its worker: \(r.why("trip"))")
      #expect(r.typedLines.first == line)
    } else {
      usleep(1_500_000)
      #expect(r.starts.isEmpty, "a worker was started for a message main has")
      #expect(r.typedLines.isEmpty)
      #expect(r.wait(5) { r.owed().until == nil })
    }
  }

  /// Old files: no owed fields means nothing is owed, nothing starts, nothing is typed (as before).
  @Test func aWorkersFileWithoutTheFieldsBehavesAsBefore() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    try """
    {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
     "threads":{"trip":{"state":"parked","tmux":"t-trip","cwd":"\(r.agentDir)"}}}
    """.write(toFile: r.talosHome + "/workers.json", atomically: true, encoding: .utf8)
    _ = r.comeBack()
    usleep(1_500_000)
    #expect(r.starts.isEmpty)
    #expect(r.typedLines.isEmpty)
    #expect(r.state("trip") == "parked")
    #expect(r.owed().until == nil && r.owed().enter == nil, "the file grew fields nobody asked for")
  }

  /// "Quit and stop" drops what waits: nothing is owed in the file it leaves.
  @Test func quitAndStopLeavesNothingOwed() throws {
    let (r, _) = try gated("noBox")
    defer { r.teardown() }
    r.firstCopy("quit").startTicking()
    try r.wake("trip")
    #expect(owedAndOnDisk(r, phase: "noBox"))
    r.mgr.stopAll()
    #expect(r.owed().until == nil && r.owed().enter == nil, "\(r.owed())")
    #expect(r.state("trip") == "parked")
  }

  // MARK: the Enter

  /// The text is in the box and the Enter failed. After a relaunch the box holds our own line: Enter only, not the line twice and
  /// not an owner's draft.
  @Test(arguments: ["quit", "crash"])
  func anOwedEnterIsFinishedWithTheEnterAloneAfterARelaunch(how: String) throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let shim = try r.faultShim()
    r.firstCopy(how, tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "the text was never typed: \(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true && r.owed().until != nil }, "the owed Enter is not on disk: \(r.owed())")
    #expect(r.typedLines.isEmpty)
    r.appGone(how)
    _ = r.comeBack()
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the Enter never went in: \(r.typedLines) \(r.why("trip"))")
    #expect(r.typedLines.first == line, "the text was typed again, or went in with something else: \(r.typedLines)")
    usleep(800_000)
    #expect(r.typedLines.count == 1)
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
  }

  /// Past the deadline the line is not wanted: it is taken out of the box (it is the only thing there), and the box is the owner's again.
  @Test(arguments: ["quit", "crash"])
  func anOwedEnterPastTheDeadlineIsClearedFromTheBox(how: String) throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let shim = try r.faultShim()
    r.firstCopy(how, tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone(how)
    _ = r.comeBack(ahead: 400)
    #expect(r.wait(10) { !r.screen().contains(PointerTyper.text) }, "our text is still in the box:\n\(r.screen())")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
    usleep(800_000)
    #expect(r.typedLines.isEmpty, "the line went in after the deadline: \(r.typedLines)")
    // the stuck-draft bug: with our text read as the owner's, every later pointer would be held. A new message goes in at once.
    try r.wake("trip")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "a later pointer was held: \(r.typedLines)")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
  }

  /// The owner added to the box while the app was away. The box holds more than our line: nothing is typed, sent or cleared, and the
  /// thread is told, with the usual unsent-text line while the message is still wanted.
  @Test func anOwedEnterWithMoreInTheBoxIsHeldAndTellsTheThread() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone("crash")
    r.ownerTypes(" and my own notes")
    let log = NoticeLog()
    let m = r.comeBack()
    r.trackNotices(log, on: m)
    m.tune { $0.draftNoticeAfter = 0.5 }
    #expect(r.wait(10) { m.needsYou()["trip"] == WorkerNotice.draftKind }, "\(m.needsYou())")
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    #expect(log.all.first?.text == WorkerNotice.draftLine(threadName: "trip"))
    usleep(800_000)
    #expect(r.typedLines.isEmpty, "Enter went in on the owner's text: \(r.typedLines)")
    #expect(r.screen().contains("\(PointerTyper.text) and my own notes"), "the box was touched:\n\(r.screen())")
    // the owner clears the box: the message is still wanted, so the line is typed again and sent
    r.ownerBackspaces(PointerTyper.text.count + " and my own notes".count)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "\(r.typedLines)")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    #expect(r.wait(5) { m.needsYou().isEmpty })
  }

  /// The same past the deadline: our line may be in what the owner left, so it is never cleared, and the thread gets its own line.
  @Test func anOldLineWithMoreInTheBoxIsLeftAloneAndTheThreadIsTold() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone("crash")
    r.ownerTypes(" and my own notes")
    let log = NoticeLog()
    let m = r.comeBack(ahead: 400)
    r.trackNotices(log, on: m)
    m.tune { $0.draftNoticeAfter = 0.5 }
    #expect(r.wait(10) { m.needsYou()["trip"] == WorkerNotice.leftoverKind }, "\(m.needsYou())")
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    #expect(log.all.first?.text == WorkerNotice.leftoverLine(threadName: "trip"))
    usleep(800_000)
    #expect(r.typedLines.isEmpty)
    #expect(r.screen().contains("\(PointerTyper.text) and my own notes"), "the owner's text was touched:\n\(r.screen())")
    // the owner clears it themselves: nothing is owed any more, and nothing is typed
    r.ownerBackspaces(PointerTyper.text.count + " and my own notes".count)
    #expect(r.wait(10) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
    #expect(r.wait(5) { m.needsYou().isEmpty })
    usleep(500_000)
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
  }

  // MARK: the Opus review's findings

  /// Finding 1: with a client attached the owner can type, so nothing is ever sent as Backspace. The line is held like any text, the
  /// thread is told, and once the client has gone, nothing can be in the way and the line is cleared.
  @Test func anOldLineIsNeverClearedWhileAClientIsAttached() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone("crash")
    let client = try r.attachClient()
    defer { if client.isRunning { client.terminate() } }
    let log = NoticeLog()
    let m = r.comeBack(ahead: 400)
    r.trackNotices(log, on: m)
    m.tune { $0.draftNoticeAfter = 0.5 }
    #expect(r.wait(10) { m.needsYou()["trip"] == WorkerNotice.leftoverKind }, "\(m.needsYou())")
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    #expect(log.all.first?.text == WorkerNotice.leftoverLine(threadName: "trip"))
    usleep(1_500_000)
    #expect(r.screen().contains(PointerTyper.text), "text was cleared with a client attached:\n\(r.screen())")
    #expect(r.typedLines.isEmpty)
    client.terminate()
    #expect(r.wait(10) { !r.screen().contains(PointerTyper.text) }, "not cleared once the client had gone:\n\(r.screen())")
    #expect(r.wait(5) { r.owed().until == nil && m.needsYou().isEmpty }, "\(r.owed()) \(m.needsYou())")
    #expect(r.typedLines.isEmpty)
  }

  /// Finding 7: three rounds of Backspace that do not take the line out leave it alone, and the thread is told.
  @Test func aLineThatWillNotClearIsGivenUpOnAfterThreeRounds() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    r.env["FAKE_RV_NO_BSPACE"] = "1"
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone("crash")
    let log = NoticeLog()
    let m = r.comeBack(ahead: 400)
    r.trackNotices(log, on: m)
    m.tune { $0.draftNoticeAfter = 0.5 }
    #expect(r.wait(10) { m.needsYou()["trip"] == WorkerNotice.leftoverKind }, "\(m.needsYou())")
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    #expect(r.screen().contains(PointerTyper.text))
    #expect(r.typedLines.isEmpty)
    #expect(r.owed().until != nil, "dropped while our line is still in the box")
  }

  /// Finding 2: a dim copy of our line (a placeholder or suggestion) is not text. The pointer is typed in full, not finished with Enter.
  @Test func aDimCopyOfOurLineIsNotOurText() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    r.env["FAKE_RV_DIM_TEXT"] = PointerTyper.text
    r.makeManager().startTicking()  // the manager the rig made in init holds the env as it was then: this one gets the fake's knobs
    try r.wake("trip")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "Enter alone went into a box that only showed a dim suggestion: \(r.typedLines)")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
  }

  /// The same, for a pointer from an earlier copy of the app, inside its deadline: the box shows only a dim copy of our line, so the
  /// line is typed in full. Were the dim copy taken for text of ours, only an Enter would go into the box, the pointer would be marked
  /// done and nothing would be sent.
  @Test func aDimCopyOfOurLineIsNotOurTextForARestoredPointer() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    r.env["FAKE_RV_DIM_TEXT"] = PointerTyper.text
    let until = ISOTime.string(Date().timeIntervalSince1970 + 60)
    try """
    {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
     "threads":{"trip":{"state":"parked","tmux":"t-trip","cwd":"\(r.agentDir)","pointer_owed_until":"\(until)"}}}
    """.write(toFile: r.talosHome + "/workers.json", atomically: true, encoding: .utf8)
    _ = r.comeBack()
    #expect(r.wait(10) { r.typedLines.count == 1 }, "Enter alone went into a box that only showed a dim suggestion: \(r.typedLines) \(r.why("trip"))")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    usleep(800_000)
    #expect(r.typedLines.count == 1, "typed more than once: \(r.typedLines)")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "still owed on disk: \(r.owed())")
  }

  /// Finding 3a: a wake file that waited (the hub wrote it long ago) counts its deadline from when the hub wrote it.
  @Test func aStaleWakeFilesDeadlineCountsFromTheHub() throws {
    let (r, gate) = try gated("noBox")
    defer { r.teardown() }
    r.firstCopy("crash").startTicking()
    try r.wake("trip", at: Date().timeIntervalSince1970 - 300)
    #expect(owedAndOnDisk(r, phase: "noBox"))
    r.appGone("crash")
    _ = r.comeBack()
    FileManager.default.createFile(atPath: gate, contents: nil)
    #expect(r.wait(10) { r.up("trip") && r.screen().contains("auto mode") })
    #expect(r.wait(5) { r.owed().until == nil }, "\(r.owed())")
    usleep(1_200_000)
    #expect(r.typedLines.isEmpty, "typed for a message the hub gave to main long ago: \(r.typedLines)")
  }

  /// Finding 3c: a start that finishes after the deadline types nothing, for a restored pointer too.
  @Test func aRestoredPointerIsNotTypedByAStartThatEndsAfterItsDeadline() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let gate = r.root + "/gate"
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    r.env["FAKE_RV_READY_FILE"] = gate
    let until = ISOTime.string(Date().timeIntervalSince1970 + 3)
    try """
    {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
     "threads":{"trip":{"state":"parked","tmux":"t-trip","cwd":"\(r.agentDir)","pointer_owed_until":"\(until)"}}}
    """.write(toFile: r.talosHome + "/workers.json", atomically: true, encoding: .utf8)
    _ = r.comeBack()
    #expect(r.wait(5) { r.state("trip") == "starting" }, "the owed pointer started its worker: \(r.why("trip"))")
    sleep(4)  // past the deadline, with the start still waiting
    FileManager.default.createFile(atPath: gate, contents: nil)
    #expect(r.wait(10) { r.up("trip") && r.screen().contains("auto mode") }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().until == nil }, "\(r.owed())")
    usleep(1_200_000)
    #expect(r.typedLines.isEmpty, "typed by a start that ended after the deadline: \(r.typedLines)")
  }

  /// Finding 4: the wake file is gone the moment it is taken, so the file that says the pointer is owed is written then, before the
  /// start. The tmux shim copies `workers.json` as `new-session` runs.
  @Test func theOwedPointerIsOnDiskBeforeTheStartBegins() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let copy = r.root + "/at-start.json"
    let shim = r.root + "/tmux-copy"
    try """
    #!/bin/bash
    for a in "$@"; do [ "$a" = new-session ] && cp '\(r.talosHome)/workers.json' '\(copy)' 2>/dev/null; done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    let m = r.manager(tmux: shim)
    try r.wake("trip")
    m.tickOnce()
    let d = try #require(FileManager.default.contents(atPath: copy), "new-session never ran")
    let f = try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
    let e = (f["threads"] as? [String: Any])?["trip"] as? [String: Any]
    #expect(e?["pointer_owed_until"] as? String != nil, "the file did not say the pointer was owed when the start began: \(String(describing: e))")
  }

  /// Finding 5: the owner cleared the box while the app was away. Enter into an empty box would lose the message: the line is typed again.
  @Test func anOwedEnterWithTheBoxClearedMeanwhileTypesTheLineAgain() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone("crash")
    r.ownerBackspaces(PointerTyper.text.count)
    #expect(r.wait(5) { !r.screen().contains(PointerTyper.text) })
    _ = r.comeBack()
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the message was lost to an Enter into an empty box: \(r.typedLines)")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
  }

  /// Finding 7: our line in the box is ours with the flag missing from the file (the app went between the text and the flag).
  @Test func ourLineInTheBoxIsRecognisedWithoutTheFlag() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone("crash")
    try r.dropEnterFlagFromDisk()
    #expect(r.owed().until != nil && r.owed().enter == nil)
    _ = r.comeBack()
    #expect(r.wait(10) { r.typedLines.count == 1 }, "read as the owner's draft, or typed again: \(r.typedLines)")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    usleep(800_000)
    #expect(r.typedLines.count == 1)
  }

  /// Findings 3b and 6, on the runtime itself: a deadline is never pushed out without a wake, and nothing owed means nothing left of
  /// a hold (a stale `leftover` would make a later ordinary draft hold post the wrong line).
  @Test func theDeadlineKeepsTheEarliestAndNothingOwedLeavesNothingBehind() {
    var r = WorkerManager.Runtime(entry: .init(threadId: "trip", cwd: "/tmp/x"))
    r.owePointer(cold: false, now: 1000, wakeAt: 400)  // a stale file: counts from when the hub wrote it
    #expect(r.owed.until == 490)
    r.owePointer(cold: true, now: 1100, wakeAt: nil)  // a park finished, a crash: no new wake
    #expect(r.owed.until == 490, "pushed out without a wake")
    r.owed.leftover = true
    r.owePointer(cold: true, now: 2000, wakeAt: 2000)  // a newer message
    #expect(r.owed.until == 2120 && !r.owed.leftover)
    r.owed.leftover = true
    r.owed.clears = 2
    r.pendingPointer = false  // fail(), a drop, stopAll, a typed pointer: whatever clears it
    #expect(r.owed.leftover == false && r.owed.clears == 0 && r.owed.until == nil)
    r.owePointer(cold: false, now: 3000, wakeAt: nil)
    #expect(r.owed.until == 3090 && !r.owed.leftover)
  }
}

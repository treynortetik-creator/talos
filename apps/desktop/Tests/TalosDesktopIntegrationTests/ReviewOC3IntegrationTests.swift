import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Independent review of PR #68 (OC3) through the real seams: a private tmux server (`talos-test-…`, never `-L talos`) and
/// the fake claude (`review-worker.sh`). Tests named FINDING fail until the finding is fixed; the others are controls.
extension WorkerRig {
  /// Like `makeManager`, with the options the builder's rig doesn't expose.
  @discardableResult
  func manager(
    install: Bool = true, idle: Double? = nil, tmux: String? = nil, parkGrace: Double = 2,
    readyTimeout: Double = 8, capHold: Double = 120, busyWindow: Double = 0.5, mainPanePid: @escaping @Sendable () -> Int32 = { 0 },
    now: (@Sendable () -> Double)? = nil, awake: (@Sendable () -> Double)? = nil
  ) -> WorkerManager {
    var o = WorkerManager.Options(
      talosHome: talosHome, agentDir: agentDir, claudePath: Rig.fixtures + "/claude",
      permissionFlag: "--dangerously-skip-permissions", tmux: tmux ?? Rig.tmuxPath!, tmuxConf: Rig.tmuxConf)
    o.socket = socket
    o.home = root + "/home"
    o.tick = 0.2
    o.heartbeat = 0.5
    o.readyTimeout = readyTimeout
    o.parkGrace = parkGrace
    o.capHold = capHold
    o.idleSecondsOverride = idle
    o.busyWindow = busyWindow  // `window_activity` is whole seconds: tests with a noisy worker need more than 1 s
    let e = env
    let m: WorkerManager
    if let now, let awake {
      m = WorkerManager(
        options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e }, mainPanePid: mainPanePid, now: now, awake: awake)
    } else if let now {
      m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e }, mainPanePid: mainPanePid, now: now)
    } else {
      m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e }, mainPanePid: mainPanePid)
    }
    record(m)
    if install {
      mgr?.detach()
      mgr = m
    }
    return m
  }

  func up(_ id: String) -> Bool { ["live", "busy"].contains(state(id) ?? "") }

  func writeConfig(maxLive: Int, threads: [(String, String?)]) throws {
    let list = threads.map { id, cwd -> String in
      let opts = cwd.map { ",\"session_opts\":{\"cwd\":\"\($0)\"}" } ?? ""
      return "{\"id\":\"\(id)\",\"name\":\"\(id)\",\"kind\":\"fixed\",\"session\":\"dedicated\"\(opts)}"
    }.joined(separator: ",")
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":\(maxLive)},"threads":[{"id":"general","kind":"fixed"},\(list)]}
    """.write(toFile: talosHome + "/config.json", atomically: true, encoding: .utf8)
  }

  func wakeFile(_ id: String, action: String, reason: String) throws {
    let d = talosHome + "/workers/" + id
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    try "{\"v\":1,\"thread_id\":\"\(id)\",\"message_ids\":[],\"at\":\"2026-10-30T00:00:00.000Z\",\"reason\":\"\(reason)\",\"action\":\"\(action)\"}"
      .write(toFile: d + "/wake", atomically: true, encoding: .utf8)
  }

  func tmuxCmd(_ args: [String]) -> RunResult {
    ProcessRunner.run([Rig.tmuxPath!, "-L", socket, "-f", Rig.tmuxConf] + args, env: env, timeout: 5)
  }

  var fileOnDisk: WorkersFile? {
    FileManager.default.contents(atPath: talosHome + "/workers.json").flatMap(WorkersFile.decode)
  }

  /// A wrapper around the real tmux: fails one `display-message` when `flag` exists, logs every `send-keys`.
  func tmuxShim(flag: String, log: String) throws -> String {
    let p = root + "/tmux-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = display-message ] && [ -f '\(flag)' ]; then rm -f '\(flag)'; exit 1; fi
      if [ "$a" = send-keys ]; then echo send-keys >> '\(log)'; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: p, atomically: true, encoding: .utf8)
    chmod(p, 0o755)
    return p
  }

  /// Pids this test's fixtures left behind on purpose.
  func killLeftovers(_ file: String) {
    for l in lines(file) { if let p = Int32(l), p > 1 { kill(p, SIGKILL) } }
  }
}

private final class Clock: @unchecked Sendable {
  private let l = NSLock()
  private var t = Date().timeIntervalSince1970
  var now: Double { l.withLock { t } }
  func advance(_ s: Double) { l.withLock { t += s } }
}

private let reviewScenario = "review-worker.sh"

@Suite("Review OC3 two copies", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3TwoCopies {
  /// Supervisor.swift holds a flock so a dev build next to the installed app stays passive for main (D1). The app starts
  /// `workers?.startTicking()` unconditionally and WorkerManager has no lock, so both copies heartbeat and take wakes.
  @Test func FINDING_aSecondTalosCopyStaysPassive() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    r.manager()
    let a = r.mgr!
    let b = r.manager(install: false)
    defer { b.detach() }
    a.startTicking()
    b.startTicking()
    // `wait` returns as soon as its condition holds: this is only how long a loaded machine (CI runs suites side by side) may take.
    let budget = 60.0
    try r.wake("trip")
    #expect(
      r.wait(budget) {
        [a, b].contains { ["live", "busy"].contains($0.snapshot().threads["trip"]?.state ?? "") }
      }, "the first wake did not bring up a live worker")
    // the hub's hello needs this entry, and a heartbeat without it means "no worker" to the router
    var misses = 0
    for _ in 0..<40 {
      if (r.fileOnDisk?.threads["trip"]?.pane_pid ?? 0) <= 1 { misses += 1 }
      usleep(50_000)
    }
    #expect(misses == 0, "workers.json lost the live worker \(misses) of 40 reads")
    // later messages are taken by whichever copy wins the rename
    let wakes = 5
    var sent = 1  // the first wake above
    for _ in 0..<wakes {
      // One wake, one typed line, in order: a wake read while the one before it is still waiting to be typed would be folded into
      // it, so each waits for the one before. A loaded machine only makes this slower.
      guard r.wait(budget, { r.typedLines.count == sent }) else { break }
      try r.wake("trip")
      sent += 1
    }
    #expect(![a, b].contains { $0.snapshot().threads["trip"]?.state == "failed" }, "one copy failed a live worker")
    // Typing follows each wake by a tick or two, so a loaded machine can lag the last one: wait for the count to arrive.
    #expect(r.wait(budget) { r.typedLines.count == sent }, "every wake typed once: \(r.typedLines.count) lines typed for \(sent) wakes sent")
  }
}

// Dropped by owner decision (2026-10-30, 15:29: Telegram is being retired): the Telegram guard is removed, so its seven
// tests are gone with it: FINDING_aWorkerThatTouchesBotPidAndDiesBeforeTheCheckStillTrips, …AndNeverConnectsStillTrips,
// FINDING_aWorkerParkedInsideTheWindowStillTrips, FINDING_aWorkerThatTouchesBotPidAfterTheOneCheckStillTrips,
// FINDING_aRelaunchInsideTheWindowDoesNotSkipTheCheck, FINDING_mainRestartingItsOwnPollerDoesNotTripTheGuard,
// FINDING_aTripSurvivesAnAppRelaunchEvenBeforeTheBridgeActed. Workers still never get channels or tokens:
// everyLaunchPathIsCleanInTheRunningProcess and the WorkerSpec tests hold that line.

@Suite("Review OC3 parking", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3Parking {
  /// Spec 2.4 "never mid-turn", 6.3 "park every worker after its current turn". `handle` calls `beginPark` straight away.
  @Test func FINDING_aGovernorParkWaitsForTheTurnToFinish() throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    defer { r.teardown() }
    let sig = r.root + "/signals"
    r.env["FAKE_RV_SIGLOG"] = sig
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    r.manager(busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" }, "mid-turn")
    try r.wakeFile("trip", action: "park", reason: "governor")
    usleep(1_500_000)
    #expect(r.lines(sig).isEmpty, "SIGTERM mid-turn")
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    #expect(r.wait(8) { r.state("trip") == "parked" }, "parked after the turn")
  }

  /// Spec section 8 row 13 and the comment at WorkerManager.swift:150: "park after the current turn".
  @Test func FINDING_switchingAThreadOffMidTurnParksAfterTheTurn() throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    defer { r.teardown() }
    let sig = r.root + "/signals"
    r.env["FAKE_RV_SIGLOG"] = sig
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    r.manager(busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" })
    try "{\"default_thread\":\"general\",\"threads\":[]}".write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    usleep(1_500_000)
    #expect(r.lines(sig).isEmpty, "SIGTERM mid-turn")
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    #expect(r.wait(8) { r.state("trip") == "parked" })
  }

  /// tmux marks the pane dead when the leader exits, and `advance` finishes the park without the SIGKILL, so a child that
  /// ignored SIGTERM (an MCP server on pipes, a background job) outlives "parked". PR text: "SIGTERM, then SIGKILL".
  @Test func FINDING_parkingLeavesNothingInTheGroup() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    r.env["FAKE_RV_CHILD"] = r.root + "/child"
    r.manager(parkGrace: 1)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    defer { r.killLeftovers(r.root + "/child.trip") }
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(15) {
      r.allEvents.contains {
        if case .parked(let thread, _) = $0 { return thread == "trip" }
        return false
      }
    })
    #expect(r.wait(5) { r.state("trip") == "parked" })  // the snapshot publishes at the end of the tick that emitted .parked
    usleep(1_500_000)
    #expect(!ProcessInspect.groupAlive(pid), "a child of the parked worker is still running")
  }

  @Test func FINDING_aCrashLeavesNothingInTheGroup() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    r.env["FAKE_RV_CHILD"] = r.root + "/child"
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    defer { r.killLeftovers(r.root + "/child.trip") }
    let pid = try #require(r.entry("trip")?.pane_pid)
    kill(pid, SIGKILL)
    #expect(r.wait(15) {
      r.allEvents.contains {
        if case .parked(let thread, _) = $0 { return thread == "trip" }
        return false
      }
    })
    #expect(r.wait(5) { r.state("trip") == "parked" })  // the snapshot publishes at the end of the tick that emitted .parked
    usleep(1_000_000)
    #expect(!ProcessInspect.groupAlive(pid), "the crashed worker's children are orphaned")
  }

  /// Spec 3.5: on relaunch the supervisor "parks any worker idle past its limit". adopt() resets the clock, so each
  /// relaunch buys another full idle period.
  @Test func FINDING_anAdoptedWorkerAlreadyIdlePastItsLimitParks() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    #expect(r.wait(3) { (r.fileOnDisk?.threads["trip"]?.pane_pid ?? 0) > 1 })
    r.mgr.detach()
    usleep(5_500_000)
    // A limit of 4 s: an adopt that restarted the clock would park only 4 s after it, so parking within the 3 s of ticks below means the
    // idle time was kept. A loaded Mac may need more than the two ticks this used to allow to read the pane.
    r.manager(idle: 4)
    r.firstTick()
    #expect(
      r.wait(3) { r.mgr.tickOnce(); return ["parking", "parked"].contains(r.state("trip") ?? "") },
      "\(String(describing: r.state("trip")))")
  }

  /// A message arriving in the park window is dropped: `handle` starts only from off/parked, and `finishPark` never
  /// looks at the pending pointer, so the thread sits parked until the hub's deadline hands it to main.
  @Test func FINDING_aMessageDuringParkingResumesTheWorker() throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["FAKE_RV_IGNORE_TERM": "1"])
    defer { r.teardown() }
    r.manager(parkGrace: 1)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "parking" })
    try r.wake("trip")
    #expect(r.wait(6) { r.starts.count == 2 }, "the message never resumed the worker: \(String(describing: r.state("trip")))")
  }

  @Test(arguments: ["restart", "fresh"])
  func FINDING_aControlDuringParkingDoesNotFailTheThread(action: String) throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["FAKE_RV_IGNORE_TERM": "1"])
    defer { r.teardown() }
    r.manager(parkGrace: 1)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "parking" })
    try r.wakeFile("trip", action: action, reason: "control")
    usleep(3_000_000)
    #expect(r.state("trip") != "failed", "\(String(describing: r.entry("trip")?.error))")
    #expect(r.wait(5) { r.up("trip") }, "\(action) never got a worker going")
    #expect(r.mgr.ownedGroups.count == 1, "stale groups stay whitelisted in main's takeover check: \(r.mgr.ownedGroups)")
  }

  /// `loadSettings` reads anything unparsable as "off", and "off" SIGTERMs every worker. smoke/option-c.md tells the owner
  /// to hand-edit config.json for rollback; one bad save kills every turn in flight.
  @Test func FINDING_anUnreadableConfigDoesNotParkEveryWorker() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    try "{\"default_thread\":\"general\",\"dedicated\":{\"enab".write(
      toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    usleep(800_000)
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
  }

  /// Spec 2.5: 5 exits in 15 min = `crash_loop`. `restartTimes` is memory only, so a relaunch forgets what the file says.
  @Test func FINDING_theCrashLoopCountSurvivesARelaunch() throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["FAKE_RV_EXIT_AFTER": "0.5"])
    defer { r.teardown() }
    var e = WorkersFile.Entry(threadId: "trip", cwd: r.agentDir)
    e.state = "parked"
    e.session_id = "11111111-2222-4333-8444-555555555555"
    let t = Date().timeIntervalSince1970
    e.restarts = (1...4).map { ISOTime.string(t - Double($0) * 10) }
    let f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-10-30T00:00:00.000Z", workers_supported: true, main_pane_pid: 0), threads: ["trip": e])
    try f.encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(5) { r.lines(r.log).count == 1 })
    #expect(r.wait(5) { ["parked", "failed"].contains(r.state("trip") ?? "") && r.entry("trip")?.pane_pid == 0 })
    #expect(r.entry("trip")?.error?.code == "crash_loop", "\(String(describing: r.state("trip")))")
  }

  /// adopt() turns `starting` into `live`, so a session that never connected gets pointers and no ready timeout.
  @Test func FINDING_aStartingWorkerAdoptedIsStillStarting() throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["FAKE_RV_NO_READY": "1"])
    defer { r.teardown() }
    r.manager(readyTimeout: 30)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "starting" })
    #expect(r.wait(3) { (r.fileOnDisk?.threads["trip"]?.pane_pid ?? 0) > 1 })
    r.mgr.detach()
    r.manager(readyTimeout: 30)
    r.firstTick()
    #expect(r.state("trip") == "starting", "\(String(describing: r.state("trip")))")
  }

  /// Control: 30 minutes by default (not the test override), on the injected clock.
  @Test func parksAtThirtyMinutesByDefaultNotBefore() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    let clock = Clock()
    r.manager(now: { clock.now })
    r.firstTick()
    try r.wake("trip")
    #expect(r.wait(8) { r.mgr.tickOnce(); return r.up("trip") })
    usleep(800_000)
    r.mgr.tickOnce()
    let pid = try #require(r.entry("trip")?.pane_pid)
    clock.advance(29 * 60)
    r.mgr.tickOnce()
    #expect(r.up("trip"), "not at 29 min")
    clock.advance(2 * 60)
    r.mgr.tickOnce()
    #expect(r.state("trip") == "parking")
    #expect(r.wait(5) { r.mgr.tickOnce(); return r.state("trip") == "parked" })
    #expect(r.wait(5) { !ProcessInspect.groupAlive(pid) })
    #expect(r.mgr.ownedGroups.isEmpty, "the parked group left the takeover whitelist")
  }

  /// Control: parking one worker signals its group only, and the id survives into the resume.
  @Test func parkingOneWorkerNeverTouchesAnother() throws {
    let r = try WorkerRig(threads: ["trip", "garden"], scenario: reviewScenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    try r.wake("garden")
    #expect(r.wait(10) { r.up("trip") && r.up("garden") })
    let a = try #require(r.entry("trip"))
    let b = try #require(r.entry("garden"))
    #expect(a.session_id != b.session_id)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(15) {
      r.allEvents.contains {
        if case .parked(let thread, _) = $0 { return thread == "trip" }
        return false
      }
    })
    #expect(r.wait(5) { r.state("trip") == "parked" })  // the snapshot publishes at the end of the tick that emitted .parked
    #expect(r.up("garden"))
    #expect(r.entry("garden")?.pane_pid == b.pane_pid)
    #expect(ProcessInspect.groupAlive(b.pane_pid))
    #expect(r.mgr.signaller.log.allSatisfy { $0.0 == a.pane_pid })
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    let last = try #require(r.lines(r.log).last)
    #expect(last.contains("--resume \(a.session_id!)"))
    #expect(!last.contains(b.session_id!))
  }
}

@Suite("Review OC3 cap", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3Cap {
  /// `planStart` parks one victim and starts one, so a lower `max_live` (or more adopted workers than the cap) never
  /// comes down to the limit.
  @Test func FINDING_aLoweredCapIsHonoured() throws {
    let r = try WorkerRig(threads: ["aa", "bb", "cc", "dd"], maxLive: 3, scenario: reviewScenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    for t in ["aa", "bb", "cc"] { try r.wake(t) }
    #expect(r.wait(10) { ["aa", "bb", "cc"].allSatisfy(r.up) })
    usleep(800_000)
    try r.writeConfig(maxLive: 1, threads: [("aa", nil), ("bb", nil), ("cc", nil), ("dd", nil)])
    try r.wake("dd")
    #expect(r.wait(10) { r.up("dd") })
    usleep(2_000_000)
    let n = r.mgr.snapshot().threads.values.filter { WorkersFile.liveStates.contains($0.state) }.count
    #expect(n <= 1, "\(n) live at max_live 1")
  }

  /// `liveList` leaves out `parking`, whose process is alive for up to the 5 s grace.
  @Test func FINDING_aParkingWorkerStillCountsTowardTheCap() throws {
    let r = try WorkerRig(threads: ["aa", "bb"], maxLive: 1, scenario: reviewScenario, extraEnv: ["FAKE_RV_IGNORE_TERM": "1"])
    defer { r.teardown() }
    r.manager(parkGrace: 2)
    r.mgr.startTicking()
    try r.wake("aa")
    #expect(r.wait(8) { r.up("aa") })
    let pid = try #require(r.entry("aa")?.pane_pid)
    try r.wakeFile("aa", action: "park", reason: "control")
    #expect(r.wait(3) { r.state("aa") == "parking" })
    try r.wake("bb")
    var overlap = false
    let until = Date().addingTimeInterval(4)
    while Date() < until, !overlap {
      if r.up("bb") || r.state("bb") == "starting", ProcessInspect.groupAlive(pid), r.state("aa") == "parking" { overlap = true }
      usleep(50_000)
    }
    #expect(!overlap, "two workers alive at max_live 1")
  }

  /// A held wake is not cleared when a later wake starts the thread, so `retryHeld` starts it again in the same tick:
  /// tmux refuses, and the live worker is marked `failed` with nobody watching it.
  @Test func FINDING_aHeldThreadStartedByALaterWakeIsNotStartedTwice() throws {
    let r = try WorkerRig(threads: ["aa", "bb"], maxLive: 1, scenario: reviewScenario, extraEnv: ["FAKE_RV_NOISE": "aa"])
    defer { r.teardown() }
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    r.manager(busyWindow: 1.5)
    r.firstTick()
    try r.wake("aa")
    #expect(r.wait(8) { r.mgr.tickOnce(); return r.state("aa") == "busy" })
    try r.wake("bb")
    r.mgr.tickOnce()
    #expect(r.lines(r.log).count == 1, "held: aa is busy")
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    usleep(3_000_000)  // aa goes quiet, past the busy window, before the next tick
    try r.wake("bb")
    r.mgr.tickOnce()
    #expect(r.state("bb") != "failed", "\(String(describing: r.entry("bb")?.error))")
    #expect(r.wait(5) { r.mgr.tickOnce(); return r.up("bb") })
  }

  /// Control: all busy = nothing parks, and the wake is dropped after the hold. A dropped wake stays dropped: when the busy
  /// worker goes quiet and there is room, the thread whose wake was dropped does not start by itself.
  /// The hold is measured on the manager's wall clock, which the test moves; the ticks are driven here, one call each.
  @Test func allBusyHoldsParksNothingThenDrops() throws {
    let r = try WorkerRig(threads: ["aa", "bb"], maxLive: 1, scenario: reviewScenario, extraEnv: ["FAKE_RV_NOISE": "aa"])
    defer { r.teardown() }
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    let clock = HoldClock()
    r.manager(capHold: 1, busyWindow: 2.5, now: { clock.now })
    r.firstTick()
    try r.wake("aa")
    #expect(r.wait(8) { r.mgr.tickOnce(); return r.state("aa") == "busy" })
    try r.wake("bb")
    let bbWake = r.talosHome + "/workers/bb/wake"
    #expect(r.wait(5) { r.mgr.tickOnce(); return !FileManager.default.fileExists(atPath: bbWake) }, "bb's wake was taken, and held")
    clock.skip(2)  // past the 1 s hold
    r.mgr.tickOnce()  // the hold ends on this tick
    #expect(r.state("aa") == "busy")
    #expect(r.lines(r.log).count == 1, "nothing parked, nothing started")
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    #expect(r.wait(10) { r.mgr.tickOnce(); return r.state("aa") != "busy" }, "aa went quiet, so there is room for bb")
    for _ in 0..<10 { r.mgr.tickOnce() }  // ticks with room and no hold: a held wake would start bb on one of them
    #expect(!r.up("bb"), "bb's wake was dropped, so bb stays down: \(String(describing: r.state("bb")))")
    #expect(r.lines(r.log).count == 1, "bb never started")
  }
}

/// A wall clock that follows real time plus whatever a test adds.
private final class HoldClock: @unchecked Sendable {
  private let l = NSLock()
  private var added: Double = 0
  var now: Double { l.withLock { Date().timeIntervalSince1970 + added } }
  func skip(_ s: Double) { l.withLock { added += s } }
}

@Suite("Review OC3 folders and launch", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3Folders {
  /// tmux expands `-c` as a format. `folderProblem` checks the literal path, tmux runs somewhere else: `#{l:..}` walks out
  /// of the checked folder, here into `~/.claude`, and a failed expansion falls back to the home folder (OBSERVED).
  @Test func FINDING_theFolderCheckedIsTheFolderTheWorkerRunsIn() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    let literal = r.root + "/home" + "/proj/#{l:..}/#{l:.claude}"
    try FileManager.default.createDirectory(atPath: literal, withIntermediateDirectories: true)
    r.env["FAKE_RV_PWD"] = r.root + "/pwd"
    try r.writeConfig(maxLive: 3, threads: [("trip", literal)])
    r.manager()
    #expect(WorkerSpec.folderProblem(literal, home: r.root + "/home", talosHome: r.talosHome) == nil, "the check passes it")
    r.mgr.startTicking()
    try r.wake("trip")
    _ = r.wait(5) { FileManager.default.fileExists(atPath: r.root + "/pwd.trip") || r.state("trip") == "failed" }
    if r.state("trip") != "failed" {
      let ran = r.lines(r.root + "/pwd.trip").first ?? ""
      #expect(ran == literal, "checked \(literal), ran in \(ran)")
    }
  }

  /// "One worker per folder" compares raw strings. The bridge doesn't normalise `cwd`.
  @Test(arguments: ["slash", "symlink", "case"])
  func FINDING_oneWorkerPerFolderSeesThroughAliases(kind: String) throws {
    let r = try WorkerRig(threads: ["aa", "bb"], scenario: reviewScenario)
    defer { r.teardown() }
    let proj = r.root + "/home/proj"
    try FileManager.default.createDirectory(atPath: proj, withIntermediateDirectories: true)
    let alias: String
    switch kind {
    case "slash": alias = proj + "/"
    case "symlink":
      alias = r.root + "/home/link"
      try FileManager.default.createSymbolicLink(atPath: alias, withDestinationPath: proj)
    default: alias = r.root + "/home/PROJ"
    }
    try r.writeConfig(maxLive: 3, threads: [("aa", proj), ("bb", alias)])
    r.manager()
    r.mgr.startTicking()
    try r.wake("aa")
    #expect(r.wait(8) { r.up("aa") })
    try r.wake("bb")
    #expect(r.wait(5) { r.state("bb") == "failed" || r.up("bb") })
    #expect(r.entry("bb")?.error?.code == "folder_claimed", "two workers in one folder (\(kind))")
  }

  /// tmux's argument parser treats an argument ending in `;` as a command separator, so one such env value makes every
  /// start fail with `unknown command`.
  @Test func FINDING_anEnvValueEndingInASemicolonDoesNotBreakEveryStart() throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["PROMPT_COMMAND": "history -a;"])
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(5) { r.up("trip") || r.state("trip") == "failed" })
    #expect(r.up("trip"), "\(String(describing: r.entry("trip")?.error))")
  }

  @Test func FINDING_aWorkerMdEndingInASemicolonDoesNotBreakTheStart() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    let d = r.agentDir + "/threads/trip"
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    try "You are the session for this thread;".write(toFile: d + "/WORKER.md", atomically: true, encoding: .utf8)
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(5) { r.up("trip") || r.state("trip") == "failed" })
    #expect(r.up("trip"), "\(String(describing: r.entry("trip")?.error))")
  }

  /// `mcpConfig` copies the talos-app entry whole, env included, into a file the worker reads.
  @Test func FINDING_theWorkerMcpConfigCarriesNoTelegramEnv() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    let proj = r.root + "/home/proj"
    try FileManager.default.createDirectory(atPath: proj, withIntermediateDirectories: true)
    try "{\"mcpServers\":{\"talos-app\":{\"command\":\"bun\",\"env\":{\"TALOS_APP_HOME\":\"/x\",\"TELEGRAM_BOT_TOKEN\":\"123:not-a-real-token\",\"TALOS_APP_BRIDGE\":\"1\"}}}}"
      .write(toFile: r.agentDir + "/.mcp.json", atomically: true, encoding: .utf8)
    try r.writeConfig(maxLive: 3, threads: [("trip", proj)])
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let raw = (try? String(contentsOfFile: r.talosHome + "/workers/trip/mcp.json", encoding: .utf8)) ?? ""
    #expect(raw.contains("talos-app"))
    #expect(!raw.contains("TELEGRAM_BOT_TOKEN"), "a token in the worker's mcp.json")
    #expect(!raw.contains("TALOS_APP_BRIDGE"))
  }

  /// `classify` reads the last 40 rows of history as well as the screen. A resumed conversation that mentions a dialog's
  /// words (a Talos thread about Talos will) is treated as that dialog: stopped, `needs_mac`.
  @Test func FINDING_aResumedConversationQuotingADialogIsNotADialog() throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["FAKE_RV_BANNER": "  earlier in this thread: the test says Not logged in, then Please run /login"])
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(5) { r.up("trip") || r.state("trip") == "failed" })
    #expect(r.up("trip"), "\(String(describing: r.entry("trip")?.error))")
  }

  /// Control: every launch path. Checks the live process (argv and environment read from the kernel) and sets a token in
  /// the tmux server's global environment first, so `env -i` is what's being tested.
  @Test func everyLaunchPathIsCleanInTheRunningProcess() throws {
    let r = try WorkerRig(scenario: reviewScenario, extraEnv: ["IMESSAGE_TOKEN": "x", "TELEGRAM_ANYTHING": "y"])
    defer { r.teardown() }
    r.manager()
    #expect(r.tmuxCmd(["new-session", "-d", "-s", "agent", "--", "/bin/sleep", "60"]).ok)
    #expect(r.tmuxCmd(["set-environment", "-g", "TELEGRAM_BOT_TOKEN", "from-the-server"]).ok)
    r.mgr.startTicking()
    func check(_ label: String) throws {
      #expect(r.wait(8) { r.up("trip") }, "\(label)")
      let pid = try #require(r.entry("trip")?.pane_pid)
      let snap = try #require(ProcessInspect.snapshot(pid))
      for a in snap.argv {
        #expect(!["--channels", "--dangerously-load-development-channels", "-p", "--print", "--bg"].contains(a), "\(label): \(a)")
        #expect(!a.hasPrefix("server:") && !a.hasPrefix("plugin:"), "\(label): \(a)")
      }
      let env = r.lines(r.envLog + ".trip")  // what the running worker really has, dumped by the worker itself
      #expect(env.contains("TALOS_APP_WORKER_THREAD=trip"), "\(label)")
      for line in env where line.hasPrefix("TELEGRAM_") || line.hasPrefix("IMESSAGE_") {
        #expect(line.hasPrefix("TELEGRAM_STATE_DIR=") || line.hasPrefix("IMESSAGE_STATE_DIR="), "\(label): \(line)")
      }
      #expect(!env.contains { $0.hasPrefix("TALOS_APP_BRIDGE=") || $0.hasPrefix("MCP_PROTOCOL_NEGOTIATION=") }, "\(label)")
      #expect(env.contains { $0.hasPrefix("TELEGRAM_STATE_DIR=") && $0.hasSuffix("/workers/_nochannel") }, "\(label)")
    }
    try r.wake("trip")
    try check("start")
    #expect(r.lines(r.log).last?.contains("--session-id") == true)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(15) {
      r.allEvents.contains {
        if case .parked(let thread, _) = $0 { return thread == "trip" }
        return false
      }
    })
    #expect(r.wait(5) { r.state("trip") == "parked" })  // the snapshot publishes at the end of the tick that emitted .parked
    try r.wake("trip")
    try check("resume")
    #expect(r.lines(r.log).last?.contains("--resume") == true)
    let sid = r.entry("trip")?.session_id
    try r.wakeFile("trip", action: "restart", reason: "control")
    #expect(r.wait(10) { r.lines(r.log).count == 3 })
    r.mgr.tickOnce()  // barrier: the fake logs its start before the tick that made it publishes; `check` reads the snapshot
    try check("restart")
    #expect(r.entry("trip")?.session_id == sid)
    try r.wakeFile("trip", action: "fresh", reason: "control")
    #expect(r.wait(10) { r.lines(r.log).count == 4 })
    r.mgr.tickOnce()  // barrier, as above
    try check("fresh")
    #expect(r.entry("trip")?.session_id != sid)
    #expect(r.entry("trip")?.previous_ids == [sid].compactMap { $0 })
  }

  /// Control: a tampered session id in workers.json can't reach argv.
  @Test func aTamperedSessionIdNeverReachesArgv() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    var e = WorkersFile.Entry(threadId: "trip", cwd: r.agentDir)
    e.state = "parked"
    e.session_id = "--channels"
    let f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-10-30T00:00:00.000Z", workers_supported: true, main_pane_pid: 0), threads: ["trip": e])
    try f.encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(5) { r.state("trip") == "failed" })
    #expect(r.lines(r.log).isEmpty)
  }
}

@Suite("Review OC3 panes and main", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3Panes {
  /// Pane ids restart at %0 with a new tmux server. `advance` never compares the pane's pid with the worker's group, so a
  /// worker whose server was replaced between two ticks is "live" on someone else's pane, and the pointer goes there.
  @Test func FINDING_aStalePaneIdNeverReachesSomeoneElsesPane() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    r.manager()
    r.firstTick()
    try r.wake("trip")
    #expect(r.wait(8) { r.mgr.tickOnce(); return r.up("trip") })
    #expect(r.wait(3) { r.mgr.tickOnce(); return r.typedLines.count == 1 })
    #expect(r.tmuxCmd(["kill-server"]).ok)
    usleep(300_000)
    // a new server on the same socket, and main comes back first: it gets %0
    let mainTyped = r.root + "/main-typed"
    let out = r.tmuxCmd(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "agent", "--", "/bin/sh", "-c", "cat >> \(mainTyped)"])
    #expect(out.out.trimmingCharacters(in: .whitespacesAndNewlines) == "%0")
    r.mgr.tickOnce()
    try r.wake("trip")
    r.mgr.tickOnce()
    r.mgr.tickOnce()
    usleep(300_000)
    #expect(r.lines(mainTyped).isEmpty, "the pointer was typed into main's pane")
  }

  /// `exited` treats one failed `display-message` as a dead pane and `release` then runs `kill-session` on a live worker.
  @Test func FINDING_oneFailedTmuxReadDoesNotKillALiveWorker() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    let flag = r.root + "/fail-once"
    let shim = try r.tmuxShim(flag: flag, log: r.root + "/sends")
    r.manager(tmux: shim)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let pid = try #require(r.entry("trip")?.pane_pid)
    FileManager.default.createFile(atPath: flag, contents: nil)
    usleep(1_000_000)
    #expect(!FileManager.default.fileExists(atPath: flag), "the shim fired")
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
    #expect(ProcessInspect.groupAlive(pid), "a live worker was killed over one failed read")
    #expect(r.lines(r.log).count == 1)
  }

  /// Spec 3.3: `send-keys -l "<pointer>"` then `Enter`. The build sends text and CR in one `send-keys -H`, which reaches
  /// the program as one 54-byte read (OBSERVED); `-l` then Enter is two reads. Whether Claude's input treats the one chunk
  /// as a paste, and so doesn't submit, needs SMOKE O3. Fake claude can't tell.
  @Test func FINDING_thePointerTextAndEnterAreSentSeparately() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    let sends = r.root + "/sends"
    let shim = try r.tmuxShim(flag: r.root + "/never", log: sends)
    r.manager(tmux: shim)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.typedLines.count == 1 })
    #expect(r.lines(sends).count == 2, "\(r.lines(sends).count) send-keys for one pointer")
  }

  /// Spec 4.4: "any worker pane whose argv contains --channels or server:talos-app is a bug, so stop that worker". adopt()
  /// only declines to own it: the file says `parked` and the pane keeps running with its channels.
  @Test func FINDING_aWorkerPaneWithChannelsIsStoppedOnAdopt() throws {
    let r = try WorkerRig(scenario: "hang.sh")
    defer { r.teardown() }
    r.manager()
    // the leftover words stay in bash's argv, which is all `argvLooksLikeMain` reads
    let res3 = r.tmuxCmd([
      "new-session", "-d", "-P", "-F", "#{pane_pid}", "-s", "t-trip", "--", "/bin/bash", "-c", "sleep 60; true", "claude",
      "--channels", "server:talos-app",
    ])
    let panePid = Int32(res3.out.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    #expect(panePid > 1)
    var e = WorkersFile.Entry(threadId: "trip", cwd: r.agentDir)
    e.state = "live"
    e.session_id = "11111111-2222-4333-8444-555555555555"
    e.pane_pid = panePid
    let f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-10-30T00:00:00.000Z", workers_supported: true, main_pane_pid: 0), threads: ["trip": e])
    try f.encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    r.mgr.tickOnce()
    r.mgr.tickOnce()
    usleep(300_000)
    #expect(!r.tmuxCmd(["has-session", "-t", "=t-trip"]).ok, "a pane with channels is still running: \(String(describing: r.state("trip")))")
  }

  /// Control: the 10 s typing guard against a real attached tmux client (`script` gives it a tty).
  @Test func aClientAttachedJustNowHoldsThePointerThenItIsTyped() throws {
    let r = try WorkerRig(scenario: reviewScenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.typedLines.count == 1 })
    let client = Process()
    client.executableURL = URL(fileURLWithPath: "/usr/bin/script")
    client.arguments = ["-q", "/dev/null", Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "attach-session", "-t", "=t-trip"]
    client.environment = ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin", "HOME": r.root + "/home"]
    let stdin = Pipe()
    client.standardInput = stdin
    client.standardOutput = FileHandle.nullDevice
    client.standardError = FileHandle.nullDevice
    try client.run()
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    #expect(r.wait(4) { !r.tmuxCmd(["list-clients", "-t", "=t-trip", "-F", "#{client_activity}"]).out.isEmpty }, "attached")
    try r.wake("trip")
    usleep(2_500_000)
    #expect(r.typedLines.count == 1, "typed within 10 s of the client's activity")
    #expect(r.wait(11) { r.typedLines.count == 2 }, "typed once the client went quiet")
  }

  /// Control: a worker dying hard touches neither main's pane nor another worker.
  @Test func aWorkerCrashTouchesNeitherMainNorAnotherWorker() throws {
    let r = try WorkerRig(threads: ["trip", "garden"], scenario: reviewScenario)
    defer { r.teardown() }
    r.manager()
    let main = r.tmuxCmd(["new-session", "-d", "-P", "-F", "#{pane_pid}", "-s", "agent", "--", "/bin/sleep", "60"])
    let mainPid = Int32(main.out.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    #expect(mainPid > 1)
    r.mgr.startTicking()
    try r.wake("trip")
    try r.wake("garden")
    #expect(r.wait(10) { r.up("trip") && r.up("garden") })
    let trip = try #require(r.entry("trip")?.pane_pid)
    let garden = try #require(r.entry("garden")?.pane_pid)
    let sid = r.entry("trip")?.session_id
    killpg(trip, SIGKILL)
    #expect(r.wait(15) {
      r.allEvents.contains {
        if case .parked(let thread, _) = $0 { return thread == "trip" }
        return false
      }
    })
    #expect(r.wait(5) { r.state("trip") == "parked" })  // the snapshot publishes at the end of the tick that emitted .parked
    #expect(r.entry("trip")?.session_id == sid)
    #expect(ProcessInspect.groupAlive(mainPid), "main's group")
    #expect(r.tmuxCmd(["has-session", "-t", "=agent"]).ok)
    #expect(ProcessInspect.groupAlive(garden))
    #expect(r.entry("garden")?.pane_pid == garden)
    #expect(r.up("garden"))
    #expect(!r.mgr.ownedGroups.contains(trip))
    #expect(!r.mgr.ownedGroups.contains(mainPid))
  }
}

import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Re-review of PR #68 at 0b5c05c: what the fix round missed or broke. Private tmux (`talos-test-…`) and the fake claude
/// only. Tests named FINDING fail until the finding is fixed; the others are controls.
private let scenario = "review-worker.sh"

extension WorkerRig {
  var faultDir: String { root + "/faults" }

  /// The real tmux, except that a verb with a file in `faults/` fails the way an overloaded server does: stderr, exit 1,
  /// no timeout. File content: `once` (one failure), `hold` (until removed), `slow` (once, after 0.4 s).
  func faultShim() throws -> String {
    try FileManager.default.createDirectory(atPath: faultDir, withIntermediateDirectories: true)
    let p = root + "/tmux-fault"
    try """
    #!/bin/bash
    d='\(faultDir)'
    for a in "$@"; do
      case "$a" in
        display-message|has-session|capture-pane|list-clients|Enter)
          if [ -f "$d/$a" ]; then
            m=$(cat "$d/$a")
            [ "$m" = hold ] || rm -f "$d/$a"
            [ "$m" = slow ] && sleep 0.4
            echo "error connecting to the socket (Resource temporarily unavailable)" >&2
            exit 1
          fi ;;
      esac
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: p, atomically: true, encoding: .utf8)
    chmod(p, 0o755)
    return p
  }

  func fault(_ verb: String, _ mode: String = "once") throws {
    try mode.write(toFile: faultDir + "/" + verb, atomically: true, encoding: .utf8)
  }

  func clearFault(_ verb: String) { unlink(faultDir + "/" + verb) }

  /// A live worker, then the app gone: tmux and the worker stay, `workers.json` stays.
  func liveWorkerThenAppGone(_ id: String = "trip", tmux: String? = nil) throws -> Int32 {
    manager(tmux: tmux)
    mgr.startTicking()
    try wake(id)
    #expect(wait(8) { up(id) })
    #expect(wait(3) { (fileOnDisk?.threads[id]?.pane_pid ?? 0) > 1 })
    let pid = fileOnDisk?.threads[id]?.pane_pid ?? 0
    mgr.detach()
    return pid
  }

  /// The app died between `new-session` and its first write: a live pane the file calls parked.
  func fileSaysParked(_ id: String = "trip") throws {
    var f = try #require(fileOnDisk)
    f.threads[id]?.state = "parked"
    f.threads[id]?.pane_pid = 0
    try f.encoded().write(to: URL(fileURLWithPath: talosHome + "/workers.json"))
  }

  func paneAlive(_ id: String = "trip") -> Bool {
    let out = tmuxCmd(["display-message", "-p", "-t", "=t-\(id):", "#{pane_dead}"])
    return out.ok && out.out.trimmingCharacters(in: .whitespacesAndNewlines) == "0"
  }
}

@Suite("Review OC3 R2 two copies", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3R2Copies {
  /// `stopAll` has no lock check and always calls `writeFile`. A passive copy has an empty table, so "Quit and stop" on it
  /// replaces the running copy's workers.json with no threads until the next heartbeat. Header line 14: "writes nothing".
  @Test func FINDING_aPassiveCopyQuittingWritesNothing() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.manager()
    let a = r.mgr!
    try r.wake("trip")
    #expect(r.wait(8) { a.tickOnce(); return r.up("trip") })
    a.tickOnce()
    usleep(600_000)
    a.tickOnce()
    let before = try #require(r.fileOnDisk)
    #expect((before.threads["trip"]?.pane_pid ?? 0) > 1)
    let b = r.manager(install: false)
    defer { b.detach() }
    b.tickOnce()
    #expect(!b.isActive, "the rig holds the lock")
    b.stopAll()
    #expect(r.fileOnDisk == before, "a passive copy wrote workers.json")
  }

  /// Control: when the running copy goes away, the passive one adopts the live worker without restarting it.
  @Test func aPassiveCopyTakesOverWithoutARestart() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.manager()
    let a = r.mgr!
    a.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    #expect(r.wait(3) { (r.fileOnDisk?.threads["trip"]?.pane_pid ?? 0) > 1 })
    let pid = try #require(r.fileOnDisk?.threads["trip"]?.pane_pid)
    let b = r.manager(install: false)
    defer { b.detach() }
    b.startTicking()
    usleep(500_000)
    #expect(!b.isActive)
    a.detach()
    #expect(r.wait(3) { b.isActive })
    #expect(r.wait(3) { ["live", "busy"].contains(b.snapshot().threads["trip"]?.state ?? "") })
    #expect(b.ownedGroups.contains(pid))
    #expect(r.lines(r.log).count == 1, "no restart")
  }
}

@Suite("Review OC3 R2 quit", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3R2Quit {
  /// `stopThenQuit` calls `stopAll`, then waits up to 15 s for main to stop, with the worker tick still running. A message in
  /// that window starts a worker that outlives the app: the exact thing the comment on the call says can't happen.
  @Test func FINDING_nothingStartsAfterQuitAndStop() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    r.mgr.stopAll()
    #expect(r.state("trip") == "parked")
    try r.wake("trip")
    usleep(1_500_000)
    #expect(r.state("trip") == "parked", "\(String(describing: r.state("trip"))) after Quit and stop")
    #expect(r.lines(r.log).count == 1, "\(r.lines(r.log).count) starts")
  }

  /// `stopNow` leaves `heldSince`: the slot it just freed lets `retryHeld` start the held thread during the quit.
  @Test func FINDING_aHeldWakeDoesNotStartAfterQuitAndStop() throws {
    let r = try WorkerRig(threads: ["aa", "bb"], maxLive: 1, scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "aa"])
    defer { r.teardown() }
    r.manager(busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("aa")
    #expect(r.wait(8) { r.state("aa") == "busy" })
    try r.wake("bb")
    usleep(600_000)
    r.mgr.stopAll()
    usleep(1_200_000)
    #expect(!r.up("bb") && r.state("bb") != "starting", "\(String(describing: r.state("bb"))) after Quit and stop")
  }
}

@Suite("Review OC3 R2 failed reads", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3R2FailedReads {
  /// `pane` calls a failed `has-session` "gone" unless it timed out, so a read failure with any other shape (the socket
  /// refusing under load, `Process.run` throwing at the file limit: status 127, every worker at once) is a crash, and the
  /// fix round made that path SIGKILL the group. The two reads fail together for the same reason.
  @Test func FINDING_aFailedHasSessionDoesNotKillALiveWorker() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.fault("has-session")
    try r.fault("display-message")
    usleep(1_000_000)
    #expect(ProcessInspect.groupAlive(pid), "two failed reads killed a live worker")
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
  }

  /// `isBusy` answers false when it can't read, so a turn in progress is a cap victim: SIGTERM mid-turn on a failed read.
  @Test func FINDING_aFailedBusyReadNeverMakesACapVictim() throws {
    let r = try WorkerRig(threads: ["aa", "bb"], maxLive: 1, scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "aa"])
    defer { r.teardown() }
    let sig = r.root + "/signals"
    r.env["FAKE_RV_SIGLOG"] = sig
    let shim = try r.faultShim()
    r.manager(tmux: shim, busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("aa")
    #expect(r.wait(8) { r.state("aa") == "busy" })
    try r.fault("display-message", "hold")
    try r.wake("bb")
    usleep(1_000_000)
    r.clearFault("display-message")
    #expect(r.lines(sig).isEmpty, "SIGTERM mid-turn: \(r.lines(sig))")
  }

  /// `adopt` reads a failed read as "gone": the live worker is marked parked and never owned, and `adopted` stays true, so
  /// it never gets another look. No idle park, outside the cap, off the takeover whitelist. Restart and Start fresh then hit
  /// "already running", so the app has no way back.
  @Test func FINDING_aFailedReadDuringAdoptKeepsTheWorker() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    let pid = try r.liveWorkerThenAppGone(tmux: shim)
    r.manager(tmux: shim)
    try r.fault("display-message")
    r.mgr.tickOnce()
    r.mgr.tickOnce()
    #expect(ProcessInspect.groupAlive(pid))
    #expect(r.up("trip"), "\(String(describing: r.state("trip"))) with the worker running")
    #expect(r.mgr.ownedGroups.contains(pid), "a running worker nobody owns")
    try r.wakeFile("trip", action: "restart", reason: "control")
    r.mgr.tickOnce()
    #expect(r.state("trip") != "failed", "\(String(describing: r.entry("trip")?.error))")
  }

  /// `start` calls a failed read straight after `new-session` "exited at once": failed, nobody owns it, and it runs on.
  @Test func FINDING_aFailedReadRightAfterStartLeavesNoUnownedWorker() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    try r.fault("display-message", "slow")
    try r.wake("trip")
    r.mgr.tickOnce()
    usleep(300_000)
    let unowned = r.state("trip") == "failed" && r.paneAlive()
    #expect(!unowned, "marked failed, still running, unowned: \(String(describing: r.entry("trip")?.error))")
  }

  /// `old == nil` means the read failed, not that the pane is dead (WorkerManager.swift:481), and the next line is
  /// kill-session. Reachable when the file doesn't know about a running worker (the app died before its first write).
  @Test func FINDING_aFailedReadNeverKillsASessionThatIsRunning() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    let pid = try r.liveWorkerThenAppGone(tmux: shim)
    try r.fileSaysParked()
    r.manager(tmux: shim)
    r.firstTick()
    try r.fault("display-message")
    try r.wake("trip")
    r.mgr.tickOnce()
    usleep(400_000)
    #expect(ProcessInspect.groupAlive(pid), "kill-session on a live worker over one failed read")
  }

  /// A failed `capture-pane` reads as an empty screen, an empty screen is `.none`, and `.none` may be typed at: the text and
  /// an Enter go into whatever dialog is up. A worker's Enter answers the highlighted option. The 10 s typing guard fails
  /// open the same way (`clientActivity`, by reading).
  @Test func FINDING_aFailedScreenReadNeverTypesThePointer() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let flag = r.root + "/dialog"
    r.env["FAKE_RV_DIALOG"] = flag
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.typedLines.count == 1 })
    FileManager.default.createFile(atPath: flag, contents: nil)
    usleep(700_000)
    try r.wake("trip")
    usleep(800_000)
    #expect(r.typedLines.count == 1, "control: held while the dialog is up")
    try r.fault("capture-pane", "hold")
    usleep(800_000)
    r.clearFault("capture-pane")
    #expect(r.typedLines.count == 1, "typed into a dialog after one failed read")
  }

  /// `sendEnter`'s result is dropped and `pendingPointer` cleared: the line sits unsubmitted in the input, the message waits
  /// for the hub's deadline, and the next pointer lands on the end of the same line.
  @Test func FINDING_aFailedEnterIsRetried() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    try r.fault("Enter")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(5) { r.typedLines.count == 1 }, "the pointer was never submitted")
  }
}

@Suite("Review OC3 R2 stopping", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3R2Stopping {
  /// Restart and Start fresh now queue in `afterPark` while the turn runs. `exited` never looks at it, so a worker that dies
  /// in `stopping` drops the owner's tap.
  @Test(arguments: ["restart", "fresh"])
  func FINDING_aControlQueuedOnAStoppingWorkerRunsIfItDies(action: String) throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    defer { r.teardown() }
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    r.manager(busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" })
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.wakeFile("trip", action: action, reason: "control")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    kill(pid, SIGKILL)
    #expect(r.wait(6) { r.up("trip") }, "\(action) was dropped: \(String(describing: r.state("trip")))")
    #expect(r.lines(r.log).count == 2, "\(r.lines(r.log).count) starts")
  }

  /// And the dropped tap stays armed: `start` doesn't clear `afterPark`, so the next ordinary park runs a stale `fresh`,
  /// moves the session id to previous_ids and starts a new conversation with nobody asking.
  @Test func FINDING_aFreshLeftOverFromACrashNeverDropsALaterSession() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    defer { r.teardown() }
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    r.manager(busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" })
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.wakeFile("trip", action: "fresh", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    kill(pid, SIGKILL)
    #expect(r.wait(6) { r.state("trip") == "parked" || r.up("trip") })
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let id = r.entry("trip")?.session_id
    let starts = r.lines(r.log).count
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(8) { r.state("trip") == "parked" }, "an ordinary park")
    usleep(500_000)
    #expect(r.entry("trip")?.session_id == id, "the session id changed on an ordinary park")
    #expect(r.lines(r.log).count == starts, "a worker started with nobody asking")
  }
}

@Suite("Review OC3 R2 cap", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3R2Cap {
  /// `enforceCap` counts `parking` workers toward the excess but can only pick from the rest. Claude takes more than one
  /// tick to exit, so each tick picks another idle worker until none is left: lowering 3 → 2 parks all three.
  @Test func FINDING_aLoweredCapParksOnlyTheExcess() throws {
    let r = try WorkerRig(threads: ["aa", "bb", "cc"], maxLive: 3, scenario: scenario, extraEnv: ["FAKE_RV_IGNORE_TERM": "1"])
    defer { r.teardown() }
    r.manager(parkGrace: 3)
    r.firstTick()
    // The ticks are driven here, one call each, so what is checked is a number of ticks and not a stretch of time.
    let all = ["aa", "bb", "cc"]
    func leaving() -> Int { r.mgr.snapshot().threads.values.filter { ["parking", "parked"].contains($0.state) }.count }
    for t in all { try r.wake(t) }
    #expect(r.wait(10) { r.mgr.tickOnce(); return all.allSatisfy(r.up) })
    #expect(r.wait(10) { r.mgr.tickOnce(); return all.allSatisfy { r.state($0) == "live" } }, "all three idle, so any may be picked")
    try r.writeConfig(maxLive: 2, threads: [("aa", nil), ("bb", nil), ("cc", nil)])
    #expect(r.wait(10) { r.mgr.tickOnce(); return leaving() >= 1 }, "the lowered cap took effect")
    // The worker that is leaving ignores SIGTERM, so it takes more than one tick to go. Each of these ticks used to pick
    // another idle worker, until none was left.
    for tick in 1...10 {
      r.mgr.tickOnce()
      let snapshot = r.mgr.snapshot().threads
      #expect(leaving() == 1, "\(leaving()) of 3 left at max_live 2, tick \(tick): \(snapshot.mapValues(\.state))")
    }
  }
}

@Suite("Review OC3 R2 relaunch", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3R2Relaunch {
  /// `lastSettings` starts as `.off`, so the "keep the last good settings" fix doesn't hold for the first read after a
  /// launch: an unreadable config parks every adopted worker.
  @Test func FINDING_anUnreadableConfigAtLaunchKeepsAdoptedWorkers() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    _ = try r.liveWorkerThenAppGone()
    try "{ half a file".write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    r.manager()
    for _ in 0..<3 {
      r.mgr.tickOnce()
      usleep(100_000)
    }
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
  }

  /// launch.sh is the whole login environment. The "already running" refusal returns without removing it.
  @Test func FINDING_aRefusedStartLeavesNoLaunchScript() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    _ = try r.liveWorkerThenAppGone()
    try r.fileSaysParked()
    r.manager()
    r.firstTick()
    try r.wake("trip")
    r.mgr.tickOnce()
    #expect(r.state("trip") == "failed")
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/launch.sh"), "the login env is still on disk")
  }
}

@Suite("Review OC3 R2 children", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewOC3R2Children {
  /// "A crash clears the group" is true, and Claude Code's tool processes aren't in the group: a Bash tool shell is its own
  /// group with no tty (OBSERVED: this reviewer's shell, pgid = its own pid, tty `??`, parent claude in another group). So a
  /// tool still running when a worker crashes keeps going, and the next message resumes a new turn beside it.
  @Test func FINDING_aToolProcessThatLeftTheGroupDoesNotOutliveACrash() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let file = r.root + "/tool"
    r.env["FAKE_RV_SETSID_CHILD"] = file
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    defer { r.killLeftovers(file + ".trip") }
    let pid = try #require(r.entry("trip")?.pane_pid)
    let tool = try #require(r.lines(file + ".trip").first.flatMap { Int32($0) })
    usleep(300_000)
    #expect(kill(tool, 0) == 0, "control: the tool is running")
    #expect(getpgid(tool) != pid, "control: it left the group")
    kill(pid, SIGKILL)
    #expect(r.wait(6) { r.state("trip") == "parked" })
    usleep(500_000)
    // Known issue, not fixed: R15 is an owner call (a tool that left the group needs a new way to find it and a new kind of
    // kill), see the PR. The assertion stands: this goes red the day the behaviour changes, so it gets a real decision.
    withKnownIssue("R15: owner call") {
      #expect(kill(tool, 0) != 0, "the crashed worker's tool is still running")
    }
  }
}

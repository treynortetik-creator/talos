import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Option C smoke O14a: when the session's process is killed (SIGKILL), what it left in its group goes with it. Every signal the
/// supervisor sends goes to the group (`killpg`), through `GroupSignaller`, which refuses pgid 0 and 1, its own group, a group it
/// does not own and a recycled leader. A fake child leaves a grandchild that ignores SIGTERM, so only a group SIGKILL ends it.
@Suite("Process group kill", .serialized)
struct ProcessGroupKillTests {
  /// perl: its own group (setpgrp), a grandchild in that group that ignores SIGTERM, the grandchild's pid on stdout.
  private func leaderWithGrandchild() throws -> (leader: Process, grandchild: Int32) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
    p.arguments = [
      "-e",
      "setpgrp(0,0); my $c = fork(); if (!$c) { $SIG{TERM} = 'IGNORE'; exec '/bin/sleep', '120' } print \"$c\\n\"; $| = 1; sleep 120",
    ]
    let out = Pipe()
    p.standardOutput = out
    p.standardInput = FileHandle.nullDevice
    try p.run()
    var line = Data()
    let until = Date().addingTimeInterval(5)
    while Date() < until, !line.contains(10) {
      let chunk = out.fileHandleForReading.availableData
      if chunk.isEmpty { usleep(50_000) } else { line.append(chunk) }
    }
    let pid = Int32(String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    return (p, pid)
  }

  @Test func aSigkillOfTheGroupTakesTheGrandchildEvenAfterTheLeaderIsGone() throws {
    let (p, gc) = try leaderWithGrandchild()
    let leader = p.processIdentifier
    defer {
      kill(leader, SIGKILL)
      if gc > 1 { kill(gc, SIGKILL) }
      p.terminate()
    }
    #expect(gc > 1)
    #expect(ProcessInspect.basic(gc)?.pgid == leader, "control: the grandchild is in the leader's group")
    let s = GroupSignaller(probe: LiveSystem(loginEnv: { [:] }))
    s.own(leader, leaderStart: try #require(ProcessInspect.basic(leader)).startTime)
    // SIGKILL of the leader alone (an external `kill -9`, or the CLI crashing): the grandchild is left behind
    kill(leader, SIGKILL)
    #expect(Rig.waitUntil(3) { !p.isRunning })
    usleep(300_000)
    #expect(ProcessInspect.alive(gc), "control: a pid kill leaves it running")
    #expect(s.alive(leader), "and the group is not empty")
    // the group kill takes it
    #expect(s.signal(leader, SIGKILL))
    #expect(Rig.waitUntil(3) { !ProcessInspect.alive(gc) }, "the grandchild is gone with the group")
    #expect(!s.alive(leader))
  }

  /// The guards: never pgid 0 or 1 (every process / init's), never our own group or pid, never a group nobody told it to own.
  @Test func theGroupSignalRefusesTheGroupsItMustNeverTouch() {
    let s = GroupSignaller(probe: LiveSystem(loginEnv: { [:] }))
    for g: Int32 in [-1, 0, 1, getpgrp(), getpid()] {
      s.own(g, leaderStart: 0)
      #expect(!s.signal(g, 0), "refused: \(g)")
    }
    #expect(s.log.isEmpty, "nothing was signalled")
    #expect(!s.signal(99_999_999, 0), "a group it does not own")
  }

  @Test(.enabled(if: Rig.hasTmux)) func aSigkilledWorkerLeavesNothingBehindInItsGroup() throws {
    let pidFile = NSTemporaryDirectory() + "gc-\(UUID().uuidString.prefix(8))"
    let r = try WorkerRig(scenario: "worker-grandchild.sh", extraEnv: ["FAKE_GRANDCHILD_PID_FILE": pidFile])
    var gc: Int32 = 0
    defer {
      if gc > 1, ProcessInspect.snapshot(gc)?.commandLine.contains("sleep") == true { kill(gc, SIGKILL) }
      unlink(pidFile)
      r.teardown()
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    gc = Int32((try? String(contentsOfFile: pidFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
    let pane = try #require(r.entry("trip")?.pane_pid)
    #expect(gc > 1 && ProcessInspect.basic(gc)?.pgid == pane, "control: the grandchild is in the pane's group")
    kill(pane, SIGKILL)  // an external kill -9 of the worker's process
    #expect(r.wait(15) { !ProcessInspect.alive(gc) }, "the grandchild outlived its worker: \(r.why("trip"))")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
  }

  @Test(.enabled(if: Rig.hasTmux)) func aSigkilledMainLeavesNothingBehindInItsGroup() throws {
    let pidFile = NSTemporaryDirectory() + "gc-\(UUID().uuidString.prefix(8))"
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 600
    t.stopGrace = 3
    t.cleanupWait = 2
    let r = try Rig(.tmux, scenario: "grandchild.sh", env: ["FAKE_GRANDCHILD_PID_FILE": pidFile], timings: t) { $0.autoRestart = false }
    var gc: Int32 = 0
    defer {
      if gc > 1, ProcessInspect.snapshot(gc)?.commandLine.contains("sleep") == true { kill(gc, SIGKILL) }
      unlink(pidFile)
      r.teardown()
    }
    try coldStartConfirmed(r)
    gc = Int32((try? String(contentsOfFile: pidFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
    let pane = try #require(r.sup.status.childPid)
    #expect(gc > 1 && ProcessInspect.basic(gc)?.pgid == pane, "control: the grandchild is in the pane's group")
    kill(pane, SIGKILL)
    #expect(r.wait(15) { r.sup.tickNow(); return !ProcessInspect.alive(gc) }, "the grandchild outlived Main: \(r.audit)")
  }
}

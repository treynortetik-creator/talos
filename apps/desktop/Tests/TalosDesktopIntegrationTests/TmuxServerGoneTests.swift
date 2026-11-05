import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A tmux server whose last session was just killed is on its way out, and a command that reaches it in that moment
/// fails with "server exited unexpectedly" without running. Plain tmux does this about once in 600 kill-then-create
/// pairs on a loaded Mac. Starting a worker (Start fresh right after a crash) or the main session must not turn that
/// into a failed start. The shim makes the moment happen on purpose; everything else is the real tmux.
private func newSessionShim(in root: String, failTimes: Int, message: String) throws -> (path: String, calls: String) {
  let path = root + "/tmux-newsession-shim"
  let calls = root + "/new-session-calls"
  try """
  #!/bin/bash
  for a in "$@"; do
    if [ "$a" = new-session ]; then
      echo x >> '\(calls)'
      n=$(wc -l < '\(calls)' | tr -d ' ')
      if [ "$n" -le \(failTimes) ]; then echo '\(message)' >&2; exit 1; fi
    fi
  done
  exec '\(Rig.tmuxPath!)' "$@"
  """.write(toFile: path, atomically: true, encoding: .utf8)
  chmod(path, 0o755)
  return (path, calls)
}

private func callCount(_ path: String) -> Int {
  ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "").split(separator: "\n").count
}

@Suite("tmux server on its way out", .serialized, .enabled(if: Rig.hasTmux))
struct TmuxServerGoneTests {
  @Test func aWorkerStartThatMeetsAShuttingDownServerIsAskedAgain() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let shim = try newSessionShim(in: r.root, failTimes: 1, message: "server exited unexpectedly")
    r.manager(tmux: shim.path)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" }, "state \(String(describing: r.state("trip"))) \(String(describing: r.entry("trip")?.error))")
    #expect(callCount(shim.calls) == 2, "one refused, one that ran")
  }

  @Test func anyOtherTmuxFailureIsNotRetried() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let shim = try newSessionShim(in: r.root, failTimes: 1, message: "create window failed: no space for new pane")
    r.manager(tmux: shim.path)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" })
    #expect(r.entry("trip")?.error?.code == "start_failed")
    #expect(callCount(shim.calls) == 1, "a different error is shown to the owner, not hidden by a second try")
  }

  @Test func aServerThatKeepsGoingAwayStopsAfterAFewTriesAndSaysSo() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let shim = try newSessionShim(in: r.root, failTimes: 1000, message: "server exited unexpectedly")
    r.manager(tmux: shim.path)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" })
    #expect(r.entry("trip")?.error?.code == "start_failed")
    #expect(r.entry("trip")?.error?.detail?.contains("server exited unexpectedly") == true, "\(String(describing: r.entry("trip")?.error))")
    #expect(callCount(shim.calls) == 4, "the first try and three more")
  }

  @Test func theMainSessionStartThatKeepsMeetingAServerGoingAwayStopsAfterAFewTriesAndSaysSo() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let shim = try newSessionShim(in: r.root, failTimes: 1000, message: "server exited unexpectedly")
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { stopReason(r.phase()) != nil }, "phase \(r.phase()), audit: \(r.audit)")
    guard case .startFailed(let why)? = stopReason(r.phase()) else {
      Issue.record("stopped for \(String(describing: stopReason(r.phase())))")
      return
    }
    #expect(why.contains("server exited unexpectedly"), "\(why)")
    #expect(callCount(shim.calls) == 4, "the first try and three more, then the owner is told")
    #expect(r.starts.isEmpty, "no agent was started")
  }

  @Test func theMainSessionStartThatMeetsAShuttingDownServerIsAskedAgain() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let shim = try newSessionShim(in: r.root, failTimes: 1, message: "server exited unexpectedly")
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) }, "\(r.phase()) \(r.audit)")
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart })
    #expect(callCount(shim.calls) == 2)
    #expect(r.starts.count == 1, "one agent, not two")
  }
}

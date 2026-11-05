import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@Suite("Mac audit package F: supervisor")
struct MacAuditPackageFTests {
  @Test func stopReasonsReadAsOnePlainSentence() {
    let all: [Supervisor.StopReason] = [
      .user, .crashLoop, .resumeMissing("abc"), .noNotice, .crashedNoAutoRestart,
      .startFailed("start failed: claude was not found (claude_path auto)"),
    ]
    for r in all {
      let s = r.plainSentence
      #expect(!s.contains("startFailed("), "\(s)")
      #expect(!s.contains("resumeMissing("), "\(s)")
      #expect(s.hasSuffix(".") || s.hasSuffix("…"), "\(s)")
      #expect(!s.contains("\n"), "\(s)")
    }
    #expect(Supervisor.StopReason.startFailed("start failed: no tmux").plainSentence == "The agent couldn't start: no tmux.")
    #expect(Supervisor.StopReason.startFailed("").plainSentence == "The agent couldn't start.")
    #expect(!Supervisor.StopReason.user.isFailure)
    #expect(Supervisor.StopReason.crashLoop.isFailure)
  }

  @Test func aFailedStartNoticeDoesNotSayItTwice() {
    let r = Supervisor.StopReason.startFailed("start failed: claude was not found (claude_path auto)")
    #expect(r.startDetail == "claude was not found (claude_path auto)")
    #expect(Supervisor.StopReason.user.startDetail == "")
  }

  @Test func onlyAMissingConversationCannotBeRetried() {
    #expect(Supervisor.StopReason.resumeMissing("abc").retryCannotWork)
    #expect(!Supervisor.StopReason.crashLoop.retryCannotWork)
    #expect(!Supervisor.StopReason.startFailed("x").retryCannotWork)
  }
}

/// D10: the folder and claude path are read at each tick, not captured when Talos opened.
@Suite("Mac audit package F: workers read the setup at each start", .serialized, .enabled(if: Rig.hasTmux))
struct MacAuditWorkerSourceTests {
  @Test func aClaudePathSetAfterLaunchIsUsedByTheNextStart() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    // Talos opened before setup: the manager was built with a claude that does not exist.
    var o = r.mgr.options
    o.claudePath = "/nonexistent/claude"
    let late = WorkerManager(options: o, probe: LiveSystem(loginEnv: { r.env }), baseEnv: { r.env })
    r.mgr.detach()
    // Setup finishes: the source now names the real one.
    let real = Rig.fixtures + "/claude"
    late.launchSource = { .init(agentDir: r.agentDir, claudePath: real, permissionFlag: "--dangerously-skip-permissions") }
    defer { late.detach() }
    late.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { late.snapshot().threads["trip"]?.state == "live" || late.snapshot().threads["trip"]?.state == "busy" })
    #expect(late.options.claudePath == real)
  }
}

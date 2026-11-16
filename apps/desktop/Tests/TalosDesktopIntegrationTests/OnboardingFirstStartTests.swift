import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Main's first start on the setup screen: the warning is answered in the Talos popup, and "done" waits for the bridge being live.
/// A start whose bridge never comes up shows the reason from Claude Code's MCP log. (The supervisor's own bridge check is in
/// MainBridgeHealthTests; these pin what the setup screen reads from it.)
@Suite("Onboarding: Main's first start waits for the bridge", .serialized)
struct OnboardingFirstStartTests {
  private func status(_ phase: Supervisor.Phase, needsYou: Supervisor.NeedsYou? = nil, live: Bool = false) -> FirstStartCheck.State {
    FirstStartCheck.state(phase: phase, needsYou: needsYou, bridgeLive: live)
  }

  @Test func eachStatusReadsAsOneSentenceAndOnlyALiveBridgeIsDone() {
    #expect(status(.idle) == .notStarted)
    #expect(status(.starting, needsYou: .confirmColdStart) == .warning)
    #expect(status(.starting) == .waitingForBridge)
    #expect(status(.running) == .waitingForBridge, "running is not done: the bridge decides")
    #expect(status(.running, live: true) == .done)
    #expect(status(.stopped(.user)) == .stopped)
    #expect(status(.running, needsYou: .startStalled) == .failed(OnboardingText.firstStartStalled))
    #expect(status(.running, needsYou: .bridgeNotLive("Executable not found in $PATH: \"bun\"")) == .failed(SupervisorNotice.bridgeNotLive("Executable not found in $PATH: \"bun\"")))
    #expect(!status(.starting).isDone)
  }

  @Test func dialogsThatOpenTerminalSayLookAtTheTerminalNotThePopup() {
    for what in ["a trust question", "a connector consent", "a sign-in"] {
      let s = status(.running, needsYou: .dialog(what))
      #expect(s == .terminalDialog)
      #expect(s.message == OnboardingText.firstStartTerminal && !s.message.contains("popup"))
    }
    #expect(status(.starting, needsYou: .confirmColdStart) == .warning && OnboardingText.firstStartWarning.contains("popup"))
    #expect(status(.blocked([])) == .blocked)
    #expect(status(.blocked([])).message != OnboardingText.firstStartIdle, "blocked is not 'not started'")
  }

  @Test func theWarningIsAnsweredThenDoneOnlyWhenTheBridgeIsLive() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    #expect(!FirstStartCheck.state(r.sup.status).isDone, "starting is not done")
    r.answeredAndSettled()
    #expect(FirstStartCheck.state(r.sup.status) == .waitingForBridge, "the warning is answered, the bridge is not up: not done yet")
    try r.writeBridgeStatus()
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.sup.status.bridgeLive)
    #expect(FirstStartCheck.state(r.sup.status) == .done, "\(r.sup.status)")
  }

  @Test func aBridgeThatNeverGoesLiveShowsTheMcpLogReason() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    try r.writeMcpLog(["{\"error\":\"Executable not found in $PATH: \\\"bun\\\"\"}"])
    r.clock.advance(70)
    for _ in 0..<3 { r.sup.tickNow() }
    let s = FirstStartCheck.state(r.sup.status)
    #expect(s == .failed(SupervisorNotice.bridgeNotLive("Executable not found in $PATH: \"bun\"")), "\(s)")
    #expect(s.message.contains("bun"), "the reason is on the screen")
    #expect(!s.isDone)
  }

  @Test func aBridgeThatNeverGoesLiveWithNoLogStillFailsPlainly() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    r.clock.advance(70)
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(FirstStartCheck.state(r.sup.status) == .failed(SupervisorNotice.bridgeNotLive(nil)))
  }
}

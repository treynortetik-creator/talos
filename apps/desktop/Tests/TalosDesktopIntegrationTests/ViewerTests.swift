import Foundation
import SwiftTerm
import Testing
import TalosDesktopCore
@testable import TalosSupervisor

/// WP-D2 acceptance, without a window: the pane is a pty running `tmux attach` on the agent's session. Same argv the app
/// uses (`TmuxCommands.attach()`), on the Rig's private socket.
private final class ViewerDelegate: LocalProcessDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var _exit: Int32??
  var exited: Bool { lock.withLock { _exit != nil } }
  var output = Data()
  func processTerminated(_ source: LocalProcess, exitCode: Int32?) { lock.withLock { _exit = .some(exitCode) } }
  func dataReceived(slice: ArraySlice<UInt8>) { lock.withLock { output.append(contentsOf: slice) } }
  func getWindowSize() -> winsize { winsize(ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0) }
}

private func startViewer(_ r: Rig, _ d: ViewerDelegate) -> LocalProcess {
  let cmds = TmuxCommands(tmux: Rig.tmuxPath!, socket: r.socket, configPath: Rig.tmuxConf)
  let argv = cmds.attach()
  var env = r.loginEnv
  env.removeValue(forKey: "TMUX")
  env["TERM"] = "xterm-256color"
  let p = LocalProcess(delegate: d, dispatchQueue: DispatchQueue(label: "viewer"))
  p.startProcess(
    executable: argv[0], args: Array(argv.dropFirst()), environment: env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" })
  return p
}

@Suite("Terminal viewer (real tmux, private socket)", .serialized, .enabled(if: Rig.hasTmux))
struct ViewerTests {
  @Test func enterTypedThroughTheViewerIsTheHumanConfirmation() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    r.start()
    // Every bound here only caps a hang: a real tmux costs a subprocess per read, and each poll below asks for a pass now.
    #expect(r.wait(30) { r.screenContains(DialogMatcher.Strings.devTitle) })
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart })
    let d = ViewerDelegate()
    let viewer = startViewer(r, d)
    #expect(r.wait(15) { viewer.running })
    usleep(800_000)
    #expect(r.config.session.confirmedAt == nil, "attaching presses nothing")
    #expect(viewer.typeDirectly([0x0d][...]))
    // Generous bounds: they only cap a hang. The whole suite runs beside Option C's suites, which load the machine.
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "running after Enter through the viewer: \(r.phase())")
    #expect(r.wait(15) { r.config.session.confirmedAt != nil })
    #expect(r.wait(15) { r.audit.contains("human_confirm") })
    viewer.terminate()
  }

  @Test func closingTheViewerDetachesAndTheAgentKeepsRunning() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let pid = try #require(r.sup.status.childPid)
    let d = ViewerDelegate()
    let viewer = startViewer(r, d)
    #expect(r.wait(5) { viewer.running })
    usleep(500_000)
    viewer.terminate()  // what closing the window does: our own `tmux attach` child
    #expect(r.wait(5) { d.exited })
    usleep(600_000)
    #expect(isRunning(r.phase()))
    #expect(kill(pid, 0) == 0, "the agent's pane process is still alive")
    #expect(r.host.attachIfRunning())
    // and a new viewer attaches to the same pane
    let d2 = ViewerDelegate()
    let again = startViewer(r, d2)
    #expect(r.wait(5) { again.running })
    usleep(500_000)
    #expect(!d2.exited)
    #expect(r.sup.status.childPid == pid)
    again.terminate()
  }

  @Test func theViewerProcessKilledExternallyLeavesTheAgentAlone() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let pid = try #require(r.sup.status.childPid)
    let d = ViewerDelegate()
    let viewer = startViewer(r, d)
    #expect(r.wait(5) { viewer.running })
    usleep(500_000)
    let vpid = viewer.shellPid
    #expect(vpid > 0 && vpid != pid)
    kill(vpid, SIGKILL)  // our own viewer child only, by pid
    #expect(r.wait(5) { d.exited })
    usleep(500_000)
    #expect(kill(pid, 0) == 0)
    #expect(isRunning(r.phase()))
  }

  @Test func viewingASessionThatDoesNotExistFailsFastAndTouchesNothing() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let d = ViewerDelegate()
    let viewer = startViewer(r, d)
    #expect(r.wait(5) { d.exited })
    _ = viewer
    #expect(r.phase() == .idle)
  }
}

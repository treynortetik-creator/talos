import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop
import TalosTestSupport

// What `SupervisorController.init` runs to build the worker manager, with a login shell that takes seconds to answer (review R1-7).
// Runs only with TALOS_GUI_TESTS=1. No window, no tmux call: the manager is built and never ticks.

@MainActor
@Suite("Mac: building the worker manager never reads the login shell on the main thread", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct WorkerLoginEnvGuiTests {
  @Test func aSlowLoginShellDoesNotHoldInitAndTheWorkersEnvHasDesktopJsonOnTop() throws {
    #expect(Thread.isMainThread)
    let root = (TestTemp.base as NSString).appendingPathComponent("talos-wlg-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: root) }
    let pinned = "/home/alex/.local/bin:/usr/bin:/bin"
    var cfg = DesktopConfig.defaults
    cfg.host = .tmux
    cfg.claudePath = "auto"
    cfg.env = ["PATH": pinned, "TALOS_APP_HOME": root + "/talos-home", "PINNED": "yes"]
    let done = DispatchSemaphore(value: 0)
    let slow = LiveSystem(loginEnv: {
      Thread.sleep(forTimeInterval: 2)
      done.signal()
      return ["PATH": "/home/alex/login/bin", "FROM_LOGIN": "1"]
    })
    let t0 = Date()
    let fixed = cfg
    let made = SupervisorController.makeWorkers(
      cfg: fixed, env: ["PATH": "/usr/bin:/bin", "HOME": root], probe: slow, mainPid: { 0 }, current: { fixed },
      tmux: "/usr/bin/false", conf: "/dev/null", auditPath: root + "/supervisor.log")
    let m = try #require(made)
    let env = m.loginEnvironment()  // what the Terminals window reads on the main thread
    let took = Date().timeIntervalSince(t0)
    #expect(took < 1, "building the worker manager held the main thread for \(took) s")
    #expect(env["PATH"] == pinned && env["PINNED"] == "yes", "desktop.json env is on top from the first moment: \(env)")
    #expect(m.options.talosHome == root + "/talos-home")
    #expect(m.options.managedDir == MainManagedSettings.systemDir, "the app's manager reads Claude Code's managed settings for the ceiling")
    #expect(done.wait(timeout: .now() + 10) == .success, "the login shell is read, in the background")
    var late: [String: String] = [:]
    for _ in 0..<100 where late["FROM_LOGIN"] == nil {
      usleep(20_000)
      late = m.loginEnvironment()
    }
    #expect(late["FROM_LOGIN"] == "1" && late["PATH"] == pinned, "its answer arrives later, under desktop.json: \(late)")
    m.detach()
  }
}

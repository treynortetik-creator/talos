import AppKit
import Foundation
import Testing
import TalosDesktopCore
@testable import TalosDesktop

/// Audit D46: a relay that is down at launch. A real WKWebView loads a loopback port nothing listens on, so WebKit itself
/// reports the failure. Needs TALOS_GUI_TESTS=1.
extension GuiSerial {
@MainActor
@Suite("Mac audit F: unreachable window", .serialized, .enabled(if: guiTestsEnabled))
struct MacAuditPackageFGuiTests {
  func deadPort() -> UInt16 {
    // bind then close: nothing listens here afterwards
    let s = socket(AF_INET, SOCK_STREAM, 0)
    var a = sockaddr_in()
    a.sin_family = sa_family_t(AF_INET)
    a.sin_addr.s_addr = inet_addr("127.0.0.1")
    a.sin_port = 0
    _ = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    var got = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &got) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) } }
    close(s)
    return UInt16(bigEndian: got.sin_port)
  }

  @Test func aDeadRelayShowsTheOverlayAndIsNotSignedOut() async throws {
    _ = NSApplication.shared
    let c = WebController()
    c.configure(relay: RelayOrigin("http://127.0.0.1:\(deadPort())")!)
    c.prepare()
    var failed = false
    for _ in 0..<60 where !failed {
      try? await Task.sleep(nanoseconds: 100_000_000)
      failed = c.loadFailed
    }
    #expect(failed, "WebKit never reported the failed load")
    #expect(c.pageState == .unreachable)
    #expect(!c.pageState.offersSignIn, "a dead relay is not a signed-out owner")
    #expect(c.failureOverlayShownForTest, "a grey blank window")
    #expect(c.failureOverlayTextForTest.contains(PageState.outageHelp.joined(separator: "\n\n")), "Help cannot load now, so the fixes are on the screen")
    c.setLoadFailedForTest(false)
    #expect(!c.failureOverlayShownForTest)
  }

  @Test func theComposePanelSaysItCantReachTalosInsteadOfSignInFirst() async throws {
    _ = NSApplication.shared
    let web = WebController.shared
    let qc = QuickCompose.shared
    web.setLoadFailedForTest(true)
    defer { web.setLoadFailedForTest(false) }
    qc.prepareShow(thread: nil)
    #expect(qc.signInMessageForTest == PageState.unreachableLine)
  }

  // MARK: D13

  final class Spy: @unchecked Sendable {
    var opened: [URL] = []
    var problems: [String] = []
    var saved: [URL] = []
  }

  func controller(_ relay: FakeRelay, saveTo dest: URL?, _ spy: Spy) -> WebController {
    cannotTakeTheKeyboard()
    let c = WebController()
    c.openExternal = { spy.opened.append($0) }
    c.downloadProblem = { spy.problems.append($0) }
    c.downloadSaved = { spy.saved.append($0) }
    c.chooseDestination = { _, done in done(dest) }
    c.configure(relay: relay.relay)
    c.prepare()
    return c
  }

  @Test func anAttachmentIsSavedInsideTheAppNotHandedToTheBrowser() async throws {
    let relay = try FakeRelay { r in
      switch r.path {
      case "/media/m_01FILE":
        return .init(headers: ["Content-Type": "application/zip", "Content-Disposition": "attachment; filename=\"pack.zip\""], body: "ZIPBYTES")
      default: return .init(body: "<html>app</html>")
      }
    }
    defer { relay.stop() }
    let spy = Spy()
    let dest = URL(fileURLWithPath: NSTemporaryDirectory() + "/talos-dl-\(UUID().uuidString.prefix(8)).zip")
    defer { try? FileManager.default.removeItem(at: dest) }
    let c = controller(relay, saveTo: dest, spy)
    #expect(await pumpUntil(3) { relay.saw("/") })
    c.routeExternal(URL(string: relay.origin + "/media/m_01FILE")!)
    #expect(await pumpUntil(8) { !spy.saved.isEmpty }, "never saved; problems \(spy.problems)")
    #expect((try? String(contentsOf: dest, encoding: .utf8)) == "ZIPBYTES")
    #expect(spy.opened.isEmpty, "the browser got a link that answers 401: \(spy.opened)")
  }

  @Test func aRefusedAttachmentIsSaidAndNothingIsWritten() async throws {
    let relay = try FakeRelay { r in
      r.path == "/media/m_01GONE" ? .init(status: 401, body: "{\"error\":\"unauthorized\"}") : .init(body: "<html>app</html>")
    }
    defer { relay.stop() }
    let spy = Spy()
    let dest = URL(fileURLWithPath: NSTemporaryDirectory() + "/talos-dl-\(UUID().uuidString.prefix(8)).json")
    defer { try? FileManager.default.removeItem(at: dest) }
    let c = controller(relay, saveTo: dest, spy)
    #expect(await pumpUntil(3) { relay.saw("/") })
    c.routeExternal(URL(string: relay.origin + "/media/m_01GONE")!)
    #expect(await pumpUntil(8) { !spy.problems.isEmpty }, "a 401 passed in silence")
    #expect(spy.problems.first?.contains("Sign in") == true)
    #expect(!FileManager.default.fileExists(atPath: dest.path), "the error page was saved as the file")
  }

  @Test func anAgentPageStillGoesToTheBrowser() async throws {
    let relay = try FakeRelay { _ in .init(body: "<html>app</html>") }
    defer { relay.stop() }
    let spy = Spy()
    let c = controller(relay, saveTo: nil, spy)
    #expect(await pumpUntil(3) { relay.saw("/") })
    c.routeExternal(URL(string: relay.origin + "/media/m_01PAGE/page")!)
    await pump(0.5)
    #expect(spy.opened.map(\.path) == ["/media/m_01PAGE/page"])
    #expect(!relay.saw("/media/m_01PAGE/page"), "the app fetched an agent page")
  }

  // MARK: D45, D10, D44

  @Test func importingACommandKeepsTheBridgeVariablesAndStartsTheWorkers() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    defer { try? FileManager.default.removeItem(atPath: SupervisorController.configPath) }  // the world is shared
    try FileManager.default.createDirectory(atPath: NSHomeDirectory() + "/.config/talos/app", withIntermediateDirectories: true)
    let mgr = try #require(w.model.workers, "no worker manager (tmux)")
    #expect(!mgr.isActive, "control: nothing ticks before setup")
    let err = w.model.importCommand("cd ~ && claude --dangerously-skip-permissions")
    #expect(err == nil, "\(err ?? "")")
    let env = w.model.supervisor.currentConfig().env
    #expect(env["TALOS_APP_BRIDGE"] == "1", "\(env)")
    #expect(env["MCP_PROTOCOL_NEGOTIATION"] == "legacy", "\(env)")
    #expect(await w.until(5) { mgr.isActive }, "own-session threads wait for a relaunch")
  }

  @Test func theNotSetUpLineIsWhatTheMenuShows() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    #expect(w.model.statusLine == SupervisorNotice.notSetUp)
  }

  @Test func aFailedStopReadsAsOneSentenceWithTheNextAction() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    w.model.configured = true
    w.model.status.phase = .stopped(.startFailed("start failed: claude was not found (claude_path auto)"))
    #expect(w.model.statusLine == "Session stopped. The agent couldn't start: claude was not found (claude_path auto).")
    #expect(w.model.failedStop, "Try again and Start a new conversation are offered")
    w.model.status.phase = .stopped(.user)
    #expect(!w.model.failedStop)
    #expect(w.model.statusLine == "Session: stopped")
  }

  // MARK: review round

  @Test func aRelayThatAnswers503IsUnreachableNotConnectingForever() async throws {
    let relay = try FakeRelay { _ in .init(status: 503, body: "<html>Application failed to respond</html>") }
    defer { relay.stop() }
    cannotTakeTheKeyboard()
    let c = WebController()
    c.configure(relay: relay.relay)
    c.prepare()
    #expect(await pumpUntil(8) { c.loadFailed }, "the error page committed as a normal load and nothing reported it")
    #expect(c.pageState == .unreachable)
    #expect(c.failureOverlayShownForTest)
  }

  @Test func aRelayAddressSetAfterLaunchStartsLoadingAtOnce() async throws {
    let relay = try FakeRelay { _ in .init(body: "<html>app</html>") }
    defer { relay.stop() }
    cannotTakeTheKeyboard()
    let c = WebController()
    c.prepare()  // launch with no relay: nothing to build
    c.configure(relay: relay.relay)  // Settings > Window
    #expect(await pumpUntil(5) { relay.saw("/") }, "the page never started loading; the menu would say Connecting forever")
  }

  @Test func savingOverAFileKeepsTheOldOneWhenTheDownloadBreaks() async throws {
    let relay = try FakeRelay { r in
      r.path == "/media/m_01CUT"
        ? .init(headers: ["Content-Type": "application/zip", "Content-Disposition": "attachment; filename=\"pack.zip\""], body: "PART", declaredLength: 4000)
        : .init(body: "<html>app</html>")
    }
    defer { relay.stop() }
    let spy = Spy()
    let dir = URL(fileURLWithPath: NSTemporaryDirectory() + "/talos-dl-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let dest = dir.appendingPathComponent("pack.zip")
    try "OLD".write(to: dest, atomically: true, encoding: .utf8)
    let c = controller(relay, saveTo: dest, spy)
    #expect(await pumpUntil(3) { relay.saw("/") })
    c.routeExternal(URL(string: relay.origin + "/media/m_01CUT")!)
    #expect(await pumpUntil(8) { !spy.problems.isEmpty }, "a cut-off download passed in silence")
    #expect((try? String(contentsOf: dest, encoding: .utf8)) == "OLD", "the old file was deleted before the new one arrived")
    #expect((try FileManager.default.contentsOfDirectory(atPath: dir.path)) == ["pack.zip"], "a half-written file was left behind")
  }

  @Test func savingOverAFileReplacesItWhenTheDownloadCompletes() async throws {
    let relay = try FakeRelay { r in
      r.path == "/media/m_01OK"
        ? .init(headers: ["Content-Type": "application/zip", "Content-Disposition": "attachment; filename=\"pack.zip\""], body: "NEWBYTES")
        : .init(body: "<html>app</html>")
    }
    defer { relay.stop() }
    let spy = Spy()
    let dir = URL(fileURLWithPath: NSTemporaryDirectory() + "/talos-dl-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let dest = dir.appendingPathComponent("pack.zip")
    try "OLD".write(to: dest, atomically: true, encoding: .utf8)
    let c = controller(relay, saveTo: dest, spy)
    #expect(await pumpUntil(3) { relay.saw("/") })
    c.routeExternal(URL(string: relay.origin + "/media/m_01OK")!)
    #expect(await pumpUntil(8) { !spy.saved.isEmpty }, "never saved; problems \(spy.problems)")
    #expect((try? String(contentsOf: dest, encoding: .utf8)) == "NEWBYTES")
    #expect((try FileManager.default.contentsOfDirectory(atPath: dir.path)) == ["pack.zip"])
  }

  @Test func theTerminalWindowKnowsTheModelFromLaunchSoABannerTapOpensIt() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    // TmuxWorld attaches its own model by hand; a model built the way the app builds it must attach itself.
    let launched = SupervisorController()
    #expect(TerminalWindowController.shared.isAttached(to: launched), "a tap would open a blank window: nothing attached the model")
  }

  @Test func theNeedsYouPaneComesForwardWithoutTakingTheKeyboard() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    StatusCoordinator.shared.setQuietForTest(nil)
    TerminalWindowController.shared.hideForTest()
    w.model.handle(.openTerminal)
    #expect(TerminalWindowController.shared.isVisible)
    #expect(!TerminalWindowController.shared.wantsKeyboardForTest, "a stray Return would answer the agent's dialog")
    TerminalWindowController.shared.hideForTest()
    TerminalWindowController.shared.show()  // the owner asked for it
    #expect(TerminalWindowController.shared.wantsKeyboardForTest)
    TerminalWindowController.shared.hideForTest()
  }

  @Test func theNeedsYouPaneStaysAwayInsideTheQuietWindow() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    let m = (Calendar.current.component(.hour, from: Date()) * 60 + Calendar.current.component(.minute, from: Date()))
    func hhmm(_ x: Int) -> String { String(format: "%02d:%02d", x / 60, x % 60) }
    let json = #"{"quiet_window":{"start":"\#(hhmm((m + 1430) % 1440))","end":"\#(hhmm((m + 10) % 1440))"},"timezone":"\#(TimeZone.current.identifier)"}"#
    StatusCoordinator.shared.setQuietForTest(try #require(QuietWindow.read(Data(json.utf8))))
    defer { StatusCoordinator.shared.setQuietForTest(nil) }
    TerminalWindowController.shared.hideForTest()
    w.model.handle(.openTerminal)
    #expect(!TerminalWindowController.shared.isVisible, "the window popped up in the owner's quiet hours")
  }

  @Test func aFailedStartIsSaidOnceAndAMissingConversationOffersOnlyANewOne() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    w.model.configured = true
    w.model.status.phase = .stopped(.startFailed("start failed: claude was not found (claude_path auto)"))
    w.model.handle(.stopped(.startFailed("start failed: claude was not found (claude_path auto)")))
    #expect(w.model.notice == "Talos couldn't start: claude was not found (claude_path auto)", "\(w.model.notice)")
    #expect(!w.model.retryCannotWork)
    w.model.status.phase = .stopped(.resumeMissing("abc"))
    #expect(w.model.failedStop)
    #expect(w.model.retryCannotWork, "Try again would fail the same way")
  }
}
}

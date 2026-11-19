import AppKit
import Foundation
import SwiftTerm
import Testing
import TalosDesktopCore
@testable import TalosDesktop
import TalosTestSupport

/// The app's own enroll: the four words in the app's sign-in window, "The words match" writes `y` once to the enroll child's pty,
/// "They don't match" ends it. A real child on a real pty (a script that prints what `talos-app enroll` prints); no tmux, no Terminals window.
@Suite("Pairing confirm", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct PairingConfirmGuiTests {
  struct World {
    var dir: String
    var web: WebController
    var relay: FakeRelay
    var cfg: DesktopConfig
  }

  /// `prompt`: what the child prints after the link; it then reads one answer line into `answer` and exits.
  func world(prompt: String, then: String = "IFS= read -r ans; printf '%s' \"$ans\" > ANSWER") async throws -> World {
    let dir = (TestTemp.base as NSString).appendingPathComponent("pairing-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let relay = try FakeRelay { _ in
      .init(body: "<script>window.talosNative={receive:function(j){}};\(talosPost)({type:'ready',shell_api:1,features:[],signed_in:false})</script>")
    }
    let web = WebController()
    web.openExternal = { _ in }
    web.configure(relay: relay.relay)
    web.prepare()
    #expect(await pumpUntil(4) { web.pageReady })
    writeScript(dir + "/talos-app", """
      #!/bin/bash
      echo 'Open this link on the device you want to add (it works once, for 10 minutes):'
      echo '\(relay.origin)/enroll#0123456789ABCDEFGHJKMNPQRS'
      sleep 0.2
      \(prompt)
      \(then.replacingOccurrences(of: "ANSWER", with: "'\(dir)/answer'"))
      echo "ended" > '\(dir)/ended'
      """)
    var cfg = DesktopConfig.defaults
    cfg.talosAppCommand = [dir + "/talos-app"]
    return World(dir: dir, web: web, relay: relay, cfg: cfg)
  }

  func armed(_ p: PairingController) {
    // the controller is a shared singleton: every test starts from the same settings, whatever the one before changed
    p.readDelay = 0.05
    p.pinWait = PairingSession.defaultPinWait
    p.exitGrace = 15
    p.writeOverride = nil
    p.front = { _ in }
  }

  /// The panel with its words drawn, its approve button, and a click event on it from a given origin (pid 0 and the hardware state: the owner's hand).
  func approveSetup(_ p: PairingController) throws -> (panel: PairingPanel, button: NSButton) {
    let panel = try #require(p.panelForTest)
    panel.render()
    panel.contentView?.layoutSubtreeIfNeeded()
    return (panel, try #require(panel.approveButton, "no approve button: the words are not up"))
  }

  func clickEvent(_ panel: PairingPanel, _ b: NSButton, pid: Int64 = 0) throws -> NSEvent {
    try guiMouse(.leftMouseUp, in: panel, at: b.convert(NSPoint(x: b.bounds.midX, y: b.bounds.midY), to: nil), pid: pid)
  }

  /// The button's own action, run while the app is handling `event` (nil: an Accessibility press or AppleScript, which send no mouse event).
  func press(_ p: PairingController, event: NSEvent?) throws {
    let (panel, b) = try approveSetup(p)
    panel.handlingEvent = { event }
    click(b)
  }

  func humanApprove(_ p: PairingController) throws {
    let (panel, b) = try approveSetup(p)
    try press(p, event: try clickEvent(panel, b))
  }

  func answer(_ w: World) -> String { (try? String(contentsOfFile: w.dir + "/answer", encoding: .utf8)) ?? "" }

  let whole = "printf 'Pin \"Mac app\" [aardvark adroitness absurd adviser]? [y/N] '"

  @Test func theWordsAppearAndConfirmSendsYExactlyOnce() async throws {
    let w = try await world(prompt: whole)
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    let details = p.detailsShown
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.phase == .confirm(["aardvark", "adroitness", "absurd", "adviser"]) }, "phase \(p.phase)")
    #expect(await pumpUntil(2) { p.confirmEnabled })
    try humanApprove(p)
    p.panelForTest?.render()
    #expect(p.panelForTest?.approveButton == nil, "a second press: there is no button any more")
    #expect(await pumpUntil(5) { answer(w).hasPrefix("y") }, "the child got: \(answer(w).debugDescription)")
    #expect(answer(w) == "y", "exactly one y: \(answer(w).debugDescription)")
    // a whole setup run, and no Terminals window was ever shown
    #expect(p.detailsShown == details, "a whole setup run opened the terminal pane")  // (not the global show counter: other suites' controllers may open it)
    p.cancel()
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  @Test func aPartialQuestionIsNotConfirmable() async throws {
    let w = try await world(prompt: "printf 'Pin \"Mac app\" [aardvark adroon riv'", then: "sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.phase == .waiting })
    await pump(0.5)
    #expect(p.phase == .waiting)
    #expect(p.confirmEnabled == false)
    #expect(p.panelForTest?.approveButton == nil, "no approve button on a partial question")
    #expect(answer(w) == "")
    p.cancel()
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  @Test func theyDontMatchSendsNoEndsTheChildAndOffersANewCode() async throws {
    let w = try await world(prompt: whole)
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    p.mismatch()
    #expect(p.phase == .mismatch)
    p.panelForTest?.render()
    #expect(p.panelForTest?.approveButton == nil, "nothing confirms after They don't match")
    #expect(await pumpUntil(5) { !p.isRunning }, "child still running")
    #expect(!answer(w).hasPrefix("y"))
    p.cancel()
  }

  @Test func cancelEndsTheChildAndCleansUp() async throws {
    let w = try await world(prompt: whole)
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.phase != .starting && p.phase != .idle })
    p.cancel()
    #expect(p.phase == .idle)
    #expect(await pumpUntil(5) { !p.isRunning })
    #expect(p.panelForTest == nil)
  }

  @Test func aSecondEnrollWhilePendingStartsNothingNew() async throws {
    let w = try await world(prompt: whole)
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    let fronted = p.panelFronted
    p.start(config: w.cfg, web: w.web)
    await pump(0.5)
    #expect(p.panelFronted == fronted + 1, "the open window comes forward")
    #expect(p.phase == .confirm(["aardvark", "adroitness", "absurd", "adviser"]))
    try humanApprove(p)
    #expect(await pumpUntil(5) { answer(w) == "y" })
    p.cancel()
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  @Test func theChildDyingBeforeAnAnswerMakesNothingConfirmable() async throws {
    let w = try await world(prompt: whole, then: "sleep 0.4; exit 3")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    #expect(await pumpUntil(8) { if case .failed = p.phase { return true } else { return false } }, "phase \(p.phase)")
    #expect(p.confirmEnabled == false)
    p.panelForTest?.render()
    #expect(p.panelForTest?.approveButton == nil)
    p.cancel()
  }

  @Test func noAnswerInTimeEndsTheOffer() async throws {
    let w = try await world(prompt: whole, then: "sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.pinWait = 0.8
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { if case .failed = p.phase { return true } else { return false } }, "phase \(p.phase)")
    p.panelForTest?.render()
    #expect(p.panelForTest?.approveButton == nil)
    #expect(await pumpUntil(5) { !p.isRunning })
    p.cancel()
  }

  // MARK: only a real human click on the button approves (R1-1)

  @Test func aSyntheticReturnApprovesNothing() async throws {
    let w = try await world(prompt: whole, then: "IFS= read -r ans; printf '%s' \"$ans\" > ANSWER")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    let (panel, b) = try approveSetup(p)
    // an agent's screen_key "enter" or an osascript keystroke: dropped at the app's gate because this is a prompt window
    #expect(SyntheticInputGuard.isPromptWindow(panel))
    let key = try guiKey(.keyDown, in: panel, pid: 4242)
    #expect(SyntheticInputGuard.admit(key, flight: SyntheticInput.Flight()) == false)
    // even a Return that gets through (hardware origin) finds no default button, no key equivalent, and a window that is never key
    let hw = try guiKey(.keyDown, in: panel)
    #expect(panel.performKeyEquivalent(with: hw) == false)
    panel.sendEvent(hw)
    #expect(b.keyEquivalent == "" && panel.defaultButtonCell == nil)
    #expect(panel.canBecomeKey == false && panel.canBecomeMain == false)
    await pump(0.4)
    #expect(answer(w) == "")
    #expect(p.phase == .confirm(["aardvark", "adroitness", "absurd", "adviser"]))
    p.cancel()
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  @Test func aSyntheticClickApprovesNothing() async throws {
    let w = try await world(prompt: whole, then: "sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    let (panel, b) = try approveSetup(p)
    let posted = try clickEvent(panel, b, pid: 4242)  // a click a program posted (cliclick, a computer-use tool) carries its pid
    #expect(SyntheticInputGuard.admit(posted, flight: SyntheticInput.Flight()) == false, "dropped at the gate before it reaches the panel")
    try press(p, event: posted)  // and if it got to the action anyway
    #expect(p.phase == .confirm(["aardvark", "adroitness", "absurd", "adviser"]), "nothing was approved: \(p.phase)")
    #expect(p.approve(clickedBy: posted, on: b) == false)
    p.cancel()
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  @Test func anAccessibilityPressApprovesNothing() async throws {
    let w = try await world(prompt: whole, then: "sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    let (_, b) = try approveSetup(p)
    #expect(b.isAccessibilityElement() == false, "the approve button is not offered to Accessibility")
    try press(p, event: nil)  // an AXPress runs the action with no mouse event
    #expect(p.phase == .confirm(["aardvark", "adroitness", "absurd", "adviser"]))
    p.cancel()
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  @Test func aRealClickApproves() async throws {
    let w = try await world(prompt: whole)
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    try humanApprove(p)
    #expect(await pumpUntil(5) { answer(w) == "y" }, "got \(answer(w).debugDescription)")
    p.cancel()
  }

  @Test func bothAnswerButtonsAcceptTheFirstClickAndEnablingDoesNotRebuild() async throws {
    let w = try await world(prompt: whole, then: "sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.readDelay = 0.6
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { if case .confirm = p.phase { return true } else { return false } })
    await pump(0.15)  // the phase's own redraw has run; from here nothing may rebuild
    let panel = try #require(p.panelForTest)
    let yes = try #require(panel.approveButton)
    let no = try #require(panel.declineButton)
    let click = try clickEvent(panel, yes)
    // the app is not active and the panel is never key: the first click has to press, not just activate
    #expect(yes.acceptsFirstMouse(for: click) && no.acceptsFirstMouse(for: click))
    #expect(yes is FirstMouseButton && no is FirstMouseButton)
    // the enable flips the same button in place
    #expect(await pumpUntil(4) { p.confirmEnabled })
    await pump(0.2)
    #expect(panel.approveButton === yes, "the content was rebuilt on the enable")
    #expect(yes.isEnabled)
    p.cancel()
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  // MARK: the window never takes the keyboard, is kept out of screenshots (R1-2, R1-7)

  @Test func theSignInWindowTakesNoKeyAndIsSecret() async throws {
    let w = try await world(prompt: whole, then: "sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.front = { PairingPanel.bringToFront($0) }  // the real fronting this time
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    let panel = try #require(p.panelForTest)
    #expect(panel.isVisible)
    #expect(panel.isKeyWindow == false && panel.canBecomeKey == false)
    #expect(panel.styleMask.contains(.nonactivatingPanel))
    #expect(ScreenSecretWindows.current.contains(UInt32(panel.windowNumber)), "a screenshot would show the four words")
    #expect(panel.sharingType == .none)
    let number = UInt32(panel.windowNumber)
    p.cancel()
    #expect(!ScreenSecretWindows.current.contains(number), "forgotten once it is closed")
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  // MARK: close after Confirm never ends the child (R1-4)

  @Test func closingAfterConfirmLetsTheChildFinishOnItsOwn() async throws {
    let w = try await world(prompt: whole, then: "IFS= read -r ans; sleep 1; printf '%s' \"$ans\" > ANSWER")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    try humanApprove(p)
    p.closeWindow()  // the Close button
    _ = p.panelForTest?.windowShouldClose(p.panelForTest!)  // and the title-bar X
    p.cancel()
    #expect(p.isRunning, "the child was ended before it wrote the answer")
    #expect(await pumpUntil(6) { answer(w) == "y" }, "the child never got to write its answer: \(answer(w).debugDescription)")
    #expect(await pumpUntil(5) { !p.isRunning })
  }

  @Test func aStuckChildAfterConfirmIsEndedAfterTheGrace() async throws {
    let w = try await world(prompt: whole, then: "IFS= read -r ans; sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.exitGrace = 0.5
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    try humanApprove(p)
    #expect(p.isRunning)
    #expect(await pumpUntil(5) { !p.isRunning }, "a stuck child was never ended")
  }

  @Test func theXBeforeConfirmDeclinesAndEndsTheChild() async throws {
    let w = try await world(prompt: whole, then: "sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    let panel = try #require(p.panelForTest)
    #expect(panel.windowShouldClose(panel) == false)
    #expect(await pumpUntil(5) { !p.isRunning })
    #expect(p.phase == .idle)
  }

  // MARK: the owner's "Open on the Mac" raises the Terminals window without activating or making anything key (R1-5)

  @Test func raisingTheTerminalsWindowTakesNoKey() {
    _ = NSApplication.shared
    let c = TerminalWindowController.shared
    c.setPairingTab(nil)
    let wasActive = NSApp.isActive
    c.show(takeFocus: false, raise: true)
    defer { c.hideForTest() }
    let win = c.windowForTest
    #expect(win?.isVisible == true)
    #expect(win?.isKeyWindow == false, "a window that holds terminals was made key")
    #expect(win?.firstResponder is LocalProcessTerminalView == false)
    #expect(NSApp.isActive == wasActive, "raising must not activate the app: AppKit would hand the keyboard to some window")
  }

  @Test func showDetailsIsTheOnlyWayTheTerminalOpens() async throws {
    let w = try await world(prompt: whole, then: "sleep 30")
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    let details = p.detailsShown
    p.start(config: w.cfg, web: w.web)
    #expect(await pumpUntil(8) { p.confirmEnabled })
    #expect(p.detailsShown == details, "the sign-in opened the details pane by itself")
    p.cancel()
    #expect(await pumpUntil(5) { !p.isRunning })
  }
}

/// Source scan: setup never opens a terminal on its own, and every window the app orders in front also activates the app.
@Suite("Windows come to the front")
struct WindowsToFrontScanTests {
  static let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Sources/TalosDesktop")

  func text(_ f: String) throws -> String { try String(contentsOf: Self.sources.appendingPathComponent(f), encoding: .utf8) }

  @Test func theSignInFlowOpensNoTerminalUnlessTheOwnerAsksForDetails() throws {
    for f in ["Pairing.swift", "PairingPanel.swift", "SignIn.swift"] {
      let lines = try text(f).split(separator: "\n").map(String.init)
      for (i, l) in lines.enumerated() where l.contains("TerminalWindowController.shared.show(") {
        // only inside showDetails()
        let before = lines[..<i].reversed().first { $0.contains("func ") } ?? ""
        #expect(before.contains("func showDetails"), "\(f):\(i + 1) opens the terminal outside Show details")
      }
      let body = try text(f)
      #expect(!body.contains("Terminal.app"), "\(f)")
    }
  }

  @Test func everyWindowOrderedToTheFrontActivatesTheApp() throws {
    let files = try FileManager.default.contentsOfDirectory(atPath: Self.sources.path).filter { $0.hasSuffix(".swift") }
    var seen = 0
    for f in files {
      let t = try text(f)
      guard t.contains("makeKeyAndOrderFront") else { continue }
      seen += 1
      #expect(t.contains("NSApp.activate(ignoringOtherApps: true)"), "\(f) orders a window front without activating the app")
    }
    #expect(seen >= 3, "control: the scan sees the windows (\(seen))")
  }

  @Test func theSignInWindowIsFrontedWithoutActivatingOrTakingKey() throws {
    let t = try text("PairingPanel.swift")
    #expect(t.contains("orderFrontRegardless()"))
    #expect(!t.contains("NSApp.activate") && !t.contains("makeKeyAndOrderFront") && !t.contains("makeKey()"))
    #expect(t.contains(".nonactivatingPanel") && t.contains("canBecomeKey: Bool { false }"))
    #expect(try text("Pairing.swift").contains("front(p)"))
    // the raise path of the Terminals window never activates
    let tw = try text("TerminalWindow.swift")
    let raise = try #require(tw.range(of: "if !takeFocus, raise {"))
    let branch = tw[raise.upperBound...].prefix { _ in true }
    let end = try #require(branch.range(of: "} else"))
    #expect(!branch[..<end.lowerBound].contains("NSApp.activate"))
  }

  @Test func everyButtonInANonactivatingPromptPanelIsAFirstMouseButton() throws {
    for f in ["PairingPanel.swift"] {
      let t = try text(f)
      #expect(!t.contains("NSButton(title"), "\(f): a plain NSButton in a panel that is never key eats the first click")
      #expect(t.contains("FirstMouseButton(title"))
    }
  }

  @Test func theSignInWindowIsAPromptWindowAndNothingApprovesByKeyOrAccessibility() throws {
    let g = try text("SyntheticInputGuard.swift")
    #expect(g.contains("w is PairingPanel"))
    let panel = try text("PairingPanel.swift")
    #expect(!panel.contains(".keyboardShortcut") && !panel.contains("keyEquivalent = \"\r\""))
    #expect(try text("Pairing.swift").contains("NeedsYouPopupView.isRealClick(event, on: button)"))
  }
}

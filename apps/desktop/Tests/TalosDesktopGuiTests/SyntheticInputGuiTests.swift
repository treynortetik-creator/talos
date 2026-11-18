import AppKit
import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport
import WebKit

@testable import TalosDesktop

// An agent in Talos never answers a card or a prompt and never reaches a terminal (docs/SECURITY.md "An agent in Talos"): the AppKit
// half. Events are made here and handed to the windows' own `sendEvent`, never posted to the system. Runs only with TALOS_GUI_TESTS=1
// (DESKTOP-SPEC 7.2).

/// A person's event has pid 0, the hardware state and no token; an agent's has this process's pid and a token.
@MainActor
func guiMouse(
  _ type: NSEvent.EventType, in w: NSWindow, at p: NSPoint = NSPoint(x: 20, y: 20), pid: Int64 = 0, token: Int64 = 0,
  state: Int64 = SyntheticInput.hidSystemStateId
) throws -> NSEvent {
  let e = try #require(
    NSEvent.mouseEvent(
      with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
      context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
  let cg = try #require(e.cgEvent)
  cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
  cg.setIntegerValueField(.eventSourceStateID, value: state)
  cg.setIntegerValueField(.eventSourceUserData, value: token)
  // A CGEvent's location is global with a top-left origin; how NSEvent(cgEvent:) maps it into a window that is not on screen depends on
  // where AppKit thinks the window is. Measure that once (x keeps its direction, y flips), then aim at `p` with it.
  let probe = try #require(NSEvent(cgEvent: cg)).locationInWindow
  cg.location = CGPoint(x: cg.location.x + p.x - probe.x, y: cg.location.y - (p.y - probe.y))
  return try #require(NSEvent(cgEvent: cg))
}

@MainActor
func guiKey(
  _ type: NSEvent.EventType, in w: NSWindow, chars: String = "\r", code: UInt16 = 36, pid: Int64 = 0, token: Int64 = 0
) throws -> NSEvent {
  let e = try #require(
    NSEvent.keyEvent(
      with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
      context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code))
  let cg = try #require(e.cgEvent)
  cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
  cg.setIntegerValueField(.eventSourceStateID, value: SyntheticInput.hidSystemStateId)
  cg.setIntegerValueField(.eventSourceUserData, value: token)
  return try #require(NSEvent(cgEvent: cg))
}

let ownPid = Int64(getpid())

@Suite("Synthetic input: the Talos window", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct SyntheticInputGuiTests {
  func window() -> WebNSWindow {
    _ = NSApplication.shared
    let w = WebNSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    return w
  }

  @Test func theWindowTellsItsPageWhoSentEachEventBeforeDeliveringItAndAnswersAnAgentsRelease() throws {
    let w = window()
    var seen: [String] = []
    var answered: [Int64] = []
    w.stamp = { origin, name, token, code in seen.append("\(origin == .human ? "human" : "synthetic"):\(name):\(token):\(code)") }
    w.answer = { answered.append($0) }
    w.sendEvent(try guiMouse(.leftMouseDown, in: w))
    w.sendEvent(try guiMouse(.leftMouseUp, in: w))
    w.sendEvent(try guiMouse(.leftMouseDown, in: w, pid: ownPid, token: 7))
    w.sendEvent(try guiMouse(.leftMouseUp, in: w, pid: ownPid, token: 7))
    w.sendEvent(try guiKey(.keyDown, in: w))
    w.sendEvent(try guiKey(.keyUp, in: w, pid: ownPid, token: 8))
    w.sendEvent(try guiMouse(.leftMouseUp, in: w, pid: 4242))
    w.sendEvent(try guiMouse(.leftMouseUp, in: w, state: 0))
    #expect(
      seen == [
        "human:leftMouseDown:0:0", "human:leftMouseUp:0:0", "synthetic:leftMouseDown:7:0", "synthetic:leftMouseUp:7:0", "human:keyDown:0:36",
        "synthetic:keyUp:8:36", "synthetic:leftMouseUp:0:0", "synthetic:leftMouseUp:0:0",
      ], "\(seen)")
    #expect(answered == [7, 8], "only the release or key-up of an event with a token is answered: \(answered)")
  }

  @Test func theTokenOnAnEventIsReadBackAndMakesItSynthetic() throws {
    let w = window()
    let e = try guiMouse(.leftMouseUp, in: w, token: 99)
    #expect(SyntheticInputGuard.token(of: e) == 99)
    #expect(SyntheticInputGuard.origin(of: e, flight: SyntheticInput.Flight()) == .synthetic, "pid 0 and the hardware state, but a token")
    #expect(SyntheticInputGuard.token(of: try guiMouse(.leftMouseUp, in: w)) == 0)
  }

  @Test func anEventOfOursStillAwaitingItsAnswerMakesAPersonsEventSyntheticToo() throws {
    let w = window()
    let flight = SyntheticInput.Flight()
    let t = flight.begin()
    flight.expect(t, answers: 1)
    flight.end()
    #expect(SyntheticInputGuard.origin(of: try guiMouse(.leftMouseUp, in: w), flight: flight) == .synthetic)
    flight.handled(t)
    #expect(SyntheticInputGuard.origin(of: try guiMouse(.leftMouseUp, in: w), flight: flight) == .human)
  }

  @Test func theWindowsThatAnswerPromptsAreTheNativeOnesAndNotThePage() {
    _ = NSApplication.shared
    #expect(SyntheticInputGuard.isPromptWindow(NeedsYouPanel(size: CGSize(width: 100, height: 100))))
    #expect(!SyntheticInputGuard.isPromptWindow(window()))
    #expect(!SyntheticInputGuard.isPromptWindow(nil))
    let alert = NSAlert()
    alert.messageText = "x"
    #expect(alert.window.worksWhenModal || alert.window is NSPanel, "an alert's window is a panel the guard takes for a prompt")
  }

  @Test func theEventNamesThePageKnowsAreTheOnesTheWindowSends() {
    for (t, n) in [
      (NSEvent.EventType.leftMouseDown, "leftMouseDown"), (.leftMouseUp, "leftMouseUp"), (.rightMouseUp, "rightMouseUp"),
      (.keyDown, "keyDown"), (.keyUp, "keyUp"),
    ] { #expect(SyntheticInputGuard.stampName(t) == n) }
    #expect(SyntheticInputGuard.stampName(.mouseMoved) == nil && SyntheticInputGuard.stampName(.scrollWheel) == nil)
    for n in ["leftMouseUp", "rightMouseUp", "otherMouseUp", "keyDown", "keyUp", "leftMouseDown", "rightMouseDown", "otherMouseDown"] {
      #expect(ProtectedInputScript.source.contains("'\(n)'"), "\(n)")
    }
    #expect(SyntheticInputGuard.isAnswerType(.leftMouseUp) && SyntheticInputGuard.isAnswerType(.keyUp) && SyntheticInputGuard.isAnswerType(.scrollWheel))
    #expect(!SyntheticInputGuard.isAnswerType(.leftMouseDown) && !SyntheticInputGuard.isAnswerType(.keyDown))
  }
}

/// R1-1, R1-2, R1-3: every terminal view in Talos drops what an agent sends. The terminal runs `cat` into a file, so what the
/// owner's shell, the agent's pane or the sign-in prompt would have read is exactly what is in the file.
@Suite("Synthetic input: terminals", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct SyntheticInputTerminalGuiTests {
  @MainActor
  final class Rig {
    let dir = (TestTemp.base as NSString).appendingPathComponent("talos-synth-\(UUID().uuidString.prefix(8))")
    var file: String { dir + "/in.txt" }
    let view: SafeTerminalView
    init() {
      try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
      view = SafeTerminalView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
      view.startProcess(executable: "/bin/sh", args: ["-c", "stty raw -echo; exec /bin/cat > '\(dir)/in.txt'"], environment: ["PATH=/usr/bin:/bin"])
    }
    var read: String { (try? String(contentsOfFile: file, encoding: .utf8)) ?? "" }
    func end() {
      if view.process.running { view.terminate() }
      try? FileManager.default.removeItem(atPath: dir)
    }
  }

  func pump(_ s: Double = 0.4) async {
    let end = Date().addingTimeInterval(s)
    while Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
  }

  /// Sends an agent's key and click, then the owner's, through `deliver` (a window's `sendEvent`); what the terminal read is the answer.
  func exercise(_ r: Rig, window w: NSWindow, deliver: (NSEvent) -> Void, answer: (Int64) -> SyntheticInput.Settled) async throws {
    w.makeFirstResponder(r.view)
    #expect(w.firstResponder === r.view)
    let tk = SyntheticInput.flight.begin(), tm = SyntheticInput.flight.begin()
    SyntheticInput.flight.expect(tk, answers: 1)
    SyntheticInput.flight.expect(tm, answers: 1)
    SyntheticInput.flight.end()
    SyntheticInput.flight.end()
    // the agent: a letter, Return, and a click inside the view
    for (c, code) in [("y", UInt16(16)), ("\r", UInt16(36))] {
      deliver(try guiKey(.keyDown, in: w, chars: c, code: code, pid: ownPid, token: tk))
      deliver(try guiKey(.keyUp, in: w, chars: c, code: code, pid: ownPid, token: tk))
    }
    deliver(try guiMouse(.leftMouseDown, in: w, at: NSPoint(x: 30, y: 30), pid: ownPid, token: tm))
    deliver(try guiMouse(.leftMouseUp, in: w, at: NSPoint(x: 30, y: 30), pid: ownPid, token: tm))
    await pump()
    #expect(r.read == "", "the shell read \(r.read.debugDescription)")
    let (rk, rm) = (answer(tk), answer(tm))
    #expect(rk == .dropped, "the agent's keys hear the drop: \(rk)")
    #expect(rm == .dropped, "the agent's click hears the drop: \(rm)")
    SyntheticInput.flight.forget([tk, tm])
  }

  @Test func theAgentsPaneAndEveryTerminalViewDropAnAgentsKeysInTheTerminalsWindow() async throws {
    _ = NSApplication.shared
    let r = Rig()
    defer { r.end() }
    let w = TerminalNSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.contentView = r.view
    try await exercise(r, window: w, deliver: { w.sendEvent($0) }, answer: { SyntheticInput.flight.wait([$0], timeout: 1) })
  }

  @Test func theSameInTheTalosWindowWhereTheEmbeddedTerminalAndTheShellPaneSit() async throws {
    _ = NSApplication.shared
    let r = Rig()
    defer { r.end() }
    let w = WebNSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    let host = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
    host.addSubview(r.view)
    w.contentView = host
    try await exercise(r, window: w, deliver: { w.sendEvent($0) }, answer: { SyntheticInput.flight.wait([$0], timeout: 1) })
  }

  /// The monitor is the first line: it drops the same events for any window, including one with no `sendEvent` of ours.
  @Test func theLocalMonitorDropsAnAgentsEventAtAnyTerminalAndAnswersOneAtAnythingElse() async throws {
    _ = NSApplication.shared
    let r = Rig()
    defer { r.end() }
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.contentView = r.view
    w.makeFirstResponder(r.view)
    let flight = SyntheticInput.Flight()
    let t = flight.begin()
    flight.expect(t, answers: 1)
    flight.end()
    #expect(!SyntheticInputGuard.admit(try guiKey(.keyDown, in: w, chars: "y", code: 16, pid: ownPid, token: t), flight: flight))
    #expect(flight.wait([t], timeout: 0.2) == .dropped)
    // a human's own key at the same terminal passes
    #expect(SyntheticInputGuard.admit(try guiKey(.keyDown, in: w, chars: "y", code: 16), flight: SyntheticInput.Flight()))
    // an agent's release at a plain window is let through and answered
    let plain = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
    plain.isReleasedWhenClosed = false
    let u = flight.begin()
    flight.expect(u, answers: 1)
    flight.end()
    #expect(SyntheticInputGuard.admit(try guiMouse(.leftMouseUp, in: plain, pid: ownPid, token: u), flight: flight))
    #expect(flight.wait([u], timeout: 0.2) == .handled)
  }

  /// A person's own typing still reaches the terminal (the positive control for the tests above).
  @Test func theOwnersOwnKeyAndClickStillReachATerminal() async throws {
    _ = NSApplication.shared
    let r = Rig()
    defer { r.end() }
    let w = TerminalNSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.contentView = r.view
    w.makeFirstResponder(r.view)
    w.sendEvent(try guiKey(.keyDown, in: w, chars: "y", code: 16))
    w.sendEvent(try guiKey(.keyUp, in: w, chars: "y", code: 16))
    for _ in 0..<30 where r.read.isEmpty { await pump(0.1) }
    #expect(r.read == "y", "the shell read \(r.read.debugDescription)")
  }
}

@Suite("Synthetic input: the page script in a real web view", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct ProtectedInputScriptGuiTests {
  func pump(_ seconds: Double = 0.4) async {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
  }

  static let html =
    #"<html><body><button id="p" data-talos-protected onclick="window.hits=(window.hits||0)+1">Approve</button><button id="o" onclick="window.others=(window.others||0)+1">Other</button></body></html>"#

  func load(_ flight: SyntheticInput.Flight) async throws -> WKWebView {
    _ = NSApplication.shared
    let cfg = WKWebViewConfiguration()
    SyntheticInputGuard.install(in: cfg, flight: flight)
    let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 300, height: 200), configuration: cfg)
    wv.loadHTMLString(Self.html, baseURL: URL(string: "https://relay.example.com/")!)
    for _ in 0..<40 {
      await pump(0.1)
      if (try? await wv.evaluateJavaScript("document.readyState") as? String) == "complete" { break }
    }
    return wv
  }

  @Test func theScriptIsInThePageButOnlyInItsOwnWorldAndAPageScriptCannotForgeAStamp() async throws {
    let flight = SyntheticInput.Flight()
    let wv = try await load(flight)
    let inPage = try await wv.evaluateJavaScript("typeof window.__talosGuardStamp") as? String
    #expect(inPage == "undefined")
    let inGuard = try await wv.evaluateJavaScript("typeof window.__talosGuardStamp", in: nil, contentWorld: SyntheticInputGuard.world) as? String
    #expect(inGuard == "function")
    // the owner's stamp is not enough for a click the page made itself (the browser did not: isTrusted is false)
    let t = flight.begin()
    flight.expect(t, answers: 1)
    flight.end()
    _ = try await wv.evaluateJavaScript("window.__talosGuardStamp('human','leftMouseUp',\(t),0)", in: nil, contentWorld: SyntheticInputGuard.world)
    _ = try await wv.evaluateJavaScript("document.getElementById('p').click()")
    _ = try await wv.evaluateJavaScript("document.getElementById('o').click()")
    _ = try await wv.evaluateJavaScript("window.__talosGuardAck(\(t))", in: nil, contentWorld: SyntheticInputGuard.world)
    #expect(flight.wait([t], timeout: 3) == .dropped, "the cancelled click is reported against the token, before the answer")
    let hits = try await wv.evaluateJavaScript("window.hits || 0") as? Int
    let others = try await wv.evaluateJavaScript("window.others || 0") as? Int
    #expect(hits == 0 && others == 1, "protected \(String(describing: hits)), other \(String(describing: others))")
  }

  /// The ack is answered after the page's own handlers ran: a token with no drop settles as handled.
  @Test func anAckForATokenWithNoDropSettlesAsHandled() async throws {
    let flight = SyntheticInput.Flight()
    let wv = try await load(flight)
    let t = flight.begin()
    flight.expect(t, answers: 1)
    flight.end()
    _ = try await wv.evaluateJavaScript("window.__talosGuardAck(\(t))", in: nil, contentWorld: SyntheticInputGuard.world)
    #expect(flight.wait([t], timeout: 3) == .handled)
  }

  /// R1-7: the real chain as far as a test can take it without posting to the system: real `NSEvent`s with the fields the system puts on
  /// them go through the real `WebNSWindow.sendEvent`, into a real web view, where the real script cancels or lets them through.
  /// Posting a real CGEvent would move the pointer on the machine running the test; that run is in the verify skill's Mac-app route.
  @Test func realEventsThroughTheRealWindowIntoARealPage() async throws {
    let flight = SyntheticInput.Flight()
    let wv = try await load(flight)
    let w = WebNSWindow(contentRect: NSRect(x: 60, y: 60, width: 300, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.contentView = wv
    NSApp.activate(ignoringOtherApps: true)
    w.makeKeyAndOrderFront(nil)
    defer { w.orderOut(nil) }
    await pump(0.5)
    w.stamp = { o, n, t, c in SyntheticInputGuard.stamp(wv, o, n, token: t, keyCode: c) }
    w.answer = { SyntheticInputGuard.ack(wv, token: $0) }
    // where the button is, in window coordinates (y up)
    let rect = try #require(
      try await wv.evaluateJavaScript("(() => { const r = document.getElementById('p').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        as? [Double])
    let content = w.contentLayoutRect
    let at = NSPoint(x: rect[0], y: content.height - rect[1])
    func hits() async -> Int { (try? await wv.evaluateJavaScript("window.hits || 0") as? Int) ?? -1 }

    // First, can this machine's window server hand injected events to WebKit at all? A person's click must reach the page; if it
    // does not (a locked or headless session), the rest proves nothing, and the run belongs to the Mac-app verify route.
    w.sendEvent(try guiMouse(.leftMouseDown, in: w, at: at))
    w.sendEvent(try guiMouse(.leftMouseUp, in: w, at: at))
    for _ in 0..<30 where await hits() == 0 { await pump(0.1) }
    guard await hits() == 1 else {
      try Test.cancel("this session does not deliver injected mouse events to WebKit; run it by hand (.claude/skills/verify, Mac app route)")
      return
    }
    _ = try await wv.evaluateJavaScript("window.hits = 0")

    // the agent: pid ours, a token. Dropped, and the request hears it.
    let t = flight.begin()
    flight.expect(t, answers: 1)
    flight.end()
    w.sendEvent(try guiMouse(.leftMouseDown, in: w, at: at, pid: ownPid, token: t))
    w.sendEvent(try guiMouse(.leftMouseUp, in: w, at: at, pid: ownPid, token: t))
    // the answer comes through the main thread (the page's message handler), so poll; never block it
    var settled = SyntheticInput.Settled.unverified
    for _ in 0..<50 where settled == .unverified {
      await pump(0.1)
      settled = flight.wait([t], timeout: 0)
    }
    #expect(settled == .dropped)
    #expect(await hits() == 0)

    // the owner: pid 0, no token. The same click lands (this also proves the events reach the page at all).
    w.sendEvent(try guiMouse(.leftMouseDown, in: w, at: at))
    w.sendEvent(try guiMouse(.leftMouseUp, in: w, at: at))
    for _ in 0..<30 where await hits() == 0 { await pump(0.1) }
    #expect(await hits() == 1)
  }
}

/// R1-2: while the sign-in pane is open, the Terminals window shows the setup link and the four words, so no agent screenshot shows it.
@Suite("Synthetic input: the sign-in window is kept out of captures", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct PairingWindowGuiTests {
  @Test func theTerminalsWindowIsSecretWhileTheSignInTabIsOpenAndOnlyThen() throws {
    _ = NSApplication.shared
    let c = TerminalWindowController.shared
    c.setPairingTab(nil)
    let w = try #require(c.windowForTest)
    #expect(w.sharingType != .none)
    c.show(takeFocus: false)
    defer {
      c.setPairingTab(nil)
      w.orderOut(nil)
    }
    #expect(!ScreenSecretWindows.current.contains(UInt32(max(0, w.windowNumber))))
    c.setPairingTab(NSView(frame: NSRect(x: 0, y: 0, width: 100, height: 100)))
    c.show(takeFocus: false)  // the window has its number once it is ordered in
    #expect(w.windowNumber > 0)
    #expect(ScreenSecretWindows.current.contains(UInt32(w.windowNumber)), "a screenshot would show the setup link")
    #expect(w.sharingType == .none, "and macOS is asked to keep it out of captures too")
    c.setPairingTab(nil)
    #expect(!ScreenSecretWindows.current.contains(UInt32(w.windowNumber)))
    #expect(w.sharingType != .none)
  }
}

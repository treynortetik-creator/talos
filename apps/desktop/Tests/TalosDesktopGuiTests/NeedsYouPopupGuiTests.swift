import AppKit
import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop

// Needs-you prompts, the Mac popup: the window. Real NSPanels are MADE here but never ordered onto the screen (the controller's
// `orderFront` is a spy): what is checked is how the panel is configured, so a stray key can never answer a dialog. Runs only with
// TALOS_GUI_TESTS=1 (DESKTOP-SPEC 7.2).

private let idA = "AAAAAAAAAAAAAAAAAAAAAA", idB = "BBBBBBBBBBBBBBBBBBBBBB", idC = "CCCCCCCCCCCCCCCCCCCCCC", idD = "DDDDDDDDDDDDDDDDDDDDDD"

private func item(_ id: String, thread: String = "garden", kind: DialogReader.Kind = .trust, seen: String = "2026-11-07T10:00:00.000Z") -> NeedsYouPopupItem {
  let options: [String] = kind == .trust ? ["No, exit", "Yes, I trust this folder"] : kind == .login ? [] : ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"]
  return NeedsYouPopupItem(
    thread: thread, threadName: "Garden",
    dialog: DialogOffer(
      id: id, kind: kind, subject: kind == .login ? nil : "/Users/alex/Projects/garden", options: options, cursor: kind == .login ? nil : 0, seen_at: seen,
      expires_at: "2026-11-07T10:15:00.000Z"))
}

@MainActor private func popup(_ i: NeedsYouPopupItem) -> NeedsYouPopupCoordinator.Popup {
  .init(item: i, content: NeedsYouPopupContent.make(i), phase: .asking)
}

@MainActor private func buttons(in v: NSView) -> [NSButton] {
  var out: [NSButton] = []
  for s in v.subviews {
    if let b = s as? NSButton { out.append(b) }
    out += buttons(in: s)
  }
  return out
}

@MainActor private func content(_ p: NSPanel) throws -> NSView { try #require(p.contentView) }

@Suite("Needs-you popup: the window", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct NeedsYouPopupGuiTests {
  @Test func thePanelNeverActivatesTheAppNeverTakesKeyAndHasNoDefaultButton() throws {
    _ = NSApplication.shared
    let panel = NeedsYouPopupController.makePanel(for: popup(item(idA)), onClick: { _ in }, onClose: {})
    #expect(panel.styleMask.contains(.nonactivatingPanel), "set in the initializer: assigning it later does not take")
    #expect(panel.becomesKeyOnlyIfNeeded)
    #expect(panel.isFloatingPanel && panel.level == .floating)
    #expect(!panel.canBecomeKey && !panel.canBecomeMain)
    #expect(!panel.hidesOnDeactivate)
    #expect(panel.sharingType == .none, "it carries a folder path and a thread name")
    #expect(panel.defaultButtonCell == nil, "Return does nothing")
    #expect(!panel.isVisible && !panel.isKeyWindow && !panel.isMainWindow)
    #expect(!ActivationPolicyController.counts(panel), "a panel is not a Talos window: no Dock icon for it")
  }

  @Test func noButtonHasAKeyEquivalentAndAReturnOrEscapeKeystrokePressesNothing() throws {
    _ = NSApplication.shared
    for kind in [DialogReader.Kind.trust, .mcpConsent, .login] {
      var clicked: [Int] = [], closed = 0
      let panel = NeedsYouPopupController.makePanel(for: popup(item(idA, kind: kind)), onClick: { clicked.append($0) }, onClose: { closed += 1 })
      let all = buttons(in: try content(panel))
      #expect(all.count >= 2, "the answers and a close button")
      for b in all { #expect(b.keyEquivalent == "" && b.keyEquivalentModifierMask.isEmpty, "\(kind): \(b.title) has key equivalent \(b.keyEquivalent.debugDescription)") }
      for (code, chars) in [(UInt16(36), "\r"), (UInt16(76), "\u{3}"), (UInt16(49), " "), (UInt16(53), "\u{1b}")] {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
          let e = try #require(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code))
          panel.sendEvent(e)  // the way the app delivers an event to a window
          _ = panel.performKeyEquivalent(with: e)
        }
      }
      #expect(clicked.isEmpty && closed == 0, "\(kind): a key reached the popup: answered \(clicked), closed \(closed)")
    }
  }

  @Test func theButtonsAreTheOptionsInScreenOrderAndAClickReportsItsIndex() throws {
    _ = NSApplication.shared
    var clicked: [Int] = []
    var event: NSEvent?
    let panel = NeedsYouPopupController.makePanel(for: popup(item(idA, kind: .mcpConsent)), onClick: { clicked.append($0) }, onClose: {}, currentEvent: { event })
    let answers = buttons(in: try content(panel)).filter { $0.tag >= 0 }.sorted { $0.tag < $1.tag }
    #expect(answers.map(\.title) == ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"])
    event = try mouse(.leftMouseUp, on: answers[1])
    click(answers[1])
    #expect(clicked == [1])
  }

  @Test func theCloseButtonOnlyHidesAndPressesNothing() throws {
    _ = NSApplication.shared
    var clicked: [Int] = [], closed = 0
    let panel = NeedsYouPopupController.makePanel(for: popup(item(idA)), onClick: { clicked.append($0) }, onClose: { closed += 1 })
    let content = try #require(panel.contentView)
    let close = try #require(buttons(in: content).first { $0.tag < 0 })
    click(close)
    #expect(closed == 1 && clicked.isEmpty)
  }

  // MARK: only the owner's own click answers

  /// A real mouse click on an answer button; Accessibility presses and AppleScript send no mouse event, so the button's action is judged by the
  /// event the app is handling when it runs.
  private func mouse(_ type: NSEvent.EventType, on b: NSButton, at: NSPoint? = nil, age: TimeInterval = 0, window: Int? = nil) throws -> NSEvent {
    let p = at ?? b.convert(NSPoint(x: b.bounds.midX, y: b.bounds.midY), to: nil)
    return try #require(
      NSEvent.mouseEvent(
        with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime - age, windowNumber: window ?? b.window?.windowNumber ?? 0,
        context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
  }

  @Test func onlyAFreshLeftMouseClickInsideTheButtonCountsAsAnAnswer() throws {
    _ = NSApplication.shared
    let panel = NeedsYouPopupController.makePanel(for: popup(item(idA)), onClick: { _ in }, onClose: {})
    let b = try #require(buttons(in: try content(panel)).first { $0.tag >= 0 })
    #expect(NeedsYouPopupView.isRealClick(try mouse(.leftMouseUp, on: b), on: b))
    #expect(NeedsYouPopupView.isRealClick(try mouse(.leftMouseDown, on: b), on: b), "the mouse-down of that click")
    #expect(!NeedsYouPopupView.isRealClick(nil, on: b), "an Accessibility press or AppleScript: no event")
    #expect(!NeedsYouPopupView.isRealClick(try mouse(.leftMouseUp, on: b, age: 5), on: b), "a stale event")
    #expect(!NeedsYouPopupView.isRealClick(try mouse(.rightMouseUp, on: b), on: b))
    #expect(!NeedsYouPopupView.isRealClick(try mouse(.mouseMoved, on: b), on: b))
    #expect(!NeedsYouPopupView.isRealClick(try mouse(.leftMouseUp, on: b, at: NSPoint(x: -50, y: -50)), on: b), "a click somewhere else")
    #expect(!NeedsYouPopupView.isRealClick(try mouse(.leftMouseUp, on: b, window: b.window!.windowNumber + 1), on: b), "a click in another window")
    let key = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: b.window?.windowNumber ?? 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
    #expect(!NeedsYouPopupView.isRealClick(key, on: b))
  }

  @Test func theButtonActionDoesNothingWithoutAClickEventAndAnswersWithOne() throws {
    _ = NSApplication.shared
    var clicked: [Int] = []
    var event: NSEvent?
    let panel = NeedsYouPopupController.makePanel(for: popup(item(idA)), onClick: { clicked.append($0) }, onClose: {}, currentEvent: { event })
    let b = try #require(buttons(in: try content(panel)).first { $0.tag == 1 })
    click(b)  // sendAction with no event: how an Accessibility press or an AppleScript click arrives
    #expect(clicked.isEmpty)
    event = try mouse(.rightMouseUp, on: b)
    click(b)
    #expect(clicked.isEmpty)
    event = try mouse(.leftMouseUp, on: b)
    click(b)
    #expect(clicked == [1])
  }

  @Test func theDefaultEventSourceIsTheAppsCurrentEventSoATestClickWithNoEventIsIgnored() throws {
    _ = NSApplication.shared
    var clicked: [Int] = []
    let panel = NeedsYouPopupController.makePanel(for: popup(item(idA)), onClick: { clicked.append($0) }, onClose: {})
    let b = try #require(buttons(in: try content(panel)).first { $0.tag == 0 })
    click(b)
    #expect(clicked.isEmpty, "NSApp.currentEvent is nil here, as it is for an Accessibility press")
  }

  /// Main's development-channels popup: Accept (the one that seals the launch) is answered only by a real mouse click. A program that presses
  /// the button (Accessibility, AppleScript) sends no mouse event, so nothing is asked, nothing is pressed, nothing is sealed.
  @Test func mainsAcceptButtonIsPressedOnlyByARealClick() throws {
    _ = NSApplication.shared
    let main = NeedsYouPopupItem(
      thread: Supervisor.mainPopupThread, threadName: "Main",
      dialog: DialogOffer(
        id: idA, kind: .devChannels, subject: "server:talos-app", options: ["I am using this for local development", "Exit"], cursor: 0, launch_changed: [],
        seen_at: "2026-11-07T10:00:00.000Z", expires_at: "2026-11-07T10:15:00.000Z"))
    var clicked: [Int] = []
    var event: NSEvent?
    let panel = NeedsYouPopupController.makePanel(for: popup(main), onClick: { clicked.append($0) }, onClose: {}, currentEvent: { event })
    let accept = try #require(buttons(in: try content(panel)).first { $0.tag == 0 })
    accept.performClick(nil)  // no mouse event: a scripted press
    click(accept)
    #expect(clicked.isEmpty, "a scripted press of Accept asked for nothing")
    event = try mouse(.leftMouseUp, on: accept)
    click(accept)
    #expect(clicked == [0], "the owner's click asks")
  }

  @Test func theLoginPopupHasOneButtonOpenInTerminals() throws {
    _ = NSApplication.shared
    let panel = NeedsYouPopupController.makePanel(for: popup(item(idA, kind: .login)), onClick: { _ in }, onClose: {})
    let answers = buttons(in: try content(panel)).filter { $0.tag >= 0 }
    #expect(answers.map(\.title) == ["Open in Terminals"])
  }

  @Test func aLabelWithAHiddenCharacterIsShownMarked() throws {
    _ = NSApplication.shared
    var i = item(idA)
    i.dialog.options = ["No, exit", "Yes\u{200B}, I trust this folder"]
    let panel = NeedsYouPopupController.makePanel(for: popup(i), onClick: { _ in }, onClose: {})
    #expect(buttons(in: try content(panel)).filter { $0.tag >= 0 }.map(\.title) == ["No, exit", "Yes⟦U+200B⟧, I trust this folder"])
  }

  @Test func aFailureReplacesTheButtonsWithTheWords() throws {
    _ = NSApplication.shared
    var p = popup(item(idA))
    p.phase = .failed("Already answered on Ada's iPhone")
    let panel = NeedsYouPopupController.makePanel(for: p, onClick: { _ in }, onClose: {})
    let v = try #require(panel.contentView)
    #expect(buttons(in: v).filter { $0.tag >= 0 }.isEmpty)
    func texts(_ v: NSView) -> [String] {
      var out: [String] = []
      for s in v.subviews {
        if let t = s as? NSTextField { out.append(t.stringValue) }
        out += texts(s)
      }
      return out
    }
    #expect(texts(v).contains("Already answered on Ada's iPhone"))
  }

  // MARK: the controller

  final class Box { var offers: [NeedsYouPopupItem] = []; var quiet: Bool? = false; var clock: Double = 1000; var asked = 0 }

  private func controller(_ b: Box) -> (NeedsYouPopupController, NeedsYouPopupCoordinator, Spy) {
    let c = NeedsYouPopupCoordinator(offers: { b.offers }, quiet: { b.quiet }, now: { b.clock }, answer: { _, _, _, _ in b.asked += 1 })
    let ctl = NeedsYouPopupController(coordinator: c)
    let spy = Spy()
    ctl.orderFront = {
      spy.fronted.append($0)
      spy.origins.append($0.frame.origin)
    }
    return (ctl, c, spy)
  }
  /// `orderFront` is replaced by this: it records which panels were put on the screen and where they stood at that moment, and shows nothing.
  final class Spy {
    var fronted: [NSPanel] = []
    var origins: [NSPoint] = []
  }

  @Test func aPanelPerPopupAtMostThreeStackedWithoutOverlapAndNeverShownByTheTest() {
    _ = NSApplication.shared
    let b = Box()
    b.offers = [item(idA, thread: "a", seen: "2026-11-07T10:00:01.000Z"), item(idB, thread: "b", seen: "2026-11-07T10:00:02.000Z"), item(idC, thread: "c", seen: "2026-11-07T10:00:03.000Z"), item(idD, thread: "d", seen: "2026-11-07T10:00:04.000Z")]
    let (ctl, _, spy) = controller(b)
    ctl.tick()
    #expect(Set(ctl.panels.keys) == [idA, idB, idC])
    #expect(spy.fronted.count == 3 && Set(spy.fronted.map { ObjectIdentifier($0) }) == Set(ctl.panels.values.map { ObjectIdentifier($0) }), "each panel was put on the screen once, by the spy")
    #expect(ctl.panels.values.allSatisfy { !$0.canBecomeKey && !$0.canBecomeMain })
    #expect(spy.origins.allSatisfy { $0 != .zero }, "a panel is placed before it is put on the screen: none flashes at the bottom left")
    #expect(Set(spy.origins.map(\.y)).count == 3)
    let frames = ctl.panels.values.map(\.frame)
    for (i, f) in frames.enumerated() { for g in frames[(i + 1)...] { #expect(!f.intersects(g), "stacked, not on top of each other") } }
    ctl.tick()
    #expect(spy.fronted.count == 3, "a popup is put on the screen once")
  }

  @Test func theWindowGoesWhenTheDialogGoesAndNotBeforeQuietEnds() {
    _ = NSApplication.shared
    let b = Box()
    b.offers = [item(idA)]
    b.quiet = true
    let (ctl, _, spy) = controller(b)
    ctl.tick()
    #expect(ctl.panels.isEmpty && spy.fronted.isEmpty, "quiet hours: no popup")
    b.quiet = false
    ctl.tick()
    #expect(Set(ctl.panels.keys) == [idA])
    b.offers = []
    ctl.tick()
    #expect(ctl.panels.isEmpty)
  }

  @Test func anUnknownQuietDecisionShowsThePopup() {
    _ = NSApplication.shared
    let b = Box()
    b.offers = [item(idA)]
    b.quiet = nil  // the bridge has not been read yet
    let (ctl, _, spy) = controller(b)
    ctl.tick()
    #expect(Set(ctl.panels.keys) == [idA] && spy.fronted.count == 1)
  }

  /// A popup that slides under the cursor (the one above it closed or grew) must not be answered by the click meant for what was there.
  @Test func aPanelThatMovesHasItsClickDelayRestarted() throws {
    _ = NSApplication.shared
    let b = Box()
    b.offers = [item(idA, thread: "a", seen: "2026-11-07T10:00:01.000Z"), item(idB, thread: "b", seen: "2026-11-07T10:00:02.000Z")]
    let (ctl, _, _) = controller(b)
    ctl.tick()
    let panelB = try #require(ctl.panels[idB])
    let yBefore = panelB.frame.origin.y
    let btn = try #require(buttons(in: try content(panelB)).first { $0.tag == 1 })
    var event: NSEvent?
    ctl.currentEvent = { event }
    b.clock += NeedsYouPopupCoordinator.clickDelay + 1
    b.offers = [item(idB, thread: "b", seen: "2026-11-07T10:00:02.000Z")]  // the popup above it is gone: this one moves up
    ctl.tick()
    #expect(ctl.panels[idB] === panelB && panelB.frame.origin.y != yBefore, "control: the same panel moved")
    event = NSEvent.mouseEvent(with: .leftMouseUp, location: btn.convert(NSPoint(x: btn.bounds.midX, y: btn.bounds.midY), to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panelB.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)
    click(btn)
    #expect(b.asked == 0, "it moved just now: the click was ignored")
    b.clock += NeedsYouPopupCoordinator.clickDelay + 0.1
    ctl.tick()
    click(btn)
    #expect(b.asked == 1)
  }

  // MARK: the live wiring

  final class FakeSource: NeedsYouPopupSource, @unchecked Sendable {
    private let lock = NSLock()
    private var _asked: [String] = []
    var asked: [String] { lock.withLock { _asked } }
    func popupOffers() -> [NeedsYouPopupItem] { [item(idA)] }
    func popupAnswer(thread: String, dialogId: String, action: NeedsYouPopupAction, completion: @escaping @Sendable (PopupAnswerResult) -> Void) {
      lock.withLock { _asked.append("\(thread)|\(dialogId)|\(action)") }
      // the worker queue: not the main thread
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { completion(.nothing(.screenChanged)) }
    }
  }

  /// Waits without holding the main actor, so the timer, the main queue and the tasks the app uses all run as they do in the app.
  private func until(_ timeout: TimeInterval, _ cond: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if cond() { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return cond()
  }

  private func texts(_ v: NSView) -> [String] {
    var out: [String] = []
    for s in v.subviews {
      if let t = s as? NSTextField { out.append(t.stringValue) }
      out += texts(s)
    }
    return out
  }

  @Test func theLiveWiringTicksByItselfAndAnAnswerComesBackToTheMainThread() async throws {
    _ = NSApplication.shared
    let source = FakeSource()
    let ctl = NeedsYouPopupController(source: source, quiet: { false }, interval: 0.05)
    defer { ctl.stop() }
    let spy = Spy()
    ctl.orderFront = { spy.fronted.append($0) }
    #expect(await until(5) { ctl.panels[idA] != nil }, "the timer never put the popup up")
    #expect(spy.fronted.count == 1)
    var event: NSEvent?
    ctl.currentEvent = { event }
    try await Task.sleep(for: .seconds(0.9))  // let the first moment pass (0.6 s, the real clock here)
    let panel = try #require(ctl.panels[idA])
    let btn = try #require(buttons(in: try content(panel)).first { $0.tag == 1 })
    event = NSEvent.mouseEvent(with: .leftMouseUp, location: btn.convert(NSPoint(x: btn.bounds.midX, y: btn.bounds.midY), to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)
    click(btn)
    #expect(await until(5) { source.asked.count == 1 })
    #expect(source.asked.first?.contains("garden|\(idA)|choose(1") == true, "\(source.asked)")
    #expect(await until(5) { ctl.panels[idA].flatMap { $0.contentView }.map { texts($0).contains { $0.hasPrefix("Nothing pressed") } } == true }, "the answer never reached the popup: \(ctl.panels[idA].flatMap { $0.contentView }.map { texts($0) } ?? [])")
  }

  @Test func theQuietDecisionIsTheStatusCoordinatorsAndUnknownShows() {
    _ = NSApplication.shared
    let sc = StatusCoordinator.shared
    let saved = sc.now
    defer { sc.now = saved; sc.setQuietForTest(nil) }
    let q = QuietWindow.read(Data(#"{"quiet_window":{"start":"20:30","end":"04:00"},"timezone":"Etc/GMT+7"}"#.utf8))
    sc.setQuietForTest(q)
    sc.now = { Date(timeIntervalSince1970: 1_793_462_400 + 13 * 3600) }  // 22:00 in the UTC-7 zone: inside the window
    #expect(NeedsYouPopupController.statusQuiet() == true)
    sc.now = { Date(timeIntervalSince1970: 1_793_462_400 + 20 * 3600) }  // 05:00, after the window
    #expect(NeedsYouPopupController.statusQuiet() == false)
  }

  @Test func aRenderOfEachPopupForTheEye() throws {
    _ = NSApplication.shared
    guard let dir = ProcessInfo.processInfo.environment["TALOS_POPUP_PNG_DIR"] else { return }
    for (name, i) in [("trust", item(idA)), ("mcp", item(idA, kind: .mcpConsent)), ("login", item(idA, kind: .login))] {
      let panel = NeedsYouPopupController.makePanel(for: popup(i), onClick: { _ in }, onClose: {})
      let v = try #require(panel.contentView)
      v.layoutSubtreeIfNeeded()
      let rep = try #require(v.bitmapImageRepForCachingDisplay(in: v.bounds))
      v.cacheDisplay(in: v.bounds, to: rep)
      try #require(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: dir + "/popup-\(name).png"))
    }
  }
}

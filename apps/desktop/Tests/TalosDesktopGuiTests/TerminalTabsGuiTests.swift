import AppKit
import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import WebKit
@testable import TalosDesktop

/// The Terminal screen's tabs in the Talos window: the embedded terminal follows the session the page names, on a private tmux
/// server (the shim `ReviewD2TerminalTests` uses), and the list and Resume reach the page. `-L talos` and the owner's workers
/// are never reached. Needs TALOS_GUI_TESTS=1.
extension GuiSerial {
@MainActor
@Suite("Terminal screen tabs (window)", .serialized, .enabled(if: guiTestsEnabled && FileManager.default.isExecutableFile(atPath: TmuxWorld.realTmux)))
struct TerminalTabsGuiTests {
  let room = TerminalViewRect(x: 240, y: 0, width: 900, height: 700)

  func file(_ states: [String: String]) -> WorkersFile {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-05T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    for (id, st) in states {
      var e = WorkersFile.Entry(threadId: id, cwd: "/home/alex/proj-\(id)")
      e.state = st
      f.threads[id] = e
    }
    return f
  }

  func threadSession(_ w: TmuxWorld, _ id: String) {
    let script = w.dir + "/\(id).sh"
    writeScript(script, "#!/bin/bash\nstty raw -echo\nprintf 'THREAD \(id) READY\\r\\n'\nexec cat >> '\(w.dir)/\(id).keys'\n")
    _ = w.tmux("new-session", "-d", "-s", "t-\(id)", "-x", "120", "-y", "40", "--", "/bin/bash", script)
  }

  func attachedSession(_ w: TmuxWorld) -> String { w.tmux("list-clients", "-F", "#{client_session}").trimmingCharacters(in: .whitespacesAndNewlines) }

  func switcher(_ w: TmuxWorld, workers: @escaping () -> WorkersFile, resumed: SpyBox? = nil) -> TerminalWindowController.SwitcherSource {
    .init(
      workers: workers, needsYou: { [:] }, names: { ["trip": "OC Test", "garden": "Garden", "p": "Parked one"] },
      attach: { SessionSwitcher.attachArgv(for: $0, tmux: TmuxWorld.root + "/bin/tmux", socket: w.sock, configPath: TmuxWorld.conf) },
      resume: { id in resumed?.resumed.append(id); return .asked })
  }

  /// A signed-in page in a web view that is in no window; the terminal is the real one reading the real (private) tmux.
  func page() -> (WebController, WKWebView) {
    let c = WebController()
    let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800), configuration: WKWebViewConfiguration())
    c.useWebViewForTest(wv, windowVisible: true)
    c.nativeMessage(.ready(signedIn: true, features: [WebController.tabsFeature]))
    return (c, wv)
  }

  @Test func theEmbeddedViewFollowsTheSessionThePageNamesAndNoSessionIsEverDetachedOrTyped() async throws {
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    threadSession(w, "garden")
    let f = file(["trip": "live", "garden": "live"])
    TerminalWindowController.shared.switcherSourceOverride = switcher(w, workers: { f })
    let (c, _) = page()
    defer { c.terminal.close() }
    c.nativeMessage(.terminalView(room, session: "main"))
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "agent" })
    c.nativeMessage(.terminalView(room, session: "trip"))
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "t-trip" }, "on \(attachedSession(w)), clients \(w.clients)")
    c.nativeMessage(.terminalView(room, session: "garden"))
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "t-garden" })
    c.nativeMessage(.terminalView(room, session: "main"))
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "agent" })
    let live = w.tmux("list-sessions", "-F", "#{session_name}").split(separator: "\n").sorted()
    #expect(live == ["agent", "t-garden", "t-trip"], "switching ended only our own clients")
    await w.run(0.5)
    #expect(w.keys.isEmpty, "nothing was typed into Main: \(w.keys.debugDescription)")
    for id in ["trip", "garden"] {
      let typed = (try? String(contentsOfFile: w.dir + "/\(id).keys", encoding: .isoLatin1)) ?? ""
      #expect(typed.isEmpty, "nothing was typed into \(id): \(typed.debugDescription)")
    }
  }

  @Test func aSessionThatIsNotInTheListAttachesNothingAndSaysSo() async throws {
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")  // a real session exists, but the list does not name it
    TerminalWindowController.shared.switcherSourceOverride = switcher(w, workers: { file([:]) })
    let (c, _) = page()
    defer { c.terminal.close() }
    c.nativeMessage(.terminalView(room, session: "trip"))
    await w.run(1.2)
    #expect(w.clients == 0, "not in workers.json, so not attached: the session name is never taken from the page")
    #expect(c.terminal.noteTextForTest == TerminalSessions.goneNote)
  }

  @Test func aParkedThreadClosesTheViewerAndTheLiveOneComesBack() async throws {
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    var f = file(["trip": "live"])
    TerminalWindowController.shared.switcherSourceOverride = switcher(w, workers: { f })
    let (c, _) = page()
    defer { c.terminal.close() }
    c.nativeMessage(.terminalView(room, session: "trip"))
    #expect(await w.until(5) { attachedSession(w) == "t-trip" })
    f.threads["trip"]?.state = "parked"
    #expect(await w.until(5) { w.clients == 0 }, "parked: our viewer ends, the page shows Resume")
    f.threads["trip"]?.state = "live"
    #expect(await w.until(6) { attachedSession(w) == "t-trip" })
  }

  @Test func theListReachesThePageOnlyWhenItCanReadItAndOnlyWhenItChanged() async throws {
    var f = file(["trip": "live", "p": "parked"])
    let c = WebController()
    c.useWebViewForTest(WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800)), windowVisible: true)
    c.terminalSessionSource = .init(
      snapshot: { (SessionSwitcher.entries(main: .init(state: .running, hasScreen: true), workers: f), f) }, resume: { _ in .asked })
    var sent: [[TerminalSessions.Item]] = []
    c.deliveredForTest = { if case .terminalSessions(let i) = $0 { sent.append(i) } }
    // an older page: no feature, nothing sent
    c.nativeMessage(.ready(signedIn: true, features: []))
    c.nativeMessage(.terminalView(room, session: "main"))
    #expect(sent.isEmpty)
    c.nativeMessage(.ready(signedIn: true, features: [WebController.tabsFeature]))
    #expect(sent.count == 1, "the page asked for the screen before it was ready: it is told as soon as it is")
    #expect(sent[0].map(\.id) == ["main", "p", "trip"] || sent[0].map(\.id) == ["main", "trip", "p"])
    c.pushTerminalSessions()
    #expect(sent.count == 1, "unchanged: not sent again")
    f.threads["trip"]?.state = "busy"
    c.pushTerminalSessions()
    #expect(sent.count == 2 && sent[1].first { $0.id == "trip" }?.state == "working")
    // the 1.5 s timer finds a change without anyone asking
    f.threads["trip"]?.state = "failed"
    let end = Date().addingTimeInterval(4)
    while sent.count < 3, Date() < end { try? await Task.sleep(nanoseconds: 100_000_000) }
    #expect(sent.count == 3 && sent[2].first { $0.id == "trip" }?.state == "failed")
    // signed out: the timer stops and the next signed-in page gets the whole list again
    #expect(c.terminalSessionsTimerRunningForTest)
    c.nativeMessage(.ready(signedIn: false, features: [WebController.tabsFeature]))
    #expect(!c.terminalSessionsTimerRunningForTest, "signing out stops the timer, not just the sending")
    f.threads["trip"]?.state = "live"
    try? await Task.sleep(nanoseconds: 2_200_000_000)
    #expect(sent.count == 3, "nothing is sent to a signed-out page")
    f.threads["trip"]?.state = "failed"  // the same list as the last one sent
    c.nativeMessage(.ready(signedIn: true, features: [WebController.tabsFeature]))
    #expect(sent.count == 4 && sent[3] == sent[2], "the next signed-in page gets the whole list again, changed or not")
    c.nativeMessage(.terminalView(nil, session: "main"))
  }

  @Test func resumeGoesThroughTheTerminalsWindowsRequestAndTellsThePageWhatHappened() {
    let f = file(["trip": "live", "p": "parked", "o": "off", "x": "failed"])
    let (c, _) = page()
    var asked: [String] = []
    c.terminalSessionSource = .init(
      snapshot: { (SessionSwitcher.entries(main: .init(state: .running, hasScreen: true), workers: f), f) },
      resume: { asked.append($0); return $0 == "o" ? .parkPending : .asked })
    var told: [(String, TerminalSessions.ResumeOutcome)] = []
    c.deliveredForTest = { if case .terminalResumeResult(let t, let o) = $0 { told.append((t, o)) } }
    c.nativeMessage(.terminalResume(threadId: "p"))
    c.nativeMessage(.terminalResume(threadId: "o"))
    #expect(asked == ["p", "o"])
    #expect(told.map(\.0) == ["p", "o"] && told.map(\.1) == [.asked, .parkPending])
    // refused: a running or failed session, Main, a thread that is not there. The page hears "failed", nothing is asked.
    for id in ["trip", "x", "main", "ghost"] { c.nativeMessage(.terminalResume(threadId: id)) }
    #expect(asked == ["p", "o"], "a press for a session that is not resumable asks nothing")
    #expect(told.suffix(4).map(\.1) == [.failed, .failed, .failed, .failed])
  }

  @Test func aSignedOutPageCannotResumeAnything() {
    let f = file(["p": "parked"])
    let c = WebController()
    c.useWebViewForTest(WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800)), windowVisible: true)
    var asked: [String] = []
    c.terminalSessionSource = .init(
      snapshot: { (SessionSwitcher.entries(main: .init(state: .running, hasScreen: true), workers: f), f) },
      resume: { asked.append($0); return .asked })
    c.nativeMessage(.ready(signedIn: false, features: [WebController.tabsFeature]))
    c.nativeMessage(.terminalResume(threadId: "p"))
    #expect(asked.isEmpty)
  }

  // MARK: review round 1

  /// A signed-in page whose list comes from `f`, with a real window that holds the web view.
  func tabsPage(_ f: @escaping () -> WorkersFile) -> (WebController, WKWebView, WebNSWindow, [TerminalSessions.Item]) {
    let c = WebController()
    let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800), configuration: WKWebViewConfiguration())
    let w = WebNSWindow(contentRect: wv.frame, styleMask: [.titled], backing: .buffered, defer: true)
    w.contentView = wv
    c.useWebViewForTest(wv, windowVisible: true, window: w)
    c.terminalSessionSource = .init(
      snapshot: { (SessionSwitcher.entries(main: .init(state: .running, hasScreen: true), workers: f(), names: ["trip": "OC Test", "garden": "Garden", "p": "Parked one"]), f()) },
      resume: { _ in .asked })
    c.nativeMessage(.ready(signedIn: true, features: [WebController.tabsFeature]))
    return (c, wv, w, [])
  }

  @Test func theListKeepsFollowingWhileAPanelStandsInPlaceOfTheTerminal() async throws {
    // R1-1: a parked tab makes the page send a null room. That is "no terminal to show", not "left the screen".
    var f = file(["p": "parked", "trip": "live"])
    let (c, _, _, _) = tabsPage { f }
    var sent: [[TerminalSessions.Item]] = []
    c.deliveredForTest = { if case .terminalSessions(let i) = $0 { sent.append(i) } }
    c.nativeMessage(.terminalView(room, session: "main"))
    c.nativeMessage(.terminalView(nil, session: "p"))  // the owner picked the parked tab: Resume panel, no native view
    #expect(c.terminalSessionsTimerRunningForTest, "a null room does not stop the list")
    c.nativeMessage(.terminalResume(threadId: "p"))
    f.threads["p"]?.state = "starting"
    func state(_ id: String) -> String? { sent.last?.first { $0.id == id }?.state }
    let end1 = Date().addingTimeInterval(5)
    while state("p") != "starting", Date() < end1 { try? await Task.sleep(nanoseconds: 100_000_000) }
    #expect(state("p") == "starting", "the tab follows the session after Resume: \(String(describing: state("p")))")
    f.threads["p"]?.state = "live"
    f.threads["trip"]?.state = "busy"
    let end2 = Date().addingTimeInterval(5)
    while state("p") != "idle", Date() < end2 { try? await Task.sleep(nanoseconds: 100_000_000) }
    #expect(state("p") == "idle" && state("trip") == "working", "and every other tab keeps moving too")
    c.nativeMessage(.terminalLeave)
    #expect(!c.terminalSessionsTimerRunningForTest, "only terminal_leave stops it")
    c.nativeMessage(.terminalView(nil, session: "main"))
    #expect(c.terminalSessionsTimerRunningForTest, "a view message after leaving (the screen opened again) starts it again")
    c.nativeMessage(.terminalLeave)
  }

  func keyEvent(_ window: NSWindow, chars: String, ignoring: String, code: UInt16, flags: NSEvent.ModifierFlags) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: window.windowNumber, context: nil,
      characters: chars, charactersIgnoringModifiers: ignoring, isARepeat: false, keyCode: code)!
  }

  @Test func controlDigitInTheNativeTerminalSwitchesTheTabAndNoByteReachesAnySession() async throws {
    // R1-2: Ctrl+3 is ESC and Ctrl+8 is DEL to a terminal: typed into Claude they interrupt a turn or eat a character.
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    threadSession(w, "garden")
    let f = file(["trip": "live", "garden": "live"])
    TerminalWindowController.shared.switcherSourceOverride = switcher(w, workers: { f })
    let (c, _, win, _) = tabsPage { f }
    var told: [String] = []
    c.deliveredForTest = { if case .terminalSelect(let s) = $0 { told.append(s) } }
    defer { c.terminal.close() }
    c.nativeMessage(.terminalView(room, session: "main"))
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "agent" })
    c.pushTerminalSessions()
    let viewer = try #require(c.terminal.viewerForTest)
    _ = win.makeFirstResponder(viewer)
    #expect(win.firstResponder === viewer)
    await w.run(0.6)
    // control: a Ctrl key that is not ours goes to the session untouched, so the assertions below can fail
    win.sendEvent(keyEvent(win, chars: "\u{01}", ignoring: "a", code: 0, flags: .control))
    #expect(await w.until(3) { w.keys.contains("\u{01}") }, "Ctrl+A reached the pane: \(w.keys.debugDescription)")
    let before = w.keys
    // Ctrl+3 is the third tab (Main, Garden, OC Test): the view switches, the page is told, nothing is typed
    win.sendEvent(keyEvent(win, chars: "\u{1B}", ignoring: "3", code: 20, flags: .control))
    #expect(c.terminal.session == "trip")
    #expect(told == ["trip"])
    win.sendEvent(keyEvent(win, chars: "\u{7F}", ignoring: "8", code: 28, flags: .control))  // no tab 8: still not typed
    #expect(told == ["trip"], "a number with no tab does nothing")
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "t-trip" })
    await w.run(0.8)
    #expect(w.keys == before, "nothing new reached Main: \(w.keys.debugDescription)")
    for id in ["trip", "garden"] {
      let typed = (try? String(contentsOfFile: w.dir + "/\(id).keys", encoding: .isoLatin1)) ?? ""
      #expect(typed.isEmpty, "nothing reached \(id): \(typed.debugDescription)")
    }
    // other chords with the Ctrl key are not ours: Ctrl+Shift+3 and Cmd+3 go on
    #expect(!c.interceptKey(keyEvent(win, chars: "3", ignoring: "3", code: 20, flags: [.control, .shift])))
    #expect(!c.interceptKey(keyEvent(win, chars: "3", ignoring: "3", code: 20, flags: [.command])))
  }

  @Test func controlDigitIsLeftToTheTerminalWhenNoTabsShowOrAnotherViewHasTheKeyboard() async throws {
    let f = file(["trip": "live"])
    let (c, wv, win, _) = tabsPage { f }
    let stop = EmbeddedTerminal.Source(host: { .none }, configured: { true }, hasLiveChild: { false }, sessionExists: { false })
    c.terminal.source = stop
    c.nativeMessage(.terminalView(room, session: "main"))
    defer { c.terminal.close() }
    let ctrl3 = keyEvent(win, chars: "\u{1B}", ignoring: "3", code: 20, flags: .control)
    #expect(!c.interceptKey(ctrl3), "no list sent yet: no tabs")
    c.pushTerminalSessions()
    #expect(!c.interceptKey(ctrl3), "tabs, but the terminal does not hold the keyboard (the page does)")
    let field = NSTextField(frame: CGRect(x: 0, y: 0, width: 100, height: 20))
    wv.addSubview(field)
    _ = win.makeFirstResponder(field)
    #expect(!c.interceptKey(ctrl3))
  }

  @Test func aSendThatWentNowhereIsTriedAgainNotTakenForDone() {
    // R1-3: the list is remembered as sent only when it was handed to a page
    let f = file(["trip": "live"])
    let c = WebController()
    c.windowVisibleForTest = true  // visible, but no web view yet
    c.terminalSessionSource = .init(
      snapshot: { (SessionSwitcher.entries(main: .init(state: .running, hasScreen: true), workers: f), f) }, resume: { _ in .asked })
    var sent = 0
    c.deliveredForTest = { if case .terminalSessions = $0 { sent += 1 } }
    c.nativeMessage(.ready(signedIn: true, features: [WebController.tabsFeature]))
    c.pushTerminalSessions()
    #expect(sent == 0)
    c.useWebViewForTest(WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800)), windowVisible: true)
    c.pushTerminalSessions()
    #expect(sent == 1, "the page that could not be reached did not use up the send")
  }

  @Test func theAgentSessionIsNeverLookedForOnTheMainThreadInTheListPath() async {
    // R1-6
    final class Box: @unchecked Sendable {
      private let lock = NSLock()
      private var _started = false, _release = false, _onMain: Bool?
      var started: Bool { lock.withLock { _started } }
      var release: Bool { get { lock.withLock { _release } } set { lock.withLock { _release = newValue } } }
      var onMain: Bool? { lock.withLock { _onMain } }
      func begin() { lock.withLock { _onMain = Thread.isMainThread; _started = true } }
    }
    let box = Box()
    let c = TerminalWindowController.shared
    c.resetProbeForTest()
    c.sessionProbeOverride = {
      box.begin()
      while !box.release, !Thread.isMainThread { usleep(10_000) }
      return true
    }
    defer { box.release = true; c.sessionProbeOverride = nil; c.resetProbeForTest() }
    let t0 = Date()
    #expect(c.cachedAgentSessionExists() == false, "no answer yet, and no waiting for one")
    #expect(Date().timeIntervalSince(t0) < 0.5)
    let end0 = Date().addingTimeInterval(3)
    while !box.started, Date() < end0 { try? await Task.sleep(nanoseconds: 20_000_000) }
    #expect(box.started)
    #expect(box.onMain == false, "tmux is asked on a background thread")
    let t1 = Date()
    #expect(c.cachedAgentSessionExists() == false, "still probing: the main thread is not blocked")
    #expect(Date().timeIntervalSince(t1) < 0.5)
    box.release = true
    var answer = false
    let end = Date().addingTimeInterval(3)
    while !answer, Date() < end { try? await Task.sleep(nanoseconds: 50_000_000); answer = c.cachedAgentSessionExists() }
    #expect(answer, "the probe's answer is used once it is in")
  }

  // MARK: review round 2

  /// Digit-row key codes 1…9 and keypad key codes 1…9 (what the hardware sends, whatever the layout prints on the key).
  let digitRow: [UInt16] = [18, 19, 20, 21, 23, 22, 26, 28, 25]
  let keypad: [UInt16] = [83, 84, 85, 86, 87, 88, 89, 91, 92]

  @Test func oneRuleDecidesWhatIsAControlDigit() {
    let w = NSWindow()
    func digit(_ code: UInt16, _ flags: NSEvent.ModifierFlags, ignoring: String = "x") -> Int? {
      EmbeddedTerminal.controlDigit(keyEvent(w, chars: "\u{1B}", ignoring: ignoring, code: code, flags: flags))
    }
    for n in 1...9 {
      #expect(digit(digitRow[n - 1], .control) == n, "digit row \(n)")
      #expect(digit(keypad[n - 1], [.control, .numericPad]) == n, "keypad \(n)")
      #expect(digit(digitRow[n - 1], [.control, .capsLock]) == n, "Caps Lock on, \(n)")
      #expect(digit(keypad[n - 1], [.control, .numericPad, .capsLock]) == n, "keypad with Caps Lock, \(n)")
    }
    // a layout that prints something else on the digit row (French: "é" where US has 2) is the same physical key
    #expect(digit(19, .control, ignoring: "é") == 2)
    #expect(digit(19, .control, ignoring: "\"") == 2)
    // not ours: any other modifier, no Ctrl, other keys, even one whose character is a digit
    #expect(digit(20, [.control, .shift]) == nil)
    #expect(digit(20, [.control, .option]) == nil)
    #expect(digit(20, [.control, .command]) == nil)
    #expect(digit(20, []) == nil)
    #expect(digit(20, [.capsLock]) == nil)
    #expect(digit(0, .control, ignoring: "3") == nil, "the key is decided by position, not by the character")
    #expect(digit(29, .control) == nil, "0 is not a tab")
    #expect(digit(82, [.control, .numericPad]) == nil, "keypad 0 is not a tab")
  }

  @Test func afterACommandDigitSwitchTheNewTerminalHasTheKeyboardSoTypingAndTheNextSwitchWork() async throws {
    // R2-1
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    threadSession(w, "garden")
    let f = file(["trip": "live", "garden": "live"])
    TerminalWindowController.shared.switcherSourceOverride = switcher(w, workers: { f })
    let (c, _, win, _) = tabsPage { f }
    var told: [String] = []
    c.deliveredForTest = { if case .terminalSelect(let s) = $0 { told.append(s) } }
    defer { c.terminal.close() }
    c.nativeMessage(.terminalView(room, session: "main"))
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "agent" })
    c.pushTerminalSessions()
    _ = win.makeFirstResponder(try #require(c.terminal.viewerForTest))
    await w.run(0.5)
    func typed(_ id: String) -> String { (try? String(contentsOfFile: w.dir + "/\(id).keys", encoding: .isoLatin1)) ?? "" }
    // Ctrl+3 (Main, Garden, OC Test): the third tab
    win.sendEvent(keyEvent(win, chars: "\u{1B}", ignoring: "3", code: 20, flags: .control))
    #expect(await w.until(5) { attachedSession(w) == "t-trip" && c.terminal.viewerForTest != nil })
    #expect(win.firstResponder === c.terminal.viewerForTest, "the new viewer has the keyboard, not the window: \(String(describing: win.firstResponder))")
    await w.run(0.6)
    win.sendEvent(keyEvent(win, chars: "x", ignoring: "x", code: 7, flags: []))
    #expect(await w.until(3) { typed("trip").contains("x") }, "(a) typing reached the new pane: \(typed("trip").debugDescription)")
    // (b) a second Ctrl+digit works, from the keypad and with Caps Lock on, which are the same tabs
    win.sendEvent(keyEvent(win, chars: "\u{1B}", ignoring: "2", code: keypad[1], flags: [.control, .numericPad, .capsLock]))
    #expect(c.terminal.session == "garden")
    #expect(await w.until(5) { attachedSession(w) == "t-garden" })
    #expect(win.firstResponder === c.terminal.viewerForTest)
    await w.run(0.6)
    win.sendEvent(keyEvent(win, chars: "\u{1B}", ignoring: "1", code: digitRow[0], flags: [.control, .capsLock]))
    #expect(c.terminal.session == "main")
    #expect(await w.until(5) { attachedSession(w) == "agent" })
    #expect(told == ["trip", "garden", "main"])
    // none of those chords, in any variant, put a byte into any pane
    await w.run(0.6)
    for id in ["trip", "garden"] { #expect(typed(id) == (id == "trip" ? "x" : ""), "\(id): \(typed(id).debugDescription)") }
    #expect(!w.keys.contains("\u{1B}") && !w.keys.contains("1"), "Main: \(w.keys.debugDescription)")
    // Ctrl+Shift+3 is not ours: it goes to the terminal like any other key
    #expect(!c.interceptKey(keyEvent(win, chars: "#", ignoring: "3", code: 20, flags: [.control, .shift])))
  }

  @Test func aSwitchToATabWithNoTerminalHandsTheKeyboardBackToThePageNotToTheWindow() async throws {
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    var f = file(["trip": "live", "garden": "parked"])
    TerminalWindowController.shared.switcherSourceOverride = switcher(w, workers: { f })
    let (c, wv, win, _) = tabsPage { f }
    defer { c.terminal.close() }
    c.nativeMessage(.terminalView(room, session: "main"))
    #expect(await w.until(5) { w.clients == 1 })
    c.pushTerminalSessions()
    _ = win.makeFirstResponder(try #require(c.terminal.viewerForTest))
    win.sendEvent(keyEvent(win, chars: "\u{1B}", ignoring: "2", code: digitRow[1], flags: .control))  // Garden: parked
    c.nativeMessage(.terminalView(nil, session: "garden"))  // the page shows Resume and closes the view
    #expect(c.terminal.session == "garden")
    #expect(!(win.firstResponder === win), "the window itself must not be left holding the keyboard")
    #expect(win.firstResponder === wv, "the page has it, so its own keys (the tab strip) work")
    f.threads["garden"]?.state = "live"
  }

  // MARK: wiring (the installed app showed no tabs)

  @Test func theRealLiveSourceListsTheWorkersOfAnAppWhoseTerminalsWindowWasNeverOpened() async throws {
    // No override anywhere: the controller reads the real SupervisorController (private tmux shim, temp HOME) the way the app does.
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    TerminalWindowController.shared.switcherSourceOverride = nil
    let mgr = try #require(w.model.workers, "the model has a worker manager on tmux")
    let parked = file(["p": "parked"])
    try FileManager.default.createDirectory(atPath: mgr.options.talosHome, withIntermediateDirectories: true)
    try parked.encoded().write(to: URL(fileURLWithPath: mgr.options.talosHome + "/workers.json"))
    mgr.startTicking()
    defer { mgr.detach() }
    await w.run(0.6)
    #expect(mgr.snapshot().threads["p"]?.state == "parked", "the worker file was adopted")
    // a fresh launch: the Terminals window was never opened, so it was never attached to anything
    TerminalWindowController.shared.detachForTest()
    let c = WebController()
    let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800), configuration: WKWebViewConfiguration())
    c.useWebViewForTest(wv, windowVisible: true)
    var lists: [[TerminalSessions.Item]] = []
    c.deliveredForTest = { if case .terminalSessions(let i) = $0 { lists.append(i) } }
    defer { c.nativeMessage(.terminalLeave); c.terminal.close() }
    c.nativeMessage(.ready(signedIn: true, features: [WebController.tabsFeature]))
    c.nativeMessage(.terminalView(room, session: "main"))  // the page opened the Terminal screen; terminalSessionSource is the real one
    let end = Date().addingTimeInterval(6)
    while lists.isEmpty, Date() < end { await w.run(0.2) }
    let items = try #require(lists.last, "the page got no terminal_sessions at all")
    #expect(items.map(\.id) == ["main", "p"])
    #expect(items.first { $0.id == "p" }?.panel == "resume")
    // and the embedded view itself attached to Main through the same real source
    #expect(await w.until(6) { w.clients == 1 && attachedSession(w) == "agent" })
  }

  @Test func aListThatBecomesAvailableAfterThePageIsOnTheScreenStillArrives() async throws {
    var f: WorkersFile?
    let c = WebController()
    c.useWebViewForTest(WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800)), windowVisible: true)
    c.terminalSessionSource = .init(
      snapshot: { f.map { (SessionSwitcher.entries(main: .init(state: .running, hasScreen: true), workers: $0), $0) } },
      resume: { _ in .asked })
    var sent = 0
    c.deliveredForTest = { if case .terminalSessions = $0 { sent += 1 } }
    defer { c.nativeMessage(.terminalLeave) }
    c.nativeMessage(.ready(signedIn: true, features: [WebController.tabsFeature]))
    c.nativeMessage(.terminalView(room, session: "main"))  // no model yet: nothing to send
    #expect(sent == 0)
    #expect(c.terminalSessionsTimerRunningForTest, "it keeps looking")
    f = file(["p": "parked"])  // the model arrives
    let end = Date().addingTimeInterval(5)
    while sent == 0, Date() < end { try? await Task.sleep(nanoseconds: 100_000_000) }
    #expect(sent == 1)
  }

  @Test func theDiagnosticLogsOneLineOnlyWhenTheStateChangesAndNeverAThreadNameOrId() throws {
    let logFile = NSTemporaryDirectory() + "talos-desktop-log-\(UUID().uuidString.prefix(8)).log"
    DesktopLog.pathOverride = logFile
    DesktopLog.resetForTest()
    defer { DesktopLog.pathOverride = nil; try? FileManager.default.removeItem(atPath: logFile) }
    var f: WorkersFile? = nil
    let c = WebController()
    c.useWebViewForTest(WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800)), windowVisible: true)
    c.terminalSessionSource = .init(
      snapshot: { f.map { (SessionSwitcher.entries(main: .init(state: .running, hasScreen: true), workers: $0, names: ["secretthread": "Secret Name"]), $0) } },
      resume: { _ in .asked })
    func lines() -> [String] { ((try? String(contentsOfFile: logFile, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init) }
    c.pushTerminalSessions()  // page not ready
    c.pushTerminalSessions()
    #expect(lines().count == 1, "the same state twice is one line")
    #expect(lines()[0].hasSuffix("terminal-tabs: pageReady=false signedIn=false feature=false visible=true snapshot=unchecked sent=skip"))
    c.nativeMessage(.ready(signedIn: true, features: [WebController.tabsFeature]))
    c.pushTerminalSessions()  // everything holds but the model is not there
    #expect(lines().last?.hasSuffix("pageReady=true signedIn=true feature=true visible=true snapshot=nil sent=skip") == true)
    f = file(["secretthread": "live"])
    c.pushTerminalSessions()
    #expect(lines().last?.hasSuffix("snapshot=2 entries sent=2") == true)
    let before = lines().count
    c.pushTerminalSessions()  // nothing changed
    #expect(lines().count == before)
    let all = lines().joined(separator: "\n")
    #expect(!all.contains("secretthread") && !all.contains("Secret") && !all.contains("main"), "counts only")
    #expect(lines().allSatisfy { $0.range(of: #"^\d{4}-\d\d-\d\dT[\d:]+Z terminal-tabs: "#, options: .regularExpression) != nil })
  }
}
}

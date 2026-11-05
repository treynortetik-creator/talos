import AppKit
import Foundation
import Testing
import SwiftTerm
import TalosDesktopCore
@testable import TalosDesktop

/// The agent terminal inside the main window. No window, no supervisor and no tmux server of ours: the view is handed the
/// facts and a command to run, and is never put in a window. Needs TALOS_GUI_TESTS=1.
/// A window that is never shown, counts as the key window, and records every request for the keyboard.
final class KeyWindowSpy: NSWindow {
  var asked: [NSResponder?] = []
  override var isKeyWindow: Bool { true }
  override func makeFirstResponder(_ r: NSResponder?) -> Bool {
    asked.append(r)
    return true
  }
}

@MainActor
@Suite("Embedded terminal", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct EmbeddedTerminalGuiTests {
  final class Facts {
    var host: EmbeddedTerminal.Host = .none
    var configured = true
    var live = false
    var sessionExists = false
    var source: EmbeddedTerminal.Source {
      .init(host: { self.host }, configured: { self.configured }, hasLiveChild: { self.live }, sessionExists: { self.sessionExists })
    }
  }

  func scratch() -> String {
    let d = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-emb-\(UUID().uuidString.prefix(8))")
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
  }

  func waitFor(_ cond: () -> Bool, seconds: Double = 8) async {
    let end = Date().addingTimeInterval(seconds)
    while !cond(), Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
  }

  /// A viewer that writes its pid where the test can read it, then waits.
  func viewerCommand(_ pidFile: String) -> [String] { ["/bin/sh", "-c", "echo $$ > '\(pidFile)'; exec /bin/sleep 60"] }

  func pid(_ file: String) -> Int32? { (try? String(contentsOfFile: file, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) } }

  func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

  func open(_ t: EmbeddedTerminal, in host: NSView, frame: CGRect = CGRect(x: 240, y: 0, width: 700, height: 600)) { t.show(in: host, frame: frame) }

  @Test func whileTheAgentIsStartingItSaysSoAndAttachesOnceTheSessionExists() async {
    let facts = Facts()
    facts.host = .tmux(attach: viewerCommand(scratch() + "/pid"))
    let t = EmbeddedTerminal()
    t.source = facts.source
    let host = NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
    open(t, in: host)
    #expect(t.noteTextForTest == "No agent session yet. Menu → Start session.")
    #expect(!t.hasViewerForTest)
    facts.sessionExists = true
    t.tick()
    #expect(t.hasViewerForTest)
    #expect(t.noteTextForTest == nil)
    t.close()
  }

  @Test func aNotSetUpMacSaysSoInsteadOfShowingABlankView() {
    let facts = Facts()
    facts.host = .tmux(attach: ["/bin/sleep", "60"])
    facts.configured = false
    let t = EmbeddedTerminal()
    t.source = facts.source
    open(t, in: NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700)))
    #expect(t.noteTextForTest == "Talos isn't set up yet. Menu → Setup checklist…")
    t.close()
  }

  @Test func aMacWithoutTmuxPointsToShowTerminalAndStartsNothing() {
    let facts = Facts()
    facts.host = .noTmux
    let t = EmbeddedTerminal()
    t.source = facts.source
    open(t, in: NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700)))
    #expect(t.noteTextForTest == EmbeddedTerminal.noTmuxNote)
    #expect(!t.hasViewerForTest)
    t.close()
  }

  @Test func whenTheSessionIsGoneTheViewerGoesAndTheNoteReturns() async {
    let facts = Facts()
    facts.host = .tmux(attach: ["/bin/sh", "-c", "exit 0"])
    facts.sessionExists = true
    let t = EmbeddedTerminal()
    t.source = facts.source
    open(t, in: NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700)))
    #expect(t.hasViewerForTest)
    await waitFor { !t.viewerIsRunningForTest }
    facts.sessionExists = false
    t.tick()
    #expect(!t.hasViewerForTest, "a viewer that ended is not left as a frozen screen")
    #expect(t.noteTextForTest == "No agent session yet. Menu → Start session.")
    t.close()
  }

  @Test func movingItKeepsTheSameViewerAndClosingEndsOnlyOurViewer() async {
    let dir = scratch()
    let facts = Facts()
    facts.host = .tmux(attach: viewerCommand(dir + "/pid"))
    facts.sessionExists = true
    let t = EmbeddedTerminal()
    t.source = facts.source
    let host = NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
    open(t, in: host)
    await waitFor { pid(dir + "/pid") != nil }
    let viewerPid = pid(dir + "/pid")
    #expect(viewerPid != nil)
    open(t, in: host, frame: CGRect(x: 68, y: 0, width: 900, height: 600))
    #expect(t.container.frame == CGRect(x: 68, y: 0, width: 900, height: 600), "a resize moves the view")
    #expect(t.container.superview === host)
    #expect(pid(dir + "/pid") == viewerPid, "and does not start another viewer")
    t.close()
    #expect(t.container.superview == nil)
    #expect(!t.isOpen)
    if let viewerPid { await waitFor { !alive(viewerPid) }; #expect(!alive(viewerPid), "our own attach child ended") }
  }

  func spyWindow(holding host: NSView) -> KeyWindowSpy {
    let w = KeyWindowSpy(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: true)
    w.contentView = host
    return w
  }

  @Test func aRoomTheMessageAsksForNeverTakesTheKeyboardEvenInTheKeyWindow() {
    let facts = Facts()
    facts.host = .tmux(attach: ["/bin/sleep", "60"])
    facts.sessionExists = true
    let t = EmbeddedTerminal()
    t.source = facts.source
    let host = NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
    let window = spyWindow(holding: host)
    open(t, in: host)
    #expect(t.hasViewerForTest)
    t.tick()
    open(t, in: host, frame: CGRect(x: 68, y: 0, width: 900, height: 600))
    #expect(window.asked.isEmpty, "a page that could move the owner's typing into the agent could type for them")
    t.close()
  }

  @Test func aClickInTheViewGivesItTheKeyboard() throws {
    let facts = Facts()
    facts.host = .tmux(attach: ["/bin/sleep", "60"])
    facts.sessionExists = true
    let t = EmbeddedTerminal()
    t.source = facts.source
    let host = NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
    let window = spyWindow(holding: host)
    open(t, in: host)
    let viewer = try #require(t.viewerForTest)
    let click = try #require(
      NSEvent.mouseEvent(
        with: .leftMouseDown, location: NSPoint(x: 20, y: 20), modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
        context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
    viewer.mouseDown(with: click)
    #expect(window.asked.contains { $0 === viewer })
    t.close()
  }

  /// Remembers the columns and rows a viewer reports when its frame changes.
  final class SizeRecorder: NSObject, LocalProcessTerminalViewDelegate {
    var cols = 0
    var rows = 0
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) { cols = newCols; rows = newRows }
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func processTerminated(source: TerminalView, exitCode: Int32?) {}
  }

  func cells(inFrameOf size: CGSize) -> (cols: Int, rows: Int) {
    let big = SafeTerminalView(frame: CGRect(x: 0, y: 0, width: 1400, height: 900))
    let rec = SizeRecorder()
    big.processDelegate = rec
    big.setFrameSize(size)
    return (rec.cols, rec.rows)
  }

  @Test func theSmallestRoomHoldsEightyByTwentyFourCellsAndNotMuchMore() {
    let min = EmbeddedTerminal.minimumSize
    let at = cells(inFrameOf: min)
    #expect(at.cols >= TerminalViewRect.minColumns)
    #expect(at.rows >= TerminalViewRect.minRows)
    let narrow = cells(inFrameOf: CGSize(width: min.width - 20, height: min.height))
    #expect(narrow.cols < TerminalViewRect.minColumns, "the minimum is measured, not padded")
  }
}

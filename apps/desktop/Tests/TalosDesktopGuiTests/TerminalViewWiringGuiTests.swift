import AppKit
import Foundation
import Testing
import TalosDesktopCore
import WebKit
@testable import TalosDesktop

/// What the Talos window does with the terminal room the page asks for: when the view opens and when it must close. The web
/// view is in no window and no window is ever shown, so nothing appears on screen. Needs TALOS_GUI_TESTS=1.
@MainActor
@Suite("Terminal view and the web window", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct TerminalViewWiringGuiTests {
  let room = TerminalViewRect(x: 240, y: 0, width: 900, height: 700)

  /// A controller whose view is an 1200 x 800 web view in no window. The terminal has no supervisor: it shows a note.
  func make(visible: Bool = true) -> (WebController, WKWebView) {
    let c = WebController()
    let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800), configuration: WKWebViewConfiguration())
    c.useWebViewForTest(wv, windowVisible: visible)
    return (c, wv)
  }

  func opened(visible: Bool = true) -> (WebController, WKWebView) {
    let (c, wv) = make(visible: visible)
    c.nativeMessage(.ready(signedIn: true, features: []))
    c.nativeMessage(.terminalView(room))
    return (c, wv)
  }

  @Test func opensForASignedInPageThatAskedAndSitsInsideTheWebView() {
    let (c, wv) = opened()
    #expect(c.terminal.isOpen)
    #expect(c.terminal.container.superview === wv)
  }

  @Test func aPageThatAsksBeforeItIsReadyOrSignedInOpensNothingUntilItIs() {
    let (c, _) = make()
    c.nativeMessage(.terminalView(room))
    #expect(!c.terminal.isOpen, "not ready yet")
    c.nativeMessage(.ready(signedIn: false, features: []))
    #expect(!c.terminal.isOpen, "ready but not signed in")
    c.nativeMessage(.ready(signedIn: true, features: []))
    #expect(c.terminal.isOpen, "signed in, and the room it asked for is still its latest word")
  }

  @Test func signingOutClosesIt() {
    let (c, _) = opened()
    c.nativeMessage(.ready(signedIn: false, features: []))
    #expect(!c.terminal.isOpen)
  }

  @Test func leavingTheTerminalScreenClosesIt() {
    let (c, _) = opened()
    c.nativeMessage(.terminalView(nil))
    #expect(!c.terminal.isOpen)
  }

  @Test func aNewDocumentClosesItAndForgetsTheRoomTheOldPageAskedFor() {
    let (c, wv) = opened()
    c.webView(wv, didCommit: nil)
    #expect(!c.terminal.isOpen)
    #expect(c.terminalRect == nil)
    // the new page signs in without asking again: the old page's room must not come back
    c.nativeMessage(.ready(signedIn: true, features: []))
    #expect(!c.terminal.isOpen)
  }

  @Test func hidingTheWindowClosesItAndKeepsTheRoom() {
    let (c, _) = opened()
    _ = c.windowShouldClose(NSWindow())
    #expect(!c.terminal.isOpen)
    #expect(c.terminalRect == room, "the room is kept for when the window is shown again")
    c.nativeMessage(.terminalView(room))  // the page's next report, or the window shown again
    #expect(c.terminal.isOpen)
  }

  @Test func aWindowThatIsNotOnScreenOpensNothing() {
    let (c, _) = opened(visible: false)
    #expect(!c.terminal.isOpen)
  }

  @Test func shrinkingTheWindowCutsTheViewToTheWindowAndClosesItBelowTheSmallestRoom() {
    let (c, wv) = opened()
    wv.setFrameSize(NSSize(width: 1000, height: 800))
    c.windowDidResize(Notification(name: NSWindow.didResizeNotification))
    #expect(c.terminal.container.frame.maxX <= 1000, "cut to what the window has left")
    // 80 columns of any monospaced font a terminal would use are at least 560 points wide and 24 rows 288 high
    #expect(EmbeddedTerminal.minimumSize.width >= 560 && EmbeddedTerminal.minimumSize.height >= 288)
    // the room starts at x = 240: leave exactly the viewer's own minimum, then one point less
    let enough = 240 + EmbeddedTerminal.minimumSize.width.rounded(.up)
    wv.setFrameSize(NSSize(width: enough, height: 800))
    c.windowDidResize(Notification(name: NSWindow.didResizeNotification))
    #expect(c.terminal.isOpen, "80 columns still fit")
    wv.setFrameSize(NSSize(width: enough - 1, height: 800))
    c.windowDidResize(Notification(name: NSWindow.didResizeNotification))
    #expect(!c.terminal.isOpen, "one point under 80 columns: the agent's screen would be squeezed")
  }

  @Test func neitherOpeningNorClosingNorResizingEverAsksForTheKeyboard() {
    let c = WebController()
    let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800), configuration: WKWebViewConfiguration())
    let window = KeyWindowSpy(contentRect: wv.frame, styleMask: [.titled], backing: .buffered, defer: true)
    window.contentView = wv
    c.useWebViewForTest(wv, windowVisible: true, window: window)
    c.nativeMessage(.ready(signedIn: true, features: []))
    c.nativeMessage(.terminalView(room))
    #expect(c.terminal.isOpen)
    wv.setFrameSize(NSSize(width: 1000, height: 800))
    c.windowDidResize(Notification(name: NSWindow.didResizeNotification))
    c.nativeMessage(.terminalView(nil))
    #expect(window.asked.isEmpty, "the page can place the view but never move the owner's typing into it")
  }

  @Test func signingOutFromTheMacClosesItAtOnceAndAMessageDuringTheLogoutCannotReopenIt() async throws {
    let (c, _) = opened()
    c.configure(relay: RelayOrigin(try #require(URL(string: "http://127.0.0.1:9"))))
    var done = false
    let out = Task { @MainActor in
      await c.signOut()
      done = true
    }
    await Task.yield()  // signOut runs to the logout request and waits there
    #expect(!done, "still waiting on the logout")
    #expect(!c.terminal.isOpen)
    #expect(c.terminalRect == nil)
    c.nativeMessage(.terminalView(room))
    #expect(!c.terminal.isOpen, "the page is still alive during the logout and may ask again")
    let end = Date().addingTimeInterval(10)
    while !done, Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
    out.cancel()
  }
}

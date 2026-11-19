import AppKit
import Foundation
import Testing
import TalosDesktopCore
import WebKit

@testable import TalosDesktop

/// View > Reload on the real `WebController`, with a web view that records what it was asked and a window that is never shown.
/// Needs TALOS_GUI_TESTS=1. No page loads and no network is touched.
@MainActor
@Suite("View > Reload (web window)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct ViewReloadGuiTests {
  final class SpyWebView: WKWebView {
    var shown: URL?
    var reloads = 0
    var loads: [URL] = []
    override var url: URL? { shown }
    override func reload() -> WKNavigation? {
      reloads += 1
      return nil
    }
    override func load(_ request: URLRequest) -> WKNavigation? {
      if let u = request.url { loads.append(u) }
      return nil
    }
  }

  /// A plain window that is neither key nor main: another Talos window (Terminals, Settings) is in front.
  final class BackWindow: NSWindow {
    override var isKeyWindow: Bool { false }
    override var isMainWindow: Bool { false }
  }

  let start = URL(string: "http://127.0.0.1:9")!

  func make(front: Bool = true, url: String? = "http://127.0.0.1:9/t/room-7", relay: Bool = true, window: Bool = true) throws
    -> (WebController, SpyWebView)
  {
    let c = WebController()
    if relay { c.configure(relay: RelayOrigin(start)) }
    let wv = SpyWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800), configuration: WKWebViewConfiguration())
    wv.shown = url.flatMap(URL.init(string:))
    let w: NSWindow? =
      window
      ? (front
        ? KeyWindowSpy(contentRect: wv.frame, styleMask: [.titled], backing: .buffered, defer: true)
        : BackWindow(contentRect: wv.frame, styleMask: [.titled], backing: .buffered, defer: true))
      : nil
    w?.contentView = wv
    w?.isReleasedWhenClosed = false
    c.useWebViewForTest(wv, windowVisible: true, window: w)
    wv.loads.removeAll()
    return (c, wv)
  }

  @Test func theFrontWebWindowReloadsItsCurrentPageNotTheStartAddress() throws {
    let (c, wv) = try make()
    #expect(c.webWindowIsFront)
    #expect(c.reloadFrontWindow())
    #expect(wv.reloads == 1, "the page it is on loads again, so the route stays")
    #expect(wv.loads.isEmpty, "the start address is not loaded")
  }

  @Test func whenAnotherWindowIsInFrontNothingReloads() throws {
    let (c, wv) = try make(front: false)
    #expect(!c.webWindowIsFront)
    #expect(!c.reloadFrontWindow())
    #expect(wv.reloads == 0 && wv.loads.isEmpty)
  }

  @Test func withNoWebWindowItDoesNothingAndDoesNotCrash() throws {
    let (c, wv) = try make(window: false)
    #expect(!c.reloadFrontWindow())
    #expect(wv.reloads == 0 && wv.loads.isEmpty)
    #expect(!WebController().reloadFrontWindow(), "no web view at all")
  }

  @Test func aFirstLoadThatNeverCommittedFallsBackToTheStartAddress() throws {
    let (c, wv) = try make(url: nil)
    #expect(c.reloadFrontWindow())
    #expect(wv.loads == [try #require(c.relay).url], "there is no current page, so it loads the start address, like Try now")
    #expect(wv.reloads == 0)
  }

  @Test func withNoRelayAndNoPageThereIsNothingToLoadAndItSaysSo() throws {
    let (c, wv) = try make(url: nil, relay: false)
    #expect(!c.reloadFrontWindow())
    #expect(wv.reloads == 0 && wv.loads.isEmpty)
  }

  /// Nothing in a reload touches the terminal window: it is a different object that the controller never reaches.
  @Test func reloadingDoesNotTouchTheTerminalWindowController() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { root.deleteLastPathComponent() }
    let src = try String(contentsOf: root.appendingPathComponent("Sources/TalosDesktop/WebWindowReload.swift"), encoding: .utf8)
    let start = try #require(src.range(of: "func reloadFrontWindow()"))
    let body = String(src[start.lowerBound...])
    #expect(!body.contains("Terminal") && !body.contains("detach") && !body.contains("terminate") && !body.contains("stop"))
  }
}

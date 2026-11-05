import CoreGraphics
import Foundation
import Testing
@testable import TalosDesktopCore

/// `terminal_view`: the page says where it left room for the agent terminal. The page is the less trusted side.
@Suite("Terminal view message")
struct TerminalViewMessageTests {
  /// A room small enough for the placement tests below; the real minimum comes from the viewer's font.
  let small = CGSize(width: 160, height: 100)
  let good: [String: Any] = ["type": "terminal_view", "rect": ["x": 240, "y": 0, "width": 880, "height": 780]]

  @Test func aRectangleOrNullDecodes() {
    #expect(WebToNative.decode(good) == .terminalView(TerminalViewRect(x: 240, y: 0, width: 880, height: 780)))
    #expect(WebToNative.decode(["type": "terminal_view", "rect": NSNull()]) == .terminalView(nil))
  }

  @Test func anythingElseIsRefusedNotIgnored() {
    #expect(WebToNative.decode(["type": "terminal_view"]) == nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": NSNull(), "text": "ls"]) == nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": ["x": 0, "y": 0, "width": 200]]) == nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": ["x": 0, "y": 0, "width": 200, "height": 200, "keys": "ls"]]) == nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": ["x": 0.5, "y": 0, "width": 200, "height": 200]]) == nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": ["x": true, "y": 0, "width": 200, "height": 200]]) == nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": ["x": -1, "y": 0, "width": 200, "height": 200]]) == nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": ["x": 0, "y": 0, "width": 20_001, "height": 200]]) == nil)
    #expect(WebToNative.decode(["type": "terminal_view", "rect": "0,0,200,200"]) == nil)
  }

  @Test func theTerminalIsPlacedInsideTheWebViewWhateverThePageSays() {
    let size = CGSize(width: 1000, height: 700)
    // AppKit's origin is the bottom left: a rectangle at the top of the page sits at the top of the view
    let top = TerminalViewRect(x: 240, y: 0, width: 700, height: 600)
    #expect(top.frame(in: size, flipped: false, minimum: small) == CGRect(x: 240, y: 100, width: 700, height: 600))
    #expect(top.frame(in: size, flipped: true, minimum: small) == CGRect(x: 240, y: 0, width: 700, height: 600))
    // a page that claims more than the window has is cut to the window
    let big = TerminalViewRect(x: 240, y: 0, width: 20_000, height: 20_000)
    #expect(big.frame(in: size, flipped: true, minimum: small) == CGRect(x: 240, y: 0, width: 760, height: 700))
    // a rectangle wholly outside the window is nothing
    #expect(TerminalViewRect(x: 5_000, y: 0, width: 800, height: 600).frame(in: size, flipped: true, minimum: small) == nil)
    #expect(TerminalViewRect(x: 0, y: 5_000, width: 800, height: 600).frame(in: size, flipped: true, minimum: small) == nil)
  }

  @Test func aSliverIsNotShownBecauseItWouldSqueezeTheAgentsOwnScreen() {
    let size = CGSize(width: 1000, height: 700)
    #expect(TerminalViewRect(x: 0, y: 0, width: 159, height: 600).frame(in: size, flipped: true, minimum: small) == nil)
    #expect(TerminalViewRect(x: 0, y: 0, width: 600, height: 99).frame(in: size, flipped: true, minimum: small) == nil)
    #expect(TerminalViewRect(x: 0, y: 0, width: 160, height: 100).frame(in: size, flipped: true, minimum: small) != nil)
    // the window shrank under a rectangle the page has not updated yet
    #expect(TerminalViewRect(x: 240, y: 0, width: 700, height: 600).frame(in: CGSize(width: 300, height: 700), flipped: true, minimum: small) == nil)
  }

  @Test func theTerminalShowsOnlyForASignedInLoadedPageAndAWindowOnScreen() {
    let size = CGSize(width: 1000, height: 700)
    let asked = TerminalViewRect(x: 240, y: 0, width: 700, height: 600)
    func place(
      _ r: TerminalViewRect? = asked, ready: Bool = true, signedIn: Bool = true, visible: Bool = true
    ) -> CGRect? {
      TerminalViewRect.placement(asked: r, pageReady: ready, signedIn: signedIn, windowVisible: visible, in: size, flipped: true, minimum: small)
    }
    #expect(place() == CGRect(x: 240, y: 0, width: 700, height: 600))
    #expect(place(nil) == nil, "the page is not on the Terminal screen")
    #expect(place(ready: false) == nil, "a page that is loading or gone")
    #expect(place(signedIn: false) == nil, "a page that is not signed in cannot open the terminal")
    #expect(place(visible: false) == nil, "a hidden window keeps no viewer")
  }

  @Test func theTerminalNeedsRoomForTheFullScreenOfTheAgent() {
    // tmux keeps the size the last viewer gave the agent's screen, and under 37 columns the dev-channel dialog is not
    // recognised, so the supervisor could not confirm a restart.
    #expect(TerminalViewRect.minColumns >= 80)
    #expect(TerminalViewRect.minRows >= 24)
    let min = CGSize(width: 660, height: 384)
    let size = CGSize(width: 1000, height: 700)
    let ask = { (w: Int, h: Int) in TerminalViewRect(x: 0, y: 0, width: w, height: h).frame(in: size, flipped: true, minimum: min) }
    #expect(ask(660, 384) != nil)
    #expect(ask(659, 384) == nil)
    #expect(ask(660, 383) == nil)
    #expect(ask(160, 100) == nil, "the old 160 x 100 was about 19 columns")
  }
}

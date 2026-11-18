import CoreGraphics
import Foundation
import Testing
@testable import TalosDesktopCore

/// A visible third-party window at a high level (a dictation tool's status window: level 1000, alpha 1, a third of the screen) can be
/// click-through, and the window list cannot say whether it is (alpha is 1 either way). The window server can: the owner of a click is
/// the window it hits. Hit a level 24+ window, or fail to ask, and the point stays refused.
@Suite("Screen input: a high window that takes no click")
struct ScreenOverlayClickThroughTests {
  typealias W = ScreenPointOwnerTests
  static let spot = CGPoint(x: 1200, y: 400)
  static let wispr = W.w(56, "Status", CGRect(x: 1022, y: 33, width: 490, height: 860), layer: 1000, bundle: "com.example.dictate", id: 90)
  /// The Mac, front to back: the overlay, the menu bar, Chrome full screen.
  static let screen: [ScreenPointWindow] = [
    wispr,
    W.w(0, "Window Server", CGRect(x: 0, y: 0, width: 1512, height: 33), layer: 24, id: 4),
    W.w(40, "Google Chrome", CGRect(x: 0, y: 33, width: 1512, height: 900), layer: 0, bundle: "com.google.Chrome", id: 7),
  ]

  @Test func aHighWindowTheServerHandsNoClickToIsNotInTheWay() {
    #expect(ScreenPointWindow.owner(at: Self.spot, in: Self.screen, hit: 7) == .app(W.chrome))
  }

  @Test func aHighWindowThatTakesTheClickRefuses() {
    // clear or opaque, ignoring the mouse or not: what decides is that the server hands the click to it
    #expect(ScreenPointWindow.owner(at: Self.spot, in: Self.screen, hit: 90) == .systemArea)
  }

  @Test func theMenuBarIsRefusedEvenUnderAnOverlayThatCoversIt() {
    let wide = W.w(56, "Status", CGRect(x: 1022, y: 0, width: 490, height: 900), layer: 1000, bundle: "com.example.dictate", id: 90)
    var list = Self.screen
    list[0] = wide
    // the server's answer at the strip is the menu bar's own window
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 1100, y: 10), in: list, hit: 4) == .systemArea)
    // and if it were not asked or named something unknown, still refused
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 1100, y: 10), in: list, hit: nil) == .systemArea)
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 1100, y: 10), in: list, hit: 12345) == .systemArea)
  }

  @Test func everyHighKindOfWindowThatTakesTheClickRefuses() {
    for (name, id, layer) in [
      ("Control Center", "com.apple.controlcenter", 25), ("Notification Center", "com.apple.notificationcenterui", 25),
      ("Alert", "com.apple.UserNotificationCenter", 25), ("Spotlight", "com.apple.Spotlight", 24), ("Overlay", "com.example.x", 101),
    ] {
      let sys = W.w(698, name, CGRect(x: 1100, y: 300, width: 300, height: 300), layer: layer, bundle: id, id: 55)
      #expect(ScreenPointWindow.owner(at: Self.spot, in: [sys] + Self.screen, hit: 55) == .systemArea, Comment(rawValue: name))
    }
  }

  @Test func anInvisibleHighWindowThatTakesTheClickRefuses() {
    let ghost = W.w(40, "Google Chrome", CGRect(x: 1100, y: 300, width: 300, height: 300), layer: 26, alpha: 0, bundle: "com.google.Chrome", id: 56)
    #expect(ScreenPointWindow.owner(at: Self.spot, in: [ghost] + Self.screen, hit: 56) == .systemArea)
  }

  @Test func theWholeGateAllowsAClickWhenTheServerHitsTheAllowedWindowAndRefusesWhenItHitsTheOverlay() throws {
    let r = CGRect(x: 0, y: 0, width: 400, height: 400)
    let list = [
      W.w(56, "Status", r, layer: 1000, bundle: "com.example.dictate", id: 90),
      W.w(501, "Notes Example", r, layer: 0, bundle: "com.example.notes", id: 10),
    ]
    for (hit, goes) in [(UInt32(10), true), (90, false)] {
      let input = FakeInput()
      let apps = FakeApps(front: Fx.notes)
      apps.owner = { ScreenPointWindow.owner(at: $0, in: list, hit: hit) }
      let core = Fx.core(input: input, apps: apps)
      if goes {
        #expect(try core.perform(.click(CGPoint(x: 50, y: 50)), allowedBundleIDs: ["com.example.notes"]) == 1)
        #expect(input.posted.count == 1)
      } else {
        #expect(throws: ScreenRefusal.systemArea) { try core.perform(.click(CGPoint(x: 50, y: 50)), allowedBundleIDs: ["com.example.notes"]) }
        #expect(input.posted.isEmpty)
      }
    }
  }

  @Test func aClickThroughOverlayDoesNotLetAClickReachAnAppThatIsNotAllowed() {
    // the allow list still decides on the window the server hits: the overlay opens no way to an app that was not granted
    let r = CGRect(x: 0, y: 0, width: 400, height: 400)
    let list = [W.w(56, "Status", r, layer: 1000, bundle: "com.example.dictate", id: 90), W.w(502, "Secret Example", r, layer: 0, bundle: "com.example.secret", id: 11)]
    let input = FakeInput()
    let apps = FakeApps(front: Fx.notes)
    apps.owner = { ScreenPointWindow.owner(at: $0, in: list, hit: 11) }
    #expect(throws: ScreenRefusal.self) { try Fx.core(input: input, apps: apps).perform(.click(CGPoint(x: 50, y: 50)), allowedBundleIDs: ["com.example.notes"]) }
    #expect(input.posted.isEmpty)
  }
}

import CoreGraphics
import Foundation

/// The room the page left for the agent terminal, in page pixels from the page's top-left (`terminal_view`,
/// packages/protocol/src/native.ts). The page is the less trusted side, so the rectangle is only ever used after `frame`
/// has clamped it to the window's own web view.
public struct TerminalViewRect: Equatable, Sendable {
  public var x: Int
  public var y: Int
  public var width: Int
  public var height: Int

  /// The largest value the message carries (`TERMINAL_RECT_MAX`).
  public static let max = 20_000
  /// The terminal shows only with room for this many cells (the app measures them in the viewer's own font). The viewer is a second tmux client and tmux sizes the agent's
  /// screen to the client used last, and the size stays after the viewer leaves. The agent's own screen must never be squeezed
  /// below what it can use: under 37 columns the dev-channel dialog no longer matches, and the supervisor needs that match to
  /// confirm a restart.
  public static let minColumns = 80
  public static let minRows = 24

  public init(x: Int, y: Int, width: Int, height: Int) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  /// Where the terminal goes inside a view of `size`, in that view's own coordinates, or nil when what is left is smaller
  /// than `minimum`. A view with its origin at the top (`flipped`) takes `y` as it is; AppKit's default origin is the bottom left.
  public func frame(in size: CGSize, flipped: Bool, minimum: CGSize) -> CGRect? {
    let left = Swift.min(x, Int(size.width))
    let right = Swift.min(x + width, Int(size.width))
    let top = Swift.min(y, Int(size.height))
    let bottom = Swift.min(y + height, Int(size.height))
    guard CGFloat(right - left) >= minimum.width, CGFloat(bottom - top) >= minimum.height else { return nil }
    let originY = flipped ? top : Int(size.height) - bottom
    return CGRect(x: left, y: originY, width: right - left, height: bottom - top)
  }

  /// Whether the terminal shows, and where. It shows only for a room the page asked for, while that page is loaded and says it
  /// is signed in, and while the window is on screen: a hidden window keeps no tmux viewer. `signedIn` is the page's own word
  /// and the relay controls the page, so it keeps a signed-out page from opening the view; it is not a lock against a hostile
  /// one (docs/SECURITY.md). `size` and `flipped` are the web view's.
  public static func placement(
    asked: TerminalViewRect?, pageReady: Bool, signedIn: Bool, windowVisible: Bool, in size: CGSize, flipped: Bool,
    minimum: CGSize
  ) -> CGRect? {
    guard pageReady, signedIn, windowVisible, let asked else { return nil }
    return asked.frame(in: size, flipped: flipped, minimum: minimum)
  }
}

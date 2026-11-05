import Foundation

/// When an open Quick Compose panel must read the page again. Reading rebuilds the picker, so it happens only when something the
/// panel shows has changed: the thread list, whether the owner is signed in, or the state of the page (loading, up, unreachable).
public enum ComposeRefresh {
  public struct World: Equatable, Sendable {
    public var threads: [WebToNative.Thread]
    public var signedIn: Bool
    public var page: PageState

    public init(threads: [WebToNative.Thread], signedIn: Bool, page: PageState) {
      self.threads = threads
      self.signedIn = signedIn
      self.page = page
    }
  }

  /// `shown` is what the panel last read; nil before its first read.
  public static func needed(open: Bool, shown: World?, now: World) -> Bool {
    open && shown != now
  }
}

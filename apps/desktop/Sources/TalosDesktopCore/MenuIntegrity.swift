import Foundation

/// Decides whether the Mac's top menu still holds the items Talos built, and how often it may be rebuilt. Pure data, so the
/// rules are tested without AppKit.
public enum MenuIntegrity {
  /// `have` still holds every item of `want`. A signature is one array per top-level menu: the title first (`# Window`),
  /// then one entry per item. AppKit adds its own items to a menu it manages and puts them anywhere: Writing Tools,
  /// Dictation and Emoji at the end of Edit, Close All in the middle of Window once a window exists, window names at the
  /// end. So every wanted item must be present and in order, with anything extra allowed between them. A menu that SwiftUI
  /// rebuilt has lost items of ours and fails. The top-level menus must match one for one by title, so a missing or extra
  /// top menu is still a replacement.
  public static func holds(_ have: [[String]], _ want: [[String]]) -> Bool {
    guard have.count == want.count else { return false }
    return zip(have, want).allSatisfy { isSubsequence($1, of: $0) && $0.first == $1.first }
  }

  private static func isSubsequence(_ small: [String], of big: [String]) -> Bool {
    var i = big.startIndex
    for s in small {
      guard let hit = big[i...].firstIndex(of: s) else { return false }
      i = big.index(after: hit)
    }
    return true
  }
}

/// A ceiling on how often the menu may be reinstalled, so two things that disagree about what the menu should look like can
/// never turn into a loop that makes the menu bar flicker. Installs are counted in a sliding window.
public struct MenuRepairBudget: Sendable {
  public enum Verdict: Equatable, Sendable {
    case go
    /// Over the limit and this is the first refusal in this burst: the caller logs once.
    case stopAndLog
    /// Over the limit and already logged.
    case stop
  }

  public let limit: Int
  public let window: TimeInterval
  private var stamps: [Date] = []
  private var logged = false

  public init(limit: Int = 3, window: TimeInterval = 60) {
    self.limit = limit
    self.window = window
  }

  /// Seconds until the oldest counted install ages out and one more is allowed; 0 when one is allowed now.
  public func waitUntilAllowed(at now: Date) -> TimeInterval {
    let live = stamps.filter { $0 <= now && now.timeIntervalSince($0) < window }
    guard live.count >= limit, let oldest = live.min() else { return 0 }
    return max(0, window - now.timeIntervalSince(oldest))
  }

  public mutating func request(at now: Date) -> Verdict {
    // A clock that jumped back must not keep old stamps alive forever: drop anything in the future too.
    stamps.removeAll { $0 > now || now.timeIntervalSince($0) >= window }
    if stamps.count < limit {
      stamps.append(now)
      logged = false
      return .go
    }
    if logged { return .stop }
    logged = true
    return .stopAndLog
  }
}

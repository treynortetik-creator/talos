import Foundation

/// Settings → Permissions → "Apps your agent may control": the owner's allowed list on this Mac, with Remove. The words live here
/// so they are tested; the view only draws them.
public final class ScreenAllowedAppsModel: @unchecked Sendable {
  public struct Row: Equatable, Sendable, Identifiable {
    public var id: String { bundleID }
    public var bundleID: String
    public var name: String
    /// Who signed it, in words.
    public var signedBy: String
    public var added: String
  }

  public static let title = "Apps your agent may control"
  public static let explainer =
    "Your agent can see and click and type only in these apps on this Mac. The first time it needs another app, Talos asks you on your phone. Talos itself can be on it too; even then, nothing your agent sends ever answers an approval card or a permission prompt."
  public static let empty = "No apps yet. Talos asks you the first time your agent needs one."
  /// The known gap (review R2-1), said where the owner removes apps.
  public static let knownGap =
    "A program already running as you on this Mac could undo a Remove after Talos restarts. Talos asking again per app does not protect against that."
  public static func unverifiedLine(_ n: Int) -> String {
    "\(n) \(n == 1 ? "entry" : "entries") in the list could not be checked (approved from a phone that is no longer paired, or changed outside Talos) and \(n == 1 ? "is" : "are") not used."
  }
  public static let unreadableLine =
    "The allowed-apps file can't be read, so no app is allowed. Start a new list to fix it; Talos asks you again for each app."
  public static func removeFailed(_ why: String) -> String { "Couldn't remove it: \(why)" }

  public let store: ScreenAllowStore
  public private(set) var rows: [Row] = []
  public private(set) var notes: [String] = []
  /// The last Remove's failure, in words; nil after a success or a refresh.
  public private(set) var error: String?
  public private(set) var unreadable = false

  public init(store: ScreenAllowStore) {
    self.store = store
    refresh()
  }

  public func refresh() {
    let s = store.snapshot()
    rows = s.apps.map(Self.row)
    unreadable = s.unreadable
    var n: [String] = []
    if s.unreadable { n.append(Self.unreadableLine) } else if s.apps.isEmpty { n.append(Self.empty) }
    if s.unverified > 0 { n.append(Self.unverifiedLine(s.unverified)) }
    notes = n
    error = nil
  }

  public func remove(_ bundleID: String) {
    do {
      try store.remove(bundleID: bundleID)
      refresh()
    } catch {
      refresh()
      self.error = Self.removeFailed(error.text)
    }
  }

  /// An unreadable list: replaced by an empty one under a new seal (`ScreenAllowStore.startNewList`).
  public func startNewList() {
    do {
      try store.startNewList()
      refresh()
    } catch {
      refresh()
      self.error = Self.removeFailed(error.text)
    }
  }

  static func row(_ a: ScreenAllowedApp) -> Row {
    Row(bundleID: a.bundleID, name: a.name, signedBy: signedBy(a), added: a.addedAt.isEmpty ? "" : "Allowed \(day(a.addedAt))")
  }

  static func signedBy(_ a: ScreenAllowedApp) -> String {
    let r = a.designatedRequirement ?? ""
    if r.hasPrefix("cdhash") { return "No developer signature: this exact build only" }
    if let t = a.teamID { return "Signed by developer team \(t)" }
    if r.contains("anchor apple"), !r.contains("anchor apple generic") { return "Apple" }
    return "Signed, no team id"
  }

  static func day(_ iso: String) -> String {
    guard let t = ISOTime.parse(iso) else { return iso }
    let f = DateFormatter()
    f.dateStyle = .medium
    f.timeStyle = .none
    return f.string(from: Date(timeIntervalSince1970: t))
  }
}

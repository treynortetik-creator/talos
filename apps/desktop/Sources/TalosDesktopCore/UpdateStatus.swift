import Foundation

/// What the update window and the menu say, in plain words. The updater (`AutoUpdater`) publishes one of these at every step; nothing
/// here decides anything, it only names the step. The words are the only place they are written, so a test can read them.
public enum UpdateStatus: Equatable, Sendable {
  /// Nothing asked yet since this app started.
  case idle
  case checking
  case upToDate(version: String)
  /// desktop.json has automatic updates off: a check is not made.
  case off
  case downloading(version: String)
  /// Downloaded and verified; waiting for its moment. The menu offers it.
  case ready(version: String)
  /// Ready, but a session is working or someone is typing. `why` is the raw look (log words); the window says it plainly.
  case waitingForQuiet(version: String, why: [String])
  /// The relay (the server the phone talks to) is on an older build than the update.
  /// `why`: the quiet rule's raw reasons when a session is busy as well (the window says both).
  case relayBehind(version: String, relay: String, app: String, why: [String] = [])
  /// The owner pressed Update now, and the update goes in the moment the turn that is running ends (or typing stops).
  case waitingForTurn(version: String)
  /// The Talos code folder is moving to the new version and its packages are installing.
  case preparing(version: String)
  /// The new app is being put in place, then the agent restarts.
  case restarting(version: String)
  case done(version: String)
  /// A release is waiting, but the Talos code folder it would move was never accepted by the owner (`AllowUpdatesCopy`): the window
  /// offers Allow updates, and nothing runs until the owner really clicks it.
  case needsAllow(version: String, clone: String)
  /// `line`: one plain sentence; `logPath`: where the details are.
  case failed(line: String, logPath: String)

  /// An update is downloaded and verified and not yet installed: the menu item turns into "Update to ...".
  public var pendingVersion: String? {
    switch self {
    case .ready(let v), .waitingForQuiet(let v, _), .relayBehind(let v, _, _, _), .waitingForTurn(let v): return v
    default: return nil
    }
  }

  /// The code folder that is waiting for the owner's OK, when this is that state.
  public var allowClone: String? {
    if case .needsAllow(_, let c) = self { return c }
    return nil
  }

  /// Still working: the window shows it is live.
  public var isBusy: Bool {
    switch self {
    case .checking, .downloading, .preparing, .restarting: return true
    default: return false
    }
  }

  public struct Words: Equatable, Sendable {
    public var headline: String
    public var detail: String
  }

  public var words: Words {
    switch self {
    case .idle:
      return Words(headline: "Check for updates", detail: "Talos looks for a new version when it starts and about every hour.")
    case .checking:
      return Words(headline: "Checking for a new version", detail: "This takes a few seconds.")
    case .upToDate(let v):
      return Words(headline: "You\u{2019}re up to date", detail: "This is Talos \(UpdateStatus.one(v)), the newest version.")
    case .off:
      return Words(
        headline: "Automatic updates are off",
        detail: "Turn on Update Talos automatically in Settings (General), then check again.")
    case .downloading(let v):
      return Words(headline: "Downloading Talos \(UpdateStatus.one(v))", detail: "Talos checks the download is genuine before it uses it.")
    case .ready(let v):
      return Words(
        headline: "Talos \(UpdateStatus.one(v)) is ready",
        detail: "Update now, or Talos installs it by itself when no agent is working.")
    case .waitingForQuiet(let v, let why):
      return Words(
        headline: "Waiting for a quiet moment",
        detail:
          "Talos \(UpdateStatus.one(v)) is ready, but \(UpdateStatus.quietReason(why)). Talos updates when nothing is going on, and keeps waiting for up to 2 hours. Update now does not wait.")
    case .relayBehind(let v, let relay, let app, let why):
      let also = why.isEmpty ? "" : " Talos is also waiting for a quiet moment: \(UpdateStatus.quietReason(why))."
      return Words(headline: "Waiting for the relay", detail: AutoUpdate.relayBehindLine(version: v, relay: relay, app: app) + also)
    case .waitingForTurn(let v):
      return Words(
        headline: "Waiting for your agent to finish its turn",
        detail: "Talos \(UpdateStatus.one(v)) goes in the moment your agent\u{2019}s turn ends and nobody is typing. Nothing is cut off.")
    case .preparing(let v):
      return Words(headline: "Getting ready for Talos \(UpdateStatus.one(v))", detail: "Updating your Talos code folder and its packages.")
    case .restarting(let v):
      return Words(
        headline: "Restarting your agent",
        detail: "Talos \(UpdateStatus.one(v)) is installed. Your agent restarts and picks up its conversation where it left off.")
    case .done(let v):
      return Words(headline: "Done", detail: "Talos is now on \(UpdateStatus.one(v)).")
    case .needsAllow(_, let clone):
      return Words(headline: AllowUpdatesCopy.title, detail: AllowUpdatesCopy.body(clone))
    case .failed(let line, let logPath):
      return Words(headline: "The update didn\u{2019}t work", detail: "\(UpdateStatus.one(line)) Details are in \(UpdateStatus.one(logPath)).")
    }
  }

  /// A version or a line on one line, with no control characters (these come from a feed or a log).
  static func one(_ s: String) -> String { UpdateRestartLine.oneLine(s) }

  /// The first reason Talos is waiting, as a clause. The raw reasons are log words (`Supervisor.autoUpdateLook`, `AutoUpdater`).
  static func quietReason(_ why: [String]) -> String {
    let first = (why.first ?? "").lowercased()
    if first.contains("background") { return "an agent is running something in the background" }
    if first.contains("draft") { return "a message is waiting to be sent" }
    if first.contains("wrote") || first.contains("typing") { return "you are typing" }
    if first.contains("owner") { return "your agent is waiting for you" }
    if first.contains("restart") || first.contains("cleaning") { return "your agent is restarting" }
    return "your agent is busy"
  }
}

/// The menu item that opens the update window.
public enum UpdateMenu {
  public static let checkTitle = "Check for Updates\u{2026}"

  public static func title(_ s: UpdateStatus) -> String {
    guard let v = s.pendingVersion else { return checkTitle }
    return "Update to \(UpdateStatus.one(v))\u{2026}"
  }

  /// The dot beside the title: an update is waiting for the owner.
  public static func showsDot(_ s: UpdateStatus) -> Bool { s.pendingVersion != nil }
}

/// The one-time banner: shown once per version, the first time it is ready. "Later" keeps it pending without asking again.
public enum UpdateBanner {
  public static func announce(_ s: UpdateStatus, announced: Set<String>) -> String? {
    guard let v = s.pendingVersion, !announced.contains(v) else { return nil }
    return "Talos \(UpdateStatus.one(v)) is ready to update."
  }
}

/// Every word of the question "Allow Talos to update itself?" and of the places that point at it (the update window, the menu bar menu,
/// Help, the line in the default thread). One place, so a test can check that no screen sends the owner to a window that is not there.
public enum AllowUpdatesCopy {
  public static let title = "Allow Talos to update itself?"
  public static let allowButton = "Allow updates"
  public static let notNowButton = "Not now"
  /// The Talos menu bar menu's item; it shows only while an answer is owed.
  public static let menuItem = "Allow updates\u{2026}"
  public static func body(_ clone: String) -> String {
    "To update, Talos moves and runs the code in this folder: \(UpdateRestartLine.oneLine(clone)). "
      + "Talos has not used it before. Allow updates only if it is the Talos folder you installed from."
  }
  /// The Keychain could not be read, so Talos cannot tell whether updates were allowed (it does not ask a question it cannot check).
  public static func keychainUnreadable(_ status: Int32) -> String {
    "Talos couldn't read its saved answer from the Keychain (error \(status)), so it can't tell whether you allowed updates. "
      + "Check that the login keychain is unlocked, then choose Check for Updates again."
  }
  /// Where the owner finds the question again after Not now.
  public static let whereToAnswer = "Choose \(menuItem) in the Talos menu bar menu, or press \(allowButton) in the update window."
}

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
  /// `why`: the quiet rule's raw reasons that still hold it (never Main's draft: the owner's ask overrides that). `draft`: what happens to
  /// the unsent text in Main's box (it is kept and put back after the restart, or Talos could not keep it).
  /// `threads`: Main is quiet and only thread agents (or their background work) are left; they get a limited wait, and the window
  /// offers Update now anyway. nil whenever Main itself still holds the update: that wait cannot be skipped.
  case waitingForTurn(version: String, why: [String] = [], draft: DraftPlan = .none, threads: ThreadWait? = nil)
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
  /// The probe found a newer version and the full check (fetching and verifying it) has begun: no timeout runs, this stays until the
  /// updater says something else.
  case fetching(version: String)
  /// A newer version exists and Talos is not set up yet: it is installed after setup.
  case availableAfterSetup(version: String)
  /// A newer version exists, but Talos is not set to install it by itself (automatic updates are off): said, never silent.
  case available(version: String)
  /// The check itself got no answer; the window says why in plain words and offers Try again.
  case couldntCheck(CheckProblem)

  /// The thread agents an Update now is still waiting for: their display names (empty when only background work is left) and the
  /// longest wait in whole minutes.
  public struct ThreadWait: Equatable, Sendable {
    public var names: [String]
    public var minutes: Int
    public init(names: [String], minutes: Int = 5) {
      self.names = names
      self.minutes = minutes
    }
    /// "Waiting for Trip to finish (up to 5 minutes)", or "your thread agents" for several (or none named).
    public var line: String {
      let who = Set(names).count == 1 ? UpdateStatus.one(names[0]) : "your thread agents"
      return "Waiting for \(who) to finish (up to \(minutes) \(minutes == 1 ? "minute" : "minutes"))"
    }
  }

  /// The button in the waiting line that skips the rest of the thread wait. It is never offered while Main's own turn runs.
  public static let skipThreadWaitButton = "Update now anyway"
  public var offersSkipThreadWait: Bool {
    if case .waitingForTurn(_, _, _, let t) = self { return t != nil }
    return false
  }

  /// What an Update now does with the unsent text in Main's input box.
  public enum DraftPlan: Equatable, Sendable {
    /// Nothing is typed there.
    case none
    /// A copy is saved before the update and shown to the owner after the restart (never typed back; it may be only part of the text).
    case keep
    /// It could not be read or saved safely: the update still goes ahead, and the text is lost.
    case cannotKeep
  }

  /// Why a check could not be answered. The words are plain: no server names, no file formats.
  public enum CheckProblem: Equatable, Sendable {
    case offline, server, unverified, timedOut, other
  }

  /// An update is downloaded and verified and not yet installed: the menu item turns into "Update to ...".
  public var pendingVersion: String? {
    switch self {
    case .ready(let v), .waitingForQuiet(let v, _), .relayBehind(let v, _, _, _), .waitingForTurn(let v, _, _, _): return v
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
    case .checking, .downloading, .preparing, .restarting, .fetching: return true
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
      return Words(headline: "Talos is up to date (\(UpdateStatus.one(v)))", detail: "You have the newest version.")
    case .off:
      return Words(
        headline: "Automatic updates are off",
        detail: "Turn on Update Talos automatically in Settings (General), then check again.")
    case .downloading(let v):
      return Words(headline: "Downloading Talos \(UpdateStatus.one(v))", detail: "Talos checks the download is genuine before it uses it.")
    case .ready(let v):
      return Words(
        headline: "Talos \(UpdateStatus.one(v)) is ready",
        detail: "Install it now, or Talos installs it by itself when no agent is working.")
    case .waitingForQuiet(let v, let why):
      return Words(
        headline: "Waiting for a quiet moment",
        detail:
          "Talos \(UpdateStatus.one(v)) is ready, but \(UpdateStatus.quietReason(why)). Talos updates when nothing is going on, and keeps waiting for up to 2 hours. Install does not wait.")
    case .relayBehind(let v, let relay, let app, let why):
      let also = why.isEmpty ? "" : " Talos is also waiting for a quiet moment: \(UpdateStatus.quietReason(why))."
      return Words(headline: "Waiting for the Talos server", detail: AutoUpdate.relayBehindLine(version: v, relay: relay, app: app) + also)
    case .waitingForTurn(let v, let why, let draft, let threads):
      let note: String
      switch draft {
      case .none: note = ""
      case .keep: note = " Talos will keep a copy of your unsent text and show it to you after the restart."
      case .cannotKeep: note = " Talos couldn\u{2019}t keep a copy of your unsent text, so it will be lost when your agent restarts."
      }
      if let threads {
        return Words(
          headline: threads.line,
          detail:
            "Talos \(UpdateStatus.one(v)) goes in when they finish, or after \(threads.minutes) \(threads.minutes == 1 ? "minute" : "minutes") at most. Anything they were still working on may be cut off. You can send it again from the thread.\(note)"
        )
      }
      return Words(
        headline: UpdateStatus.waitHeadline(why),
        detail: "Talos \(UpdateStatus.one(v)) goes in the moment this is over. Nothing is cut off.\(note)")
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
    case .fetching(let v):
      return Words(headline: "Getting Talos \(UpdateStatus.one(v))\u{2026}", detail: "Talos is fetching the update and checking it is genuine.")
    case .availableAfterSetup(let v):
      return Words(headline: "Talos \(UpdateStatus.one(v)) is available", detail: "It will be installed after setup.")
    case .available(let v):
      return Words(
        headline: "Talos \(UpdateStatus.one(v)) is available",
        detail: "Automatic updates are off. Turn on Update Talos automatically in Settings (General), then check again.")
    case .couldntCheck(let why):
      let headline = "Talos couldn\u{2019}t check for updates"
      switch why {
      case .offline: return Words(headline: headline, detail: "You seem to be offline. Connect to the internet, then try again.")
      case .server: return Words(headline: headline, detail: "Talos couldn\u{2019}t reach the update server. Try again in a little while.")
      case .unverified:
        return Words(headline: headline, detail: "The update file couldn\u{2019}t be verified, so Talos did not use it. Try again later.")
      case .timedOut: return Words(headline: headline, detail: "It took too long to get an answer. Check your internet connection, then try again.")
      case .other: return Words(headline: headline, detail: "Something went wrong while checking. Try again in a little while.")
      }
    }
  }

  /// The plain headline for what an Update now still waits for (first reason first). Main's draft is not one: the owner's ask overrides it.
  static func waitHeadline(_ why: [String]) -> String {
    let first = (why.first ?? "").lowercased()
    if first.contains("background") { return "Waiting for background work" }
    if first.contains("draft") { return first.hasPrefix("main") ? "Waiting: you have unsent text in your main chat" : "Waiting: you have unsent text in one of your chats" }
    if first.contains("wrote") || first.contains("typing") || first.contains("keys") { return "Waiting: you are typing" }
    if first.contains("owner") { return "Waiting: your agent is waiting for you" }
    if first.contains("restart") || first.contains("cleaning") { return "Waiting: your agent is restarting" }
    return "Waiting for your agent to finish its turn"
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
    if case .waitingForTurn(_, _, _, let t?) = s {
      return "Update to \(UpdateStatus.one(v)): w\(t.line.dropFirst())\u{2026}"
    }
    if case .waitingForTurn(_, let why, _, _) = s {
      return "Update to \(UpdateStatus.one(v)): \(UpdateStatus.waitHeadline(why).replacingOccurrences(of: "Waiting: ", with: "").lowercasedFirst)\u{2026}"
    }
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
  public static func body(_ clone: String, home: String = NSHomeDirectory()) -> String {
    "Talos keeps itself up to date from this folder: \(shownPath(clone, home: home)). Allow it if this is where you installed Talos."
  }
  /// The folder on one line, with the home folder as ~ and the middle cut out when it is long (the ends are what the owner recognises).
  public static func shownPath(_ clone: String, home: String = NSHomeDirectory(), limit: Int = 56) -> String {
    var p = UpdateRestartLine.oneLine(clone)
    if !home.isEmpty && home != "/" && (p == home || p.hasPrefix(home + "/")) { p = "~" + p.dropFirst(home.count) }
    guard p.count > limit, limit > 8 else { return p }
    let keep = limit - 1
    let head = keep / 3
    return String(p.prefix(head)) + "\u{2026}" + String(p.suffix(keep - head))
  }
  /// The Keychain could not be read, so Talos cannot tell whether updates were allowed (it does not ask a question it cannot check).
  public static func keychainUnreadable(_ status: Int32) -> String {
    "Talos couldn't read its saved answer from the Keychain (error \(status)), so it can't tell whether you allowed updates. "
      + "Check that the login keychain is unlocked, then choose Check for Updates again."
  }
  /// Where the owner finds the question again after Not now.
  public static let whereToAnswer = "Choose \(menuItem) in the Talos menu bar menu, or press \(allowButton) in the update window."
}

/// The words of the About window: the version, and the update check's answer inline. The update words themselves are `UpdateStatus.words`.
public enum AboutCopy {
  public static let checkButton = "Check for Updates"
  public static let tryAgainButton = "Try again"
  public static let installButton = "Install"
  /// The check button reads Try again after a check that got no answer.
  public static func checkButtonTitle(_ s: UpdateStatus) -> String {
    if case .couldntCheck = s { return tryAgainButton }
    return checkButton
  }
  public static func version(_ v: String) -> String { "Version \(UpdateRestartLine.oneLine(v))" }
  /// The build number, smaller under the version; nil when there is none or it only repeats the version.
  public static func build(_ b: String?, version: String) -> String? {
    guard let b, !b.isEmpty, b != version else { return nil }
    return "Build \(UpdateRestartLine.oneLine(b))"
  }
  /// Nothing is said until the owner has checked (or an update is already known).
  public static func headline(_ s: UpdateStatus) -> String {
    switch s {
    case .idle: return ""
    case .checking: return "Checking\u{2026}"
    default: return s.words.headline
    }
  }
  public static func detail(_ s: UpdateStatus) -> String? {
    switch s {
    case .idle, .checking: return nil
    default: return s.words.detail
    }
  }
  /// Update now is offered while an update waits for the owner (ready, or waiting for a quiet moment or the relay); not once it is going in.
  public static func offersUpdateNow(_ s: UpdateStatus) -> Bool {
    switch s {
    case .ready, .waitingForQuiet, .relayBehind: return true
    default: return false
    }
  }
}

extension String {
  fileprivate var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}

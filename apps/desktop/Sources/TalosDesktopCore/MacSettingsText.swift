import Foundation

/// The words of Mac settings that more than one place needs, and the "when does this apply" line for every Mac setting
/// (S6). The names follow the owner's call of 2026-11-01 (O6): "Mac settings" is this window, "Settings" is the page inside
/// the Talos window, "Companion" is the character.
public enum MacSettingsText {
  public static let windowTitle = "Mac settings"
  public static let connectionTab = "Connection"
  public static let companionName = "Companion"
  /// Where the relay address, sign-in and talos-app command live. Every notice that points there uses this.
  public static let connectionPath = "Mac settings \u{2192} Connection"
  public static let sessionPath = "Mac settings \u{2192} Session"
  public static let companionPath = "Mac settings \u{2192} Companion"
  public static let generalPath = "Mac settings \u{2192} General"
  public static let permissionsPath = "Mac settings \u{2192} Permissions"

  public enum Setting: String, CaseIterable, Sendable {
    case agentFolder, launchCommand, host, notifyThread
    case autoRestart, autoConfirmRestart, startSessionOnLaunch, openTerminalOnDialog
    case relayAddress, talosAppCommand
    case composeHotkey
    case startAtLogin, dockIcon, keepAwake, companion, openWindowAtLaunch
  }

  /// When a change takes effect. Never empty: a setting that applies at once says "Applies now."
  public static func applies(_ s: Setting) -> String {
    switch s {
    case .agentFolder: return AgentFolderCheck.appliesNote
    case .launchCommand: return "Applies the next time the agent starts, and that start is a cold start. Nothing restarts on its own."
    case .host: return HostChoice.appliesNote
    case .notifyThread: return "Applies to the next crash post."
    case .autoRestart: return "Applies from the next crash."
    case .autoConfirmRestart: return "Applies from the next start."
    case .startSessionOnLaunch: return "Applies the next time Talos opens."
    case .openTerminalOnDialog: return "Applies from the next time the agent needs you."
    case .relayAddress: return "Applies when you press Return or close this window. The Talos window reloads then."
    case .talosAppCommand: return "Applies to the next Sign in or Forget this Mac."
    case .composeHotkey: return "Applies now."
    case .startAtLogin: return "Applies the next time you log in."
    case .dockIcon: return "Applies now."
    case .keepAwake: return "Applies now."
    case .companion: return "Applies now."
    case .openWindowAtLaunch: return "Applies the next time Talos starts."
    }
  }

  // MARK: wording fixes (M22 to M30)

  /// M22. The old label read as if Talos asked you to confirm; on means Talos presses Enter for you.
  public static let autoConfirmTitle = "Press Enter for me on the development-channel dialog"
  public static let autoConfirmHelp =
    "Every time the agent starts, Talos presses Enter on the development-channel dialog for you, but only when it is exactly the dialog for the channel Talos launched with. Anything else waits for you."

  /// M26. Off still joins an agent that is already running; it only stops Talos starting a new one.
  public static let startOnOpenTitle = "Start the agent when Talos opens"
  public static let startOnOpenHelp =
    "Off still reconnects to an agent that is already running. It only stops Talos from starting a new one."

  /// M23/M24. The relay box shows nothing for the generic placeholder, so its hint is true.
  public static let relayHint = "auto (from bridge.env)"
  public static let noRelayYet = "No relay address yet. Set one in \(connectionPath)."
  /// The reason shown at the top of the Connection tab when a door (Help, Show Talos) sent the owner there for want of a relay
  /// address. Only those two notices, and only while there is still no address: any other notice belongs to other screens.
  public static func connectionNotice(_ notice: String, hasRelay: Bool) -> String {
    guard !hasRelay, notice == HelpPage.noRelay || notice == noRelayYet else { return "" }
    return notice
  }
  public static func relayDraft(_ configured: String) -> String {
    let c = configured.trimmingCharacters(in: .whitespacesAndNewlines)
    return c.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == RelayConfig.placeholder || c == "auto" ? "" : configured
  }
  public static func relayUsing(_ url: String?) -> String {
    url.map { "Using \($0)" } ?? "No relay address yet. Type one here, or run talos-app init --relay-url."
  }

  /// M29. The menu entry that ends a snooze says so.
  public static func snoozeEntry(until time: String) -> String { "End snooze (snoozed until \(time))" }

  /// M27. Start at login: what the line under the switch says for each state the system can report.
  public static let loginPending = "Waiting for you to approve Talos in System Settings \u{2192} General \u{2192} Login Items. It will not start at login until you do."
}

/// Build number and the files the General tab links to.
public enum MacAbout {
  public static func versionLine(version: String, build: String?) -> String {
    guard let b = build, !b.isEmpty, b != version else { return "Version \(version)" }
    return "Version \(version) (build \(b))"
  }

  public enum Reveal: Equatable, Sendable {
    case show(String)
    case missing(String)
  }

  public static func reveal(path: String, exists: Bool, what: String, madeBy: String) -> Reveal {
    exists ? .show(path) : .missing("No \(what) yet. \(madeBy)")
  }

  public static let logMissing = "The Mac app writes it the first time it records an event."
  public static let configMissing = "It is created when you set up the agent folder in the Setup checklist (Create, Adopt or Choose), Import your launch command, or Adopt a running session."
}

/// What Import and Adopt say (U6, U7).
public enum SetupText {
  public static let importSaved =
    "Saved. Your launch command is now your setup. Starting the session; if Claude asks you to confirm anything, answer it in Terminals… in the menu bar item."
  /// Import that did not start the session (it was refused, see the menu bar item).
  public static let importSavedNotStarted =
    "Saved. Your launch command is now your setup. Nothing has started yet: choose Start session in the menu bar item when you are ready."
  /// Import while a session is up: the running agent keeps the command it started with.
  public static let importSavedRunning =
    "Saved. The session that is running keeps its old command; the new one applies the next time it starts (Restart session in the menu bar item)."
  public static func importNotSaved(path: String) -> String {
    "Couldn't save the setup file (\(path)). Check that the folder exists and that you can write to it."
  }
  public static let launchNeedsSetup =
    "There is no launch command to edit yet. Paste your whole command under Import below, or use Find a running session and Adopt."
}

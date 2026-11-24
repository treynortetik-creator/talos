import Foundation

/// The words the Mac app shares with the web and iPhone apps (the owner-approved "Plain words" board, 2026-11-20).
/// One word per idea: the agent is "your agent", the relay is "the Talos server", the bridge is "your Mac" (or "Talos on your
/// Mac"). Engineer words (relay, bridge, tmux, session, Terminal, token, MCP, launch command) are allowed in Advanced only:
/// `MacWordsGuardTests` fails when one reaches any other Mac screen or the menu bar menu.
public enum MacWords {
  // MARK: the settings tabs (a mock tab each, `Settings: Your agent` and so on)

  public static let tabAgent = "Your agent"
  public static let tabPhone = "Phone & Mac"
  public static let tabAccess = "Privacy & access"
  public static let tabGeneral = "General"
  public static let tabAdvanced = "Advanced"
  public static let tabNames = [tabAgent, tabPhone, tabAccess, tabGeneral, tabAdvanced]

  // MARK: the menu bar menu

  public static let startAgent = "Start your agent"
  public static let stopAgent = "Stop your agent"
  public static let restartAgent = "Restart your agent"
  public static let advancedMenu = "Advanced"
  /// "Another session holds the channels": another Claude is already signed in to the channels this agent needs.
  public static let anotherAgentRunning = "Another agent is already using this account"
  public static let quitKeepsAgent = "Quit Talos (your agent keeps running)"
  public static let quitStopsAgent = "Quit Talos (stops your agent)"
  public static let quitAndStop = "Quit Talos and stop your agent"
  /// The Terminal window's second tab: the agents threads run for themselves.
  public static let threadAgentsTab = "Thread agents"
  public static let threadAgentsEmpty = "No thread agents yet. A thread that runs its own agent shows up here once it has started."
  /// The Advanced menu item without its dots, how a notice names it.
  public static let agentScreenName = "Show my agent's screen"
  /// Where that item is: every sentence that sends the owner to the agent's own screen says it this way.
  public static let agentScreenPath = "Advanced \u{2192} " + agentScreenName + " in the menu bar item"
  /// Where to go when nothing is set up: the setup, or the take-over, both named as the menu names them.
  public static let finishSetup = "Choose Set up Talos\u{2026} in the menu bar item, or press \u{201C}" + BlockedText.adoptButton + "\u{201D} in " + path(tabAdvanced) + "."
  public static let quickMessage = "Quick message\u{2026}"
  public static let quickMessageShortcut = "Quick message shortcut\u{2026}"
  public static let privacyAndAccess = "Privacy & access\u{2026}"
  public static let connectThisMac = "Connect this Mac\u{2026}"
  public static let disconnectThisMac = "Disconnect this Mac\u{2026}"
  /// Signing out of the Talos window on this Mac is not the Claude account (Phone & Mac, "Switch account\u{2026}").
  public static let signOutWindow = "Sign out of the Talos window\u{2026}"
  public static let signOutTitle = "Sign out of this Mac's Talos window?"
  public static let signOutBody =
    "This signs out the Talos window on this Mac only. To use the window again you connect this Mac with a new setup code. It does not change your agent, your phone or your Claude account."
  public static let signOutButton = "Sign out"
  public static let needsServerAddress = "Needs the Talos server address first."
  public static let shortcutNotSet = "Not set"
  public static let setShortcut = "Set shortcut"
  public static let changeShortcut = "Change shortcut"
  public static let screenRowTitle = "See and use the screen"
  public static func appsItMayUse(_ n: Int) -> String { "Apps it may use (\(n))" }
  public static let thisMacSignedIn = "Signed in on this Mac"
  public static let thisMacSignedOut = "Sign in on this Mac"

  // MARK: Advanced only (technical words allowed here)

  public static let showAgentScreen = "Show my agent's screen\u{2026}"
  public static let copyTerminalCommand = "Copy Terminal command"
  public static let copyAttachCommand = "Copy tmux attach command"
  public static let takeOver = "Take over an agent that's already running\u{2026}"
  public static let showProblemReport = "Show problem report"
  public static let showSettingsFile = "Show settings file"

  /// The Settings window's Advanced tab opens on this path from every door ("Mac settings \u{2192} Advanced").
  public static func path(_ tab: String) -> String { "Mac settings \u{2192} " + tab }

  // MARK: the status lines at the top of the menu

  public static func agentLine(_ state: String) -> String { "Agent: " + state }
  public static func serverLine(_ state: String) -> String { "Talos server: " + state }
  public static func macLine(_ state: String) -> String { "Your Mac: " + state }

  // MARK: the guard

  /// Words an owner never reads outside Advanced. Whole words, any case ("sessionless" is not "session").
  public static let forbidden = ["relay", "bridge", "tmux", "session", "sessions", "Terminal", "Terminals", "token", "MCP", "launch command", "config.json"]

  public static func forbiddenWords(in text: String) -> [String] {
    forbidden.filter { w in
      text.range(of: "(?<![A-Za-z])" + NSRegularExpression.escapedPattern(for: w) + "(?![A-Za-z])", options: [.regularExpression, .caseInsensitive]) != nil
    }
  }

  /// Every fixed string the owner reads in the menu bar menu and the Mac settings outside Advanced, for the guard.
  public static var outsideAdvanced: [String] {
    [
      MacSettingsText.windowTitle, MacSettingsText.companionName, MacSettingsText.companionHint, ThreadChoices.note(.unreadable), tabAgent, tabPhone, tabAccess, tabGeneral, tabAdvanced,
      startAgent, stopAgent, restartAgent, advancedMenu, signOutWindow, signOutTitle, signOutBody, signOutButton, thisMacSignedIn, thisMacSignedOut, needsServerAddress, shortcutNotSet, setShortcut, changeShortcut, screenRowTitle, appsItMayUse(3), agentScreenPath, finishSetup, SetupText.launchNeedsSetup, BlockedText.notSetUpLine, SupervisorNotice.noLogNotice(path: "/x/y"), anotherAgentRunning, quitKeepsAgent, quitStopsAgent, quitAndStop,
      threadAgentsTab, threadAgentsEmpty, quickMessage, quickMessageShortcut, privacyAndAccess, connectThisMac, disconnectThisMac,
      MacSettingsText.noRelayYet, MacSettingsText.autoUpdateTitle, MacSettingsText.autoUpdateHelp, MacSettingsText.loginPending,
      MacSettingsText.startOnOpenTitle, MacSettingsText.startOnOpenHelp, MacSettingsText.changesApply, MacSettingsText.restartNow,
      MacSettingsText.keepWorkingTitle, MacSettingsText.restartIfStopsTitle, MacSettingsText.problemsInTitle,
      SupervisorNotice.blocked, SupervisorNotice.restarted, SupervisorNotice.stoppedRestarting,
      SupervisorNotice.startStalledLine(agentName: nil, waited: 120), SupervisorNotice.resumeFailedLine(agentName: nil), SupervisorNotice.couldNotStartLine(agentName: nil), OnboardingText.firstStartStalled,
      SupervisorNotice.bridgeNotLive(nil), SupervisorNotice.relayUnreachable(closeCode: nil), SupervisorNotice.relayUnreachable(closeCode: 1006),
      HelpPage.noRelay, OnboardingText.firstStartBlocked, DevicesPage.rowTitle, DevicesPage.rowButton, DevicesPage.needsServer,
      AutoUpdate.relayBehindLine(version: "0.1.9", relay: "abc", app: "def"),
      UpdateStatus.relayBehind(version: "0.1.9", relay: "abc", app: "def").words.headline,
      UpdateStatus.relayBehind(version: "0.1.9", relay: "abc", app: "def").words.detail,
    ]
      + PermissionMode.allCases.flatMap { [$0.settingsName, $0.settingsBlurb] }
      + PermissionModeSetting.settingsTexts
      + PermissionsModel.table.flatMap { [$0.1, $0.2] } + [PermissionsModel.notificationsWhy, PermissionsModel.reopenNote]
      + PermissionsModel.allStateNotes
  }
}

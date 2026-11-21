import Foundation

/// Every sentence the first-run steps show (rule 3: strings are tokens, never literals in a view). Plain words for someone who
/// has never opened Terminal.
public enum OnboardingText {
  // Sign in to Claude
  public static let signInTitle = "Sign in to Claude"
  public static let signInExplain =
    "This signs in Claude Code on this Mac, the program your agent runs on. Your browser opens to finish. It does not sign in Talos."
  public static let signInButton = "Sign in to Claude\u{2026}"
  public static let signInAlready = "Claude is signed in."
  public static let signInWaiting = "Waiting for you to finish in the browser\u{2026}"
  public static let signInCancel = "Cancel"
  public static let signInRetry = "Try again"
  public static let signInNoClaude = "Claude Code isn't installed yet. Install it first (see claude above), then come back here."
  public static let signInCancelled = "Cancelled. Nothing was changed."
  public static let signInNotYet = "Claude is not signed in yet."
  /// What a repeating sign-in failure says to do. The sign-in stays in the app: no terminal, no command to type.
  public static let terminalFallback = "If it keeps failing, update Claude Code (the claude row above) and press Try again."
  public static let signInTimedOut =
    "Still not signed in after \(Int(ClaudeSignInPlan.defaultLimit / 60)) minutes. Press Try again and finish the page in your browser. \(terminalFallback)"
  public static let signInEnded = "The sign-in ended before Claude was signed in. Press Try again. \(terminalFallback)"
  public static let signInOpenPage = "Open sign-in page"
  public static let signInCopyLink = "Copy link"
  public static let signInCopied = "Copied"
  public static let signInCodeLabel = "If the page shows a code, paste it here"
  public static let signInCodeSend = "Send code"
  public static let signInBrowser = "Your browser should open. If it did not, use Open sign-in page."
  public static let signInAuthRow = "Not signed in. Press Sign in to Claude below. \(terminalFallback)"
  public static let signInCouldNotRun = "Talos couldn't start the sign-in. Press Try again. \(terminalFallback)"
  public static let signInUnknown = "Talos couldn't tell whether Claude is signed in. Press Try again."

  // Tools
  public static let toolsTitle = "Tools Talos needs"
  public static let installTmuxWithBrew = "Install tmux with Homebrew"
  public static let openClaudePage = "Open the Claude Code page"
  public static let openBunPage = "Open bun.sh"
  public static let openBrewPage = "Open brew.sh"
  public static let brewNeedsUser = "Homebrew will install tmux as you, never as an administrator."
  public static let brewRefusedRoot = "Talos will not install anything as an administrator. Open Talos as yourself and try again."
  public static let brewFailed = "The install did not finish. Open Terminal and run: brew install tmux"
  public static let brewMissingForTmux = "tmux needs Homebrew first. Open brew.sh, install it, then press Check again."

  /// The sentence on the "Sign in to Claude again" window (a thread or Main found Claude signed out).
  public static let signInAgainSentence =
    "Claude Code is signed out, so a session is waiting. Sign in below: open the link, then paste the code it gives you."

  // First start
  public static let firstStartTitle = "Start your agent"
  public static let firstStartIdle = "Not started. Finish the steps above, then choose Start your agent in the menu bar item."
  public static let firstStartWarning = "Claude is asking about the development channel. Answer in the Talos popup."
  public static let firstStartWaiting = "Waiting for the Talos bridge to come up\u{2026}"
  public static let firstStartDone = "Done. Your agent is running and its Talos bridge is live."
  public static let firstStartStalled = "Claude has not finished starting. Open Terminals\u{2026} in the menu bar item and look at the pane."
  public static let firstStartTerminal =
    "Claude is showing a question that only you can answer (a folder trust). Open Terminals\u{2026} in the menu bar item and look at the pane."
  public static let firstStartSafety =
    "Claude is asking whether to use a project connector (an MCP server), or whether to run with permission checks off. Answer in the Talos popup."
  public static let firstStartSignIn = "Claude is signed out. Choose Sign in to Claude again in the menu bar item, then follow the steps in that window."
  public static let firstStartApiKey = "Claude found an API key in your environment and is asking whether to use it. Answer in the Talos popup."
  public static let firstStartBlocked = "Another agent is already using this account, so yours did not start. Close it, then choose Start your agent in the menu bar item."
  public static let firstStartStopped = "Your agent stopped before it finished starting. Choose Start your agent in the menu bar item."

  // Rules
  public static let rulesTitle = "Rules for your agent"
  public static let rulesExplain =
    "Plain sentences your agent follows in every conversation. Leave it empty if you have none. Talos saves it as .claude/rules/owner-rules.md in your agent folder, which Claude Code reads at the start of each session, so it applies the next time the agent starts. Your own rules are kept apart from the ones Talos ships and are never replaced by an update."
  public static let rulesPlaceholder = "For example: Never include patient names or health details in anything you write or send."
  public static let rulesSave = "Save rules"
  public static let rulesSaved = "Saved. Your agent reads it the next time it starts (Restart your agent in the menu bar item)."
  public static let rulesRemoved = "Removed. Your agent has no rules of yours now."
  public static let rulesNothing = "Nothing to save."
  // Rules refusals
  public static func rulesNoFolder(_ dir: String) -> String { "There is no agent folder at \(dir) yet. Set up the agent folder first." }
  public static func rulesTooLong(_ n: Int, max: Int) -> String { "That is too long (\(n) characters). Keep it under \(max)." }
  public static func rulesLink(_ p: String) -> String { "\(p) is a link, so Talos will not write through it." }
  public static func rulesForeignFile(_ f: String) -> String {
    "\(f) already exists and Talos did not write it. Edit that file yourself, or move it aside."
  }
  public static func rulesCannotRemove(_ f: String) -> String { "Talos couldn't remove \(f)." }
  public static func rulesCannotWrite(_ f: String) -> String { "Talos couldn't write \(f)." }
  public static let permissionNote =
    "New installs show the agent's tool prompts as approval cards on your phone. To turn that off: Settings \u{2192} Health \u{2192} \u{201C}Tool prompts as approval cards\u{201D}. An agent you already had is not changed."
}

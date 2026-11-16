import Foundation

/// The tools Talos needs (claude, bun, tmux): how their versions read and what a one-click fix may be. Pure. The app finds
/// the programs (always by absolute path, through the login environment) and runs a fix; this decides what is offered.
public enum PrereqPlan {
  public enum Fix: Equatable, Sendable {
    /// Open an official install page in the browser. Runs nothing.
    case openPage(label: String, url: String)
    /// `brew install <formula>` as the signed-in user, by Homebrew's absolute path.
    case brewInstall(label: String, brew: String, formula: String)

    public var label: String {
      switch self {
      case .openPage(let l, _), .brewInstall(let l, _, _): return l
      }
    }
  }

  public static let claudePage = "https://claude.com/claude-code"
  public static let bunPage = "https://bun.sh"
  public static let brewPage = "https://brew.sh"

  /// The fix offered for a missing tool row (`claude`, `bun`, `tmux`), or nil when there is no safe one. `brew` is Homebrew's
  /// absolute path when it was found. Only tmux is installed by a command, because SETUP.md documents `brew install tmux`;
  /// claude and bun open their official pages (the repo's installer points at the same ones), and nothing is piped to a shell.
  public static func fix(for id: String, brew: String?, existingPath: String? = nil) -> Fix? {
    switch id {
    case "claude": return .openPage(label: OnboardingText.openClaudePage, url: claudePage)
    case "bun": return .openPage(label: OnboardingText.openBunPage, url: bunPage)
    case "tmux":
      // A tmux that is already there (too old) may not be Homebrew's: installing over it is not safe, so only the row's words help.
      if existingPath != nil { return nil }
      if let brew { return .brewInstall(label: OnboardingText.installTmuxWithBrew, brew: brew, formula: "tmux") }
      return .openPage(label: OnboardingText.openBrewPage, url: brewPage)
    default: return nil
    }
  }

  public enum Run: Equatable, Sendable {
    case argv([String])
    case refused(String)
  }

  /// The argv for a brew fix. Never as root (uid 0), and only an absolute Homebrew path and a plain formula name.
  public static func argv(for fix: Fix, uid: UInt32) -> Run {
    guard case .brewInstall(_, let brew, let formula) = fix else { return .refused("not a command") }
    if uid == 0 { return .refused(OnboardingText.brewRefusedRoot) }
    guard brew.hasPrefix("/"), formula.range(of: "^[a-z0-9][a-z0-9@._+-]*$", options: .regularExpression) != nil else {
      return .refused(OnboardingText.brewFailed)
    }
    return .argv([brew, "install", formula])
  }

  /// The version number from `claude --version` ("2.1.312 (Claude Code)"), `bun --version` ("1.4.4") or `tmux -V` ("tmux 3.5a").
  /// nil when no number can be read.
  public static func version(_ id: String, output: String) -> String? {
    let first = output.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
    var words = first.split(separator: " ").map(String.init)
    if id == "tmux", words.first == "tmux" { words.removeFirst() }
    guard let w = words.first, w.first?.isNumber == true else { return nil }
    return w
  }
}

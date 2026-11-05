import Foundation

/// The sign-in command the setup screen shows with a Copy button, so the owner never has to ask the agent for it.
public enum SignInHelp {
  public static let label = "Mac app"

  /// The exact command, ready to paste into Terminal. `resolved` is how this Mac runs the talos-app command (a path, or
  /// `bun run <file>`); nil when it was not found, which shows the plain name.
  ///
  /// The path is kept as resolved: a Terminal may not have the same PATH as Talos (a binary found only under `~/.bun/bin`,
  /// or a path typed in Settings, gives "command not found" if shortened). `onTerminalPath` is true only when the caller
  /// knows the login PATH finds the bare name, which then reads better. `env` (for example `TALOS_APP_HOME`) leads the
  /// command so a custom home reaches it too.
  public static func command(resolved: [String]?, env: [String: String] = [:], onTerminalPath: Bool = false) -> String {
    var base = (resolved?.isEmpty == false) ? resolved! : ["talos-app"]
    if onTerminalPath, base.count == 1, base[0].split(separator: "/").last == "talos-app" { base = ["talos-app"] }
    let prefix = env.keys.filter { Self.carried.contains($0) }.sorted().map { "\($0)=\(LaunchSpec.shellQuote(env[$0] ?? ""))" }
    return (prefix + (base + ["enroll", "--label", label]).map(LaunchSpec.shellQuote)).joined(separator: " ")
  }

  /// The variables that change which Talos the command talks to.
  public static let carried: Set<String> = ["TALOS_APP_HOME"]

  /// What to do with the command when the button can't finish the job. `talos-app enroll` prints a one-time link and waits;
  /// the four words only show up after the device has used the link. A browser that opens the link would be pinned instead
  /// of this Mac, so the link goes into the Talos window.
  public static let how =
    "Run it in Terminal. It prints a one-time link (good for 10 minutes). Copy the link into the Talos window (Paste a "
    + "setup link), not a browser. When the window shows four words, type y in Terminal if they match."

  /// What the sign-in pane says when the command ended, or nil to leave its message alone: a run that showed a link says
  /// done, two different links keep their own message, and only a run that showed nothing is "ended before a link".
  public static func exitMessage(sent: Bool, ambiguous: Bool, command: String) -> String? {
    if sent { return "Done. If the Talos window shows This device is ready, you're signed in." }
    if ambiguous { return nil }
    return fallback(command: command, why: "The sign-in command ended before it showed a link.")
  }

  /// What the sign-in panel offers right now. The button appears only when the page itself said the owner is signed out
  /// (audit D46): a relay that is down or a page still loading is not a signed-out Mac, and a second enroll would mint a
  /// one-use code for a device that is already pinned.
  public enum Offer: Equatable, Sendable { case needsRelay, signedIn, connecting, unreachable, button }

  public static func offer(hasRelay: Bool, page: PageState) -> Offer {
    if !hasRelay { return .needsRelay }
    switch page {
    case .signedIn: return .signedIn
    case .loading: return .connecting
    case .unreachable: return .unreachable
    case .signedOut: return .button
    }
  }

  /// When the button could not start the command.
  public static func fallback(command: String, why: String) -> String {
    "\(why) You can run it yourself instead: \(command)"
  }
}

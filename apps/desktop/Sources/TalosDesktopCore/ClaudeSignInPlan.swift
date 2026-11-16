import Foundation

/// The Sign in to Claude step (`claude auth login`, then `claude auth status` until it says signed in). Pure: what each outcome
/// says and what the buttons do. The process work is `ClaudeSignIn` in TalosSupervisor. Nothing the CLI prints is ever kept or
/// shown: the only facts used are "status exited 0" and "login exited".
public enum ClaudeSignInPlan {
  /// How long the poll waits for the owner to finish in the browser.
  public static let defaultLimit: Double = 300
  public static let defaultInterval: Double = 2
  /// One `claude auth status` call.
  public static let statusTimeout: Double = 10

  public enum Check: Equatable, Sendable {
    case signedIn
    case notSignedIn
    /// The call timed out or could not run: not the same as signed out.
    case unknown
  }

  public enum Outcome: Equatable, Sendable {
    case alreadySignedIn
    case signedIn
    case cancelled
    case timedOut
    /// `claude auth login` ended and status still says not signed in.
    case loginEndedNotSignedIn
    case couldNotRun
    /// Status never answered (every call timed out) for the whole wait.
    case statusUnknown
    case noClaude

    public var isSuccess: Bool { self == .alreadySignedIn || self == .signedIn }

    /// What the step says. Retry is offered for every outcome that is not a success.
    public var message: String {
      switch self {
      case .alreadySignedIn: return OnboardingText.signInAlready
      case .signedIn: return OnboardingText.signInAlready
      case .cancelled: return OnboardingText.signInCancelled
      case .timedOut: return OnboardingText.signInTimedOut
      case .loginEndedNotSignedIn: return OnboardingText.signInEnded
      case .couldNotRun: return OnboardingText.signInCouldNotRun
      case .statusUnknown: return OnboardingText.signInUnknown
      case .noClaude: return OnboardingText.signInNoClaude
      }
    }
  }

  /// `claude auth status` exited with `status` (nil = it did not run), or timed out.
  public static func check(status: Int32?, timedOut: Bool, json: Data = Data()) -> Check {
    if timedOut || status == nil { return .unknown }
    // `auth status --json` says {"loggedIn": true|false}. Only that one boolean is read; nothing else in the output is kept.
    if let o = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any], let yes = o["loggedIn"] as? Bool {
      return yes && status == 0 ? .signedIn : .notSignedIn
    }
    return status == 0 ? .signedIn : .notSignedIn
  }

  /// Whether the Sign in button shows: not when Claude is signed in (the last check, or a sign-in that just worked), and not while
  /// a sign-in is running.
  public static func showsButton(authSignedIn: Bool?, outcome: Outcome?, running: Bool) -> Bool {
    if running || authSignedIn == true { return false }
    if let outcome { return !outcome.isSuccess }
    return true
  }

  /// A kept outcome the latest definite check contradicts (a success, then signed out; a failure, then signed in): it is dropped so
  /// the panel shows what the check says.
  public static func isStale(outcome: Outcome?, authSignedIn: Bool?) -> Bool {
    guard let outcome, let auth = authSignedIn else { return false }
    return outcome.isSuccess != auth
  }

  /// What the poll ends with when the time is up: a status that never answered is its own message.
  public static func timeoutOutcome(everAnswered: Bool) -> Outcome { everAnswered ? .timedOut : .statusUnknown }
}

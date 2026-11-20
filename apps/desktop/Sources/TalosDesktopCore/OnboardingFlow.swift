import Foundation

/// The new first-run screens as a state machine: Welcome, Getting Talos ready (with its Apple-tools and offline variants), Sign in,
/// Use Talos on your phone, Scan and check the words, then the app's own hello. Pure: it holds no process and no window. Every event
/// is a fact the app learned or a button the owner pressed; `apply` answers with the things the app must now do (`Effect`), so a test
/// can say "this press starts that and nothing else". The real work (fetching Talos, Claude's sign-in, the phone pairing) is the
/// existing machinery, driven by `OnboardingCoordinator`.
///
/// Skips, all decided here: Apple's tools present means the Apple step never shows; Claude already signed in skips the sign-in step;
/// "Just this Mac for now" skips the pairing step. An Mac that is already set up never starts this (`isNeeded`).
public struct OnboardingFlow: Equatable, Sendable {
  public enum Step: Equatable, Sendable { case welcome, ready, appleTools, signIn, phone, pair, hello }

  public enum Download: Equatable, Sendable {
    case running(pct: Int)
    /// No internet: paused where it was, one button (Try again now). Talos also tries again by itself.
    case offline(pct: Int)
    /// Stopped for another reason (the message is plain words); the same one button.
    case failed(pct: Int, message: String)
    /// Finished. Going back to this screen shows Continue lit.
    case done
  }

  public enum Tools: Equatable, Sendable {
    /// macOS is showing its own Install window: the owner clicks Install in it.
    case asking
    /// macOS is installing. `pct` is nil when the system gives no progress (the bar then just moves).
    case installing(pct: Int?)
  }

  public enum SignIn: Equatable, Sendable {
    case idle
    case waiting
    /// The last try did not end signed in (plain words); the one button is Sign in again.
    case failed(String)
  }

  public enum Pair: Equatable, Sendable {
    /// Making a one-use code.
    case starting
    /// The code to scan, as the link it holds.
    case scan(link: String)
    /// The phone opened it: these four words must be the ones the phone shows.
    case confirm(link: String, words: [String])
    /// The owner said the words match; waiting for the connection to finish.
    case connecting
    case failed(String)
  }

  public enum Event: Equatable, Sendable {
    case getStarted
    case toolsAsked
    case toolsInstalling(pct: Int?)
    case toolsDone
    case downloadProgress(pct: Int)
    case downloadOffline
    case downloadFailed(String)
    case tryAgain
    /// The download and setup finished. `signedIn`: Claude is signed in on this Mac (nil: could not tell, which asks for sign-in).
    case downloadDone(signedIn: Bool?)
    case continuePressed
    case signInPressed
    /// Claude's sign-in ended; `message` is the plain reason when it did not succeed.
    case signInEnded(success: Bool, message: String?)
    /// Talos noticed on its own that Claude is signed in.
    case signedInNoticed
    case back
    /// Whether a phone link can be made now (the Mac already has a place to connect phones through). Said before `choosePhone`.
    case phoneLinkKnown(Bool)
    case choosePhone
    case chooseThisMacOnly
    case pairLink(String)
    case pairWords([String])
    case wordsMatch
    case wordsDontMatch
    case pairConnected
    case pairFailed(String)
  }

  /// What the app must do now. The coordinator is the only place that does any of it.
  public enum Effect: Equatable, Sendable {
    case startDownload
    case startSignIn
    case cancelSignIn
    case startPairing
    case cancelPairing
    /// The owner's yes to the four words. Only ever from `wordsMatch` on a screen that showed them.
    case confirmWords
    /// The owner's no: the code is cancelled and nothing is connected.
    case declineWords
    /// Setup is over: the Talos window opens on the agent's first hello.
    case finish
  }

  public private(set) var step: Step = .welcome
  public private(set) var download: Download = .running(pct: 0)
  public private(set) var tools: Tools = .asking
  public private(set) var signIn: SignIn = .idle
  public private(set) var pair: Pair = .starting
  /// Claude is signed in on this Mac (set when the download finishes).
  public private(set) var signedIn = false
  /// A phone was connected in this run. "They don't match" and "Just this Mac" never set it.
  public private(set) var phoneConnected = false
  /// A phone link can be made on this Mac (nothing is asked of the owner for it). A fresh Mac has none: "Yes, on my phone too" then goes
  /// straight on, and the agent leads the phone setup after its hello.
  public private(set) var phoneLinkAvailable = false

  public init() {}

  /// An already set-up Mac (its `desktop.json` exists) never sees the new screens: they are for a Mac with no agent yet.
  public static func isNeeded(configured: Bool) -> Bool { !configured }

  /// Which of the three bars is current (1...3); nil on the welcome and hello screens, which have no progress bar.
  public var stepNumber: Int? {
    switch step {
    case .welcome, .hello: return nil
    case .ready, .appleTools: return 1
    case .signIn: return 2
    case .phone, .pair: return 3
    }
  }

  public enum Segment: Equatable, Sendable { case done, current, todo }

  public var segments: [Segment] {
    guard let n = stepNumber else { return [] }
    return (1...3).map { $0 < n ? .done : ($0 == n ? .current : .todo) }
  }

  /// The setup is going on right now: a download that runs (or waits for the internet), Apple's install, sign-in, the phone step. A
  /// download that stopped on a failure, the first screen and the end are not: another route setting the Mac up then is not a clash.
  public var isActive: Bool {
    switch step {
    case .welcome, .hello: return false
    case .appleTools, .signIn, .phone, .pair: return true
    case .ready:
      switch download {
      case .running, .offline: return true
      case .failed, .done: return false
      }
    }
  }

  /// Continue on the ready screen is lit only when the work is done (it also goes on by itself).
  public var continueLit: Bool { step == .ready && download == .done }

  @discardableResult
  public mutating func apply(_ e: Event) -> [Effect] {
    switch e {
    case .getStarted:
      guard step == .welcome else { return [] }
      step = .ready
      download = .running(pct: 0)
      return [.startDownload]

    case .toolsAsked:
      // only while the download is running: a late message from a download that already stopped or finished is not news
      guard step == .ready || step == .appleTools, case .running = download else { return [] }
      step = .appleTools
      tools = .asking
      return []

    case .toolsInstalling(let pct):
      guard step == .appleTools else { return [] }
      tools = .installing(pct: pct.map { min(100, max(0, $0)) })
      return []

    case .toolsDone:
      guard step == .appleTools else { return [] }
      step = .ready
      return []

    case .downloadProgress(let pct):
      // a progress report that arrives after the download stopped (offline, failed, done) changes nothing: the stop is the truth
      guard step == .ready || step == .appleTools, case .running(let old) = download else { return [] }
      if step == .appleTools { step = .ready }
      download = .running(pct: max(old, min(100, max(0, pct))))
      return []

    case .downloadOffline:
      guard step == .ready || step == .appleTools else { return [] }
      step = .ready
      download = .offline(pct: pctNow)
      return []

    case .downloadFailed(let message):
      guard step == .ready || step == .appleTools else { return [] }
      step = .ready
      download = .failed(pct: pctNow, message: message)
      return []

    case .tryAgain:
      switch (step, download) {
      case (.ready, .offline(let p)), (.ready, .failed(let p, _)):
        download = .running(pct: p)
        return [.startDownload]
      default: return []
      }

    case .downloadDone(let signed):
      guard step == .ready || step == .appleTools else { return [] }
      signedIn = signed == true
      download = .done
      return advanceFromReady()

    case .continuePressed:
      guard continueLit else { return [] }
      return advanceFromReady()

    case .signInPressed:
      guard step == .signIn, signIn != .waiting else { return [] }
      signIn = .waiting
      return [.startSignIn]

    case .signInEnded(let ok, let message):
      guard step == .signIn else { return [] }
      if ok {
        signedIn = true
        signIn = .idle
        step = .phone
      } else {
        signIn = .failed(message ?? "Claude isn't signed in yet. Press Sign in with Claude to try again.")
      }
      return []

    case .signedInNoticed:
      guard step == .signIn else { return [] }
      signedIn = true
      signIn = .idle
      step = .phone
      return [.cancelSignIn]

    case .back:
      switch step {
      case .signIn:
        let was = signIn
        signIn = .idle
        step = .ready
        download = .done
        return was == .waiting ? [.cancelSignIn] : []
      case .phone:
        step = signedIn ? .ready : .signIn
        if step == .ready { download = .done }
        return []
      case .pair:
        step = .phone
        pair = .starting
        return [.cancelPairing]
      default: return []
      }

    case .phoneLinkKnown(let known):
      phoneLinkAvailable = known
      return []

    case .choosePhone:
      guard step == .phone else { return [] }
      guard phoneLinkAvailable else {
        // no link to make: nothing is connected here, the agent offers it next (the hello says so)
        step = .hello
        return [.finish]
      }
      step = .pair
      pair = .starting
      return [.startPairing]

    case .chooseThisMacOnly:
      guard step == .phone else { return [] }
      step = .hello
      return [.finish]

    case .pairLink(let link):
      guard step == .pair, pair == .starting else { return [] }
      pair = .scan(link: link)
      return []

    case .pairWords(let words):
      guard step == .pair, words.count == 4 else { return [] }
      switch pair {
      case .scan(let link), .confirm(let link, _): pair = .confirm(link: link, words: words)
      default: break
      }
      return []

    case .wordsMatch:
      guard step == .pair, case .confirm = pair else { return [] }
      pair = .connecting
      return [.confirmWords]

    case .wordsDontMatch:
      guard step == .pair, case .confirm = pair else { return [] }
      // nothing is connected: the old code is cancelled and a new one is made
      pair = .starting
      return [.declineWords, .startPairing]

    case .pairConnected:
      guard step == .pair, pair == .connecting else { return [] }
      phoneConnected = true
      step = .hello
      return [.finish]

    case .pairFailed(let message):
      guard step == .pair else { return [] }
      pair = .failed(message)
      return []
    }
  }

  /// "Try again" after a pairing failure: a new code.
  @discardableResult
  public mutating func retryPairing() -> [Effect] {
    guard step == .pair, case .failed = pair else { return [] }
    pair = .starting
    return [.startPairing]
  }

  public enum LineState: Equatable, Sendable { case done, active, waiting }

  /// The three lines under the bar: the agent's home (the Talos copy is in place), the download and install, the final check. A line
  /// turns green when the work it names is behind the bar (`pct`), and only the first not-yet-done line spins.
  public static func readyLines(pct: Int, done: Bool) -> [LineState] {
    if done { return [.done, .done, .done] }
    let home: LineState = pct >= 44 ? .done : .active
    let download: LineState = pct >= 88 ? .done : (home == .done ? .active : .waiting)
    let check: LineState = download == .done ? .active : .waiting
    return [home, download, check]
  }

  private var pctNow: Int {
    switch download {
    case .running(let p), .offline(let p), .failed(let p, _): return p
    case .done: return 100
    }
  }

  private mutating func advanceFromReady() -> [Effect] {
    if signedIn {
      step = .phone
    } else {
      step = .signIn
      signIn = .idle
    }
    return []
  }
}

import Foundation

/// Every word the new first-run screens show. The sentences are the approved mock's (Welcome, Getting Talos ready, One quick Apple
/// install, Sign in, Use Talos on your phone, Scan and check the words, Offline, Hello). One word for each idea: the agent, a chat,
/// the connection to your phone; never session, bridge, relay, tmux, Terminal or a launch command (`forbidden`, held by a test).
public enum OnboardingCopy {
  public static let windowTitle = "Set up Talos"

  // 1 Welcome
  public static let welcomeTitle = "Welcome to Talos"
  public static let welcomeBody = "Your Claude agent, on this Mac and on your phone. Setup takes about three minutes."
  public static let welcomeSteps = ["Talos gets itself ready", "You sign in to Claude", "You connect your phone"]
  public static let getStarted = "Get started"
  public static let robotAlt = "Talos, the bronze robot"

  // 2 Getting Talos ready
  public static let readyTitle = "Getting Talos ready"
  public static let readyBody = "Talos is downloading what it needs. You don't have to do anything."
  public static let readyDownloading = "Downloading Talos's tools"
  public static let readyHome = "Your agent's home is made"
  public static let readyChecking = "Checking everything works"
  public static let readyFooter = "It goes on by itself; Continue lights up when it's done."
  public static let continueButton = "Continue"
  public static func stepLabel(_ n: Int) -> String { "Step \(n) of 3" }

  /// "62% · about 1 minute left"; just the percent when there is no honest estimate yet.
  public static func readyDetail(pct: Int, secondsLeft: Int?) -> String {
    guard let s = secondsLeft else { return "\(pct)%" }
    if s < 45 { return "\(pct)% · less than a minute left" }
    let m = Int((Double(s) / 60).rounded())
    return "\(pct)% · about \(max(1, m)) \(m <= 1 ? "minute" : "minutes") left"
  }

  /// Seconds left from the time spent so far, or nil while a guess would be noise (under 10% or under 5 seconds in).
  public static func secondsLeft(pct: Int, elapsed: TimeInterval) -> Int? {
    guard pct >= 10, pct < 100, elapsed >= 5 else { return nil }
    return Int(elapsed * Double(100 - pct) / Double(pct))
  }

  // 2b One quick Apple install
  public static let appleTitle = "One quick Apple install first"
  public static let appleAsking = "Talos needs a free set of tools from Apple. macOS is showing its own window for it."
  public static let appleClick = "Click Install"
  /// Apple's window asks to Install, then shows its licence with an Agree button: both are named.
  public static let appleClickRest = ", then Agree, in Apple's window. It takes about 5 minutes, then Talos carries on by itself."
  public static let appleNoWindow = "I don't see Apple's window"
  public static let appleInstalling = "macOS is installing Apple's tools. You can leave this window; Talos carries on by itself when it's done."
  public static let appleInstallingLabel = "Installing"
  public static func appleLeft(minutes: Int) -> String { "about \(minutes) \(minutes == 1 ? "minute" : "minutes") left" }
  public static let appleWorking = "Installing, this can take a few minutes"
  public static let appleWindowTitle = "Apple's window looks like this"
  public static let appleWindowText =
    "The \u{201C}xcode-select\u{201D} command requires the command line developer tools. Would you like to install the tools now?"
  public static let appleWindowButtons = ["Cancel", "Install"]
  /// Under the sketch: the second thing Apple's window asks.
  public static let appleWindowAgree = "Then Apple shows a license: click Agree."
  public static let appleFooter = "Only on Macs that don't have these tools yet."
  /// Shown when Apple's window was closed or the install did not finish: one button.
  public static let appleClosed = "Apple's window was closed before the install finished. Press Try again, then click Install and Agree."
  public static let tryAgain = "Try again"
  public static let spaceTitle = "Not enough free space yet"
  public static func spaceBody(have: Int64) -> String {
    "Talos needs about \(ToolsSpace.gb(ToolsSpace.requiredBytes)) GB free on this Mac to install Apple's tools. You have \(ToolsSpace.gb(have)) GB free."
  }
  public static let spaceAnyway = "Try anyway"
  public static let spaceHow = "How to free up space"
  public static let spaceFooter = "Talos asks Apple for its tools once there is room. Try anyway lets Apple\u{2019}s own installer decide."
  public static let details = "Details"

  // 3 Sign in
  public static let signInTitle = "Sign in to Claude"
  public static let signInBody = "Talos runs on your Claude account. Your browser opens; sign in there and come back. Talos notices by itself."
  public static let signInButton = "Sign in with Claude"
  public static let signInWaiting = "Waiting for you in the browser\u{2026}"
  public static let signInNoBrowser = "The browser didn't open? Open the sign-in page"
  public static let signInFooter = "Already signed in on this Mac? Talos skips this step."
  public static let back = "Back"

  public static let signInNotYet = "Still not signed in. Press Sign in with Claude and finish the page in your browser."
  public static let signInCouldNot = "Talos couldn't start the sign-in. Press Sign in with Claude to try again."
  public static let signInCodeSend = "Send code"

  /// What the sign-in step says when a try did not end signed in. nil: nothing to say (the owner cancelled).
  public static func signInMessage(for o: ClaudeSignInPlan.Outcome) -> String? {
    switch o {
    case .alreadySignedIn, .signedIn, .cancelled: return nil
    case .timedOut, .loginEndedNotSignedIn: return signInNotYet
    case .couldNotRun, .statusUnknown, .noClaude: return signInCouldNot
    }
  }

  // 4a Phone
  public static let phoneTitle = "Use Talos on your phone?"
  public static let phoneBody = "Talk to your agent from anywhere, and answer it when it needs you."
  public static let phoneYes = "Yes, on my phone too"
  public static let phoneYesBody = "Your agent will help you connect your phone next. It works with iPhone and Android."
  public static let phoneNo = "Just this Mac for now"
  public static let phoneNoBody = "You can add your phone any time from the Talos menu."

  // 4b Pair
  public static let pairTitle = "Connect your phone"
  public static let pairScanLabel = "Code to scan with your phone's camera"
  public static let pairPoint = "Point your phone's camera here"
  public static let pairSteps = [
    "Scan the code with your phone's camera.", "Tap the link that appears. Talos opens on your phone.",
    "Check that your phone shows these words:",
  ]
  public static let pairMatch = "The words match"
  public static let pairNoMatch = "They don't match"
  public static let pairFooter = "\u{201C}They don't match\u{201D} stops here and makes a new code: nothing is connected."
  public static let pairMaking = "Making a code for your phone\u{2026}"
  public static let pairConnecting = "Connecting your phone\u{2026}"
  public static let pairNoCode = "No code yet. Try again makes a new one."
  public static let pairFailed = "Talos couldn't connect your phone this time. Nothing was connected."

  // Offline
  public static let offlineTitle = "You're offline"
  public static let offlineBody =
    "Talos needs the internet to finish downloading. Check your Wi-Fi; Talos carries on by itself as soon as you're back online."
  public static func offlinePaused(pct: Int) -> String { "Paused at \(pct)%" }
  public static let offlineSafe = "Nothing is lost"
  public static let offlineNote = "Talos checks again every few seconds. You can also try now."
  public static let offlineButton = "Try again now"
  /// A download that stopped for another reason: the one button is the same.
  public static let downloadStopped = "Talos couldn't finish downloading. Nothing is lost; press Try again now."

  // 5 Hello (Main's first message, sent by the agent in the app)
  public static let helloGreeting = [
    "Hi, I'm Talos. I'm running on this Mac, and your phone is connected, so you can reach me from either.",
    "You can start right away: just tell me what you'd like done. Whenever you have a minute, I can also:",
  ]
  public static let helloOffers = [
    "learn a few rules you'd like me to always follow,",
    "get to know how you like things (short answers or detailed ones, your working hours),",
    "ask for a permission only when a task needs it, never all at once.",
  ]
  /// The hello when no phone is connected ("Just this Mac", or a Yes on a Mac with no phone link): no claim that it is, and an offer.
  public static let helloGreetingNoPhone =
    "Hi, I'm Talos. I'm running on this Mac. Your phone isn't connected yet, and I'll help you with that next."
  public static let helloStatusConnected = "Your phone is connected"
  public static let helloStatusNoPhone = "Phone not connected"
  public static let helloAsk = "What should we do first?"
  public static let helloChips = ["Let's set up my rules", "What can you do?", "Later"]
  /// With no phone connected the first suggested reply is the phone.
  public static let helloChipsNoPhone = ["Connect my phone"] + helloChips

  // Advanced and the menu
  public static let menuSetUp = "Set up Talos\u{2026}"
  public static let menuUseFolder = "Use a folder I already have\u{2026}"
  public static let advancedTitle = "Use a folder I already have"

  /// Everything above that a screen can show, for the guard.
  public static var all: [String] {
    var s: [String] = [
      windowTitle, welcomeTitle, welcomeBody, getStarted, robotAlt, readyTitle, readyBody, readyDownloading, readyHome, readyChecking,
      readyFooter, continueButton, appleTitle, appleAsking, appleClick, appleClickRest, appleNoWindow, appleInstalling,
      appleInstallingLabel, appleWorking, appleWindowTitle, appleWindowText, appleWindowAgree, appleFooter, appleClosed, tryAgain, spaceTitle, spaceBody(have: 19_160_000_000), spaceHow, spaceAnyway, spaceFooter, signInTitle, signInBody,
      details, signInButton, signInNotYet, signInCouldNot, signInCodeSend, signInWaiting, signInNoBrowser, signInFooter, back, phoneTitle, phoneBody, phoneYes, phoneYesBody, phoneNo,
      phoneNoBody, pairTitle, pairScanLabel, pairPoint, pairMatch, pairNoMatch, pairFooter, pairMaking, pairConnecting, pairNoCode, pairFailed,
      offlineTitle, offlineBody, offlineSafe, offlineNote, offlineButton, downloadStopped, helloAsk, menuSetUp, menuUseFolder,
      advancedTitle, stepLabel(1), stepLabel(2), stepLabel(3), offlinePaused(pct: 62), appleLeft(minutes: 1), appleLeft(minutes: 3),
      helloGreetingNoPhone, helloStatusConnected, helloStatusNoPhone, readyDetail(pct: 62, secondsLeft: 70), readyDetail(pct: 62, secondsLeft: nil),
    ]
    s += welcomeSteps + appleWindowButtons + pairSteps + helloGreeting + helloOffers + helloChips + helloChipsNoPhone
    return s
  }

  /// Words the owner never sees on these screens (the one-word table in the plain-words list). Whole words, any case.
  public static let forbidden = ["session", "sessions", "bridge", "relay", "tmux", "terminal", "terminals", "launch command", "worker", "pane"]

  /// The forbidden words found in `text`, whole words only ("sessionless" is not "session").
  public static func forbiddenWords(in text: String) -> [String] {
    forbidden.filter { w in
      text.range(of: "(?<![A-Za-z])" + NSRegularExpression.escapedPattern(for: w) + "(?![A-Za-z])", options: [.regularExpression, .caseInsensitive]) != nil
    }
  }
}

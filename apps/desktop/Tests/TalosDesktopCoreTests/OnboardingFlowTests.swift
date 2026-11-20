import Foundation
import Testing

@testable import TalosDesktopCore

/// The new first-run screens as a state machine: each step, each skip, the offline screen, and the four words.
@Suite("Onboarding flow")
struct OnboardingFlowTests {
  private func at(_ events: [OnboardingFlow.Event]) -> OnboardingFlow {
    var f = OnboardingFlow()
    for e in events { f.apply(e) }
    return f
  }

  private let toSignIn: [OnboardingFlow.Event] = [.getStarted, .downloadProgress(pct: 50), .downloadDone(signedIn: false)]
  private let toPhone: [OnboardingFlow.Event] = [.getStarted, .downloadDone(signedIn: false), .signInPressed, .signInEnded(success: true, message: nil)]
  private let toConfirm: [OnboardingFlow.Event] = [
    .getStarted, .downloadDone(signedIn: true), .phoneLinkKnown(true), .choosePhone, .pairLink("https://r.example/enroll#abc"), .pairWords(["amber", "falcon", "river", "stone"]),
  ]

  @Test func startsOnWelcomeWithNoBar() {
    let f = OnboardingFlow()
    #expect(f.step == .welcome)
    #expect(f.stepNumber == nil)
    #expect(f.segments.isEmpty)
  }

  @Test func getStartedBeginsTheDownloadOnce() {
    var f = OnboardingFlow()
    #expect(f.apply(.getStarted) == [.startDownload])
    #expect(f.step == .ready)
    #expect(f.apply(.getStarted).isEmpty)  // a second press starts nothing
  }

  @Test func readyIsStepOneAndProgressOnlyMovesForward() {
    var f = at([.getStarted, .downloadProgress(pct: 40)])
    #expect(f.stepNumber == 1)
    #expect(f.segments == [.current, .todo, .todo])
    f.apply(.downloadProgress(pct: 30))
    #expect(f.download == .running(pct: 40))
    f.apply(.downloadProgress(pct: 250))
    #expect(f.download == .running(pct: 100))
  }

  @Test func continueIsDarkUntilTheWorkIsDone() {
    var f = at([.getStarted, .downloadProgress(pct: 90)])
    #expect(!f.continueLit)
    #expect(f.apply(.continuePressed).isEmpty)
    #expect(f.step == .ready)
    f.apply(.downloadDone(signedIn: false))
    #expect(f.step == .signIn)  // it went on by itself
  }

  // MARK: skips

  @Test func notSignedInShowsTheSignInStep() {
    let f = at(toSignIn)
    #expect(f.step == .signIn)
    #expect(f.segments == [.done, .current, .todo])
    #expect(f.stepNumber == 2)
  }

  @Test func alreadySignedInSkipsStepThree() {
    let f = at([.getStarted, .downloadDone(signedIn: true)])
    #expect(f.step == .phone)
    #expect(f.segments == [.done, .done, .current])
  }

  @Test func anUnknownSignInStateAsksRatherThanAssumes() {
    #expect(at([.getStarted, .downloadDone(signedIn: nil)]).step == .signIn)
  }

  @Test func toolsPresentNeverShowsTheAppleStep() {
    // the provisioner says nothing about Apple's window when the tools are there: only progress and done arrive
    var f = OnboardingFlow()
    var seen: [OnboardingFlow.Step] = []
    for e in [OnboardingFlow.Event.getStarted, .toolsDone, .downloadProgress(pct: 10), .downloadProgress(pct: 60), .downloadDone(signedIn: true)] {
      f.apply(e)
      seen.append(f.step)
    }
    #expect(!seen.contains(.appleTools))
  }

  @Test func toolsMissingShowAskingThenInstallingThenCarryOn() {
    var f = at([.getStarted])
    f.apply(.toolsAsked)
    #expect(f.step == .appleTools)
    #expect(f.tools == .asking)
    #expect(f.stepNumber == 1)  // still step one: the bar does not move
    f.apply(.toolsInstalling(pct: 40))
    #expect(f.tools == .installing(pct: 40))
    f.apply(.toolsInstalling(pct: nil))
    #expect(f.tools == .installing(pct: nil))  // no progress from the system: no made-up number
    f.apply(.toolsDone)
    #expect(f.step == .ready)  // carried on by itself
  }

  @Test func theAppleStepIgnoresEventsFromOtherSteps() {
    var f = at([.getStarted, .downloadDone(signedIn: true)])
    f.apply(.toolsAsked)
    #expect(f.step == .phone)  // a late message from the download never pulls the owner back
  }

  @Test func justThisMacSkipsPairingAndFinishes() {
    var f = at(toPhone)
    #expect(f.step == .phone)
    let effects = f.apply(.chooseThisMacOnly)
    #expect(f.step == .hello)
    #expect(effects == [.finish])
    #expect(!f.phoneConnected)
    #expect(!effects.contains(.startPairing))
  }

  @Test func yesOnMyPhoneStartsOnePairing() {
    var f = at(toPhone + [.phoneLinkKnown(true)])
    #expect(f.apply(.choosePhone) == [.startPairing])
    #expect(f.step == .pair)
    #expect(f.stepNumber == 3)
  }

  @Test func anExistingInstallSkipsOnboarding() {
    #expect(!OnboardingFlow.isNeeded(configured: true))
    #expect(OnboardingFlow.isNeeded(configured: false))
    // an existing install has no in-progress marker, so it stays out; a cut-short setup comes back
    #expect(!OnboardingMarker.isNeeded(configured: true, pending: false))
    #expect(OnboardingMarker.isNeeded(configured: true, pending: true))
    #expect(OnboardingMarker.isNeeded(configured: false, pending: false))
  }

  // MARK: sign-in

  @Test func signInWaitsThenContinuesWhenClaudeIsSignedIn() {
    var f = at(toSignIn)
    #expect(f.apply(.signInPressed) == [.startSignIn])
    #expect(f.signIn == .waiting)
    #expect(f.apply(.signInPressed).isEmpty)  // never a second login
    f.apply(.signInEnded(success: true, message: nil))
    #expect(f.step == .phone)
    #expect(f.signedIn)
  }

  @Test func aFailedSignInStaysWithOneButton() {
    var f = at(toSignIn)
    f.apply(.signInPressed)
    f.apply(.signInEnded(success: false, message: OnboardingCopy.signInNotYet))
    #expect(f.step == .signIn)
    #expect(f.signIn == .failed(OnboardingCopy.signInNotYet))
    #expect(f.apply(.signInPressed) == [.startSignIn])  // the same button tries again
  }

  @Test func talosNoticingTheSignInByItselfMovesOnAndStopsTheLogin() {
    var f = at(toSignIn)
    f.apply(.signInPressed)
    #expect(f.apply(.signedInNoticed) == [.cancelSignIn])
    #expect(f.step == .phone)
  }

  @Test func backFromSignInCancelsAWaitingLogin() {
    var f = at(toSignIn)
    f.apply(.signInPressed)
    #expect(f.apply(.back) == [.cancelSignIn])
    #expect(f.step == .ready)
    #expect(f.continueLit)  // the ready screen is done: Continue is lit
    f.apply(.continuePressed)
    #expect(f.step == .signIn)
  }

  // MARK: offline

  @Test func offlinePausesWhereItWasAndOffersOneButton() {
    var f = at([.getStarted, .downloadProgress(pct: 62)])
    f.apply(.downloadOffline)
    #expect(f.download == .offline(pct: 62))
    #expect(f.step == .ready)
  }

  @Test func tryAgainFromOfflineRestartsTheDownloadKeepingTheBar() {
    var f = at([.getStarted, .downloadProgress(pct: 62), .downloadOffline])
    #expect(f.apply(.tryAgain) == [.startDownload])
    #expect(f.download == .running(pct: 62))
    #expect(f.apply(.tryAgain).isEmpty)  // pressed again while it runs: nothing starts twice
  }

  @Test func anotherStopHasTheSameOneButton() {
    var f = at([.getStarted, .downloadProgress(pct: 30), .downloadFailed("x")])
    #expect(f.download == .failed(pct: 30, message: "x"))
    #expect(f.apply(.tryAgain) == [.startDownload])
  }

  @Test func aLateProgressReportNeverUndoesAStop() {
    var f = at([.getStarted, .downloadProgress(pct: 40), .downloadOffline])
    f.apply(.downloadProgress(pct: 45))  // the report was in flight when the stop landed
    f.apply(.toolsAsked)
    #expect(f.download == .offline(pct: 40))
    #expect(f.step == .ready)
    var g = at([.getStarted, .downloadFailed("x")])
    g.apply(.downloadProgress(pct: 90))
    if case .failed = g.download {} else { Issue.record("a late report flipped a failure back to running") }
    var h = at([.getStarted, .downloadDone(signedIn: true)])
    h.apply(.downloadProgress(pct: 10))
    h.apply(.toolsAsked)
    #expect(h.step == .phone)
  }

  @Test func offlineDuringAppleInstallReturnsToTheDownloadScreen() {
    let f = at([.getStarted, .toolsAsked, .downloadOffline])
    #expect(f.step == .ready)
    if case .offline = f.download {} else { Issue.record("expected offline") }
  }

  // MARK: the four words

  @Test func theFourWordsAppearOnlyAfterTheCode() {
    var f = at(toPhone + [.phoneLinkKnown(true), .choosePhone])
    f.apply(.pairWords(["a", "b", "c", "d"]))  // words with no code yet: ignored
    #expect(f.pair == .starting)
    f.apply(.pairLink("https://r.example/enroll#abc"))
    f.apply(.pairWords(["amber", "falcon", "river", "stone"]))
    #expect(f.pair == .confirm(link: "https://r.example/enroll#abc", words: ["amber", "falcon", "river", "stone"]))
  }

  @Test func anIncompleteWordListIsIgnored() {
    var f = at(toConfirm)
    f.apply(.pairWords(["amber", "falcon"]))
    if case .confirm(_, let w) = f.pair { #expect(w.count == 4) } else { Issue.record("left confirm") }
  }

  @Test func theWordsMatchConfirmsOnceThenConnects() {
    var f = at(toConfirm)
    #expect(f.apply(.wordsMatch) == [.confirmWords])
    #expect(f.pair == .connecting)
    #expect(f.apply(.wordsMatch).isEmpty)  // a second yes writes nothing
    #expect(f.apply(.pairConnected) == [.finish])
    #expect(f.step == .hello)
    #expect(f.phoneConnected)
  }

  @Test func theyDontMatchMakesANewCodeAndConnectsNothing() {
    var f = at(toConfirm)
    let effects = f.apply(.wordsDontMatch)
    #expect(effects == [.declineWords, .startPairing])
    #expect(!effects.contains(.confirmWords))
    #expect(!effects.contains(.finish))
    #expect(f.step == .pair)
    #expect(f.pair == .starting)  // the old code and its words are gone
    #expect(!f.phoneConnected)
    // a late "connected" from the cancelled run must not connect anything
    #expect(f.apply(.pairConnected).isEmpty)
    #expect(f.step == .pair)
    #expect(!f.phoneConnected)
  }

  @Test func theyDontMatchNeedsTheWordsOnScreen() {
    var f = at(toPhone + [.phoneLinkKnown(true), .choosePhone])
    #expect(f.apply(.wordsDontMatch).isEmpty)  // no question open: nothing to decline
    #expect(f.apply(.wordsMatch).isEmpty)  // and nothing to confirm
  }

  @Test func connectedBeforeAYesIsIgnored() {
    var f = at(toConfirm)
    #expect(f.apply(.pairConnected).isEmpty)
    #expect(f.step == .pair)
    #expect(!f.phoneConnected)
  }

  @Test func aFailedPairingOffersTryAgainWithANewCode() {
    var f = at(toConfirm)
    f.apply(.pairFailed("no"))
    #expect(f.pair == .failed("no"))
    #expect(f.retryPairing() == [.startPairing])
    #expect(f.pair == .starting)
    #expect(f.retryPairing().isEmpty)
  }

  @Test func backFromPairingCancelsTheCode() {
    var f = at(toConfirm)
    #expect(f.apply(.back) == [.cancelPairing])
    #expect(f.step == .phone)
  }

  @Test func backFromPhoneNeverReturnsToASignInThatIsAlreadyDone() {
    var f = at(toPhone)  // signed in during this run
    f.apply(.back)
    #expect(f.step == .ready)
    #expect(f.continueLit)
    f.apply(.continuePressed)
    #expect(f.step == .phone)  // Continue goes forward again, past the finished sign-in
    var g = at([.getStarted, .downloadDone(signedIn: true)])  // sign-in was skipped
    g.apply(.back)
    #expect(g.step == .ready)
  }

  // MARK: pieces

  @Test func theThreeLinesFollowTheBar() {
    #expect(OnboardingFlow.readyLines(pct: 10, done: false) == [.active, .waiting, .waiting])
    #expect(OnboardingFlow.readyLines(pct: 62, done: false) == [.done, .active, .waiting])
    #expect(OnboardingFlow.readyLines(pct: 92, done: false) == [.done, .done, .active])
    #expect(OnboardingFlow.readyLines(pct: 100, done: true) == [.done, .done, .done])
  }

  @Test func timeLeftIsOnlyShownWhenItIsHonest() {
    #expect(OnboardingCopy.secondsLeft(pct: 5, elapsed: 60) == nil)
    #expect(OnboardingCopy.secondsLeft(pct: 50, elapsed: 2) == nil)
    #expect(OnboardingCopy.secondsLeft(pct: 50, elapsed: 60) == 60)
    #expect(OnboardingCopy.readyDetail(pct: 62, secondsLeft: nil) == "62%")
    #expect(OnboardingCopy.readyDetail(pct: 62, secondsLeft: 70) == "62% · about 1 minute left")
    #expect(OnboardingCopy.readyDetail(pct: 90, secondsLeft: 20) == "90% · less than a minute left")
    #expect(OnboardingCopy.readyDetail(pct: 30, secondsLeft: 300) == "30% · about 5 minutes left")
  }

  @Test func yesOnAFreshMacGoesStraightToHelloWithNoPhoneConnected() {
    var f = at(toPhone)  // no phone link known: the default
    let effects = f.apply(.choosePhone)
    #expect(f.step == .hello)
    #expect(effects == [.finish])
    #expect(!effects.contains(.startPairing))
    #expect(!f.phoneConnected)  // so the hello says the phone is not connected
  }

  @Test func theHelloRequestCarriesOnlyThePhoneState() throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    for phone in [true, false] {
      let o = try #require(try JSONSerialization.jsonObject(with: FirstHello.requestBody(phoneConnected: phone, now: now)) as? [String: Any])
      #expect(Set(o.keys) == ["v", "action", "phone", "ts"])  // no text, nothing to change what the agent is told
      #expect(o["phone"] as? String == (phone ? "connected" : "not_connected"))
      #expect(o["action"] as? String == "hello")
    }
  }

  @Test func theHelloRequestIsWrittenPrivateAndWhole() throws {
    let home = NSTemporaryDirectory() + "talos-ob-test-" + UUID().uuidString
    defer { try? FileManager.default.removeItem(atPath: home) }
    #expect(FirstHello.writeRequest(talosHome: home, phoneConnected: false))
    let path = FirstHello.requestPath(talosHome: home)
    let mode = try #require(try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber).intValue
    #expect(mode == 0o600)
    let dir = try #require(try FileManager.default.attributesOfItem(atPath: home + "/onboarding")[.posixPermissions] as? NSNumber).intValue
    #expect(dir == 0o700)
    let left = try FileManager.default.contentsOfDirectory(atPath: home + "/onboarding")
    #expect(left == ["hello.json"])  // no temporary file left behind
  }

  // MARK: the hello stays pending until the bridge takes it

  @Test func helloIsAskedWhenTheConnectionIsUpAndDoneWhenTheRequestIsTaken() {
    let p = HelloDelivery.Pending(phoneConnected: false)
    #expect(HelloDelivery.next(p, bridgeUp: false, requestExists: false, now: 100) == .nothing)  // not up: keep it pending
    #expect(HelloDelivery.next(p, bridgeUp: true, requestExists: false, now: 100) == .write(phoneConnected: false))
    let written = HelloDelivery.Pending(phoneConnected: false, writtenAt: 100)
    #expect(HelloDelivery.next(written, bridgeUp: true, requestExists: true, now: 200) == .nothing)  // waiting for the bridge
    #expect(HelloDelivery.next(written, bridgeUp: true, requestExists: false, now: 200) == .done)  // the bridge took it
    #expect(HelloDelivery.next(written, bridgeUp: true, requestExists: true, now: 100 + 9 * 60) == .write(phoneConnected: false))  // too old to be read
    #expect(HelloDelivery.next(nil, bridgeUp: true, requestExists: false, now: 1) == .nothing)
  }

  @Test func helloRetriesAcrossLaunchesUntilSentOnce() {
    let home = NSTemporaryDirectory() + "talos-ob-test-" + UUID().uuidString
    let talos = NSTemporaryDirectory() + "talos-ob-test-" + UUID().uuidString
    defer {
      try? FileManager.default.removeItem(atPath: home)
      try? FileManager.default.removeItem(atPath: talos)
    }
    HelloDelivery.save(.init(phoneConnected: true), home: home)
    #expect(HelloDelivery.tick(home: home, talosHome: talos, bridgeUp: false) == .nothing)  // bridge not up at the end of setup
    #expect(!FileManager.default.fileExists(atPath: FirstHello.requestPath(talosHome: talos)))
    #expect(HelloDelivery.read(home: home) != nil)  // still pending (a quit and relaunch finds it)
    #expect(HelloDelivery.tick(home: home, talosHome: talos, bridgeUp: true) == .write(phoneConnected: true))
    #expect(FileManager.default.fileExists(atPath: FirstHello.requestPath(talosHome: talos)))
    #expect(HelloDelivery.tick(home: home, talosHome: talos, bridgeUp: true) == .nothing)
    try? FileManager.default.removeItem(atPath: FirstHello.requestPath(talosHome: talos))  // what the bridge does when it takes it
    #expect(HelloDelivery.tick(home: home, talosHome: talos, bridgeUp: true) == .done)
    #expect(HelloDelivery.read(home: home) == nil)  // sent once: never asked again
    #expect(HelloDelivery.tick(home: home, talosHome: talos, bridgeUp: true) == .nothing)
  }

  // MARK: the launch rule and the marker

  @Test func theLaunchRulePrefersConfiguredOverTheMarker() {
    #expect(OnboardingLaunch.shouldOpen(configured: false, pending: false, shownThisRun: false))  // fresh Mac
    #expect(!OnboardingLaunch.shouldOpen(configured: true, pending: false, shownThisRun: false))  // an existing install
    #expect(OnboardingLaunch.shouldOpen(configured: true, pending: true, shownThisRun: false))  // a setup cut short
    #expect(!OnboardingLaunch.shouldOpen(configured: false, pending: true, shownThisRun: true))  // once per launch
  }

  @Test func aSetupDoneAnotherWayClearsTheMarkerButTheFlowsOwnConfigDoesNot() {
    let home = NSTemporaryDirectory() + "talos-ob-test-" + UUID().uuidString
    defer { try? FileManager.default.removeItem(atPath: home) }
    OnboardingMarker.set(home: home)
    OnboardingLaunch.settle(configured: true, flowActive: true, home: home)  // the new screens made the folder: still going
    #expect(OnboardingMarker.isPending(home: home))
    OnboardingLaunch.settle(configured: false, flowActive: false, home: home)
    #expect(OnboardingMarker.isPending(home: home))  // not set up: nothing to settle
    OnboardingLaunch.settle(configured: true, flowActive: false, home: home)  // the Advanced route finished
    #expect(!OnboardingMarker.isPending(home: home))
    #expect(!OnboardingLaunch.shouldOpen(configured: true, pending: OnboardingMarker.isPending(home: home), shownThisRun: false))
  }

  @Test func theNotConnectedHelloPutsThePhoneFirst() {
    #expect(OnboardingCopy.helloChipsNoPhone.first == "Connect my phone")
    #expect(Array(OnboardingCopy.helloChipsNoPhone.dropFirst()) == OnboardingCopy.helloChips)
    #expect(OnboardingCopy.helloStatusNoPhone == "Phone not connected")
    #expect(OnboardingCopy.pairNoCode == "No code yet. Try again makes a new one.")
  }

  @Test func aSetupTheOwnerClosedOnPurposeIsNotOpenedAgainByLaunchButACrashedOneIs() {
    let home = NSTemporaryDirectory() + "talos-ob-test-" + UUID().uuidString
    defer { try? FileManager.default.removeItem(atPath: home) }
    #expect(!OnboardingDismissal.isSet(home: home))
    // a crash mid-setup: the marker is there, nothing says it was closed on purpose
    #expect(OnboardingLaunch.shouldOpen(configured: true, pending: true, shownThisRun: false, dismissed: OnboardingDismissal.isSet(home: home)))
    OnboardingDismissal.set(home: home)  // the close button
    #expect(!OnboardingLaunch.shouldOpen(configured: false, pending: false, shownThisRun: false, dismissed: OnboardingDismissal.isSet(home: home)))
    #expect(!OnboardingLaunch.shouldOpen(configured: true, pending: true, shownThisRun: false, dismissed: OnboardingDismissal.isSet(home: home)))
    OnboardingDismissal.clear(home: home)  // the menu opened it again
    #expect(OnboardingLaunch.shouldOpen(configured: false, pending: false, shownThisRun: false, dismissed: OnboardingDismissal.isSet(home: home)))
  }

  @Test func aFailedDownloadIsNotASetupInProgressSoAnAdvancedSetupClearsTheMarker() {
    var f = at([.getStarted, .downloadProgress(pct: 30)])
    #expect(f.isActive)  // mid-download
    f.apply(.downloadOffline)
    #expect(f.isActive)  // waiting for the internet, going on by itself
    f.apply(.tryAgain)
    f.apply(.downloadFailed("x"))
    #expect(!f.isActive)  // stopped on a failure
    #expect(!OnboardingFlow().isActive)
    #expect(at([.getStarted, .toolsAsked]).isActive)
    #expect(at(toSignIn).isActive)
    let home = NSTemporaryDirectory() + "talos-ob-test-" + UUID().uuidString
    defer { try? FileManager.default.removeItem(atPath: home) }
    OnboardingMarker.set(home: home)
    OnboardingLaunch.settle(configured: true, flowActive: f.isActive, home: home)  // the Advanced route finished after the failure
    #expect(!OnboardingMarker.isPending(home: home))
    OnboardingMarker.set(home: home)
    OnboardingLaunch.settle(configured: true, flowActive: at(toSignIn).isActive, home: home)  // mid-setup: kept
    #expect(OnboardingMarker.isPending(home: home))
  }

  @Test func theStepFourWordsAreTheUpdatedMocks() {
    #expect(OnboardingCopy.phoneBody == "Talk to your agent from anywhere, and answer it when it needs you.")
    #expect(OnboardingCopy.phoneYesBody == "Your agent will help you connect your phone next. It works with iPhone and Android.")
    #expect(!OnboardingCopy.phoneBody.contains("by itself"))
  }

  @Test func theMarkerIsWrittenAndCleared() throws {
    let home = NSTemporaryDirectory() + "talos-ob-test-" + UUID().uuidString
    defer { try? FileManager.default.removeItem(atPath: home) }
    #expect(!OnboardingMarker.isPending(home: home))
    #expect(OnboardingMarker.set(home: home))
    #expect(OnboardingMarker.isPending(home: home))
    OnboardingMarker.clear(home: home)
    #expect(!OnboardingMarker.isPending(home: home))
  }

  @Test func chronosIsAddedWithItsOwnRunAndNeverBlocksTheAgent() {
    let a = AgentFolderSetup.chronosArguments(repo: "/home/alex/talos", dir: "/home/alex/talos-agent")
    #expect(a == ["/home/alex/talos/install.sh", "--agent-dir", "/home/alex/talos-agent", "--no-app", "--yes", "--with-chronos"])
    #expect(!AgentFolderSetup.installArguments(repo: "/r", dir: "/d").contains("--with-chronos"))  // Create itself stays as it was
  }
}

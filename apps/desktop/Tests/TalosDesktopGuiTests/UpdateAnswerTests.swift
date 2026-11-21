import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop

/// "Check for Updates" always answers. Not gated: no window is opened, the controller is driven directly, as the About button and the
/// update window's Check again drive it. A fresh `UpdateController` with no updater behind it is the app before sign-in.
@MainActor
@Suite("Check for Updates always answers", .serialized)
struct UpdateAnswerTests {
  func controller() -> UpdateController {
    let uc = UpdateController()
    uc.orderFront = { _ in }
    return uc
  }

  /// Waits (up to `seconds`) for the status to leave idle and checking.
  func answer(_ uc: UpdateController, seconds: Double = 3) async -> UpdateStatus {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if uc.status != .idle, uc.status != .checking { break }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return uc.status
  }

  /// A look at the feed that answers when the test lets it.
  func fake(_ r: UpdateProbeResult) -> @Sendable () -> UpdateProbeResult { { r } }

  @Test func beforeSignInTheAboutButtonGetsAnAnswer() async {
    let uc = controller()  // no updater, no agent, nothing running
    uc.checkFromAbout()
    let s = await answer(uc)
    #expect(s != .idle && s != .checking, "got no answer: \(s)")
    #expect(s == .couldntCheck(.other), "nothing to look with is said, not hidden")
  }

  @Test func theMenuAndCheckAgainAnswerToo() async {
    let uc = controller()
    uc.probe = fake(.upToDate("0.1.8"))
    uc.startCheck()
    #expect(await answer(uc) == .upToDate(version: "0.1.8"))
    uc.checkAgain()
    #expect(uc.status == .checking, "Check again starts a new look")
    #expect(await answer(uc) == .upToDate(version: "0.1.8"))
    #expect(uc.checksStarted == 2)
  }

  @Test func upToDateSaysTheRunningVersion() async {
    let uc = controller()
    uc.probe = fake(.upToDate("0.1.8"))
    uc.startCheck()
    let s = await answer(uc)
    #expect(s.words.headline == "Talos is up to date (0.1.8)")
  }

  @Test func aNewerVersionWithAutomaticUpdatesOffIsSaidWithItsVersion() async {
    let uc = controller()
    uc.updatesAreOn = { false }
    uc.probe = fake(.newer("0.1.9"))
    uc.startCheck()
    let s = await answer(uc)
    #expect(s == .available(version: "0.1.9"))
    #expect(s.words.headline == "Talos 0.1.9 is available" && s.words.detail.contains("Automatic updates are off"))
  }

  @Test func aNewerVersionWithNoUpdaterIsSaidToo() async {
    let uc = controller()  // updates on, but nothing to download with
    uc.probe = fake(.newer("0.1.9"))
    uc.startCheck()
    #expect(await answer(uc) == .available(version: "0.1.9"))
  }

  @Test func eachProblemGetsItsOwnPlainWords() async {
    let cases: [(UpdateStatus.CheckProblem, String)] = [
      (.offline, "offline"), (.server, "update server"), (.unverified, "couldn\u{2019}t be verified"), (.other, "Something went wrong"),
    ]
    for (p, word) in cases {
      let uc = controller()
      uc.probe = fake(.problem(p))
      uc.startCheck()
      let s = await answer(uc)
      #expect(s == .couldntCheck(p))
      #expect(s.words.detail.contains(word), "\(p): \(s.words.detail)")
    }
  }

  @Test func aLookThatNeverReturnsEndsInCouldntCheckAfterTheTimeout() async {
    let uc = controller()
    uc.checkTimeout = 0.3
    let release = DispatchSemaphore(value: 0)
    uc.probe = {
      release.wait()
      return .upToDate("0.1.8")
    }
    uc.startCheck()
    #expect(uc.status == .checking)
    let s = await answer(uc, seconds: 3)
    #expect(s == .couldntCheck(.timedOut), "never an endless spinner: \(s)")
    release.signal()  // the stalled look returns late: it must not overwrite what the owner was told
    try? await Task.sleep(nanoseconds: 200_000_000)
    #expect(uc.status == .couldntCheck(.timedOut))
    // and Try again works afterwards
    uc.probe = fake(.upToDate("0.1.8"))
    uc.checkAgain()
    #expect(await answer(uc) == .upToDate(version: "0.1.8"))
  }

  @Test func aSecondPressWhileCheckingIsTheSameCheck() async {
    let uc = controller()
    let release = DispatchSemaphore(value: 0)
    uc.probe = {
      release.wait()
      return .upToDate("0.1.8")
    }
    uc.checkFromAbout()
    uc.checkFromAbout()
    uc.checkAgain()
    #expect(uc.checksStarted == 1)
    release.signal()
    #expect(await answer(uc) == .upToDate(version: "0.1.8"))
  }

  @Test func theCheckButtonReadsTryAgainAfterAFailure() {
    #expect(AboutCopy.checkButtonTitle(.couldntCheck(.offline)) == "Try again")
    #expect(AboutCopy.checkButtonTitle(.upToDate(version: "0.1.8")) == "Check for Updates")
  }

  // MARK: the hand-off after a newer version is found (R1-5, R1-6)

  final class Count: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var value: Int { lock.withLock { n } }
    func bump() { lock.withLock { n += 1 } }
  }

  /// A real updater whose feed fetch counts itself and takes `delay` seconds, then fails (nothing is on the network here).
  func updater(delay: Double, fetches: Count, on uc: UpdateController) -> AutoUpdater {
    let home = NSTemporaryDirectory() + "talos-ua-\(UUID().uuidString.prefix(8))"
    let o = AutoUpdater.Options(talosHome: home, appPath: home + "/Talos.app", appVersion: "0.1.8", keys: ReleaseTrust.keys)
    var h = AutoUpdater.Hooks(settings: { (true, nil) }, checkout: { nil }, look: { [] }, post: { _ in }, env: { [:] })
    h.fetch = { _, _, _ in
      fetches.bump()
      Thread.sleep(forTimeInterval: delay)
      return nil
    }
    h.onStatus = { s in Task { @MainActor in uc.apply(s) } }
    return AutoUpdater(options: o, hooks: h)
  }

  @Test func beforeSetupANewerVersionIsAnnouncedAndNothingIsStartedOrOffered() async {
    let uc = controller()
    let fetches = Count()
    let u = updater(delay: 0, fetches: fetches, on: uc)
    uc.updater = u
    uc.isSetUp = { false }
    uc.probe = fake(.newer("0.1.9"))
    uc.startCheck()
    let s = await answer(uc)
    #expect(s == .availableAfterSetup(version: "0.1.9"))
    #expect(s.words.headline == "Talos 0.1.9 is available" && s.words.detail == "It will be installed after setup.")
    try? await Task.sleep(nanoseconds: 300_000_000)
    #expect(fetches.value == 0, "the full check was never started")
    #expect(s.pendingVersion == nil && !AboutCopy.offersUpdateNow(s), "no Install to press")
  }

  @Test func onceTheProbeHandsOffTheTimeoutNoLongerCutsTheFullCheckOff() async {
    let uc = controller()
    uc.checkTimeout = 0.2
    let fetches = Count()
    let u = updater(delay: 0.8, fetches: fetches, on: uc)  // the full check outlasts the timeout
    uc.updater = u
    uc.probe = fake(.newer("0.1.9"))
    uc.startCheck()
    try? await Task.sleep(nanoseconds: 100_000_000)
    #expect(uc.status == .fetching(version: "0.1.9") || uc.status == .checking, "\(uc.status)")
    try? await Task.sleep(nanoseconds: 500_000_000)  // past the timeout
    #expect(uc.status != .couldntCheck(.timedOut), "the watchdog was stopped at the hand-off")
    #expect(uc.status.words.headline.hasPrefix("Getting Talos 0.1.9") || uc.status == .checking, "\(uc.status)")
    // the updater's own answer arrives (here: its feed is unreachable)
    let end = Date().addingTimeInterval(5)
    while Date() < end, uc.status.isBusy { try? await Task.sleep(nanoseconds: 50_000_000) }
    #expect(!uc.status.isBusy && uc.status != .couldntCheck(.timedOut), "\(uc.status)")
    #expect(fetches.value >= 1)
    u.stop()
  }

  @Test func tryAgainAfterATimeoutIsOneCheckHoweverOftenItIsPressed() async {
    let uc = controller()
    uc.checkTimeout = 0.2
    let release = DispatchSemaphore(value: 0)
    uc.probe = {
      release.wait()
      return .upToDate("0.1.8")
    }
    uc.startCheck()
    #expect(await answer(uc) == .couldntCheck(.timedOut))
    let before = uc.checksStarted
    uc.checkAgain()
    uc.checkAgain()
    uc.checkFromAbout()
    #expect(uc.checksStarted == before + 1, "one new check, not three")
    release.signal()
    release.signal()  // the first, stalled look returns too: it must not answer for the new check
    try? await Task.sleep(nanoseconds: 100_000_000)
    release.signal()
  }
}

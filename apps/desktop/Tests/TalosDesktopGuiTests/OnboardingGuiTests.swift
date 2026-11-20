import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

@testable import TalosDesktop

/// A pairing that records what the coordinator asked of it. `approveResult` false is the real one's refusal of a click that is not the
/// owner's hand; the real refusals are proven against the real controller below (`LivePhonePairingGuiTests`).
@MainActor
final class FakePairing: PhonePairing {
  var onEvent: ((OnboardingFlow.Event) -> Void)?
  var starts = 0
  var declines = 0
  var cancels = 0
  var approveCalls = 0
  var approveResult = true
  func start() { starts += 1 }
  func approve(event: NSEvent?, button: NSButton) -> Bool {
    approveCalls += 1
    return approveResult
  }
  func decline() { declines += 1 }
  func cancel() { cancels += 1 }
}

/// Apple's installer helper as the system's running-app list would answer: "running" only from the moment a test says so, and it
/// records every raise. It refuses (false) to activate an app that is not running, as the real list does.
final class FakeApps: AppActivating, @unchecked Sendable {
  private let lock = NSLock()
  private var _running = false
  private var _activations = 0
  private var _asked: [String] = []
  var running: Bool {
    get { lock.withLock { _running } }
    set { lock.withLock { _running = newValue } }
  }
  var activations: Int { lock.withLock { _activations } }
  var asked: [String] { lock.withLock { _asked } }
  func isRunning(bundleID: String) -> Bool { lock.withLock { _running && bundleID == AppleInstallerFront.bundleID } }
  func activate(bundleID: String) -> Bool {
    lock.withLock {
      _asked.append(bundleID)
      guard _running, bundleID == AppleInstallerFront.bundleID else { return false }
      _activations += 1
      return true
    }
  }
}

@MainActor
final class Counts {
  var reinstalls = 0
  var provisions = 0
  var agentStarts = 0
  var shown = 0
  var closed = 0
  var markerDuringProvision: [Bool] = []
  var ignoredSpace: [Bool] = []
  var hellos: [Bool] = []
}

/// The coordinator on scratch deps: nothing here starts claude, opens a browser or touches the network.
@Suite("Onboarding coordinator", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct OnboardingCoordinatorGuiTests {
  func home() -> String {
    (TestTemp.base as NSString).appendingPathComponent("talos-ob-home-" + UUID().uuidString.prefix(8))
  }

  func make(
    provisions: [ProvisionOutcome], signedIn: Bool? = true, online: @escaping () -> Bool = { true }, signIn: ClaudeSignInCoordinator = .init(),
    claude: String? = nil, tools: [OnboardingCoordinator.ToolsSignal] = [], toolsInstalling: @escaping () -> Bool = { false },
    gate: (@MainActor () async -> Void)? = nil, relay: Bool = true, apps: FakeApps = FakeApps()
  ) -> (OnboardingCoordinator, FakePairing, Counts, String) {
    let c = Counts()
    let h = home()
    let pairing = FakePairing()
    var d = OnboardingCoordinator.Deps(pairing: pairing)
    d.home = h
    var queue = provisions
    d.provision = { progress, toolsSignal, ignoreSpace in
      c.provisions += 1
      c.ignoredSpace.append(ignoreSpace)
      c.markerDuringProvision.append(OnboardingMarker.isPending(home: h))
      // the live run reports no progress before it stops for want of space (OnboardingLive.provision checks first)
      if case .needSpace? = queue.first {} else { progress(40) }
      for t in tools where c.provisions == 1 { toolsSignal(t) }
      if let gate { await gate() }
      if !tools.isEmpty { toolsSignal(.done) }
      return queue.isEmpty ? .ok : queue.removeFirst()
    }
    d.isOnline = { online() }
    d.checkSignIn = { .init(claude: claude, env: ProcessInfo.processInfo.environment, signedIn: signedIn) }
    d.signIn = signIn
    d.startAgent = {
      c.agentStarts += 1
      return true
    }
    d.showTalos = { c.shown += 1 }
    d.hasRelay = { relay }
    d.requestHello = { c.hellos.append($0) }
    d.closeWindow = { c.closed += 1 }
    d.offlinePoll = 0.05
    d.toolsPoll = 0.05
    d.toolsInstalling = toolsInstalling
    d.appleApps = apps
    d.askAppleAgain = { c.reinstalls += 1 }
    d.readyHold = 0.15
    d.frontInterval = 0.02
    return (OnboardingCoordinator(deps: d), pairing, c, h)
  }

  @Test func alreadySignedInGoesWelcomeToPhoneToDoneAndStartsTheAgentOnce() async throws {
    let (co, pairing, c, h) = make(provisions: [.ok], signedIn: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    #expect(c.markerDuringProvision == [true])  // a quit while it runs reopens setup
    co.actions.chooseThisMacOnly()
    #expect(co.flow.step == .hello)
    #expect(c.agentStarts == 1)
    #expect(c.shown == 1)
    #expect(c.closed == 1)
    #expect(pairing.starts == 0)  // "just this Mac" pairs nothing
    #expect(!OnboardingMarker.isPending(home: h))  // setup is over
    co.send(.getStarted)
    co.actions.chooseThisMacOnly()
    #expect(c.agentStarts == 1)  // never a second start
  }

  @Test func offlineShowsTheScreenAndTryAgainRunsTheDownloadAgain() async throws {
    var online = false
    let (co, _, c, h) = make(provisions: [.failed(message: "x", onTools: false), .ok], signedIn: true, online: { online })
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { if case .offline = co.flow.download { return true } else { return false } })
    #expect(c.provisions == 1)
    online = true  // the one button, pressed before the automatic check noticed
    co.actions.tryAgain()
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    #expect(c.provisions == 2)
    #expect(co.flow.download == .done)
  }

  @Test func offlineGoesOnByItselfWhenTheInternetComesBack() async throws {
    var online = false
    let (co, _, c, h) = make(provisions: [.failed(message: "x", onTools: false), .ok], signedIn: true, online: { online })
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { if case .offline = co.flow.download { return true } else { return false } })
    await pump(0.3)
    #expect(c.provisions == 1)  // still offline: nothing was started again
    online = true
    #expect(await pumpUntil(4) { co.flow.step == .phone })
    #expect(c.provisions == 2)
  }

  @Test func aStopWhileOnlineIsNotCalledOffline() async throws {
    let (co, _, c, h) = make(provisions: [.failed(message: "The download failed.", onTools: false), .ok], signedIn: true, online: { true })
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { if case .failed = co.flow.download { return true } else { return false } })
    #expect(co.extras.failureDetail == "The download failed.")
    co.actions.tryAgain()
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    #expect(c.provisions == 2)
  }

  /// Short of room: the Apple step says so and Apple's installer is not asked (no tools signal at all) until Try again finds room.
  @Test func notEnoughSpaceHoldsBackAppleAndTryAgainChecksAgain() async throws {
    let (co, _, c, h) = make(provisions: [.needSpace(have: 19_160_000_000), .needSpace(have: 19_160_000_000), .ok], signedIn: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    var opened: [URL] = []
    co.setOpenURL { opened.append($0) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.tools == .needSpace(have: 19_160_000_000) })
    #expect(co.flow.step == .appleTools)
    #expect(c.provisions == 1 && c.reinstalls == 0)
    co.actions.recheckSpace()  // still short: the same screen, a second look
    #expect(await pumpUntil(3) { c.provisions == 2 })
    #expect(co.flow.tools == .needSpace(have: 19_160_000_000))
    co.actions.openStorage()
    #expect(opened.map(\.absoluteString) == ["x-apple.systempreferences:com.apple.settings.Storage"])
    #expect(c.ignoredSpace == [false, false])  // Try again keeps the check
    co.actions.recheckSpace()  // room now: the run goes on
    #expect(await pumpUntil(5) { co.flow.step == .phone })
    #expect(c.provisions == 3)
  }

  /// The 20 GB gate is soft: Try anyway runs the install without the check, so Apple's own installer decides.
  @Test func tryAnywayRunsAppleWithoutTheSpaceCheck() async throws {
    let (co, _, c, h) = make(provisions: [.needSpace(have: 19_160_000_000), .ok], signedIn: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.tools == .needSpace(have: 19_160_000_000) })
    co.actions.tryAnyway()
    #expect(await pumpUntil(5) { co.flow.step == .phone })
    #expect(c.ignoredSpace == [false, true], "the first run checked, the second skipped the check")
    co.actions.tryAnyway()  // not on that screen any more: nothing happens
    #expect(c.provisions == 2)
  }

  @Test func appleToolsAskThenInstallThenTheDownloadCarriesOn() async throws {
    var installing = false
    var release = false
    let (co, _, _, h) = make(
      provisions: [.ok], signedIn: true, tools: [.asking], toolsInstalling: { installing },
      gate: { while !release { try? await Task.sleep(nanoseconds: 20_000_000) } })
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .appleTools })
    #expect(co.flow.tools == .asking)
    #expect(co.flow.stepNumber == 1)
    installing = true  // macOS began installing
    #expect(await pumpUntil(3) { co.flow.tools == .installing(pct: nil) })
    release = true  // Apple's install finished: the stub reports it done
    #expect(await pumpUntil(5) { co.flow.step == .phone })  // carried on by itself, nothing pressed
  }

  @Test func appleToolsAskBringsAppleInstallerForwardOnceItAppearsAndWeStayBehindIt() async throws {
    let apps = FakeApps()
    var release = false
    let (co, _, _, h) = make(provisions: [.ok], signedIn: true, tools: [.asking], gate: { while !release { try? await Task.sleep(nanoseconds: 20_000_000) } }, apps: apps)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .appleTools })
    #expect(apps.activations == 0, "Apple's helper is not up yet: nothing to raise, and it keeps looking")
    #expect(await pumpUntil(1) { apps.asked.count >= 3 })
    apps.running = true  // Apple's window opened behind ours
    #expect(await pumpUntil(3) { apps.activations >= 1 }, "it is raised without the owner pressing anything")
    #expect(apps.asked.allSatisfy { $0 == "com.apple.dt.CommandLineTools.installondemand" })
    release = true
    #expect(await pumpUntil(5) { co.flow.step == .phone })
  }

  @Test func iDontSeeAppleWindowRaisesAppleWhenItRunsAndOnlyAsksAgainWhenItDoesNot() async throws {
    let apps = FakeApps()
    var release = false
    let (co, _, c, h) = make(provisions: [.ok], signedIn: true, tools: [.asking], gate: { while !release { try? await Task.sleep(nanoseconds: 20_000_000) } }, apps: apps)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .appleTools })
    apps.running = true
    #expect(await pumpUntil(3) { apps.activations >= 1 })
    let before = apps.activations
    co.actions.showAppleWindow()
    #expect(await pumpUntil(3) { apps.activations > before }, "the link raises Apple's window again")
    #expect(c.reinstalls == 0, "Apple's installer is running: macOS is not asked to start another")
    apps.running = false  // the installer is gone (closed)
    co.actions.showAppleWindow()
    #expect(c.reinstalls == 1, "not running: only then is the install asked for again")
    release = true
    #expect(await pumpUntil(5) { co.flow.step == .phone })
  }

  @Test func afterAppleToolsTheFinishedGettingReadyScreenShowsBeforeSignIn() async throws {
    var release = false
    let (co, _, _, h) = make(provisions: [.ok], signedIn: false, tools: [.asking], gate: { while !release { try? await Task.sleep(nanoseconds: 20_000_000) } })
    defer { try? FileManager.default.removeItem(atPath: h) }
    var seen: [OnboardingFlow.Step] = []
    let watch = Task { @MainActor in
      while !Task.isCancelled { if seen.last != co.flow.step { seen.append(co.flow.step) }; try? await Task.sleep(nanoseconds: 5_000_000) }
    }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .appleTools })
    release = true
    #expect(await pumpUntil(5) { co.flow.step == .signIn })
    await pump(0.05)  // the watcher takes its turn
    watch.cancel()
    #expect(Array(seen.suffix(3)) == [.appleTools, .ready, .signIn], "\(seen): the ready screen sits between Apple's step and sign-in")
  }

  @Test func theFinishedScreensHoldEndsWhenTheOwnerPressesContinueOrBackSoItNeverFiresOnALaterScreen() async throws {
    var release = false
    let (co, _, _, h) = make(provisions: [.ok], signedIn: false, tools: [.asking], gate: { while !release { try? await Task.sleep(nanoseconds: 20_000_000) } })
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .appleTools })
    release = true
    #expect(await pumpUntil(5) { co.flow.step == .ready && co.flow.continueLit })  // held on the finished screen
    co.actions.continuePressed()  // the owner goes on before the hold is up
    #expect(co.flow.step == .signIn)
    co.actions.back()  // and straight back: the finished screen again, Continue lit
    #expect(co.flow.step == .ready && co.flow.continueLit)
    await pump(0.5)  // well past the 0.15 s hold the first time round
    #expect(co.flow.step == .ready, "the old hold did not carry the owner on a second time")
  }

  @Test func signedOutAsksForSignInAndAMissingClaudeSaysSoPlainly() async throws {
    let (co, _, _, h) = make(provisions: [.ok], signedIn: false, claude: nil)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .signIn })
    co.actions.signIn()
    #expect(await pumpUntil(3) { if case .failed = co.flow.signIn { return true } else { return false } })
    guard case .failed(let m) = co.flow.signIn else { return }
    #expect(m == OnboardingCopy.signInCouldNot)
    #expect(co.flow.step == .signIn)  // never moves on without Claude signed in
    #expect(OnboardingCopy.forbiddenWords(in: m).isEmpty)
  }

  @Test func signInRunsOnARealClaudeAndTheStepNoticesByItself() async throws {
    let dir = home()
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    writeScript(dir + "/claude", """
      #!/bin/bash
      if [ "$1" = auth ] && [ "$2" = status ]; then
        if [ -f '\(dir)/in' ]; then echo '{"loggedIn": true}'; exit 0; fi
        echo '{"loggedIn": false}'; exit 1
      fi
      if [ "$1" = auth ] && [ "$2" = login ]; then
        echo 'Open https://claude.ai/oauth/authorize?x=1 to sign in'
        sleep 0.4; touch '\(dir)/in'; sleep 5; exit 0
      fi
      exit 0
      """)
    let (co, _, _, h) = make(provisions: [.ok], signedIn: false, claude: dir + "/claude")
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .signIn })
    co.actions.signIn()
    #expect(co.flow.signIn == .waiting)
    #expect(await pumpUntil(20) { co.flow.step == .phone })
    #expect(co.flow.signedIn)
  }

  @Test func theyDontMatchDeclinesOnceMakesANewCodeAndConnectsNothing() async throws {
    let (co, pairing, c, h) = make(provisions: [.ok], signedIn: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    co.actions.choosePhone()
    #expect(pairing.starts == 1)
    pairing.onEvent?(.pairLink("https://r.example/enroll#abc"))
    pairing.onEvent?(.pairWords(["amber", "falcon", "river", "stone"]))
    co.actions.wordsDontMatch()
    #expect(pairing.declines == 1)
    #expect(pairing.starts == 2)  // a new code
    #expect(pairing.approveCalls == 0)  // nothing was confirmed
    #expect(co.flow.step == .pair)
    #expect(co.flow.pair == .starting)
    #expect(!co.flow.phoneConnected)
    #expect(c.agentStarts == 0)
    #expect(!co.performed.contains(.confirmWords))
    pairing.onEvent?(.pairConnected)  // a late connected from the cancelled run
    #expect(co.flow.step == .pair)
    #expect(!co.flow.phoneConnected)
  }

  @Test func aRefusedClickChangesNothing() async throws {
    let (co, pairing, c, h) = make(provisions: [.ok], signedIn: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    co.actions.choosePhone()
    pairing.onEvent?(.pairLink("https://r.example/enroll#abc"))
    pairing.onEvent?(.pairWords(["amber", "falcon", "river", "stone"]))
    pairing.approveResult = false  // not the owner's hand
    co.wordsMatch(event: nil, button: NSButton())
    #expect(pairing.approveCalls == 1)
    if case .confirm = co.flow.pair {} else { Issue.record("a refused click must leave the words up") }
    #expect(!co.performed.contains(.confirmWords))
    #expect(c.agentStarts == 0)
    pairing.approveResult = true
    co.wordsMatch(event: nil, button: NSButton())
    #expect(co.flow.pair == .connecting)
    pairing.onEvent?(.pairConnected)
    #expect(co.flow.step == .hello)
    #expect(c.agentStarts == 1)
  }

  @Test func yesOnAFreshMacSkipsThePairingAndAsksForTheNotConnectedHello() async throws {
    let (co, pairing, c, h) = make(provisions: [.ok], signedIn: true, relay: false)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    co.actions.choosePhone()
    #expect(co.flow.step == .hello)
    #expect(pairing.starts == 0)  // no code is attempted, so nothing can spin
    #expect(c.hellos == [false])  // the hello will not claim the phone is connected
    #expect(c.agentStarts == 1)
  }

  @Test func yesWithAPlaceToConnectStartsThePairingAndAConnectedPhoneAsksForTheConnectedHello() async throws {
    let (co, pairing, c, h) = make(provisions: [.ok], signedIn: true, relay: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    co.actions.choosePhone()
    #expect(pairing.starts == 1)
    pairing.onEvent?(.pairLink("https://r.example/enroll#abc"))
    pairing.onEvent?(.pairWords(["amber", "falcon", "river", "stone"]))
    co.wordsMatch(event: nil, button: NSButton())
    pairing.onEvent?(.pairConnected)
    #expect(c.hellos == [true])
  }

  @Test func justThisMacAsksForTheNotConnectedHello() async throws {
    let (co, _, c, h) = make(provisions: [.ok], signedIn: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    co.actions.chooseThisMacOnly()
    #expect(c.hellos == [false])
  }

  @Test func reopeningTheWindowMidDownloadNeverStartsASecondDownload() async throws {
    var release = false
    let (co, _, c, h) = make(provisions: [.ok], signedIn: true, gate: { while !release { try? await Task.sleep(nanoseconds: 20_000_000) } })
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { c.provisions == 1 })
    co.windowClosed()  // the window was closed
    co.send(.getStarted)  // and opened again, finding the same coordinator
    co.actions.getStarted()
    co.actions.tryAgain()
    await pump(0.3)
    #expect(c.provisions == 1)
    release = true
    #expect(await pumpUntil(4) { co.flow.step == .phone })
    #expect(c.provisions == 1)
  }

  @Test func closingTheWindowEndsAPairingInFlight() async throws {
    let (co, pairing, _, h) = make(provisions: [.ok], signedIn: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    co.actions.choosePhone()
    co.windowClosed()
    #expect(pairing.cancels == 1)
  }

  @Test func justThisMacAfterAFailedPairingCancelsTheCode() async throws {
    let (co, pairing, c, h) = make(provisions: [.ok], signedIn: true)
    defer { try? FileManager.default.removeItem(atPath: h) }
    co.send(.getStarted)
    #expect(await pumpUntil(3) { co.flow.step == .phone })
    co.actions.choosePhone()
    pairing.onEvent?(.pairFailed(OnboardingCopy.pairFailed))
    co.actions.chooseThisMacOnly()
    #expect(pairing.cancels == 1)
    #expect(co.flow.step == .hello)
    #expect(c.agentStarts == 1)
    #expect(!co.flow.phoneConnected)
  }
}

/// The phone step on the real `PairingController`: a real child on a real pty prints what `talos-app enroll` prints for the name "Phone".
@Suite("Onboarding phone pairing (real enroll child)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct LivePhonePairingGuiTests {
  struct World {
    var dir: String
    var web: WebController
    var relay: FakeRelay
    var cfg: DesktopConfig
  }

  func world() async throws -> World {
    let dir = (TestTemp.base as NSString).appendingPathComponent("talos-ob-phone-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let relay = try FakeRelay { _ in
      .init(body: "<script>window.talosNative={receive:function(j){}};\(talosPost)({type:'ready',shell_api:1,features:[],signed_in:false})</script>")
    }
    let web = WebController()
    web.openExternal = { _ in }
    web.configure(relay: relay.relay)
    web.prepare()
    #expect(await pumpUntil(4) { web.pageReady })
    writeScript(dir + "/talos-app", """
      #!/bin/bash
      echo "$@" > '\(dir)/args'
      echo 'Open this link on the device you want to add (it works once, for 10 minutes):'
      echo '\(relay.origin)/enroll#0123456789ABCDEFGHJKMNPQRS'
      sleep 0.2
      printf 'Pin "Phone" [aardvark adroitness absurd adviser]? [y/N] '
      IFS= read -r ans; printf '%s' "$ans" >> '\(dir)/answer'
      exit 0
      """)
    var cfg = DesktopConfig.defaults
    cfg.talosAppCommand = [dir + "/talos-app"]
    return World(dir: dir, web: web, relay: relay, cfg: cfg)
  }

  func armed(_ p: PairingController) {
    p.readDelay = 0.05
    p.pinWait = PairingSession.defaultPinWait
    p.exitGrace = 15
    p.writeOverride = nil
    p.front = { _ in }
  }

  func answer(_ w: World) -> String { (try? String(contentsOfFile: w.dir + "/answer", encoding: .utf8)) ?? "" }

  /// A real `NSButton` in a real window, and a click event on it (`pid` 0: the owner's hand; another: a program).
  func button() -> (NSWindow, NSButton) {
    let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
    win.isReleasedWhenClosed = false
    let b = FirstMouseButton(title: "The words match", target: nil, action: nil)
    b.frame = NSRect(x: 20, y: 20, width: 160, height: 44)
    win.contentView?.addSubview(b)
    return (win, b)
  }

  @Test func theLinkTheWordsAndTheOwnersYesGoThroughTheRealController() async throws {
    let w = try await world()
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    var events: [OnboardingFlow.Event] = []
    let live = LivePhonePairing(config: { w.cfg }, web: w.web, controller: p)
    live.onEvent = { events.append($0) }
    live.start()
    #expect(await pumpUntil(8) { events.contains(.pairWords(["aardvark", "adroitness", "absurd", "adviser"])) })
    #expect(events.contains(.pairLink("\(w.relay.origin)/enroll#0123456789ABCDEFGHJKMNPQRS")))
    // the program was asked for a phone, not for this Mac, and no sign-in window opened for it
    #expect((try String(contentsOfFile: w.dir + "/args", encoding: .utf8)).contains("--label Phone"))
    #expect(p.panelForTest == nil)
    let (win, b) = button()
    let at = b.convert(NSPoint(x: b.bounds.midX, y: b.bounds.midY), to: nil)
    // a program's click (another process id) is refused: nothing is written
    let program = try guiMouse(.leftMouseUp, in: win, at: at, pid: 4242)
    #expect(!live.approve(event: program, button: b))
    #expect(!live.approve(event: nil, button: b))  // an Accessibility press has no mouse event
    await pump(0.3)
    #expect(answer(w) == "")
    #expect(!events.contains(.pairConnected))
    // the owner's own click goes through, once
    let hand = try guiMouse(.leftMouseUp, in: win, at: at, pid: 0)
    #expect(await pumpUntil(3) { p.confirmEnabled })
    #expect(live.approve(event: hand, button: b))
    #expect(!live.approve(event: hand, button: b))  // a second yes writes nothing
    #expect(await pumpUntil(8) { events.contains(.pairConnected) })
    #expect(answer(w) == "y")
    live.cancel()
  }

  /// R1-1: a phone start with nowhere to connect it says so at once, every time, and never leaves the screen spinning.
  @Test func aPhoneStartWithNoPlaceToConnectNeverSpins() async throws {
    let w = try await world()
    defer { w.relay.stop() }
    let bare = WebController()  // no relay configured
    #expect(bare.relay == nil)
    let p = PairingController.shared
    armed(p)
    var events: [OnboardingFlow.Event] = []
    let live = LivePhonePairing(config: { w.cfg }, web: bare, controller: p)
    live.onEvent = { events.append($0) }
    live.start()
    live.start()  // a retry is told again, not swallowed as "the same as before"
    #expect(events == [.pairFailed(OnboardingCopy.pairFailed), .pairFailed(OnboardingCopy.pairFailed)])
    // and the controller itself, started for a phone with no relay, fails the phone run (the purpose is set first)
    p.start(config: w.cfg, web: bare, purpose: .phone)
    #expect(p.purpose == .phone)
    if case .failed = p.phase {} else { Issue.record("a phone run with no relay must fail, not wait") }
    p.start(config: w.cfg, web: bare, purpose: .phone)
    #expect(events.count == 4)  // the second failure of the same text reached the listener
  }

  /// R1-7: a child that ignores the polite end is ended by force; the next code comes, or a plain error. Never a spin.
  @Test func aStuckOldChildIsKilledAndTheNewCodeComes() async throws {
    let w = try await world()
    defer { w.relay.stop() }
    writeScript(w.dir + "/talos-app", """
      #!/bin/bash
      trap '' TERM HUP
      echo 'Open this link on the device you want to add (it works once, for 10 minutes):'
      echo '\(w.relay.origin)/enroll#0123456789ABCDEFGHJKMNPQRS'
      sleep 0.2
      printf 'Pin "Phone" [aardvark adroitness absurd adviser]? [y/N] '
      while true; do sleep 0.2; done
      """)
    let p = PairingController.shared
    armed(p)
    var events: [OnboardingFlow.Event] = []
    let live = LivePhonePairing(config: { w.cfg }, web: w.web, controller: p)
    live.endWait = 0.4
    live.onEvent = { events.append($0) }
    live.start()
    #expect(await pumpUntil(8) { events.contains { if case .pairWords = $0 { return true } else { return false } } })
    live.decline()
    #expect(await pumpUntil(3) { p.phase == .mismatch })
    #expect(p.isRunning)  // it ignored the polite end
    let links = events.filter { if case .pairLink = $0 { return true } else { return false } }.count
    live.start()
    #expect(await pumpUntil(10) { events.filter { if case .pairLink = $0 { return true } else { return false } }.count > links })
    #expect(!events.contains(.pairFailed(OnboardingCopy.pairFailed)))
    live.cancel()
    p.killChild()
  }

  @Test func theyDontMatchNeverWritesYesAndConnectsNothingThenAFreshCodeComes() async throws {
    let w = try await world()
    defer { w.relay.stop() }
    let p = PairingController.shared
    armed(p)
    var events: [OnboardingFlow.Event] = []
    let live = LivePhonePairing(config: { w.cfg }, web: w.web, controller: p)
    live.onEvent = { events.append($0) }
    live.start()
    #expect(await pumpUntil(8) { events.contains { if case .pairWords = $0 { return true } else { return false } } })
    live.decline()
    #expect(await pumpUntil(5) { p.phase == .mismatch })
    await pump(0.6)
    #expect(!answer(w).hasPrefix("y"))  // never a yes
    #expect(!events.contains(.pairConnected))
    #expect(p.phase == .mismatch)
    let links = events.filter { if case .pairLink = $0 { return true } else { return false } }.count
    live.start()  // the next code
    #expect(await pumpUntil(8) { events.filter { if case .pairLink = $0 { return true } else { return false } }.count > links || p.link != nil })
    live.cancel()
  }
}

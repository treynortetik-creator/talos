import AppKit
import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop

/// What the owner is told when the session stops or needs them, from the supervisor's event all the way to the Mac banner:
/// `SupervisorController.handle` -> `notice` -> `StatusCoordinator.start`'s subscription -> the quiet window -> `Notifier.show`.
/// Runs only with TALOS_GUI_TESTS=1, on the scratch HOME that `TmuxWorld.root` sets.
@MainActor
@Suite("Crash alert chain", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct CrashAlertChainGuiTests {
  @MainActor private final class World {
    let model: SupervisorController
    let coordinator = StatusCoordinator()
    var banners: [NativeNotice] = []
    private let savedOnNotify = WebController.shared.onNotify
    private let savedFeed = WebController.shared.onCompanionFeed

    init() throws {
      cannotTakeTheKeyboard()
      _ = TmuxWorld.root
      TmuxWorld.hookBundle()
      try #require(SupervisorController.configPath.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
      try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
      model = SupervisorController(store: MemoryStore())
      Notifier.shared.resetRateLimitForTest()
      Notifier.shared.observer = { [unowned self] in banners.append($0) }
      coordinator.start(model: model)
    }

    func close() {
      Notifier.shared.observer = nil
      Notifier.shared.resetRateLimitForTest()
      WebController.shared.onNotify = savedOnNotify
      WebController.shared.onCompanionFeed = savedFeed
      try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
    }
  }

  @Test func everyStopOrAskReachesAMacBannerWithTheFixedPhrase() throws {
    let w = try World()
    defer { w.close() }
    let cases: [(Supervisor.Event, NotificationPolicy.Supervisor)] = [
      (.needsYou(.confirmColdStart), .needsYou),
      (.needsYou(.startStalled), .needsYou),
      (.stoppedRestarting, .stoppedRestarting),
      (.resumeFailed(sessionId: "s"), .resumeFailed),
      (.confirmFailed, .confirmFailed),
      (.blocked([]), .blocked),
      (.stopped(.startFailed("no claude")), .couldNotStart),
      (.stopped(.crashedNoAutoRestart), .crashedNoRestart),
    ]
    for (event, kind) in cases {
      Notifier.shared.resetRateLimitForTest()  // each kind on its own; the 60 s limit is checked in the next test
      let before = w.banners.count
      w.model.handle(event)
      let expected = NotificationPolicy.notice(kind, agent: w.coordinator.agentName)
      if w.banners.count != before + 1 {
        Issue.record("\(event) raised \(w.banners.count - before) banners")
        continue
      }
      #expect(w.banners.last == expected, "\(event)")
    }
    // No screen text or error detail reaches a banner.
    #expect(!w.banners.map { $0.body }.joined().contains("no claude"))
  }

  @Test func theSameStopTwiceInAMinuteIsOneBanner() throws {
    let w = try World()
    defer { w.close() }
    w.model.handle(.stopped(.crashedNoAutoRestart))
    w.model.handle(.stopped(.crashedNoAutoRestart))
    #expect(w.banners.count == 1)
  }

  @Test func theSameStopAgainAfterTheMinuteIsAnotherBanner() throws {
    let w = try World()
    defer { w.close() }
    w.model.handle(.stopped(.crashedNoAutoRestart))
    Notifier.shared.resetRateLimitForTest()  // the 60 s limit has run out
    w.model.handle(.stopped(.crashedNoAutoRestart))
    #expect(w.banners.count == 2, "the notice text is the same, but a second crash later is a new event, not a repeat")
  }

  @Test func aBannerInsideTheQuietWindowIsHeldAndCounted() throws {
    let w = try World()
    defer { w.close() }
    let config = Data(#"{"quiet_window":{"start":"20:00","end":"04:00"},"timezone":"UTC"}"#.utf8)
    w.coordinator.setQuietForTest(try #require(QuietWindow.read(config)))
    // 01:30 UTC is inside a window that runs from 20:00 across midnight to 04:00.
    w.coordinator.now = { Date(timeIntervalSince1970: 1_798_767_000) }  // 2027-01-01T01:30:00Z
    w.model.handle(.stopped(.crashedNoAutoRestart))
    #expect(w.banners.isEmpty, "quiet hours: no banner")
    #expect(w.coordinator.collected == 1, "it is collected for the morning report")
    #expect(w.model.notice.hasPrefix(SupervisorNotice.crashedNoRestart), "the menu still says it")

    w.coordinator.now = { Date(timeIntervalSince1970: 1_798_790_400) }  // 2027-01-01T08:00:00Z, outside
    w.model.handle(.stopped(.crashedNoAutoRestart))
    #expect(w.banners.count == 1, "after the window the next one is shown")
  }
}

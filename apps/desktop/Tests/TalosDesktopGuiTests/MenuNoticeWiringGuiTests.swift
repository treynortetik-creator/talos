import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop

/// The two lines that make the menu's "needs you" text follow `status.needsYou`: `handle(.needsYou)` records the event's text in
/// `needsYouEventNotice`, and `liveNotice` runs the notice through `following`. `MenuNoticeFollowsTests` covers only the pure
/// `following`; with either line gone every test there stays green. This drives a real controller. Runs only with
/// TALOS_GUI_TESTS=1, on the scratch HOME that `TmuxWorld.root` sets.
@MainActor
@Suite("Menu notice wiring", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct MenuNoticeWiringGuiTests {
  @MainActor private final class World {
    let model: SupervisorController

    init() throws {
      cannotTakeTheKeyboard()
      _ = TmuxWorld.root
      TmuxWorld.hookBundle()
      try #require(SupervisorController.configPath.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
      try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
      model = SupervisorController(store: MemoryStore())
    }

    func close() {
      try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
    }
  }

  @Test func theLineFollowsTheQuestionThatIsOnScreenNotTheLastEvent() throws {
    let w = try World()
    defer { w.close() }
    let coldStart = "\(SupervisorNotice.needsYou): \(SupervisorController.describe(.confirmColdStart))"

    // an event about the folder-trust dialog, while that dialog is what the status holds
    w.model.handle(.needsYou(.dialog("folder trust")))
    w.model.status.phase = .starting
    w.model.status.needsYou = .dialog("folder trust")
    #expect(w.model.liveNotice.contains("folder trust"), "control: the event's own dialog is shown while it is the question")

    // the supervisor puts the dev-channel question back quietly: no event, the notice text is still the trust line
    w.model.status.needsYou = .confirmColdStart
    #expect(w.model.notice.contains("folder trust"), "the notice itself is unchanged: only the menu line follows")
    #expect(w.model.liveNotice == coldStart)
    #expect(!w.model.liveNotice.contains("folder trust"))

    // nothing waits any more
    w.model.status.needsYou = nil
    #expect(w.model.liveNotice.isEmpty)
  }
}

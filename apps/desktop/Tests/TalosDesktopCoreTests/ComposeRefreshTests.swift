import Foundation
import Testing

@testable import TalosDesktopCore

/// When an open Quick Compose panel reads the page again. The panel and its observer need a window and are covered by the GUI tests.
@Suite("Quick Compose: when an open panel refreshes")
struct ComposeRefreshTests {
  typealias World = ComposeRefresh.World
  typealias Thread = WebToNative.Thread

  func world(_ threads: [Thread] = [Thread(id: "work", name: "Work"), Thread(id: "play", name: "Play")], signedIn: Bool = true, page: PageState = .signedIn) -> World {
    World(threads: threads, signedIn: signedIn, page: page)
  }

  @Test func aClosedPanelNeverRefreshesAndAnOpenOneThatHasReadNothingDoes() {
    #expect(!ComposeRefresh.needed(open: false, shown: nil, now: world()))
    #expect(!ComposeRefresh.needed(open: false, shown: world(signedIn: false), now: world()), "it reads when it is opened")
    #expect(ComposeRefresh.needed(open: true, shown: nil, now: world()))
  }

  @Test func anOpenPanelRefreshesWhenTheThreadListChangesInAnyWay() {
    let shown = world()
    let work = Thread(id: "work", name: "Work"), play = Thread(id: "play", name: "Play")
    #expect(!ComposeRefresh.needed(open: true, shown: shown, now: world()), "nothing changed: the picker is left alone")
    #expect(ComposeRefresh.needed(open: true, shown: shown, now: world([work])), "a thread left")
    #expect(ComposeRefresh.needed(open: true, shown: shown, now: world([work, play, Thread(id: "new", name: "New")])), "a thread came")
    #expect(ComposeRefresh.needed(open: true, shown: shown, now: world([work, Thread(id: "play", name: "Games")])), "a thread was renamed")
    #expect(ComposeRefresh.needed(open: true, shown: shown, now: world([play, work])), "the order is the picker's order")
    #expect(ComposeRefresh.needed(open: true, shown: shown, now: world([])), "a reloading page lists none")
  }

  @Test func anOpenPanelRefreshesWhenSignInOrThePageStateChanges() {
    let shown = world(signedIn: false, page: .loading)
    #expect(ComposeRefresh.needed(open: true, shown: shown, now: world(signedIn: false, page: .signedOut)), "the page came up")
    #expect(ComposeRefresh.needed(open: true, shown: shown, now: world(signedIn: true, page: .signedIn)), "signed in")
    #expect(ComposeRefresh.needed(open: true, shown: world(), now: world(signedIn: true, page: .unreachable)), "the page went away")
    #expect(ComposeRefresh.needed(open: true, shown: world(page: .unreachable), now: world()), "and came back: a reconnect")
  }
}

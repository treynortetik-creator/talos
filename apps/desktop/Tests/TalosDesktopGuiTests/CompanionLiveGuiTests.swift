import AppKit
import Foundation
import Testing
import WebKit
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop

// C-LIVE (DESKTOP-COMPANION-SPEC 11.4) on real NSPanels, real NSEvent monitors and one real page. Runs only with
// TALOS_GUI_TESTS=1 from a logged-in session. No test activates the app, plays a sound, or touches the owner's windows.

private func feedFrame(
  busy: Bool = false, needs: Int = 0, unread: Int = 0, failed: Int = 0, rows: [[String: Any]] = [], reply: (String, Int)? = nil
) -> CompanionFeed {
  let o: [String: Any] = [
    "type": "companion_state", "link": "online", "mac_online": true, "busy": busy, "needs": needs, "working": 0, "queued": 0,
    "on_call": 0, "unread": unread, "failed": failed, "rows": rows,
    "last_reply": reply.map { ["thread_id": $0.0, "seq": $0.1] as [String: Any] } ?? NSNull(),
  ]
  guard case .companionState(let f)? = WebToNative.decode(o) else { fatalError("the test frame must decode") }
  return f
}

@MainActor
final class LiveFixture {
  let fx: CompanionFixture
  var paths: [String] = []
  var terminals = 0
  var replyRequests: [String] = []
  var replyDone: [@MainActor (LastReplyTracker.Outcome) -> Void] = []
  var cancels = 0
  /// The banners he fell back to posting himself: (thread id, thread name).
  var fallbackBanners: [String] = []
  /// Every value of the flag he told the page (the page's jump banner stands down while it is true).
  var flags: [Bool] = []
  /// What he said he showed with each flag message (the page drops those from its held list).
  var acks: [[HeldReply]] = []
  var c: CompanionController { fx.controller }

  init(enabled: Bool = true) {
    _ = NSApplication.shared
    fx = CompanionFixture(enabled: enabled)
    c.host.openPath = { [unowned self] in self.paths.append($0) }
    c.host.showTerminal = { [unowned self] in self.terminals += 1 }
    c.host.requestReply = { [unowned self] thread, done in
      self.replyRequests.append(thread)
      self.replyDone.append(done)
    }
    c.host.cancelReply = { [unowned self] in self.cancels += 1 }
    c.host.postReplyBanner = { [unowned self] id, name in self.fallbackBanners.append("\(id):\(name)") }
    c.host.setRepliesFlag = { [unowned self] on, shown, _ in
      self.flags.append(on)
      self.acks.append(shown)
    }
    fx.inputs.threads = [
      CompanionThreadRef(id: "general", name: "Daily plan"), CompanionThreadRef(id: "a1", name: "A thread"),
      CompanionThreadRef(id: "a2", name: "A thread"),
    ]
    fx.inputs.pageStatus = .ready
    feed(feedFrame())
  }

  func feed(_ f: CompanionFeed?) {
    fx.inputs.feed = f
    fx.inputs.pageStatus = f == nil ? .down : .ready
    fx.advance(0.5)
  }

  func done() { fx.done() }

  func openTray() {
    fx.controller.hoverForTest(true)
    fx.spin(0.3)
    if let button = fx.controller.controlsViewForTest?.statusButton { click(button) }
  }
}

@MainActor
@Suite("Companion LIVE panels", .serialized, .enabled(if: guiTestsEnabled))
struct CompanionLiveGuiTests {
  @Test func theTrayAndTheReplyCardStayOutOfCapturesAndSharesWhenOpened() throws {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame(unread: 1, reply: ("general", 2)))
    t.c.showTray()
    let tray = try #require(t.c.trayPanelForTest)
    #expect(t.c.trayIsShowing && tray.sharingType == .none, "the tray lists thread names")
    t.c.openReplyCard(thread: "general")
    let card = try #require(t.c.cardPanelForTest)
    #expect(t.c.cardIsShowing && card.sharingType == .none, "the reply card shows reply text")
    #expect(try #require(t.c.spritePanelForTest).sharingType == .readOnly, "opening them leaves the character as he was")
    // every panel that exists now, by the controller's own list: exactly one is shared
    #expect(t.c.panels.filter { $0.sharingType != .none }.map { $0 === t.c.spritePanelForTest } == [true])
    // what the window server itself reports (kCGWindowSharingState: 0 none, 1 read only), not just the property we set
    let info = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    func state(_ p: NSPanel) -> Int? { info.first { ($0[kCGWindowNumber as String] as? Int) == p.windowNumber }?[kCGWindowSharingState as String] as? Int }
    #expect(state(try #require(t.c.spritePanelForTest)) == 1, "the window server lists the character as read-only")
    #expect(state(tray) == 0 && state(card) == 0, "and the tray and the card as not shared")
  }

  @Test func theStatusButtonOpensTheTrayAndARowOpensItsThreadByIdEvenWithEqualNames() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame(rows: [["thread_id": "a1", "state": "working"], ["thread_id": "a2", "state": "ready"]]))
    t.openTray()
    #expect(t.c.trayIsShowing)
    #expect(t.c.outsideMonitorCount == 2, "a global and a local monitor, only while it is open")
    let v = try! #require(t.c.trayViewForTest)
    #expect(v.rowViews.map { $0.row.title } == ["A thread", "A thread 2"])
    v.rowViews[1].onClick?(v.rowViews[1].row)
    #expect(t.paths == ["/t/a2"], "the id acts, not the name")
    #expect(!t.c.trayIsShowing)
    #expect(t.c.outsideMonitorCount == 0, "the monitors are gone with the tray")
  }

  @Test func theStatusButtonCarriesTheCountForVoiceOver() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame(rows: [["thread_id": "a1", "state": "working"], ["thread_id": "a2", "state": "ready"]]))
    t.fx.controller.hoverForTest(true)
    t.fx.spin(0.3)
    #expect(t.c.controlsViewForTest?.statusButton.accessibilityLabel() == "Status list, 2")
    #expect(t.c.controlsViewForTest?.statusButton.frame.width == 44)
  }

  @Test func theTrayShowsLoadingEmptyAndDownStates() {
    let t = LiveFixture()
    defer { t.done() }
    t.openTray()
    #expect(t.c.trayViewForTest?.current.headline == "All quiet.")
    t.feed(nil)
    #expect(t.c.trayViewForTest?.current.headline == "Can't reach Talos", "refreshed live, still open")
    t.c.hideTray()
    #expect(t.c.outsideMonitorCount == 0)
  }

  @Test func aClickElsewhereClosesTheTrayAndTheCard() {
    let t = LiveFixture()
    defer { t.done() }
    t.openTray()
    #expect(t.c.trayIsShowing)
    t.c.closeCards()  // what both monitors call
    #expect(!t.c.trayIsShowing && t.c.outsideMonitorCount == 0)
  }

  @Test func aNewReplyBubbleOpensTheReplyCardAndTheTextStaysInTheViewOnly() throws {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.defaults.set(false, forKey: CompanionController.Key.replyBubbles)  // the plain bubble: today's behaviour
    t.feed(feedFrame(reply: ("general", 1)))
    t.feed(feedFrame(unread: 1, reply: ("general", 2)))
    #expect(t.c.bubbleIsShowing)
    #expect(t.c.currentBubbleForTest == .newReply(thread: "Daily plan", id: "general"))
    t.c.bubbleViewForTest?.onClick?()
    #expect(t.c.cardIsShowing)
    #expect(t.replyRequests == ["general"], "asked of the page, on the click, for that thread")
    #expect(t.c.cardViewForTest?.textField.stringValue == "Fetching the reply…")
    t.replyDone[0](.text("It is done.\u{202E}", truncated: true))
    #expect(t.c.cardViewForTest?.textField.stringValue == "It is done.…")
    #expect(t.c.cardViewForTest?.shownText == "It is done.…")
    t.c.hideCard()
    #expect(t.c.cardViewForTest?.textField.stringValue == "", "cleared on close")
    #expect(t.cancels == 1)
    #expect(t.c.outsideMonitorCount == 0)
  }

  @Test func aLateAnswerForACardThatClosedIsDropped() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame(reply: ("general", 1)))
    t.c.openReplyCard(thread: "general")
    #expect(t.c.cardIsShowing)
    t.c.hideCard()
    t.replyDone[0](.text("LATE TEXT", truncated: false))
    #expect(!t.c.cardIsShowing)
    #expect(t.c.cardViewForTest?.textField.stringValue != "LATE TEXT")
  }

  @Test func aSecondClickReplacesTheFirstRequestAndOnlyTheNewAnswerShows() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    t.c.openReplyCard(thread: "general")
    t.c.openReplyCard(thread: "a1")
    #expect(t.replyRequests == ["general", "a1"])
    t.replyDone[0](.text("OLD", truncated: false))  // the first request's answer (WebController would say superseded)
    #expect(t.c.cardViewForTest?.textField.stringValue != "OLD")
    t.replyDone[1](.text("NEW", truncated: false))
    #expect(t.c.cardViewForTest?.textField.stringValue == "NEW")
  }

  @Test func everyFailureOfTheReplyRequestSaysSoAndKeepsOpenInTalos() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    for (outcome, line) in [
      (LastReplyTracker.Outcome.timedOut, "Couldn't load the reply."), (.unavailable, "Couldn't load the reply."),
      (.empty, "Nothing to show yet."),
    ] {
      t.c.openReplyCard(thread: "general")
      t.replyDone.last?(outcome)
      #expect(t.c.cardViewForTest?.textField.stringValue == line)
    }
    t.c.cardViewForTest?.onOpenTalos?()
    #expect(t.paths == ["/t/general"] && !t.c.cardIsShowing, "Open in Talos closes the card and opens that thread")
  }

  @Test func aMicStartingClosesTheCardAndRefusesANewOne() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    t.c.openReplyCard(thread: "general")
    #expect(t.c.cardIsShowing)
    t.c.envAdjust = { $0.micRunning = true }  // a call starts
    t.fx.advance(0.5)
    #expect(!t.c.cardIsShowing, "the card holds message text: a call closes it")
    t.c.openReplyCard(thread: "general")
    #expect(!t.c.cardIsShowing, "and none opens while it runs")
    #expect(t.replyRequests.count == 1, "nothing was even asked")
  }

  @Test func signOutOrAStaleFeedClosesTheCard() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    t.c.openReplyCard(thread: "general")
    #expect(t.c.cardIsShowing)
    t.feed(nil)
    #expect(!t.c.cardIsShowing)
    #expect(t.c.cardViewForTest?.textField.stringValue == "")
  }

  @Test func theQuietWindowClosesTheCard() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    t.c.openReplyCard(thread: "general")
    t.fx.inputs.quiet = true
    t.fx.advance(0.5)
    #expect(!t.c.cardIsShowing)
  }

  @Test func eachBubbleOpensWhatItNames() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    t.feed(feedFrame(needs: 1, rows: [["thread_id": "general", "state": "needs_you"]]))
    t.fx.advance(4)
    #expect(t.c.currentBubbleForTest == .needsYouIn(thread: "Daily plan", id: "general"))
    t.c.bubbleViewForTest?.onClick?()
    #expect(t.paths == ["/t/general"])
    #expect(!t.c.bubbleIsShowing)
  }

  @Test func aFailedSendBubbleOpensTalos() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    t.feed(feedFrame(failed: 1))
    #expect(t.c.currentBubbleForTest == .sendFailed)
    t.c.bubbleViewForTest?.onClick?()
    #expect(t.fx.opened == 1)
    #expect(t.paths.isEmpty)
  }

  @Test func aFailedSendRaisesTroubleAndAReloadDoesNot() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    t.feed(feedFrame(failed: 1))
    #expect(t.c.lastOutput?.state == .trouble)
    #expect(t.c.bubbleIsShowing && t.c.currentBubbleForTest == .sendFailed)
    t.feed(nil)  // the page reloaded
    t.fx.advance(4)  // leaving Trouble waits out the 3 s between changes
    #expect(t.c.lastOutput?.state != .trouble)
    t.feed(feedFrame(failed: 1))  // and came back already holding one failure
    #expect(t.c.lastOutput?.state != .trouble)
  }

  @Test func offMidTrayAndMidCardLeavesNothingBehind() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame(rows: [["thread_id": "a1", "state": "working"]]))
    t.openTray()
    #expect(t.c.trayIsShowing)
    t.c.openReplyCard(thread: "general")
    t.c.showTray()
    t.c.openReplyCard(thread: "a1")
    #expect(t.c.cardIsShowing && t.c.outsideMonitorCount == 2)
    t.fx.turnOff()
    #expect(t.c.panels.isEmpty, "tray and card panels are gone with the rest")
    #expect(t.c.outsideMonitorCount == 0 && t.c.activeTimerCount == 0 && t.c.activeListenerCount == 0)
    t.replyDone.last?(.text("AFTER OFF", truncated: false))
    #expect(t.c.panels.isEmpty, "a late answer after off builds nothing")
  }

  @Test func onOffOneHundredTimesLeavesNoPanelAndNoMonitor() {
    let t = LiveFixture()
    defer { t.done() }
    for _ in 0..<100 {
      t.fx.turnOff()
      t.fx.turnOn()
      t.c.showTray()
    }
    #expect(t.c.panels.filter { $0 is CompanionPanel }.count <= 5)
    t.fx.turnOff()
    #expect(t.c.panels.isEmpty && t.c.outsideMonitorCount == 0)
  }

  @Test func aDragClosesTheTrayAndTheCardAndRoundsNeverStartWithOneOpen() {
    let t = LiveFixture()
    defer { t.done() }
    t.openTray()
    t.c.dragBeganForTest(right: true)
    #expect(!t.c.trayIsShowing, "nothing follows a moving sprite")
    t.c.dragEndedForTest()
    t.c.showTray()
    t.c.startRoundsForTest()
    #expect(!t.c.isWalking, "Rounds start only with the tray and card closed")
  }

  @Test func theReplyBannerIsDroppedOnlyWhileHeCanShowIt() {
    let t = LiveFixture()
    defer { t.done() }
    #expect(t.c.dropsReplyBanner(body: "New reply in Daily plan"))
    #expect(!t.c.dropsReplyBanner(body: "Needs you in Daily plan"), "other banners are untouched")
    t.c.envAdjust = { $0.micRunning = true }
    #expect(!t.c.dropsReplyBanner(body: "New reply in Daily plan"), "a mic is running: he holds bubbles, so the banner stays")
    t.c.envAdjust = nil
    t.feed(nil)
    #expect(!t.c.dropsReplyBanner(body: "New reply in Daily plan"), "no feed")
    t.feed(feedFrame())
    t.fx.defaults.set(true, forKey: CompanionController.Key.replyBanners)
    #expect(!t.c.dropsReplyBanner(body: "New reply in Daily plan"), "the owner asked for both")
    t.fx.defaults.set(false, forKey: CompanionController.Key.replyBanners)
    t.fx.turnOff()
    #expect(!t.c.dropsReplyBanner(body: "New reply in Daily plan"), "off: today's banner")
  }

  @Test func aHostileThreadNameStaysOneCleanLineInTheTrayAndItsLabels() throws {
    let t = LiveFixture()
    defer { t.done() }
    let bad = "\u{202E}evil\nname **x**" + String(repeating: "z", count: 400)
    t.fx.inputs.threads = [CompanionThreadRef(id: "general", name: bad)]
    t.feed(feedFrame(rows: [["thread_id": "general", "state": "working"]]))
    t.openTray()
    let row = try #require(t.c.trayViewForTest?.rowViews.first)
    #expect(!row.row.title.contains("\n") && row.row.title.count <= 40)
    #expect(row.accessibilityLabel()?.contains("\n") == false)
    #expect(row.toolTip?.contains("\u{202E}") == false)
  }

  /// The real page (the actual `attachShell` and feed from apps/web, on a real store with a real connection-meta store) into
  /// the real `WebController` and decoder, into the real `StatusCoordinator` input builder, into a real panel: a failed send
  /// raises Trouble, and it does so from the push of the failure, not from the page's 30 s re-send.
  @Test func aFailedSendOnTheRealPageRaisesTroubleInHim() async throws {
    _ = NSApplication.shared
    let relay = try #require(RelayOrigin("https://relay.example.com"))
    let web = WebController()
    web.configure(relay: relay)
    web.prepare()
    let wv = try #require(web.webView)
    let js = try CompanionFeedGuiTests.harness.get()
    wv.loadHTMLString("<html><body></body></html>", baseURL: URL(string: "https://relay.example.com/"))
    // Wait for the document to commit: a script run on the blank page before it would be thrown away with it.
    var committed = false
    for _ in 0..<250 where !committed {
      try await Task.sleep(nanoseconds: 20_000_000)
      committed = (try? await wv.evaluateJavaScript("location.href.startsWith('https://relay.example.com') && document.readyState === 'complete'")) as? Bool == true
    }
    #expect(committed, "the page never loaded")
    _ = try? await wv.evaluateJavaScript(js)

    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    func inputs() -> CompanionInputs {
      StatusCoordinator.companionInputs(
        phase: .idle, configured: true, activity: nil, sessionNeedsYou: false, badge: 0, relayFailures: 0, relayConfigured: true,
        agentName: "Talos", quiet: false, quietWindow: nil, collected: 0, feed: web.companionFeed,
        pageStatus: web.companionPageStatus, threads: web.threads.map { CompanionThreadRef(id: $0.id, name: $0.name) },
        windowIsKey: false)
    }
    var feedChanges = 0
    web.onCompanionFeed = { _ in
      feedChanges += 1
      fx.inputs = inputs()
      fx.controller.inputsChanged()
    }
    let start = Date()
    while web.companionFeed == nil, Date().timeIntervalSince(start) < 20 { try await Task.sleep(nanoseconds: 20_000_000) }
    #expect(web.companionFeed != nil, "no feed arrived")
    #expect(web.companionPageStatus == .ready)
    fx.inputs = inputs()
    fx.controller.inputsChanged()
    #expect(fx.controller.lastOutput?.state != .trouble)

    _ = try await wv.evaluateJavaScript("window.__h.failSend('c1')")
    let t0 = Date()
    // Shorter than the page's 30 s re-send, so Trouble got here because the failed send was pushed; the cap only ends a hang.
    while fx.controller.lastOutput?.state != .trouble, Date().timeIntervalSince(t0) < 20 {
      try await Task.sleep(nanoseconds: 20_000_000)
      fx.advance(0)
    }
    #expect(web.companionFeed?.failed == 1)
    #expect(fx.controller.lastOutput?.state == .trouble, "a failed send never reached him")
    #expect(fx.controller.currentBubbleForTest == .sendFailed)

    // The card closing cancels the request the page is still answering: the outcome is "superseded", never a later text.
    var outcome: LastReplyTracker.Outcome?
    web.requestLastReply(thread: "general") { outcome = $0 }
    web.cancelLastReply()
    #expect(outcome == .superseded)
    outcome = nil
    try await Task.sleep(nanoseconds: 400_000_000)
    #expect(outcome == nil, "a cancelled request answers once")

    _ = try await wv.evaluateJavaScript("window.__h.signOut()")
    let t1 = Date()
    while web.companionFeed != nil, Date().timeIntervalSince(t1) < 20 { try await Task.sleep(nanoseconds: 20_000_000) }
    #expect(web.companionFeed == nil)
    fx.advance(4)  // leaving Trouble waits out the 3 s between changes
    #expect(fx.controller.lastOutput?.state != .trouble, "sign-out clears the alarm with the feed")
    #expect(web.companionPageStatus == .down)
  }
}

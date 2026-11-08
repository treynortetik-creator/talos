import AppKit
import Foundation
import Testing
import TalosDesktopCore

@testable import TalosDesktop

// Mini Talos delivers thread replies, on real NSPanels. Runs only with TALOS_GUI_TESTS=1 from a logged-in session. Fictional
// threads and text; no test activates the app, posts a real notification, or touches the owner's windows.

private func feedFrame(
  needs: Int = 0, unread: Int = 0, rows: [[String: Any]] = [], reply: (String, Int)? = nil, held: [(String, Int)] = [],
  viewing: String? = nil
) -> CompanionFeed {
  let o: [String: Any] = [
    "type": "companion_state", "link": "online", "mac_online": true, "busy": false, "needs": needs, "working": 0, "queued": 0,
    "on_call": 0, "unread": unread, "failed": 0, "rows": rows,
    "last_reply": reply.map { ["thread_id": $0.0, "seq": $0.1] as [String: Any] } ?? NSNull(),
    "viewing": viewing.map { $0 as Any } ?? NSNull(), "held": held.map { ["thread_id": $0.0, "seq": $0.1] as [String: Any] },
  ]
  guard case .companionState(let f)? = WebToNative.decode(o) else { fatalError("the test frame must decode") }
  return f
}

@MainActor
private final class Banners {
  var seen: [NativeNotice] = []
  init() {
    Notifier.shared.resetRateLimitForTest()
    Notifier.shared.observer = { [unowned self] in seen.append($0) }
  }
  func close() {
    Notifier.shared.observer = nil
    Notifier.shared.resetRateLimitForTest()
  }
}

extension CompanionController {
  var replyBubbleIsShowing: Bool { replies.isShowing }
  var replyBubbleViewForTest: CompanionReplyBubbleView? { replies.view }
  var replyBubblePanelForTest: NSPanel? { replies.panel }
  var repliesFlagIsOn: Bool { replies.flagOn }
}

@MainActor
@Suite("Companion replies delivered by him", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct CompanionReplyBubbleGuiTests {
  /// A reply in `general` ("Daily plan") the way the page's feed reports it.
  private func reply(_ t: LiveFixture, _ thread: String = "general", seq: Int = 2) {
    t.feed(feedFrame(reply: (thread, seq - 1)))
    t.feed(feedFrame(unread: 1, reply: (thread, seq)))
  }

  /// The page holds a reply for him (the flag is on) and says so in its feed.
  private func held(_ t: LiveFixture, _ thread: String = "general", seq: Int = 5) {
    t.feed(feedFrame(unread: 1, held: [(thread, seq)]))
  }

  private func replyText(_ t: LiveFixture, _ text: String = "Ticket's in: ISH-5238 is codenamed Tron: Hephaestus and more words that go on and on", at i: Int = 0) {
    t.replyDone[i](.text(text, truncated: false))
  }

  @Test func aReplyComesInHisBubbleWithTheThreadTheFirstLineAndOpenAndLater() throws {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    #expect(t.replyRequests == ["general"], "the page is asked for the reply text")
    #expect(!t.c.replyBubbleIsShowing, "not shown until the text is here")
    replyText(t)
    #expect(t.c.replyBubbleIsShowing)
    #expect(!t.c.bubbleIsShowing, "instead of the plain one-line bubble")
    let v = try #require(t.c.replyBubbleViewForTest)
    #expect(v.headerField.stringValue == "DAILY PLAN · new reply")
    #expect(v.bodyField.stringValue.hasPrefix("Ticket's in: ISH-5238"))
    #expect(v.openButton.accessibilityLabel() == "Open" && v.laterButton.accessibilityLabel() == "Later")
    let panel = try #require(t.c.replyBubblePanelForTest)
    #expect(panel.sharingType == .none, "it holds message text: out of captures and shares")
    #expect(v.laterButton.frame.maxY < panel.frame.height && v.openButton.frame.maxX <= v.laterButton.frame.minX + 0.5, "both buttons fit inside")
    #expect(panel.frame.height > 70 && panel.frame.height < 140 && panel.frame.width == CompanionPlacement.replyBubbleWidth)
    #expect(t.fallbackBanners.isEmpty)
  }

  @Test func openJumpsToTheThreadAndClosesIt() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    t.c.replyBubbleViewForTest?.onOpen?()
    #expect(t.paths == ["/t/general"])
    #expect(!t.c.replyBubbleIsShowing)
    #expect(t.c.replyBubbleViewForTest?.bodyField.stringValue == "", "the text does not outlive the bubble")
  }

  @Test func aClickOnTheBubbleItselfIsOpen() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    t.c.replyBubbleViewForTest?.onClick?()
    #expect(t.paths == ["/t/general"] && !t.c.replyBubbleIsShowing)
  }

  @Test func laterDismissesItAndOpensNothing() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    t.c.replyBubbleViewForTest?.onLater?()
    #expect(!t.c.replyBubbleIsShowing)
    #expect(t.paths.isEmpty && t.fx.opened == 0 && t.fallbackBanners.isEmpty)
  }

  @Test func severalRepliesMakeOneBubbleAndOpenGoesHome() throws {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)  // Daily plan
    t.feed(feedFrame(unread: 2, reply: ("a1", 3)))  // and another thread before the text is back
    #expect(t.replyRequests == ["general"], "one question to the page, not two")
    replyText(t)
    let v = try #require(t.c.replyBubbleViewForTest)
    #expect(t.c.panels.filter { $0 is CompanionPanel && $0.isVisible && $0 !== t.c.spritePanelForTest }.count == 1, "one bubble")
    #expect(v.headerField.stringValue == "2 new replies")
    #expect(v.bodyField.stringValue == "Daily plan, A thread")
    v.onOpen?()
    #expect(t.paths == ["/"])
  }

  @Test func aReplyThatArrivesWhileTheBubbleIsUpJoinsItAndRestartsTheClock() throws {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    t.c.replies.lifetime = 0.8
    t.c.replies.restartClock()
    t.fx.spin(0.5)
    t.feed(feedFrame(unread: 2, reply: ("a1", 3)))
    #expect(t.c.replyBubbleViewForTest?.headerField.stringValue == "2 new replies")
    t.fx.spin(0.5)
    #expect(t.c.replyBubbleIsShowing, "1 s in, but the clock restarted at 0.5")
    t.fx.spin(0.6)
    #expect(!t.c.replyBubbleIsShowing, "gone after its time, the reply is still in Talos")
  }

  @Test func itDoesNotVanishOnTheOrdinarySixSecondTimerAndHoverHoldsIt() {
    let t = LiveFixture()
    defer { t.done() }
    #expect(ReplyBubbleContent.lifetime == 30)
    reply(t)
    replyText(t)
    #expect(t.c.currentBubbleForTest == nil, "the plain bubble and its 6 s timer are not what runs it")
    t.c.replies.lifetime = 0.3
    t.c.replies.restartClock()
    t.c.replies.bubbleHovered = true
    t.fx.spin(0.6)
    #expect(t.c.replyBubbleIsShowing, "a pointer on it pauses the clock")
    t.c.replies.bubbleHovered = false
    t.fx.spin(0.5)
    #expect(!t.c.replyBubbleIsShowing, "and it runs again when the pointer leaves")
  }

  @Test func theReplyTextFailingStillDeliversTheReply() {
    let t = LiveFixture()
    defer { t.done() }
    for (i, outcome) in [LastReplyTracker.Outcome.timedOut, .unavailable, .empty, .superseded].enumerated() {
      reply(t, seq: 2 + 2 * i)
      t.replyDone.last?(outcome)
      #expect(t.c.replyBubbleIsShowing, "\(outcome)")
      #expect(t.c.replyBubbleViewForTest?.headerField.stringValue == "DAILY PLAN · new reply")
      #expect(t.c.replyBubbleViewForTest?.bodyField.stringValue == "Open to read it.")
      t.c.replyBubbleViewForTest?.onLater?()
      t.fx.advance(70)  // past the minute between bubbles for one thread
    }
  }

  @Test func withTheToggleOffItIsTheOldPlainBubble() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.defaults.set(false, forKey: CompanionController.Key.replyBubbles)
    reply(t)
    #expect(t.c.bubbleIsShowing && t.c.currentBubbleForTest == .newReply(thread: "Daily plan", id: "general"))
    #expect(!t.c.replyBubbleIsShowing && t.replyRequests.isEmpty)
  }

  @Test func theToggleIsOnByDefault() {
    let t = LiveFixture()
    defer { t.done() }
    #expect(t.c.replyBubblesOn)
    t.fx.defaults.set(false, forKey: CompanionController.Key.replyBubbles)
    #expect(!t.c.replyBubblesOn)
  }

  @Test func aMicStartingTakesAShownBubbleDownAndPostsNothing() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    t.c.envAdjust = { $0.micRunning = true }
    t.fx.advance(0.5)
    #expect(!t.c.replyBubbleIsShowing)
    #expect(t.fallbackBanners.isEmpty, "it was shown: that was its one delivery")
  }

  @Test func theQuietWindowTakesItDownAndAddsNoBanner() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    t.fx.inputs.quiet = true
    t.fx.advance(0.5)
    #expect(!t.c.replyBubbleIsShowing)
    #expect(t.fallbackBanners.isEmpty, "quiet hours had no banner before, and have none now")
  }

  @Test func aMicThatStartedWhileTheTextWasComingPostsTheBannerBecauseItWasNeverShown() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    t.c.envAdjust = { $0.micRunning = true }
    replyText(t)
    #expect(!t.c.replyBubbleIsShowing)
    #expect(t.fallbackBanners == ["general:Daily plan"])
  }

  @Test func quietHoursWhileTheTextWasComingPostNoBannerEither() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    t.fx.inputs.quiet = true
    t.fx.advance(0.5)
    replyText(t)
    #expect(!t.c.replyBubbleIsShowing && t.fallbackBanners.isEmpty)
  }

  @Test func snoozingWhileTheTextIsComingPostsTheBannerAndShowsNothing() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    t.c.snooze()
    replyText(t)
    #expect(!t.c.replyBubbleIsShowing)
    #expect(t.fallbackBanners == ["general:Daily plan"], "never shown, so the banner: a reply is never lost")
  }

  @Test func turningHimOffWhileTheTextIsComingPostsTheBannerAndALateAnswerShowsNothing() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    t.fx.turnOff()
    #expect(t.fallbackBanners == ["general:Daily plan"], "never shown, so the banner: closing is not a way to lose a reply")
    replyText(t)
    #expect(t.c.panels.isEmpty && !t.c.replyBubbleIsShowing)
    #expect(t.fallbackBanners.count == 1)
  }

  @Test func aDragHidesItAndTheDropBringsItBack() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    t.c.dragBeganForTest(right: true)
    #expect(!t.c.replyBubbleIsShowing)
    t.c.dragEndedForTest()
    #expect(t.c.replyBubbleIsShowing, "the reply is still there after the drop")
  }

  @Test func aHeldReplyThatLandsDuringADragIsShownAfterTheDropAndAckedThen() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = true
    t.c.dragBeganForTest(right: true)
    held(t)
    replyText(t)
    #expect(!t.c.replyBubbleIsShowing && t.acks.allSatisfy { $0.isEmpty }, "not shown, so not acked")
    t.c.dragEndedForTest()
    #expect(t.c.replyBubbleIsShowing)
    #expect(t.acks.last == [HeldReply(thread: "general", seq: 5)])
  }

  @Test func offLeavesNoPanelNoTimerNoText() {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    t.fx.turnOff()
    #expect(t.c.panels.isEmpty && t.c.activeTimerCount == 0 && t.c.activeListenerCount == 0)
    #expect(t.c.replyBubbleViewForTest?.bodyField.stringValue ?? "" == "")
  }

  @Test func theBubbleStacksAboveHimAndAnotherBubbleSitsPastIt() throws {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    let rb = try #require(t.c.replyBubblePanelForTest).frame
    let sprite = try #require(t.c.spritePanelForTest).frame
    #expect(!rb.intersects(sprite))
    t.feed(feedFrame(needs: 1, rows: [["thread_id": "a1", "state": "needs_you"]]))
    t.fx.advance(4)
    #expect(t.c.bubbleIsShowing && t.c.replyBubbleIsShowing)
    #expect(!(try #require(t.c.bubblePanelForTest).frame.intersects(try #require(t.c.replyBubblePanelForTest).frame)), "two bubbles never overlap")
  }

  // MARK: the page holds replies for him (the window is in use)

  @Test func aHeldReplyComesInHisBubbleAndIsAckedOnceItIsShown() throws {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = true
    held(t, "general", seq: 5)
    #expect(t.replyRequests == ["general"], "the first line is asked of the page")
    #expect(t.acks.allSatisfy { $0.isEmpty }, "not shown yet, so not acked")
    replyText(t)
    #expect(t.c.replyBubbleIsShowing)
    #expect(t.c.replyBubbleViewForTest?.headerField.stringValue == "DAILY PLAN · new reply")
    #expect(t.acks.last == [HeldReply(thread: "general", seq: 5)], "the page may now forget it")
    t.feed(feedFrame(unread: 1, held: [("general", 5)]))  // the page has not heard yet
    #expect(t.replyRequests.count == 1, "and he does not take it twice")
    t.c.replyBubbleViewForTest?.onOpen?()
    #expect(t.paths == ["/t/general"])
  }

  @Test func aSecondHeldReplyInTheSameThreadFortySecondsLaterGetsItsBubbleToo() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = true
    held(t, "general", seq: 5)
    replyText(t)
    t.c.replyBubbleViewForTest?.onLater?()
    t.fx.advance(40)
    held(t, "general", seq: 9)
    #expect(t.replyRequests.count == 2, "the model's 60 s gap does not apply to the page's list")
    replyText(t, "Second one", at: 1)
    #expect(t.c.replyBubbleIsShowing && t.acks.last == [HeldReply(thread: "general", seq: 9)])
  }

  @Test func twoHeldRepliesInOneFrameAreOneBubbleAndOneAck() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = true
    t.feed(feedFrame(unread: 2, held: [("general", 5), ("a1", 6)]))
    replyText(t)
    #expect(t.c.replyBubbleViewForTest?.headerField.stringValue == "2 new replies")
    #expect(Set(t.acks.last ?? []) == [HeldReply(thread: "general", seq: 5), HeldReply(thread: "a1", seq: 6)])
  }

  @Test func aHeldReplyMidTurnWaitsForThatThreadsTurnAndThenComes() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = true
    let working: [[String: Any]] = [["thread_id": "general", "state": "working"]]
    t.feed(feedFrame(rows: working, held: [("general", 5)]))
    #expect(t.replyRequests.isEmpty && !t.c.replyBubbleIsShowing)
    t.feed(feedFrame(unread: 1, held: [("general", 5)]))  // the turn ended
    #expect(t.replyRequests == ["general"])
  }

  @Test func aHeldReplyThatWaitedPastItsExpiryIsPostedAsABannerAndAcked() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = true
    let working: [[String: Any]] = [["thread_id": "general", "state": "working"]]
    t.feed(feedFrame(rows: working, held: [("general", 5)]))
    t.fx.advance(ReplyLedger.expiry + 5)
    t.feed(feedFrame(rows: working, held: [("general", 5)]))
    #expect(t.fallbackBanners == ["general:Daily plan"])
    #expect(t.acks.last == [HeldReply(thread: "general", seq: 5)], "acked in the same breath, so the page does not toast it too")
  }

  @Test func whenHeStopsInAKeyWindowThePageKeepsWhatItHeldForItsToast() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = true
    held(t)
    t.c.envAdjust = { $0.micRunning = true }
    t.fx.advance(0.5)
    #expect(t.flags.last == false)
    #expect(t.fallbackBanners.isEmpty && t.acks.allSatisfy { $0.isEmpty }, "the page toasts it; nothing here")
  }

  @Test func whenHeStopsOutsideAKeyWindowItBecomesOneBannerAndOneAck() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = false
    held(t)
    t.c.envAdjust = { $0.micRunning = true }
    t.fx.advance(0.5)
    #expect(t.fallbackBanners == ["general:Daily plan"])
    #expect(t.acks.last == [HeldReply(thread: "general", seq: 5)])
    #expect(t.flags.last == false)
  }

  @Test func inQuietHoursNothingIsPostedAndThePageToastsIt() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.inputs.windowIsKey = false
    held(t)
    t.fx.inputs.quiet = true
    t.fx.advance(0.5)
    #expect(t.fallbackBanners.isEmpty && t.acks.allSatisfy { $0.isEmpty } && t.flags.last == false)
  }

  @Test func withTheToggleOffAHeldListIsIgnored() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.defaults.set(false, forKey: CompanionController.Key.replyBubbles)
    t.fx.inputs.windowIsKey = true
    held(t)
    #expect(t.replyRequests.isEmpty && !t.c.replyBubbleIsShowing)
  }

  // MARK: the flag that makes the page's jump banner stand down

  @Test func theFlagIsOnWhileHeCanDeliverAndOffTheMomentAnythingChanges() {
    let t = LiveFixture()
    defer { t.done() }
    #expect(t.flags.last == true && t.c.repliesFlagIsOn, "on and fed: he delivers")
    t.c.snooze()
    #expect(t.flags.last == false, "snoozed")
    t.c.endSnooze()
    #expect(t.flags.last == true, "and back when the snooze ends")
    t.c.hide()
    #expect(t.flags.last == false, "hidden")
    t.fx.turnOn()
    #expect(t.flags.last == true)
    t.fx.inputs.quiet = true
    t.fx.advance(0.5)
    #expect(t.flags.last == false, "quiet hours")
    t.fx.inputs.quiet = false
    t.fx.advance(0.5)
    #expect(t.flags.last == true)
    t.c.envAdjust = { $0.micRunning = true }
    t.fx.advance(0.5)
    #expect(t.flags.last == false, "a call")
    t.c.envAdjust = nil
    t.fx.advance(0.5)
    #expect(t.flags.last == true)
    t.fx.defaults.set(false, forKey: CompanionController.Key.replyBubbles)
    t.fx.spin(0.2)
    #expect(t.flags.last == false, "the toggle off")
    t.fx.defaults.set(true, forKey: CompanionController.Key.replyBubbles)
    t.fx.spin(0.2)
    #expect(t.flags.last == true)
    t.feed(nil)
    #expect(t.flags.last == false, "no feed")
    t.feed(feedFrame())
    #expect(t.flags.last == true)
    t.fx.inputs.sessionNeedsYou = true
    t.fx.advance(4)
    #expect(t.flags.last == false, "needs you outranks a reply")
    t.fx.inputs.sessionNeedsYou = false
    t.fx.advance(8)
    #expect(t.flags.last == true)
    t.fx.controller.shutdown()
    #expect(t.flags.last == false, "app quit")
  }

  @Test func theFlagOnlyChangesWhenItsValueChanges() {
    let t = LiveFixture()
    defer { t.done() }
    let before = t.flags.count
    t.fx.advance(0.5)
    t.fx.advance(0.5)
    #expect(t.flags.count == before)
  }

  // MARK: hover follows the pointer

  @Test func afterItIsDismissedHoverIsReadFromWherePointerReallyIs() throws {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    let sprite = try #require(t.c.spritePanelForTest).frame
    t.fx.pointer = CGPoint(x: sprite.midX, y: sprite.midY)
    t.c.replies.spriteHovered = true
    t.c.replyBubbleViewForTest?.onLater?()
    #expect(t.c.replies.spriteHovered, "the pointer is still on him")
    t.fx.pointer = CGPoint(x: -5000, y: -5000)
    t.fx.advance(70)  // past the reducer's minute between bubbles for one thread
    reply(t, seq: 6)
    replyText(t, at: 1)
    t.c.replyBubbleViewForTest?.onLater?()
    #expect(!t.c.replies.spriteHovered && !t.c.replies.bubbleHovered)
  }

  @Test func theBubbleLetsGoOfHoverWhenItMovesAwayFromThePointer() throws {
    let t = LiveFixture()
    defer { t.done() }
    reply(t)
    replyText(t)
    let panel = try #require(t.c.replyBubblePanelForTest)
    t.fx.pointer = CGPoint(x: panel.frame.midX, y: panel.frame.midY)
    t.c.replies.bubbleHovered = true
    t.fx.pointer = CGPoint(x: -5000, y: -5000)  // the pointer is elsewhere when the panel is laid out again
    t.c.replies.relayout()
    #expect(!t.c.replies.bubbleHovered)
  }

  // MARK: the page's banner, end to end through the app's own notify route

  private func notify(_ t: LiveFixture, body: String = "New reply in Daily plan", navigate: String = "/t/general") {
    StatusCoordinator().webNotify(title: "Talos", body: body, navigate: navigate, tag: "thread:general", companion: t.c)
  }

  @Test func whileHeCanShowItNoBannerIsPosted() {
    let t = LiveFixture()
    let b = Banners()
    defer { b.close(); t.done() }
    notify(t)
    #expect(b.seen.isEmpty)
  }

  @Test func snoozedHiddenOrOffThePlainBannerIsPosted() {
    let t = LiveFixture()
    let b = Banners()
    defer { b.close(); t.done() }
    t.c.snooze()
    notify(t)
    #expect(b.seen.map(\.body) == ["New reply in Daily plan"])
    b.seen = []
    Notifier.shared.resetRateLimitForTest()
    t.c.endSnooze()
    t.c.hide()
    notify(t)
    #expect(b.seen.map(\.navigate) == ["/t/general"])
  }

  @Test func quietOrAMicKeepsTheBannerThePageAlreadySentAndNothingNewIsAdded() {
    let t = LiveFixture()
    let b = Banners()
    defer { b.close(); t.done() }
    t.c.envAdjust = { $0.micRunning = true }
    notify(t)
    #expect(b.seen.count == 1, "the page's banner, as today")
  }

  @Test func theThreadOnScreenInAKeyWindowGetsNeitherBanner() {
    let t = LiveFixture()
    let b = Banners()
    defer { b.close(); t.done() }
    t.fx.inputs.viewedThread = "general"
    t.fx.inputs.windowIsKey = true
    t.c.envAdjust = { $0.micRunning = true }  // so the banner would otherwise have been posted
    notify(t)
    #expect(b.seen.isEmpty)
  }

  @Test func aVisibleButUnfocusedWindowAtThatThreadStillGetsTheBannerWhenHeIsOff() {
    let t = LiveFixture()
    let b = Banners()
    defer { b.close(); t.done() }
    t.fx.inputs.viewedThread = "general"
    t.fx.inputs.windowIsKey = false
    t.c.hide()
    notify(t)
    #expect(b.seen.map(\.navigate) == ["/t/general"], "today's behaviour is fully restored when he is off")
  }

  @Test func aReplyInAThreadThatIsMidTurnKeepsItsBannerWhileAnotherThreadsDoesNot() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame(rows: [["thread_id": "general", "state": "working"]]))
    #expect(!t.c.dropsReplyBanner(body: "New reply in Daily plan", navigate: "/t/general"), "his Done waits for that turn")
    #expect(t.c.dropsReplyBanner(body: "New reply in A thread", navigate: "/t/a1"))
  }

  @Test func theOwnerWhoWantsBothGetsTheBannerAndTheBubble() {
    let t = LiveFixture()
    let b = Banners()
    defer { b.close(); t.done() }
    t.fx.defaults.set(true, forKey: CompanionController.Key.replyBanners)
    notify(t)
    #expect(b.seen.count == 1)
    reply(t)
    replyText(t)
    #expect(t.c.replyBubbleIsShowing)
  }

  @Test func otherBannersAreAlwaysPosted() {
    let t = LiveFixture()
    let b = Banners()
    defer { b.close(); t.done() }
    notify(t, body: "Needs you in Daily plan")
    #expect(b.seen.count == 1)
  }
}

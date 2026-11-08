import CoreGraphics
import Foundation
import Testing

@testable import TalosDesktopCore

// Mini Talos delivers thread replies: the delivery decision, the bubble's words, the pile-up of several replies, and where Open goes.
// All data here is made up.

private func pet(
  onScreen: Bool = true, quiet: Bool? = false, mic: Bool = false, feed: Bool = true, state: CompanionState = .idle, both: Bool = false,
  viewing: String? = nil, key: Bool = true, working: Set<String> = []
) -> CompanionBannerPolicy.Pet {
  .init(
    onScreen: onScreen, quiet: quiet, micRunning: mic, feedLive: feed, state: state, replyBanners: both, viewedThread: viewing,
    windowIsKey: key, workingThreads: working)
}

@Suite("Reply delivery: bubble, banner or nothing")
struct ReplyRouteTests {
  let body = "New reply in Work"
  let nav = "/t/work"

  @Test func whileHeCanShowItTheReplyGoesToHisBubble() {
    for s in [CompanionState.idle, .done, .asleep] {
      #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(state: s)) == .bubble, "\(s)")
    }
    #expect(ReplyDelivery.route(body: "Answer ready in Work", navigate: nav, pet: pet()) == .bubble)
  }

  @Test func anyOtherConditionKeepsTodaysBanner() {
    let cases: [(String, (inout CompanionBannerPolicy.Pet) -> Void)] = [
      ("hidden, off or snoozed", { $0.onScreen = false }),
      ("quiet", { $0.quiet = true }),
      ("quiet not known yet", { $0.quiet = nil }),
      ("mic", { $0.micRunning = true }),
      ("feed down", { $0.feedLive = false }),
      ("down", { $0.state = .down }),
      ("needs you", { $0.state = .needsYou }),
      ("trouble", { $0.state = .trouble }),
      ("this thread is mid-turn: his Done waits for it", { $0.workingThreads = ["work"] }),
      ("owner wants the banner too", { $0.replyBanners = true }),
    ]
    for (name, change) in cases {
      var p = pet()
      change(&p)
      #expect(ReplyDelivery.route(body: body, navigate: nav, pet: p) == .banner, "\(name)")
    }
  }

  @Test func aReplyInTheThreadYouAreReadingGetsNothingAtAll() {
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(viewing: "work")) == .nothing)
    // not even a banner when he could not have shown it, or when the owner asked for both
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(onScreen: false, viewing: "work")) == .nothing)
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(mic: true, viewing: "work")) == .nothing)
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(both: true, viewing: "work")) == .nothing)
  }

  @Test func theThreadOnScreenOnlyCountsWhileTheWindowIsKey() {
    // visible but not focused: the owner is not reading it, so the banner (or his bubble) still comes
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(onScreen: false, viewing: "work", key: false)) == .banner)
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(mic: true, viewing: "work", key: false)) == .banner)
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(viewing: "work", key: false)) == .bubble)
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(onScreen: false, viewing: "work", key: true)) == .nothing)
  }

  @Test func aGlobalWorkingStateDoesNotKeepTheBannerForAnotherThreadsReply() {
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(state: .working, working: ["ops"])) == .bubble)
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(state: .working, working: ["work"])) == .banner)
  }

  @Test func aReplyInAnotherThreadIsNotHeldBackByTheThreadYouAreReading() {
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(viewing: "ops")) == .bubble)
    #expect(ReplyDelivery.route(body: body, navigate: nav, pet: pet(viewing: nil)) == .bubble)
  }

  @Test func everyOtherBannerIsUntouchedEvenForTheThreadYouAreReading() {
    for b in ["Needs you in Work", "Talos's Mac session stopped", "Overnight: 3 items", "New activity"] {
      #expect(ReplyDelivery.route(body: b, navigate: nav, pet: pet(viewing: "work")) == .banner, "\(b)")
    }
    #expect(ReplyDelivery.route(body: "New reply in \n" + String(repeating: "x", count: 90), navigate: nav, pet: pet()) == .banner)
  }

  @Test func theThreadComesFromTheInAppPath() {
    #expect(ReplyDelivery.threadId(inPath: "/t/work") == "work")
    #expect(ReplyDelivery.threadId(inPath: "/t/work?x=1#top") == "work")
    #expect(ReplyDelivery.threadId(inPath: "/t/oc_test_2") == "oc_test_2")
    for bad in ["/", "/t/", "/t/all", "/t/Work", "/t/work/extra", "/card/abc", "t/work", "", "/t/9lives", "/t/" + String(repeating: "a", count: 33)] {
      #expect(ReplyDelivery.threadId(inPath: bad) == nil, "\(bad)")
    }
    #expect(ReplyDelivery.threadId(inPath: nil) == nil)
  }

  @Test func aReplyBannerWithAPathThatNamesNoThreadIsNotHeldBack() {
    #expect(ReplyDelivery.route(body: body, navigate: "/", pet: pet(viewing: "work")) == .bubble)
  }
}

@Suite("Reply delivery: the words in the bubble")
struct ReplyBubbleTextTests {
  private func one(_ name: String = "Work", id: String = "work", line: String? = nil) -> ReplyBubbleContent {
    var c = ReplyBubbleContent()
    c.add(thread: id, name: name)
    c.line = line
    return c
  }

  @Test func oneReplyHasTheThreadNameInCapsAndItsFirstLine() {
    let c = one(line: "Ticket's in: ISH-5238 is codenamed Tron: Hephaestus…")
    #expect(c.header == "WORK · new reply")
    #expect(c.body == "Ticket's in: ISH-5238 is codenamed Tron: Hephaestus…")
    #expect(c.count == 1)
    #expect(c.spoken == "New reply in Work: Ticket's in: ISH-5238 is codenamed Tron: Hephaestus…")
  }

  @Test func withoutTheTextItStillSaysWhatToDo() {
    let c = one()
    #expect(c.header == "WORK · new reply")
    #expect(c.body == "Open to read it.")
  }

  @Test func theThreadNameIsOneCleanShortLine() {
    let hostile = "\u{202E}evil\nname " + String(repeating: "z", count: 200)
    let c = one(hostile)
    #expect(!c.header.contains("\n") && !c.header.contains("\u{202E}"))
    #expect(c.header.count <= 40 + " · new reply".count)
    #expect(one("  ").header == "TALOS · new reply", "an empty name reads Talos")
  }

  @Test func severalRepliesAreOneLineWithTheCountAndTheNames() {
    var c = ReplyBubbleContent()
    c.add(thread: "work", name: "Work")
    c.add(thread: "oc_test", name: "OC Test")
    c.add(thread: "ops", name: "Ops")
    #expect(c.count == 3)
    #expect(c.header == "3 new replies")
    #expect(c.body == "Work, OC Test…")
    #expect(c.spoken == "3 new replies: Work, OC Test…")
  }

  @Test func twoRepliesListBothNamesWithNoDots() {
    var c = ReplyBubbleContent()
    c.add(thread: "work", name: "Work")
    c.add(thread: "ops", name: "Ops")
    #expect(c.spoken == "2 new replies: Work, Ops")
  }

  @Test func aThreadThatRepliesAgainIsOneEntryAndMovesToTheNewest() {
    var c = ReplyBubbleContent()
    c.add(thread: "work", name: "Work")
    c.add(thread: "ops", name: "Ops")
    c.add(thread: "work", name: "Work")
    #expect(c.items.map(\.id) == ["ops", "work"], "ordered by arrival, once each, the newest last")
    #expect(c.count == 2)
  }

  @Test func equalNamesInDifferentThreadsAreListedOnce() {
    var c = ReplyBubbleContent()
    c.add(thread: "a1", name: "A thread")
    c.add(thread: "a2", name: "A thread")
    c.add(thread: "ops", name: "Ops")
    #expect(c.count == 3)
    #expect(c.body == "A thread, Ops")
  }

  @Test func theListIsCutAtTwoNamesAndEachNameAtFortyCharacters() {
    var c = ReplyBubbleContent()
    for (i, n) in ["Alpha", "Beta", "Gamma", "Delta", "Echo"].enumerated() { c.add(thread: "t\(i)", name: n) }
    #expect(c.body == "Alpha, Beta…")
    var long = ReplyBubbleContent()
    long.add(thread: "a", name: String(repeating: "q", count: 90))
    long.add(thread: "b", name: "B")
    #expect(long.body.count <= 40 + 2 + 1 + 1)
  }

  @Test func theFirstLineOfTheNewestReplyIsForgottenWhenAnotherThreadJoins() {
    var c = one(line: "Done.")
    c.add(thread: "ops", name: "Ops")
    #expect(c.line == nil)
  }

  @Test func firstLineTakesTheFirstRealLineCleansMarkupAndCutsLongOnes() {
    #expect(ReplyBubbleContent.firstLine(of: "Done.\nThe second line.") == "Done.")
    #expect(ReplyBubbleContent.firstLine(of: "\n\n  Hello there  \nmore") == "Hello there")
    #expect(ReplyBubbleContent.firstLine(of: "## Plan for **today**\n- one") == "Plan for today")
    #expect(ReplyBubbleContent.firstLine(of: "---\n> `code` first") == "code first")
    #expect(ReplyBubbleContent.firstLine(of: "a   b \t c") == "a b c")
    #expect(ReplyBubbleContent.firstLine(of: "") == nil)
    #expect(ReplyBubbleContent.firstLine(of: "  \n \n") == nil)
    let long = String(repeating: "word ", count: 40)
    let cut = try! #require(ReplyBubbleContent.firstLine(of: long))
    #expect(cut.hasSuffix("…") && cut.count <= ReplyBubbleContent.maxLine + 1)
    #expect(!cut.dropLast().hasSuffix(" "), "no space before the dots")
    let exact = String(repeating: "x", count: ReplyBubbleContent.maxLine)
    #expect(ReplyBubbleContent.firstLine(of: exact) == exact, "a line that fits is left alone")
  }

  @Test func firstLineStripsBidiAndControlCharacters() {
    #expect(ReplyBubbleContent.firstLine(of: "It is\u{202E} done\u{0007}.") == "It is done.")
  }

  @Test func aTextThePageCutGetsTheDotsEvenWhenItsLastLineIsShort() {
    #expect(ReplyBubbleContent.firstLine(of: "Short one", truncated: true) == "Short one…")
    #expect(ReplyBubbleContent.firstLine(of: "Short one\nand another", truncated: true) == "Short one")
  }
}

@Suite("Reply delivery: Open, Later and how long it stays")
struct ReplyBubbleTargetTests {
  @Test func openGoesToTheThreadOfASingleReply() {
    var c = ReplyBubbleContent()
    c.add(thread: "work", name: "Work")
    #expect(c.openPath == "/t/work")
  }

  @Test func openGoesHomeWhenSeveralThreadsReplied() {
    var c = ReplyBubbleContent()
    c.add(thread: "work", name: "Work")
    c.add(thread: "ops", name: "Ops")
    #expect(c.openPath == "/", "Home shows them all; a thread would hide the others")
  }

  @Test func aSecondReplyInTheSameThreadStillOpensThatThread() {
    var c = ReplyBubbleContent()
    c.add(thread: "work", name: "Work")
    c.add(thread: "work", name: "Work")
    #expect(c.openPath == "/t/work" && c.count == 1)
  }

  @Test func itStaysThirtySecondsAndOpensOnlyAnInAppPath() {
    #expect(ReplyBubbleContent.lifetime == 30)
    var c = ReplyBubbleContent()
    c.add(thread: "work", name: "Work")
    #expect(AppPath.isValid(c.openPath))
    #expect(AppPath.isValid(ReplyBubbleContent().openPath))
  }

  @Test func theBannerWeFallBackToIsTheFixedPhraseForThatThread() throws {
    let n = NotificationPolicy.replyBanner(agent: "Talos", thread: "Work", id: "work")
    #expect(n.body == "New reply in Work" && NotificationPolicy.isPushPhrase(n.body))
    #expect(n.navigate == "/t/work" && n.title == "Talos" && !n.quiet)
    #expect(n.tag == "web:thread:work", "the page's own banner for that thread has this tag, so the two replace each other")
    let hostile = NotificationPolicy.replyBanner(agent: "A\nB", thread: "x\ny" + String(repeating: "z", count: 99), id: "work")
    #expect(NotificationPolicy.isPushPhrase(hostile.body))
  }
}

@Suite("Reply delivery: where the bubble sits")
struct ReplyBubblePlacementTests {
  let v = CGRect(x: 0, y: 0, width: 1280, height: 800)
  let size = CGSize(width: CompanionPlacement.replyBubbleWidth, height: 110)

  @Test func itSitsAboveHimAndStaysOnScreenInAllFourCorners() {
    for o in [CGPoint(x: 8, y: 8), CGPoint(x: 1176, y: 8), CGPoint(x: 8, y: 688), CGPoint(x: 1176, y: 688)] {
      let s = CGRect(origin: o, size: CompanionPlacement.standardSize)
      let f = CompanionPlacement.replyBubbleFrame(sprite: s, size: size, past: nil, in: v)
      #expect(v.contains(f))
      #expect(!f.intersects(s))
    }
  }

  @Test func atTheTopEdgeItFlipsBelowHim() {
    let s = CGRect(x: 600, y: 688, width: 96, height: 104)
    let f = CompanionPlacement.replyBubbleFrame(sprite: s, size: size, past: nil, in: v)
    #expect(f.maxY <= s.minY)
  }

  @Test func itSitsPastTheControlsOnTheSameSide() {
    let s = CGRect(x: 600, y: 8, width: 96, height: 104)
    let controls = CGRect(x: 566, y: s.maxY, width: 164, height: 74)
    let f = CompanionPlacement.replyBubbleFrame(sprite: s, size: size, past: controls, in: v)
    #expect(f.minY >= controls.maxY)
  }
}

@Suite("Reply delivery: a key window leaves replies to the page's held list")
struct ReplyKeyWindowModelTests {
  private func frame(rows: [[String: Any]] = [], reply: (String, Int)? = nil, unread: Int = 0) -> CompanionFeed {
    let o: [String: Any] = [
      "type": "companion_state", "link": "online", "mac_online": true, "busy": false, "needs": 0, "working": 0, "queued": 0,
      "on_call": 0, "unread": unread, "failed": 0, "rows": rows,
      "last_reply": reply.map { ["thread_id": $0.0, "seq": $0.1] as [String: Any] } ?? NSNull(),
    ]
    guard case .companionState(let f)? = WebToNative.decode(o) else { fatalError("the test frame must decode") }
    return f
  }

  private func rig() -> Rig {
    var r = Rig()
    r.inputs.threads = [CompanionThreadRef(id: "work", name: "Work"), CompanionThreadRef(id: "ops", name: "Ops")]
    r.inputs.pageStatus = .ready
    r.inputs.feed = frame()
    r.tick()
    return r
  }

  @Test func aKeyWindowGetsNoDoneBubbleFromTheModelThePagesHeldListDoesThat() {
    var r = rig()
    r.inputs.windowIsKey = true
    r.inputs.feed = frame(reply: ("work", 1), unread: 1)
    r.advance(3)
    #expect(r.bubbles.isEmpty && r.last?.state != .done, "no second delivery from the reducer")
  }

  @Test func aWindowThatIsNotKeyStillGetsItsDoneBubbleEvenOnTheThreadItShows() {
    var r = rig()
    r.inputs.windowIsKey = false
    r.inputs.viewedThread = "work"  // visible, not focused: nobody is reading it
    r.inputs.feed = frame(reply: ("work", 1), unread: 1)
    r.advance(1)
    #expect(r.bubbles == ["New reply in Work"])
  }
}

@Suite("Reply delivery: the flag the page hears")
struct ReplyFlagTests {
  @Test func theFlagMessageCarriesWhatHeShownAndTheShellMayEvaluateIt() throws {
    let shown = [HeldReply(thread: "ops", seq: 7), HeldReply(thread: "work", seq: 9)]
    let m = NativeToWeb.companionReplies(on: true, shown: shown)
    #expect(m.object["type"] as? String == "companion_replies" && m.object["on"] as? Bool == true)
    let list = try #require(m.object["shown"] as? [[String: Any]])
    #expect(list.count == 2 && list[0]["thread_id"] as? String == "ops" && list[0]["seq"] as? Int == 7)
    #expect(NativeToWeb.companionReplies(on: false, shown: []).jsonString() == #"{"on":false,"type":"companion_replies"}"#)
    let js = try #require(m.javascript())
    #expect(js.hasPrefix("window.talosNative && window.talosNative.receive(") && js.contains("companion_replies"))
    #expect(NativeToWeb.validated(m) == m)
    let bad = NativeToWeb.companionReplies(on: true, shown: [HeldReply(thread: "ALL", seq: 1)])
    #expect(NativeToWeb.validated(bad) == nil, "a thread id the page would refuse never leaves")
    #expect(NativeToWeb.validated(.companionReplies(on: true, shown: [HeldReply(thread: "ops", seq: -1)])) == nil)
    #expect(NativeToWeb.validated(.companionReplies(on: true, shown: (0..<13).map { HeldReply(thread: "t\($0)", seq: $0) })) == nil)
  }

  private func pet(
    onScreen: Bool = true, quiet: Bool? = false, mic: Bool = false, feed: Bool = true, state: CompanionState = .idle
  ) -> CompanionBannerPolicy.Pet {
    .init(onScreen: onScreen, quiet: quiet, micRunning: mic, feedLive: feed, state: state, replyBanners: false)
  }

  @Test func heDeliversWhenHeIsOnAwakeQuietlessFedAndNotOutranked() {
    for s in [CompanionState.idle, .done, .asleep, .working] { #expect(CompanionBannerPolicy.canDeliver(pet: pet(state: s)), "\(s)") }
  }

  @Test func anyCauseToFallBackTakesTheFlagDown() {
    #expect(!CompanionBannerPolicy.canDeliver(pet: pet(onScreen: false)), "hidden, off or snoozed")
    #expect(!CompanionBannerPolicy.canDeliver(pet: pet(quiet: true)))
    #expect(!CompanionBannerPolicy.canDeliver(pet: pet(quiet: nil)))
    #expect(!CompanionBannerPolicy.canDeliver(pet: pet(mic: true)))
    #expect(!CompanionBannerPolicy.canDeliver(pet: pet(feed: false)))
    for s in [CompanionState.down, .needsYou, .trouble] { #expect(!CompanionBannerPolicy.canDeliver(pet: pet(state: s)), "\(s)") }
  }
}

@Suite("Reply delivery: the page's viewing and held fields")
struct ReplyFeedFieldsTests {
  private func frame(_ over: [String: Any] = [:], drop: [String] = []) -> [String: Any] {
    var o: [String: Any] = [
      "type": "companion_state", "link": "online", "mac_online": true, "busy": false, "needs": 0, "working": 0, "queued": 0,
      "on_call": 0, "unread": 0, "failed": 0, "rows": [], "last_reply": NSNull(),
    ]
    for (k, v) in over { o[k] = v }
    for k in drop { o[k] = nil }
    return o
  }

  private func feed(_ o: [String: Any]) -> CompanionFeed? {
    if case .companionState(let f)? = WebToNative.decode(o) { return f }
    return nil
  }

  @Test func aFrameWithoutThemStillDecodesAsNothingOnScreenAndNothingHeld() {
    let f = feed(frame())
    #expect(f != nil && f?.viewing == nil && f?.held == [])
  }

  @Test func theyDecodeWhenPresent() {
    let f = feed(frame(["viewing": "general", "held": [["thread_id": "ops", "seq": 4], ["thread_id": "work", "seq": 9]]]))
    #expect(f?.viewing == "general")
    #expect(f?.held == [HeldReply(thread: "ops", seq: 4), HeldReply(thread: "work", seq: 9)])
    #expect(feed(frame(["viewing": NSNull(), "held": []]))?.viewing == nil)
  }

  @Test func aBadHeldEntryDropsThatEntryNotTheFrame() {
    let f = feed(
      frame(["held": [["thread_id": "ops", "seq": 4], ["thread_id": "ALL", "seq": 1], ["thread_id": "x"], 5, ["thread_id": "ops", "seq": 6], ["thread_id": "w", "seq": -1]]]))
    #expect(f?.held == [HeldReply(thread: "ops", seq: 6)], "the bad ones are dropped, and a thread is listed once with its newest seq")
  }

  @Test func heldIsCappedAndOneEntryPerThreadTheNewestWins() {
    let many = (0..<20).map { ["thread_id": "t\($0)", "seq": $0] as [String: Any] }
    #expect(feed(frame(["held": many]))?.held.count == CompanionFeed.maxRows)
  }

  @Test func aBadViewingOrAHeldThatIsNotAListIsAnInvalidFrame() {
    for (k, v) in [("viewing", "ALL" as Any), ("viewing", 5), ("held", "ops"), ("held", NSNull())] {
      #expect(WebToNative.decode(frame([k: v])) == .companionInvalid, "\(k)=\(v)")
    }
  }

  @Test func anOtherUnknownFieldIsStillInvalid() {
    #expect(WebToNative.decode(frame(["text": "a name"])) == .companionInvalid)
  }
}

@Suite("Reply delivery: words that must stay a push phrase")
struct ReplyWordsTests {
  @Test func aLabelIsCutByUTF16SoCombiningMarksCannotFloodIt() {
    let flood = "e" + String(repeating: "\u{0301}", count: 200)
    let l = CompanionPhrase.label(flood)
    #expect(l.utf16.count <= 40, "\(l.utf16.count)")
    let family = String(repeating: "👨‍👩‍👧‍👦", count: 30)
    #expect(CompanionPhrase.label(family).utf16.count <= 40)
    #expect(CompanionPhrase.label("Daily plan") == "Daily plan")
  }

  @Test func theBannerBodyIsAlwaysAPushPhraseOrNewActivity() {
    let flood = "e" + String(repeating: "\u{0301}", count: 200)
    for name in ["Work", flood, String(repeating: "👨‍👩‍👧‍👦", count: 30), "x\ny", ""] {
      let n = NotificationPolicy.replyBanner(agent: "Talos", thread: name, id: "work")
      #expect(NotificationPolicy.isPushPhrase(n.body), "\(n.body.utf16.count)")
    }
    #expect(NotificationPolicy.replyBanner(agent: "Talos", thread: "Work", id: "work").body == "New reply in Work")
  }

  @Test func theBubbleContentKeepsASeqPerThreadAndTheHighestOne() {
    var c = ReplyBubbleContent()
    c.add(thread: "ops", name: "Ops", seq: 4)
    c.add(thread: "work", name: "Work", seq: 5)
    c.add(thread: "ops", name: "Ops", seq: nil)  // the reducer's own bubble for the same thread
    #expect(c.items.map(\.id) == ["work", "ops"])
    #expect(c.items.last?.seq == 4, "a later add without a seq keeps the one it had")
    c.add(thread: "ops", name: "Ops", seq: 8)
    #expect(c.items.last?.seq == 8)
    c.add(thread: "ops", name: "Ops", seq: 2)
    #expect(c.items.last?.seq == 8, "never lowered")
    #expect(c.held == [HeldReply(thread: "work", seq: 5), HeldReply(thread: "ops", seq: 8)])
  }
}

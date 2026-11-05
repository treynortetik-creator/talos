import AppKit
import Foundation
import Testing
import TalosDesktopCore
import WebKit

@testable import TalosDesktop

/// Send in the compose panel against a real web view whose page answers `talosNative.receive` the way a real page can:
/// takes the message, refuses it, has no receiver, or throws. The owner's text may only go when the page took the message.
/// The panel is built but never put on screen (no `show`, no `contentViewForTest`), so a run does not flash a window.
/// The relay origin is faked with `loadHTMLString(baseURL:)`. The controller still starts one load of that origin before the
/// test page replaces it, so a run may make a request that fails to resolve. Needs TALOS_GUI_TESTS=1.
@MainActor
@Suite("QuickCompose send", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct QuickComposeSendGuiTests {
  static let draft = "Check /home/alex/notes.md before the call"
  static let keptLine = "Talos didn't take that (is it open and signed in?). Your text is kept."

  static let lostLine = "Talos went away before answering. Check the thread before sending again."

  /// A page whose receiver records every call in `window.__got` (and which door in `window.__doors`), then runs `body` (its
  /// return value is the answer). `ack` adds the newer `receiveAck` door the same way; nil for both is a page with no receiver.
  static func page(receiver body: String?, ack: String? = nil) -> String {
    let doors = [
      body.map { "receive: function (j) { window.__got.push(j); window.__doors.push('receive'); \($0) }" },
      ack.map { "receiveAck: function (j) { window.__got.push(j); window.__doors.push('receiveAck'); \($0) }" },
    ].compactMap { $0 }
    let install = doors.isEmpty ? "" : "window.talosNative = { \(doors.joined(separator: ", ")) };"
    return "<html><body><script>window.__got = []; window.__doors = []; \(install)</script></body></html>"
  }

  @MainActor struct Rig {
    let web: WebController
    let view: WKWebView
    func doors() async throws -> [String] {
      let all = try await view.evaluateJavaScript("JSON.stringify(window.__doors)") as? String ?? "[]"
      return try #require(JSONSerialization.jsonObject(with: Data(all.utf8)) as? [String])
    }
    func received() async throws -> [[String: String]] {
      let all = try await view.evaluateJavaScript("JSON.stringify(window.__got)") as? String ?? "[]"
      let raw = try #require(JSONSerialization.jsonObject(with: Data(all.utf8)) as? [String])
      return try raw.map { try #require(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: String]) }
    }
  }

  /// A controller whose page has loaded `html` and said `ready`, signed in, with one known thread. Compose is pointed at it.
  func rig(page html: String, threads: [(id: String, name: String)] = [("work", "Work")]) async throws -> Rig {
    cannotTakeTheKeyboard()  // no Dock icon, no activation: the panel is never shown, and the app could not take the keyboard if it were
    let web = WebController()
    web.configure(relay: RelayOrigin("https://relay.example.com")!)
    web.prepare()
    let view = try #require(web.webView)
    view.loadHTMLString(html, baseURL: URL(string: "https://relay.example.com/")!)
    // The page has run once `__got` exists. Bounded only so a starved machine ends the test with a message.
    var ran = false
    for _ in 0..<200 where !ran {
      try? await Task.sleep(nanoseconds: 50_000_000)
      ran = (try? await view.evaluateJavaScript("Array.isArray(window.__got)")) as? Bool == true
    }
    try #require(ran, "the test page never ran")
    web.nativeMessage(.ready(signedIn: true, features: []))
    web.nativeMessage(
      try #require(WebToNative.decode(["type": "threads", "items": threads.map { ["id": $0.id, "name": $0.name] }])))
    UserDefaults.standard.removeObject(forKey: QuickCompose.lastThreadKey)
    QuickCompose.shared.useWebForTest(web)
    QuickCompose.shared.resetForTest()
    QuickCompose.shared.prepareShow(thread: nil)  // builds and fills the panel; never orders it onto the screen
    QuickCompose.shared.dropPreviousAppForTest()
    QuickCompose.shared.setTextForTest(Self.draft)
    return Rig(web: web, view: view)
  }

  func cleanUp(_ r: Rig) {
    QuickCompose.shared.resetForTest()
    UserDefaults.standard.removeObject(forKey: QuickCompose.lastThreadKey)
    r.web.nativeMessage(.ready(signedIn: false, features: []))
    QuickCompose.shared.useWebForTest(.shared)
  }

  /// Presses Send and waits for the answer: the status leaves "Sending…" (kept) or the panel hides (taken).
  func send() async {
    QuickCompose.shared.sendPressedForTest()
    for _ in 0..<200 where QuickCompose.shared.statusForTest == "Sending…" {
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
  }

  /// Waits (bounded) until the page has been handed `count` messages.
  func waitForPage(_ r: Rig, count: Int) async throws {
    for _ in 0..<200 {
      if try await r.received().count >= count { return }
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    Issue.record("the page was never handed \(count) message(s)")
  }

  /// Waits (bounded) until the in-flight send has been answered: Send is off while one is in flight and back on after.
  func waitForAnswer() async {
    for _ in 0..<200 where !QuickCompose.shared.sendEnabledForTest {
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
  }

  /// A page whose receiver does not answer until the test calls `window.__answer(true | false)`.
  static let waitingPage = page(receiver: "return new Promise(function (r) { window.__answer = r })")

  func expectKept(_ r: Rig, sentToPage: Int) async throws {
    #expect(QuickCompose.shared.textForTest == Self.draft, "a failed or missing ack must keep the owner's text")
    #expect(QuickCompose.shared.statusForTest == Self.keptLine)
    #expect(QuickCompose.shared.sendEnabledForTest, "Send comes back so the owner can try again")
    #expect(try await r.received().count == sentToPage)
  }

  @Test func aRealAckSendsExactlyTheOwnersWordsToThePageThenClearsTheText() async throws {
    let r = try await rig(page: Self.page(receiver: "return true"))
    defer { cleanUp(r) }
    await send()
    #expect(try await r.received() == [["type": "compose", "thread_id": "work", "text": Self.draft]])
    #expect(QuickCompose.shared.textForTest == "")
    #expect(QuickCompose.shared.statusForTest == "")
    #expect(QuickCompose.shared.sendEnabledForTest)
    #expect(UserDefaults.standard.string(forKey: QuickCompose.lastThreadKey) == "work")
  }

  @Test func aPageThatRefusesTheMessageKeepsTheText() async throws {
    let r = try await rig(page: Self.page(receiver: "return false"))
    defer { cleanUp(r) }
    await send()
    try await expectKept(r, sentToPage: 1)
  }

  @Test func aPageWithNoReceiverKeepsTheText() async throws {
    let r = try await rig(page: Self.page(receiver: nil))
    defer { cleanUp(r) }
    await send()
    try await expectKept(r, sentToPage: 0)
  }

  @Test func aReceiverThatThrowsKeepsTheText() async throws {
    let r = try await rig(page: Self.page(receiver: "throw new Error('boom')"))
    defer { cleanUp(r) }
    await send()
    try await expectKept(r, sentToPage: 1)
  }

  @Test func aReceiverThatAnswersNothingOrAnythingButTrueKeepsTheText() async throws {
    for answer in ["", "return undefined", "return 1", "return 'true'", "return {}"] {
      let r = try await rig(page: Self.page(receiver: answer))
      defer { cleanUp(r) }
      await send()
      try await expectKept(r, sentToPage: 1)
    }
  }

  @Test func aNewPageThatHasNotSaidReadyIsNeverHandedTheMessageAndTheTextIsKept() async throws {
    let r = try await rig(page: Self.page(receiver: "return true"))
    defer { cleanUp(r) }
    // A new document committing drops `ready` while the owner is still signed in: the old page is gone, the new one is not up.
    r.view.loadHTMLString(Self.page(receiver: "return true"), baseURL: URL(string: "https://relay.example.com/")!)
    for _ in 0..<200 where r.web.pageReady { try? await Task.sleep(nanoseconds: 50_000_000) }
    try #require(!r.web.pageReady && r.web.signedIn, "the new document should have committed and the owner still be signed in")
    await send()
    try await expectKept(r, sentToPage: 0)
  }

  @Test func aPageThatAnswersWithAPromiseIsWaitedFor() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    QuickCompose.shared.sendPressedForTest()
    try await waitForPage(r, count: 1)
    #expect(QuickCompose.shared.textForTest == Self.draft, "nothing is cleared before the page answers")
    _ = try? await r.view.evaluateJavaScript("window.__answer(true)")
    await waitForAnswer()
    #expect(QuickCompose.shared.textForTest == "")
  }

  @Test func aPromiseThatRejectsOrSaysFalseKeepsTheText() async throws {
    for answer in ["return Promise.reject(new Error('could not save'))", "return Promise.resolve(false)"] {
      let r = try await rig(page: Self.page(receiver: answer))
      defer { cleanUp(r) }
      await send()
      try await expectKept(r, sentToPage: 1)
    }
  }

  @Test func anAckNeverWipesWordsTheOwnerTypedAfterPressingSend() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    QuickCompose.shared.sendPressedForTest()
    try await waitForPage(r, count: 1)
    QuickCompose.shared.setTextForTest(Self.draft + "\n\nAnd ask about Friday.")  // typed while the first message is in flight
    _ = try? await r.view.evaluateJavaScript("window.__answer(true)")
    await waitForAnswer()
    #expect(try await r.received() == [["type": "compose", "thread_id": "work", "text": Self.draft]], "the page only got the first words")
    #expect(QuickCompose.shared.textForTest == "And ask about Friday.", "what was sent leaves, the newer typing stays")
    #expect(QuickCompose.shared.statusForTest == "Sent. Your newer text is kept.")
    #expect(QuickCompose.shared.sendEnabledForTest)
  }

  @Test func anAckNeverWipesADifferentDraftTheOwnerStartedAfterPressingSend() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    QuickCompose.shared.sendPressedForTest()
    try await waitForPage(r, count: 1)
    QuickCompose.shared.setTextForTest("A different note")
    _ = try? await r.view.evaluateJavaScript("window.__answer(true)")
    await waitForAnswer()
    #expect(QuickCompose.shared.textForTest == "A different note")
    #expect(QuickCompose.shared.statusForTest == "Sent. Your newer text is kept.")
  }

  @Test func sendCannotFireAgainWhileAnAckIsPending() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    QuickCompose.shared.sendPressedForTest()
    try await waitForPage(r, count: 1)
    QuickCompose.shared.prepareShow(thread: nil)  // any entry point: it rebuilds the picker and used to turn Send back on
    QuickCompose.shared.dropPreviousAppForTest()  // prepareShow noted the frontmost app again; a finished send must not activate it
    #expect(!QuickCompose.shared.sendEnabledForTest, "Send stays off while the first message is unanswered")
    QuickCompose.shared.sendPressedForTest()  // the Command-Return shortcut
    // Script calls run in order, so by the time this answers a second send would already have reached the page.
    #expect(try await r.received().count == 1, "a second Send must not send a second message")
    _ = try? await r.view.evaluateJavaScript("window.__answer(true)")
    await waitForAnswer()
    #expect(QuickCompose.shared.textForTest == "")
    #expect(QuickCompose.shared.sendEnabledForTest)
  }

  @Test func aPageThatGoesAwayWithoutAnsweringEndsTheSendAndKeepsTheText() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    QuickCompose.shared.sendPressedForTest()
    try await waitForPage(r, count: 1)
    // A new document commits (a reload, a crash recovery): the old page can never answer.
    r.view.loadHTMLString(Self.page(receiver: "return true"), baseURL: URL(string: "https://relay.example.com/")!)
    await waitForAnswer()
    #expect(QuickCompose.shared.textForTest == Self.draft)
    #expect(QuickCompose.shared.statusForTest == Self.lostLine, "the page may have saved it: no invitation to just send again")
    #expect(QuickCompose.shared.sendEnabledForTest, "Send is not left off at Sending…")
  }

  /// A send that ended as `lost`: the page went away without answering.
  func lostSend(_ r: Rig) async throws {
    QuickCompose.shared.sendPressedForTest()
    try await waitForPage(r, count: 1)
    r.view.loadHTMLString(Self.page(receiver: "return true"), baseURL: URL(string: "https://relay.example.com/")!)
    await waitForAnswer()
    try #require(QuickCompose.shared.statusForTest == Self.lostLine, "setup: the send should have ended as lost")
  }

  /// The status, with the "went away" line last.
  func endsWithLost() -> Bool { QuickCompose.shared.statusForTest.hasSuffix(Self.lostLine) }

  @Test func theWentAwayWarningStaysThroughTypingReopeningAndASendThatIsNotTaken() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    try await lostSend(r)
    // a keystroke
    QuickCompose.shared.setTextForTest(Self.draft + " and more")
    QuickCompose.shared.textDidChange(Notification(name: NSText.didChangeNotification))
    #expect(QuickCompose.shared.statusForTest == Self.lostLine, "typing does not clear the only guard against sending twice")
    // closing and opening the panel again
    QuickCompose.shared.prepareShow(thread: nil)
    QuickCompose.shared.dropPreviousAppForTest()
    #expect(QuickCompose.shared.statusForTest == Self.lostLine, "opening the panel again does not clear it")
    // Send before the new page is ready: nothing is handed over; the warning stays, and still says the text is kept
    for _ in 0..<200 where r.web.pageReady { try? await Task.sleep(nanoseconds: 50_000_000) }
    try #require(!r.web.pageReady, "setup: the new document has not said ready")
    QuickCompose.shared.sendPressedForTest()
    await waitForAnswer()
    #expect(endsWithLost(), "a Send the page never took does not replace it")
    #expect(QuickCompose.shared.statusForTest.contains("Your text is kept."), "\(QuickCompose.shared.statusForTest)")
    #expect(QuickCompose.shared.textForTest == Self.draft + " and more")
    #expect(try await r.received().count == 0)
    #expect(QuickCompose.shared.sendEnabledForTest)
  }

  @Test func aReopenWhileThePageReloadsAndListsNoThreadsKeepsTheWentAwayWarning() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    try await lostSend(r)
    QuickCompose.shared.cancelForTest()  // Esc: the draft keeps the thread it was written for
    // the reloading page mirrors an empty thread list before the real one: the draft's thread seems gone
    r.web.nativeMessage(try #require(WebToNative.decode(["type": "threads", "items": []])))
    QuickCompose.shared.prepareShow(thread: nil)
    QuickCompose.shared.dropPreviousAppForTest()
    try #require(QuickCompose.shared.threadGoneForTest, "setup: the draft's thread is missing from the list")
    #expect(endsWithLost(), "\(QuickCompose.shared.statusForTest)")
    // the page lists other threads, not the draft's: still gone, still warned
    r.web.nativeMessage(try #require(WebToNative.decode(["type": "threads", "items": [["id": "play", "name": "Play"]]])))
    QuickCompose.shared.prepareShow(thread: nil)
    QuickCompose.shared.dropPreviousAppForTest()
    try #require(QuickCompose.shared.threadGoneForTest, "setup: the draft's thread is still missing")
    #expect(endsWithLost(), "\(QuickCompose.shared.statusForTest)")
    // picking a thread by hand is the way out of "that thread is gone"; it does not end the warning
    QuickCompose.shared.pickThreadForTest("play")
    try #require(!QuickCompose.shared.threadGoneForTest, "setup: the pick was taken")
    #expect(endsWithLost(), "\(QuickCompose.shared.statusForTest)")
    // and the page lists the draft's thread again: the owner still has to check before resending
    r.web.nativeMessage(try #require(WebToNative.decode(["type": "threads", "items": [["id": "work", "name": "Work"]]])))
    QuickCompose.shared.prepareShow(thread: nil)
    QuickCompose.shared.dropPreviousAppForTest()
    #expect(endsWithLost(), "\(QuickCompose.shared.statusForTest)")
  }

  @Test func aSendThatIsRefusedBeforeLeavingKeepsTheWentAwayWarningAndSaysWhy() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    try await lostSend(r)
    // The new page has not listed its threads yet: the picker is empty, and Send is refused with "Pick a thread."
    r.web.nativeMessage(try #require(WebToNative.decode(["type": "threads", "items": []])))
    QuickCompose.shared.prepareShow(thread: nil)
    QuickCompose.shared.dropPreviousAppForTest()
    QuickCompose.shared.sendPressedForTest()
    #expect(endsWithLost())
    #expect(QuickCompose.shared.statusForTest.hasPrefix("Pick a thread."), "\(QuickCompose.shared.statusForTest)")
    #expect(try await r.received().count == 0)
    // too long, and nothing but spaces: each says why, and the warning is still last
    r.web.nativeMessage(try #require(WebToNative.decode(["type": "threads", "items": [["id": "work", "name": "Work"]]])))
    QuickCompose.shared.prepareShow(thread: nil)
    QuickCompose.shared.dropPreviousAppForTest()
    QuickCompose.shared.setTextForTest(String(repeating: "x", count: 32_001))
    QuickCompose.shared.sendPressedForTest()
    #expect(endsWithLost() && QuickCompose.shared.statusForTest.hasPrefix("That is too long"), "\(QuickCompose.shared.statusForTest)")
    QuickCompose.shared.setTextForTest("   ")
    QuickCompose.shared.sendPressedForTest()
    #expect(endsWithLost() && QuickCompose.shared.statusForTest.hasPrefix("Write something first."), "\(QuickCompose.shared.statusForTest)")
    #expect(try await r.received().count == 0)
  }

  @Test func theWentAwayWarningGoesWhenTheBoxIsEmptied() async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    try await lostSend(r)
    QuickCompose.shared.setTextForTest("")
    QuickCompose.shared.textDidChange(Notification(name: NSText.didChangeNotification))
    #expect(QuickCompose.shared.statusForTest == "", "nothing left to be careful about")
  }

  /// What the box holds when the answer comes back, against what was sent and what is in the box then.
  @Test(arguments: [
    // (sent, box when the ack arrives, box after, status after)
    ("I", "It is a new note", "It is a new note", "Sent. Your newer text is kept."),  // starts with the sent word, a different note
    ("Ok", "Ok so the plan changed", "Ok so the plan changed", "Sent. Your newer text is kept."),
    ("see:", "see:\n    indented next line", "    indented next line", "Sent. Your newer text is kept."),  // the indent stays
    ("see:", "see:\r\n\r\nnext", "next", "Sent. Your newer text is kept."),
    ("a\n", "a\nb", "b", "Sent. Your newer text is kept."),  // the message went out trimmed; what follows its line break stays
    ("hello", "hello  ", "", ""),  // nothing newer: sent cleanly
    ("hello", "hello\n", "", ""),
    ("hello", "", "", ""),  // the owner emptied the box
    ("hello", "  \n ", "", ""),
  ] as [(String, String, String, String)])
  func theBoxKeepsOnlyWhatIsNewerAndSaysSoOnlyWhenThereIsSome(sent: String, during: String, after: String, status: String) async throws {
    let r = try await rig(page: Self.waitingPage)
    defer { cleanUp(r) }
    QuickCompose.shared.setTextForTest(sent)
    QuickCompose.shared.sendPressedForTest()
    try await waitForPage(r, count: 1)
    QuickCompose.shared.setTextForTest(during)
    _ = try? await r.view.evaluateJavaScript("window.__answer(true)")
    await waitForAnswer()
    #expect(QuickCompose.shared.textForTest == after)
    #expect(QuickCompose.shared.statusForTest == status)
    #expect(QuickCompose.shared.sendEnabledForTest)
  }

  @Test func aNewerPageIsAskedThroughReceiveAckAndWaitedFor() async throws {
    let r = try await rig(page: Self.page(receiver: "return true", ack: "return new Promise(function (r) { window.__answer = r })"))
    defer { cleanUp(r) }
    QuickCompose.shared.sendPressedForTest()
    try await waitForPage(r, count: 1)
    #expect(try await r.doors() == ["receiveAck"], "the plain-boolean door says true before the message is saved")
    #expect(QuickCompose.shared.textForTest == Self.draft)
    _ = try? await r.view.evaluateJavaScript("window.__answer(true)")
    await waitForAnswer()
    #expect(QuickCompose.shared.textForTest == "")
  }

  @Test func aNewerPageThatSaysNoThroughReceiveAckKeepsTheTextEvenThoughItsPlainDoorSaysTrue() async throws {
    let r = try await rig(page: Self.page(receiver: "return true", ack: "return Promise.resolve(false)"))
    defer { cleanUp(r) }
    await send()
    try await expectKept(r, sentToPage: 1)
    #expect(try await r.doors() == ["receiveAck"])
  }

  @Test func anOlderPageWithOnlyReceiveIsStillAskedAndAnswersAsBefore() async throws {
    let r = try await rig(page: Self.page(receiver: "return true"))
    defer { cleanUp(r) }
    await send()
    #expect(try await r.doors() == ["receive"])
    #expect(QuickCompose.shared.textForTest == "")
  }
}

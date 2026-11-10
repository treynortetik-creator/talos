import Foundation
import Testing
@testable import TalosDesktopCore

/// Needs-you prompts, the Mac popup: what it says, when it is on the screen and what a click asks for. All pure: no window, no tmux.
private func offer(
  _ id: String, kind: DialogReader.Kind = .trust, subject: String? = "/Users/alex/Projects/garden",
  options: [String]? = nil, seen: String = "2026-11-07T10:00:00.000Z"
) -> DialogOffer {
  let opts = options ?? (kind == .trust ? ["No, exit", "Yes, I trust this folder"] : kind == .login ? [] : ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"])
  return DialogOffer(id: id, kind: kind, subject: subject, options: opts, cursor: kind == .login ? nil : 0, seen_at: seen, expires_at: "2026-11-07T10:15:00.000Z")
}

private func item(_ id: String, thread: String = "garden", name: String = "Garden", kind: DialogReader.Kind = .trust, subject: String? = "/Users/alex/Projects/garden", options: [String]? = nil, seen: String = "2026-11-07T10:00:00.000Z") -> NeedsYouPopupItem {
  NeedsYouPopupItem(thread: thread, threadName: name, dialog: offer(id, kind: kind, subject: subject, options: options, seen: seen))
}

private let idA = "AAAAAAAAAAAAAAAAAAAAAA", idB = "BBBBBBBBBBBBBBBBBBBBBB", idC = "CCCCCCCCCCCCCCCCCCCCCC", idD = "DDDDDDDDDDDDDDDDDDDDDD"

@Suite("Needs-you popup: words")
struct NeedsYouPopupWordsTests {
  // MARK: hidden characters (the card's dialogVisibleText)

  @Test func hiddenCharactersAreShownAsMarkers() {
    #expect(DialogVisibleText.show("Yes, I trust this folder") == "Yes, I trust this folder")
    #expect(DialogVisibleText.show("café 日本語 😀 ls -la") == "café 日本語 😀 ls -la")
    #expect(DialogVisibleText.show("a\u{200B}b") == "a⟦U+200B⟧b")
    #expect(DialogVisibleText.show("a\u{202E}b") == "a⟦U+202E⟧b")
    #expect(DialogVisibleText.show("a\u{00AD}b\u{FEFF}") == "a⟦U+00AD⟧b⟦U+FEFF⟧")
    #expect(DialogVisibleText.show("a\u{1B}[2Kb") == "a⟦U+001B⟧[2Kb")
    #expect(DialogVisibleText.show("line\none") == "line⟦U+000A⟧one", "a line break is shown too, as on the card")
    #expect(DialogVisibleText.show("a\u{E0041}b") == "a⟦U+E0041⟧b")
    #expect(DialogVisibleText.show("a\u{3164}b\u{2800}") == "a⟦U+3164⟧b⟦U+2800⟧")
    #expect(DialogVisibleText.show("a\u{E000}b") == "a⟦U+E000⟧b", "private use")
    #expect(DialogVisibleText.show("a\u{0378}b") == "a⟦U+0378⟧b", "unassigned")
    #expect(DialogVisibleText.show("a\u{FE0F}") == "a⟦U+FE0F⟧", "every one is shown, an emoji selector too, as on the card")
  }

  /// The table shared with the TypeScript `dialogVisibleText` (fixtures/needs-you/visible-text.json): the port cannot drift from the card's rule.
  @Test func theHiddenCharacterRuleIsTheCardsOnTheSharedTable() throws {
    let o = try A2Fixtures.object("visible-text")
    let cases = try #require(o["cases"] as? [[String: String]])
    #expect(cases.count >= 20)
    for c in cases {
      let input = try #require(c["input"]), expected = try #require(c["expected"])
      #expect(DialogVisibleText.show(input) == expected, "\(c["name"] ?? "?"): \(input.unicodeScalars.map { String($0.value, radix: 16) })")
    }
  }

  @Test func theMarkerBracketsAreMarkedSoALabelCannotPrintAMarkerOfItsOwn() {
    #expect(DialogVisibleText.show("⟦U+0041⟧") == "⟦U+27E6⟧U+0041⟦U+27E7⟧")
  }

  @Test func moreThanThreeCombiningMarksInARowAreShownThreeAreNot() {
    let m = "\u{301}"
    #expect(DialogVisibleText.show("e" + m + m + m) == "e" + m + m + m)
    #expect(DialogVisibleText.show("e" + m + m + m + m) == "e⟦U+0301⟧⟦U+0301⟧⟦U+0301⟧⟦U+0301⟧")
  }

  // MARK: what it says, per kind

  @Test func theTrustPopupSaysWhatTheCardSaysInPlainWords() throws {
    let c = NeedsYouPopupContent.make(item(idA))
    #expect(c.header == "Talos · Garden needs you")
    #expect(c.title == "Trust this folder?")
    #expect(c.subject == "/Users/alex/Projects/garden")
    #expect(c.sentence == "Garden's session wants to work in this folder. Claude will be able to read, change and run files in it, and in folders inside it.")
    #expect(c.sentence == (try wording()).sentence["trust"]?.replacingOccurrences(of: "{thread}", with: "Garden"))
    #expect(c.footer == "Also on your phone. Answer either one.")
  }

  @Test func theMcpPopupSaysWhatTheServerWillDo() {
    let c = NeedsYouPopupContent.make(item(idA, kind: .mcpConsent, subject: "harmless"))
    #expect(c.header == "Talos · Garden needs you")
    #expect(c.title == "Allow this MCP server?")
    #expect(c.subject == "harmless")
    #expect(c.sentence == "Garden's session wants to turn on this server's tools for its folder.")
    #expect(c.footer == "Also on your phone. Answer either one.")
  }

  @Test func theLoginPopupHasNoSubjectAndOneButtonThatTypesNothing() {
    let c = NeedsYouPopupContent.make(item(idA, kind: .login, subject: nil))
    #expect(c.title == "Garden needs you to sign in", "sign in, never log in")
    #expect(c.subject == nil)
    #expect(c.sentence == "Garden's session needs you to sign in to Claude on the Mac.")
    #expect(c.buttons == [NeedsYouPopupButton(text: "Open in Terminals", action: .open)])
  }

  /// The phone and web card and the Mac popup say ONE thing: the table in packages/protocol (`DIALOG_WORDING`), committed as
  /// fixtures/needs-you/wording.json and written by the protocol tests.
  struct Wording {
    var title: [String: String]
    var sentence: [String: String]
    var footer: [String: String]
    var devChannels: [String: String]
    var phone: [String: String]
  }
  static func wording() throws -> Wording {
    let o = try A2Fixtures.object("wording")
    func dict(_ k: String) throws -> [String: String] { try #require(o[k] as? [String: String]) }
    return Wording(title: try dict("title"), sentence: try dict("sentence"), footer: try dict("footer"), devChannels: try dict("devChannels"), phone: (o["phone"] as? [String: String]) ?? [:])
  }
  func wording() throws -> Wording { try Self.wording() }

  /// The phone notice for Main waiting at the Mac (posted without Main's bridge) is the table's words too.
  @Test func thePhoneNoticeIsTheSharedWording() throws {
    let w = try wording()
    #expect(!NeedsYouPopupContent.devWaitingPhone.isEmpty)
    #expect(NeedsYouPopupContent.devWaitingPhone == w.phone["devChannelsWaiting"])
  }

  @Test(arguments: [DialogReader.Kind.trust, .mcpConsent, .login, .devChannels])
  func thePopupSaysExactlyWhatTheSharedWordingTableSays(kind: DialogReader.Kind) throws {
    let w = try wording()
    let c = NeedsYouPopupContent.make(item(idA, kind: kind, subject: kind == .login ? nil : kind == .devChannels ? "server:talos-app" : "x"))
    #expect(c.title == w.title[kind.rawValue]?.replacingOccurrences(of: "{thread}", with: "Garden"), "\(kind)")
    #expect(c.sentence == w.sentence[kind.rawValue]?.replacingOccurrences(of: "{thread}", with: "Garden"), "\(kind)")
    #expect(c.footer == (kind == .devChannels ? w.footer["popupMainHere"] : w.footer["popup"]), "\(kind)")
    #expect(NeedsYouPopupContent.footerMain == w.footer["popupMain"] && NeedsYouPopupContent.footer == w.footer["popup"])
    #expect(!c.title.lowercased().contains("log in") && !c.sentence.lowercased().contains("log in"))
  }

  /// The dev-channels popup says what the card says: the table's sentence, the channel Talos did not add, the changed start command and what changed.
  @Test func theDevChannelsPopupCarriesTheCardsExtraLines() throws {
    let w = try wording()
    func popup(_ subject: String?, _ changed: [String]?) -> NeedsYouPopupContent {
      NeedsYouPopupContent.make(
        NeedsYouPopupItem(
          thread: "general", threadName: "General",
          dialog: DialogOffer(
            id: idA, kind: .devChannels, subject: subject, options: ["I am using this for local development", "Exit"], cursor: 0,
            launch_changed: changed, seen_at: "2026-11-07T10:00:00.000Z", expires_at: "2026-11-07T10:15:00.000Z")))
    }
    let base = w.sentence["dev_channels"] ?? ""
    #expect(popup("server:talos-app", nil).sentence == base)
    #expect(popup(nil, nil).sentence == base)
    #expect(popup("server:talos-app, server:odd", nil).sentence == base + " " + (w.devChannels["alsoLoads"] ?? "").replacingOccurrences(of: "{channels}", with: "server:odd"))
    #expect(popup("server:talos-app", []).sentence == base + " " + (w.devChannels["launchUnconfirmed"] ?? ""))
    let lc = popup("server:talos-app", ["program", "env"]).sentence
    #expect(lc == base + " " + (w.devChannels["launchChanged"] ?? "") + " " + (w.devChannels["launchChangedWhat"] ?? "").replacingOccurrences(of: "{what}", with: "program, env"))
  }

  @Test func noSubjectNoBox() {
    #expect(NeedsYouPopupContent.make(item(idA, subject: nil)).subject == nil)
  }

  @Test func aSubjectAndAThreadNameAreShownWithTheirHiddenCharactersMarked() {
    let c = NeedsYouPopupContent.make(item(idA, name: "Gar\u{200B}den", subject: "/Users/alex/pro\u{202E}jects"))
    #expect(c.header == "Talos · Gar⟦U+200B⟧den needs you")
    #expect(c.subject == "/Users/alex/pro⟦U+202E⟧jects")
    #expect(c.sentence.hasPrefix("Gar⟦U+200B⟧den's session"))
  }

  @Test func aThreadWithNoNameIsAThread() {
    #expect(NeedsYouPopupContent.make(item(idA, name: "  ")).header == "Talos · A thread needs you")
  }

  // MARK: buttons

  @Test func theButtonsAreTheOptionsInScreenOrderNoneDroppedOrEdited() {
    let trust = NeedsYouPopupContent.make(item(idA)).buttons
    #expect(trust.map(\.text) == ["No, exit", "Yes, I trust this folder"])
    #expect(trust.map(\.action) == [.choose(0, label: "No, exit"), .choose(1, label: "Yes, I trust this folder")])
    let mcp = NeedsYouPopupContent.make(item(idA, kind: .mcpConsent, subject: "harmless")).buttons
    #expect(mcp.count == 3)
    #expect(mcp.map(\.text) == ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"])
    #expect(mcp.map(\.action) == [
      .choose(0, label: "Use this MCP server"), .choose(1, label: "Use this and all future MCP servers in this project"),
      .choose(2, label: "Continue without using this MCP server"),
    ])
  }

  @Test func aLabelWithAHiddenCharacterIsShownMarkedButClickedExactly() {
    let label = "Yes\u{200B}, I trust this folder"
    let b = NeedsYouPopupContent.make(item(idA, options: ["No, exit", label])).buttons
    #expect(b[1].text == "Yes⟦U+200B⟧, I trust this folder")
    #expect(b[1].action == .choose(1, label: label), "what is pressed is the label as read, not as shown")
  }

  @Test func theFriendlierWordsOfTheDesignAreNotUsed() {
    let texts = NeedsYouPopupContent.make(item(idA)).buttons.map(\.text)
    #expect(!texts.contains("Not now") && !texts.contains("Trust"))
  }

  // MARK: the failure words

  @Test func theFailureWords() {
    #expect(NeedsYouPopupContent.failureText(.screenChanged, threadName: "Garden") == "Nothing pressed: Garden's screen changed, so Talos left it alone. A new popup comes if it still needs you.")
    #expect(NeedsYouPopupContent.failureText(.notOffered, threadName: "Garden") == "Nothing pressed: Garden's screen changed, so Talos left it alone. A new popup comes if it still needs you.")
    #expect(NeedsYouPopupContent.failureText(.alreadyAnswered(by: "Ada's iPhone"), threadName: "Garden") == "Already answered on Ada's iPhone")
    #expect(NeedsYouPopupContent.failureText(.alreadyAnswered(by: nil), threadName: "Garden") == "Already answered on another device")
    #expect(NeedsYouPopupContent.failureText(.alreadyAnswered(by: "iPh\u{200B}one"), threadName: "Garden") == "Already answered on iPh⟦U+200B⟧one")
    #expect(NeedsYouPopupContent.failureText(.noWindow, threadName: "Garden").hasPrefix("Nothing opened"))
    #expect(NeedsYouPopupContent.failureText(.typing, threadName: "Garden") == "You were typing in Garden's session, so Talos left it alone.")
    #expect(NeedsYouPopupContent.failureText(.couldNotCheck, threadName: "Garden") == "Talos could not check whether you were typing in Garden's session, so it left it alone.")
    #expect(NeedsYouPopupContent.failureText(.typing, threadName: "Gar\u{200B}den") == "You were typing in Gar⟦U+200B⟧den's session, so Talos left it alone.")
  }
}

@Suite("Needs-you popup: what is on the screen")
struct NeedsYouPopupScreenTests {
  final class Harness: @unchecked Sendable {
    var offers: [NeedsYouPopupItem] = []
    var quiet: Bool? = false
    var clock: Double = 1000
    var asked: [(thread: String, dialogId: String, action: NeedsYouPopupAction)] = []
    var finish: [(PopupAnswerResult) -> Void] = []
    lazy var c = NeedsYouPopupCoordinator(
      offers: { [unowned self] in offers }, quiet: { [unowned self] in quiet }, now: { [unowned self] in clock },
      answer: { [unowned self] thread, id, action, done in
        asked.append((thread, id, action))
        finish.append(done)
      })
    func ids() -> [String] { c.refresh().map(\.item.dialog.id) }
    /// Past the moment a fresh popup ignores clicks.
    func settle() { clock += NeedsYouPopupCoordinator.clickDelay + 0.1 }
  }

  @Test func oneOfferIsOnePopupWithItsWords() {
    let h = Harness()
    h.offers = [item(idA)]
    let p = h.c.refresh()
    #expect(p.count == 1 && p[0].phase == .asking && p[0].content == NeedsYouPopupContent.make(item(idA)))
  }

  @Test func severalDialogsAreSeveralPopupsAtMostThreeTheRestWait() {
    let h = Harness()
    h.offers = [item(idD, thread: "d", seen: "2026-11-07T10:00:04.000Z"), item(idB, thread: "b", seen: "2026-11-07T10:00:02.000Z"), item(idA, thread: "a", seen: "2026-11-07T10:00:01.000Z"), item(idC, thread: "c", seen: "2026-11-07T10:00:03.000Z")]
    #expect(h.ids() == [idA, idB, idC], "oldest first, three at most")
    h.offers.removeAll { $0.dialog.id == idB }  // one is answered elsewhere: the one that waited comes
    #expect(h.ids() == [idA, idC, idD])
  }

  /// Main's own warning is not hidden by three older popups: it is shown first and does not count against the three.
  @Test func mainsPopupComesFirstWhateverItsAge() {
    let h = Harness()
    let main = NeedsYouPopupItem(thread: "supervisor:main", threadName: "Main", dialog: offer(idD, kind: .devChannels, subject: "server:talos-app", options: ["I am using this for local development", "Exit"], seen: "2026-11-07T10:00:09.000Z"), first: true)
    h.offers = [item(idA, thread: "a", seen: "2026-11-07T10:00:01.000Z"), item(idB, thread: "b", seen: "2026-11-07T10:00:02.000Z"), item(idC, thread: "c", seen: "2026-11-07T10:00:03.000Z"), main]
    #expect(h.ids() == [idD, idA, idB], "Main first, then the oldest")
  }

  @Test func theOwnerHidingOneBringsTheNextAndTheHiddenOneStaysHidden() {
    let h = Harness()
    h.offers = [item(idA, thread: "a", seen: "2026-11-07T10:00:01.000Z"), item(idB, thread: "b", seen: "2026-11-07T10:00:02.000Z"), item(idC, thread: "c", seen: "2026-11-07T10:00:03.000Z"), item(idD, thread: "d", seen: "2026-11-07T10:00:04.000Z")]
    #expect(h.ids() == [idA, idB, idC])
    h.c.hide(dialogId: idA)
    #expect(h.ids() == [idB, idC, idD])
    #expect(h.ids() == [idB, idC, idD], "and it does not come back while it is still offered")
  }

  // MARK: quiet hours

  @Test func noPopupWhileQuietShownOnceQuietEndsAndNilShows() {
    let h = Harness()
    h.offers = [item(idA)]
    h.quiet = true
    #expect(h.ids().isEmpty, "quiet hours stop notifying the owner")
    h.quiet = false
    #expect(h.ids() == [idA], "still offered when the quiet window ends: shown then")
    h.quiet = true
    #expect(h.ids().isEmpty, "a popup on the screen when the window starts goes")
    h.quiet = nil
    #expect(h.ids() == [idA], "bridge not read yet: show")
  }

  @Test func aDialogThatWentAwayInTheQuietWindowIsNotShownAfter() {
    let h = Harness()
    h.offers = [item(idA)]
    h.quiet = true
    #expect(h.ids().isEmpty)
    h.offers = []
    h.quiet = false
    #expect(h.ids().isEmpty)
  }

  // MARK: closing

  @Test func thePopupClosesWhenTheDialogIsNoLongerOffered() {
    let h = Harness()
    h.offers = [item(idA)]
    #expect(h.ids() == [idA])
    h.offers = []
    #expect(h.ids().isEmpty)
  }

  @Test func aNewIdIsANewPopupAndTheOldOneIsGone() {
    let h = Harness()
    h.offers = [item(idA)]
    #expect(h.ids() == [idA])
    h.offers = [item(idB)]
    #expect(h.ids() == [idB])
  }

  @Test func hidingPressesNothingAndAsksNobody() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.hide(dialogId: idA)
    #expect(h.ids().isEmpty && h.asked.isEmpty)
  }

  @Test func aHiddenPopupIsNotBroughtBackByQuietEnding() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.c.hide(dialogId: idA)
    h.quiet = true
    _ = h.c.refresh()
    h.quiet = false
    #expect(h.ids().isEmpty)
  }

  // MARK: the click

  @Test func aClickAsksForExactlyTheButtonClicked() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.count == 1)
    #expect(h.asked.first?.thread == "garden" && h.asked.first?.dialogId == idA && h.asked.first?.action == .choose(1, label: "Yes, I trust this folder"))
    #expect(h.c.refresh().first?.phase == .working)
  }

  @Test func theLoginButtonAsksToOpen() {
    let h = Harness()
    h.offers = [item(idA, kind: .login, subject: nil)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 0)
    #expect(h.asked.first?.action == .open)
  }

  @Test func aClickInTheFirstMomentIsIgnoredSoAPopupAppearingUnderTheCursorIsNotAnswered() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.clock += NeedsYouPopupCoordinator.clickDelay - 0.1
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.isEmpty && h.c.refresh().first?.phase == .asking)
    h.settle()
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.count == 1)
  }

  @Test func aSecondClickWhileTheFirstIsWorkingAsksNothingMore() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 1)
    h.c.click(dialogId: idA, button: 0)
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.count == 1)
  }

  @Test func aClickOnAPopupThatIsNotOnTheScreenOrAButtonThatIsNotThereAsksNothing() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idB, button: 0)
    h.c.click(dialogId: idA, button: 2)
    h.c.click(dialogId: idA, button: -1)
    #expect(h.asked.isEmpty)
    h.quiet = true  // not on the screen now
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.isEmpty, "a popup that is not shown cannot be clicked")
  }

  @Test func aPressClosesThePopupAndItDoesNotComeBackWhileTheDialogShowsAGoodWhile() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 1)
    h.finish[0](.pressed(choice: 1, label: "Yes, I trust this folder"))
    #expect(h.ids().isEmpty)
    #expect(h.ids().isEmpty)
  }

  @Test func anOpenedLoginPopupCloses() {
    let h = Harness()
    h.offers = [item(idA, kind: .login, subject: nil)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 0)
    h.finish[0](.opened)
    #expect(h.ids().isEmpty)
  }

  @Test func whenNothingWasPressedThePopupSaysSoForAFewSecondsThenAsksAgainWithAFreshDelay() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 1)
    h.finish[0](.nothing(.screenChanged))
    let words = "Nothing pressed: Garden's screen changed, so Talos left it alone. A new popup comes if it still needs you."
    #expect(h.c.refresh().first?.phase == .failed(words))
    h.clock += NeedsYouPopupCoordinator.failureShown - 1
    #expect(h.c.refresh().first?.phase == .failed(words), "still there a moment before")
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.count == 1, "no click while it only says so")
    h.clock += 2
    // the same dialog id is still offered: it is a question again, and its first moment starts over
    #expect(h.c.refresh().first?.phase == .asking)
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.count == 1, "a click in the fresh first moment is ignored")
    h.settle()
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.count == 2)
  }

  @Test func aTypingGuardFailureHasItsOwnWordsAndAsksAgainToo() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 0)
    h.finish[0](.nothing(.typing))
    #expect(h.c.refresh().first?.phase == .failed("You were typing in Garden's session, so Talos left it alone."))
    h.clock += NeedsYouPopupCoordinator.failureShown + 0.1
    #expect(h.c.refresh().first?.phase == .asking)
  }

  @Test func aPopupIsRearmedWhenItMovesSoAClickMeantForWhatWasUnderTheCursorIsNotTaken() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.rearm(dialogId: idA)
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.isEmpty, "it moved just now")
    h.settle()
    h.c.click(dialogId: idA, button: 1)
    #expect(h.asked.count == 1)
  }

  @Test func whenAnotherDeviceWonThePopupNamesIt() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 0)
    h.finish[0](.nothing(.alreadyAnswered(by: "Ada's iPhone")))
    #expect(h.c.refresh().first?.phase == .failed("Already answered on Ada's iPhone"))
  }

  @Test func theWordsStayTheirFullTimeEvenWhenTheDialogGoesAwayFirstAndThenTheyGo() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 0)
    h.finish[0](.nothing(.alreadyAnswered(by: "Ada's iPhone")))
    h.offers = []  // the phone's answer pressed: the dialog is gone before the owner could read it
    #expect(h.c.refresh().first?.phase == .failed("Already answered on Ada's iPhone"))
    h.clock += NeedsYouPopupCoordinator.failureShown - 1
    #expect(h.c.refresh().first?.phase == .failed("Already answered on Ada's iPhone"))
    h.clock += 2
    #expect(h.ids().isEmpty)
    #expect(h.ids().isEmpty)
  }

  @Test func theOwnerHidingAFailureClosesItAtOnce() {
    let h = Harness()
    h.offers = [item(idA)]
    _ = h.c.refresh()
    h.settle()
    h.c.click(dialogId: idA, button: 0)
    h.finish[0](.nothing(.screenChanged))
    h.c.hide(dialogId: idA)
    #expect(h.ids().isEmpty)
  }
}

@Suite("Needs-you popup: the files")
struct NeedsYouPopupFilesTests {
  @Test func theMacResultIsTheContractsPopupShape() throws {
    let want = try A2Fixtures.object("dialog-result-mac-popup")
    let dialogId = try #require(want["dialog_id"] as? String)
    let atText = try #require(want["at"] as? String)
    let at = try #require(ISOTime.parse(atText))
    let data = DialogResult.encodeMac(dialogId: dialogId, outcome: .pressed, choice: 1, label: "Yes, I trust this folder", at: at)
    let got = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(NSDictionary(dictionary: got).isEqual(to: want), "\(got) vs \(want)")
    #expect(got["control_id"] == nil && got["reason"] == nil && got["source"] as? String == "mac")
  }

  @Test func theOpenedResultHasNoChoiceAndNoLabel() throws {
    let o = try #require(JSONSerialization.jsonObject(with: DialogResult.encodeMac(dialogId: "k3Xv9QpT2mLw8ZrNa5HdBe", outcome: .opened, at: 1_793_000_000)) as? [String: Any])
    #expect(Set(o.keys) == ["v", "dialog_id", "source", "outcome", "at"] && o["outcome"] as? String == "opened" && o["source"] as? String == "mac")
  }

  @Test func theCardFileSaysWhoAnsweredOnlyForThisDialogAndOnlyWhenAnswered() throws {
    let dir = try DialogFilesTests.tmp()
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/dialog-card.json"
    try A2Fixtures.data("dialog-card-answered").write(to: URL(fileURLWithPath: path))
    #expect(DialogCardAck.answered(path: path, dialogId: "k3Xv9QpT2mLw8ZrNa5HdBe") == "Alex's iPhone")
    #expect(DialogCardAck.answered(path: path, dialogId: "Aq5Lm8ZtRx3Cv9PkNa2HdB") == nil, "another dialog")
    try A2Fixtures.data("dialog-card").write(to: URL(fileURLWithPath: path))
    #expect(DialogCardAck.answered(path: path, dialogId: "k3Xv9QpT2mLw8ZrNa5HdBe") == nil, "waiting: nobody yet")
    #expect(DialogCardAck.answered(path: dir + "/none.json", dialogId: "k3Xv9QpT2mLw8ZrNa5HdBe") == nil)
  }
}

@Suite("Needs-you popup: what a real click is")
struct PopupRealClickTests {
  private func real(_ kind: PopupClickCheck.Kind = .leftMouseUp, age: Double = 0.05, window: Bool = true, bounds: Bool = true) -> Bool {
    PopupClickCheck.isRealClick(kind: kind, age: age, sameWindow: window, onButton: bounds)
  }

  @Test func onlyAFreshLeftMouseEventInThisWindowOnTheButtonIsAClick() {
    #expect(real(.leftMouseUp))
    #expect(real(.leftMouseDown))
    #expect(!real(.other), "a key, a right click, a move, or no event at all")
    #expect(!real(age: 1.0) && !real(age: 5) && !real(age: -5), "a stale event, or one from the future")
    #expect(!real(window: false), "another window")
    #expect(!real(bounds: false), "somewhere else in the window")
  }

  @Test func theFooterOfMainsPopupFollowsWhetherThePhoneWasTold() throws {
    let w = try NeedsYouPopupWordsTests.wording()
    func main(told: Bool) -> NeedsYouPopupContent {
      NeedsYouPopupContent.make(NeedsYouPopupItem(thread: "supervisor:main", threadName: "Main", dialog: offer(idA, kind: .devChannels, subject: "server:talos-app", options: ["I am using this for local development", "Exit"], seen: "2026-11-07T10:00:00.000Z"), phoneTold: told))
    }
    #expect(main(told: true).footer == w.footer["popupMain"])
    #expect(main(told: false).footer == w.footer["popupMainHere"])
    #expect(main(told: false).footer != "Your phone is told to come here.")
    #expect(NeedsYouPopupContent.make(item(idA)).footer == w.footer["popup"], "a worker's popup keeps its footer")
  }

  @Test func theFirstRunRowPointsAtThePopup() {
    let r = FirstRun.rows(.init(authSignedIn: nil, agentDirTrusted: false, home: "/h"))
    let text = r.compactMap { row -> String? in if case .fix(let t) = row.state { return t } else { return nil } }.joined(separator: " ")
    #expect(text.contains("Talos popup") && !text.contains("press Enter"), "\(text)")
  }
}

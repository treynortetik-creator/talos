import Foundation
import Testing

@testable import TalosDesktopCore

/// The key gate, the tmux sends, the offer's record and the popup's words for the tool permission and the agent's question (pane-prompts rows 8 and 9).
@Suite("PaneSelect key gate and wiring")
struct PaneSelectGateTests {
  static func tool() throws -> [String] { try RealScreens.rows("bash-permission") }
  static func question() throws -> [String] { try RealScreens.rows("askuser-select") }
  static func bound(_ rows: [String]) throws -> PaneSelect.Screen { try #require(PaneSelect.read(rows: rows)) }

  static func intent(_ s: PaneSelect.Screen, tolerant: Bool = false) -> KeyGuard.Intent {
    .pane(KeyGuard.PaneBinding(kind: s.kind, bound: s.bound, freeText: tolerant ? s.freeText : nil))
  }

  // MARK: the gate

  @Test func aPaneKeyGoesOnlyToTheExactScreenTheOfferWasMadeFor() throws {
    let s = try Self.bound(try Self.tool())
    #expect(KeyGuard.refusal(try Self.tool(), intent: Self.intent(s)) == nil)
    // the cursor on another row, the countdown, the dot above: the same prompt
    #expect(KeyGuard.refusal(try RealScreens.rows("bash-permission-cursor2"), intent: Self.intent(s)) == nil)
    #expect(KeyGuard.refusal(try RealScreens.rows("bash-permission-6s"), intent: Self.intent(s)) == nil)
    // another command, another prompt kind, a garbled screen, nothing: refused, each with the intent's own reason
    for (name, rows) in [
      ("another command", try RealScreens.rows("bash-permission-other", in: "synthetic")), ("a file permission", try RealScreens.rows("write-permission")),
      ("a question", try Self.question()), ("garbled", try RealScreens.rows("bash-permission-garbled", in: "synthetic")),
      ("the idle box", try RealScreens.rows("empty-input")),
    ] {
      #expect(KeyGuard.refusal(rows, intent: Self.intent(s))?.why == "not_tool_permission", "\(name)")
    }
    #expect(KeyGuard.refusal(nil, intent: Self.intent(s))?.why == "unreadable")
    #expect(KeyGuard.Intent.pane(.init(kind: .agentQuestion, bound: "x")).name == "agent_question")
  }

  @Test func aToolBindingNeverOpensAQuestionAndTheOtherWayRound() throws {
    let t = try Self.bound(try Self.tool()), q = try Self.bound(try Self.question())
    #expect(KeyGuard.refusal(try Self.question(), intent: Self.intent(t)) != nil)
    #expect(KeyGuard.refusal(try Self.tool(), intent: Self.intent(q)) != nil)
    // the right bound with the wrong kind is no key either
    #expect(KeyGuard.refusal(try Self.tool(), intent: .pane(.init(kind: .agentQuestion, bound: t.bound))) != nil)
  }

  @Test func noOtherIntentOpensEitherScreenAndTheUsageLimitMenuGetsNoKey() throws {
    for rows in [try Self.tool(), try Self.question()] {
      for k in KeyGuard.DialogKind.allCases { #expect(KeyGuard.refusal(rows, intent: .dialog(k)) != nil, "\(k)") }
      #expect(KeyGuard.refusal(rows, intent: .box(.empty)) != nil && KeyGuard.refusal(rows, intent: .box(.ours)) != nil)
      #expect(KeyGuard.refusal(rows, intent: .interrupt) != nil && KeyGuard.refusal(rows, intent: .interruptBlank) != nil)
    }
    #expect(KeyGuard.intent(for: .toolPermission) == nil && KeyGuard.intent(for: .agentQuestion) == nil, "the generic tap answerer has no key for them")
    // a usage-limit menu is never a pane Select: no key under any binding
    let limit = try RealScreens.rows("usage-limit", in: "synthetic")
    #expect(KeyGuard.refusal(limit, intent: Self.intent(try Self.bound(try Self.tool())))?.why == "usage_limit")
  }

  @Test func theTypedWordsAndTheEnterAreAllowedOnlyWhereTheOfferKnowsTheFreeTextRowAndTheCursorIsOnIt() throws {
    let q = try Self.bound(try Self.question())
    let typed = try RealScreens.rows("askuser-typed", in: "synthetic")
    #expect(KeyGuard.refusal(typed, intent: Self.intent(q)) != nil, "an exact binding does not know the typed row")
    #expect(KeyGuard.refusal(typed, intent: Self.intent(q, tolerant: true)) == nil)
    #expect(KeyGuard.refusal(try RealScreens.rows("askuser-cursor-on-text", in: "synthetic"), intent: Self.intent(q, tolerant: true)) == nil)
    // the cursor on another row: the row's label is a label again
    #expect(KeyGuard.refusal(try Self.question(), intent: .pane(.init(kind: .agentQuestion, bound: q.bound, freeText: 1))) != nil)
  }

  // MARK: the tmux sends

  @Test func theNumberKeyAndTheTextAreLiteralSendsThatLeaveCopyModeFirst() throws {
    var c = TmuxCommands(tmux: "/usr/bin/tmux", socket: "s", configPath: "/c", session: "agent")
    c.paneId = "%1"
    let n = try #require(SelectNumber(4))
    #expect(Array(c.sendSelectNumber(n).suffix(6)) == ["send-keys", "-t", "%1", "-l", "--", "4"])
    let t = try #require(AnswerText("purple"))
    #expect(Array(c.sendAnswerText(t).suffix(6)) == ["send-keys", "-t", "%1", "-l", "--", "purple"])
    #expect(c.sendAnswerText(t).contains("send-keys -t %1 -X cancel"), "copy mode is left first")
    // a text that ends in `;` is not read as a tmux command separator
    let semi = try #require(AnswerText("run it;"))
    #expect(c.sendAnswerText(semi).last == "run it\\;")
  }

  @Test func onlyOneDigitOneToNineAndOnlyCleanTextCanBeMade() {
    #expect(SelectNumber(0) == nil && SelectNumber(10) == nil && SelectNumber(-1) == nil && SelectNumber(9)?.value == 9)
    #expect(AnswerText("a\nb") == nil && AnswerText(" padded") == nil && AnswerText("") == nil && AnswerText("a\u{202E}b") == nil)
    #expect(AnswerText("plain words")?.text == "plain words")
  }

  // MARK: the offer and the popup

  @Test func theOffersFreeTextIsInItsRecordAndValidOnlyForAQuestion() throws {
    let q = try Self.bound(try Self.question())
    let o = DialogOffer(
      id: "AAAAAAAAAAAAAAAAAAAAAA", kind: .agentQuestion, subject: q.displaySubject, options: PaneSelect.offered(q), cursor: nil, free_text: 2,
      seen_at: "2026-11-20T00:00:00.000Z", expires_at: "2026-11-20T00:15:00.000Z")
    #expect(o.isValid)
    let back = try JSONDecoder().decode(DialogOffer.self, from: JSONEncoder().encode(o))
    #expect(back == o && back.free_text == 2)
    var bad = o
    bad.free_text = 9
    #expect(!bad.isValid)
    bad = o
    bad.kind = .toolPermission
    #expect(!bad.isValid, "only a question has a free-text option")
    // an older record with no free_text reads as none
    let old = #"{"id":"AAAAAAAAAAAAAAAAAAAAAA","kind":"tool_permission","subject":"Bash command · x","options":["Allow once","Deny"],"cursor":null,"seen_at":"2026-11-20T00:00:00.000Z","expires_at":"2026-11-20T00:15:00.000Z"}"#
    #expect(try JSONDecoder().decode(DialogOffer.self, from: Data(old.utf8)).free_text == nil)
  }

  @Test func theWordsOnThePopupAreTheOwnersAndNeverTheScreensStandingGrants() throws {
    let t = try Self.bound(try Self.tool())
    let o = DialogOffer(
      id: "AAAAAAAAAAAAAAAAAAAAAA", kind: .toolPermission, subject: t.displaySubject, options: PaneSelect.offered(t), cursor: nil,
      seen_at: "2026-11-20T00:00:00.000Z", expires_at: "2026-11-20T00:15:00.000Z")
    let c = NeedsYouPopupContent.make(NeedsYouPopupItem(thread: "trip", threadName: "Garden", dialog: o))
    #expect(c.title == "Allow this tool request?" && c.buttons.map(\.text) == ["Allow once", "Deny"])
    #expect(c.sentence == "Garden's session asks to use the tool shown. Allow once lets it run this one time. Standing permissions are only given at the Mac.")
    #expect(c.buttons.map(\.action) == [.choose(0, label: "Allow once"), .choose(1, label: "Deny")])
    #expect(c.footer == NeedsYouPopupContent.footer)
  }

  @Test func theNoticesForAPromptWithNoCardNameNoTerminal() throws {
    let tool = try #require(PromptDetector.detect(try Self.tool()))
    for line in [SupervisorNotice.workerPromptLine(prompt: tool), SupervisorNotice.mainPromptLine(agentName: "A", prompt: tool)] {
      #expect(line.contains("could not put it on a card") && !line.localizedCaseInsensitiveContains("terminal"), "\(line)")
    }
    let multi = try #require(PromptDetector.detect(try RealScreens.rows("askuser-multi", in: "synthetic")))
    #expect(SupervisorNotice.workerPromptLine(prompt: multi) == "This thread's session is asking several questions at once, which Talos cannot put on a card. Answer them at the Mac.")
    #expect(SupervisorNotice.mainPromptLine(agentName: "A", prompt: multi) == "A is asking several questions at once, which Talos cannot put on a card. Answer them at the Mac.")
    #expect(ThreadNotices.waitingLine(name: "Garden", prompt: "Bash command") == "\(SupervisorNotice.needsYou): the Garden session is waiting on a 'Bash command' prompt. Answer it on its card, or at the Mac.")
  }

  /// A command or a question is text an agent writes. One with a control, hidden or direction-changing character (a right-to-left override that makes
  /// `safe` read last) is not read at all: no card, and the line says so. What the reader does let through is still shown with any mark made visible.
  @Test func aCommandWithAHiddenOrDirectionChangingCharacterGetsNoCard() throws {
    for bad in ["echo safe\u{202E}evil", "echo a\u{200B}b", "echo a\u{0007}b", "echo a\u{FEFF}b"] {
      let rows = try Self.tool().map { $0.replacingOccurrences(of: " touch hello.txt && ls -l hello.txt", with: " " + bad) }
      #expect(PaneSelect.read(rows: rows) == nil, "\(bad.unicodeScalars.map(\.value))")
    }
    let ask = try Self.question().map { $0.replacingOccurrences(of: "Which color do you prefer?", with: "Which color\u{202E} do you prefer?") }
    #expect(PaneSelect.read(rows: ask) == nil)
  }
}

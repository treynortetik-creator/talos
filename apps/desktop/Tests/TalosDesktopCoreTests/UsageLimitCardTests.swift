import Foundation
import Testing

@testable import TalosDesktopCore

/// Pane-prompts row 7: Claude Code's usage-limit menu is a card (`PaneSelect.Kind.usageLimit`). Reads from the synthetic screens (Fixtures/synthetic/
/// usage-limit*.txt: built from the CLI's own strings, no real capture exists yet; docs/CAPTURE-USAGE-LIMIT.md). The words, the two buttons and the
/// three keys (`KeyGuard.Intent.usageLimit`).
@Suite("The usage-limit card")
struct UsageLimitCardTests {
  func rows(_ name: String) throws -> [String] { try RealScreens.rows(name, in: "synthetic") }

  // MARK: what the card says

  @Test func theCardSaysWhenItResetsInPlainWordsAndOffersWaitAndSwitchModel() throws {
    let s = try #require(PaneSelect.read(rows: try rows("usage-limit")))
    #expect(s.kind == .usageLimit)
    #expect(s.displaySubject == "Fable limit reached. It resets 4pm (Europe/Paris).")
    #expect(PaneSelect.offered(s) == ["Stop and wait", "Switch model"])
    // the menu's own rows are kept only to tie an answer to this exact screen, and are never offered
    #expect(s.rows.map(\.label) == ["Stop and wait for limit to reset", "Wait here, then continue automatically when the limit resets", "Switch to usage credits"].map { $0 })
    #expect(PaneSelect.offered(s).allSatisfy { !$0.lowercased().contains("credit") && !$0.lowercased().contains("funds") })
  }

  @Test func aResetTheScreenDoesNotShowIsSaidPlainly() throws {
    let s = try #require(PaneSelect.read(rows: try rows("usage-limit-weekly-model")))
    #expect(s.displaySubject == "Opus 5.5 limit reached. The screen doesn't say when it resets.")
    let admin = try #require(PaneSelect.read(rows: try rows("usage-limit-admin")))
    #expect(admin.displaySubject == "Usage limit reached. The screen doesn't say when it resets.")
  }

  @Test func switchModelIsOfferedOnlyWhenTheHeadlineNamesAModel() throws {
    // a session (5-hour) limit or a team budget is not lifted by another model: Stop and wait only
    for name in ["usage-limit-session", "usage-limit-admin", "usage-limit-upgrade-only"] {
      let s = try #require(PaneSelect.read(rows: try rows(name)))
      #expect(PaneSelect.offered(s) == ["Stop and wait"], "\(name)")
    }
    let session = try #require(PaneSelect.read(rows: try rows("usage-limit-session")))
    #expect(session.displaySubject == "Usage limit reached. It resets Aug 8, 3:10pm.")
  }

  /// Every menu form the CLI draws, a narrow pane included (its footer wraps): a card with the buttons that screen really offers, and the credits rows
  /// never among them.
  @Test(arguments: UsageLimitScreenTests.all)
  func everyFormIsACardWithOnlyTheTwoButtons(name: String) throws {
    let s = try #require(PaneSelect.read(rows: try rows(name)))
    #expect(s.kind == .usageLimit)
    let offered = PaneSelect.offered(s)
    #expect(["Stop and wait", "Switch model"].contains(offered.first ?? ""))
    #expect(offered.allSatisfy { ["Stop and wait", "Switch model"].contains($0) }, "\(name)")
    let offer = DialogOffer(
      id: DialogOffer.newId(), kind: .usageLimit, subject: s.displaySubject, options: offered, cursor: nil, seen_at: "2026-11-21T10:00:00Z",
      expires_at: "2026-11-21T10:15:00Z")
    #expect(offer.isValid)
  }

  @Test func aQuotedMenuAndTheScreenAfterEscapeAreNoCard() throws {
    for name in ["usage-limit-quoted", "usage-limit-quoted-user-status", "usage-limit-quoted-old-model-row", "usage-limit-after-esc"] {
      #expect(PaneSelect.read(rows: try rows(name)) == nil, "\(name)")
    }
  }

  @Test func aMenuWithoutEscToCancelIsNoCard() throws {
    let r = try rows("usage-limit").map { $0.contains("Esc to cancel") ? "  Enter to confirm" : $0 }
    #expect(UsageLimitScreen.read(r) != nil, "control: still the usage-limit screen (and so still no key)")
    #expect(PaneSelect.read(rows: r) == nil)
  }

  @Test func theOfferNeverCarriesAnOptionThatSpendsCredits() {
    func offer(_ options: [String]) -> DialogOffer {
      DialogOffer(
        id: DialogOffer.newId(), kind: .usageLimit, subject: "x", options: options, cursor: nil, seen_at: "2026-11-21T10:00:00Z",
        expires_at: "2026-11-21T10:15:00Z")
    }
    #expect(offer(["Stop and wait", "Switch model"]).isValid)
    #expect(offer(["Stop and wait"]).isValid)
    #expect(!offer(["Stop and wait", "Add funds to continue with usage credits"]).isValid)
    #expect(!offer(["Switch to usage credits"]).isValid)
    #expect(!offer(["Stop and wait", "Stop and wait"]).isValid)
  }

  // MARK: the keys

  static let after = "usage-limit-after-esc"

  /// `idle` for the steps after Escape: the signature of the menu-gone read (the fixture of the idle prompt), as the driver takes it.
  func binding(_ name: String, _ step: KeyGuard.UsageStep, idle: String?? = nil) throws -> KeyGuard.Intent {
    let s = try #require(PaneSelect.read(rows: try rows(name)))
    let sig = try idle ?? (step == .escape ? nil : KeyGuard.idleSignature(try rows(Self.after)))
    return .usageLimit(KeyGuard.UsageBinding(bound: s.bound, limit: UsageLimitScreen.limitKey(s.limit ?? .init()), step: step, idle: sig))
  }

  @Test func escapeGoesToTheMenuItWasMadeForAndNothingElse() throws {
    let menu = try rows("usage-limit")
    #expect(KeyGuard.allows(menu, intent: try binding("usage-limit", .escape)))
    // another menu (another model, another reset, another row list) is another screen
    for other in ["usage-limit-session", "usage-limit-weekly-model", "usage-limit-admin"] {
      let r = try rows(other)
      #expect(KeyGuard.refusal(r, intent: try binding("usage-limit", .escape))?.why == "usage_limit", "\(other)")
    }
    // the cursor is not part of the screen it is tied to (it moves without the menu changing)
    #expect(KeyGuard.allows(try rows("usage-limit-cursor3"), intent: try binding("usage-limit", .escape)))
    // and not the other steps, which belong to the prompt after Escape
    for step in [KeyGuard.UsageStep.typeModel, .enterModel, .clearModel] {
      #expect(KeyGuard.refusal(menu, intent: try binding("usage-limit", step))?.why == "usage_limit", "\(step)")
    }
  }

  @Test func everyOtherIntentStillGetsNoKeyOnTheMenu() throws {
    let menu = try rows("usage-limit")
    for (n, i) in KeyGuardTests.intents { #expect(KeyGuard.refusal(menu, intent: i)?.why == "usage_limit", "\(n)") }
    let s = try #require(PaneSelect.read(rows: menu))
    // a pane Select's number (the digit of the credits row), whatever it is bound to
    for kind in [PaneSelect.Kind.toolPermission, .agentQuestion, .usageLimit] {
      #expect(KeyGuard.refusal(menu, intent: .pane(KeyGuard.PaneBinding(kind: kind, bound: s.bound)))?.why == "usage_limit", "\(kind)")
    }
    #expect(KeyGuard.refusal(menu, intent: .interrupt)?.why == "usage_limit")
    #expect(KeyGuard.refusal(menu, intent: .interruptBlank)?.why == "usage_limit")
    #expect(KeyGuard.refusal(menu, intent: nil)?.why == "no_intent")
    #expect(KeyGuard.refusal(nil, intent: try binding("usage-limit", .escape))?.why == "unreadable")
  }

  @Test func escapeIsRefusedOnAnythingButTheMenu() throws {
    let esc = try binding("usage-limit", .escape)
    for name in [Self.after, "usage-limit-quoted"] { #expect(KeyGuard.refusal(try rows(name), intent: esc)?.why == "not_usage_limit", "\(name)") }
    #expect(KeyGuard.refusal(KeyGuardTests.box, intent: esc)?.why == "not_usage_limit")
  }

  /// After Escape the headline stays above Claude's empty box: `/model` is typed there, for the same limit only.
  @Test func slashModelIsTypedAndEnteredOnlyOnTheIdlePromptOfTheSameLimit() throws {
    let idle = try rows(Self.after)
    #expect(KeyGuard.allows(idle, intent: try binding("usage-limit", .typeModel)), "control: the empty box under the same limit's headline")
    // the same prompt, another limit's headline
    #expect(KeyGuard.refusal(idle, intent: try binding("usage-limit-session", .typeModel))?.why == "not_usage_limit")
    #expect(KeyGuard.refusal(idle.map { $0.replacingOccurrences(of: "Fable", with: "Opus") }, intent: try binding("usage-limit", .typeModel))?.why == "not_usage_limit")
    // no headline on the pane: not after this menu
    #expect(KeyGuard.refusal(KeyGuardTests.box, intent: try binding("usage-limit", .typeModel))?.why == "not_usage_limit")
    // a draft in the box: nothing typed into it
    let draft = typedRows(idle, "half a thought")
    #expect(KeyGuard.refusal(draft, intent: try binding("usage-limit", .typeModel)) != nil)
    // Enter only when the box holds exactly /model (a real draft colour is how the guard tells typed words from a placeholder)
    let typed = typedRows(idle, "/model")
    #expect(KeyGuard.allows(typed, intent: try binding("usage-limit", .enterModel)))
    #expect(KeyGuard.refusal(idle, intent: try binding("usage-limit", .enterModel))?.why == "box_not_our_line", "an empty box gets no Enter")
    #expect(KeyGuard.refusal(typedRows(idle, "/model please run the gate"), intent: try binding("usage-limit", .enterModel))?.why == "box_not_our_line")
    #expect(KeyGuard.refusal(typedRows(idle, "/modelx"), intent: try binding("usage-limit", .enterModel))?.why == "box_not_our_line")
  }

  @Test func theEnterAcceptsTheSlashListAndNothingElseUnderTheBox() throws {
    let idle = try rows(Self.after)
    let enter = try binding("usage-limit", .enterModel)
    let list = ["  /model        Set the AI model for Claude Code", "  /memory       Edit memory files"]
    #expect(KeyGuard.allows(withUnderBox(typedRows(idle, "/model"), list), intent: enter), "the list of commands Claude draws for a typed slash")
    // a select of any other shape under the box: no Enter
    for under in [["  ❯ 1. Yes", "    2. No"], ["  Allow this? (y/n)"], ["  Buy $50 of credits", "  Cancel"], ["  /model", "  Buy $50 of credits"]] {
      #expect(KeyGuard.refusal(withUnderBox(typedRows(idle, "/model"), under), intent: enter) != nil, "\(under[0])")
    }
    // and a typed /model never goes in with the menu itself up
    #expect(KeyGuard.refusal(try rows("usage-limit"), intent: enter)?.why == "usage_limit")
  }

  /// R1-1: Enter runs the HIGHLIGHTED row of Claude's slash list, so the list is accepted only when that row is exactly `/model`.
  @Test func theEnterIsRefusedWhenTheHighlightedSlashRowIsNotExactlySlashModel() throws {
    let idle = try rows(Self.after)
    let enter = try binding("usage-limit", .enterModel)
    func list(_ rows: [String]) -> [String] { withUnderBox(typedRows(idle, "/model"), rows) }
    // the cursor on /model: fine, whatever else is listed
    let marked = list(["  ❯ /model        Set the AI model", "    /memory       Edit memory files"])
    #expect(KeyGuard.allows(marked, intent: enter))
    // the cursor on /memory, on a project command that merely starts with /model, on a row that is not first, or on two rows: refused
    for under in [
      ["    /model        Set the AI model", "  ❯ /memory       Edit memory files"],
      ["  ❯ /model-x      A project command", "    /model        Set the AI model"],
      ["    /model        Set the AI model", "  ❯ /model-x      A project command"],
      ["  ❯ /model        Set the AI model", "  ❯ /memory       Edit memory files"],
      ["  ❯ /modelx", "    /model"],
    ] {
      #expect(KeyGuard.refusal(list(under), intent: enter)?.why == "row_under_box", "\(under[0])")
    }
    // no cursor mark at all (the real list may mark it by colour): only when the first row is exactly /model
    #expect(KeyGuard.allows(list(["  /model        Set the AI model", "  /memory       Edit memory files"]), intent: enter))
    #expect(KeyGuard.refusal(list(["  /memory       Edit memory files", "  /model        Set the AI model"]), intent: enter)?.why == "row_under_box")
    #expect(KeyGuard.refusal(list(["  /model-x      A project command", "  /model        Set the AI model"]), intent: enter)?.why == "row_under_box")
  }

  /// R1-5: the steps after Escape are tied to the idle prompt the menu-gone read saw, not only to the headline text.
  @Test func theLaterStepsAreTiedToTheMenuGoneReadAndNotOnlyToTheHeadline() throws {
    let idle = try rows(Self.after)
    for step in [KeyGuard.UsageStep.typeModel, .enterModel, .clearModel] {
      let screen = step == .typeModel ? idle : typedRows(idle, "/model")
      #expect(KeyGuard.allows(screen, intent: try binding("usage-limit", step)), "control: \(step)")
      // a bound with no signature, or with another screen's, goes nowhere
      #expect(KeyGuard.refusal(screen, intent: try binding("usage-limit", step, idle: .some(nil)))?.why == "not_usage_limit", "\(step): none")
      #expect(KeyGuard.refusal(screen, intent: try binding("usage-limit", step, idle: .some("another screen")))?.why == "not_usage_limit", "\(step): another")
      // the same headline still on the pane, but the conversation moved on under it (a new answer arrived): another generation
      let moved = screen.flatMap { $0.hasPrefix("⏺ Running the gate now.") ? [$0, "", "⏺ The gate passed."] : [$0] }
      #expect(KeyGuard.refusal(moved, intent: try binding("usage-limit", step))?.why == "not_usage_limit", "\(step): moved on")
    }
  }

  /// R1-2: the Backspaces that clear a typed `/model` go only while the box holds exactly that.
  @Test func theBackspacesGoOnlyWhileTheBoxHoldsExactlySlashModel() throws {
    let idle = try rows(Self.after)
    let clear = try binding("usage-limit", .clearModel)
    #expect(KeyGuard.allows(typedRows(idle, "/model"), intent: clear))
    // allowed even where the Enter is not: a list with the cursor on /memory under the box (that refusal is why they are sent)
    let memory = withUnderBox(typedRows(idle, "/model"), ["  ❯ /memory       Edit memory files"])
    #expect(KeyGuard.allows(memory, intent: clear))
    for text in ["/model x", "/mod", "hello", "/modelx"] {
      #expect(KeyGuard.refusal(typedRows(idle, text), intent: clear)?.why == "box_not_our_line", "\(text)")
    }
    #expect(KeyGuard.refusal(idle, intent: clear)?.why == "box_not_our_line", "an empty box: nothing to clear")
    #expect(KeyGuard.refusal(try rows("usage-limit"), intent: clear)?.why == "usage_limit", "never with the menu up")
  }

  @Test func theAuditNamesTheStep() throws {
    #expect(KeyGuard.UsageStep.allCases.map { KeyGuard.Intent.usageLimit(.init(bound: "b", limit: "l", step: $0)).name } == ["usage-limit-escape", "usage-limit-typeModel", "usage-limit-enterModel", "usage-limit-clearModel"])
    #expect(KeyGuard.intent(for: .usageLimit) == nil, "a card's tap states its own intent with the screen's binding, never one by kind")
  }

  // MARK: the old lines

  @Test func theLinesNameNoTerminalNoPaneAndNoCommand() {
    let i = UsageLimitScreen.Info(model: "Fable", resets: "4pm (Europe/Paris)")
    let lines = [UsageLimitScreen.threadLine(i), UsageLimitScreen.mainLine(i), UsageLimitScreen.menuLine, UsageLimitScreen.stallLine, UsageLimitScreen.threadLine(.init())]
    for l in lines {
      for word in ["Terminal", "pane", "tmux", "Esc", "/model"] { #expect(!l.contains(word), "\(word) in: \(l)") }
    }
    #expect(UsageLimitScreen.threadLine(i).hasPrefix("This thread's session hit the usage limit for Fable. It resets 4pm (Europe/Paris)."))
    #expect(UsageLimitScreen.mainLine(.init()).contains("The screen doesn't say when it resets."))
  }

  // MARK: helpers

  /// Claude's box holding `text` (plain rows carry no colours, so the words read as typed).
  func typedRows(_ plain: [String], _ text: String) -> [String] {
    plain.map { r in r.hasPrefix("❯") && r.dropFirst().allSatisfy { $0 == " " || $0 == "\u{00A0}" } ? "❯\u{00A0}" + text : r }
  }

  func withUnderBox(_ rows: [String], _ under: [String]) -> [String] {
    guard let bottom = rows.lastIndex(where: DialogMatcher.isFrameRule) else { return rows }
    return Array(rows[...bottom]) + under
  }
}

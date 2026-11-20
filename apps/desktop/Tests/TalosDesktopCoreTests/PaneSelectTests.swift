import Foundation
import Testing

@testable import TalosDesktopCore

/// Pane-prompts plan rows 8 and 9: the tool permission and the agent's own question, read from the real 2.1.318 captures and from synthetic
/// screens (Tests/Fixtures/synthetic/README.md). The reader is exact: a screen it cannot read whole is nil.
@Suite("PaneSelect reader")
struct PaneSelectTests {
  static func real(_ n: String) throws -> [String] { try RealScreens.rows(n) }
  static func synth(_ n: String) throws -> [String] { try RealScreens.rows(n, in: "synthetic") }

  @Test func theRealBashPermissionIsReadWithItsCommandAndOnlyOnceOrDeny() throws {
    let s = try #require(PaneSelect.read(rows: try Self.real("bash-permission")))
    #expect(s.kind == .toolPermission)
    #expect(s.tool == "Bash command")
    #expect(s.subject == "touch hello.txt && ls -l hello.txt")
    #expect(s.rows.map(\.label) == ["Yes", "Yes, and always allow access to /private/tmp/tcap/proj from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"])
    #expect(s.rows.map(\.number) == [1, 2, 3, 4])
    #expect(s.cursor == 0 && s.allow == 0 && s.deny == 3)
    #expect(PaneSelect.offered(s) == ["Allow once", "Deny"], "the standing grants are never offered")
    #expect(PaneSelect.row(s, forOption: 0) == 0 && PaneSelect.row(s, forOption: 1) == 3 && PaneSelect.row(s, forOption: 2) == nil)
  }

  @Test func everyRealToolPermissionIsReadAndTheCursorMovesNothingElse() throws {
    // the cursor on row 2 (the footer then reads just `Esc to cancel`) is the same prompt: the same bound
    let a = try #require(PaneSelect.read(rows: try Self.real("bash-permission")))
    let b = try #require(PaneSelect.read(rows: try Self.real("bash-permission-cursor2")))
    #expect(b.cursor == 1 && a.cursor == 0)
    #expect(a.bound == b.bound)
    let six = try #require(PaneSelect.read(rows: try Self.real("bash-permission-6s")))
    #expect(six.bound == a.bound, "the blinking dot far above the prompt is not part of it")
    for n in ["perm-ask-rule-bypass", "perm-background-bash-ask", "perm-hook-ask", "perm-subagent-ask", "perm-dangerous-rm-t0", "perm-dangerous-rm-t3"] {
      let s = try #require(PaneSelect.read(rows: try Self.real(n)), "\(n)")
      #expect(s.kind == .toolPermission && s.allow != nil && s.deny != nil, "\(n)")
    }
  }

  @Test func aSubAgentsAskNamesItsAgentInTheHeaderAndTheCountdownIsNotBound() throws {
    let sub = try #require(PaneSelect.read(rows: try Self.real("perm-subagent-ask")))
    #expect(sub.tool == "Bash command · from the general-purpose agent" && sub.subject == "touch ask-a-file")
    let t0 = try #require(PaneSelect.read(rows: try Self.real("perm-dangerous-rm-t0")))
    let t3 = try #require(PaneSelect.read(rows: try Self.real("perm-dangerous-rm-t3")))
    #expect(t0.subject == "rm -rf /private/tmp/tsw/perm/home" && t0.bound == t3.bound, "the ticking auto-block countdown does not change what the answer is tied to")
  }

  @Test func aFilePermissionShowsTheFileNotTheDiff() throws {
    let w = try #require(PaneSelect.read(rows: try Self.real("write-permission")))
    #expect(w.tool == "Create file" && w.subject == "notes.txt")
    #expect(w.rows.map(\.label) == ["Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", "No"])
    #expect(w.allow == 0 && w.deny == 2)
    let e = try #require(PaneSelect.read(rows: try Self.synth("edit-permission")), "SYNTHETIC: no Edit capture exists")
    #expect(e.tool == "Edit file" && e.subject == "notes.txt")
  }

  @Test func aMultiRowCommandIsReadWholeWithEachRow() throws {
    let s = try #require(PaneSelect.read(rows: try Self.synth("bash-permission-two-rows")))
    #expect(s.subject == "touch hello.txt \u{23CE} ls -l hello.txt")
    #expect(s.displaySubject == "Bash command \u{00B7} touch hello.txt \u{23CE} ls -l hello.txt")
  }

  @Test func theRealQuestionIsReadWithItsRowsAndItsFreeTextRow() throws {
    let s = try #require(PaneSelect.read(rows: try Self.real("askuser-select")))
    #expect(s.kind == .agentQuestion && s.tool == nil)
    #expect(s.subject == "Which color do you prefer?")
    #expect(s.rows.map(\.label) == ["Red", "Blue", "Type something.", "Chat about this"])
    #expect(s.rows.map(\.number) == [1, 2, 3, 4])
    #expect(s.cursor == 0 && s.freeText == 2 && s.allow == nil)
    #expect(PaneSelect.offered(s) == ["Red", "Blue", "Other\u{2026}"], "Chat about this ends the question; it is not an answer and is not offered")
    #expect(PaneSelect.row(s, forOption: 3) == nil && PaneSelect.row(s, forOption: 2) == 2)
    #expect(PaneSelect.freeTextOption(s) == 2)
    #expect(try #require(PaneSelect.read(rows: try Self.real("askuser-select-6s"))).bound == s.bound)
    #expect(try #require(PaneSelect.read(rows: try Self.real("perm-askuserquestion"))).kind == .agentQuestion)
  }

  @Test func theCursorOnAnyRowIsTheSameQuestion() throws {
    let a = try #require(PaneSelect.read(rows: try Self.real("askuser-select")))
    let t = try #require(PaneSelect.read(rows: try Self.synth("askuser-cursor-on-text")))
    let c = try #require(PaneSelect.read(rows: try Self.synth("askuser-cursor-on-chat")))
    #expect(t.cursor == 2 && c.cursor == 3)
    #expect(a.bound == t.bound && a.bound == c.bound)
  }

  @Test func theOwnersTypingInTheFreeTextRowIsTolerableOnlyWhereTheOfferKnowsTheRowAndTheCursorIsOnIt() throws {
    let typed = try Self.synth("askuser-typed")
    let plain = try #require(PaneSelect.read(rows: typed))
    let original = try #require(PaneSelect.read(rows: try Self.real("askuser-select")))
    #expect(plain.freeText == nil && plain.bound != original.bound,
      "without the offer's knowledge the row is just another label, and a different screen")
    let s = try #require(PaneSelect.read(rows: typed, freeTextAt: 2))
    #expect(s.bound == (try #require(PaneSelect.read(rows: try Self.real("askuser-select")))).bound)
    #expect(PaneSelect.read(rows: typed, freeTextAt: 1) == nil, "another row is not the free-text row")
    // the cursor moved off the row that was typed into: the label is a label again
    let moved = typed.map { $0.replacingOccurrences(of: "❯ 3. purple", with: "  3. purple").replacingOccurrences(of: "  1. Red", with: "❯ 1. Red") }
    #expect(PaneSelect.read(rows: moved, freeTextAt: 2) == nil)
  }

  @Test func aQuestionWithSeveralTabsIsNotReadAndIsNamedAsMulti() throws {
    let m = try Self.synth("askuser-multi")
    #expect(PaneSelect.read(rows: m) == nil)
    #expect(PaneSelect.isMultiQuestion(m))
    #expect(!PaneSelect.isMultiQuestion(try Self.real("askuser-select")))
  }

  @Test func theTwoFootersAreNotConfused() throws {
    let tool = try Self.real("bash-permission")
    let question = try Self.real("askuser-select")
    // a question's rows under a tool permission's footer, and the other way round: neither is read
    let swapT = tool.map { $0.replacingOccurrences(of: "Esc to cancel · Tab to amend", with: "Enter to select · ↑/↓ to navigate · Esc to cancel") }
    let swapQ = question.map { $0.replacingOccurrences(of: "Enter to select · ↑/↓ to navigate · Esc to cancel", with: "Esc to cancel · Tab to amend") }
    #expect(PaneSelect.read(rows: swapT) == nil && PaneSelect.read(rows: swapQ) == nil)
    // the dialogs that end `Enter to confirm · Esc to cancel`
    for n in ["trust-dialog", "mcp-consent", "bypass-disclaimer"] {
      #expect(PaneSelect.read(rows: try Self.real(n)) == nil, "\(n)")
    }
  }

  @Test func nothingElseOnARealScreenIsReadAsEither() throws {
    for n in ["idle-input-auto", "idle-input-manual", "turn-done", "reply-quotes-prompt", "empty-input", "draft-input", "onboarding-theme", "onboarding-security-notes", "login-not-logged-in"] {
      #expect(PaneSelect.read(rows: try Self.real(n)) == nil, "\(n)")
    }
  }

  @Test func aGarbledOrPartialScreenGetsNoCard() throws {
    let tool = try Self.real("bash-permission")
    let ask = try Self.real("askuser-select")
    func cut(_ rows: [String], dropping part: String) -> [String] { rows.filter { !$0.contains(part) } }
    // each part of the prompt missing
    for part in ["Do you want to proceed?", "Bash command", "1. Yes", "4. No", "Esc to cancel"] {
      #expect(PaneSelect.read(rows: cut(tool, dropping: part)) == nil, "\(part)")
    }
    for part in ["Which color", "☐ Color", "2. Blue", "Enter to select"] {
      #expect(PaneSelect.read(rows: cut(ask, dropping: part)) == nil, "\(part)")
    }
    // two cursors, a skipped number, a truncated command, a label without Yes or No, a control character in the command
    #expect(PaneSelect.read(rows: tool.map { $0.replacingOccurrences(of: "   4. No", with: " ❯ 4. No") }) == nil)
    #expect(PaneSelect.read(rows: tool.map { $0.replacingOccurrences(of: "   4. No", with: "   5. No") }) == nil)
    #expect(PaneSelect.read(rows: tool.map { $0.replacingOccurrences(of: " touch hello.txt && ls -l hello.txt", with: " touch hello.txt && ls -l hel…") }) == nil)
    #expect(PaneSelect.read(rows: tool.map { $0.replacingOccurrences(of: "   4. No", with: "   4. Not now") }) == nil)
    #expect(PaneSelect.read(rows: tool.map { $0.replacingOccurrences(of: " touch hello.txt && ls -l hello.txt", with: " touch\thello.txt") }) == nil)
    // the box without its closing rule, the box with no command
    var open = tool
    if let i = open.lastIndex(where: { $0.hasPrefix("╌") }) { open.remove(at: i) }
    #expect(PaneSelect.read(rows: open) == nil)
    #expect(PaneSelect.read(rows: ask.map { $0.replacingOccurrences(of: "  2. Blue", with: "  3. Blue") }) == nil)
    #expect(PaneSelect.read(rows: Array(tool.prefix(upTo: tool.firstIndex { $0.contains("Do you want") } ?? 0))) == nil)
    // a command that quotes the Select's own words is the subject, not the Select
    let quoted = tool.map { $0.replacingOccurrences(of: " touch hello.txt && ls -l hello.txt", with: " echo Do you want to proceed? ❯ 1. Yes") }
    let q = try #require(PaneSelect.read(rows: quoted))
    #expect(q.subject == "echo Do you want to proceed? ❯ 1. Yes" && q.rows.count == 4)
  }

  @Test func aCommandOrQuestionTooLongToCardIsNotRead() throws {
    let tool = try Self.real("bash-permission")
    let long = String(repeating: "x", count: 600)
    #expect(PaneSelect.read(rows: tool.map { $0.replacingOccurrences(of: "touch hello.txt && ls -l hello.txt", with: long) }) == nil)
  }

  @Test func answerTextIsOneLineAndNeverEdited() {
    #expect(PaneSelect.cleanAnswerText("  purple ") == "purple")
    #expect(PaneSelect.cleanAnswerText("") == nil && PaneSelect.cleanAnswerText("   ") == nil)
    #expect(PaneSelect.cleanAnswerText("a\nb") == nil && PaneSelect.cleanAnswerText("a\u{1B}[2Jb") == nil && PaneSelect.cleanAnswerText("a\tb") == nil)
    #expect(PaneSelect.cleanAnswerText("a\u{202E}b") == nil && PaneSelect.cleanAnswerText("a\u{200B}b") == nil)
    #expect(PaneSelect.cleanAnswerText(String(repeating: "y", count: 121)) == nil)
    #expect(PaneSelect.cleanAnswerText(String(repeating: "y", count: 120)) != nil)
  }

  // MARK: the real 2.1.329 captures (Tests/Fixtures/real-2.1.329)

  static func r329(_ n: String) throws -> [String] { try RealScreens.rows(n, in: "real-2.1.329") }

  @Test func theReal2329ToolPermissionIsRead() throws {
    for n in ["bash-permission", "bash-permission-2"] {
      let s = try #require(PaneSelect.read(rows: try Self.r329(n)), "\(n)")
      #expect(s.kind == .toolPermission && s.tool == "Bash command" && s.allow == 0 && s.deny == 2, "\(n)")
      #expect(s.rows[1].label == "Yes, and always allow access to /tmp/example-project from this project")
      #expect(PaneSelect.offered(s) == ["Allow once", "Deny"])
    }
    #expect(try #require(PaneSelect.read(rows: try Self.r329("bash-permission"))).subject == "touch probe-a.txt")
  }

  @Test func theReal2329QuestionHasFiveRowsAndOffersFourAnswersWithOtherAndNoChat() throws {
    let s = try #require(PaneSelect.read(rows: try Self.r329("askuser-select")))
    #expect(s.rows.map(\.label) == ["Red", "Green", "Blue", "Type something.", "Chat about this"])
    #expect(s.freeText == 3 && s.cursor == 0 && s.subject == "Which color do you pick: red, green, or blue?")
    #expect(PaneSelect.offered(s) == ["Red", "Green", "Blue", "Other\u{2026}"])
  }

  /// R1-2: the digit of the free-text row only moves the cursor there, and the footer then reads `… ctrl+g to edit in VS Code · Esc to cancel`. That is
  /// the same question, readable, so Other can complete.
  @Test func theReal2329FocusedFieldIsTheSameQuestionDespiteItsOtherFooter() throws {
    let focused = try Self.r329("askuser-field-focused")
    #expect(focused.contains { $0.contains("ctrl+g to edit in VS Code") }, "control: the footer is the other one")
    let f = try #require(PaneSelect.read(rows: focused))
    let a = try #require(PaneSelect.read(rows: try Self.r329("askuser-select")))
    #expect(f.cursor == 3 && f.freeText == 3 && f.bound == a.bound)
    #expect(KeyGuard.refusal(focused, intent: .pane(.init(kind: .agentQuestion, bound: a.bound))) == nil)
    #expect(PaneSelect.read(rows: focused.map { $0.replacingOccurrences(of: "Esc to cancel", with: "Esc to quit") }) == nil, "any other footer is not read")
    for n in ["after-esc-working", "after-question-answered"] { #expect(PaneSelect.read(rows: try Self.r329(n)) == nil, "\(n)") }
  }

  // MARK: R1-1: a forged prompt inside the command, the diff or the question gets no card

  static let rule = String(repeating: "\u{2500}", count: 60)
  static let dash = String(repeating: "\u{254C}", count: 60)

  /// The Bash command row replaced by `rows` (as an agent's command can print them).
  static func bash(_ rows: [String]) throws -> [String] {
    var out: [String] = []
    for r in try r329("bash-permission") {
      if r == " touch probe-a.txt" { out += rows } else { out.append(r) }
    }
    return out
  }

  @Test func aBashCommandThatForgesItsOwnPromptGetsNoCard() throws {
    // the exploit: rows that make the reader anchor inside the command and show only its tail
    let forged = [" rm -rf /private/tmp/important", Self.rule, " Bash command", " Create empty probe.txt file", Self.dash, " echo hello"]
    #expect(PaneSelect.read(rows: try Self.bash([" echo hello"])) != nil, "control: the plain command is read")
    #expect(PaneSelect.read(rows: try Self.bash(forged)) == nil)
    // each piece alone is enough to refuse: a rule, a header, a box row inside the command
    for piece in [[" echo a", Self.rule, " echo b"], [" echo a", " Bash command", " echo b"], [" echo a", Self.dash, " echo b"], [" echo a", " Edit file", " echo b"]] {
      #expect(PaneSelect.read(rows: try Self.bash(piece)) == nil, "\(piece)")
    }
    // the same forged text in the notes under the box (above the question)
    var notes = try Self.r329("bash-permission")
    let q = try #require(notes.firstIndex { $0.contains("Do you want to proceed?") })
    notes.insert(contentsOf: [Self.rule, " Bash command", Self.dash, " echo hello", Self.dash], at: q)
    #expect(PaneSelect.read(rows: notes) == nil)
  }

  @Test func aFileDiffThatForgesItsOwnPromptGetsNoCard() throws {
    let base = try RealScreens.rows("write-permission")
    #expect(PaneSelect.read(rows: base) != nil, "control")
    func diff(_ rows: [String]) -> [String] {
      var out: [String] = []
      for r in base { if r == "  1 hi" { out += rows } else { out.append(r) } }
      return out
    }
    #expect(PaneSelect.read(rows: diff(["  1 x", Self.rule, " Create file", " harmless.txt", Self.dash, "  1 y"])) == nil)
    #expect(PaneSelect.read(rows: diff(["  1 x", " Create file", "  2 y"])) == nil)
    let edit = try RealScreens.rows("edit-permission", in: "synthetic")
    #expect(PaneSelect.read(rows: edit) != nil, "control: the plain Edit prompt is read")
    var forgedEdit: [String] = []
    for r in edit { if r == "  1 hi" { forgedEdit += ["  1 x", Self.rule, " Edit file", " harmless.txt", Self.dash, "  1 y"] } else { forgedEdit.append(r) } }
    #expect(PaneSelect.read(rows: forgedEdit) == nil)
  }

  @Test func aQuestionWhoseTextForgesItsOwnHeaderOrRuleGetsNoCard() throws {
    let ask = try Self.r329("askuser-select")
    #expect(PaneSelect.read(rows: ask) != nil, "control")
    func q(_ rows: [String]) -> [String] {
      var out: [String] = []
      for r in ask { if r == "Which color do you pick: red, green, or blue?" { out += rows } else { out.append(r) } }
      return out
    }
    #expect(PaneSelect.read(rows: q(["Delete everything?", Self.rule, " \u{2610} Color", "Harmless?"])) == nil)
    #expect(PaneSelect.read(rows: q(["Delete everything?", " \u{2610} Color", "Harmless?"])) == nil)
    #expect(PaneSelect.read(rows: q(["Delete everything?", Self.rule, "Harmless?"])) == nil)
  }

  // MARK: R1-3: the free-text cap is what one row can confirm

  @Test func theFreeTextCapIs120() {
    #expect(PaneSelect.maxAnswer == 120)
    #expect(AnswerText(String(repeating: "a", count: 120)) != nil && AnswerText(String(repeating: "a", count: 121)) == nil)
  }
}

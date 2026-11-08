import Foundation
import Testing
@testable import TalosDesktopCore

/// A prompt of the CLI's that Talos has no name for (a tool permission, the agent's own question, a Select) is found from its
/// SHAPE on the screen. Every positive and negative here is a REAL Claude Code 2.1.318 capture (Fixtures/real-2.1.318, README);
/// a test that builds its own screen says SYNTHETIC.
@Suite("PromptDetector on real captures")
struct PromptDetectorRealTests {
  @Test(arguments: [
    ("bash-permission", PromptDetector.Kind.bashCommand, "Do you want to proceed?", true),
    ("bash-permission-cursor2", .bashCommand, "Do you want to proceed?", true),
    ("write-permission", .fileCreate, "Do you want to create notes.txt?", true),
    ("askuser-select", .question, "Which color do you prefer?", true),
    ("onboarding-theme", .other, "Choose the text style that looks best with your terminal", false),
  ])
  func aPromptWaitingOnAKeypressIsFound(name: String, kind: PromptDetector.Kind, question: String, footer: Bool) throws {
    let p = try #require(PromptDetector.detect(try RealScreens.rows(name)), "\(name) is a prompt")
    #expect(p.kind == kind)
    #expect(p.question == question)
    #expect(p.footer == footer)
  }

  /// The idle input box looks framed and cursored but is not a prompt. The turn that just ended, the interrupted one, and a reply
  /// that quotes a whole prompt are not prompts either. The security notes only say "Press Enter to continue": not a Select.
  @Test(arguments: [
    "idle-input-auto", "idle-input-manual", "turn-done", "after-esc", "reply-quotes-prompt", "onboarding-security-notes",
    "empty-input", "draft-input",
  ])
  func screensThatAreNotPromptsAreNotFlagged(name: String) throws {
    #expect(PromptDetector.detect(try RealScreens.rows(name)) == nil, "\(name)")
  }

  /// The known four keep their own handling: the generic detector never answers for them, so nothing is announced twice.
  @Test(arguments: [
    "trust-dialog", "trust-dialog-tcap", "mcp-consent", "bypass-disclaimer", "login-not-logged-in",
  ])
  func aKnownDialogIsNeverAlsoAGenericPrompt(name: String) throws {
    let rows = try RealScreens.rows(name)
    if name != "login-not-logged-in" { #expect(DialogMatcher.liveDialog(rows) != .none, "control: \(name) is a known dialog") }
    #expect(PromptDetector.detect(rows) == nil, "\(name)")
  }

  /// The cursor moving to another option is the same prompt: same identity, region changed.
  @Test func movingTheCursorKeepsThePromptAndChangesItsRegion() throws {
    let a = try #require(PromptDetector.detect(try RealScreens.rows("bash-permission")))
    let b = try #require(PromptDetector.detect(try RealScreens.rows("bash-permission-cursor2")))
    #expect(a.signature == b.signature)
    #expect(a.region != b.region)
  }

  /// STILLNESS region: the transcript above the prompt has a blinking activity dot (07 vs 07b differ in one line far above it; the
  /// 09 and 10 pairs, six seconds apart, came out identical). The prompt's own region is identical, so a blink does not restart the wait.
  @Test(arguments: [("bash-permission", true), ("write-permission", false), ("askuser-select", false)])
  func aBlinkingLineAboveThePromptIsNotInItsRegion(name: String, screensDiffer: Bool) throws {
    let early = try RealScreens.rows(name)
    let late = try RealScreens.rows(name + "-6s")
    #expect((early != late) == screensDiffer, "control: the whole screens differ only for the Bash pair")
    let a = try #require(PromptDetector.detect(early))
    let b = try #require(PromptDetector.detect(late))
    #expect(a.region == b.region)
    #expect(a.signature == b.signature)
  }

  @Test func theRegionStartsAtTheFrameRuleAboveTheCursor() throws {
    let rows = try RealScreens.rows("askuser-select")
    let p = try #require(PromptDetector.detect(rows))
    #expect(DialogMatcher.isFrameRule(try #require(p.region.first)))
    #expect(p.region.contains { $0.contains("Which color do you prefer?") })
    #expect(p.region.contains { $0.contains("4. Chat about this") }, "the second rule inside the prompt does not cut it short")
    #expect(!p.region.contains { $0.contains("Cogitated") })
  }
}

/// The distinctions the rule rests on, each pinned on its own. Screens built here are SYNTHETIC, copying the shapes of the real ones.
@Suite("PromptDetector structure")
struct PromptDetectorShapeTests {
  let rule = String(repeating: "\u{2500}", count: 60)

  @Test func aNumberedOptionListBelowARuleIsAPromptWithOrWithoutAKnownFooter() {
    let numbered = ["output", rule, " Allow it?", " \u{276F} 1. Yes", "   2. No"]
    #expect(PromptDetector.detect(numbered)?.footer == false)
    #expect(PromptDetector.detect(numbered + ["", " Esc to cancel"])?.footer == true)
    // unnumbered, aligned with the cursor's text
    #expect(PromptDetector.detect(["output", rule, " Pick one", " \u{276F} Red", "   Blue", "   Green"]) != nil)
  }

  /// The idle box: its cursor is followed by free text, nothing lines up under it, and the status footer is there.
  @Test func theIdleBoxIsNotAPromptWhatEverIsInIt() {
    let status = "  \u{23F8} manual mode on \u{00B7} ? for shortcuts"
    #expect(PromptDetector.detect(["output", rule, "\u{276F}\u{00A0}", rule, status]) == nil)
    #expect(PromptDetector.detect(["output", rule, "\u{276F} Try \"fix lint errors\"", rule, status]) == nil)
    // a draft that looks like an option, and one that wraps onto an aligned row: the box is two rules around it
    #expect(PromptDetector.detect(["output", rule, "\u{276F}\u{00A0}1. fix it", "  2. then this", rule, status]) == nil)
    #expect(PromptDetector.detect(["output", rule, "\u{276F}\u{00A0}one long draft", "  that wraps", rule, "  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)"]) == nil)
    // the same draft with a footer line we have never seen, or none: still the box (a rule above and below), not a prompt
    #expect(PromptDetector.detect(["output", rule, "\u{276F}\u{00A0}1. fix it", "  2. then this", rule, "  Press Ctrl-C again to exit"]) == nil)
    #expect(PromptDetector.detect(["output", rule, "\u{276F}\u{00A0}one long draft", "  that wraps", rule]) == nil)
    // a status footer rules out a cursor row even with options lined up and no box around it
    #expect(PromptDetector.detect(["output", rule, " \u{276F} 1. Yes", "   2. No", "", status]) == nil)
  }

  /// A prompt quoted in the agent's reply is above the last frame rule, with the real idle box below it.
  @Test func aQuotedPromptAboveTheIdleBoxIsNotAPrompt() {
    let quoted = ["\u{23FA} Do you want to proceed?", "  \u{276F} 1. Yes", "  2. No", "  Esc to cancel \u{00B7} Tab to amend", ""]
    #expect(PromptDetector.detect(quoted + [rule, "\u{276F}\u{00A0}", rule, "  \u{23F8} manual mode on \u{00B7} ? for shortcuts"]) == nil)
    // even if the idle box were drawn with a status line we do not know, the quote has no frame rule of its own above its cursor
    #expect(PromptDetector.detect(quoted + [rule, "\u{276F}\u{00A0}", rule]) == nil)
    // the user's own lines in the history start with the same glyph and the next line is indented: not options
    #expect(PromptDetector.detect(["\u{276F} Reply with these lines", "  \"Esc to cancel\"", "", rule, "\u{276F}\u{00A0}", rule, "  ? for shortcuts"]) == nil)
  }

  @Test func oneCursorAndSiblingsThatLineUpAreRequired() {
    // no sibling at all, siblings that do not line up with the cursor's text, two cursors
    #expect(PromptDetector.detect(["output", rule, " Allow it?", " \u{276F} 1. Yes"]) == nil)
    #expect(PromptDetector.detect(["output", rule, " Allow it?", " \u{276F} 1. Yes", "2. No", " 3. Maybe"]) == nil)
    #expect(PromptDetector.detect(["output", rule, " \u{276F} 1. Yes", "   2. No", " \u{276F} 3. Maybe", "   4. Other"]) == nil)
    // the cursor's text and a ✔ marker (the theme Select): siblings line up with the label, not the marker
    #expect(PromptDetector.detect(["Pick", "", "     Auto", " \u{276F} \u{2714} Dark", "     Light"]) != nil)
  }

  @Test func theTrustDialogIsKnownNotGeneric() {
    let trust = ["Quick safety check", "", " \u{276F} No, exit", "   Yes, I trust this folder", "", " Enter to confirm \u{00B7} Esc to cancel"]
    #expect(PromptDetector.detect([rule] + trust) == nil)
  }

  @Test func theFooterShapesAreSupportingEvidenceOnly() {
    for f in ["Esc to cancel", "Esc to cancel \u{00B7} Tab to amend", "Enter to select \u{00B7} \u{2191}/\u{2193} to navigate \u{00B7} Esc to cancel", "Enter to confirm \u{00B7} Esc to cancel"] {
      #expect(PromptDetector.detect([rule, " Q?", " \u{276F} 1. A", "   2. B", "", " " + f])?.footer == true, "\(f)")
    }
    #expect(PromptDetector.detect([rule, " Q?", " \u{276F} 1. A", "   2. B", "", " Press Esc to cancel everything now"])?.footer == false)
  }

  @Test func theQuestionLineIsCleanedForANotice() throws {
    let long = String(repeating: "x", count: 300)
    let p = try #require(PromptDetector.detect([rule, " \"Run\u{0007} it?\"  now?", " \u{276F} 1. A", "   2. B"]))
    #expect(p.question == "'Run it?' now?")
    let q = try #require(PromptDetector.detect([rule, " " + long, " \u{276F} 1. A", "   2. B"]))
    #expect(q.question != nil && (q.question ?? "").count <= 101)
    #expect(PromptDetector.detect(["", ""]) == nil)
    #expect(PromptDetector.detect([]) == nil)
  }
}

/// The wait: a prompt counts once its region has held still, and is one notice however long it stays.
@Suite("PromptWatch stillness")
struct PromptWatchTests {
  func prompt(_ name: String) throws -> PromptDetector.Prompt { try #require(PromptDetector.detect(try RealScreens.rows(name))) }

  @Test func announcesOnceAfterTheRegionHeldStill() throws {
    var w = PromptWatch()
    let p = try prompt("bash-permission")
    #expect(w.observe(p, at: 100) == .none)
    #expect(w.observe(p, at: 104.9) == .none)
    #expect(w.observe(p, at: 105) == .appeared(p))
    #expect(w.current == p)
    #expect(w.observe(p, at: 106) == .none, "one notice per prompt")
    #expect(w.observe(p, at: 600) == .none)
  }

  /// 07 vs 07b: a blinking dot far above the prompt. The detector's region ignores it, so the wait is not restarted.
  @Test func aBlinkAboveThePromptDoesNotResetTheWait() throws {
    var w = PromptWatch()
    let a = try prompt("bash-permission"), b = try prompt("bash-permission-6s")
    #expect(w.observe(a, at: 100) == .none)
    #expect(w.observe(b, at: 102) == .none)
    #expect(w.observe(a, at: 104) == .none)
    #expect(w.observe(b, at: 105) == .appeared(b))
  }

  /// A change inside the region (here the cursor moved: the owner is at the keys) restarts it.
  @Test func aChangeInsideThePromptRestartsTheWait() throws {
    var w = PromptWatch()
    let a = try prompt("bash-permission"), c = try prompt("bash-permission-cursor2")
    #expect(w.observe(a, at: 100) == .none)
    #expect(w.observe(c, at: 104) == .none)
    #expect(w.observe(c, at: 108) == .none, "4 s since the change")
    #expect(w.observe(c, at: 109) == .appeared(c))
  }

  /// After the notice the owner moves the cursor: the same prompt, no second notice.
  @Test func movingTheCursorAfterTheNoticeIsNotANewPrompt() throws {
    var w = PromptWatch()
    let a = try prompt("bash-permission"), c = try prompt("bash-permission-cursor2")
    _ = w.observe(a, at: 100)
    #expect(w.observe(a, at: 105) == .appeared(a))
    #expect(w.observe(c, at: 106) == .none)
    #expect(w.observe(c, at: 120) == .none)
    #expect(w.current != nil)
  }

  @Test func clearsOnlyWhenItStaysGoneAndThenANewOneIsNew() throws {
    var w = PromptWatch()
    let a = try prompt("bash-permission")
    _ = w.observe(a, at: 100)
    _ = w.observe(a, at: 105)
    #expect(w.observe(nil, at: 106) == .none, "a redraw for a moment is not the end")
    #expect(w.current != nil)
    #expect(w.observe(a, at: 106.5) == .none, "and it is back: still the one prompt")
    #expect(w.observe(nil, at: 110) == .none)
    #expect(w.observe(nil, at: 112) == .cleared)
    #expect(w.current == nil)
    #expect(w.observe(nil, at: 113) == .none)
    #expect(w.observe(a, at: 114) == .none)
    #expect(w.observe(a, at: 119) == .appeared(a), "a prompt that comes back later is a new one")
  }

  @Test func aDifferentPromptReplacingItIsAnnouncedAfterItsOwnWait() throws {
    var w = PromptWatch()
    let a = try prompt("bash-permission"), x = try prompt("write-permission")
    _ = w.observe(a, at: 100)
    _ = w.observe(a, at: 105)
    #expect(w.observe(x, at: 106) == .none)
    #expect(w.observe(x, at: 110) == .none)
    #expect(w.observe(x, at: 111) == .appeared(x))
  }

  @Test func aPromptThatNeverSettlesIsNeverAnnounced() throws {
    var w = PromptWatch()
    let a = try prompt("bash-permission"), c = try prompt("bash-permission-cursor2")
    for i in 0..<20 { #expect(w.observe(i % 2 == 0 ? a : c, at: 100 + Double(i)) == .none) }
  }
}

@Suite("Prompt notice wording")
struct PromptNoticeTests {
  func prompt(_ name: String) throws -> PromptDetector.Prompt { try #require(PromptDetector.detect(try RealScreens.rows(name))) }

  @Test func aWorkerNoticeNamesTheKindTheQuestionAndWhereToAnswer() throws {
    #expect(
      SupervisorNotice.workerPromptLine(threadName: "OC Test", prompt: try prompt("bash-permission"))
        == "OC Test's session is waiting on a 'Bash command' prompt, \"Do you want to proceed?\"; open Terminals \u{2192} OC Test on the Mac to answer.")
    #expect(
      SupervisorNotice.workerPromptLine(threadName: "OC Test", prompt: try prompt("write-permission"))
        == "OC Test's session is waiting on a 'file create' prompt, \"Do you want to create notes.txt?\"; open Terminals \u{2192} OC Test on the Mac to answer.")
    #expect(
      SupervisorNotice.workerPromptLine(threadName: "OC Test", prompt: try prompt("askuser-select"))
        == "OC Test's session is waiting on a 'question' prompt, \"Which color do you prefer?\"; open Terminals \u{2192} OC Test on the Mac to answer.")
  }

  @Test func aKindWeCannotNameIsJustAPrompt() throws {
    #expect(
      SupervisorNotice.workerPromptLine(threadName: "OC Test", prompt: try prompt("onboarding-theme"))
        == "OC Test's session is waiting on a prompt, \"Choose the text style that looks best with your terminal\"; open Terminals \u{2192} OC Test on the Mac to answer.")
    var bare = try prompt("onboarding-theme")
    bare.question = nil
    #expect(SupervisorNotice.workerPromptLine(threadName: "OC Test", prompt: bare) == "OC Test's session is waiting on a prompt; open Terminals \u{2192} OC Test on the Mac to answer.")
  }

  @Test func mainsNoticeNamesTheAgentAndTheTerminal() throws {
    #expect(
      SupervisorNotice.mainPromptLine(agentName: "Testagent", prompt: try prompt("bash-permission"))
        == "Testagent is waiting on a 'Bash command' prompt, \"Do you want to proceed?\"; open Terminal on the Mac to answer.")
    #expect(SupervisorNotice.mainPromptLine(agentName: nil, prompt: try prompt("askuser-select")).hasPrefix("The agent is waiting on a 'question' prompt"))
  }
}

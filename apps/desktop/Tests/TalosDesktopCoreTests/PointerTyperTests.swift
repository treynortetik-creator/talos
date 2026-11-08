import Foundation
import Testing
@testable import TalosDesktopCore

/// Real Claude Code screens (Tests/Fixtures/real-2.1.318, and real-2.1.319 where a test names it): byte-for-byte `tmux capture-pane -p -J` output, read the way
/// the supervisor reads a pane. A test that builds its own screen says SYNTHETIC.
enum RealScreens {
  static func rows(_ name: String, in fixtures: String = "real-2.1.318") throws -> [String] {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/" + fixtures)
    let text = try String(contentsOf: dir.appendingPathComponent(name + ".txt"), encoding: .utf8)
    return TmuxCommands.parseCapture(text)
  }
}

/// R1-5, R2-2, R2-3: the pointer is never typed onto the owner's draft, with or without a client attached, and the draft is found
/// in the real input box (`❯` + U+00A0 between two rule rows), not in a history line.
@Suite("PointerTyper draft guard")
struct PointerTyperDraftTests {
  @Test func theRealDraftIsFoundAndBlocksTheLineWithNoClientAttached() throws {
    let rows = try RealScreens.rows("draft-input")
    #expect(rows.contains { $0.contains("\u{276F}\u{00A0}hello draft") }, "control: the capture has the NBSP draft row")
    let draft = PointerTyper.draftPresent(rows: rows)
    #expect(draft)
    #expect(!PointerTyper.mayType(screen: .none, lastClientActivity: nil, now: 100, draftPresent: draft, boxVisible: true))
    #expect(PointerTyper.mayType(screen: .none, lastClientActivity: nil, now: 100, draftPresent: false, boxVisible: true))
  }

  /// The history line `❯ Talos: new message…` (ASCII space) is above the box. The first guard latched onto it.
  @Test func theRealEmptyBoxIsNotADraftDespiteAHistoryLine() throws {
    let rows = try RealScreens.rows("empty-input")
    #expect(rows.contains { $0.hasPrefix("\u{276F} Talos: new message") }, "control: a history line with an ASCII space is there")
    #expect(!PointerTyper.draftPresent(rows: rows))
  }

  @Test func aDraftIsADraftWhereverTheCursorIs() throws {
    // (R2-4) the old guard read "cursor at the start" as a placeholder: the answer no longer depends on the cursor at all
    #expect(PointerTyper.draftPresent(rows: try RealScreens.rows("draft-input")))
  }

  @Test func syntheticMultiLineDraftAndOtherShapes() {
    let rule = String(repeating: "\u{2500}", count: 60)
    // SYNTHETIC: a long draft wraps onto an indented row
    #expect(PointerTyper.draftPresent(rows: ["output", rule, "\u{276F}\u{00A0}first line", "  second line", rule, "  ? for shortcuts"]))
    // SYNTHETIC: the box is the LAST pair of rules with a cursor row; older rules above don't count
    #expect(!PointerTyper.draftPresent(rows: [rule, "\u{276F}\u{00A0}old", rule, "text", rule, "\u{276F}\u{00A0} ", rule]))
    // SYNTHETIC: no box on screen, and an option row, are not drafts
    #expect(!PointerTyper.draftPresent(rows: ["working..."]))
    #expect(!PointerTyper.draftPresent(rows: [" \u{276F} 1. Yes", "   2. No"]))
    #expect(!PointerTyper.draftPresent(rows: []))
  }
}

/// The pointer is typed only where Claude's input box is on the screen. `inputBox` is the one definition of "a box" (the last pair of rule
/// rows with `❯` first between them), shared by the draft checks and the typing guard.
@Suite("PointerTyper needs the input box")
struct PointerTyperInputBoxTests {
  /// The plain screens with a box, and the four colour captures (their escapes stripped the way the manager reads them).
  @Test(arguments: [
    "empty-input", "draft-input", "turn-done", "after-esc", "idle-input-auto", "idle-input-manual", "input-e-cleared",
    "input-e-draft-looks-like-placeholder", "input-e-idle-placeholder", "input-e-real-draft", "input-e-theme-auto-draft",
    "input-e-theme-auto-placeholder", "input-e-theme-dark-ansi-draft", "input-e-theme-dark-ansi-placeholder",
    "input-e-theme-dark-cb-draft", "input-e-theme-dark-cb-placeholder", "input-e-theme-light-ansi-draft",
    "input-e-theme-light-ansi-placeholder", "input-e-theme-light-cb-draft", "input-e-theme-light-cb-placeholder",
    "input-e-theme-light-draft", "input-e-theme-light-placeholder",
  ])
  func aRealInputBoxIsFound(name: String) throws {
    let rows = try RealScreens.rows(name).map { InputBoxAttributes.stripEscapes($0) }
    let box = try #require(PointerTyper.inputBox(rows: rows), "\(name)")
    #expect(rows[box.lowerBound].drop(while: { $0 == " " }).first == "\u{276F}")
    #expect(DialogMatcher.isFrameRule(rows[box.lowerBound - 1]) && DialogMatcher.isFrameRule(rows[box.upperBound]), "\(name): the rules around it")
  }

  /// Dialogs and prompts have a rule row and a `❯` row, but not a `❯` row between two rules.
  @Test(arguments: [
    "trust-dialog", "trust-dialog-tcap", "mcp-consent", "bypass-disclaimer", "bash-permission", "bash-permission-6s",
    "bash-permission-cursor2", "write-permission", "write-permission-6s", "askuser-select", "askuser-select-6s",
    "perm-askuserquestion", "perm-ask-rule-bypass", "perm-background-bash-ask", "perm-dangerous-rm-bypass", "perm-dangerous-rm-t0",
    "perm-hook-ask", "perm-subagent-ask", "onboarding-theme", "onboarding-security-notes",
  ])
  func aDialogOrPromptIsNotABox(name: String) throws {
    let rows = try RealScreens.rows(name).map { InputBoxAttributes.stripEscapes($0) }
    #expect(PointerTyper.inputBox(rows: rows) == nil, "\(name)")
  }

  @Test func syntheticBlankBannerOnlyAndMidDrawScreensAreNotABox() {
    let rule = String(repeating: "\u{2500}", count: 60)
    // SYNTHETIC: a blank pane, no rows at all, and a banner without a box
    #expect(PointerTyper.inputBox(rows: []) == nil)
    #expect(PointerTyper.inputBox(rows: Array(repeating: "", count: 40)) == nil)
    #expect(PointerTyper.inputBox(rows: [" \u{2590}\u{259B}\u{2588}\u{2588}\u{2588}\u{259B}\u{2588}   Claude Code v2.1.318", "  /tmp/proj", ""]) == nil)
    // SYNTHETIC: a dialog caught mid-draw, so far a rule row and a title; the top rule of a box with nothing under it yet
    #expect(PointerTyper.inputBox(rows: [rule, " Accessing workspace:"]) == nil)
    #expect(PointerTyper.inputBox(rows: [rule]) == nil)
    #expect(PointerTyper.inputBox(rows: [rule, "\u{276F}\u{00A0}"]) == nil)
    // SYNTHETIC: two rules with no `❯` row between them, and with the rules touching
    #expect(PointerTyper.inputBox(rows: [rule, "some text", rule, "  footer"]) == nil)
    #expect(PointerTyper.inputBox(rows: [rule, rule, "\u{276F}\u{00A0}"]) == nil)
  }

  @Test func theBoxIsTheLastPairAndItsRowsAreTheInput() {
    let rule = String(repeating: "\u{2500}", count: 40)
    let rows = ["out", rule, "\u{276F}\u{00A0}old", rule, "text", rule, "\u{276F}\u{00A0}first", "  second", rule, "  ? for shortcuts"]
    #expect(PointerTyper.inputBox(rows: rows) == 6..<8)
  }

  @Test func mayTypeNeedsTheBoxOnTopOfEverythingElse() {
    #expect(PointerTyper.mayType(screen: .none, lastClientActivity: nil, now: 100, draftPresent: false, boxVisible: true))
    #expect(!PointerTyper.mayType(screen: .none, lastClientActivity: nil, now: 100, draftPresent: false, boxVisible: false))
    #expect(!PointerTyper.mayType(screen: .none, lastClientActivity: 80, now: 100, draftPresent: false, boxVisible: false))
  }

  @Test func theNoBoxNoticeIsOneLineWithTheArrowAndTheThreadName() {
    #expect(
      WorkerNotice.noBoxLine(threadName: "trip")
        == "trip's session isn't showing its input box yet. Open Terminals \u{2192} trip to see what it's waiting on.")
    #expect(WorkerNotice.noBoxLine(threadName: "").hasPrefix("A thread's session"))
  }
}

/// R1-3, R2-1: a dialog on a worker is a whole dialog at the bottom of the screen, not words in output. The real trust dialog has
/// no numbered options.
@Suite("Live dialog is the whole dialog")
struct LiveDialogTests {
  let rule = String(repeating: "\u{2500}", count: 40)

  @Test func theRealTrustDialogFlagsAndHasNoNumberedOptions() throws {
    let rows = try RealScreens.rows("trust-dialog")
    #expect(!rows.contains { $0.contains("1.") && $0.contains("Yes") }, "control: the real dialog is not numbered")
    #expect(rows.contains { $0.contains("\u{276F} No, exit") })
    #expect(DialogMatcher.liveDialog(rows) == .trust)
    // the screen-wide check by words alone, still used at the pointer, misses it: this is why the structure check exists
    #expect(DialogMatcher.workerScreen(rows) == .none)
  }

  @Test func theRealIdleScreensAreNotDialogs() throws {
    #expect(DialogMatcher.liveDialog(try RealScreens.rows("empty-input")) == .none)
    #expect(DialogMatcher.liveDialog(try RealScreens.rows("draft-input")) == .none)
  }

  @Test func theRealTrustDialogWithOutputScrolledBelowItIsNotWaiting() throws {
    let rows = try RealScreens.rows("trust-dialog") + (0..<30).map { " later output line \($0)" }
    #expect(DialogMatcher.liveDialog(rows) == .none)
  }

  @Test func theRealTrustDialogQuotedAboveAWorkersOwnMenuIsNotADialog() throws {
    // the real dialog's text printed as output, then the worker's own question menu (SYNTHETIC menu)
    let quoted = try RealScreens.rows("trust-dialog").filter { !DialogMatcher.isFrameRule($0) }
    let rows = quoted + [rule, "  Which way?", "", "  \u{276F} Alpha", "    Beta", "", "  Enter to select \u{00B7} Esc to cancel"]
    #expect(DialogMatcher.liveDialog(rows) == .none)
  }

  /// Real MCP consent: three UNNUMBERED options, and the cursor starts on the LAST one ("Continue without"), not the first.
  @Test func theRealMcpConsentFlagsAndIdleScreensDoNot() throws {
    let rows = try RealScreens.rows("mcp-consent")
    #expect(rows.contains { $0.contains("\u{276F} Continue without using this MCP server") }, "control: the cursor is on the last row")
    #expect(!rows.contains { $0.contains("1.") }, "control: not numbered")
    #expect(DialogMatcher.liveDialog(rows) == .mcpConsent)
    #expect(DialogMatcher.liveDialog(try RealScreens.rows("empty-input")) == .none)
  }

  @Test func theRealBypassDisclaimerFlagsAndIdleScreensDoNot() throws {
    let rows = try RealScreens.rows("bypass-disclaimer")
    #expect(rows.contains { $0.contains("\u{276F} No, exit") })
    #expect(DialogMatcher.liveDialog(rows) == .bypassDisclaimer)
    #expect(DialogMatcher.liveDialog(try RealScreens.rows("draft-input")) == .none)
  }

  /// Real "not logged in": no Select at all. The idle input box stays and the footer reads `Not logged in · Run /login`.
  @Test func theRealNotLoggedInScreenFlagsAndAnIdleLoggedInScreenDoesNot() throws {
    let rows = try RealScreens.rows("login-not-logged-in")
    #expect(rows.contains { $0.contains("Not logged in \u{00B7} Run /login") })
    #expect(DialogMatcher.workerScreen(rows) == .loginExpired)
    // the supervisor tells the owner from liveDialog; it used to read this real screen as nothing
    #expect(DialogMatcher.liveDialog(rows) == .loginExpired)
    #expect(DialogMatcher.workerScreen(try RealScreens.rows("empty-input")) == .none)
    #expect(DialogMatcher.workerScreen(try RealScreens.rows("draft-input")) == .none)
    #expect(DialogMatcher.liveDialog(try RealScreens.rows("empty-input")) == .none)
  }

  /// The login status is the footer row only. The same words quoted in output above the input box, or in a footer row that does not
  /// end with the status, are not it (SYNTHETIC).
  @Test func syntheticQuotedNotLoggedInAboveTheInputBoxIsNotTheFooter() throws {
    var rows = try RealScreens.rows("empty-input")
    rows.insert("  The footer once said: Not logged in \u{00B7} Run /login", at: 2)
    #expect(DialogMatcher.liveDialog(rows) == .none)
    // a row that merely contains the words, with no status at its end, is not the footer
    var noStatus = try RealScreens.rows("login-not-logged-in")
    noStatus = noStatus.map { $0.replacingOccurrences(of: "Not logged in \u{00B7} Run /login", with: "Not logged in \u{00B7} Run /login now") }
    #expect(DialogMatcher.liveDialog(noStatus) == .none)
  }

  @Test func theRealDialogsAreEachTheirOwnKindOnTheWorkerPath() throws {
    // unnumbered Selects: the words-only worker check does not see them (the supervisor uses liveDialog, as for trust)
    #expect(DialogMatcher.workerScreen(try RealScreens.rows("mcp-consent")) == .none)
    #expect(DialogMatcher.workerScreen(try RealScreens.rows("bypass-disclaimer")) == .none)
    #expect(DialogMatcher.liveDialog(try RealScreens.rows("trust-dialog")) != DialogMatcher.liveDialog(try RealScreens.rows("mcp-consent")))
  }

  // SYNTHETIC cases below: no real capture exists for these dialogs, or they are the reviewer's quote cases.

  @Test func syntheticLoginMcpAndBypassDialogsFlag() {
    let login = ["", " \(rule)", " Not logged in \u{00B7} Please run /login", "", " \u{276F} 1. Claude account with subscription", "   2. Anthropic Console account", "", " Enter to confirm"]
    #expect(DialogMatcher.liveDialog(login) == .loginExpired)
    let mcp = ["", " \(rule)", " New MCP server found in this project: docs", "", " \u{276F} Use this and all future MCP servers", "   Use this MCP server", "   Continue without using this MCP server", "", " Enter to confirm \u{00B7} Esc to cancel"]
    #expect(DialogMatcher.liveDialog(mcp) == .mcpConsent)
    let bypass = ["", " \(rule)", " WARNING: Claude Code running in Bypass Permissions mode", "", " \u{276F} No, exit", "   Yes, I accept", "", " Enter to confirm \u{00B7} Esc to cancel"]
    #expect(DialogMatcher.liveDialog(bypass) == .bypassDisclaimer)
  }

  @Test func syntheticToolOutputAndProseSayingNotLoggedInAreNotDialogs() {
    let a = ["", " \u{25CF} Bash(vercel whoami)", "   \u{23BF}  Not logged in. Run vercel login.", "", " \(rule)", "\u{276F}\u{00A0} ", " \(rule)", "   ? for shortcuts"]
    #expect(DialogMatcher.liveDialog(a) == .none)
    let b = ["", " \u{25CF} gh auth status said:", "   Not logged in to any GitHub hosts", "   Run gh auth login to authenticate.", "", " \(rule)", "\u{276F}\u{00A0} ", " \(rule)"]
    #expect(DialogMatcher.liveDialog(b) == .none)
  }

  @Test func syntheticSourceTextAboveTheWorkersOwnMenuAndAUserOptionLineAreNotDialogs() {
    let rows = [" public static let trust = [\"Yes, I trust this folder\", \"Yes, I trust these settings\"]",
                " public static let login = [\"Please run /login\", \"Not logged in\"]", "",
                " \(rule)", "  Which way?", "", "  \u{276F} 1. Alpha", "    2. Beta", "", "  Enter to select"]
    #expect(DialogMatcher.liveDialog(rows) == .none)
    #expect(DialogMatcher.liveDialog([" \u{276F} 1. ship it please", "", " \u{25CF} On it.", "", " \(rule)", "\u{276F}\u{00A0} ", " \(rule)"]) == .none)
    #expect(DialogMatcher.liveDialog([" \u{276F} 1. Yes, I trust this folder", "   2. No"]) == .none, "no frame, no dialog")
  }
}

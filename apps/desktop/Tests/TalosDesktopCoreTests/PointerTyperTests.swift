import Foundation
import Testing
@testable import TalosDesktopCore

/// Real Claude Code 2.1.318 screens (Tests/Fixtures/real-2.1.318): byte-for-byte `tmux capture-pane -p -J` output, read the way
/// the supervisor reads a pane. A test that builds its own screen says SYNTHETIC.
enum RealScreens {
  static func rows(_ name: String) throws -> [String] {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/real-2.1.318")
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
    #expect(!PointerTyper.mayType(screen: .none, lastClientActivity: nil, now: 100, draftPresent: draft))
    #expect(PointerTyper.mayType(screen: .none, lastClientActivity: nil, now: 100, draftPresent: false))
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

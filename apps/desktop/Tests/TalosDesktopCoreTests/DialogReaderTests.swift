import Foundation
import Testing
@testable import TalosDesktopCore

/// Needs-you prompts: `DialogReader` reads the three known dialogs off a worker's pane (trust, MCP consent, login) and refuses
/// anything it can't read exactly. Every positive and negative below is a REAL capture (Fixtures/real-2.1.318 and
/// real-2.1.319/needs-you-capture) unless the test says SYNTHETIC, in which case it changes rows of a real one.
enum NeedsYouScreens {
  static let cap = "real-2.1.319/needs-you-capture"
  static let trustOptions = ["No, exit", "Yes, I trust this folder"]
  static let mcpOptions = ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"]

  static func rows(_ name: String, in dir: String = cap) throws -> [String] { try RealScreens.rows(name, in: dir) }
  static func escaped(_ name: String, in dir: String = cap) throws -> [String] { try RealScreens.rows(name + ".ansi", in: dir) }

  /// The folder path row of a trust capture, as the dialog draws it (an independent read of the same file).
  static func pathRow(_ rows: [String]) -> String? {
    rows.first { $0.hasPrefix(" /") }?.trimmingCharacters(in: .whitespaces)
  }

  /// SYNTHETIC: a real screen with one row replaced.
  static func replacing(_ rows: [String], where match: (String) -> Bool, with new: [String]) -> [String] {
    var out: [String] = []
    for r in rows { out += match(r) ? new : [r] }
    return out
  }
}

@Suite("DialogReader reads the known dialogs")
struct DialogReaderTests {
  typealias S = NeedsYouScreens

  // MARK: trust

  @Test(arguments: [
    ("01-trust-first", 0), ("02-trust-down", 1), ("03-trust-down2", 0), ("04-trust-up", 1), ("05-trust-first", 0),
    ("06-trust-after-2", 0), ("07-trust-after-2-later", 0), ("08-trust-first", 0), ("09-trust-on-yes", 1), ("12-trust-first", 0),
  ])
  func everyRealTrustCaptureOf2_1_319IsReadWithItsCursor(name: String, cursor: Int) throws {
    let rows = try S.rows(name)
    let d = try #require(DialogReader.read(rows: rows, escapedRows: try S.escaped(name)), "\(name)")
    #expect(d.kind == .trust)
    #expect(d.options == S.trustOptions)
    #expect(d.cursor == cursor)
    #expect(d.subject == S.pathRow(rows))
    #expect(d.subject?.hasPrefix("/private/tmp/tcap-ny-proj.") == true)
    // the same without the colours
    #expect(DialogReader.read(rows: rows) == d)
  }

  @Test(arguments: [("trust-dialog", "/private/tmp/tsw/cap/proj"), ("trust-dialog-tcap", "/private/tmp/tcap/proj")])
  func theRealTrustCapturesOf2_1_318AreRead(name: String, path: String) throws {
    let d = try #require(DialogReader.read(rows: try RealScreens.rows(name)))
    #expect(d == DialogReader.Dialog(kind: .trust, subject: path, options: S.trustOptions, cursor: 0))
  }

  // MARK: MCP consent

  @Test(arguments: [
    ("20-mcp-first", 2), ("21-mcp-up", 1), ("22-mcp-up2", 0), ("23-mcp-down", 1), ("24-mcp-to-top", 1), ("27-mcp-first", 2),
    ("28-mcp-after-1", 2), ("29-mcp-after-1-later", 2),
  ])
  func everyRealMcpCaptureOf2_1_319IsReadWithItsCursor(name: String, cursor: Int) throws {
    let d = try #require(DialogReader.read(rows: try S.rows(name), escapedRows: try S.escaped(name)), "\(name)")
    #expect(d == DialogReader.Dialog(kind: .mcpConsent, subject: "harmless", options: S.mcpOptions, cursor: cursor))
  }

  @Test func theRealMcpCaptureOf2_1_318IsRead() throws {
    let d = try #require(DialogReader.read(rows: try RealScreens.rows("mcp-consent")))
    #expect(d == DialogReader.Dialog(kind: .mcpConsent, subject: "harmless", options: S.mcpOptions, cursor: 2))
  }

  // MARK: login (kind only)

  @Test(arguments: [("login-not-logged-in", "real-2.1.318"), ("10-trust-after-enter", S.cap), ("11-trust-after-enter-later", S.cap), ("25-mcp-after-enter", S.cap), ("26-mcp-after-enter-later", S.cap)])
  func theRealNotLoggedInScreensReadAsLoginWithNoKeys(name: String, dir: String) throws {
    // the 2.1.318 captures are plain text only; the 2.1.319 ones have their colours too
    let d = try #require(DialogReader.read(rows: try S.rows(name, in: dir), escapedRows: dir == S.cap ? try S.escaped(name, in: dir) : nil), "\(name)")
    #expect(d == DialogReader.Dialog(kind: .login, subject: nil, options: [], cursor: nil))
  }

  // MARK: refusals

  @Test func theBypassDisclaimerIsNeverRead() throws {
    let rows = try RealScreens.rows("bypass-disclaimer")
    #expect(DialogMatcher.liveDialog(rows) == .bypassDisclaimer, "control: it is a known dialog")
    #expect(DialogReader.read(rows: rows) == nil)
  }

  @Test func screensThatAreNotTheseDialogsAreNeverRead() throws {
    let positives: Set<String> = ["trust-dialog", "trust-dialog-tcap", "mcp-consent", "login-not-logged-in"]
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/real-2.1.318")
    let names = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".txt") }.map { String($0.dropLast(4)) }
    #expect(names.count > 30, "control: the captures were found")
    for name in names where !positives.contains(name) {
      #expect(DialogReader.read(rows: try RealScreens.rows(name)) == nil, "\(name)")
    }
    // after the dialog is answered "No, exit" Claude is gone: an empty pane
    for name in ["13-trust-after-no", "14-trust-after-no-later"] { #expect(DialogReader.read(rows: try S.rows(name)) == nil, "\(name)") }
  }

  @Test func theInputBoxAndUnknownSelectsAreNeverRead() throws {
    for name in ["empty-input", "draft-input", "idle-input-auto", "bash-permission", "write-permission", "askuser-select", "perm-askuserquestion"] {
      #expect(DialogReader.read(rows: try RealScreens.rows(name)) == nil, "\(name)")
    }
    #expect(DialogReader.read(rows: []) == nil)
  }

  /// SYNTHETIC: the trust path wrapped over two rows can't be rejoined exactly, so the dialog is still read but has no subject.
  @Test func aWrappedPathIsNoSubjectAndNeverAPartialOne() throws {
    let rows = try S.rows("01-trust-first")
    let path = try #require(S.pathRow(rows))
    let wrapped = S.replacing(rows, where: { $0.hasPrefix(" /private/tmp/tcap") }, with: [" " + path.prefix(12), " " + path.dropFirst(12)])
    let d = try #require(DialogReader.read(rows: wrapped))
    #expect(d.subject == nil)
    #expect(d.options == S.trustOptions && d.cursor == 0)
  }

  @Test func aPathCutWithAnEllipsisIsNoSubject() throws {
    let rows = try S.rows("01-trust-first")
    let cut = S.replacing(rows, where: { $0.hasPrefix(" /private/tmp/tcap") }, with: [" /private/tmp/tcap-ny-pr…"])
    #expect(try #require(DialogReader.read(rows: cut)).subject == nil)
  }

  /// SYNTHETIC: a long server name wraps onto the next row: no subject, never the first half.
  @Test func aWrappedMcpServerNameIsNoSubject() throws {
    let rows = try S.rows("20-mcp-first")
    let wrapped = S.replacing(rows, where: { $0.contains("New MCP server found") }, with: ["  New MCP server found in this project: a-very-long-na", "  me-that-wrapped"])
    let d = try #require(DialogReader.read(rows: wrapped))
    #expect(d.subject == nil)
    #expect(d.options == S.mcpOptions && d.cursor == 2)
  }

  /// SYNTHETIC: the plural dialog (several servers, checkboxes) has never been captured.
  @Test func theSeveralServersDialogIsNotRead() throws {
    let rows = try S.rows("20-mcp-first")
    let plural = S.replacing(rows, where: { $0.contains("New MCP server found") }, with: ["  3 new MCP servers found in this project"])
    #expect(DialogMatcher.liveDialog(plural) == .mcpConsent, "control: it still counts as the MCP dialog")
    #expect(DialogReader.read(rows: plural) == nil)
  }

  /// SYNTHETIC: a row touching the options that is not one of them (a wrapped label, an inserted line) is a select we can't read.
  @Test func aRowThatIsNotAnAlignedOptionBesideTheOptionsRefuses() throws {
    let rows = try S.rows("20-mcp-first")
    let odd = S.replacing(rows, where: { $0 == "    Use this MCP server" }, with: ["    Use this MCP server", "  continued here"])
    #expect(DialogReader.read(rows: odd) == nil)
    let above = S.replacing(rows, where: { $0 == "    Use this MCP server" }, with: ["  a note", "    Use this MCP server"])
    #expect(DialogReader.read(rows: above) == nil)
  }

  @Test func twoOptionsWithTheSameLabelRefuse() throws {
    let rows = try S.rows("01-trust-first")
    let dup = S.replacing(rows, where: { $0 == "   Yes, I trust this folder" }, with: ["   No, exit"])
    #expect(DialogReader.read(rows: dup) == nil)
  }

  @Test func aScreenWithAnythingAfterTheFooterRefuses() throws {
    var rows = try S.rows("01-trust-first")
    rows.append(" and then more text")
    #expect(DialogReader.read(rows: rows) == nil)
  }

  // MARK: the colours

  @Test func colourRowsFromAnotherFrameRefuse() throws {
    // plain: the cursor on "No, exit"; colours: the cursor on "Yes"
    #expect(DialogReader.read(rows: try S.rows("01-trust-first"), escapedRows: try S.escaped("02-trust-down")) == nil)
    #expect(DialogReader.read(rows: try S.rows("01-trust-first"), escapedRows: []) == nil)
  }

  /// SYNTHETIC: the highlighted row must be the coloured one, and no other row may be.
  @Test func theCursorRowMustBeTheColouredOneAndTheOthersPlain() throws {
    let rows = try S.rows("01-trust-first")
    let esc = try S.escaped("01-trust-first")
    #expect(DialogReader.read(rows: rows, escapedRows: esc) != nil, "control")
    let uncoloured = esc.map { $0.replacingOccurrences(of: "\u{1B}[38;5;153m", with: "") }
    #expect(DialogReader.read(rows: rows, escapedRows: uncoloured) == nil, "no colour on the cursor row")
    let both = esc.map { $0.replacingOccurrences(of: "   Yes, I trust this folder", with: "   \u{1B}[38;5;153mYes, I trust this folder") }
    #expect(DialogReader.read(rows: rows, escapedRows: both) == nil, "a second coloured row")
    let dim = esc.map { $0.replacingOccurrences(of: "   Yes, I trust this folder", with: "   \u{1B}[2mYes, I trust this folder") }
    #expect(DialogReader.read(rows: rows, escapedRows: dim) == nil, "a dim option")
  }

  // MARK: a wrapped option

  /// SYNTHETIC: an option label that wraps onto an aligned continuation row reads as two options if it is read at all. The long first row
  /// is what gives it away, so the dialog is refused.
  @Test func aLabelWrappedOverTwoRowsRefusesTheDialog() throws {
    let rows = try S.rows("20-mcp-first")
    let long = "    Use this and all future MCP servers in this project and every other project on this computer too"
    let wrapped = S.replacing(rows, where: { $0.contains("Use this and all future") }, with: [long, "    as well"])
    #expect(DialogMatcher.liveDialog(wrapped) == .mcpConsent, "control: it still counts as the MCP dialog")
    #expect(DialogReader.read(rows: wrapped) == nil)
    let oneRow = S.replacing(rows, where: { $0.contains("Use this and all future") }, with: [long])
    #expect(DialogReader.read(rows: oneRow) == nil, "a label that long is not one of the dialogs captured")
  }

  @Test func theLongestRealOptionIsStillRead() throws {
    let d = try #require(DialogReader.read(rows: try S.rows("20-mcp-first")))
    #expect(d.options.map(\.count).max() == 51, "control: the longest real label is 51 characters")
  }

  // MARK: character for character

  @Test func textIsComparedByUnicodeScalarsNotCanonicalEquivalence() {
    let composed = "caf\u{E9}", decomposed = "cafe\u{301}"
    #expect(composed == decomposed, "control: Swift's == treats these as the same")
    #expect(!ExactText.equal(composed, decomposed))
    #expect(ExactText.equal(composed, "caf\u{E9}"))
    #expect(!ExactText.equal([composed], [decomposed]) && ExactText.equal([composed, "x"], [composed, "x"]))
    #expect(!ExactText.equal(Optional(composed), Optional(decomposed)) && ExactText.equal(String?.none, String?.none) && !ExactText.equal(Optional("a"), nil))
  }
}

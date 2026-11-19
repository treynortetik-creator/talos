import Foundation
import Testing
@testable import TalosDesktopCore

/// The key guard (`KeyGuard`): an allowlist by what the sender means to press, decided from the live region only, and no key to the
/// usage-limit menu or to any select Talos cannot name. Checked against the table the Linux supervisor's guard is checked against
/// (Fixtures/key-guard-vectors.json, read by apps/bridge/test/supervisor/usage-limit.test.ts too), so the two sides allow the same keys.
@Suite("The key guard")
struct KeyGuardTests {
  static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

  struct Vectors: Decodable {
    struct Reading: Decodable, Equatable {
      var model: String?
      var resets: String?
    }
    var captures: [String: [String]]
    var usage_limit: [String: Reading]
    var not_usage_limit: [String]
    struct StatusRows: Decodable {
      struct Vector: Decodable {
        var name: String
        var rows: [String]
        var box_empty: Bool
      }
      var vectors: [Vector]
    }
    var status_row_vectors: StatusRows
    struct Probes: Decodable {
      struct Probe: Decodable {
        var name: String
        var rows: [String]
        var box_empty: Bool
      }
      var probes: [Probe]
    }
    var status_row_probes: Probes
  }

  static func vectors() throws -> Vectors {
    try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: fixtures.appendingPathComponent("key-guard-vectors.json")))
  }

  /// Every intent a Mac sender may state, by the table's names.
  static let intents: [(String, KeyGuard.Intent)] =
    [("box-empty", .box(.empty)), ("box-ours", .box(.ours))] + KeyGuard.DialogKind.allCases.map { ($0.rawValue, .dialog($0)) }

  /// A capture's rows, coloured when its .ansi.txt exists (the live guard always has colours).
  static func capture(_ rel: String) throws -> [String] {
    let ansi = fixtures.appendingPathComponent(rel.replacingOccurrences(of: ".txt", with: ".ansi.txt"))
    let url = rel.hasSuffix(".txt") && FileManager.default.fileExists(atPath: ansi.path) ? ansi : fixtures.appendingPathComponent(rel)
    return TmuxCommands.parseCapture(try String(contentsOf: url, encoding: .utf8))
  }

  static func synthetic(_ name: String) throws -> [String] { try RealScreens.rows(name, in: "synthetic") }

  static func allowed(_ rows: [String]) -> [String] { intents.filter { KeyGuard.allows(rows, intent: $0.1) }.map(\.0) }

  static let rule = String(repeating: "─", count: 60)
  static let box = [rule, "❯ ", rule]

  /// A capture whose intents the Mac reads differently from the shared table while a change waits for the table's owner (who agrees it
  /// with the Linux side). Empty: the table holds every change. Remove an entry once the shared table says the same.
  static let pendingTableChanges: [String: [String]] = [:]

  @Test func everyRealCaptureAllowsExactlyWhatTheSharedTableSays() throws {
    let v = try Self.vectors()
    var seen: [String] = []
    for dir in try FileManager.default.contentsOfDirectory(atPath: Self.fixtures.path) where dir.hasPrefix("real") {
      let root = Self.fixtures.appendingPathComponent(dir)
      let walk = FileManager.default.enumerator(atPath: root.path)
      while let f = walk?.nextObject() as? String {
        if f.hasSuffix(".txt"), !f.hasSuffix(".ansi.txt") { seen.append(dir + "/" + f) }
      }
    }
    #expect(seen.sorted() == v.captures.keys.sorted(), "a capture missing from the table, or one the table names that is gone")
    let mine = Set(Self.intents.map(\.0))
    for rel in seen.sorted() {
      let listed = Self.pendingTableChanges[rel] ?? v.captures[rel] ?? []
      let want = Self.intents.map(\.0).filter { listed.contains($0) && mine.contains($0) }
      #expect(Self.allowed(try Self.capture(rel)) == want, "\(rel)")
    }
  }

  @Test func everyUsageLimitScreenIsReadAsTheSharedTableSaysAndGetsNoKey() throws {
    let v = try Self.vectors()
    #expect(v.usage_limit.count == 12)
    for (name, want) in v.usage_limit {
      let rows = try Self.synthetic(name)
      let info = try #require(UsageLimitScreen.read(rows), "\(name)")
      #expect(Vectors.Reading(model: info.model, resets: info.resets) == want, "\(name)")
      #expect(Self.allowed(rows).isEmpty, "\(name): \(Self.allowed(rows))")
      #expect(KeyGuard.refusal(rows, intent: .dialog(.trust))?.why == "usage_limit")
    }
    for name in v.not_usage_limit { #expect(UsageLimitScreen.read(try Self.synthetic(name)) == nil, "\(name)") }
    // the quoted menu ends in Claude's live input box, empty: typing goes there, the menu above is the conversation's
    #expect(Self.allowed(try Self.synthetic("usage-limit-quoted")) == ["box-empty"])
  }

  @Test func noIntentOrAnUnreadablePaneGetsNoKey() throws {
    let empty = try Self.capture("real-2.1.318/empty-input.txt")
    #expect(KeyGuard.allows(empty, intent: .box(.empty)), "control: the empty box takes the line")
    #expect(KeyGuard.refusal(empty, intent: nil)?.why == "no_intent")
    for (n, i) in Self.intents { #expect(KeyGuard.refusal(nil, intent: i)?.why == "unreadable", "\(n)") }
  }

  /// An unknown select gets nothing from any sender, whatever its shape, under the box or in place of it (strict: only Claude Code's own
  /// status rows, and Talos's own thread status line, may sit under the box).
  @Test func anUnknownSelectOfAnyShapeGetsNoKeyFromAnyIntent() {
    let under = [
      ["  → Buy $50 of credits", "    Cancel"], ["  * Buy", "  - Cancel"], ["  [x] Buy", "  [ ] Cancel"], ["  (•) Buy", "  ( ) Cancel"],
      ["  a) Buy", "  b) Cancel"], ["  Buy $50 of credits", "  Cancel"], ["  100. Buy", "  101. Cancel"], ["  1. Buy", "  2. Cancel"],
      ["  Press Enter to purchase"], ["  ❯ Buy", "    Cancel"], ["  ☐ Buy", "  ☑ Cancel"], ["  ⏺ Buy", "  ⏺ Cancel"], ["  ◯ Buy", "  ◯ Cancel"],
    ]
    for u in under { #expect(Self.allowed(["⏺ Done."] + Self.box + u).isEmpty, "\(u[0])") }
    // a menu drawn between two rules: its first row is not an empty prompt row
    #expect(Self.allowed(["⏺ Done.", Self.rule, "❯ Buy $50 of credits", "  Cancel", Self.rule]).isEmpty)
    // a numbered select of its own, nothing Talos names
    #expect(Self.allowed(["⏺ Done.", Self.rule, " Pick a plan", " ❯ 1. Buy $50 of credits", "   2. Cancel", " Enter to confirm · Esc to cancel"]).isEmpty)
    // the empty box with Claude Code's own status rows under it: typed into
    #expect(Self.allowed(["⏺ Done."] + Self.box + ["  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"]) == ["box-empty"])
    #expect(Self.allowed(["⏺ Done."] + Self.box + [Self.rule, "  ⏸ manual mode on · ? for shortcuts"]).isEmpty, "a second rule under the box")
  }

  /// Thread sessions draw Talos's own status line (WorkerSpec sets it: WorkerUsage), "Talos", then ": <model>" (8 at most), then " | 7d:
  /// N%", and that one row may sit under the box; a user's own status line of any other shape, even a plain one, still refuses.
  @Test func talossOwnThreadStatusLinePassesAndAUsersOwnStillRefuses() {
    let empty = KeyGuard.Intent.box(.empty)
    let base = ["⏺ Done."] + Self.box
    let ours = ["  Talos: Sonnet 5 | 7d: 38%", "  Talos: Opus 5.5", "  Talos", "  Talos: Sonnet 4 | 7d: 100%", "  Talos: 4o-mini | 7d: 100%", "  Talos: 4o-mini | 7d: 0%"]
    for o in ours {
      #expect(KeyGuard.allows(base + [o], intent: empty), "\(o)")
      #expect(KeyGuard.allows(base + [o, "  ⏸ manual mode on · ? for shortcuts"], intent: empty), "\(o)")
    }
    let refused: [[String]] = [
      ["  Talos: Sonnet 5 | 7d: 38%", "  Talos: Sonnet 5 | 7d: 38%"],  // two Talos rows
      ["  Talos: Opus | 7d: 3%", "  Talos"],
      ["  Talos | 7d: 3%"], ["  Talos | 7d: 100%"],  // a percentage needs a model (and the old row never starts with "Talos")
      ["  Talos: "], ["  Talos: | 7d: 3%"],  // an empty model
      ["  1. Talos: Sonnet 5 | 7d: 38%"],  // a leading "1. "
      ["  Talos: Sonnet 5 | 7d: 101%"], ["  Talos: Sonnet 5 | 7d: 1000%"], ["  Talos: Sonnet 5 | 7d: 05%"],
      ["  Talos: " + String(repeating: "a", count: 9)], ["  Talos: Sonnet 4.5 | 7d: 1%"],  // a model over 8 (the recorder cuts at 8)
      ["  Talos: Opus 5.5 (1M context)"],
      ["  Sonnet 5.5"],  // no prefix and no percentage (the old recorder row with one: oldRecorderRow...RemoveAfterTheNext)
      ["  Sonnet 5.5 | 20% | 7d: 38%"], ["  ~/proj  main ✓  Fable 5.2  42% ctx"], ["  Talos: ❯ Buy"], ["  Talos: Sonnet | 7d: 38% | more"],
    ]
    for u in refused {
      #expect(KeyGuard.refusal(base + u, intent: empty)?.why == "row_under_box", "\(u)")
    }
    // the recorder keeps a model from its first letter or digit, so "1. Buy" is a model it may print; the prefix keeps it from leading
    #expect(KeyGuard.allows(base + ["  Talos: 1. Buy"], intent: empty))
    #expect(KeyGuard.allows(base + ["  Talos: " + String(repeating: "a", count: 8)], intent: empty), "8 is the most")
    // a dialog key never goes on the strength of Talos's own row
    for k in KeyGuard.DialogKind.allCases { #expect(!KeyGuard.allows(base + ["  Talos: Sonnet 5 | 7d: 38%"], intent: .dialog(k)), "\(k)") }
  }

  /// Talos's row is read as box-frame.ts reads it: on the row's FIRST part (split on runs of two or more spaces and on " · "), with only
  /// Claude Code's own parts after it, as a wide pane draws it (real-2.1.323-statusline/thread: the row, then "Not logged in · Run
  /// /login" far to the right). The patterns take ASCII digits only and end at the end of the text (`\z`, never `$`).
  @Test func talosRowIsReadOnItsFirstPartWithClaudesPartsAfterItAsLinuxReadsIt() throws {
    let empty = KeyGuard.Intent.box(.empty)
    let base = ["⏺ Done."] + Self.box
    let pad = String(repeating: " ", count: 40)
    let allowed = [
      "  Talos: Opus 5.5" + pad + "Not logged in · Run /login", "  Talos" + pad + "Not logged in",
      "  Talos: Opus | 7d: 3%  ◐ medium · /effort", "  Opus 5.5 | 7d: 42%" + pad + "Not logged in · Run /login",
    ]
    for a in allowed {
      #expect(BoxFrame.isTalosStatusLine(a), "\(a)")
      #expect(!BoxFrame.statusRow(a), "\(a): Talos's row, not Claude Code's")
      #expect(KeyGuard.allows(base + [a], intent: empty), "\(a)")
      #expect(KeyGuard.allows(base + [a, "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"], intent: empty), "\(a)")
    }
    let refused: [[String]] = [
      ["  Talos: Opus 5.5" + pad + "a user status line too long to pass"],  // longer than an unknown part may be
      ["  Not logged in" + pad + "Talos: Opus 5.5"],  // Talos's row is the first part or nothing
      ["  Talos: Opus  ❯ 1. Yes"], ["  Talos: Opus · Allow"],  // a select's marks after it
      ["  Talos: Opus  Talos: Opus"], ["  Talos: Opus · Talos"],  // two on one row: an unknown part never starts with the word Talos
      ["  ⏸ manual mode on · Talos: Opus"], ["  ⏸ manual mode on · Talos"], ["  ⏸ manual mode on · Talosx"],
      ["  Talos: Opus 5.5" + pad + "USER-STATUS-LINE"],  // upper case is no unknown part's shape
      ["  Talos: Opus 5.5" + pad + "Not logged in", "  Talos"],  // and still one row in all
      ["  Talos: Opus | 7d: \u{0663}%"], ["  Opus | 7d: \u{0663}\u{0660}%"],  // Arabic-Indic digits
      ["  Talos: Opus | 7d: \u{FF13}%"],  // a full-width digit
    ]
    for u in refused { #expect(KeyGuard.refusal(base + u, intent: empty)?.why == "row_under_box", "\(u)") }
    // after Talos's row, a short part Talos does not know is an unknown part (status_row_vectors), even one that reads like Talos's row
    for u in ["  Talos: Opus 5.5" + pad + "user-status-line", "  ⏸ manual mode on · talos"] {
      #expect(KeyGuard.allows(base + [u], intent: empty), "\(u)")
    }
    // the patterns end at the end of the text: ICU's `$` would also stop before a final line break
    for (r, row) in [(BoxFrame.talosStatusLine, "Talos: Opus | 7d: 3%"), (BoxFrame.talosStatusLine, "Talos"), (BoxFrame.oldRecorderRow, "Opus | 7d: 3%")] {
      #expect(BoxFrame.matches(r, row), "control: \(row)")
      #expect(!BoxFrame.matches(r, row + "\n"), "\(row) and a line break")
      #expect(!BoxFrame.matches(r, row + "\r\n"), "\(row) and a CRLF")
    }
    #expect(!BoxFrame.matches(BoxFrame.talosStatusLine, "Talos: Opus | 7d: \u{0663}%"))
    // the real capture: Talos's row with Claude Code's sign-in reminder on the same row takes the line
    let thread = try Self.capture("real-2.1.323-statusline/thread.txt")
    #expect(KeyGuard.allows(thread, intent: empty))
  }

  /// For one release the old recorder row, "<model> | 7d: N%" with no "Talos" prefix, may sit under the box: thread sessions started before
  /// the prefix change print it until they restart. Only the form with the percentage, and one Talos-or-old row in total. Remove this test
  /// with BoxFrame.oldRecorderRow after the release following this one.
  @Test func oldRecorderRowWithPercentAllowedForOneReleaseRemoveAfterTheNext() {
    let empty = KeyGuard.Intent.box(.empty)
    let base = ["⏺ Done."] + Self.box
    // the old recorder printed the model's display name: it starts with a model family (Opus, Sonnet, Haiku, Fable, Claude), then a space
    // or the end of the name
    let old = ["  Sonnet 5.5 | 7d: 38%", "  Opus 5.5 (1M context) | 7d: 100%", "  Claude 3.7 Sonnet | 7d: 0%", "  Haiku | 7d: 9%",
               "  Opus 5.5 | 7d: 42%", "  Fable 5.2 | 7d: 3%", "  Sonnet " + String(repeating: "a", count: 32) + " | 7d: 1%"]
    for o in old {
      #expect(KeyGuard.allows(base + [o], intent: empty), "\(o)")
      #expect(KeyGuard.allows(base + [o, "  ⏸ manual mode on · ? for shortcuts"], intent: empty), "\(o)")
      #expect(KeyGuard.allows(base + ["  ⏺ main", o], intent: empty), "\(o) after a status row")
    }
    #expect(KeyGuard.allows(base + ["  Opus 5.5 | 7d: 42%", "  Not logged in · Run /login"], intent: empty))
    #expect(KeyGuard.allows(base + ["  Not logged in · Run /login", "  Opus 5.5 | 7d: 42%"], intent: empty))
    let refused: [[String]] = [
      ["  Sonnet 5.5"], ["  Opus 5.5 (1M context)"],  // the bare old model-only form
      ["  Sonnet 5.5 | 7d: 38%", "  Talos: Sonnet 5 | 7d: 38%"], ["  Talos: Sonnet 5 | 7d: 38%", "  Sonnet 5.5 | 7d: 38%"],  // old + new
      ["  Sonnet 5.5 | 7d: 38%", "  Talos"], ["  Talos: Opus", "  Opus | 7d: 2%"],
      ["  Sonnet 5.5 | 7d: 38%", "  Sonnet 5.5 | 7d: 38%"], ["  Opus | 7d: 1%", "  ⏺ main", "  Sonnet | 7d: 2%"],  // two old
      ["  Opus 5.5"], ["  Opus 5.5 | 7d: 42%", "  Talos: Opus 5.5 | 7d: 42%"], ["  Opus 5.5 | 7d: 42%", "  Opus 5.5 | 7d: 42%"],
      ["  Opus 5.5 | 7d: 101%"], ["  -Opus | 7d: 3%"], ["  Buy $50 | 7d: 3%"],
      ["  Talos | 7d: 3%"], ["  Talos | 7d: 100%"], ["  Talos 5 | 7d: 3%"], ["  Talos (old) | 7d: 3%"],  // never the word "Talos" first
      ["  Opus 5.5 | 7d: 42%", "  Not logged in · Run /login", "  Opus 5.5 | 7d: 42%"],
      ["  Sonnet 5.5 | 7d: 101%"], ["  Sonnet 5.5 | 7d: 05%"], ["  Sonnet 5.5 | 7d: 38"], ["  Sonnet 5.5 |  7d: 38%"],
      ["  Sonnet 5.5 | 20% | 7d: 38%"], ["  ❯ Buy | 7d: 3%"], ["  -x | 7d: 3%"], ["  Talos: Opus | 7d: 3% | 7d: 3%"],
      ["  Sonnet " + String(repeating: "a", count: 33) + " | 7d: 1%"], ["  Opus " + String(repeating: "a", count: 33) + " | 7d: 1%"],  // past 32 after it
      // not a model family first: no old row (Fable R3's "Approve (y) or deny (n) | 7d: 0%" was one)
      ["  Approve (y) or deny (n) | 7d: 0%"], ["  claude-sonnet-4-5 | 7d: 0%"], ["  4o | 7d: 9%"], ["  Talosx | 7d: 3%"],
      ["  Opusx | 7d: 3%"], ["  opus | 7d: 3%"], ["  1. Buy | 7d: 3%"], ["  " + String(repeating: "a", count: 40) + " | 7d: 1%"],
    ]
    for u in refused {
      #expect(KeyGuard.refusal(base + u, intent: empty)?.why == "row_under_box", "\(u)")
    }
    // a dialog key never goes on the strength of the old row either
    for k in KeyGuard.DialogKind.allCases { #expect(!KeyGuard.allows(base + ["  Sonnet 5.5 | 7d: 38%"], intent: .dialog(k)), "\(k)") }
  }

  /// Claude Code's own status rows pass at any count: the agents panel draws one row per subagent.
  @Test func anyNumberOfClaudeCodesOwnStatusRowsPasses() throws {
    let base = ["⏺ Done."] + Self.box
    let mode = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents · ↓ to manage"
    let agents = (1...7).map { "  ◯ talos-builder-\($0)  Verify the push                                \($0 * 3)s · ↓ \($0 * 12) tokens" }
    let panel = [mode, "  ⏺ main"] + agents
    #expect(panel.allSatisfy(BoxFrame.statusRow), "control: each is a status row")
    #expect(KeyGuard.allows(base + panel, intent: .box(.empty)), "nine status rows")
    // one row of a user's own status line among them: refused (strict)
    #expect(KeyGuard.refusal(base + panel + ["  Sonnet 5.5 | 20%"], intent: .box(.empty))?.why == "row_under_box")
    // Talos's own thread status line among them: still typed into
    #expect(KeyGuard.allows(base + ["  Talos: Sonnet 5 | 7d: 38%"] + panel, intent: .box(.empty)))
    // and the real capture with its panel still takes the line
    #expect(KeyGuard.allows(try Self.capture("real-2.1.322/idle-agents-panel.txt"), intent: .box(.empty)))
  }

  /// The live region only: words above the last rule never name the select below it.
  @Test func scrollbackCannotDecide() throws {
    let select = [Self.rule, " ❯ 1. Buy $50 of credits", "   2. Cancel", " Enter to confirm · Esc to cancel"]
    let quotes: [[String]] = [
      [" Quick safety check: Is this a project you created or one you trust?", " Yes, I trust this folder"],
      [" New MCP server found in this project: talos-app", " ❯ Use this and all future MCP servers in this project"],
      [" WARNING: Loading development channels", " Channels: server:talos-app", " ❯ 1. I am using this for local development"],
      [" Computer Use needs macOS permissions", " Accessibility: granted", " Screen Recording: not granted"],
    ]
    for q in quotes { #expect(Self.allowed(q + select).isEmpty, "\(q[0])") }
    // the real dev-channels warning drawn below a rule is still the warning (its own region)
    let dev = try Self.capture("real-dev-channels/dev-channels-capture.txt")
    #expect(Self.allowed(dev) == ["dev_channels"], "control")
    #expect(Self.allowed(["⏺ earlier:"] + dev + select).isEmpty, "the whole warning above a rule, an unknown select below it")
    // a trust dialog's key names only the trust dialog
    let trust = try Self.capture("real-2.1.318/trust-dialog.txt")
    #expect(Self.allowed(trust) == ["trust"])
  }

  /// Real Claude Code 2.1.325 with messages queued in a busy turn (real-2.1.325-queued): the dim placeholder in the box is no draft, and
  /// the rows under the box are Claude Code's own, "1 shell" and a last part cut at a 30-column edge ("esc to…") included. A cut part
  /// names a known part; anything else cut is still a strange row.
  @Test func queuedMessagesInABusyTurnLeaveTheBoxTypable() throws {
    for name in ["queued-one-120", "queued-two-box-empty-120", "queued-one-30", "busy-30"] {
      #expect(Self.allowed(try Self.capture("real-2.1.325-queued/\(name).txt")) == ["box-empty"], "\(name)")
    }
    #expect(Self.allowed(try Self.capture("real-2.1.325-queued/queued-draft-120.txt")).isEmpty, "a draft is the owner's")
    let base = ["⏺ Done."] + Self.box
    for ok in ["  ⏸ manual mode on · 1 shell · esc to interrupt · ↓ to manage", "  ⏸ manual mode on · 2 shells", "  ⏸ manual mode on · esc to…",
               "  ⏸ manual mode on · 1 sh…", "  ⏸ manual mode on · ? for…"] {
      #expect(KeyGuard.allows(base + [ok], intent: .box(.empty)), "\(ok)")
    }
    // not a known part, but plain ASCII words after the mode head: an unknown part (status_row_vectors); a cut that is no known part's is not
    #expect(KeyGuard.allows(base + ["  ⏸ manual mode on · shells"], intent: .box(.empty)))
    #expect(KeyGuard.refusal(base + ["  ⏸ manual mode on · e…"], intent: .box(.empty))?.why == "row_under_box")
    for bad in ["  ⏸ manual mode on · Buy $50…", "  ⏸ manual mode on · esc to interrupt…", "  esc to… · ? for shortcuts",
                "  ⏸ manual mode on · 1 shell · 1. Yes…"] {
      #expect(KeyGuard.refusal(base + [bad], intent: .box(.empty))?.why == "row_under_box", "\(bad)")
    }
  }

  /// Real Claude Code 2.1.325 in the states a thread session goes through (real-2.1.325-status), at 120, 60 and 30 columns: every one
  /// takes the empty box. Named here for what each adds: the todo hint, the subagent row with an up arrow and its narrow forms.
  @Test func everyStatusStateOf2_1_325TakesTheEmptyBox() throws {
    for state in ["todo-busy", "subagent-busy", "idle-plan", "idle-accept-edits", "bg-running", "subagent-later"] {
      for w in [120, 60, 30] {
        #expect(Self.allowed(try Self.capture("real-2.1.325-status/\(state)-\(w).txt")) == ["box-empty"], "\(state)-\(w)")
      }
    }
    let base = ["⏺ Done."] + Self.box
    for row in ["  ◯ general-purpose  Write lighthouse essay        3s · ↑ 50 tokens", "  ◯ general-purpose 6s · ↑",
                "  ◯ general-purpose  Write lighthouse… 4s · ↑ 34.0k tokens", "  ◯ talos-builder-2  Verify the push   6s · ↓ 24 tokens"] {
      #expect(KeyGuard.allows(base + ["  ⏺ main", row], intent: .box(.empty)), "\(row)")
    }
    for row in ["  ◯ general-purpose  ❯ 1. Yes", "  ◯ Buy $50 of credits", "  ◯ general-purpose  3s · ↑ 50 tokens · Enter to confirm"] {
      #expect(KeyGuard.refusal(base + [row], intent: .box(.empty))?.why == "row_under_box", "\(row)")
    }
  }

  /// Status parts Talos does not know, from the shared table (`status_row_vectors`): after Claude's mode part (or Talos's row), at most two
  /// short unknown parts with no dialog marks, option numbers, footer or choice words, `$` or `?`, on one row only; a row with a control
  /// or format character refused whole. Every vector both ways, and each refused one also refused for the Enter (`box-ours`).
  @Test func unknownStatusPartsAreAllowedOnlyAsTheSharedTableSays() throws {
    let v = try Self.vectors().status_row_vectors.vectors
    #expect(v.count == 53)
    for t in v {
      let rows = ["⏺ Done.", Self.rule, "❯ ", Self.rule] + t.rows
      #expect(KeyGuard.allows(rows, intent: .box(.empty)) == t.box_empty, "\(t.name)")
      if !t.box_empty { #expect(KeyGuard.refusal(rows, intent: .box(.empty))?.why == "row_under_box", "\(t.name)") }
      let ours = ["⏺ Done.", Self.rule, "❯ " + PointerTyper.text, Self.rule] + t.rows
      #expect(KeyGuard.allows(ours, intent: .box(.ours)) == t.box_empty, "\(t.name): the Enter")
    }
    // the shapes the audit gets: letters a, digits N, spaces and the rest kept, at most 40 code points, never the text
    #expect(BoxFrame.unknownShape("ctrl+r to search") == "aaaa+a aa aaaaaa")
    #expect(BoxFrame.unknownShape("v2 tip") == "aN aaa")
    #expect(BoxFrame.unknownShape(String(repeating: "x", count: 60)).unicodeScalars.count == 40)
    let under = ["⏺ Done.", Self.rule, "❯ ", Self.rule, "  ⏸ manual mode on · 1 shell · ctrl+r to search · new thing"]
    #expect(KeyGuard.unknownStatusShapes(under) == ["aaaa+a aa aaaaaa", "aaa aaaaa"])
    #expect(KeyGuard.unknownStatusShapes(["⏺ Done.", Self.rule, "❯ ", Self.rule, "  ⏸ manual mode on · ? for shortcuts"]).isEmpty)
  }

  /// Pantheon's narrow refusals after Fable R3: an unknown part that starts with an option number, holds "y/n" or holds the word "enter"
  /// refuses (and its shape is audited); hints shaped "x to y" stay allowed.
  @Test func anOptionNumberFirstOrAYesNoHintIsNoUnknownPart() {
    let base = ["⏺ Done."] + Self.box
    for bad in ["  ⏸ manual mode on · 1. yes", "  ⏸ manual mode on · 2) no", "  ⏸ manual mode on · 10. later", "  ⏸ manual mode on · y/n",
                "  ⏸ manual mode on · continue y/n", "  ⏸ manual mode on · 3.later", "  ⏸ manual mode on · press enter",
                "  ⏸ manual mode on · enter to confirm", "  ⏸ manual mode on · hit enter now"] {
      #expect(KeyGuard.refusal(base + [bad], intent: .box(.empty))?.why == "row_under_box", "\(bad)")
    }
    for ok in ["  ⏸ manual mode on · space to select", "  ⏸ manual mode on · see 2. next", "  ⏸ manual mode on · v2.1 ready",
               "  ⏸ manual mode on · y to trust", "  ⏸ manual mode on · entered", "  ⏸ manual mode on · reenter later"] {
      #expect(KeyGuard.allows(base + [ok], intent: .box(.empty)), "\(ok)")
    }
  }

  /// Fable's round-3 probes (`status_row_probes`, 271), each decided from the spec text: the Mac gives exactly that outcome, for the empty box
  /// and for the Enter.
  @Test func everyRound3ProbeGivesTheOutcomeTheSpecDecides() throws {
    let probes = try Self.vectors().status_row_probes.probes
    #expect(probes.count == 278)
    var wrong: [String] = []
    for t in probes {
      let rows = ["⏺ Done.", Self.rule, "❯ ", Self.rule] + t.rows
      if KeyGuard.allows(rows, intent: .box(.empty)) != t.box_empty { wrong.append(t.name) }
      let ours = ["⏺ Done.", Self.rule, "❯ " + PointerTyper.text, Self.rule] + t.rows
      if KeyGuard.allows(ours, intent: .box(.ours)) != t.box_empty { wrong.append(t.name + " (Enter)") }
    }
    #expect(wrong.isEmpty, "\(wrong)")
    // a refused part's shape for the audit: its length and its character classes, never its text
    #expect(BoxFrame.refusedShape("Yes") == "3:aA")
    #expect(BoxFrame.refusedShape("Press Y") == "7:aAs")
    #expect(BoxFrame.refusedShape("☑\u{FE0F} done") == "7:asu")
    let under = ["⏺ Done.", Self.rule, "❯ ", Self.rule, "  ⏸ manual mode on · Proceed?"]
    #expect(KeyGuard.refusedStatusShapes(under) == ["8:aAp"])
    #expect(KeyGuard.refusedStatusShapes(["⏺ Done.", Self.rule, "❯ ", Self.rule, "  ⏸ quiet mode on · x"]) == ["mode 15:asu"])
  }

  /// No real capture of a select or dialog has Claude's input box frame on the same pane, live or not: the guard's whole design rests on
  /// Claude Code drawing a select INSTEAD of its box. A capture of a Claude Code that draws a select under (or over) its box fails this.
  @Test func noRealSelectOrDialogCaptureHasALiveBox() throws {
    var checked = 0
    let table = try Self.vectors().captures
    for dir in try FileManager.default.contentsOfDirectory(atPath: Self.fixtures.path) where dir.hasPrefix("real") {
      let walk = FileManager.default.enumerator(atPath: Self.fixtures.appendingPathComponent(dir).path)
      while let f = walk?.nextObject() as? String {
        guard f.hasSuffix(".txt"), !f.hasSuffix(".ansi.txt") else { continue }
        let rows = try Self.capture(dir + "/" + f).map(InputBoxAttributes.stripEscapes)
        // a select or dialog: the table names a dialog key for it, or a whole-pane reader reads one live (the sign-in hint and the resume
        // error are notices, not selects)
        let dialogKey = (table[dir + "/" + f] ?? []).contains { !$0.hasPrefix("box-") }
        let live = DialogMatcher.liveDialog(rows)
        let isSelect = dialogKey || PromptDetector.detect(rows) != nil || (live != .none && live != .loginExpired && live != .resumeMissing)
        guard isSelect else { continue }
        checked += 1
        // no input box frame on the pane at all: not a live one, and not one a select is drawn under (whose rows would only make the
        // guard refuse, hiding that Claude Code changed how it draws)
        #expect(PointerTyper.inputBox(rows: rows) == nil, "\(dir)/\(f): a select with an input box frame on the pane")
        #expect(BoxFrame.liveBox(rows) == nil, "\(dir)/\(f): a select with a live box")
      }
    }
    #expect(checked >= 10, "control: the scan finds the select and dialog captures (\(checked))")
  }

  /// A key for the development-channels warning names WHICH row it lands on and which channels the warning lists, not just that there is one
  /// title, one channel line and one cursor: the Enter that confirms goes only while the cursor is on "I am using this for local
  /// development" and the list is the one the sender read; an arrow only from the row the sender saw. Any other row under the cursor, or a
  /// different list, gets no key; the bare dialog intent takes only the warning's own two rows and a list with no empty entry.
  @Test func aDevChannelsKeyNamesTheHighlightedRowAndTheChannelList() throws {
    let dev = try Self.capture("real-dev-channels/dev-channels-capture.txt")
    let confirm = DialogMatcher.Strings.devConfirm, exit = DialogMatcher.Strings.devExit
    let listed = ["server:talos-app"]
    #expect(KeyGuard.allows(dev, intent: .devWarning(highlighted: confirm, channels: listed)), "control: the capture as read")
    #expect(KeyGuard.refusal(dev, intent: .devWarning(highlighted: exit, channels: listed))?.why == "not_dev_channels", "the cursor is elsewhere")
    #expect(KeyGuard.refusal(dev, intent: .devWarning(highlighted: confirm, channels: ["server:other"]))?.why == "not_dev_channels")
    #expect(!KeyGuard.allows(dev, intent: .devWarning(highlighted: confirm, channels: listed + ["plugin:x"])), "another list")
    #expect(!KeyGuard.allows(dev, intent: .devWarning(highlighted: confirm, channels: [])))
    // the cursor moved to Exit: Exit is named, the confirm is not
    let onExit = dev.map {
      $0.replacingOccurrences(of: "❯ 1. I am using", with: "  1. I am using").replacingOccurrences(of: "   2. Exit", with: " ❯ 2. Exit")
    }
    #expect(KeyGuard.allows(onExit, intent: .devWarning(highlighted: exit, channels: listed)), "control: the cursor on Exit")
    #expect(!KeyGuard.allows(onExit, intent: .devWarning(highlighted: confirm, channels: listed)))
    // a row of some other wording under the cursor, the same counts: no key for either intent
    let other = dev.map { $0.replacingOccurrences(of: "I am using this for local development", with: "Load and send my files") }
    #expect(!KeyGuard.allows(other, intent: .dialog(.devChannels)), "the dialog intent takes only the warning's own rows")
    #expect(!KeyGuard.allows(other, intent: .devWarning(highlighted: "Load and send my files", channels: listed)))
    // an empty entry in the list (a dangling comma): never the warning a key is for
    let dangling = dev.map { $0.replacingOccurrences(of: "Channels: server:talos-app", with: "Channels: server:talos-app,") }
    #expect(!KeyGuard.allows(dangling, intent: .dialog(.devChannels)))
    #expect(!KeyGuard.allows(dangling, intent: .devWarning(highlighted: confirm, channels: ["server:talos-app", ""])))
    #expect(KeyGuard.Intent.devWarning(highlighted: confirm, channels: listed).name == "dev_channels")
  }

  /// A live dialog in a frame of its own below a quoted menu wins (the Linux reader's Fable R5-2): the trust dialog is read and answered;
  /// nothing is typed.
  @Test func aLiveDialogBelowAQuotedMenuWins() throws {
    var trust = try Self.capture("real-2.1.318/trust-dialog.txt")
    while let l = trust.last, InputBoxAttributes.stripEscapes(l).trimmingCharacters(in: .whitespaces).isEmpty { trust.removeLast() }
    let both = Self.menuRows() + trust
    #expect(UsageLimitScreen.read(both.map(InputBoxAttributes.stripEscapes)) == nil)
    #expect(KeyGuard.allows(both, intent: .dialog(.trust)))
    #expect(!KeyGuard.allows(both, intent: .box(.empty)))
  }

  /// A live prompt below a quoted menu wins too: it is the prompt (needs-you as one), not the usage limit, and it gets no key.
  @Test func aLivePromptBelowAQuotedMenuWinsAndGetsNoKey() throws {
    for name in ["real-2.1.318/bash-permission.txt", "real-2.1.318/askuser-select.txt", "real-2.1.322/perm-subagent-rm-120x40.txt"] {
      var prompt = try Self.capture(name).map(InputBoxAttributes.stripEscapes)
      while let l = prompt.last, l.trimmingCharacters(in: .whitespaces).isEmpty { prompt.removeLast() }
      #expect(PromptDetector.detect(prompt) != nil, "control: \(name)")
      let both = Self.menuRows() + prompt
      #expect(UsageLimitScreen.read(both) == nil, "\(name)")
      #expect(PromptDetector.detect(both) != nil, "\(name)")
      #expect(Self.allowed(both).isEmpty, "\(name): \(Self.allowed(both))")
    }
  }

  /// The menu's rows from the synthetic screen, without its footer.
  static func menuRows() -> [String] {
    ((try? synthetic("usage-limit")) ?? []).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty && !$0.contains("Enter to confirm") }
  }

  @Test func theEnterGoesOnlyOnExactlyTalossLine() throws {
    let typed = try Self.capture("real-2.1.319/owed-capture/05-typed-30.txt")
    #expect(KeyGuard.allows(typed, intent: .box(.ours)))
    let swap = { (a: String, b: String) in typed.map { $0.replacingOccurrences(of: a, with: b) } }
    #expect(!KeyGuard.allows(swap("thread. Call", "thread.  Call"), intent: .box(.ours)))
    #expect(!KeyGuard.allows(swap("  thread. Call", "    thread. Call"), intent: .box(.ours)))
    #expect(!KeyGuard.allows(swap("read_inbound.", "read_inbound. x"), intent: .box(.ours)))
    #expect(!KeyGuard.allows(swap("Talos: new", "Talos:\tnew"), intent: .box(.ours)))
  }

  /// The synthetic menu under the empty box: no reader names it and the typing guard alone would type; the key guard refuses.
  @Test func anUnknownMenuUnderTheBoxIsStoppedByTheGuardAlone() throws {
    let rows = try Self.synthetic("unknown-menu-under-box")
    #expect(DialogMatcher.liveDialog(rows) == .none && DialogMatcher.workerScreen(rows) == .none && PromptDetector.detect(rows) == nil)
    #expect(PointerTyper.mayType(screen: .none, lastClientActivity: nil, now: 100, draftPresent: PointerTyper.draftPresent(rows: rows), boxVisible: true))
    #expect(KeyGuard.refusal(rows, intent: .box(.empty))?.why == "row_under_box")
    #expect(Self.allowed(rows).isEmpty)
  }

  /// One path: every place the app sends a key to a Claude Code pane goes through the gate (`Supervisor.sendKey`, `WorkerManager.sendKey`),
  /// which runs the guard with a stated intent. A send written anywhere else fails here: every tmux send builder (`sendEnter`,
  /// `sendLiteral`, `sendBackspaces`, `sendBytes`, `cancelMode` and their `…UnlessInMode` forms), the host's own sends, and the app
  /// target's (Sources/TalosDesktop) too. A one-line function whose body sends is read as a send (only its signature is left out).
  @Test func everyKeySenderGoesThroughTheGate() throws {
    let root = Self.fixtures.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")
    let sends = [
      ".sendDialogKey(", ".sendEscape()", "UnlessInMode(", ".send(keys:", "$0.send(", ".sendEnter(", ".sendLiteral(", ".sendBackspaces(",
      ".sendBytes(", ".sendBytesLeavingMode(", ".cancelMode(", "hostSend(", ".send(source:", ".send(data:",
    ]
    // the gates themselves and the host implementations (what the gates call)
    let exempt = ["SupervisorKeyGuard.swift", "WorkerKeyGuard.swift", "TmuxPtyHost.swift", "PtyHost.swift", "SwiftTermPtyHost.swift"]
    // by name, each a key that is not Talos's to guard: the `claude auth login` pty (a sign-in code typed into the login tool, not Claude
    // Code), the owner's own key buttons in the Terminals window and the one-line pass-through they call, and the owner's typing in a
    // pane shell's terminal, and a script the owner tapped Run on, written only after their own click vouched for that exact Run
    // (`ShellRunChannel`, which alone can make the ticket `runScript` takes: docs/TERMINAL-PANE.md "One path to the shell")
    let owners: [(file: String, line: String)] = [
      ("ClaudeLoginSession.swift", "host.send(keys: Array(clean.utf8))"),  // the code, then its Return as a write of its own
      ("ClaudeLoginSession.swift", "self.host.send(keys: [0x0d])"),
      ("TerminalWindow.swift", "model.supervisor.hostSend(b.bytes)"),
      ("Supervisor.swift", "public func hostSend(_ keys: [UInt8]) { host.send(keys: keys) }"),
      ("ShellClipboardGuard.swift", "inner.send(source: source, data: data)"),
      ("OwnerShellPane.swift", "v.send(data: bytes[...]); noteWrite(bytes)"),
      // the owner's Confirm / Cancel on the four words, written to our own `talos-app enroll` pty (one place: `PairingController.write`)
      ("Pairing.swift", "terminal?.send(data: bytes[...])"),
    ]
    var found = 0, ownersSeen = 0
    for target in ["TalosSupervisor", "TalosDesktop"] {
      let dir = root.appendingPathComponent(target)
      for f in try FileManager.default.contentsOfDirectory(atPath: dir.path) where f.hasSuffix(".swift") && !exempt.contains(f) {
        let text = try String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8)
        for line in text.split(separator: "\n").map(String.init) where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
          // a declaration's own signature is no send; the body on the same line is read
          var code = line
          if let fn = line.range(of: "func ") {
            guard let body = line[fn.upperBound...].firstIndex(of: "{") else { continue }
            code = String(line[body...])
          }
          guard sends.contains(where: { code.contains($0) }) else { continue }
          found += 1
          if owners.contains(where: { $0.file == f && line.contains($0.line) }) {
            ownersSeen += 1
            continue
          }
          let gated = ["sendKey(", "sendKeyReading(", "sendUnlessInMode(", "sendUnlessInModeReading("]
          #expect(gated.contains(where: code.contains), "\(target)/\(f): \(line)")
          if code.contains("sendUnlessInMode") { #expect(code.contains("intent: ."), "\(target)/\(f): \(line)") }
        }
      }
    }
    // the stall auto-unstick's Escape is one of the gated senders, and it states the interrupt intent
    let unstick = try String(contentsOf: root.appendingPathComponent("TalosSupervisor/SupervisorUnstick.swift"), encoding: .utf8)
    #expect(unstick.contains("sendKey(intent) { $0.sendEscape() }") && unstick.contains(".interruptBlank") && unstick.contains(": .interrupt"),
      "the unstick's one key goes through the gate with its own intents")
    #expect(ownersSeen == owners.count, "control: each named exception is still where it is named (\(ownersSeen))")
    #expect(found >= 14, "control: the scan sees the senders (\(found))")
  }

  // MARK: the stall auto-unstick's Escape (`.interrupt`)

  private static let working = ["❯ are you there?", "", "✻ Pondering… (19s · ↓ 77 tokens)", "", rule, "❯ ", rule,
    "  ⏵⏵ bypass permissions on · esc to interrupt"]

  @Test func anEscapeMeantAsInterruptGoesOnlyToARequestInFlightWithAnEmptyBox() {
    #expect(KeyGuard.refusal(Self.working, intent: .interrupt) == nil)
    #expect(KeyGuard.Intent.interrupt.name == "interrupt")
  }

  @Test func noEscapeWhileSomeoneIsTypingAPromptIsUpOrNothingIsRunning() {
    var typing = Self.working
    typing[5] = "❯\u{00A0}half a sentence"
    #expect(KeyGuard.refusal(typing, intent: .interrupt)?.why == "box_not_empty")
    let idle = ["❯ hello", "", "⏺ Hi.", "", Self.rule, "❯ ", Self.rule, "  ⏵⏵ bypass permissions on"]
    #expect(KeyGuard.refusal(idle, intent: .interrupt)?.why == "not_working", "an idle Main gets no Escape")
    let permission = ["⏺ Bash(ls)", "", Self.rule, " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No", "", " Esc to cancel"]
    #expect(KeyGuard.refusal(permission, intent: .interrupt) != nil, "a permission dialog is answered by Escape: never sent")
    #expect(KeyGuard.refusal(nil, intent: .interrupt)?.why == "unreadable")
    #expect(KeyGuard.refusal(Self.working, intent: nil)?.why == "no_intent")
  }

  // MARK: Escape for a frozen request with no working line (`.interruptBlank`)

  private static let blankIdle = ["❯ hello", "", "⏺ Read(file)", "", rule, "❯ ", rule, "  ⏵⏵ bypass permissions on"]

  @Test func aBlankStallsEscapeGoesToTheIdlePromptOnly() {
    #expect(KeyGuard.refusal(Self.blankIdle, intent: .interruptBlank) == nil)
    #expect(KeyGuard.Intent.interruptBlank.name == "interrupt-blank")
    // each intent wants its own screen: a spinner is `.interrupt`'s, the idle prompt is this one's
    #expect(KeyGuard.refusal(Self.working, intent: .interruptBlank)?.why == "working_line")
    #expect(KeyGuard.refusal(Self.blankIdle, intent: .interrupt)?.why == "not_working")
  }

  @Test func noBlankEscapeOverADraftADialogOrAnUnreadableScreen() {
    var draft = Self.blankIdle
    draft[5] = "❯\u{00A0}half a sentence"
    #expect(KeyGuard.refusal(draft, intent: .interruptBlank)?.why == "box_not_empty")
    let permission = ["⏺ Bash(ls)", "", Self.rule, " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No", "", " Esc to cancel"]
    #expect(KeyGuard.refusal(permission, intent: .interruptBlank) != nil, "a dialog is answered by Escape: never sent")
    #expect(KeyGuard.refusal(["⏺ Read(file)", "", "no box here"], intent: .interruptBlank)?.why == "no_input_box")
    #expect(KeyGuard.refusal(nil, intent: .interruptBlank)?.why == "unreadable")
  }

  @Test func theBlankEscapeNeedsThisTicksPendingTurnAndTheWait() {
    // the sender's side of the rule (the gate sees only the screen): a nil or an answered transcript, or a wait not yet passed, never picks it
    func ready(_ tail: MainStall.Transcript?, at t: Double) -> Bool {
      var w = MainWatch()
      let told = Date(timeIntervalSince1970: 1_000)
      var s = BridgeStatus(pid: 42, mode: .live, relayConnected: true, lastConnectAt: nil, lastCloseCode: nil, queueDepth: 0, permissionRelay: false, updatedAt: Date())
      s.unseenOldestAt = told
      s.mainResend = true
      for i in 0...Int(t) {
        w.observe(status: s, paneOutputAt: nil, awakeNow: Double(i))
        w.observeStall(rows: Self.blankIdle, transcript: tail, awakeNow: Double(i))
      }
      return w.blankStallReady(awakeNow: t)
    }
    let pending = MainStall.Transcript(size: 100, tail: .awaitingModel(since: nil))
    #expect(ready(pending, at: 90))
    #expect(!ready(pending, at: 89), "the blank wait has not passed")
    #expect(!ready(nil, at: 300), "an unreadable transcript with a blank pane is an idle prompt")
    #expect(!ready(.init(size: 100, tail: .answered), at: 300))
  }

  @Test func theInterruptIntentIsNotOnTheSharedTable() {
    // Escape for a stalled request is a Mac-only sender: the shared table (and its Linux twin) never lists it, and no other intent allows it
    #expect(!Self.intents.contains { $0.1 == .interrupt || $0.1 == .interruptBlank })
    for (name, intent) in Self.intents { #expect(!KeyGuard.allows(Self.working, intent: intent) || name == "box-empty", "\(name)") }
  }
}

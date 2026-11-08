import Foundation
import Testing
@testable import TalosDesktopCore

/// Review of the first prompt detector: a resize must not make a prompt a new one (S1), the dev-channels dialog is never generic
/// (S2), an owner-opened picker waits (S3), and the smaller cases (L1 to L6). Captures are REAL (Fixtures/real-2.1.318); anything
/// built here says SYNTHETIC.
@Suite("PromptDetector review")
struct PromptDetectorReviewTests {
  /// SYNTHETIC re-flow of a 120-column capture to `width` columns: a rule or a `╌` box row is redrawn at the new width; any other row
  /// that is too long is word-wrapped, its continuation rows indented as the row was. (Claude Code re-wraps by its own rules; this only
  /// has to change the layout the way a narrower pane does.)
  static func reflow(_ rows: [String], width: Int) -> [String] {
    var out: [String] = []
    for row in rows {
      if DialogMatcher.isFrameRule(row) {
        out.append(String(repeating: row.first(where: { $0 != " " }) ?? "\u{2500}", count: width))
      } else if row.trimmingCharacters(in: .whitespaces).allSatisfy({ $0 == "\u{254C}" }), !row.trimmingCharacters(in: .whitespaces).isEmpty {
        out.append(String(repeating: "\u{254C}", count: width))
      } else if row.count <= width {
        out.append(row)
      } else {
        let indent = String(row.prefix(while: { $0 == " " }))
        var line = ""
        for word in row.split(separator: " ", omittingEmptySubsequences: true) {
          let first = line.isEmpty
          let candidate = first ? indent + word : line + " " + word
          if candidate.count > width, !first {
            out.append(line)
            line = indent + word
          } else {
            line = candidate
          }
        }
        out.append(line)
      }
    }
    return out
  }

  // MARK: S1

  @Test(arguments: ["bash-permission", "write-permission", "askuser-select", "onboarding-theme"])
  func theSamePromptAtEightyColumnsIsTheSamePrompt(name: String) throws {
    let wide = try RealScreens.rows(name)
    let narrow = Self.reflow(wide, width: 80)
    #expect(narrow != wide, "control: the layout changed")
    let a = try #require(PromptDetector.detect(wide))
    let b = try #require(PromptDetector.detect(narrow), "still a prompt at 80 columns")
    #expect(a.signature == b.signature)
    #expect(a.hash == b.hash)
    #expect(a.kind == b.kind)
  }

  @Test func thePromptsDifferEvenWithoutTheirLayout() throws {
    let a = try #require(PromptDetector.detect(try RealScreens.rows("bash-permission")))
    let w = try #require(PromptDetector.detect(try RealScreens.rows("write-permission")))
    #expect(!a.hash.isEmpty && a.hash != w.hash)
    // another command of the same kind is another prompt
    let other = try RealScreens.rows("bash-permission").map { $0.replacingOccurrences(of: "touch hello.txt", with: "rm -rf build") }
    #expect(try #require(PromptDetector.detect(other)).hash != a.hash)
    // the cursor on another option, or another footer, is the same prompt
    #expect(try #require(PromptDetector.detect(try RealScreens.rows("bash-permission-cursor2"))).hash == a.hash)
  }

  // MARK: L2

  /// SYNTHETIC: the cursor row of 10 moved to `4. Chat about this`, alone under the second rule.
  func cursorOnChat() throws -> [String] {
    try RealScreens.rows("askuser-select").map { row in
      if row.hasPrefix("\u{276F} 1. Red") { return "  1. Red" }
      if row.hasPrefix("  4. Chat about this") { return "\u{276F} 4. Chat about this" }
      return row
    }
  }

  @Test func theCursorOnChatAboutThisIsStillTheQuestion() throws {
    let real = try #require(PromptDetector.detect(try RealScreens.rows("askuser-select")))
    let moved = try #require(PromptDetector.detect(try cursorOnChat()))
    #expect(moved.kind == .question)
    #expect(moved.question == "Which color do you prefer?")
    #expect(moved.hash == real.hash)
  }

  /// SYNTHETIC: typing into `3. Type something.` with the cursor on it (the typed words replace the label) is not a new prompt.
  @Test func typingIntoTypeSomethingIsNotANewPrompt() throws {
    let real = try #require(PromptDetector.detect(try RealScreens.rows("askuser-select")))
    let typing = try RealScreens.rows("askuser-select").map { row -> String in
      if row.hasPrefix("\u{276F} 1. Red") { return "  1. Red" }
      if row.hasPrefix("  3. Type something.") { return "\u{276F} 3. my own colour is teal" }
      return row
    }
    let p = try #require(PromptDetector.detect(typing))
    #expect(p.hash == real.hash)
    #expect(p.region != real.region)
  }

  // MARK: S2

  @Test(arguments: [false, true])
  func theDevChannelsDialogIsNeverGeneric(boxed: Bool) {
    #expect(PromptDetector.detect(devDialog(boxed: boxed)) == nil)
    #expect(PromptDetector.detect(devDialog(highlight: 2, boxed: boxed)) == nil)
    // the title and the text scrolled off a short pane: the options and the footer are all that is left
    let short = devDialog(boxed: boxed).filter { !$0.contains("WARNING") && !$0.contains("--dangerously") && !$0.contains("Please use") }
    #expect(!short.contains { $0.contains("WARNING") })
    #expect(PromptDetector.detect(short) == nil)
    #expect(PromptDetector.detect(Array(short.suffix(5))) == nil)
  }

  // MARK: S3 and the question line

  @Test func transcriptChromeIsNeverTheQuestion() throws {
    let rule = String(repeating: "\u{2500}", count: 60)
    for chrome in ["\u{273B} Worked for 2s", "\u{23FA} Ran 1 command", "\u{23BF}  Interrupted"] {
      let p = try #require(PromptDetector.detect([rule, " " + chrome, " \u{276F} 1. A", "   2. B"]), "\(chrome)")
      #expect(p.question == nil, "\(chrome)")
      #expect(SupervisorNotice.workerPromptLine(threadName: "T", prompt: p) == "T's session is waiting on a prompt; open Terminals \u{2192} T on the Mac to answer.")
    }
  }

  // MARK: L5

  /// SYNTHETIC variant of 09: the Edit tool's permission (no capture of it exists).
  @Test func syntheticEditPermissionIsAFileEdit() throws {
    let rows = try RealScreens.rows("write-permission").map {
      $0.replacingOccurrences(of: " Create file", with: " Edit file").replacingOccurrences(of: "Do you want to create notes.txt?", with: "Do you want to make this edit to notes.txt?")
    }
    let p = try #require(PromptDetector.detect(rows))
    #expect(p.kind == .fileEdit)
    #expect(p.title == "file edit")
    #expect(p.question == "Do you want to make this edit to notes.txt?")
    // the question alone names it too
    let q = try RealScreens.rows("write-permission").map { $0.replacingOccurrences(of: "Do you want to create notes.txt?", with: "Do you want to make this edit to notes.txt?") }
    #expect(try #require(PromptDetector.detect(q.map { $0.replacingOccurrences(of: " Create file", with: " notes.txt") })).kind == .fileEdit)
  }

  /// SYNTHETIC variant of 10: several questions put a tab header (`← ☐ …`) where `☐ Color` was.
  @Test func syntheticTheTabHeaderOfSeveralQuestionsIsStillAQuestion() throws {
    let rows = try RealScreens.rows("askuser-select").map {
      $0.hasPrefix(" \u{2610} Color") ? " \u{2190} \u{2610} Color  \u{2610} Size  \u{2714} Submit \u{2192}" : $0
    }
    #expect(rows.contains { $0.contains("\u{2190} \u{2610}") }, "control: the header is there")
    let p = try #require(PromptDetector.detect(rows))
    #expect(p.kind == .question)
    #expect(p.question == "Which color do you prefer?")
  }

  // MARK: the question line has a real value

  @Test func aLongQuestionIsCutAtOneHundredCharacters() throws {
    let rule = String(repeating: "\u{2500}", count: 60)
    let q = try #require(PromptDetector.detect([rule, " " + String(repeating: "x", count: 300), " \u{276F} 1. A", "   2. B"])?.question)
    #expect(q.count == 101)
  }
}

@Suite("PromptWatch review")
struct PromptWatchReviewTests {
  func prompt(_ name: String) throws -> PromptDetector.Prompt { try #require(PromptDetector.detect(try RealScreens.rows(name))) }

  /// S3: while an attached client has typed lately the prompt waits (the wait starts over with each look); once it is quiet the usual
  /// stillness applies.
  @Test func aClientTypingLatelyHoldsTheNoticeAndAQuietOneDoesNot() throws {
    var w = PromptWatch()
    let p = try prompt("bash-permission")
    #expect(w.observe(p, at: 100, hold: true) == .none)
    #expect(w.observe(p, at: 110, hold: true) == .none, "10 s still, but the owner is typing")
    #expect(w.observe(p, at: 112, hold: false) == .none, "quiet only just now: the wait starts from the last activity")
    #expect(w.observe(p, at: 114.9, hold: false) == .none)
    #expect(w.observe(p, at: 115, hold: false) == .appeared(p))
  }

  @Test func holdingNeverEndsAnAnnouncedPrompt() throws {
    var w = PromptWatch()
    let p = try prompt("bash-permission")
    _ = w.observe(p, at: 100)
    #expect(w.observe(p, at: 105) == .appeared(p))
    #expect(w.observe(p, at: 106, hold: true) == .none)
    #expect(w.current != nil)
  }

  /// L3: the idle box (its status bar) is the prompt gone, at once; the same prompt back within 2 s is a new one.
  @Test func theIdleBoxClearsAtOnceAndTheSamePromptBackIsNew() throws {
    var w = PromptWatch()
    let p = try prompt("bash-permission")
    _ = w.observe(p, at: 100)
    #expect(w.observe(p, at: 105) == .appeared(p))
    #expect(w.observe(nil, at: 105.5, idle: true) == .cleared)
    #expect(w.observe(p, at: 106) == .none)
    #expect(w.observe(p, at: 111) == .appeared(p))
  }

  @Test func theIdleScreensAreRecognised() throws {
    for name in ["idle-input-auto", "idle-input-manual", "turn-done", "after-esc", "reply-quotes-prompt"] {
      #expect(PromptDetector.isIdle(try RealScreens.rows(name)), "\(name)")
    }
    for name in ["bash-permission", "askuser-select", "write-permission", "onboarding-theme"] {
      #expect(!PromptDetector.isIdle(try RealScreens.rows(name)), "\(name)")
    }
  }

  /// L4: a screen that has not held still is not yet a look to act on.
  @Test func aScreenIsStillOnlyAfterItHeldStill() throws {
    var w = PromptWatch()
    let a = try RealScreens.rows("bash-permission"), b = try RealScreens.rows("bash-permission-cursor2")
    let s1 = w.screenStill(a, at: 100, settle: 5)
    let s2 = w.screenStill(a, at: 104, settle: 5)
    let s3 = w.screenStill(a, at: 105, settle: 5)
    let s4 = w.screenStill(b, at: 106, settle: 5)  // it changed
    let s5 = w.screenStill(b, at: 111, settle: 5)
    #expect(!s1 && !s2 && s3 && !s4 && s5)
  }
}


/// Real bypass-mode permission prompts (`perm-*`, README). Claude Code's own "Dangerous rm operation on critical path" prompt shows even
/// in bypass mode, never reaches the channel relay, and has a live countdown row that lives about two minutes.
@Suite("PromptDetector on the permission captures")
struct PermissionFixtureTests {
  let ts = ["perm-dangerous-rm-t0", "perm-dangerous-rm-t1", "perm-dangerous-rm-t2", "perm-dangerous-rm-t3"]
  func prompt(_ name: String) throws -> PromptDetector.Prompt { try #require(PromptDetector.detect(try RealScreens.rows(name)), "\(name)") }

  @Test(arguments: [
    ("perm-dangerous-rm-bypass", PromptDetector.Kind.bashCommand, "Do you want to proceed?"),
    ("perm-ask-rule-bypass", .bashCommand, "Do you want to proceed?"),
    ("perm-hook-ask", .bashCommand, "Do you want to proceed?"),
    ("perm-subagent-ask", .bashCommand, "Do you want to proceed?"),
    ("perm-background-bash-ask", .bashCommand, "Do you want to proceed?"),
  ])
  func eachPermissionPromptIsFound(name: String, kind: PromptDetector.Kind, question: String) throws {
    let p = try prompt(name)
    #expect(p.kind == kind)
    #expect(p.question == question)
    #expect(p.footer, "its footer is a real shape")
  }

  @Test func theAgentsOwnQuestionIsFound() throws {
    #expect(try prompt("perm-askuserquestion").kind == .question)
  }

  /// The countdown ticks (`1:54` .. `1:45`, three seconds apart): it is not part of the prompt's region or signature.
  @Test func theCountdownIsNotPartOfThePrompt() throws {
    let all = try ts.map(prompt)
    #expect(Set(all.map(\.signature)).count == 1)
    #expect(Set(all.map(\.hash)).count == 1)
    #expect(Set(all.map(\.region)).count == 1)
    #expect(all.map(\.autoBlockSeconds) == [114, 111, 108, 105])
    #expect(all.allSatisfy { $0.kind == .bashCommand && $0.question == "Do you want to proceed?" })
    // the frames really differ in that one row
    let raw = try ts.map { try RealScreens.rows($0) }
    #expect(Set(raw.map { $0.joined(separator: "\n") }).count == 4)
  }

  /// Narrow: digits in the command are the command. Another command is another prompt even when it differs only in digits.
  @Test func syntheticDigitsInTheCommandAreNotMasked() throws {
    let a = try RealScreens.rows("perm-dangerous-rm-t0").map { $0.replacingOccurrences(of: " rm -rf /private/tmp/tsw/perm/home", with: " sleep 1:54") }
    let b = a.map { $0.replacingOccurrences(of: "sleep 1:54", with: "sleep 2:54") }
    #expect(try #require(PromptDetector.detect(a)).hash != (try #require(PromptDetector.detect(b))).hash)
  }

  /// The four real frames, three seconds apart (t = 0, 3, 6, 9), through the watcher: announced exactly once, within those frames. The
  /// countdown changes every one of them; unmasked, no two frames agree for 5 s and it would never be announced.
  @Test func theTickingCountdownIsAnnouncedExactlyOnce() throws {
    var w = PromptWatch()
    var announced = 0
    var at = 0.0
    for name in ts {
      if case .appeared = w.observe(try prompt(name), at: at) { announced += 1 }
      at += 3
    }
    #expect(announced == 1)
    #expect(w.current != nil)
  }

  @Test func theNoticeSaysItBlocksItselfAndWhenFromTheFrameItWasAnnouncedOn() throws {
    let line = SupervisorNotice.workerPromptLine(threadName: "OC Test", prompt: try prompt("perm-dangerous-rm-t0"))
    #expect(line == "OC Test's session is waiting on a 'Bash command' prompt, \"Do you want to proceed?\" (Claude Code blocks it automatically in about 2 min); open Terminals \u{2192} OC Test on the Mac to answer.")
    #expect(SupervisorNotice.mainPromptLine(agentName: "Testagent", prompt: try prompt("perm-dangerous-rm-t3"))
      == "Testagent is waiting on a 'Bash command' prompt, \"Do you want to proceed?\" (Claude Code blocks it automatically in about 2 min); open Terminal on the Mac to answer.")
    // a prompt with no countdown says nothing of the kind
    #expect(!SupervisorNotice.workerPromptLine(threadName: "T", prompt: try prompt("perm-ask-rule-bypass")).contains("automatically"))
  }

  @Test func underAMinuteSaysSo() throws {
    var p = try prompt("perm-dangerous-rm-t0")
    p.autoBlockSeconds = 40
    #expect(SupervisorNotice.mainPromptLine(agentName: "A", prompt: p).contains("(Claude Code blocks it automatically in under a minute)"))
  }
}

import Foundation
import Testing
@testable import TalosDesktopCore

/// A background sub-agent's Bash ask as the real Claude Code 2.1.322 draws it (Fixtures/real-2.1.322, README): the owner's case of
/// 2026-11-11, where `This shell -c script runs rm and could not be checked` sat in a thread session's pane. Every screen here is a
/// capture; nothing is built by hand unless the test says SYNTHETIC.
@Suite("PromptDetector on the 2.1.322 sub-agent captures")
struct PromptDetector322Tests {
  static let dialogs = [
    "perm-subagent-rm-unchecked", "perm-subagent-rm-unchecked-cursor2", "perm-subagent-rm-two-agents", "perm-subagent-rm-queued-3",
    "perm-subagent-rm-queued-4", "perm-subagent-rm-withheld",
  ]
  func rows(_ name: String) throws -> [String] { try RealScreens.rows(name, in: "real-2.1.322") }
  func prompt(_ name: String) throws -> PromptDetector.Prompt { try #require(PromptDetector.detect(try rows(name)), "\(name) is a prompt") }

  @Test(arguments: dialogs)
  func theSubAgentsBashAskIsFoundAsABashCommand(name: String) throws {
    let screen = try rows(name)
    #expect(screen.contains { $0.contains("Bash command \u{00B7} from the talos-builder agent") }, "control: the capture has the sub-agent header")
    #expect(screen.contains { $0.contains("This shell -c script runs rm and could not be checked") }, "control: and Claude Code's own rm check")
    let p = try prompt(name)
    #expect(p.kind == .bashCommand)
    #expect(p.title == "Bash command")
    #expect(p.question == "Do you want to proceed?")
    #expect(DialogMatcher.liveDialog(screen) == .none, "none of the known dialogs")
  }

  /// With the cursor on `1. Yes` the last row is the long footer that names the background agents; on `2. No` it is the same row.
  @Test func theFooterThatNamesBackgroundAgentsIsAFooter() throws {
    #expect(try prompt("perm-subagent-rm-unchecked").footer)
    #expect(try prompt("perm-subagent-rm-unchecked-cursor2").footer)
    let a = try prompt("perm-subagent-rm-unchecked"), b = try prompt("perm-subagent-rm-unchecked-cursor2")
    #expect(a.signature == b.signature, "the cursor is not the prompt")
    #expect(a.region != b.region)
  }

  /// Several sub-agents asking at once: the header gains a right-aligned `1 of 3`, and it counts up as more of them ask (`1 of 4`
  /// six seconds later, same prompt in front). The counter is not the prompt: it must not make the one on screen a new prompt (a
  /// second notice) nor restart its wait.
  @Test func theQueueCounterInTheHeaderIsNotPartOfThePrompt() throws {
    let plain = try rows("perm-subagent-rm-two-agents"), three = try rows("perm-subagent-rm-queued-3"), four = try rows("perm-subagent-rm-queued-4")
    #expect(!plain.contains { $0.hasSuffix("1 of 3") } && three.contains { $0.hasSuffix("1 of 3") } && four.contains { $0.hasSuffix("1 of 4") },
      "control: the three captures differ in the counter")
    let all = try [plain, three, four].map { try #require(PromptDetector.detect($0)) }
    #expect(Set(all.map(\.signature)).count == 1)
    #expect(Set(all.map(\.hash)).count == 1)
    #expect(Set(all.map(\.region)).count == 1)
    #expect(all.allSatisfy { $0.kind == .bashCommand })
  }

  /// The watch on those frames, one look a second: the prompt is announced once, `settle` after it first showed, and the counter
  /// going from nothing to `1 of 3` to `1 of 4` neither holds it back nor announces it again.
  @Test func aCounterThatTicksNeitherHoldsThePromptBackNorAnnouncesItTwice() throws {
    let frames = try ["perm-subagent-rm-two-agents", "perm-subagent-rm-queued-3", "perm-subagent-rm-queued-4"].map { try rows($0) }
    var watch = PromptWatch()
    var appeared: [Double] = []
    for t in 0..<30 {
      let screen = frames[min(t / 3, 2)]  // the counter changes at 3 s and at 6 s
      if case .appeared = watch.observe(PromptDetector.detect(screen), at: Double(t), settle: 5) { appeared.append(Double(t)) }
    }
    #expect(appeared == [5])
  }

  /// SYNTHETIC: digits at the end of a command row are the command. Only the header row loses a counter.
  @Test func syntheticACommandThatEndsLikeACounterIsStillTheCommand() throws {
    let base = try rows("perm-subagent-rm-withheld")
    let a = base.map { $0.contains("scripted test call") ? " echo        1 of 3" : $0 }
    let b = base.map { $0.contains("scripted test call") ? " echo        1 of 4" : $0 }
    #expect(a != b)
    #expect(try #require(PromptDetector.detect(a)).hash != (try #require(PromptDetector.detect(b))).hash)
  }

  /// A long script is not drawn: `(value cannot be shown in full …)` stands in its box. Still the Bash ask.
  @Test func aCommandTooLongToShowIsStillFound() throws {
    #expect(try rows("perm-subagent-rm-withheld").contains { $0.contains("value cannot be shown in full") }, "control")
    #expect(try prompt("perm-subagent-rm-withheld").kind == .bashCommand)
  }

  /// 2.1.322 draws the background agents UNDER the idle box's status bar (`⏺ main`, `◯ talos-builder … 4s · ↓ 36 tokens`), so the
  /// status bar is no longer the last row. It is still the idle input box: not a prompt, and a prompt that was there is over.
  @Test(arguments: ["idle-agents-panel", "idle-after-esc"])
  func theIdleBoxWithTheAgentsPanelUnderItIsIdleAndNotAPrompt(name: String) throws {
    let screen = try rows(name)
    if name == "idle-agents-panel" {
      #expect(screen.last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })?.contains("talos-builder") == true, "control: the panel is the last row")
    }
    #expect(PromptDetector.detect(screen) == nil)
    #expect(PromptDetector.isIdle(screen))
  }
}

/// What counts as a tool's ask for the hold cap (`Prompt.isTool`), on real captures; a cut-off top is SYNTHETIC (rows dropped).
@Suite("PromptDetector: a tool's ask")
struct PromptToolAskTests {
  @Test(arguments: [
    ("real-2.1.322", "perm-subagent-rm-unchecked", true), ("real-2.1.322", "perm-subagent-rm-unchecked-cursor2", true),
    ("real-2.1.318", "bash-permission", true), ("real-2.1.318", "bash-permission-cursor2", true), ("real-2.1.318", "write-permission", true),
    ("real-2.1.318", "askuser-select", false), ("real-2.1.318", "perm-askuserquestion", false), ("real-2.1.318", "onboarding-theme", false),
  ])
  func aToolsAskIsOneAndTheOwnersOwnQuestionIsNot(dir: String, name: String, tool: Bool) throws {
    #expect(try #require(PromptDetector.detect(try RealScreens.rows(name, in: dir))).isTool == tool, "\(name)")
  }

  /// SYNTHETIC: the top of the ask is off the pane (a window shorter than the prompt), so its header is gone and the kind can't be
  /// told. `Do you want to …?` over `Esc to cancel …` is still a tool's ask; the agent's question cut the same way is not.
  @Test(arguments: [("real-2.1.322", "perm-subagent-rm-unchecked", true), ("real-2.1.318", "write-permission", true), ("real-2.1.318", "askuser-select", false)])
  func withItsHeaderCutOffAToolsAskIsStillOne(dir: String, name: String, tool: Bool) throws {
    let rows = try RealScreens.rows(name, in: dir)
    let from = try #require(rows.firstIndex { $0.contains("Do you want to") || $0.contains("Which color") })
    let p = try #require(PromptDetector.detect(Array(rows[from...])), "\(name)")
    #expect(p.kind == (tool ? .other : p.kind))
    #expect(p.isTool == tool, "\(name): \(p.kind) \(String(describing: p.question))")
  }

  /// SYNTHETIC: the live pane's two status rows (a status line script's row, then the mode line with its hint pushed off by `3 shells`)
  /// above the agents' rows. Still the idle box. And the mode line's words inside a prompt's command say nothing.
  @Test func theModeLineWithoutItsHintUnderTheBoxIsIdle() throws {
    var rows = try RealScreens.rows("idle-agents-panel", in: "real-2.1.322")
    let at = try #require(rows.firstIndex { $0.contains("bypass permissions on") })
    rows[at] = "  \u{23F5}\u{23F5} bypass permissions on \u{00B7} 3 shells"
    rows.insert("  Opus 5.5 | \u{2588}\u{2588}\u{2591}\u{2591} 53% | 7d: 70%", at: at)
    #expect(PromptDetector.isIdle(rows))
    #expect(PromptDetector.detect(rows) == nil)
    let ask = try RealScreens.rows("perm-subagent-rm-withheld", in: "real-2.1.322").map {
      $0.contains("scripted test call") ? " echo bypass permissions on (shift+tab to cycle)" : $0
    }
    #expect(!PromptDetector.isIdle(ask), "a prompt is not idle, whatever its command says")
    #expect(PromptDetector.detect(ask)?.kind == .bashCommand)
  }
}

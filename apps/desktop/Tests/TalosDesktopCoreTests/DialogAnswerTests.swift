import Foundation
import Testing
@testable import TalosDesktopCore

/// Needs-you prompts: the key plan for an answer. Arrows and Enter only, never a digit; the moves come from the CURRENT cursor row of a
/// fresh read of the same dialog (the real Select starts on a different row in each dialog and wraps at its ends).
@Suite("DialogAnswer plans the keys")
struct DialogAnswerTests {
  typealias D = DialogReader.Dialog
  static func trust(_ cursor: Int?, subject: String? = "/private/tmp/p") -> D {
    D(kind: .trust, subject: subject, options: NeedsYouScreens.trustOptions, cursor: cursor)
  }
  static func mcp(_ cursor: Int?) -> D { D(kind: .mcpConsent, subject: "harmless", options: NeedsYouScreens.mcpOptions, cursor: cursor) }

  @Test func trustYesFromTheDefaultNoIsDownThenEnter() {
    #expect(DialogAnswer.plan(offered: Self.trust(0), fresh: Self.trust(0), choice: 1) == .keys([.down, .enter]))
  }

  @Test func mcpFirstOptionFromTheLastIsUpUpThenEnter() {
    #expect(DialogAnswer.plan(offered: Self.mcp(2), fresh: Self.mcp(2), choice: 0) == .keys([.up, .up, .enter]))
  }

  @Test func aCursorAlreadyOnTheChoiceIsEnterOnly() {
    #expect(DialogAnswer.plan(offered: Self.trust(0), fresh: Self.trust(1), choice: 1) == .keys([.enter]))
    #expect(DialogAnswer.plan(offered: Self.trust(0), fresh: Self.trust(0), choice: 0) == .keys([.enter]))
  }

  @Test func theMovesComeFromTheCurrentRowNotTheOfferedOne() {
    // offered with the cursor on the last row; the owner moved it to the first before the tap arrived
    #expect(DialogAnswer.plan(offered: Self.mcp(2), fresh: Self.mcp(0), choice: 2) == .keys([.down, .down, .enter]))
    #expect(DialogAnswer.plan(offered: Self.mcp(2), fresh: Self.mcp(1), choice: 0) == .keys([.up, .enter]))
  }

  @Test func neverMoreThanTheOptionsAreWide() {
    for from in 0..<3 {
      for to in 0..<3 {
        guard case .keys(let ks) = DialogAnswer.plan(offered: Self.mcp(from), fresh: Self.mcp(from), choice: to) else { Issue.record("no plan"); continue }
        #expect(ks.last == .enter && ks.filter { $0 == .enter }.count == 1)
        #expect(ks.count == abs(to - from) + 1)
        #expect(ks.dropLast().allSatisfy { $0 == (to > from ? .down : .up) }, "no wrapping: \(from) to \(to)")
      }
    }
  }

  @Test func aFreshReadThatIsNotTheSameDialogGetsNoKeys() {
    let offered = Self.trust(0)
    #expect(DialogAnswer.plan(offered: offered, fresh: nil, choice: 1) == .refuse(.unreadable))
    #expect(DialogAnswer.plan(offered: offered, fresh: Self.mcp(2), choice: 1) == .refuse(.kindChanged))
    var renamed = Self.trust(0)
    renamed.options[1] = "Yes, I trust this folder and everything in it"
    #expect(DialogAnswer.plan(offered: offered, fresh: renamed, choice: 1) == .refuse(.optionsChanged))
    var reordered = Self.trust(0)
    reordered.options = Array(NeedsYouScreens.trustOptions.reversed())
    #expect(DialogAnswer.plan(offered: offered, fresh: reordered, choice: 1) == .refuse(.optionsChanged))
    var fewer = Self.mcp(0)
    fewer.options.removeLast()
    #expect(DialogAnswer.plan(offered: Self.mcp(2), fresh: fewer, choice: 0) == .refuse(.optionsChanged))
  }

  @Test func labelsAndSubjectsAreComparedCharacterForCharacter() {
    var offered = Self.trust(0, subject: "/private/tmp/caf\u{E9}")
    offered.options[1] = "Yes, I trust caf\u{E9}"
    var fresh = offered
    fresh.options[1] = "Yes, I trust cafe\u{301}"
    #expect(DialogAnswer.plan(offered: offered, fresh: fresh, choice: 1) == .refuse(.optionsChanged))
    fresh = offered
    fresh.subject = "/private/tmp/cafe\u{301}"
    #expect(DialogAnswer.plan(offered: offered, fresh: fresh, choice: 1) == .refuse(.subjectChanged))
    #expect(DialogAnswer.plan(offered: offered, fresh: offered, choice: 1) == .keys([.down, .enter]), "control")
  }

  @Test func aSubjectTheOfferHadMustBeTheSame() {
    #expect(DialogAnswer.plan(offered: Self.trust(0), fresh: Self.trust(0, subject: "/private/tmp/other"), choice: 1) == .refuse(.subjectChanged))
    #expect(DialogAnswer.plan(offered: Self.trust(0), fresh: Self.trust(0, subject: nil), choice: 1) == .refuse(.subjectChanged))
    // an offer with no subject (it could not be read) takes whatever the screen shows
    #expect(DialogAnswer.plan(offered: Self.trust(0, subject: nil), fresh: Self.trust(0, subject: "/private/tmp/p"), choice: 1) == .keys([.down, .enter]))
  }

  @Test func aBadChoiceANoCursorAndLoginGetNoKeys() {
    #expect(DialogAnswer.plan(offered: Self.trust(0), fresh: Self.trust(0), choice: 2) == .refuse(.badChoice))
    #expect(DialogAnswer.plan(offered: Self.trust(0), fresh: Self.trust(0), choice: -1) == .refuse(.badChoice))
    #expect(DialogAnswer.plan(offered: Self.trust(0), fresh: Self.trust(nil), choice: 1) == .refuse(.noCursor))
    let login = D(kind: .login, subject: nil, options: [], cursor: nil)
    #expect(DialogAnswer.plan(offered: login, fresh: login, choice: 0) == .refuse(.noKeys))
  }

  @Test func anArrowMustMoveTheRowByExactlyOneInItsDirection() {
    #expect(DialogAnswer.moved(.down, from: 0, to: 1))
    #expect(DialogAnswer.moved(.up, from: 2, to: 1))
    #expect(!DialogAnswer.moved(.down, from: 0, to: 0), "did not move")
    #expect(!DialogAnswer.moved(.down, from: 1, to: 0), "the wrong way")
    #expect(!DialogAnswer.moved(.down, from: 0, to: 2), "two rows")
    #expect(!DialogAnswer.moved(.up, from: 0, to: 2), "a wrap is not a move")
    #expect(!DialogAnswer.moved(.down, from: 1, to: nil))
    #expect(!DialogAnswer.moved(.enter, from: 0, to: 1))
  }
}

/// The key sender: exactly Up, Down and Enter, by tmux key NAME (the pane's own cursor-key mode decides the bytes), leaving copy mode first.
@Suite("TmuxCommands sends only the three dialog keys")
struct TmuxDialogKeyTests {
  let cmds = TmuxCommands(tmux: "/usr/bin/tmux", socket: "s", configPath: "/c", session: "t-trip").withPane("%7")

  @Test func theKeysAreTheThreeByName() {
    #expect(Set(DialogKey.allCases.map(\.rawValue)) == ["Up", "Down", "Enter"])
    for k in DialogKey.allCases {
      let a = cmds.sendDialogKey(k)
      #expect(a.suffix(4) == ["send-keys", "-t", "%7", k.rawValue], "\(a)")
      #expect(!a.contains("-H") && !a.contains("-l"), "no raw bytes, no literal text: \(a)")
    }
  }

  @Test func itLeavesCopyModeInTheSameInvocation() {
    let a = cmds.sendDialogKey(.down)
    #expect(a.contains("if-shell") && a.contains("#{pane_in_mode}"))
    #expect(a.contains("send-keys -t %7 -X cancel"))
    #expect(a.contains(";"), "one tmux invocation: the cancel and the key are one command list")
    #expect(a.prefix(5) == ["/usr/bin/tmux", "-L", "s", "-f", "/c"])
  }
}

import Foundation
import Testing
import TalosDesktopCore

@testable import TalosSupervisor

/// `PaneAnswerDriver` on scripted screens: the steps of an answer, and every way it stops. No tmux: a scripted pane, a log of what was sent (the gate
/// is asked with the real `KeyGuard` against the scripted pane, so a send the gate would refuse comes back `.refused`, as `sendKey` does).
@Suite("Pane answer driver")
struct PaneAnswerDriverTests {
  final class Pane: @unchecked Sendable {
    private let lock = NSLock()
    var screens: [[String]]
    var sent: [String] = []
    var typing: PaneAnswerDriver.Blocked?
    var outcome: SendOutcome = .sent
    var reads = 0
    /// What a successful key does to the screen: the next scripted screen is drawn.
    var advance: [String: Int] = [:]
    var now = 0.0
    init(_ s: [[String]]) { screens = s }
    var current: [String]? { lock.withLock { screens.first } }
    func read() -> [String]? { lock.withLock { reads += 1; return screens.first } }
    func key(_ step: PaneAnswerDriver.Step, _ intent: KeyGuard.Intent) -> SendOutcome {
      lock.withLock {
        guard KeyGuard.refusal(screens.first, intent: intent) == nil else { return .refused }
        let name: String
        switch step {
        case .number(let n): name = "DIGIT:\(n.value)"
        case .text(let t): name = "TEXT:\(t.text)"
        case .enter: name = "ENTER"
        }
        if outcome == .sent || outcome == .unknown { sent.append(name) }
        if let n = advance[name], screens.count > 1 {
          for _ in 0..<min(n, screens.count - 1) { screens.removeFirst() }
        }
        return outcome
      }
    }
  }

  static func rows(_ n: String, synthetic: Bool = false) throws -> [String] {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/" + (synthetic ? "synthetic" : "real-2.1.318"))
    return TmuxCommands.parseCapture(try String(contentsOf: dir.appendingPathComponent(n + ".txt"), encoding: .utf8))
  }

  func driver(_ p: Pane, _ screen: PaneSelect.Screen) -> PaneAnswerDriver {
    var d = PaneAnswerDriver(
      kind: screen.kind, bound: screen.bound, freeText: screen.freeText, read: { p.read() }, typing: { p.typing }, send: { p.key($0, $1) },
      awake: { p.now })
    d.pause = { p.now += 0.5 }
    d.echoWait = 2
    return d
  }

  func screen(_ rows: [String]) throws -> PaneSelect.Screen { try #require(PaneSelect.read(rows: rows)) }

  // MARK: one key

  @Test func allowOnceIsTheYesRowsNumberAndDenyIsTheNoRowsNumber() throws {
    let tool = try Self.rows("bash-permission"), s = try screen(tool), idle = try Self.rows("empty-input")
    let allow = Pane([tool, idle]), deny = Pane([tool, idle])
    allow.advance = ["DIGIT:1": 1]
    deny.advance = ["DIGIT:4": 1]
    #expect(driver(allow, s).run(option: 0, text: nil) == .delivered && allow.sent == ["DIGIT:1"])
    #expect(driver(deny, s).run(option: 1, text: nil) == .delivered && deny.sent == ["DIGIT:4"])
    // the rows between them (always allow, auto mode) have no option and so no key
    for bad in [2, 3, -1] {
      let p = Pane([tool])
      #expect(driver(p, s).run(option: bad, text: nil) == .changed && p.sent.isEmpty, "\(bad)")
    }
    // the numbers come from the rows as read: a screen with Yes / No only presses 2 for No
    let short = try Self.rows("perm-ask-rule-bypass"), sShort = try screen(short)
    let p = Pane([short, idle])
    p.advance = ["DIGIT:2": 1]
    #expect(driver(p, sShort).run(option: 1, text: nil) == .delivered && p.sent == ["DIGIT:2"])
  }

  @Test func theChatRowIsNotAnOptionAndHasNoKey() throws {
    let ask = try Self.rows("askuser-select"), s = try screen(ask)
    let p = Pane([ask])
    #expect(driver(p, s).run(option: 3, text: nil) == .changed && p.sent.isEmpty)
  }

  @Test func aQuestionOptionPressesItsOwnNumberIncludingTheOneUnderTheSecondRule() throws {
    let ask = try Self.rows("askuser-select"), s = try screen(ask), idle = try Self.rows("empty-input")
    for (opt, key) in [(0, "DIGIT:1"), (1, "DIGIT:2")] {
      let p = Pane([ask, idle])
      p.advance = [key: 1]
      #expect(driver(p, s).run(option: opt, text: nil) == .delivered && p.sent == [key], "\(opt)")
    }
  }

  @Test func aKeyThatTimedOutIsUnknownAndOneThatFailedOrWasRefusedIsNotSent() throws {
    let tool = try Self.rows("bash-permission"), s = try screen(tool)
    let slow = Pane([tool, try Self.rows("empty-input")])
    slow.outcome = .unknown
    #expect(driver(slow, s).run(option: 0, text: nil) == .unknown)
    for o in [SendOutcome.failed, .refused] {
      let p = Pane([tool])
      p.outcome = o
      #expect(driver(p, s).run(option: 0, text: nil) == .changed && p.sent.isEmpty, "\(o)")
    }
  }

  // MARK: the screen is not the offered one

  /// The key was sent and the prompt is STILL there: the digit did not take (it is only assumed to choose a row). That is not an answer that stood: it is
  /// delivery unknown, so the offer is shown again after a short memory and nothing is reported as done.
  @Test func aKeyAfterWhichThePromptIsStillThereIsNotAnAnswerThatStood() throws {
    let tool = try Self.rows("bash-permission"), s = try screen(tool)
    let p = Pane([tool])
    #expect(driver(p, s).run(option: 0, text: nil) == .unknown && p.sent == ["DIGIT:1"])
    // and a pane that cannot be read afterwards says nothing: not "gone"
    var d = driver(Pane([tool]), s)
    final class Reads: @unchecked Sendable { var n = 0 }
    let r = Reads()
    d.read = {
      r.n += 1
      return r.n <= 2 ? tool : nil
    }
    #expect(d.run(option: 0, text: nil) == .unknown)
  }

  @Test func aScreenThatChangedSinceTheOfferPressesNothingAtEachLook() throws {
    let tool = try Self.rows("bash-permission"), other = try Self.rows("bash-permission-other", synthetic: true)
    let s = try screen(tool)
    // changed before the first look
    let a = Pane([other])
    #expect(driver(a, s).run(option: 0, text: nil) == .changed && a.sent.isEmpty)
    // between the first look and the last look, straight before the key
    final class Flip: @unchecked Sendable { var n = 0 }
    let flip = Flip()
    let p = Pane([tool])
    var d = driver(p, s)
    d.read = {
      flip.n += 1
      return flip.n >= 2 ? other : tool
    }
    #expect(d.run(option: 0, text: nil) == .changed && p.sent.isEmpty, "the last look is another prompt")
    // unreadable, the usage-limit menu
    var e = driver(Pane([tool]), s)
    e.read = { nil }
    #expect(e.run(option: 0, text: nil) == .changed)
    let limit = Pane([try Self.rows("usage-limit", synthetic: true)])
    #expect(driver(limit, s).run(option: 0, text: nil) == .changed && limit.sent.isEmpty)
  }

  @Test func aPersonTypingInThePaneBlocksEveryKeyAndASendThatCannotBeCheckedIsNotMade() throws {
    let tool = try Self.rows("bash-permission"), s = try screen(tool)
    for b in [PaneAnswerDriver.Blocked.typing, .unreadable] {
      let p = Pane([tool])
      p.typing = b
      #expect(driver(p, s).run(option: 0, text: nil) == .blocked(b) && p.sent.isEmpty)
    }
  }

  // MARK: free text

  @Test func otherIsTheNumberThenTheWordsThenEnterEachOnAFreshRead() throws {
    let ask = try Self.rows("askuser-select"), onText = try Self.rows("askuser-cursor-on-text", synthetic: true), typed = try Self.rows("askuser-typed", synthetic: true)
    let s = try screen(ask)
    let p = Pane([ask, onText, typed, try Self.rows("empty-input")])
    p.advance = ["DIGIT:3": 1, "TEXT:purple": 1, "ENTER": 1]
    #expect(driver(p, s).run(option: 2, text: "purple") == .delivered)
    #expect(p.sent == ["DIGIT:3", "TEXT:purple", "ENTER"], "\(p.sent)")
  }

  @Test func theWordsAreNotTypedUnlessTheFieldTookFocusAndNotEnteredUnlessTheyShow() throws {
    let ask = try Self.rows("askuser-select"), onText = try Self.rows("askuser-cursor-on-text", synthetic: true)
    let s = try screen(ask)
    // the digit did nothing (the field never took focus): nothing more is sent
    let a = Pane([ask])
    #expect(driver(a, s).run(option: 2, text: "purple") == .partial && a.sent == ["DIGIT:3"])
    // the field took focus, but the words never show: no Enter
    let b = Pane([ask, onText])
    b.advance = ["DIGIT:3": 1]
    #expect(driver(b, s).run(option: 2, text: "purple") == .partial && b.sent == ["DIGIT:3", "TEXT:purple"], "\(b.sent)")
    // the screen became another prompt after the digit: the words are not typed
    let c = Pane([ask, try Self.rows("askuser-multi", synthetic: true)])
    c.advance = ["DIGIT:3": 1]
    #expect(driver(c, s).run(option: 2, text: "purple") == .partial && c.sent == ["DIGIT:3"], "\(c.sent)")
  }

  @Test func theTextGoesOnlyWithTheFreeTextOptionAndIsOnlyCleanWords() throws {
    let ask = try Self.rows("askuser-select"), s = try screen(ask)
    for (opt, text) in [(0, "x"), (2, nil), (2, ""), (2, "two\nlines"), (2, "a\u{1B}[31mb"), (2, String(repeating: "z", count: 501)), (2, "a\u{202E}b")] as [(Int, String?)] {
      let p = Pane([ask])
      #expect(driver(p, s).run(option: opt, text: text) == .changed && p.sent.isEmpty, "\(opt) \(String(describing: text))")
    }
    // a tool permission has no free text at all
    let tool = try Self.rows("bash-permission")
    let p = Pane([tool])
    #expect(driver(p, try screen(tool)).run(option: 0, text: "x") == .changed && p.sent.isEmpty)
  }
}

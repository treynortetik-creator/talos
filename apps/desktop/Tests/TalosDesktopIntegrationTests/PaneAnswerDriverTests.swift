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
        case .escape: name = "ESC"
        case .backspaces(let n): name = "BSPACE:\(n)"
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

  // MARK: the usage-limit card (row 7)

  static func usage(_ n: String) throws -> [String] { try rows(n, synthetic: true) }
  static func typed(_ rows: [String], _ text: String) -> [String] { rows.map { r in r.hasPrefix("❯") && r.dropFirst().allSatisfy { $0 == " " || $0 == "\u{00A0}" } ? "❯\u{00A0}" + text : r } }

  @Test func waitForResetIsOneEscapeOnTheMenuItWasMadeFor() throws {
    let menu = try Self.usage("usage-limit"), idle = try Self.usage("usage-limit-after-esc"), s = try screen(menu)
    let p = Pane([menu, idle])
    p.advance = ["ESC": 1]
    #expect(driver(p, s).run(option: 0, text: nil) == .delivered)
    #expect(p.sent == ["ESC"], "one Escape: no digit, no arrow, no Enter, no text")
  }

  @Test func switchModelIsEscapeThenSlashModelThenEnterEachOnItsOwnLook() throws {
    let menu = try Self.usage("usage-limit"), idle = try Self.usage("usage-limit-after-esc"), s = try screen(menu)
    let p = Pane([menu, idle, Self.typed(idle, "/model"), idle])
    p.advance = ["ESC": 1, "TEXT:/model": 1, "ENTER": 1]
    #expect(driver(p, s).run(option: 1, text: nil) == .delivered)
    #expect(p.sent == ["ESC", "TEXT:/model", "ENTER"])
  }

  @Test func aMenuThatChangedPressesNothingAndNoDigitIsEverSent() throws {
    let menu = try Self.usage("usage-limit"), other = try Self.usage("usage-limit-session"), s = try screen(menu)
    let p = Pane([other])
    #expect(driver(p, s).run(option: 0, text: nil) == .changed && p.sent.isEmpty)
    // an option the card does not have (the credits row's number, a third button, a negative index) has no key
    for bad in [2, 3, -1] {
      let q = Pane([menu])
      #expect(driver(q, s).run(option: bad, text: nil) == .changed && q.sent.isEmpty, "\(bad)")
    }
    // and no words travel with a usage-limit answer
    let r = Pane([menu])
    #expect(driver(r, s).run(option: 1, text: "rm -rf /") == .changed && r.sent.isEmpty)
    // a screen with no model has no Switch model button
    let session = try Self.usage("usage-limit-session"), sSession = try screen(session)
    let t = Pane([session])
    #expect(driver(t, sSession).run(option: 1, text: nil) == .changed && t.sent.isEmpty)
  }

  @Test func someoneTypingStopsItBeforeTheEscape() throws {
    let menu = try Self.usage("usage-limit"), s = try screen(menu)
    let p = Pane([menu])
    p.typing = .typing
    #expect(driver(p, s).run(option: 0, text: nil) == .blocked(.typing) && p.sent.isEmpty)
  }

  @Test func anEscapeThatTookNoEffectIsUnknownAndASwitchStopsAfterIt() throws {
    let menu = try Self.usage("usage-limit"), s = try screen(menu)
    // the menu is still there after a confirmed Escape: not an answer that stood
    let stuck = Pane([menu])
    #expect(driver(stuck, s).run(option: 0, text: nil) == .unknown && stuck.sent == ["ESC"])
    // a Switch model whose Escape did not take sends nothing more, and says so as unconfirmed (the menu may not be closed)
    let sw = Pane([menu])
    #expect(driver(sw, s).run(option: 1, text: nil) == .unknown && sw.sent == ["ESC"])
    // an Escape whose delivery is unknown: no second key
    let slow = Pane([menu, try Self.usage("usage-limit-after-esc")])
    slow.outcome = .unknown
    #expect(driver(slow, s).run(option: 1, text: nil) == .unknown && slow.sent == ["ESC"])
  }

  @Test func theTypingAndTheEnterAreRefusedWhenThePromptAfterEscapeIsNotThatLimits() throws {
    let menu = try Self.usage("usage-limit"), s = try screen(menu)
    // after Escape the pane shows another limit's headline: /model is not typed
    let otherIdle = try Self.usage("usage-limit-after-esc").map { $0.replacingOccurrences(of: "Fable", with: "Opus") }
    let p = Pane([menu, otherIdle])
    p.advance = ["ESC": 1]
    #expect(driver(p, s).run(option: 1, text: nil) == .usageStopped(.closed) && p.sent == ["ESC"])
    // the words never reached the box: no Enter
    let idle = try Self.usage("usage-limit-after-esc")
    let q = Pane([menu, idle])
    q.advance = ["ESC": 1]
    #expect(driver(q, s).run(option: 1, text: nil) == .usageStopped(.closed) && q.sent == ["ESC", "TEXT:/model"])
  }

  /// R1-2: the Enter was refused (the cursor of Claude's list is on /memory), `/model` is in the box: guarded Backspaces take it out, and it is said as it is.
  @Test func anEnterThatIsRefusedIsFollowedByBackspacesAndSaidAsClosedAndCleared() throws {
    let menu = try Self.usage("usage-limit"), idle = try Self.usage("usage-limit-after-esc"), s = try screen(menu)
    let memory = ["  ❯ /memory       Edit memory files", "    /model        Set the AI model"]
    func withList(_ r: [String]) -> [String] { Array(r[...r.lastIndex(where: { $0.hasPrefix("────") })!]) + memory }
    let typedList = withList(Self.typed(idle, "/model"))
    let p = Pane([menu, idle, typedList, idle])
    p.advance = ["ESC": 1, "TEXT:/model": 1, "BSPACE:6": 1]
    #expect(driver(p, s).run(option: 1, text: nil) == .usageStopped(.cleared))
    #expect(p.sent == ["ESC", "TEXT:/model", "BSPACE:6"], "no Enter, and the Backspaces once: \(p.sent)")
    // the Backspaces went and the words are still there
    let stuck = Pane([menu, idle, typedList])
    stuck.advance = ["ESC": 1, "TEXT:/model": 1]
    #expect(driver(stuck, s).run(option: 1, text: nil) == .usageStopped(.typed))
    #expect(stuck.sent == ["ESC", "TEXT:/model", "BSPACE:6"])
    // someone typing in the pane after the words went in: no Enter and no Backspace, and it says /model is still there
    let busy = Pane([menu, idle, Self.typed(idle, "/model")])
    busy.advance = ["ESC": 1, "TEXT:/model": 1]
    var d = driver(busy, s)
    final class Calls: @unchecked Sendable { var n = 0 }
    let c = Calls()
    d.typing = { c.n += 1; return c.n >= 4 ? .typing : nil }
    #expect(d.run(option: 1, text: nil) == .usageStopped(.typed))
    #expect(busy.sent == ["ESC", "TEXT:/model"], "\(busy.sent)")
    // the box holds something else by then (the owner typed): the guard refuses the Backspaces, so nothing of theirs is deleted
    let theirs = Pane([menu, idle, withList(Self.typed(idle, "/model and my own words"))])
    theirs.advance = ["ESC": 1, "TEXT:/model": 1]
    #expect(driver(theirs, s).run(option: 1, text: nil) == .usageStopped(.closed))
    #expect(theirs.sent == ["ESC", "TEXT:/model"], "no Enter and no Backspace on words that are not ours: \(theirs.sent)")
  }
}

import CoreGraphics
import Foundation
import Testing
@testable import TalosDesktopCore

/// Typing text: the per-key path (a character becomes the key that makes it, the way screen_key presses one), the whole-text
/// Unicode fallback, and the honest read-back (verified, could not verify, did not land).
@Suite("Screen type: key path and honest reply")
struct ScreenTypeTests {
  // MARK: the per-key path

  /// A US keyboard layout from the hotkey table's key codes: what a key makes, plain or with shift.
  static let shiftedSymbols: [String: String] = [
    "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+", "[": "{",
    "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?", "`": "~",
  ]
  static let namesByCode: [UInt16: String] = Dictionary(uniqueKeysWithValues: HotkeySpec.keys.map { (UInt16($0.value), $0.key) })

  static func us(_ code: UInt16, _ shift: Bool) -> ScreenKeyLayout.KeyOutput? {
    guard let name = namesByCode[code] else { return nil }
    switch name {
    case "return": return .init(text: "\r")
    case "tab": return .init(text: "\t")
    case "space": return .init(text: " ")
    default:
      guard name.count == 1 else { return nil }
      return .init(text: shift ? (shiftedSymbols[name] ?? name.uppercased()) : name)
    }
  }

  static let layout = ScreenKeyLayout.build(translate: us)

  static func key(_ name: String, shift: Bool = false) -> ScreenKeyCombo {
    ScreenKeyCombo(keyCode: UInt16(HotkeySpec.keys[name]!), flags: shift ? ScreenKeyCombo.shift : 0)
  }

  static func pieces(_ text: String, _ layout: ScreenKeyLayout = layout) -> [[ScreenKeyCombo]]? {
    layout.pieces(for: text, maxKeys: ScreenCore.textChunkUnits)
  }

  @Test func plainCharactersBecomeTheirKeys() {
    #expect(Self.pieces("hi 5") == [[Self.key("h"), Self.key("i"), Self.key("space"), Self.key("5")]])
    #expect(Self.pieces("a.b/c") == [[Self.key("a"), Self.key("."), Self.key("b"), Self.key("/"), Self.key("c")]])
  }

  @Test func shiftedCharactersAreTheirKeyWithShift() {
    #expect(Self.pieces("Ab") == [[Self.key("a", shift: true), Self.key("b")]])
    #expect(Self.pieces("!?_") == [[Self.key("1", shift: true), Self.key("/", shift: true), Self.key("-", shift: true)]])
    #expect(Self.pieces("\"{") == [[Self.key("'", shift: true), Self.key("[", shift: true)]])
  }

  @Test func aNewlineIsTheReturnKeyAndATabIsTheTabKeyAndEachEndsItsPiece() {
    #expect(Self.pieces("a\nb") == [[Self.key("a"), Self.key("return")], [Self.key("b")]])
    #expect(Self.pieces("\r\n") == [[Self.key("return")]], "a CRLF is one Character, one Return")
    #expect(Self.pieces("\r") == [[Self.key("return")]])
    #expect(Self.pieces("a\tb\n") == [[Self.key("a"), Self.key("tab")], [Self.key("b"), Self.key("return")]])
    #expect(Self.pieces("\n\n") == [[Self.key("return")], [Self.key("return")]])
  }

  @Test func aLongRunIsCutIntoPiecesOfAtMostMaxKeys() {
    let p = Self.layout.pieces(for: String(repeating: "a", count: 7), maxKeys: 3)
    #expect(p?.map(\.count) == [3, 3, 1])
  }

  @Test func oneCharacterWithNoKeyMakesTheWholeTextUnicode() {
    #expect(Self.pieces("é") == nil)
    #expect(Self.pieces("hello €") == nil, "plain letters before it do not make it a mix")
    #expect(Self.pieces("a\nb😀") == nil, "the newline goes as Unicode too, not as Return")
  }

  @Test func anUnusableLayoutTypesNothingAsKeysNotEvenReturnOrTab() {
    #expect(Self.pieces("ab", .empty) == nil)
    #expect(Self.pieces("\n", .empty) == nil)
    #expect(Self.pieces("\t", .empty) == nil)
  }

  @Test func theLayoutNeverMakesAControlCharacterOrAModifierOtherThanShift() {
    let weird = ScreenKeyLayout.build { code, shift in
      code == 0 ? .init(text: "\u{1}") : code == 1 ? .init(text: shift ? "S" : "") : code == 2 ? .init(text: "ab") : nil
    }
    #expect(Self.pieces("\u{1}", weird) == nil)
    #expect(Self.pieces("S", weird) == [[ScreenKeyCombo(keyCode: 1, flags: ScreenKeyCombo.shift)]])
    #expect(Self.pieces("ab", weird) == nil, "a key that makes two characters makes neither")
    for piece in Self.pieces("Ab!?\n \t") ?? [] {
      for k in piece { #expect(k.flags & ~ScreenKeyCombo.shift == 0) }
    }
  }

  @Test func aDeadKeyIsNotInTheLayout() {
    // a US-style layout where the key for "e" is also reachable as a dead key (the accent on code 14 with shift), and one key
    // that makes a character but leaves a dead-key state
    let withDead = ScreenKeyLayout.build { code, shift in
      switch (code, shift) {
      case (14, false): return .init(text: "e")
      case (14, true): return .init(text: "", deadKeyState: 7)  // a dead key: no character, a state left
      case (0, false): return .init(text: "´", deadKeyState: 9)  // makes a standalone accent and leaves a state
      case (0, true): return .init(text: "A")
      default: return nil
      }
    }
    #expect(Self.pieces("e", withDead) == [[ScreenKeyCombo(keyCode: 14, flags: 0)]])
    #expect(Self.pieces("´", withDead) == nil, "the accent mark of a dead key is typed as Unicode, not by pressing the dead key")
    #expect(Self.pieces("A", withDead) == [[ScreenKeyCombo(keyCode: 0, flags: ScreenKeyCombo.shift)]])
  }

  @Test func aCharacterReachableWithoutShiftNeverUsesShift() {
    // two keys make the same character: the plain one wins
    let dup = ScreenKeyLayout.build { code, shift in
      code == 0 ? .init(text: shift ? "q" : "z") : code == 1 ? .init(text: shift ? "x" : "q") : nil
    }
    #expect(Self.pieces("q", dup) == [[ScreenKeyCombo(keyCode: 1, flags: 0)]])
  }

  // MARK: the events of a typed request

  func core(_ input: FakeInput, apps: FakeApps = FakeApps(front: Fx.notes), layout: ScreenKeyLayout? = ScreenTypeTests.layout) -> ScreenCore {
    var c = Fx.core(input: input, apps: apps)
    if let layout { c.layout = { layout } }
    return c
  }

  @Test func textWithEveryKeyGoesAsKeyEventsEndingAtEachReturn() throws {
    let input = FakeInput()
    #expect(try core(input).perform(.type("ls\nx"), allowed: .ids(["com.example.notes"])) == 2)
    #expect(input.posted == [.keys([Self.key("l"), Self.key("s"), Self.key("return")]), .keys([Self.key("x")])])
  }

  @Test func textWithAnyCharacterWithoutAKeyGoesWhollyAsUnicodeNewlinesIncluded() throws {
    let input = FakeInput()
    #expect(try core(input).perform(.type("ab\n€"), allowed: .ids(["com.example.notes"])) == 1)
    #expect(input.posted == [.text("ab\n€")])
    let again = FakeInput()
    _ = try core(again, layout: .empty).perform(.type("hi\n"), allowed: .ids(["com.example.notes"]))
    #expect(again.posted == [.text("hi\n")], "no usable layout: Unicode, and a newline is not a Return")
  }

  @Test func eachReturnIsFollowedByAFreshGateBeforeMoreKeysGo() throws {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    // the first piece ends at the Return; after it the keyboard is somewhere else (the front app is still the same)
    let moved = LockedValue(false)
    input.after = { _ in moved.value = true }
    a.focus = { moved.value ? 999 : Fx.notes.pid }
    let c = core(input, apps: a)
    #expect(throws: ScreenRefusal.focusElsewhere(app: "Notes Example")) { try c.perform(.type("a\nbcd"), allowed: .ids(["com.example.notes"])) }
    #expect(input.posted == [.keys([Self.key("a"), Self.key("return")])], "nothing after the Return was typed")
  }

  // MARK: the honest reply

  /// The field's value as the focused element gives it, one value per read; the last one repeats. The first read is the one
  /// before typing.
  final class Reads: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String?]
    private var _count = 0
    var count: Int { lock.withLock { _count } }
    init(_ values: [String?]) { self.values = values }
    func next() -> String? {
      lock.withLock {
        _count += 1
        return values.count > 1 ? values.removeFirst() : values[0]
      }
    }
  }

  func typed(_ text: String, reads: [String?], layout: ScreenKeyLayout? = ScreenTypeTests.layout) throws -> ScreenCore.ReadBack {
    let a = FakeApps(front: Fx.notes)
    let r = Reads(reads)
    a.value = { _ in r.next() }
    return try core(FakeInput(), apps: a, layout: layout).typeText(text, allowed: .ids(["com.example.notes"])).readBack
  }

  @Test func aFieldThatCannotBeReadIsUnverified() throws {
    #expect(try typed("hello", reads: [nil]) == .unverified)
    // readable after but not before: nothing to compare with
    #expect(try typed("hello", reads: [nil, "hello"]) == .unverified)
    // readable before but not after
    #expect(try typed("hello", reads: ["", nil]) == .unverified)
  }

  @Test func aFieldThatDidNotChangeIsNotLanded() throws {
    #expect(try typed("hello", reads: ["abc", "abc"]) == .unchanged)
  }

  @Test func textThatWasAlreadyInTheFieldDoesNotVerifyTypingThatChangedNothing() throws {
    // a terminal's whole buffer already holds the word: the word being in it proves nothing
    #expect(try typed("ls", reads: ["$ ls\nfile", "$ ls\nfile"]) == .unchanged)
    // something else changed but the text did not arrive one more time
    #expect(try typed("ls", reads: ["$ ls\nfile", "$ ls\nfile\n12:00"]) == .mismatch(suffix: "$ ls\nfile\n12:00"))
  }

  @Test func textThatArrivedIsVerified() throws {
    #expect(try typed("hello", reads: ["", "hello"]) == .verified)
    #expect(try typed("ls", reads: ["$ ls\nfile\n$ ", "$ ls\nfile\n$ ls"]) == .verified, "one more time than before")
  }

  @Test func textWithNewlinesIsVerifiedByItsLinesWhenTheyShowAndOtherwiseSaysItWasAReturn() throws {
    #expect(try typed("echo hi\n", reads: ["$ ", "$ echo hi\nhi\n$ "]) == .verified)
    #expect(try typed("one\ntwo", reads: ["", "one\ntwo"]) == .verified)
    // a Return may have submitted and cleared the field: unchanged or changed otherwise is not a failure, and says nothing
    #expect(try typed("one\ntwo", reads: ["", "one"]) == .unverifiedReturn)
    #expect(try typed("hello\n", reads: ["draft", "draft"]) == .unverifiedReturn, "never 'did not land' for text with a Return")
    #expect(try typed("hello\n", reads: [nil]) == .unverified)
  }

  @Test func textWithANewlineTypedAsUnicodeIsNeverVerified() throws {
    // a Unicode newline may or may not be a Return to the app, so even a field that shows the lines proves nothing
    #expect(try typed("one\ntwo", reads: ["", "one\ntwo"], layout: .empty) == .unverifiedReturn)
    #expect(try typed("hello\n", reads: [nil], layout: .empty) == .unverifiedReturn)
    #expect(try typed("hello", reads: ["", "hello"], layout: .empty) == .verified, "no newline: read back as usual")
  }

  @Test func aChangeThatIsNotTheTextIsAMismatchWithTheEndOfTheField() throws {
    let long = String(repeating: "x", count: 100) + "END"
    #expect(try typed("hello", reads: ["", long]) == .mismatch(suffix: String(long.suffix(ScreenCore.readBackSuffix))))
  }

  @Test func theFieldIsReadAgainWhileTheAppCatchesUp() throws {
    let a = FakeApps(front: Fx.notes)
    let r = Reads(["", "", "", "hello"])  // before, then three looks: the text shows on the last one
    a.value = { _ in r.next() }
    var c = core(FakeInput(), apps: a)
    let waits = LockedValue<[Double]>([])
    c.pause = { s in waits.value.append(s) }
    #expect(try c.typeText("hello", allowed: .ids(["com.example.notes"])).readBack == .verified)
    #expect(r.count == 4)
    #expect(waits.value.filter { $0 == ScreenCore.readBackSettleSeconds }.count == 3, "a wait before each look: \(waits.value)")
  }

  @Test func aVerifiedReadStopsLooking() throws {
    let a = FakeApps(front: Fx.notes)
    let r = Reads(["", "hello"])
    a.value = { _ in r.next() }
    #expect(try core(FakeInput(), apps: a).typeText("hello", allowed: .ids(["com.example.notes"])).readBack == .verified)
    #expect(r.count == 2)
  }

  @Test func theFieldAfterMustBeTheSameElementAsBefore() throws {
    let a = FakeApps(front: Fx.notes)
    let r = Reads(["", "hello"])
    let calls = LockedValue(0)
    a.value = { _ in r.next() }
    a.element = { _ in calls.value += 1; return calls.value }  // each read finds another element
    #expect(try core(FakeInput(), apps: a).typeText("hello", allowed: .ids(["com.example.notes"])).readBack == .unverified)
    // the same element on both reads
    a.element = { _ in 5 }
    let r2 = Reads(["", "hello"])
    a.value = { _ in r2.next() }
    #expect(try core(FakeInput(), apps: a).typeText("hello", allowed: .ids(["com.example.notes"])).readBack == .verified)
  }

  // MARK: the read before the gate

  @Test func theFieldIsReadBeforeTheGateAndNothingIsReadBetweenTheGateAndThePost() throws {
    final class Log: @unchecked Sendable {
      private let lock = NSLock()
      private var _e: [String] = []
      var events: [String] { lock.withLock { _e } }
      func add(_ s: String) { lock.withLock { _e.append(s) } }
    }
    let log = Log()
    let input = FakeInput()
    input.after = { _ in log.add("post") }
    let a = FakeApps(front: Fx.notes)
    a.focus = { log.add("gate"); return Fx.notes.pid }
    a.value = { _ in log.add("read"); return "" }
    var c = core(input, apps: a)
    c.pause = { _ in }
    _ = try c.typeText("hi", allowed: .ids(["com.example.notes"]))
    #expect(Array(log.events.prefix(3)) == ["read", "gate", "post"], "\(log.events)")
  }

  @Test func aFieldReadBeforeTheGateOfAnotherAppIsNotUsed() throws {
    let a = FakeApps(front: Fx.notes)
    let r = Reads(["", "hello"])
    a.value = { _ in r.next() }
    // call 1 is the read before the gate: the front becomes the other allowed app before the gate (call 2) reads it
    a.onFrontmost = { n in if n == 2 { a.front = Fx.secret } }
    let c = core(FakeInput(), apps: a)
    #expect(try c.typeText("hello", allowed: .ids(["com.example.notes", "com.example.secret"])).readBack == .unverified)
  }

  @Test func aFrontAppThatIsNotAllowedIsNotReadBeforeTheGate() throws {
    let a = FakeApps(front: Fx.secret)
    let reads = LockedValue<[Int32]>([])
    a.value = { pid in reads.value.append(pid); return "" }
    #expect(throws: ScreenRefusal.self) { try core(FakeInput(), apps: a).typeText("hello", allowed: .ids(["com.example.notes"])) }
    #expect(reads.value.isEmpty)
  }
}

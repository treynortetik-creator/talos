import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("HotkeySpec")
struct HotkeySpecTests {
  @Test func theDefaultParsesToCarbonNumbers() throws {
    let s = try HotkeySpec.parse("ctrl+opt+space")
    #expect(s.keyCode == 49)
    #expect(s.modifiers == HotkeySpec.ctrl | HotkeySpec.opt)
    #expect(s.text == "ctrl+opt+space")
    #expect(s.display == "⌃⌥Space")
  }

  @Test func orderAndCaseDontMatterAndTheTextIsCanonical() throws {
    let a = try HotkeySpec.parse("Option+Control+Space")
    let b = try HotkeySpec.parse("ctrl+opt+space")
    #expect(a == b)
    #expect(try HotkeySpec.parse("cmd+shift+k").text == "shift+cmd+k")
    #expect(try HotkeySpec.parse(" ctrl + alt + j ").text == "ctrl+opt+j")
  }

  @Test func roundTripsEveryKeyName() throws {
    for name in HotkeySpec.keys.keys {
      let s = try HotkeySpec.parse("ctrl+opt+" + name)
      #expect(try HotkeySpec.parse(s.text) == s, "\(name)")
    }
  }

  @Test func refusesBadInput() {
    #expect(throws: HotkeySpec.ParseError.empty) { try HotkeySpec.parse("") }
    #expect(throws: HotkeySpec.ParseError.needsModifier) { try HotkeySpec.parse("space") }
    #expect(throws: HotkeySpec.ParseError.needsModifier) { try HotkeySpec.parse("shift+a") }
    #expect(throws: HotkeySpec.ParseError.needsTwoModifiers) { try HotkeySpec.parse("ctrl+j") }
    #expect(throws: HotkeySpec.ParseError.needsTwoModifiers) { try HotkeySpec.parse("cmd+q") }
    #expect(throws: HotkeySpec.ParseError.tooManyKeys) { try HotkeySpec.parse("ctrl+a+b") }
    #expect(throws: HotkeySpec.ParseError.unknownKey("banana")) { try HotkeySpec.parse("ctrl+banana") }
    #expect(throws: HotkeySpec.ParseError.unknownModifier("hyper")) { try HotkeySpec.parse("hyper+a") }
    #expect(throws: HotkeySpec.ParseError.empty) { try HotkeySpec.parse("ctrl+opt") }
    #expect(throws: HotkeySpec.ParseError.unknownKey("")) { try HotkeySpec.parse("ctrl++a") }
    #expect(throws: HotkeySpec.ParseError.reserved("opt+cmd+esc")) { try HotkeySpec.parse("cmd+opt+esc") }
    #expect(throws: HotkeySpec.ParseError.reserved("shift+cmd+4")) { try HotkeySpec.parse("cmd+shift+4") }
    #expect(throws: HotkeySpec.ParseError.reserved("ctrl+cmd+q")) { try HotkeySpec.parse("q+cmd+ctrl") }
  }

  @Test func aKeyPressBecomesASpecOnlyWhenAllowed() {
    #expect(HotkeySpec.from(keyCode: 49, carbonModifiers: HotkeySpec.ctrl | HotkeySpec.opt)?.text == "ctrl+opt+space")
    #expect(HotkeySpec.from(keyCode: 49, carbonModifiers: 0) == nil)
    #expect(HotkeySpec.from(keyCode: 12, carbonModifiers: HotkeySpec.cmd) == nil)  // cmd+q
    #expect(HotkeySpec.from(keyCode: 8, carbonModifiers: HotkeySpec.cmd) == nil)  // cmd+c would break copy everywhere
    #expect(HotkeySpec.from(keyCode: 200, carbonModifiers: HotkeySpec.ctrl) == nil)
    #expect(HotkeySpec.from(keyCode: 0, carbonModifiers: 0xFFFF_FFFF)?.modifiers == HotkeySpec.cmd | HotkeySpec.shift | HotkeySpec.opt | HotkeySpec.ctrl)
  }

  @Test func functionKeysNeedNoModifier() throws {
    #expect(try HotkeySpec.parse("f5").keyCode == 96)
  }
}

@Suite("ComposeRules")
struct ComposeRulesTests {
  let known = ["general", "inbox", "work"]

  @Test func whitespaceOnlyIsRefused() {
    for t in ["", "   ", "\n\t \n"] {
      #expect(ComposeRules.check(text: t, threadId: "general", known: known) == .failure(.empty))
    }
  }

  @Test func aGoodMessageIsTrimmedAndKeepsItsInnerText() throws {
    let r = ComposeRules.check(text: "  line one\n\nline two \n", threadId: "work", known: known)
    #expect(try r.get().text == "line one\n\nline two")
    #expect(try r.get().thread == "work")
  }

  @Test func limitsAndUnknownThreads() {
    #expect(ComposeRules.check(text: String(repeating: "a", count: 32_001), threadId: "general", known: known) == .failure(.tooLong))
    #expect(ComposeRules.check(text: String(repeating: "a", count: 32_000), threadId: "general", known: known) != .failure(.tooLong))
    #expect(ComposeRules.check(text: "hi", threadId: "nope", known: known) == .failure(.unknownThread))
    #expect(ComposeRules.check(text: "hi", threadId: nil, known: known) == .failure(.unknownThread))
    #expect(ComposeRules.check(text: "hi", threadId: "All", known: ["All"]) == .failure(.unknownThread))
  }

  @Test func theResultAlwaysPassesTheWebAppsOwnRules() throws {
    let ok = try ComposeRules.check(text: "hello", threadId: "inbox", known: known).get()
    #expect(NativeToWeb.validated(.compose(threadId: ok.thread, text: ok.text)) != nil)
  }

  @Test func equalThreadNamesGetDistinctLabels() {
    let t = [("general", "General"), ("t_a", "A thread"), ("work", "Work"), ("t_b", "A thread"), ("t_c", "A thread")]
      .map { WebToNative.Thread(id: $0.0, name: $0.1) }
    let l = ComposeRules.labels(t)
    #expect(l == ["General", "A thread", "Work", "A thread 2", "A thread 3"])
    #expect(Set(l).count == l.count)
    // a real thread already called "A thread 2" still ends up distinct
    let u = ComposeRules.labels(["A thread", "A thread", "A thread 2"].enumerated().map { WebToNative.Thread(id: "t\($0.offset)", name: $0.element) })
    #expect(Set(u).count == 3)
  }

  @Test func lastUsedThreadComesFirst() {
    let t = known.map { WebToNative.Thread(id: $0, name: $0.capitalized) }
    #expect(ComposeRules.order(t, lastUsed: "work").map(\.id) == ["work", "general", "inbox"])
    #expect(ComposeRules.order(t, lastUsed: "general").map(\.id) == known)
    #expect(ComposeRules.order(t, lastUsed: "ghost").map(\.id) == known)
    #expect(ComposeRules.order(t, lastUsed: nil).map(\.id) == known)
  }
}

@Suite("Quick compose after a send")
struct BoxAfterSendTests {
  // (box when the answer comes back, message that went out, box kept; nil = the box empties)
  @Test(arguments: [
    ("It is a new note", "I", "It is a new note"),  // starts with the sent word: a different note
    ("Ok so the plan changed", "Ok", "Ok so the plan changed"),
    ("see:\n    indented next line", "see:", "    indented next line"),  // the indent stays
    ("see:\r\n\r\nnext", "see:", "next"),
    ("a\nb", "a", "b"),  // the message went out trimmed ("a\n" was typed); the box still holds "a" then more
    ("  a\nb", "a", "b"),  // leading space in the box
    ("a  \nb", "a", "b"),  // trailing space before the line break
    ("a b", "a", "a b"),  // more on the same line is a different draft
    ("hello  ", "hello", nil),
    ("hello\n", "hello", nil),
    ("", "hello", nil),
    ("  \n ", "hello", nil),
  ] as [(String, String, String?)])
  func onlyWhatWasSentLeavesTheBox(box: String, sent: String, kept: String?) {
    #expect(ComposeRules.boxAfterSend(box: box, sent: sent) == kept)
  }
}

@Suite("Hotkey config")
struct HotkeyConfigTests {
  @Test func changingTheHotkeyDoesNotForceAColdRestart() {
    var a = DesktopConfig.defaults
    var b = a
    b.hotkeys.compose = "ctrl+opt+j"
    #expect(a.launchFingerprint(resolvedClaude: "/x/claude") == b.launchFingerprint(resolvedClaude: "/x/claude"))
    a.args.append("--other")
    #expect(a.launchFingerprint(resolvedClaude: "/x/claude") != b.launchFingerprint(resolvedClaude: "/x/claude"))
  }

  @Test func theDefaultHotkeyInTheConfigParses() throws {
    #expect(try HotkeySpec.parse(DesktopConfig.defaults.hotkeys.compose).text == "ctrl+opt+space")
  }
}

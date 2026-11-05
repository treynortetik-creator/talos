import Foundation

/// A global hotkey as text (`"ctrl+opt+space"`) and as the Carbon numbers `RegisterEventHotKey` takes (DESKTOP-SPEC 6.3).
public struct HotkeySpec: Equatable, Sendable {
  public static let cmd: UInt32 = 256
  public static let shift: UInt32 = 512
  public static let opt: UInt32 = 2048
  public static let ctrl: UInt32 = 4096

  public var keyCode: UInt32
  public var modifiers: UInt32

  public enum ParseError: Error, Equatable, Sendable {
    case empty, unknownKey(String), unknownModifier(String), needsModifier, needsTwoModifiers, reserved(String), tooManyKeys
  }

  static let keys: [String: UInt32] = {
    var k: [String: UInt32] = [
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
      "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
      "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "'": 39,
      "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
      "delete": 51, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    ]
    let f: [UInt32] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
    for (i, c) in f.enumerated() { k["f\(i + 1)"] = c }
    return k
  }()

  static let modNames: [String: UInt32] = [
    "cmd": cmd, "command": cmd, "ctrl": ctrl, "control": ctrl, "opt": opt, "option": opt, "alt": opt, "shift": shift,
  ]

  /// Two-modifier system shortcuts that stay refused (canonical text). The enabled ones in the machine's own table are
  /// checked by the app as well (`CopySymbolicHotKeys`).
  static let reserved: Set<String> = [
    "opt+cmd+esc", "ctrl+cmd+q", "shift+cmd+q", "opt+shift+cmd+q", "shift+cmd+tab", "shift+cmd+3", "shift+cmd+4",
    "shift+cmd+5", "shift+cmd+6", "ctrl+cmd+space", "opt+cmd+d", "opt+cmd+h", "opt+cmd+m", "shift+cmd+h", "shift+cmd+a",
    "ctrl+cmd+f", "opt+cmd+space", "ctrl+opt+cmd+8", "shift+cmd+delete", "opt+cmd+delete", "ctrl+shift+cmd+q",
  ]

  /// `ctrl+opt+space`, case-insensitive, any modifier order. Needs a real key and at least one of ctrl/opt/cmd
  /// (shift alone would grab ordinary typing); a few system shortcuts are refused.
  public static func parse(_ text: String) throws -> HotkeySpec {
    let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    guard !parts.isEmpty, !(parts.count == 1 && parts[0].isEmpty) else { throw ParseError.empty }
    var mods: UInt32 = 0
    var key: UInt32?
    var keyName = ""
    for p in parts {
      if p.isEmpty { throw ParseError.unknownKey("") }
      if let m = modNames[p] { mods |= m; continue }
      if let k = keys[p] {
        if key != nil { throw ParseError.tooManyKeys }
        key = k
        keyName = p
        continue
      }
      throw p == parts.last ? ParseError.unknownKey(p) : ParseError.unknownModifier(p)
    }
    guard let key else { throw ParseError.empty }
    let isF = keyName.hasPrefix("f") && keyName.count > 1
    let modCount = [cmd, ctrl, opt, shift].filter { mods & $0 != 0 }.count
    // A global hotkey is swallowed in every app. One modifier on an ordinary key would take everyday shortcuts away
    // (⌘C, ⌃C in every terminal, ⌥E for é), so it needs two modifiers, one of them ctrl/opt/cmd. F-keys are the exception.
    if mods & (cmd | ctrl | opt) == 0 && !isF { throw ParseError.needsModifier }
    if modCount < 2 && !isF { throw ParseError.needsTwoModifiers }
    let spec = HotkeySpec(keyCode: key, modifiers: mods)
    let canon = spec.text
    if reserved.contains(canon) { throw ParseError.reserved(canon) }
    return spec
  }

  /// From a key press: the Carbon modifier bits and the key code. nil when the key has no name here or the combination
  /// is not allowed (the same rules as `parse`).
  public static func from(keyCode: UInt32, carbonModifiers: UInt32) -> HotkeySpec? {
    guard keys.values.contains(keyCode) else { return nil }
    let masked = carbonModifiers & (cmd | shift | opt | ctrl)
    return try? parse(HotkeySpec(keyCode: keyCode, modifiers: masked).text)
  }

  /// Canonical text: ctrl, opt, shift, cmd, then the key.
  public var text: String {
    var out: [String] = []
    if modifiers & Self.ctrl != 0 { out.append("ctrl") }
    if modifiers & Self.opt != 0 { out.append("opt") }
    if modifiers & Self.shift != 0 { out.append("shift") }
    if modifiers & Self.cmd != 0 { out.append("cmd") }
    out.append(Self.keys.first { $0.value == keyCode }?.key ?? "?")
    return out.joined(separator: "+")
  }

  /// A human reading, with the usual symbols.
  public var display: String {
    var s = ""
    if modifiers & Self.ctrl != 0 { s += "⌃" }
    if modifiers & Self.opt != 0 { s += "⌥" }
    if modifiers & Self.shift != 0 { s += "⇧" }
    if modifiers & Self.cmd != 0 { s += "⌘" }
    let k = Self.keys.first { $0.value == keyCode }?.key ?? "?"
    return s + (k == "space" ? "Space" : k.uppercased())
  }
}

public enum ComposeRules {
  public struct Message: Equatable, Sendable {
    public var thread: String
    public var text: String
  }
  public enum Refusal: Error, Equatable, Sendable { case empty, tooLong, unknownThread }
  /// The protocol's limit on a message, in UTF-16 units.
  public static let maxLength = 32_000

  /// What QuickCompose may send: not whitespace-only, at most 32,000 characters (the protocol's limit), to a thread the
  /// page listed. Returns the text exactly as typed apart from trimming the ends.
  public static func check(text: String, threadId: String?, known: [String]) -> Result<Message, Refusal> {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return .failure(.empty) }
    if t.utf16.count > maxLength { return .failure(.tooLong) }
    guard let id = threadId, ThreadIdRule.isValid(id), known.contains(id) else { return .failure(.unknownThread) }
    return .success(Message(thread: id, text: t))
  }

  /// What the box holds after the page took `sent` (the message as it went out, trimmed) while the owner may have kept typing:
  /// nil when nothing newer is there and the box should empty. Otherwise the text to keep. The box is cut only where the sent
  /// words end at a line break (the owner pressed Return and went on); a draft that merely starts with the same letters or
  /// words is a different draft and stays whole.
  public static func boxAfterSend(box: String, sent: String) -> String? {
    let ends = CharacterSet.whitespacesAndNewlines
    let now = box.trimmingCharacters(in: ends)
    let words = sent.trimmingCharacters(in: ends)
    if now.isEmpty || now == words { return nil }
    let body = box.drop(while: \.isWhitespace)  // the message went out without the box's leading blank space
    guard !words.isEmpty, body.hasPrefix(words) else { return box }
    let rest = body.dropFirst(words.count).drop { $0.isWhitespace && !$0.isNewline }
    guard rest.first?.isNewline == true else { return box }
    return String(rest.drop(while: \.isNewline))
  }

  /// Picker order: the last used thread first, then the page's own order. Unknown last-used ids are ignored.
  /// Picker labels, one per thread and all different: a second thread with the same name reads "Trip 2". The page sends
  /// each thread's real name (apps/web .../native/attach.ts); two threads can still share one, and a blank name arrives as
  /// "A thread", so equal names stay possible and are kept apart here.
  public static func labels(_ threads: [WebToNative.Thread]) -> [String] {
    var seen: [String: Int] = [:]
    var total: [String: Int] = [:]
    for t in threads { total[t.name, default: 0] += 1 }
    var used = Set<String>()
    return threads.map { t in
      seen[t.name, default: 0] += 1
      var label = t.name
      if total[t.name, default: 1] > 1, let n = seen[t.name], n > 1 { label = "\(t.name) \(n)" }
      var k = 2
      while used.contains(label) { label = "\(t.name) \(seen[t.name] ?? 1).\(k)"; k += 1 }
      used.insert(label)
      return label
    }
  }

  public static func order(_ threads: [WebToNative.Thread], lastUsed: String?) -> [WebToNative.Thread] {
    guard let l = lastUsed, let i = threads.firstIndex(where: { $0.id == l }), i != 0 else { return threads }
    var out = threads
    out.insert(out.remove(at: i), at: 0)
    return out
  }
}

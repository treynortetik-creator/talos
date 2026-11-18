import Foundation

/// Which key makes which character on a keyboard layout, so typed text can go in as real key presses. Some apps (Terminal's text
/// view among them) drop a key event that carries only a Unicode string, but take the key events `screen_key` posts.
/// Text is typed either wholly as keys or wholly as Unicode strings, never a mix: if any character has no plain key (an emoji, an
/// accented letter, anything that needs option or a dead key), `pieces(for:)` says so and the whole text goes the old way.
public struct ScreenKeyLayout: Sendable {
  let keys: [Character: ScreenKeyCombo]
  /// False when typing as keys would not make these characters (an input method is in use, or the layout cannot be read).
  let usable: Bool

  /// No keys: all text goes as Unicode strings.
  public static let empty = ScreenKeyLayout(keys: [:], usable: false)

  static let returnKey = ScreenKeyCombo(keyCode: 36, flags: 0)
  static let tabKey = ScreenKeyCombo(keyCode: 48, flags: 0)
  /// The main block of a keyboard: letters, digits, punctuation, Return, Tab, Space and the key above Tab.
  public static let keyCodes: ClosedRange<UInt16> = 0...50

  /// What a key makes: its text, and the dead-key state it leaves (0 when none: a dead key only starts an accent and makes no
  /// character of its own).
  public struct KeyOutput: Sendable, Equatable {
    public var text: String
    public var deadKeyState: UInt32
    public init(text: String, deadKeyState: UInt32 = 0) {
      self.text = text
      self.deadKeyState = deadKeyState
    }
  }

  /// A layout from what each key makes. `translate(keyCode, shifted)` is what the key makes with or without shift, nil for none.
  /// Only a key that makes one printable character and leaves no dead-key state counts (no control characters, no dead keys); a
  /// character two keys make belongs to the one that needs no shift. Return and Tab are fixed keys, not read from the layout.
  public static func build(translate: (UInt16, Bool) -> KeyOutput?) -> ScreenKeyLayout {
    var keys: [Character: ScreenKeyCombo] = [:]
    for shifted in [false, true] {
      for code in keyCodes {
        guard let out = translate(code, shifted), out.deadKeyState == 0, out.text.count == 1, let c = out.text.first,
          c.unicodeScalars.count == 1, let v = c.unicodeScalars.first?.value, v >= 0x20, v != 0x7F, keys[c] == nil
        else { continue }
        keys[c] = ScreenKeyCombo(keyCode: code, flags: shifted ? ScreenKeyCombo.shift : 0)
      }
    }
    return ScreenKeyLayout(keys: keys, usable: true)
  }

  /// The key presses that type `text`, in pieces of at most `maxKeys` keys, a piece ending after every Return and Tab (so each
  /// is followed by a fresh gate before more keys go). A newline is the Return key and a tab the Tab key. nil when any character
  /// has no key (the whole text then goes as Unicode, the newlines too), or when this layout is not usable.
  public func pieces(for text: String, maxKeys: Int) -> [[ScreenKeyCombo]]? {
    guard usable else { return nil }
    var out: [[ScreenKeyCombo]] = []
    var cur: [ScreenKeyCombo] = []
    for c in text {
      let combo: ScreenKeyCombo
      switch c {
      case "\n", "\r", "\r\n": combo = Self.returnKey
      case "\t": combo = Self.tabKey
      default:
        guard let k = keys[c] else { return nil }
        combo = k
      }
      cur.append(combo)
      if combo == Self.returnKey || combo == Self.tabKey || cur.count >= maxKeys {
        out.append(cur)
        cur = []
      }
    }
    if !cur.isEmpty { out.append(cur) }
    return out
  }
}

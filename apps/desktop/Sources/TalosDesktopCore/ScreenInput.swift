import CoreGraphics
import Foundation

/// One event as the backend posts it. Text is already cut into short pieces, each one let through by the gate on its own.
public enum ScreenInputEvent: Sendable, Equatable {
  case click(CGPoint, button: ScreenMouseButton, count: Int)
  case text(String)
  case key(ScreenKeyCombo)
  /// Pixels; positive `dy` scrolls up, positive `dx` scrolls left (CGEvent's own sense).
  case scroll(at: CGPoint, dx: Int, dy: Int)
}

public enum ScreenMouseButton: String, Sendable, Equatable { case left, right, middle }

/// A key and its modifiers, from text like `"cmd+shift+t"`, as a virtual key code and CGEvent flag bits.
public struct ScreenKeyCombo: Sendable, Equatable {
  public static let shift: UInt64 = 0x0002_0000
  public static let ctrl: UInt64 = 0x0004_0000
  public static let opt: UInt64 = 0x0008_0000
  public static let cmd: UInt64 = 0x0010_0000

  public var keyCode: UInt16
  public var flags: UInt64

  /// Keys beyond the hotkey table.
  static let extraKeys: [String: UInt32] = [
    "enter": 36, "backspace": 51, "escape": 53, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116,
    "pagedown": 121,
  ]

  /// Case-insensitive, any order, `+` between parts; exactly one non-modifier key. Modifiers alone are allowed to be none.
  public static func parse(_ text: String) throws(ScreenRefusal) -> ScreenKeyCombo {
    let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    var flags: UInt64 = 0
    var key: UInt32?
    for p in parts {
      switch p {
      case "cmd", "command": flags |= cmd
      case "ctrl", "control": flags |= ctrl
      case "opt", "option", "alt": flags |= opt
      case "shift": flags |= shift
      default:
        guard let k = HotkeySpec.keys[p] ?? extraKeys[p] else {
          throw .badRequest(p.isEmpty ? "an empty part in the key \"\(text)\"" : "no key called \"\(p)\"")
        }
        guard key == nil else { throw .badRequest("more than one key in \"\(text)\"") }
        key = k
      }
    }
    guard let key else { throw .badRequest("no key in \"\(text)\"") }
    return ScreenKeyCombo(keyCode: UInt16(key), flags: flags)
  }
}

/// R1-1: keys that macOS or Talos handle for the whole Mac. The front-app gate cannot cover them: ⌘⇧3 saves an unfiltered
/// screenshot, ⌘Space opens Spotlight (which is not the front app), ⌘Tab switches apps. So they are never pressed for an agent,
/// whatever app is in front. A combination counts when it holds at least the modifiers of a refused one.
public enum ScreenKeyGuard {
  /// Names of the fn / globe key: macOS gives it system meanings (input source, emoji, dictation) and it is never pressed.
  static let fnNames: Set<String> = ["fn", "globe", "function"]
  /// F13-F20: no Mac keyboard has them, so they are free for global hotkeys (and are used for them). Never pressed.
  static let highFKeys: Set<String> = Set((13...20).map { "f\($0)" })

  /// Refused by name, besides the families in `isGlobal`: the reserved hotkeys, zoom, and Talos's own defaults (quick compose
  /// and the capture hotkey). The owner's configured Talos hotkeys and this Mac's enabled shortcuts come in as `extra`.
  static let named: [String] = Array(HotkeySpec.reserved) + [
    "opt+cmd+8", "ctrl+opt+space", "ctrl+opt+cmd+s", "opt+cmd+f5", "ctrl+cmd+power", "opt+cmd+eject",
  ]

  static let namedCombos: [ScreenKeyCombo] = named.compactMap(combo)

  /// A combination from hotkey text, with the HotkeySpec key table; nil for a name it does not know.
  static func combo(_ text: String) -> ScreenKeyCombo? {
    var flags: UInt64 = 0
    var key: UInt32?
    for p in text.lowercased().split(separator: "+").map(String.init) {
      switch p {
      case "cmd", "command": flags |= ScreenKeyCombo.cmd
      case "ctrl", "control": flags |= ScreenKeyCombo.ctrl
      case "opt", "option", "alt": flags |= ScreenKeyCombo.opt
      case "shift": flags |= ScreenKeyCombo.shift
      default:
        guard let k = HotkeySpec.keys[p] ?? ScreenKeyCombo.extraKeys[p] else { return nil }
        key = k
      }
    }
    return key.map { ScreenKeyCombo(keyCode: UInt16($0), flags: flags) }
  }

  /// Carbon modifier bits (a `HotkeySpec`, the symbolic hotkey table) as CGEvent flag bits.
  public static func combo(carbonKey: UInt32, carbonModifiers m: UInt32) -> ScreenKeyCombo {
    var f: UInt64 = 0
    if m & HotkeySpec.cmd != 0 { f |= ScreenKeyCombo.cmd }
    if m & HotkeySpec.ctrl != 0 { f |= ScreenKeyCombo.ctrl }
    if m & HotkeySpec.opt != 0 { f |= ScreenKeyCombo.opt }
    if m & HotkeySpec.shift != 0 { f |= ScreenKeyCombo.shift }
    return ScreenKeyCombo(keyCode: UInt16(carbonKey), flags: f)
  }

  static let fKeys: Set<UInt16> = Set((1...12).compactMap { HotkeySpec.keys["f\($0)"].map { UInt16($0) } })
  static let digits: Set<UInt16> = Set((1...9).compactMap { HotkeySpec.keys["\($0)"].map { UInt16($0) } })
  static let screenshotDigits: Set<UInt16> = Set([3, 4, 5, 6].compactMap { HotkeySpec.keys["\($0)"].map { UInt16($0) } })

  public static func isGlobal(_ k: ScreenKeyCombo, extra: [ScreenKeyCombo] = []) -> Bool {
    let cmd = ScreenKeyCombo.cmd, ctrl = ScreenKeyCombo.ctrl, opt = ScreenKeyCombo.opt, shift = ScreenKeyCombo.shift
    let m = k.flags & (cmd | ctrl | opt | shift)
    func has(_ need: UInt64) -> Bool { m & need == need }
    switch k.keyCode {
    case let c where fKeys.contains(c): return true  // brightness, Mission Control, Launchpad, media, menu bar and Dock focus
    case 49: if m & (cmd | ctrl) != 0 { return true }  // space: Spotlight, input sources, emoji, Finder search
    case 48, 50: if has(cmd) { return true }  // tab, `: app and window switching
    case 123, 124, 125, 126: if has(ctrl) { return true }  // arrows: Mission Control, Spaces
    case let c where digits.contains(c) && has(ctrl): return true  // switch to Desktop n
    case let c where screenshotDigits.contains(c) && has(cmd | shift): return true  // screenshots, file or clipboard
    case 53: if has(cmd | opt) { return true }  // esc: Force Quit
    case 12: if has(ctrl | cmd) || has(cmd | shift) { return true }  // q: lock screen, log out
    default: break
    }
    return (namedCombos + extra).contains { $0.keyCode == k.keyCode && m & $0.flags == $0.flags && ($0.flags != 0 || m == 0) }
  }
}

/// What an agent asks for. `ScreenCore.perform` checks it, cuts text up, and gates every piece.
public enum ScreenInputRequest: Sendable, Equatable {
  case click(CGPoint, button: ScreenMouseButton = .left, count: Int = 1)
  case type(String)
  case key(String)
  case scroll(at: CGPoint, dx: Int, dy: Int)
}

extension ScreenCore {
  /// The most text one call may type.
  public static let maxTypedCharacters = 10_000
  /// UTF-16 units per text event (CGEvent carries at most 20).
  static let textChunkUnits = 16
  /// The wait between two pieces of typed text, so an app keeps up and the front-app check before each piece has something to see.
  /// The longest text (10,000 characters, 625 pieces) then takes about 5 s, inside the socket's 20 s.
  public static let textPaceSeconds = 0.008

  /// Sends one request if every gate passes: Accessibility granted, an allowed app (not Talos) in front at each event, and
  /// for a click or scroll an allowed app's window under the pointer. Text is typed a few characters at a time and the
  /// front app is checked before each piece, so a switch to another app mid-way stops the typing there.
  /// Returns the number of events posted.
  @discardableResult
  public func perform(_ request: ScreenInputRequest, allowed: ScreenAllowed) throws(ScreenRefusal) -> Int {
    if case .key(let text) = request { try checkKey(text) }
    let events = try Self.events(for: request)
    var posted = 0
    for e in events {
      // the socket gave up on this request (it ran past its time): stop between pieces
      if Task.isCancelled { throw .inputFailed("stopped after \(posted) of \(events.count) events: the request ran out of time") }
      if posted > 0, case .text = e { pause(Self.textPaceSeconds) }
      let front = try gate(e, allowed)
      do { try input.post(e) } catch let r as ScreenRefusal { throw r } catch {
        throw .inputFailed(ScreenRefusal.detail(error))
      }
      posted += 1
      // a key or text that made another app come forward: stop, and say so (a click may bring its own window forward)
      if case .click = e { continue }
      if case .scroll = e { continue }
      if apps.frontmost()?.pid != front.pid { throw .frontChanged(app: front.name) }
    }
    return posted
  }

  /// A key the whole Mac handles is never pressed (`ScreenKeyGuard`, the fn / globe key, F13-F20). Then the rule (review R2-2): a
  /// plain key or shift+key goes anywhere; a combination with cmd, ctrl or opt only when it is one of the front app's own menu
  /// shortcuts. A global hotkey of some other app (a launcher on opt+space) is in no app's menus, whatever this Mac has installed.
  func checkKey(_ text: String) throws(ScreenRefusal) {
    let parts = Set(text.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) })
    if !parts.isDisjoint(with: ScreenKeyGuard.fnNames) || !parts.isDisjoint(with: ScreenKeyGuard.highFKeys) { throw .keyNotAllowed(text) }
    let combo = try ScreenKeyCombo.parse(text)
    if ScreenKeyGuard.isGlobal(combo, extra: refusedKeys()) { throw .keyNotAllowed(text) }
    let mods = combo.flags & (ScreenKeyCombo.cmd | ScreenKeyCombo.ctrl | ScreenKeyCombo.opt | ScreenKeyCombo.shift)
    guard mods & (ScreenKeyCombo.cmd | ScreenKeyCombo.ctrl | ScreenKeyCombo.opt) != 0 else { return }
    guard permissions.accessibility() else { throw .accessibilityNotGranted }
    guard let front = apps.frontmost() else { throw .noFrontmostApp }
    let menu = apps.menuShortcuts(pid: front.pid) ?? []
    guard menu.contains(where: { $0.keyCode == combo.keyCode && $0.flags == mods }) else {
      throw .keyNotInMenu(keys: text, app: front.name)
    }
  }

  /// Checked and split, before any event is posted.
  static func events(for request: ScreenInputRequest) throws(ScreenRefusal) -> [ScreenInputEvent] {
    switch request {
    case .click(let p, let button, let count):
      try checkPoint(p)
      guard (1...3).contains(count) else { throw .badRequest("a click count is 1, 2 or 3") }
      // one event per click (its click count 1, 2, 3), each gated on its own: a first click that changes what is under the
      // pointer stops the rest
      return (1...count).map { .click(p, button: button, count: $0) }
    case .type(let s):
      guard !s.isEmpty else { throw .badRequest("no text to type") }
      guard s.count <= maxTypedCharacters else { throw .badRequest("more than \(maxTypedCharacters) characters to type") }
      return chunks(s).map { .text($0) }
    case .key(let k):
      return [.key(try ScreenKeyCombo.parse(k))]
    case .scroll(let p, let dx, let dy):
      try checkPoint(p)
      guard abs(dx) <= 10_000, abs(dy) <= 10_000 else { throw .badRequest("a scroll is at most 10000 pixels") }
      guard dx != 0 || dy != 0 else { throw .badRequest("a scroll of zero") }
      return [.scroll(at: p, dx: dx, dy: dy)]
    }
  }

  static func checkPoint(_ p: CGPoint) throws(ScreenRefusal) {
    guard p.x.isFinite, p.y.isFinite, abs(p.x) < 100_000, abs(p.y) < 100_000 else { throw .badRequest("that point is not on a screen") }
  }

  /// Whole characters, at most `textChunkUnits` UTF-16 units a piece (a character longer than that is a piece on its own).
  static func chunks(_ s: String) -> [String] {
    var out: [String] = []
    var cur = ""
    var units = 0
    for c in s {
      let n = c.utf16.count
      if units + n > textChunkUnits, !cur.isEmpty {
        out.append(cur)
        cur = ""
        units = 0
      }
      cur.append(c)
      units += n
    }
    if !cur.isEmpty { out.append(cur) }
    return out
  }

  @discardableResult
  func gate(_ e: ScreenInputEvent, _ allowed: ScreenAllowed) throws(ScreenRefusal) -> ScreenApp {
    guard permissions.accessibility() else { throw .accessibilityNotGranted }
    guard let front = apps.frontmost() else { throw .noFrontmostApp }
    guard !isSelf(front) else { throw .talosItself }
    guard allowed.allows(bundleID: front.bundleID, pid: front.pid) else {
      throw .appNotAllowed(app: front.bundleID ?? front.name, subject: .running(pid: front.pid))
    }
    // a key or text goes where the keyboard really is: a panel that took it without coming to the front gets nothing
    switch e {
    case .key, .text: guard apps.keyboardFocusPID() == front.pid else { throw .focusElsewhere(app: front.name) }
    case .click, .scroll: break
    }
    let point: CGPoint?
    switch e {
    case .click(let p, _, _), .scroll(let p, _, _): point = p
    case .text, .key: point = nil
    }
    if let point {
      let under: ScreenApp
      switch apps.pointOwner(at: point) {
      case .systemArea: throw .systemArea
      case .nothing: throw .nothingAtPoint
      case .app(let a): under = a
      }
      guard !isSelf(under) else { throw .talosItself }
      guard allowed.allows(bundleID: under.bundleID, pid: under.pid) else {
        throw .appNotAllowed(app: under.bundleID ?? under.name, subject: .running(pid: under.pid))
      }
    }
    return front
  }
}

/// One value shared between threads, read and written under a lock.
public final class LockedValue<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var _value: T
  public init(_ v: T) { _value = v }
  public var value: T {
    get { lock.withLock { _value } }
    set { lock.withLock { _value = newValue } }
  }
}

public enum ScreenPointOwner: Sendable, Equatable {
  case app(ScreenApp)
  /// The menu bar, a menu bar extra, or a window above normal ones: never clicked for an agent.
  case systemArea
  case nothing
}

/// One window as the window list gives it, for `owner(at:in:)`.
public struct ScreenPointWindow: Sendable, Equatable {
  public var pid: Int32
  public var name: String
  public var bundleID: String?
  /// Global points, top-left origin.
  public var bounds: CGRect
  public var layer: Int
  public var alpha: Double
  public var onScreen: Bool
  public init(pid: Int32, name: String, bundleID: String?, bounds: CGRect, layer: Int, alpha: Double, onScreen: Bool) {
    self.pid = pid
    self.name = name
    self.bundleID = bundleID
    self.bounds = bounds
    self.layer = layer
    self.alpha = alpha
    self.onScreen = onScreen
  }

  /// The main menu's level (kCGMainMenuWindowLevel): the menu bar, its extras (25) and everything above normal windows.
  public static let systemLayer = 24

  /// What a click at `point` lands on, from a front-to-back list (review R3-1). Any on-screen window at level 24 or above holding
  /// the point, visible or not, makes it system area: an invisible app window laid over the menu bar does not make the menu bar
  /// that app's. Otherwise the first visible (alpha above 0) normal window holding it is the owner: an invisible one is skipped,
  /// since the click goes through it.
  public static func owner(at point: CGPoint, in windows: [ScreenPointWindow]) -> ScreenPointOwner {
    let here = windows.filter { $0.onScreen && $0.bounds.contains(point) }
    if here.contains(where: { $0.layer >= systemLayer }) { return .systemArea }
    guard let w = here.first(where: { $0.alpha > 0 }) else { return .nothing }
    return .app(ScreenApp(bundleID: w.bundleID, pid: w.pid, name: w.name))
  }
}

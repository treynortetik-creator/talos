import CoreGraphics
import Foundation

/// One event as the backend posts it. Text is already cut into short pieces, each one let through by the gate on its own.
public enum ScreenInputEvent: Sendable, Equatable {
  case click(CGPoint, button: ScreenMouseButton, count: Int)
  case text(String)
  /// Key presses, the events `screen_key` posts: one piece of typed text that goes in as the keys that make it.
  case keys([ScreenKeyCombo])
  case key(ScreenKeyCombo)
  /// Pixels; positive `dy` scrolls up, positive `dx` scrolls left (CGEvent's own sense).
  case scroll(at: CGPoint, dx: Int, dy: Int)
}

extension ScreenInputEvent {
  /// How many of the CGEvents the live backend posts for this event are answered by a window (a release, a key-up, a scroll): the
  /// live backend must post exactly this many of the types `SyntheticInputGuard.isAnswerType` names.
  public var answers: Int {
    switch self {
    case .click, .text, .key, .scroll: return 1
    case .keys(let k): return max(1, k.count)
    }
  }

  /// Text going in, as Unicode strings or as key presses.
  var isTyping: Bool {
    switch self {
    case .text, .keys: return true
    case .click, .key, .scroll: return false
    }
  }
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
  /// The wait before the first piece of typed text.
  public static let textSettleSeconds = 0.05
  /// How many trailing characters of the field a failed read-back reports.
  static let readBackSuffix = 40
  /// The wait before each look at the field after typing, so an app that takes its events a beat later has shown them.
  public static let readBackSettleSeconds = 0.1
  /// How many times the field is looked at before the answer is given (it stops at the first look that shows the text).
  static let readBackLooks = 3

  /// What the field held after typing, compared with what it held before.
  public enum ReadBack: Sendable, Equatable {
    /// The text is in the field one more time than before.
    case verified
    /// The field changed, but not by the text.
    case mismatch(suffix: String)
    /// The field is exactly as it was: the typing did not land.
    case unchanged
    /// The field could not be read before or after (not readable, secure, another element, or another app came to the front).
    case unverified
    /// The text held a newline, which is a Return: it may have run a command, sent a message or submitted a form and cleared the
    /// field, so what the field holds says nothing either way.
    case unverifiedReturn
  }

  /// Types text (`perform`), then looks at the focused field and says whether the text arrived. The field is read once before
  /// the gate (for the front app, only if it is allowed) and kept only if the gate then passes for that same app; it is read again
  /// after the last piece, and the text counts only when it appears more often than before and the field is the same element: a
  /// terminal's buffer already holds the words an agent types, so the text being in the field proves nothing.
  public func typeText(_ text: String, allowed: ScreenAllowed) throws(ScreenRefusal) -> (events: Int, readBack: ReadBack) {
    let events = try self.events(for: .type(text))
    var viaKeys = false
    if case .keys = events.first { viaKeys = true }
    let hasReturn = text.contains { $0.isNewline }
    // before the gate, so no read comes between the gate and the first post
    var before: (pid: Int32, field: ScreenField)?
    if let f = apps.frontmost(), allowed.allows(bundleID: f.bundleID, pid: f.pid),
      let field = apps.focusedField(pid: f.pid)
    { before = (f.pid, field) }
    let (n, gated) = try send(.type(text), allowed: allowed, events: events)
    // a Return typed as a Unicode character may or may not be a Return to the app: nothing can be said of the field
    if hasReturn, !viaKeys { return (n, .unverifiedReturn) }
    guard let gated, let before, before.pid == gated.pid else { return (n, .unverified) }
    var result = ReadBack.unverified
    for _ in 0..<Self.readBackLooks {
      pause(Self.readBackSettleSeconds)
      // only the app the text was gated for: if another app came to the front since, or it is no longer allowed, nothing is read
      guard let now = apps.frontmost(), now.pid == gated.pid, allowed.allows(bundleID: now.bundleID, pid: now.pid),
        let after = apps.focusedField(pid: gated.pid), after.element == before.field.element
      else {
        result = .unverified
        break
      }
      result = Self.judge(text, before: before.field.value, after: after.value)
      if result == .verified { break }
    }
    if hasReturn, result != .verified { return (n, .unverifiedReturn) }
    return (n, result)
  }

  /// Whether the field's change from `before` to `after` is the typed text: every line of it (a newline runs a command or starts a
  /// line, and is not in the field as a character) appears more often than it did.
  static func judge(_ text: String, before: String, after: String) -> ReadBack {
    if after == before { return .unchanged }
    var need: [String: Int] = [:]
    for line in text.split(whereSeparator: \.isNewline) { need[String(line), default: 0] += 1 }
    let landed = need.allSatisfy { line, times in occurrences(of: line, in: after) - occurrences(of: line, in: before) >= times }
    return landed ? .verified : .mismatch(suffix: String(after.suffix(readBackSuffix)))
  }

  private static func occurrences(of piece: String, in text: String) -> Int {
    text.components(separatedBy: piece).count - 1
  }

  /// Sends one request if every gate passes: Accessibility granted, an allowed app in front at each event, and
  /// for a click or scroll an allowed app's window under the pointer. Text is typed a few characters at a time and the
  /// front app is checked before each piece, so a switch to another app mid-way stops the typing there.
  /// Returns the number of events posted.
  @discardableResult
  public func perform(_ request: ScreenInputRequest, allowed: ScreenAllowed) throws(ScreenRefusal) -> Int {
    try send(request, allowed: allowed).posted
  }

  /// `perform`, also saying which app the last event was gated for. `events` are the request's events when the caller already
  /// made them (the typed text's way, keys or Unicode, was then decided once).
  func send(
    _ request: ScreenInputRequest, allowed: ScreenAllowed, events given: [ScreenInputEvent]? = nil
  ) throws(ScreenRefusal) -> (posted: Int, front: ScreenApp?) {
    if case .key(let text) = request { try checkKey(text) }
    let events: [ScreenInputEvent]
    if let given { events = given } else { events = try self.events(for: request) }
    var posted = 0
    var gated: ScreenApp?
    var tokens: [Int64] = []
    defer { flight.forget(tokens) }
    var keyText: String?
    if case .key(let t) = request { keyText = t }
    for e in events {
      // the socket gave up on this request (it ran past its time): stop between pieces
      if Task.isCancelled { throw .inputFailed("stopped after \(posted) of \(events.count) events: the request ran out of time") }
      if posted > 0, e.isTyping { pause(Self.textPaceSeconds) }
      // the app needs a beat before the first piece, or its first characters are lost; waited before the gate, so nothing can
      // change between the check and the post
      if posted == 0, e.isTyping { pause(Self.textSettleSeconds) }
      var aimedAtTalos = false
      let front = try gate(e, allowed, keyText: keyText, touched: { if $0.pid == self.flight.ownPid { aimedAtTalos = true } })
      gated = front
      // Talos may be the app that gets this event, and a card's button or a terminal may sit under it. Every event carries its own
      // token; one aimed at Talos is answered by the window that gets it ("handled") or dropped there, and the request waits for the
      // answers of its own tokens below (`SyntheticInput.Flight`).
      let token = flight.begin()
      if aimedAtTalos {
        flight.expect(token, answers: e.answers)
        tokens.append(token)
      }
      do { try input.post(e, token: token) } catch let r as ScreenRefusal { flight.end(); throw r } catch {
        flight.end()
        throw .inputFailed(ScreenRefusal.detail(error))
      }
      flight.end()
      posted += 1
      // a key or text that made another app come forward: stop, and say so (a click may bring its own window forward)
      if case .click = e { continue }
      if case .scroll = e { continue }
      if apps.frontmost()?.pid != front.pid { throw .frontChanged(app: front.name) }
    }
    // Events aimed at Talos itself: wait for their own answers. A drop is `protectedPrompt`; no answer in time is `deliveryUnverified`.
    if !tokens.isEmpty {
      switch flight.wait(tokens, timeout: deliveryTimeout) {
      case .handled: break
      case .dropped: throw .protectedPrompt
      case .unverified: throw .deliveryUnverified
      }
    }
    return (posted, gated)
  }

  /// Shortcuts of open and save panels, which are in no app's menu bar: they skip the menu-shortcut check only.
  public static let panelShortcuts: Set<String> = ["cmd+shift+g"]  // Go to Folder
  static let panelCombos: [ScreenKeyCombo] = panelShortcuts.compactMap(ScreenKeyGuard.combo)

  /// A key the whole Mac handles is never pressed (`ScreenKeyGuard`, the fn / globe key, F13-F20). Then the rule (review R2-2): a
  /// plain key or shift+key goes anywhere; a combination with cmd, ctrl or opt only when it is one of the front app's own menu
  /// shortcuts. A global hotkey of some other app (a launcher on opt+space) is in no app's menus, whatever this Mac has installed.
  func checkKey(_ text: String) throws(ScreenRefusal) {
    let parts = Set(text.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) })
    if !parts.isDisjoint(with: ScreenKeyGuard.fnNames) || !parts.isDisjoint(with: ScreenKeyGuard.highFKeys) { throw .keyNotAllowed(text) }
    let combo = try ScreenKeyCombo.parse(text)
    if ScreenKeyGuard.isGlobal(combo, extra: refusedKeys()) { throw .keyNotAllowed(text) }
  }

  /// The menu rule, decided on the front app the gate read (one read, so the front cannot change between this and the gate).
  func checkMenu(_ text: String, _ combo: ScreenKeyCombo, front: ScreenApp) throws(ScreenRefusal) {
    let mods = combo.flags & (ScreenKeyCombo.cmd | ScreenKeyCombo.ctrl | ScreenKeyCombo.opt | ScreenKeyCombo.shift)
    guard mods & (ScreenKeyCombo.cmd | ScreenKeyCombo.ctrl | ScreenKeyCombo.opt) != 0 else { return }
    // a panel shortcut is in no menu bar: it skips the menu check only (the layers above already applied), and only while the
    // front app's focused window is a sheet or an open/save panel
    if Self.panelCombos.contains(where: { $0.keyCode == combo.keyCode && $0.flags == mods }), apps.frontHasPanel(pid: front.pid) { return }
    let menu = apps.menuShortcuts(pid: front.pid) ?? []
    guard menu.contains(where: { $0.keyCode == combo.keyCode && $0.flags == mods }) else {
      throw .keyNotInMenu(keys: text, app: front.name)
    }
  }

  /// Checked and split, before any event is posted. Typed text goes in as key presses when every character has a key on the
  /// current layout (a piece ends at each Return and Tab, so each is gated before more keys go); otherwise the whole text goes as
  /// Unicode strings, never a mix of the two.
  func events(for request: ScreenInputRequest) throws(ScreenRefusal) -> [ScreenInputEvent] {
    switch request {
    case .click(let p, let button, let count):
      try Self.checkPoint(p)
      guard (1...3).contains(count) else { throw .badRequest("a click count is 1, 2 or 3") }
      // one event per click (its click count 1, 2, 3), each gated on its own: a first click that changes what is under the
      // pointer stops the rest
      return (1...count).map { .click(p, button: button, count: $0) }
    case .type(let s):
      guard !s.isEmpty else { throw .badRequest("no text to type") }
      guard s.count <= Self.maxTypedCharacters else { throw .badRequest("more than \(Self.maxTypedCharacters) characters to type") }
      if let pieces = layout().pieces(for: s, maxKeys: Self.textChunkUnits) { return pieces.map { .keys($0) } }
      return Self.chunks(s).map { .text($0) }
    case .key(let k):
      return [.key(try ScreenKeyCombo.parse(k))]
    case .scroll(let p, let dx, let dy):
      try Self.checkPoint(p)
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
  func gate(_ e: ScreenInputEvent, _ allowed: ScreenAllowed, keyText: String? = nil, touched: (ScreenApp) -> Void = { _ in }) throws(ScreenRefusal) -> ScreenApp {
    guard permissions.accessibility() else { throw .accessibilityNotGranted }
    guard let front = apps.frontmost() else { throw .noFrontmostApp }
    guard allowed.allows(bundleID: front.bundleID, pid: front.pid) else {
      throw .appNotAllowed(app: front.bundleID ?? front.name, subject: .running(pid: front.pid))
    }
    touched(front)
    // the menu rule, after the allow list (a disallowed app is refused as such), on the front the gate read
    if case .key(let combo) = e, let keyText { try checkMenu(keyText, combo, front: front) }
    // a key or text goes where the keyboard really is: a panel that took it without coming to the front gets nothing
    switch e {
    case .key, .text, .keys:
      // nil: nothing reports focus. Then only an app that provably owns the keyboard passes (it fails closed); another pid never does.
      switch apps.keyboardFocusPID() {
      case front.pid: break
      case nil: guard apps.appOwnsKeyboard(pid: front.pid) else { throw .focusElsewhere(app: front.name) }
      default: throw .focusElsewhere(app: front.name)
      }
    case .click, .scroll: break
    }
    let point: CGPoint?
    switch e {
    case .click(let p, _, _), .scroll(let p, _, _): point = p
    case .text, .keys, .key: point = nil
    }
    if let point {
      let under: ScreenApp
      var covering = false
      switch apps.pointOwner(at: point) {
      case .systemArea: throw .systemArea
      case .nothing: throw .nothingAtPoint
      case .app(let a): under = a
      case .coveredBy(let a): (under, covering) = (a, true)
      }
      guard allowed.allows(bundleID: under.bundleID, pid: under.pid) else {
        if covering { throw .coveredByInvisibleWindow(app: under.name) }
        throw .appNotAllowed(app: under.bundleID ?? under.name, subject: .running(pid: under.pid))
      }
      touched(under)
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
  /// Read and change under one lock hold: `value[i] = x` is a separate read and write, so two threads can lose an update.
  @discardableResult
  public func withLock<R>(_ body: (inout T) -> R) -> R { lock.withLock { body(&_value) } }
}

public enum ScreenPointOwner: Sendable, Equatable {
  case app(ScreenApp)
  /// The menu bar, a menu bar extra, or a window above normal ones: never clicked for an agent.
  case systemArea
  case nothing
  /// An invisible window of another app lies above the visible owner at the point and owns the click: this app.
  case coveredBy(ScreenApp)
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
  /// The window server's number for this window (0 = unknown).
  public var windowID: UInt32
  public init(
    pid: Int32, name: String, bundleID: String?, bounds: CGRect, layer: Int, alpha: Double, onScreen: Bool, windowID: UInt32 = 0
  ) {
    self.pid = pid
    self.name = name
    self.bundleID = bundleID
    self.bounds = bounds
    self.layer = layer
    self.alpha = alpha
    self.onScreen = onScreen
    self.windowID = windowID
  }

  /// The main menu's level (kCGMainMenuWindowLevel): the menu bar, its extras (25) and everything above normal windows.
  public static let systemLayer = 24

  /// What a click at `point` lands on. `hit` is the window the window server itself would hand a click at that point to (0: none;
  /// nil: it could not be asked). The window list's order, and a window's alpha, are not trusted to say who is on top or who takes
  /// a click: the owner is the hit window. So a Dock or floating panel of an app that is not allowed, over an allowed window, is that
  /// other app's point and the allow list refuses it, and a visible window that the server hands no click to (a click-through status
  /// window at level 1000 over a third of the screen) is not in the way. A hit window at level 24 or above (the menu bar and its
  /// extras, Control Center, Notification Center, any overlay that takes the click) is system area, as is a hit window the list does
  /// not hold or one that does not hold the point, and a point the server could not be asked about (it fails closed). An invisible
  /// (alpha 0) hit window below level 24 is the app that owns the click, reported as `.coveredBy`. What remains is the gap between this
  /// check and the click: a window that moves or appears in that gap is not seen (the hit is taken a moment before the post).
  public static func owner(at point: CGPoint, in windows: [ScreenPointWindow], hit: UInt32?) -> ScreenPointOwner {
    guard let hit else { return .systemArea }
    if hit == 0 { return .nothing }
    guard let w = windows.first(where: { $0.windowID == hit && $0.onScreen && $0.bounds.contains(point) }) else { return .systemArea }
    if w.layer >= systemLayer { return .systemArea }
    let app = ScreenApp(bundleID: w.bundleID, pid: w.pid, name: w.name)
    return w.alpha > 0 ? .app(app) : .coveredBy(app)
  }

  /// A window smaller than this (either side) is a sliver, not where a person sees an app.
  static let minVisibleSide: CGFloat = 40

  /// The pid of the topmost on-screen window at layers 0-23 that a person could see: alpha above 0 and at least
  /// `minVisibleSide` on each side. Invisible slivers (a notification helper's 4x4 window at alpha 0) are skipped. So is the
  /// Dock's screen-wide event window (level 20, alpha 1: it takes no keys and would otherwise be on top of everything), and ONLY that
  /// one: it must belong to `realDockPID` (the process running from the system's Dock.app, not any app that claims the id), sit at
  /// level 20, and be at least as large as a screen (`screenSizes`). Any other Dock window, and any impostor's, counts as on top.
  public static func topVisibleAppPID(in windows: [ScreenPointWindow], realDockPID: Int32? = nil, screenSizes: [CGSize] = []) -> Int32? {
    func isDockEventWindow(_ w: ScreenPointWindow) -> Bool {
      guard let dock = realDockPID, w.pid == dock, w.layer == 20 else { return false }
      return screenSizes.contains { w.bounds.width >= $0.width && w.bounds.height >= $0.height }
    }
    return windows.first {
      $0.onScreen && (0..<systemLayer).contains($0.layer) && $0.alpha > 0 && $0.bounds.width >= minVisibleSide
        && $0.bounds.height >= minVisibleSide && !isDockEventWindow($0)
    }?.pid
  }
}

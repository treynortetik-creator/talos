import AppKit
import CoreGraphics
import Foundation
import Testing
@testable import TalosDesktopCore

/// R1-1: keys that macOS or Talos handle for the whole Mac never reach the event tap, whatever app is in front. Gating on the
/// front app alone would let ⌘⇧3 save an unfiltered screenshot, ⌘Space open Spotlight (then typed into), ⌘Tab switch apps.
@Suite("Screen input: system-wide shortcuts are never pressed")
struct ScreenKeyGuardTests {
  let allowed: Set<String> = ["com.example.notes"]

  func core(_ input: FakeInput, refused: [ScreenKeyCombo] = []) -> ScreenCore {
    var c = Fx.core(input: input, apps: FakeApps(front: Fx.notes))
    c.refusedKeys = { refused }
    return c
  }

  @Test(arguments: [
    // screenshots, to a file or the clipboard
    "cmd+shift+3", "cmd+shift+4", "cmd+shift+5", "cmd+shift+6", "ctrl+cmd+shift+3", "ctrl+cmd+shift+4",
    // Spotlight, input sources, emoji, Finder search
    "cmd+space", "ctrl+space", "ctrl+opt+space", "cmd+opt+space", "ctrl+cmd+space",
    // app and window switching
    "cmd+tab", "cmd+shift+tab", "cmd+opt+tab", "cmd+`", "cmd+shift+`",
    // Mission Control and Spaces
    "ctrl+up", "ctrl+down", "ctrl+left", "ctrl+right", "ctrl+1", "ctrl+9",
    // force quit, lock, log out
    "cmd+opt+esc", "cmd+opt+shift+esc", "ctrl+cmd+q", "cmd+shift+q", "cmd+opt+shift+q",
    // the F-keys macOS binds (brightness, Mission Control, Launchpad, media) and the menu bar / Dock focus keys
    "f1", "f3", "f4", "f11", "f12", "ctrl+f2", "ctrl+f3", "fn", "globe", "fn+f",
    // HotkeySpec.reserved and accessibility toggles
    "opt+cmd+d", "shift+cmd+a", "ctrl+opt+cmd+8", "opt+cmd+8",
    // Talos's own: the capture hotkey's default
    "ctrl+opt+cmd+s",
  ])
  func aSystemWideShortcutIsRefusedInWordsAndNothingIsPosted(keys: String) {
    let input = FakeInput()
    #expect(throws: ScreenRefusal.keyNotAllowed(keys)) { try core(input).perform(.key(keys), allowedBundleIDs: allowed) }
    #expect(input.posted.isEmpty, "\(keys)")
  }

  @Test func theWordsAreOneLine() {
    #expect(
      ScreenRefusal.keyNotAllowed("cmd+space").reason
        == "cmd+space is a shortcut macOS or Talos handles for the whole Mac, so Talos never presses it for an agent. Nothing was pressed.")
    #expect(ScreenRefusal.keyNotAllowed("x").code == "key_not_allowed")
  }

  @Test func talosOwnHotkeysAndTheMachinesOwnShortcutsAreRefusedToo() {
    let input = FakeInput()
    // the compose hotkey as the owner set it, and a shortcut enabled in this Mac's own table
    let compose = ScreenKeyCombo(keyCode: 40, flags: ScreenKeyCombo.ctrl | ScreenKeyCombo.opt)  // ctrl+opt+k
    let machine = ScreenKeyCombo(keyCode: 0, flags: ScreenKeyCombo.ctrl | ScreenKeyCombo.shift)  // ctrl+shift+a
    let c = core(input, refused: [compose, machine])
    #expect(throws: ScreenRefusal.keyNotAllowed("ctrl+opt+k")) { try c.perform(.key("ctrl+opt+k"), allowedBundleIDs: allowed) }
    #expect(throws: ScreenRefusal.keyNotAllowed("shift+ctrl+a")) { try c.perform(.key("shift+ctrl+a"), allowedBundleIDs: allowed) }
    #expect(input.posted.isEmpty)
  }

  @Test(arguments: ["return", "cmd+s", "cmd+shift+t", "cmd+c", "tab", "shift+tab", "esc", "up", "cmd+w", "space", "shift+a", "f"])
  func ordinaryKeysStillWork(keys: String) throws {
    let input = FakeInput()
    #expect(try core(input).perform(.key(keys), allowedBundleIDs: allowed) == 1)
  }

  @Test func ifAnotherAppComesToTheFrontAfterAKeyTalosSaysSoAndStops() {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    input.after = { _ in a.front = Fx.talos }
    let c = Fx.core(input: input, apps: a)
    #expect(throws: ScreenRefusal.frontChanged(app: "Notes Example")) { try c.perform(.key("cmd+n"), allowedBundleIDs: allowed) }
    #expect(input.posted.count == 1)
    #expect(
      ScreenRefusal.frontChanged(app: "Notes Example").reason
        == "Another app came to the front after Notes Example got the last key, so Talos stopped there. Take a screenshot to see where things are.")
  }
}

/// R1-8: typing is paced, and each click of a multi-click is its own gated event.
@Suite("Screen input: paced typing and gated clicks")
struct ScreenInputPacingTests {
  final class Pauses: @unchecked Sendable {
    private let lock = NSLock()
    private var _all: [Double] = []
    var all: [Double] { lock.withLock { _all } }
    func add(_ s: Double) { lock.withLock { _all.append(s) } }
  }

  @Test func typingPausesBetweenPiecesAndChecksTheFrontBeforeEach() throws {
    let input = FakeInput()
    let p = Pauses()
    let a = FakeApps(front: Fx.notes)
    var c = Fx.core(input: input, apps: a)
    let log = Pauses()
    a.focus = { log.add(-1); return Fx.notes.pid }  // -1: a gate
    c.pause = { p.add($0); log.add($0) }
    let text = String(repeating: "abcdefgh", count: 10)  // five pieces
    #expect(try c.perform(.type(text), allowedBundleIDs: ["com.example.notes"]) == 5)
    #expect(p.all == [ScreenCore.textSettleSeconds] + Array(repeating: ScreenCore.textPaceSeconds, count: 4), "one settle before the first, then between pieces, not after the last")
    #expect(ScreenCore.textSettleSeconds == 0.05)
    #expect(Array(log.all.prefix(2)) == [ScreenCore.textSettleSeconds, -1], "the settle comes before the first gate")
    #expect(ScreenCore.textPaceSeconds >= 0.005 && ScreenCore.textPaceSeconds * Double(ScreenCore.maxTypedCharacters / 16) < 15)
  }

  @Test func theFieldIsReadBeforeAndAfterTyping() throws {
    let all: ScreenAllowed = .ids(["com.example.notes"])
    func typed(_ reads: [String?]) throws -> ScreenCore.ReadBack {
      let a = FakeApps(front: Fx.notes)
      let r = ScreenTypeTests.Reads(reads)
      a.value = { $0 == Fx.notes.pid ? r.next() : nil }
      return try Fx.core(apps: a).typeText("hello", allowed: all).readBack
    }
    #expect(try typed(["before", "before hello there"]) == .verified)
    let long = String(repeating: "x", count: 100) + "END"
    #expect(try typed(["before", long]) == .mismatch(suffix: String(long.suffix(40))))
    #expect(try typed([nil]) == .unverified)
  }

  @Test func theReadBackNeverReadsAnAppThatWasNotGated() throws {
    final class Reads: @unchecked Sendable {
      private let lock = NSLock()
      private var _pids: [Int32] = []
      var pids: [Int32] { lock.withLock { _pids } }
      func add(_ p: Int32) { lock.withLock { _pids.append(p) } }
    }
    let a = FakeApps(front: Fx.notes)
    let reads = Reads()
    a.value = { reads.add($0); return "hello" }
    // call 1 is the read before the gate, 2 the gate, 3 the check after the last piece, 4 the read-back's own look: the front
    // changes just before it
    a.onFrontmost = { n in if n == 4 { a.front = Fx.secret } }
    let c = Fx.core(apps: a)
    #expect(try c.typeText("hello", allowed: .ids(["com.example.notes"])) == (1, .unverified))
    #expect(reads.pids == [Fx.notes.pid], "one read, of the gated app before it was typed into, and none of Secret's")
  }

  @Test func eachClickOfADoubleClickIsGatedOnItsOwn() throws {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.under = { _ in Fx.notes }
    let pt = CGPoint(x: 50, y: 50)
    let c = Fx.core(input: input, apps: a)
    #expect(try c.perform(.click(pt, button: .left, count: 2), allowedBundleIDs: ["com.example.notes"]) == 2)
    #expect(input.posted == [.click(pt, button: .left, count: 1), .click(pt, button: .left, count: 2)])
    // the first click brings an ungranted window under the pointer: the second is not sent
    let input2 = FakeInput()
    let b = FakeApps(front: Fx.notes)
    b.under = { _ in input2.posted.isEmpty ? Fx.notes : Fx.secret }
    #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.secret", subject: .running(pid: 502))) {
      try Fx.core(input: input2, apps: b).perform(.click(pt, button: .left, count: 3), allowedBundleIDs: ["com.example.notes"])
    }
    #expect(input2.posted.count == 1)
  }
}

/// R2-2: a deny list cannot know every app's global hotkey (Raycast or Alfred on opt+space, 1Password, a drop-down terminal),
/// and a non-activating panel takes the keyboard without coming to the front. So: keys go only where the keyboard really is, and
/// a cmd/ctrl/opt combination only when it is one of the front app's own menu shortcuts.
@Suite("Screen input: the keyboard's real owner and the app's own shortcuts")
struct ScreenKeyFocusTests {
  let allowed: Set<String> = ["com.example.notes"]

  @Test(arguments: ["opt+space", "ctrl+opt+cmd+k", "opt+shift+p", "cmd+opt+l", "ctrl+opt+t", "opt+e", "ctrl+c", "ctrl+tab"])
  func aCombinationThatIsNotOneOfTheAppsMenuShortcutsIsRefused(keys: String) {
    let input = FakeInput()
    let c = Fx.core(input: input, apps: FakeApps(front: Fx.notes))
    #expect(throws: ScreenRefusal.keyNotInMenu(keys: keys, app: "Notes Example")) { try c.perform(.key(keys), allowedBundleIDs: allowed) }
    #expect(input.posted.isEmpty, "\(keys)")
  }

  @Test func theWordsSayWhatWorks() {
    #expect(
      ScreenRefusal.keyNotInMenu(keys: "opt+space", app: "Notes Example").reason
        == "opt+space isn't one of Notes Example's own menu shortcuts, so Talos didn't press it. Plain keys and shift work anywhere; for anything else use the app's menus.")
    #expect(ScreenRefusal.keyNotInMenu(keys: "x", app: "y").code == "key_not_in_menu")
    #expect(
      ScreenRefusal.focusElsewhere(app: "Notes Example").reason
        == "Another app has the keyboard, not Notes Example, so Talos stopped there. Take a screenshot to see where things are.")
  }

  @Test func whenTheMenusCannotBeReadOnlyPlainKeysGo() throws {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.menu = nil
    let c = Fx.core(input: input, apps: a)
    #expect(throws: ScreenRefusal.keyNotInMenu(keys: "cmd+s", app: "Notes Example")) { try c.perform(.key("cmd+s"), allowedBundleIDs: allowed) }
    #expect(try c.perform(.key("return"), allowedBundleIDs: allowed) == 1)
  }

  @Test(arguments: ["f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "shift+f13"])
  func theHighFunctionKeysAreRefused(keys: String) {
    let input = FakeInput()
    #expect(throws: ScreenRefusal.keyNotAllowed(keys)) { try Fx.core(input: input).perform(.key(keys), allowedBundleIDs: allowed) }
    #expect(input.posted.isEmpty)
  }

  @Test func aPanelHoldingTheKeyboardGetsNoKeysAndNoText() {
    // a non-activating panel (a launcher, a password manager) has the keyboard while Notes stays in front
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.focus = { 4242 }
    let c = Fx.core(input: input, apps: a)
    for r: ScreenInputRequest in [.key("return"), .type("secret"), .key("cmd+s")] {
      #expect(throws: ScreenRefusal.focusElsewhere(app: "Notes Example")) { try c.perform(r, allowedBundleIDs: allowed) }
    }
    a.focus = { nil }
    a.ownsKeyboard = { _ in false }  // nothing reports focus and the app cannot show it owns the keyboard: still refused
    #expect(throws: ScreenRefusal.focusElsewhere(app: "Notes Example")) { try c.perform(.type("x"), allowedBundleIDs: allowed) }
    #expect(input.posted.isEmpty)
  }

  @Test func withNothingFocusedAnAppThatOwnsTheKeyboardStillGetsKeysAndText() throws {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.focus = { nil }
    a.ownsKeyboard = { $0 == Fx.notes.pid }
    let c = Fx.core(input: input, apps: a)
    #expect(try c.perform(.key("return"), allowedBundleIDs: allowed) == 1)
    #expect(try c.perform(.type("hi"), allowedBundleIDs: allowed) == 1)
    #expect(input.posted == [.key(try ScreenKeyCombo.parse("return")), .text("hi")])
  }

  @Test func withNothingFocusedAndNoProofOfTheKeyboardKeysAndTextAreRefused() {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.focus = { nil }
    a.ownsKeyboard = { _ in false }
    let c = Fx.core(input: input, apps: a)
    for r: ScreenInputRequest in [.key("return"), .type("x")] {
      #expect(throws: ScreenRefusal.focusElsewhere(app: "Notes Example")) { try c.perform(r, allowedBundleIDs: allowed) }
    }
    #expect(input.posted.isEmpty)
  }

  @Test func anotherAppHoldingTheKeyboardIsRefusedWhateverTheFrontAppClaims() {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.focus = { 4242 }
    a.ownsKeyboard = { _ in true }
    let c = Fx.core(input: input, apps: a)
    for r: ScreenInputRequest in [.key("return"), .type("x")] {
      #expect(throws: ScreenRefusal.focusElsewhere(app: "Notes Example")) { try c.perform(r, allowedBundleIDs: allowed) }
    }
    #expect(input.posted.isEmpty)
  }

  @Test func theMenuAndPanelDecisionUsesTheOneFrontTheGateRead() throws {
    final class Asked: @unchecked Sendable {
      private let lock = NSLock()
      private var _pids: [Int32] = []
      var pids: [Int32] { lock.withLock { _pids } }
      func add(_ p: Int32) { lock.withLock { _pids.append(p) } }
    }
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    let asked = Asked()
    a.menu = []
    a.hasPanel = { asked.add($0); return true }
    // the front changes right after the gate's read (the second call): the decision was already made on Notes alone
    a.onFrontmost = { n in if n == 2 { a.front = Fx.secret } }
    let c = Fx.core(input: input, apps: a)
    #expect(throws: ScreenRefusal.frontChanged(app: "Notes Example")) { try c.perform(.key("cmd+shift+g"), allowedBundleIDs: allowed) }
    #expect(asked.pids == [Fx.notes.pid], "decided once, on the gate's own read")
  }

  @Test func aDisallowedFrontAppIsRefusedAsSuchBeforeTheMenuRule() {
    let input = FakeInput()
    let a = FakeApps(front: Fx.secret)
    a.menu = []
    let c = Fx.core(input: input, apps: a)
    #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.secret", subject: .running(pid: 502))) {
      try c.perform(.key("cmd+s"), allowedBundleIDs: allowed)
    }
    #expect(input.posted.isEmpty)
  }

  @Test func goToFolderOutsideAPanelNeedsTheMenu() throws {
    let a = FakeApps(front: Fx.notes)
    a.menu = []
    let c = Fx.core(apps: a)
    #expect(throws: ScreenRefusal.keyNotInMenu(keys: "cmd+shift+g", app: "Notes Example")) {
      try c.perform(.key("cmd+shift+g"), allowedBundleIDs: allowed)
    }
    a.menu = [try ScreenKeyCombo.parse("cmd+shift+g")]
    #expect(try c.perform(.key("cmd+shift+g"), allowedBundleIDs: allowed) == 1)
  }

  @Test func goToFolderIsPressedInAPanelWithNoMenuShortcutsButNeighboursAreNot() throws {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.menu = []
    a.hasPanel = { $0 == Fx.notes.pid }
    let c = Fx.core(input: input, apps: a)
    #expect(try c.perform(.key("cmd+shift+g"), allowedBundleIDs: allowed) == 1)
    #expect(try c.perform(.key("shift+Cmd+G"), allowedBundleIDs: allowed) == 1)
    #expect(throws: ScreenRefusal.keyNotInMenu(keys: "cmd+shift+k", app: "Notes Example")) {
      try c.perform(.key("cmd+shift+k"), allowedBundleIDs: allowed)
    }
    #expect(throws: ScreenRefusal.keyNotAllowed("cmd+shift+3")) { try c.perform(.key("cmd+shift+3"), allowedBundleIDs: allowed) }
    #expect(input.posted.count == 2)
  }

  @Test func aPanelThatTakesTheKeyboardMidwayStopsTheTyping() {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.focus = { input.posted.count >= 2 ? 4242 : Fx.notes.pid }
    let c = Fx.core(input: input, apps: a)
    #expect(throws: ScreenRefusal.focusElsewhere(app: "Notes Example")) {
      try c.perform(.type(String(repeating: "abcdefgh", count: 10)), allowedBundleIDs: allowed)
    }
    #expect(input.posted.count == 2)
  }
}

@Suite("Screen input: Talos's own hotkeys, shared between threads")
struct LockedHotkeysTests {
  @Test func writesOnOneThreadAndReadsOnAnotherNeverTear() async {
    let box = LockedValue<[ScreenKeyCombo]>([])
    let a = ScreenKeyCombo(keyCode: 49, flags: ScreenKeyCombo.ctrl | ScreenKeyCombo.opt)
    let b = ScreenKeyCombo(keyCode: 40, flags: ScreenKeyCombo.cmd)
    await withTaskGroup(of: Void.self) { g in
      g.addTask { for i in 0..<5000 { box.value = i % 2 == 0 ? [a] : [b, a] } }
      g.addTask { for _ in 0..<5000 { let v = box.value; #expect(v.isEmpty || v == [a] || v == [b, a]) } }
    }
  }
}

/// R3-3: the front app's menu shortcuts are read 4 menus deep (Edit > Find > Find… is cmd+f), and never from the Services
/// submenu, whose shortcuts belong to other apps.
@Suite("Screen input: reading the app's menus")
struct MenuWalkTests {
  final class Node {
    let role: String
    let combo: ScreenKeyCombo?
    let kids: [Node]
    init(_ role: String, _ combo: String? = nil, _ kids: [Node] = []) {
      self.role = role
      self.combo = combo.map { try! ScreenKeyCombo.parse($0) }
      self.kids = kids
    }
  }
  static func item(_ combo: String?, submenu: [Node] = []) -> Node { Node("AXMenuItem", combo, submenu.isEmpty ? [] : [Node("AXMenu", nil, submenu)]) }
  static func top(_ items: [Node]) -> Node { Node("AXMenuBarItem", nil, [Node("AXMenu", nil, items)]) }

  @Test func submenusAreReadAndServicesIsNot() {
    let bar = Node("AXMenuBar", nil, [
      Self.top([Self.item("cmd+q"), Self.item(nil, submenu: [Self.item("cmd+shift+l")])]),  // the app menu; its submenu is Services
      Self.top([
        Self.item("cmd+c"),
        Self.item(nil, submenu: [  // Find
          Self.item("cmd+f"),
          Self.item(nil, submenu: [  // a third menu
            Self.item("cmd+g"),
            Self.item(nil, submenu: [  // the fourth
              Self.item("cmd+opt+j"),
              Self.item(nil, submenu: [Self.item("cmd+e")]),  // a fifth: past the limit
            ]),
          ]),
        ]),
      ]),
    ])
    let got = MenuWalk.shortcuts(bar: bar, children: { $0.kids }, role: { $0.role }, shortcut: { $0.combo })
    let want = ["cmd+q", "cmd+c", "cmd+f", "cmd+g", "cmd+opt+j"].map { try! ScreenKeyCombo.parse($0) }
    #expect(got == want)
    #expect(!got.contains(try! ScreenKeyCombo.parse("cmd+shift+l")), "Services")
  }
}

/// R3-1: what a click lands on. On this Mac the menu-bar strip is covered by an invisible (alpha 0) window of Chrome at level 26:
/// taking the first window under the point, Chrome allowed meant a click could reach any menu bar extra (Talos's own included)
/// and the Apple menu. The list below mirrors that Mac, front to back.
@Suite("Screen input: what is under the pointer")
struct ScreenPointOwnerTests {
  static func w(_ pid: Int32, _ name: String, _ r: CGRect, layer: Int, alpha: Double = 1, bundle: String? = nil, id: UInt32 = 0) -> ScreenPointWindow {
    ScreenPointWindow(pid: pid, name: name, bundleID: bundle, bounds: r, layer: layer, alpha: alpha, onScreen: true, windowID: id)
  }
  static let mac: [ScreenPointWindow] = [
    w(40, "Google Chrome", CGRect(x: 0, y: 0, width: 1512, height: 33), layer: 26, alpha: 0, bundle: "com.google.Chrome", id: 1),
    w(60, "Talos", CGRect(x: 1250, y: 0, width: 30, height: 24), layer: 25, bundle: "app.talos.desktop", id: 2),
    w(61, "Control Center", CGRect(x: 1300, y: 0, width: 30, height: 24), layer: 25, bundle: "com.apple.controlcenter", id: 3),
    w(0, "Window Server", CGRect(x: 0, y: 0, width: 1512, height: 33), layer: 24, id: 4),
    w(40, "Google Chrome", CGRect(x: 200, y: 200, width: 100, height: 100), layer: 0, alpha: 0, bundle: "com.google.Chrome", id: 5),
    w(501, "Notes Example", CGRect(x: 150, y: 150, width: 300, height: 300), layer: 0, bundle: "com.example.notes", id: 6),
    w(40, "Google Chrome", CGRect(x: 0, y: 33, width: 1512, height: 900), layer: 0, bundle: "com.google.Chrome", id: 7),
  ]
  static let chrome = ScreenApp(bundleID: "com.google.Chrome", pid: 40, name: "Google Chrome")
  static let notes = ScreenApp(bundleID: "com.example.notes", pid: 501, name: "Notes Example")

  @Test func theMenuBarAndItsExtrasAreNeverAnAppsWindow() {
    // the server names a level 24+ window there (live: the window server's own menu bar window), or cannot be asked
    for p in [CGPoint(x: 10, y: 10), CGPoint(x: 700, y: 10), CGPoint(x: 1260, y: 10), CGPoint(x: 1310, y: 10)] {
      for hit: UInt32? in [1, 2, 3, 4, 999, nil] {
        #expect(ScreenPointWindow.owner(at: p, in: Self.mac, hit: hit) == .systemArea, "\(p) \(String(describing: hit))")
      }
    }
  }

  @Test func theOwnerIsTheWindowTheServerHitNotTheFirstOneListed() {
    // (250, 250): the invisible Chrome window above Notes owns the click when the server hits it, Notes when the server hits Notes
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 250, y: 250), in: Self.mac, hit: 5) == .coveredBy(Self.chrome))
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 250, y: 250), in: Self.mac, hit: 6) == .app(Self.notes))
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 900, y: 600), in: Self.mac, hit: 7) == .app(Self.chrome))
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 5000, y: 5000), in: Self.mac, hit: 0) == .nothing)
  }

  @Test func aServerThatCannotBeAskedOrNamesAWindowTheListLacksIsRefused() {
    let p = CGPoint(x: 400, y: 400)
    #expect(ScreenPointWindow.owner(at: p, in: Self.mac, hit: nil) == .systemArea)
    #expect(ScreenPointWindow.owner(at: p, in: Self.mac, hit: 999) == .systemArea)
    // a hit window that does not hold the point, or is off screen, is not an owner
    #expect(ScreenPointWindow.owner(at: p, in: Self.mac, hit: 5) == .systemArea)
    var off = Self.mac
    off[5].onScreen = false
    #expect(ScreenPointWindow.owner(at: p, in: off, hit: 6) == .systemArea)
  }

  /// R1-2: the all-windows list is not in stacking order, so a window of an app that is not allowed, over an allowed window, used to be
  /// attributed to the allowed app. The owner is what the server hits, whatever the list's order is.
  @Test func aDockOrFloatingPanelOverAnAllowedWindowIsThatOtherAppsPoint() throws {
    let r = CGRect(x: 0, y: 0, width: 400, height: 400)
    let allowedWindow = Self.w(501, "Notes Example", r, layer: 0, bundle: "com.example.notes", id: 10)
    let dock = Self.w(697, "Dock", CGRect(x: 100, y: 100, width: 100, height: 100), layer: 20, bundle: "com.apple.dock", id: 11)
    let panel = Self.w(502, "Secret Example", CGRect(x: 100, y: 100, width: 100, height: 100), layer: 3, bundle: "com.example.secret", id: 12)
    for (top, other) in [(dock, "com.apple.dock"), (panel, "com.example.secret")] {
      // listed the way the all-windows list can list them: the allowed window first, the covering one after it
      for list in [[top, allowedWindow], [allowedWindow, top]] {
        let apps = FakeApps(front: Fx.notes)
        apps.owner = { ScreenPointWindow.owner(at: $0, in: list, hit: top.windowID) }
        let input = FakeInput()
        #expect(throws: ScreenRefusal.self, Comment(rawValue: other)) {
          try Fx.core(input: input, apps: apps).perform(.click(CGPoint(x: 150, y: 150)), allowedBundleIDs: ["com.example.notes"])
        }
        #expect(input.posted.isEmpty, Comment(rawValue: other))
      }
    }
    // and a click on the allowed app's own visible window, beside the panel, still goes through
    let apps = FakeApps(front: Fx.notes)
    apps.owner = { ScreenPointWindow.owner(at: $0, in: [panel, dock, allowedWindow], hit: 10) }
    let input = FakeInput()
    #expect(try Fx.core(input: input, apps: apps).perform(.click(CGPoint(x: 300, y: 300)), allowedBundleIDs: ["com.example.notes"]) == 1)
    #expect(input.posted.count == 1)
  }

  /// The layers of a real desktop's on-screen list, front to back, are not monotonic (a recorded list reads 2147483630, 2004, 2003,
  /// 2001, 8, 1000, 25, 24, 0, then negative wallpaper levels). Both the owner and the top-window check must rest on the list's ORDER
  /// and the server's hit, never on the layer numbers rising or falling.
  static let recorded: [ScreenPointWindow] = {
    let full = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let mid = CGRect(x: 400, y: 400, width: 300, height: 300)
    let dot = CGRect(x: 0, y: 0, width: 4, height: 4)
    return [
      w(90, "Overlay Example", dot, layer: 2_147_483_630, alpha: 0, id: 20),
      w(91, "Shield Example", dot, layer: 2004, alpha: 0, id: 21),
      w(92, "Popup Example", dot, layer: 2003, alpha: 0, id: 22),
      w(93, "Cursor Example", dot, layer: 2001, alpha: 0, id: 23),
      w(501, "Notes Example", mid, layer: 8, bundle: "com.example.notes", id: 24),
      w(61, "Status Example", full, layer: 1000, bundle: "com.example.status", id: 25),
      w(60, "Menu Extra Example", CGRect(x: 1250, y: 0, width: 30, height: 24), layer: 25, bundle: "com.example.extra", id: 26),
      w(0, "Window Server", CGRect(x: 0, y: 0, width: 1512, height: 33), layer: 24, id: 27),
      w(40, "Browser Example", full, layer: 0, bundle: "com.example.browser", id: 28),
      w(95, "Wallpaper Example", full, layer: -2_147_483_624, bundle: "com.example.wallpaper", id: 29),
    ]
  }()

  static let recordedNotes = recorded[4]
  static let recordedBrowser = recorded[8]

  @Test func theTopVisibleWindowIsTheFirstEligibleOneInListOrderNotTheLowestOrHighestLayer() {
    // layer 8 is listed before layer 0, so the layer-8 window wins over the browser's layer-0 one; the windows at 2001 and above,
    // 1000, 25 and 24 around it are not eligible
    #expect(ScreenPointWindow.topVisibleAppPID(in: Self.recorded) == 501)
    // a layer-0 window listed first and the layer-8 one later: the layer-0 window wins, a higher number does not
    let browser = Self.recordedBrowser
    let notes = Self.recordedNotes
    #expect(ScreenPointWindow.topVisibleAppPID(in: [browser, notes]) == 40)
    #expect(ScreenPointWindow.topVisibleAppPID(in: [Self.recorded[0], browser] + Self.recorded[4...]) == 40)
  }

  /// The window server's own list on this Mac: only that it is read at all (a broken `kCGWindowNumber` read would give every window
  /// id 0, and every click would then be refused). No order is asserted: it is a property of the machine's screen, not of our code.
  @Test func theLiveWindowListIsReadWithIdsAndPids() throws {
    let list = try #require(LiveScreenApps.windowList())
    try #require(!list.isEmpty)
    #expect(list.contains { $0.windowID != 0 && $0.pid > 0 })
  }

  @Test func theOwnerIsTheWindowTheServerNamesWhereverItSitsInTheList() {
    let p = CGPoint(x: 500, y: 500)
    let notes = ScreenApp(bundleID: "com.example.notes", pid: 501, name: "Notes Example")
    let browser = ScreenApp(bundleID: "com.example.browser", pid: 40, name: "Browser Example")
    // the layer-8 window is listed first and the layer-0 one near the end: each is credited when, and only when, it is the hit
    #expect(ScreenPointWindow.owner(at: p, in: Self.recorded, hit: 24) == .app(notes))
    #expect(ScreenPointWindow.owner(at: p, in: Self.recorded, hit: 28) == .app(browser))
    #expect(ScreenPointWindow.owner(at: p, in: Self.recorded.reversed(), hit: 28) == .app(browser))
    #expect(ScreenPointWindow.owner(at: p, in: Self.recorded.reversed(), hit: 24) == .app(notes))
    // a hit on the level-1000 window, on a level 24 or 25 one, or on one far above them is system area
    #expect(ScreenPointWindow.owner(at: p, in: Self.recorded, hit: 25) == .systemArea)
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 1260, y: 10), in: Self.recorded, hit: 26) == .systemArea)
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 10, y: 10), in: Self.recorded, hit: 27) == .systemArea)
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 2, y: 2), in: Self.recorded, hit: 20) == .systemArea)
  }

  static let screen = CGSize(width: 1512, height: 982)

  @Test func theRealDocksScreenWideWindowIsNotTheTopWindowForTheKeyboard() {
    let dock = Self.w(697, "Dock", CGRect(origin: .zero, size: Self.screen), layer: 20, bundle: "com.apple.dock")
    let mine = Self.w(501, "Notes Example", CGRect(x: 0, y: 0, width: 300, height: 300), layer: 0, bundle: "com.example.notes")
    #expect(ScreenPointWindow.topVisibleAppPID(in: [dock, mine], realDockPID: 697, screenSizes: [Self.screen]) == 501)
    // a window a little larger than the screen (spanning a second display) is still the event window
    let wide = Self.w(697, "Dock", CGRect(x: 0, y: 0, width: 3000, height: 982), layer: 20, bundle: "com.apple.dock")
    #expect(ScreenPointWindow.topVisibleAppPID(in: [wide, mine], realDockPID: 697, screenSizes: [Self.screen]) == 501)
  }

  /// R2-1: an app that only claims the Dock's bundle id gets no skip: its panel above the allowed app is on top, so the allowed app
  /// does not own the keyboard (`appOwnsKeyboard` is this pid compared with the app's).
  @Test func anImpostorWithTheDocksIdIsStillOnTop() {
    let panel = Self.w(999, "Fake Dock", CGRect(origin: .zero, size: Self.screen), layer: 20, bundle: "com.apple.dock")
    let mine = Self.w(501, "Notes Example", CGRect(x: 0, y: 0, width: 300, height: 300), layer: 0, bundle: "com.example.notes")
    #expect(ScreenPointWindow.topVisibleAppPID(in: [panel, mine], realDockPID: 697, screenSizes: [Self.screen]) == 999)
    // and with no real Dock known, nothing is skipped
    #expect(ScreenPointWindow.topVisibleAppPID(in: [panel, mine]) == 999)
  }

  @Test func theRealDocksOtherWindowsStillCountAsOnTop() {
    let mine = Self.w(501, "Notes Example", CGRect(x: 0, y: 0, width: 300, height: 300), layer: 0, bundle: "com.example.notes")
    let small = Self.w(697, "Dock", CGRect(x: 600, y: 900, width: 300, height: 80), layer: 20, bundle: "com.apple.dock")
    let otherLevel = Self.w(697, "Dock", CGRect(origin: .zero, size: Self.screen), layer: 3, bundle: "com.apple.dock")
    for w in [small, otherLevel] {
      #expect(ScreenPointWindow.topVisibleAppPID(in: [w, mine], realDockPID: 697, screenSizes: [Self.screen]) == 697, Comment(rawValue: w.name))
    }
  }

  @Test func theRealDockIsFoundByItsSystemBundleNotItsId() throws {
    // on a Mac the Dock is running: its pid is the one whose bundle is the system's Dock.app
    let pid = try #require(LiveScreenApps.realDockPID())
    #expect(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.dock")
  }

  @Test func theTopVisibleWindowSkipsInvisibleSlivers() {
    let sliver = Self.w(61, "UserNotificationCenter", CGRect(x: 0, y: 0, width: 4, height: 4), layer: 8, alpha: 0)
    let big = CGRect(x: 0, y: 0, width: 300, height: 300)
    let mine = Self.w(501, "Notes Example", big, layer: 0)
    let other = Self.w(40, "Google Chrome", big, layer: 0)
    #expect(ScreenPointWindow.topVisibleAppPID(in: [sliver, mine, other]) == 501)
    #expect(ScreenPointWindow.topVisibleAppPID(in: [sliver, other, mine]) == 40)
    // small but visible, invisible but big, off screen, and system layers are all skipped too
    let tiny = Self.w(70, "T", CGRect(x: 0, y: 0, width: 39, height: 300), layer: 0)
    let ghost = Self.w(71, "G", big, layer: 0, alpha: 0)
    var off = Self.w(72, "O", big, layer: 0)
    off.onScreen = false
    let menu = Self.w(73, "M", big, layer: 25)
    #expect(ScreenPointWindow.topVisibleAppPID(in: [tiny, ghost, off, menu, mine]) == 501)
    #expect(ScreenPointWindow.topVisibleAppPID(in: [sliver]) == nil)
  }

  @Test func aClickUnderAnotherAppsInvisibleWindowIsDecidedByThatAppsAllowListEntry() throws {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    let chrome = ScreenApp(bundleID: "com.google.Chrome", pid: 40, name: "Google Chrome")
    a.owner = { _ in .coveredBy(chrome) }
    let c = Fx.core(input: input, apps: a)
    let want = ScreenRefusal.coveredByInvisibleWindow(app: "Google Chrome")
    #expect(throws: want) { try c.perform(.click(CGPoint(x: 5, y: 5)), allowedBundleIDs: ["com.example.notes"]) }
    #expect(want.reason == "An invisible window of Google Chrome covers that point, and Google Chrome isn't allowed. Nothing was clicked: take a screenshot, or click another point.")
    #expect(input.posted.isEmpty)
    // allowed: the click goes through
    #expect(try c.perform(.click(CGPoint(x: 5, y: 5)), allowedBundleIDs: ["com.example.notes", "com.google.Chrome"]) == 1)
  }

  @Test func aClickOnTheMenuBarIsRefusedInWordsWithAnAllowedAppInFront() {
    let input = FakeInput()
    let a = FakeApps(front: Fx.notes)
    a.under = { _ in Fx.notes }
    a.systemArea = { $0.y < 33 }
    #expect(throws: ScreenRefusal.systemArea) { try Fx.core(input: input, apps: a).perform(.click(CGPoint(x: 700, y: 10)), allowedBundleIDs: ["com.example.notes"]) }
    #expect(throws: ScreenRefusal.systemArea) {
      try Fx.core(input: input, apps: a).perform(.scroll(at: CGPoint(x: 700, y: 10), dx: 0, dy: 5), allowedBundleIDs: ["com.example.notes"])
    }
    #expect(input.posted.isEmpty)
    #expect(ScreenRefusal.systemArea.reason == "That spot is the menu bar or a system overlay, which Talos never clicks for an agent. Nothing was clicked.")
  }
}

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

  @Test func theFieldIsReadBackOnceAfterTyping() throws {
    let a = FakeApps(front: Fx.notes)
    let c = Fx.core(apps: a)
    let all: ScreenAllowed = .ids(["com.example.notes"])
    a.value = { $0 == Fx.notes.pid ? "before hello there" : nil }
    #expect(try c.typeText("hello", allowed: all) == (1, .verified))
    let long = String(repeating: "x", count: 100) + "END"
    a.value = { _ in long }
    #expect(try c.typeText("hello", allowed: all) == (1, .mismatch(suffix: String(long.suffix(40)))))
    a.value = { _ in nil }
    #expect(try c.typeText("hello", allowed: all) == (1, .unverified))
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
    // call 1 is the gate, 2 the check after the last piece, 3 the read-back's own look: the front changes just before it
    a.onFrontmost = { n in if n == 3 { a.front = Fx.secret } }
    let c = Fx.core(apps: a)
    #expect(try c.typeText("hello", allowed: .ids(["com.example.notes"])) == (1, .unverified))
    #expect(reads.pids.isEmpty, "no read for any pid, Secret's least of all")
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
  static func w(_ pid: Int32, _ name: String, _ r: CGRect, layer: Int, alpha: Double = 1, bundle: String? = nil) -> ScreenPointWindow {
    ScreenPointWindow(pid: pid, name: name, bundleID: bundle, bounds: r, layer: layer, alpha: alpha, onScreen: true)
  }
  static let mac: [ScreenPointWindow] = [
    w(40, "Google Chrome", CGRect(x: 0, y: 0, width: 1512, height: 33), layer: 26, alpha: 0, bundle: "com.google.Chrome"),
    w(60, "Talos", CGRect(x: 1250, y: 0, width: 30, height: 24), layer: 25, bundle: "app.talos.desktop"),
    w(61, "Control Center", CGRect(x: 1300, y: 0, width: 30, height: 24), layer: 25, bundle: "com.apple.controlcenter"),
    w(0, "Window Server", CGRect(x: 0, y: 0, width: 1512, height: 33), layer: 24),
    w(40, "Google Chrome", CGRect(x: 200, y: 200, width: 100, height: 100), layer: 0, alpha: 0, bundle: "com.google.Chrome"),
    w(501, "Notes Example", CGRect(x: 150, y: 150, width: 300, height: 300), layer: 0, bundle: "com.example.notes"),
    w(40, "Google Chrome", CGRect(x: 0, y: 33, width: 1512, height: 900), layer: 0, bundle: "com.google.Chrome"),
  ]

  @Test func theMenuBarAndItsExtrasAreNeverAnAppsWindow() {
    for p in [CGPoint(x: 10, y: 10), CGPoint(x: 700, y: 10), CGPoint(x: 1260, y: 10), CGPoint(x: 1310, y: 10)] {
      #expect(ScreenPointWindow.owner(at: p, in: Self.mac) == .systemArea, "\(p)")
    }
  }

  @Test func anInvisibleWindowIsSkippedAndTheVisibleOneBelowOwnsThePoint() {
    // (250, 250) lies under an invisible Chrome window above Notes: Chrome owns it, see anInvisibleWindowOfAnotherAppAboveTheTargetOwnsThePoint
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 250, y: 250), in: Self.mac) == .coveredBy(ScreenApp(bundleID: "com.google.Chrome", pid: 40, name: "Google Chrome")))
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 400, y: 400), in: Self.mac) == .app(ScreenApp(bundleID: "com.example.notes", pid: 501, name: "Notes Example")))
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 900, y: 600), in: Self.mac) == .app(ScreenApp(bundleID: "com.google.Chrome", pid: 40, name: "Google Chrome")))
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 5000, y: 5000), in: Self.mac) == .nothing)
    // a window off screen is not under anything
    var off = Self.mac
    off[5].onScreen = false
    #expect(ScreenPointWindow.owner(at: CGPoint(x: 160, y: 160), in: off) == .app(ScreenApp(bundleID: "com.google.Chrome", pid: 40, name: "Google Chrome")))
  }

  @Test func anInvisibleWindowOfAnotherAppAboveTheTargetOwnsThePoint() {
    let p = CGPoint(x: 50, y: 50)
    let r = CGRect(x: 0, y: 0, width: 100, height: 100)
    let notes = ScreenApp(bundleID: "com.example.notes", pid: 501, name: "Notes Example")
    let visible = Self.w(501, "Notes Example", r, layer: 0, bundle: "com.example.notes")
    let chrome = ScreenApp(bundleID: "com.google.Chrome", pid: 40, name: "Google Chrome")
    for layer in [0, 3, 23] {
      #expect(
        ScreenPointWindow.owner(at: p, in: [Self.w(40, "Google Chrome", r, layer: layer, alpha: 0, bundle: "com.google.Chrome"), visible])
          == .coveredBy(chrome), "layer \(layer)")
    }
    // the same app's own invisible window is no cover
    #expect(ScreenPointWindow.owner(at: p, in: [Self.w(501, "Notes Example", r, layer: 0, alpha: 0), visible]) == .app(notes))
    // an invisible window below the target is skipped as before
    #expect(ScreenPointWindow.owner(at: p, in: [visible, Self.w(40, "Google Chrome", r, layer: 0, alpha: 0)]) == .app(notes))
    // no invisible window: unchanged
    #expect(ScreenPointWindow.owner(at: p, in: [visible, Self.w(40, "Google Chrome", r, layer: 0)]) == .app(notes))
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

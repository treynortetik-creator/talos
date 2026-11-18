import CoreGraphics
import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("Screen input: only into an allowed app in front, never into Talos")
struct ScreenInputTests {
  let allowed: Set<String> = ["com.example.notes"]
  let p = CGPoint(x: 50, y: 50)

  func apps(front: ScreenApp?, under: ScreenApp? = Fx.notes) -> FakeApps {
    let a = FakeApps(front: front)
    a.under = { _ in under }
    return a
  }

  @Test func anAllowedAppInFrontGetsTheEvents() throws {
    let input = FakeInput()
    let core = Fx.core(input: input, apps: apps(front: Fx.notes))
    try core.perform(.click(p, button: .right, count: 2), allowedBundleIDs: allowed)
    try core.perform(.key("cmd+shift+t"), allowedBundleIDs: allowed)
    try core.perform(.scroll(at: p, dx: 0, dy: -120), allowedBundleIDs: allowed)
    #expect(try core.perform(.type("hello"), allowedBundleIDs: allowed) == 1)
    #expect(
      input.posted == [
.click(p, button: .right, count: 1), .click(p, button: .right, count: 2), .key(ScreenKeyCombo(keyCode: 17, flags: ScreenKeyCombo.cmd | ScreenKeyCombo.shift)),
        .scroll(at: p, dx: 0, dy: -120), .text("hello"),
      ])
  }

  @Test func withoutAccessibilityNothingIsPosted() {
    // CGEvent drops events silently without the grant, so a post would read as done when nothing happened
    let input = FakeInput()
    let core = Fx.core(input: input, apps: apps(front: Fx.notes), permissions: FakePermissions(ax: false))
    for r: ScreenInputRequest in [.click(p), .type("x"), .key("a"), .scroll(at: p, dx: 1, dy: 0)] {
      #expect(throws: ScreenRefusal.accessibilityNotGranted) { try core.perform(r, allowedBundleIDs: allowed) }
    }
    #expect(input.posted.isEmpty)
  }

  @Test func anUngrantedAppInFrontIsRefused() {
    let input = FakeInput()
    let core = Fx.core(input: input, apps: apps(front: Fx.secret, under: Fx.secret))
    for r: ScreenInputRequest in [.click(p), .type("x"), .key("return"), .scroll(at: p, dx: 0, dy: 5)] {
      #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.secret", subject: .running(pid: 502))) { try core.perform(r, allowedBundleIDs: allowed) }
    }
    #expect(input.posted.isEmpty)
  }

  /// Talos is an app like any other: off the list it is refused as such, on the list it is driven (a card's buttons stay the owner's:
  /// `SyntheticInputTests`).
  @Test func talosInFrontIsRefusedOffTheListAndDrivenOnIt() throws {
    let input = FakeInput()
    let core = Fx.core(input: input, apps: apps(front: Fx.talos, under: Fx.talos))
    #expect(throws: ScreenRefusal.appNotAllowed(app: ScreenCore.talosBundleID, subject: .running(pid: 777))) {
      try core.perform(.type("x"), allowedBundleIDs: allowed)
    }
    #expect(input.posted.isEmpty)
    let withTalos = allowed.union([ScreenCore.talosBundleID])
    #expect(try core.perform(.type("x"), allowedBundleIDs: withTalos) == 1)
    #expect(try core.perform(.click(p), allowedBundleIDs: withTalos) == 1)
    #expect(try core.perform(.key("return"), allowedBundleIDs: withTalos) == 1)
    #expect(input.posted.count == 3)
    // an allowed app in front with a Talos window over the click: Talos is not on the list, so that click is refused as any other app's
    let over = Fx.core(input: FakeInput(), apps: apps(front: Fx.notes, under: Fx.talos))
    #expect(throws: ScreenRefusal.appNotAllowed(app: ScreenCore.talosBundleID, subject: .running(pid: 777))) {
      try over.perform(.click(p), allowedBundleIDs: allowed)
    }
  }

  @Test func aClickLandingOnAnUngrantedWindowIsRefusedEvenWithAnAllowedAppInFront() {
    let input = FakeInput()
    let core = Fx.core(input: input, apps: apps(front: Fx.notes, under: Fx.secret))
    #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.secret", subject: .running(pid: 502))) { try core.perform(.click(p), allowedBundleIDs: allowed) }
    #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.secret", subject: .running(pid: 502))) {
      try core.perform(.scroll(at: p, dx: 0, dy: 1), allowedBundleIDs: allowed)
    }
    // Typing goes to the focused app, not to the pointer, so it is not blocked by what is under the pointer
    #expect(throws: Never.self) { try core.perform(.type("ok"), allowedBundleIDs: allowed) }
    let nothing = Fx.core(input: input, apps: apps(front: Fx.notes, under: nil))
    #expect(throws: ScreenRefusal.nothingAtPoint) { try nothing.perform(.click(p), allowedBundleIDs: allowed) }
    #expect(input.posted == [.text("ok")])
  }

  @Test func noFrontAppOrOneWithNoIdIsRefused() {
    let input = FakeInput()
    #expect(throws: ScreenRefusal.noFrontmostApp) {
      try Fx.core(input: input, apps: apps(front: nil)).perform(.type("x"), allowedBundleIDs: allowed)
    }
    let noID = ScreenApp(bundleID: nil, pid: 600, name: "Loose Tool")
    // An empty id on the list does not match an app with no id
    #expect(throws: ScreenRefusal.appNotAllowed(app: "Loose Tool", subject: .running(pid: 600))) {
      try Fx.core(input: input, apps: apps(front: noID)).perform(.type("x"), allowedBundleIDs: allowed.union([""]))
    }
    #expect(input.posted.isEmpty)
  }

  /// The front app is checked before every piece of text: switching apps mid-way stops the typing at that point.
  @Test func switchingAppsWhileTypingStopsTheRest() {
    let input = FakeInput()
    let a = apps(front: Fx.notes)
    input.after = { n in if n == 2 { a.front = Fx.secret } }
    let core = Fx.core(input: input, apps: a)
    let text = String(repeating: "abcdefgh", count: 10)  // 80 characters, five pieces
    #expect(throws: ScreenRefusal.frontChanged(app: "Notes Example")) { try core.perform(.type(text), allowedBundleIDs: allowed) }
    #expect(input.posted.count == 2)
    #expect(input.posted.allSatisfy { if case .text(let s) = $0 { s.utf16.count <= 16 } else { false } })
  }

  @Test func textIsCutIntoWholeCharacters() {
    let family = "👨‍👩‍👧‍👦"  // 11 UTF-16 units, one character
    let pieces = ScreenCore.chunks("ab" + family + "é" + family + String(repeating: "x", count: 20))
    #expect(pieces.joined() == "ab" + family + "é" + family + String(repeating: "x", count: 20))
    #expect(pieces.allSatisfy { $0.utf16.count <= ScreenCore.textChunkUnits })
    #expect(pieces.first == "ab" + family + "é")
    // A single character past the limit is a piece of its own rather than split
    let huge = "a" + String(repeating: "\u{0301}", count: 30)
    #expect(ScreenCore.chunks(huge) == [huge])
  }

  @Test func badRequestsAreRefusedBeforeAnyEvent() {
    let input = FakeInput()
    let core = Fx.core(input: input, apps: apps(front: Fx.notes))
    let bad: [ScreenInputRequest] = [
      .click(p, count: 0), .click(p, count: 4), .click(CGPoint(x: CGFloat.nan, y: 0)), .click(CGPoint(x: 1e9, y: 0)), .type(""),
      .type(String(repeating: "x", count: ScreenCore.maxTypedCharacters + 1)), .key(""), .key("cmd"), .key("cmd+a+b"),
      .key("cmd+banana"), .key("cmd++a"), .scroll(at: p, dx: 0, dy: 0), .scroll(at: p, dx: 0, dy: 20_000),
    ]
    for r in bad {
      #expect(throws: ScreenRefusal.self, "\(r)") { try core.perform(r, allowedBundleIDs: allowed) }
    }
    #expect(input.posted.isEmpty)
  }

  @Test func keysParseInAnyOrderAndCase() throws {
    #expect(try ScreenKeyCombo.parse("Shift+CMD+t") == ScreenKeyCombo.parse("cmd+shift+t"))
    #expect(try ScreenKeyCombo.parse("return") == ScreenKeyCombo(keyCode: 36, flags: 0))
    #expect(try ScreenKeyCombo.parse("ctrl+opt+pagedown") == ScreenKeyCombo(keyCode: 121, flags: ScreenKeyCombo.ctrl | ScreenKeyCombo.opt))
    // The flag bits are CGEventFlags'
    #expect(ScreenKeyCombo.cmd == CGEventFlags.maskCommand.rawValue)
    #expect(ScreenKeyCombo.shift == CGEventFlags.maskShift.rawValue)
    #expect(ScreenKeyCombo.opt == CGEventFlags.maskAlternate.rawValue)
    #expect(ScreenKeyCombo.ctrl == CGEventFlags.maskControl.rawValue)
  }

  @Test func aFailedPostIsAnErrorNotASend() {
    let input = FakeInput()
    input.error = Boom(text: "event tap gone")
    let core = Fx.core(input: input, apps: apps(front: Fx.notes))
    #expect(throws: ScreenRefusal.inputFailed("event tap gone")) { try core.perform(.click(p), allowedBundleIDs: allowed) }
  }
}

@Suite("Screen apps")
struct ScreenAppsTests {
  @Test func opensOnlyAllowedApps() async {
    let a = FakeApps(front: Fx.notes)
    let core = Fx.core(apps: a)
    await #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.secret", subject: .installed(path: "/Apps/com.example.secret.app"))) {
      try await core.openApp(bundleID: "com.example.secret", allowedBundleIDs: ["com.example.notes"])
    }
    await #expect(throws: ScreenRefusal.self) { try await core.openApp(bundleID: "  ", allowedBundleIDs: [""]) }
    #expect(a.opened.isEmpty)
    await #expect(throws: Never.self) { try await core.openApp(bundleID: "com.example.notes", allowedBundleIDs: ["com.example.notes"]) }
    #expect(a.opened == ["com.example.notes"])
    // Talos is opened like any allowed app
    await #expect(throws: Never.self) { try await core.openApp(bundleID: ScreenCore.talosBundleID, allowedBundleIDs: [ScreenCore.talosBundleID]) }
    #expect(a.opened == ["com.example.notes", ScreenCore.talosBundleID])
  }

  @Test func aFailedOpenSaysSo() async {
    let a = FakeApps(front: nil)
    a.openError = Boom(text: "not installed")
    await #expect(throws: ScreenRefusal.openFailed(app: "com.example.notes", detail: "not installed")) {
      try await Fx.core(apps: a).openApp(bundleID: "com.example.notes", allowedBundleIDs: ["com.example.notes"])
    }
  }

  @Test func listsAppsByName() {
    let a = FakeApps(front: nil)
    a.running = [Fx.secret, ScreenApp(bundleID: "com.example.b", pid: 3, name: "beta"), Fx.notes]
    #expect(Fx.core(apps: a).runningApps().map(\.name) == ["beta", "Notes Example", "Secret Example"])
  }

  @Test func everyRefusalReadsAsOnePlainLine() {
    let all: [ScreenRefusal] = [
      .screenRecordingNotGranted, .accessibilityNotGranted, .filterUnavailable("a"), .captureFailed("b"), .encodeFailed("c"),
      .noDisplay, .displayNotFound(1), .windowNotFound(2), .regionOffScreen, .appNotAllowed(app: "d"), .protectedPrompt,
      .noFrontmostApp, .nothingAtPoint, .openFailed(app: "e", detail: "f"), .inputFailed("g"), .badRequest("h"),
    ]
    for r in all {
      #expect(!r.reason.isEmpty && !r.reason.contains("\n"), "\(r)")
    }
    #expect(ScreenRefusal.detail(Boom(text: "two\nlines")) == "two lines")
  }
}

import Foundation
import Testing
@testable import TalosDesktopCore

/// The computer-use permission dialog as the real Claude Code 2.1.322 draws it (Fixtures/real-2.1.322/computer-use-permissions*.txt, README),
/// and the rule for its one key (`ComputerUseDismiss`). Screens are the captures; a variant built from one in a test says SYNTHETIC.
@Suite("The computer-use permission dialog")
struct ComputerUseDialogTests {
  func rows(_ name: String) throws -> [String] { try RealScreens.rows(name, in: "real-2.1.322") }
  /// SYNTHETIC: the capture with one row replaced.
  func edited(_ name: String, _ change: (inout [String]) -> Void) throws -> [String] {
    var r = try rows(name)
    change(&r)
    return r
  }
  /// The row that holds `text`; for an option, the row that is that option (the dialog's own text names "Try again" too).
  func index(_ r: [String], _ text: String) -> Int? {
    let t = text.trimmingCharacters(in: .whitespaces)
    if DialogMatcher.Strings.computerUseOptions.contains(t) {
      return r.firstIndex { DialogMatcher.clean($0) == t }
    }
    return r.firstIndex { $0.contains(text) }
  }

  @Test(arguments: ["computer-use-permissions", "computer-use-permissions-6s"])
  func theRealDialogIsKnownByEveryReader(name: String) throws {
    let screen = try rows(name)
    #expect(screen.contains { $0.contains("Computer Use needs macOS permissions") }, "control: the capture has the title")
    let block = try #require(DialogMatcher.computerUseBlock(screen))
    #expect(block.first == DialogMatcher.Strings.computerUseTitle && block.last == DialogMatcher.Strings.selectFooter)
    #expect(DialogMatcher.classify(screen) == .computerUsePermissions)
    #expect(DialogMatcher.liveDialog(screen) == .computerUsePermissions)
    #expect(DialogMatcher.workerScreen(screen) == .computerUsePermissions)
    #expect(DialogMatcher.Screen.computerUsePermissions.isDialog)
    // never a prompt nobody named, and never a dialog a tap could answer (no card, so no Enter from the phone)
    #expect(PromptDetector.detect(screen) == nil)
    #expect(DialogReader.read(rows: screen) == nil)
    // the six-second capture differs only above the dialog: its own rows are the same, so a re-read finds the same dialog
    #expect(try DialogMatcher.computerUseBlock(rows("computer-use-permissions")) == block)
  }

  @Test func afterEscapeItIsGone() throws {
    let screen = try rows("computer-use-permissions-after-esc")
    #expect(DialogMatcher.computerUseBlock(screen) == nil)
    #expect(DialogMatcher.liveDialog(screen) == .none)
    #expect(DialogMatcher.classify(screen) == .none)
  }

  @Test func eitherPermissionMayReadGrantedAndTheCursorMayBeOnAnyOption() throws {
    // SYNTHETIC: one permission granted
    let granted = try edited("computer-use-permissions") { r in
      if let i = index(r, "Accessibility: ") { r[i] = "   Accessibility: ✔ granted" }
    }
    #expect(DialogMatcher.computerUseBlock(granted) != nil)
    // SYNTHETIC: the cursor moved to "Try again"
    let moved = try edited("computer-use-permissions") { r in
      if let a = index(r, "❯ Open System Settings → Accessibility") { r[a] = "     Open System Settings → Accessibility" }
      if let t = index(r, "     Try again") { r[t] = "   ❯ Try again" }
    }
    #expect(DialogMatcher.computerUseBlock(moved) != nil)
  }

  @Test func anythingButTheWholeDialogIsNotIt() throws {
    let bad: [(String, [String])] = try [
      ("no footer", edited("computer-use-permissions") { r in if let i = index(r, "Enter to confirm") { r[i] = "" } }),
      ("another footer", edited("computer-use-permissions") { r in if let i = index(r, "Enter to confirm") { r[i] = "  Enter to select · Esc to cancel" } }),
      ("another title", edited("computer-use-permissions") { r in if let i = index(r, "Computer Use needs") { r[i] = "  Computer Use needs your OK" } }),
      ("an option renamed", edited("computer-use-permissions") { r in if let i = index(r, "Try again") { r[i] = "     Allow anyway" } }),
      ("numbered options", edited("computer-use-permissions") { r in if let i = index(r, "Try again") { r[i] = "     3. Try again" } }),
      ("two cursors", edited("computer-use-permissions") { r in if let i = index(r, "     Try again") { r[i] = "   ❯ Try again" } }),
      ("no cursor", edited("computer-use-permissions") { r in if let i = index(r, "❯ Open") { r[i] = "     Open System Settings → Accessibility" } }),
      ("a permission row missing", edited("computer-use-permissions") { r in if let i = index(r, "Screen Recording: ") { r[i] = "" } }),
      ("a row after the footer", edited("computer-use-permissions") { r in r[r.count - 1] = "  more output" }),
    ]
    for (why, screen) in bad {
      #expect(DialogMatcher.computerUseBlock(screen) == nil, "\(why)")
      #expect(DialogMatcher.liveDialog(screen) != .computerUsePermissions, "\(why)")
    }
    // the dialog's words quoted in a conversation, with Claude's idle box below them: conversation, not the dialog
    let quoted = try rows("computer-use-permissions").prefix(28) + rows("computer-use-permissions-after-esc").suffix(4)
    #expect(DialogMatcher.computerUseBlock(Array(quoted)) == nil)
  }

  @Test func theKnownNameIsInEveryList() {
    #expect(DialogMatcher.Screen.computerUsePermissions.label == "computer-use permissions")
    #expect(WorkerNotice.promptName(.computerUsePermissions) == "computer-use permissions")
    #expect(MainRestartCheck.Last.ownLabels.contains("computer-use permissions"))
  }

  @Test func escapeIsTheOnlyKeyByName() {
    let t = TmuxCommands(tmux: "/usr/bin/tmux", socket: "talos-test-x", configPath: "/dev/null", session: "t-trip")
    let argv = t.sendEscape()
    #expect(argv.suffix(4) == ["send-keys", "-t", t.paneTarget, "Escape"])
    #expect(!argv.contains("Enter") && !argv.contains("-l") && !argv.contains("-H"))
  }

  // MARK: the rule for the key

  @Test func oncePerAppearanceThenTheNextAppearanceAgain() {
    var d = ComputerUseDismiss()
    do { let v = d.look(onScreen: false, now: 0); #expect(v == .gone) }
    do { let v = d.look(onScreen: true, now: 1); #expect(v == .press) }
    d.pressed(now: 1)
    // still drawn on the next look: never a second key for it
    do { let v = d.look(onScreen: true, now: 2); #expect(v == .pressed(stuck: false)) }
    #expect(!d.leftForOwner)
    do { let v = d.look(onScreen: true, now: 1 + ComputerUseDismiss.stuckAfter); #expect(v == .pressed(stuck: true)) }
    #expect(d.leftForOwner, "an Escape that did not take leaves it for the owner")
    do { let v = d.look(onScreen: false, now: 20); #expect(v == .fading) }
    do { let v = d.look(onScreen: false, now: 20 + ComputerUseDismiss.goneAfter); #expect(v == .gone) }
    #expect(!d.leftForOwner)
    do { let v = d.look(onScreen: true, now: 21 + ComputerUseDismiss.goneAfter); #expect(v == .press, "a new appearance") }
  }

  @Test func atMostThreeAnHourThenItIsLeftAndSaidOnce() {
    var d = ComputerUseDismiss()
    var t = 0.0
    for _ in 0..<ComputerUseDismiss.perHour {
      do { let v = d.look(onScreen: true, now: t); #expect(v == .press) }
      d.pressed(now: t)
      t += 60
      do { let v = d.look(onScreen: false, now: t); #expect(v == .fading) }
      do { let v = d.look(onScreen: false, now: t + ComputerUseDismiss.goneAfter); #expect(v == .gone) }
    }
    do { let v = d.look(onScreen: true, now: t); #expect(v == .limit(first: true)) }
    #expect(d.leftForOwner)
    do { let v = d.look(onScreen: true, now: t + 1); #expect(v == .limit(first: false)) }
    // an hour after the first press, one is free again
    do { let v = d.look(onScreen: false, now: 3600); #expect(v == .fading) }
    do { let v = d.look(onScreen: false, now: 3600 + ComputerUseDismiss.goneAfter); #expect(v == .gone) }
    do { let v = d.look(onScreen: true, now: 3600 + ComputerUseDismiss.goneAfter); #expect(v == .press) }
  }

  /// R1-2: one torn frame (a look that misses the dialog mid-redraw) does not end the appearance, so the same dialog never gets a second
  /// Escape; only looks that miss it for `goneAfter` do. A clock set back during the miss starts that wait over.
  @Test func oneTornFrameDoesNotEndTheAppearance() {
    var d = ComputerUseDismiss()
    do { let v = d.look(onScreen: true, now: 0); #expect(v == .press) }
    d.pressed(now: 0)
    do { let v = d.look(onScreen: false, now: 1); #expect(v == .fading, "a torn frame") }
    do { let v = d.look(onScreen: true, now: 1.5); #expect(v == .pressed(stuck: false), "the same appearance: no second key") }
    #expect(d.presses.count == 1)
    do { let v = d.look(onScreen: false, now: 2); #expect(v == .fading) }
    do { let v = d.look(onScreen: false, now: 0.5); #expect(v == .fading, "the clock went back: the wait starts over") }
    do { let v = d.look(onScreen: false, now: 0.5 + ComputerUseDismiss.goneAfter - 0.1); #expect(v == .fading) }
    do { let v = d.look(onScreen: false, now: 0.5 + ComputerUseDismiss.goneAfter); #expect(v == .gone) }
    do { let v = d.look(onScreen: true, now: 3); #expect(v == .press, "now a new appearance") }
    // at the limit too: a torn frame does not make it a new appearance with its own audit line
    var l = ComputerUseDismiss()
    for t in [0.0, 10, 20] {
      _ = l.look(onScreen: true, now: t)
      l.pressed(now: t)
      _ = l.look(onScreen: false, now: t + 1)
      _ = l.look(onScreen: false, now: t + 1 + ComputerUseDismiss.goneAfter)
    }
    do { let v = l.look(onScreen: true, now: 30); #expect(v == .limit(first: true)) }
    do { let v = l.look(onScreen: false, now: 31); #expect(v == .fading) }
    do { let v = l.look(onScreen: true, now: 32); #expect(v == .limit(first: false)) }
    // a dialog never pressed (its re-read changed) is gone on the first miss: nothing was sent to it
    var n = ComputerUseDismiss()
    do { let v = n.look(onScreen: true, now: 0); #expect(v == .press) }
    do { let v = n.look(onScreen: false, now: 1); #expect(v == .gone) }
  }

  @Test func aClockSetBackDoesNotHandOutPresses() {
    var d = ComputerUseDismiss()
    for t in [1000.0, 1001, 1002] {
      _ = d.look(onScreen: true, now: t)
      d.pressed(now: t)
      _ = d.look(onScreen: false, now: t)
      _ = d.look(onScreen: false, now: t + ComputerUseDismiss.goneAfter)
    }
    do { let v = d.look(onScreen: true, now: 10); #expect(v == .limit(first: true)) }
  }

  @Test func theOwnersLineAtMostOnceAnHour() {
    var d = ComputerUseDismiss()
    do { let v = d.mayTellOwner(now: 0); #expect(v) }
    do { let v = d.mayTellOwner(now: 10); #expect(!v) }
    do { let v = d.mayTellOwner(now: 3599); #expect(!v) }
    do { let v = d.mayTellOwner(now: 3600); #expect(v) }
    #expect(ComputerUseDismiss.ownerLine.hasPrefix("This session tried to use the screen, but macOS has not allowed it."))
  }

  // MARK: the lines when it is left for the owner (R1-1): Esc, never "answer"

  static let neverSaid = ["answer", "approve", "accept", "confirm", "grant", "allow"]

  @Test func theThreadsFallbackLineSaysEscAndInvitesNoAnswer() {
    let line = WorkerNotice.line(screen: .computerUsePermissions)
    #expect(
      line
        == "This thread's session is showing the computer-use permissions dialog, and Talos has left it on screen. To close it, press Esc in this thread's pane in Terminals; Esc is the only key to press there (Enter opens System Settings). The session carries on without screen control."
    )
    for w in Self.neverSaid { #expect(!line.lowercased().contains(w), "\(w): \(line)") }
    // every other dialog keeps its "answer" line: only this kind changed
    #expect(WorkerNotice.line(screen: .trust).hasSuffix("open this thread in Terminals on the Mac to answer."))
  }

  @Test func mainsLinesSayEscAndInviteNoAnswer() {
    let label = DialogMatcher.Screen.computerUsePermissions.label
    let menu = SupervisorNotice.mainDialog(label)
    #expect(menu == "the computer-use permissions dialog is on Main's pane; press Esc there to close it (Esc only: Enter opens System Settings)")
    let phone = MainRestartCheck.stallPhoneLine(label)
    #expect(
      phone
        == "Main restarted on request and is showing the computer-use permissions dialog at your Mac. To close it, press Esc in Main's pane; Esc is the only key to press there."
    )
    for line in [menu, phone] {
      for w in Self.neverSaid { #expect(!line.lowercased().contains(w), "\(w): \(line)") }
    }
    #expect(SupervisorNotice.mainDialog("folder trust") == "folder trust on screen")
    #expect(DialogMatcher.Screen.answerless(label: label) && DialogMatcher.Screen.computerUsePermissions.answerless)
    #expect(!DialogMatcher.Screen.answerless(label: "folder trust") && !DialogMatcher.Screen.trust.answerless)
  }
}

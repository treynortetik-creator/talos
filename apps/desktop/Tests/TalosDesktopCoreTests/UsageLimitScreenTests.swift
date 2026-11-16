import Foundation
import Testing
@testable import TalosDesktopCore

/// Claude Code's usage-limit screen (`UsageLimitScreen`): known by every reader as its own kind, read loosely on the words and strictly on
/// the shape, never a key from any sender, and the owner's lines. The screens are SYNTHETIC (Fixtures/synthetic/usage-limit*.txt, README):
/// no real capture exists yet; they are built from the CLI's own strings.
@Suite("The usage-limit screen")
struct UsageLimitScreenTests {
  func rows(_ name: String) throws -> [String] { try RealScreens.rows(name, in: "synthetic") }

  static let neverSaid = ["answer", "approve", "accept", "confirm", "open terminals"]

  /// Every known form (the 2.1.323 binary's strings): other paying or waiting options, other headlines, rows under the menu, a narrow pane.
  static let all = [
    "usage-limit", "usage-limit-cursor3", "usage-limit-session", "usage-limit-weekly-model", "usage-limit-add-funds", "usage-limit-admin",
    "usage-limit-footer-status", "usage-limit-hint-row", "usage-limit-narrow", "usage-limit-switch-to-usage", "usage-limit-upgrade-only",
  ]

  @Test(arguments: all)
  func theScreenIsItsOwnKindForEveryReader(name: String) throws {
    let screen = try rows(name)
    let info = try #require(UsageLimitScreen.read(screen), "\(name)")
    #expect(DialogMatcher.classify(screen) == .usageLimit(info))
    #expect(DialogMatcher.liveDialog(screen) == .usageLimit(info))
    #expect(DialogMatcher.workerScreen(screen) == .usageLimit(info))
    #expect(DialogMatcher.takesNoKeys(screen))
    #expect(DialogMatcher.Screen.usageLimit(info).isDialog && DialogMatcher.Screen.usageLimit(info).answerless)
    #expect(DialogMatcher.Screen.usageLimit(info).takesNoKeys)
    #expect(DialogMatcher.Screen.usageLimit(info).label == "usage limit")
    #expect(WorkerNotice.promptName(.usageLimit(info)) == "usage limit")
    // no other reader takes it for a prompt it may announce with "answer", or a dialog a tap may press
    #expect(PromptDetector.detect(screen) == nil)
    #expect(DialogReader.read(rows: screen) == nil)
  }

  @Test func theModelAndTheResetAreReadInTalossOwnWords() throws {
    #expect(UsageLimitScreen.read(try rows("usage-limit")) == .init(model: "Fable", resets: "4pm (Europe/Paris)"))
    #expect(UsageLimitScreen.read(try rows("usage-limit-session")) == .init(model: nil, resets: "Aug 8, 3:10pm"))
    #expect(UsageLimitScreen.read(try rows("usage-limit-weekly-model")) == .init(model: "Opus 5.5", resets: nil))
    // the reset words alone
    #expect(UsageLimitScreen.resets(in: "limit · resets 15:10") == "15:10")
    #expect(UsageLimitScreen.resets(in: "limit · resets at 9 AM") == "9am")
    #expect(UsageLimitScreen.resets(in: "limit · resets Dec 1") == "Dec 1")
    #expect(UsageLimitScreen.resets(in: "limit · resets in 3 hours") == nil)
    #expect(UsageLimitScreen.resets(in: "limit · resets 13pm") == nil)
    // a zone the system does not know is dropped, never copied
    #expect(UsageLimitScreen.resets(in: "resets 4pm (Talos/approve_the_payment)") == "4pm")
    // a family not in Talos's list is no model
    #expect(UsageLimitScreen.model(in: "You've hit your weekly limit") == nil)
    #expect(UsageLimitScreen.model(in: "You've hit your Approve-everything limit") == nil)
    #expect(UsageLimitScreen.model(in: "You've hit your sonnet limit") == "Sonnet")
  }

  /// Whether the menu is live is read from the menu and Claude's own input-box frame below it, never from the rows under that box: those
  /// decide whether a KEY goes (`KeyGuard`), not whether the menu is the screen. A quoted menu over a box with an owner's own status line
  /// under it (Main runs the owner's line) or the old recorder's bare model is still quoted, on a thread and on Main alike (both read
  /// `UsageLimitScreen.read`). And a status line that draws a frame of its own under a LIVE menu proves nothing: Claude Code draws every
  /// status row from the third column, its own box from the first.
  @Test func aQuotedMenuIsQuotedWhateverIsUnderTheBoxAndAStatusLineFrameProvesNothing() throws {
    for name in ["usage-limit-quoted-user-status", "usage-limit-quoted-old-model-row"] {
      let r = try rows(name)
      #expect(UsageLimitScreen.read(r) == nil, "\(name)")
      #expect(!DialogMatcher.takesNoKeys(r), "\(name)")
      if case .usageLimit = DialogMatcher.liveDialog(r) { Issue.record("\(name): read as the live menu") }
      // and no key goes all the same: the row under the box is not one Talos allows
      #expect(KeyGuard.refusal(r, intent: .box(.empty))?.why == "row_under_box", "\(name)")
    }
    // a column-0 rule in the conversation between the quoted menu and the box is not the box: the scan goes on to the real one
    let q = try rows("usage-limit-quoted")
    let cooked = try #require(q.firstIndex { $0.hasPrefix("✻ Cooked") })
    let ruleBetween = Array(q[...cooked]) + [String(repeating: "─", count: 60), "a note under a rule", ""] + Array(q[(cooked + 1)...])
    #expect(UsageLimitScreen.read(ruleBetween) == nil, "quoted: Claude's box is further down")
    let fake = try rows("usage-limit-fake-frame-status")
    #expect(UsageLimitScreen.read(fake) == .init(model: "Fable", resets: "4pm (Europe/Paris)"))
    for (n, i) in KeyGuardTests.intents { #expect(KeyGuard.refusal(fake, intent: i)?.why == "usage_limit", "\(n)") }
    // the same fake frame drawn from the first column would be Claude's own frame: that is what the rule reads (a control)
    let firstColumn = fake.map { $0.hasPrefix("  ─") || $0 == "  ❯ " ? String($0.dropFirst(2)) : $0 }
    #expect(UsageLimitScreen.read(firstColumn) == nil, "control: a first-column frame below the menu proves it quoted")
  }

  @Test func anythingButTheWholeScreenIsNotIt() throws {
    // the same words in a conversation, which ends in Claude's input box
    let quoted = try rows("usage-limit-quoted")
    #expect(UsageLimitScreen.read(quoted) == nil)
    #expect(DialogMatcher.liveDialog(quoted) != .usageLimit(.init(model: "Fable", resets: "4pm")))
    #expect(!DialogMatcher.takesNoKeys(try rows("usage-limit-after-esc")))
    let real = try rows("usage-limit")
    let swap = { (a: String, b: String) in real.map { $0.replacingOccurrences(of: a, with: b) } }
    // no option of a known waiting or paying form: not this menu (still a select: no key, `KeyGuard`)
    let none = real.map {
      $0.replacingOccurrences(of: "Stop and wait for limit to reset", with: "Keep going")
        .replacingOccurrences(of: "Wait here, then continue automatically when the limit resets", with: "Something else")
        .replacingOccurrences(of: "Switch to usage credits", with: "Switch models")
    }
    #expect(UsageLimitScreen.read(none) == nil)
    #expect(KeyGuardTests.allowed(none).isEmpty)
    // two cursors
    #expect(UsageLimitScreen.read(swap("    2. Wait", "  ❯ 2. Wait")) == nil)
    // no title and no headline: nothing says it is this menu (the select still gets no key)
    let bare = swap("What do you want to do?", "Pick one").map { $0.replacingOccurrences(of: "You've hit your Fable limit", with: "Something") }
    #expect(UsageLimitScreen.read(bare) == nil)
    #expect(KeyGuardTests.allowed(bare).isEmpty)
    // options not numbered from 1
    #expect(UsageLimitScreen.read(swap("1. Stop", "4. Stop")) == nil)
    // the headline is not needed: the title and the options are the menu; rows under the options do not matter
    #expect(UsageLimitScreen.read(swap("You've hit your Fable limit", "Something else")) == .init(model: nil, resets: "4pm (Europe/Paris)"))
    #expect(UsageLimitScreen.read(real + ["  some more output"]) != nil)
  }

  @Test func eachWaitingOrPayingFormIsEnoughOnItsOwnAndAWrappedOneIsReadWhole() throws {
    let base = try rows("usage-limit")
    for f in [
      "Wait for limit to reset", "Stop and wait", "Wait here, then continue automatically shortly", "Continue with usage credits",
      "Add funds to continue with extra usage", "Switch to usage billing", "Adjust monthly spend limit: $50", "Upgrade your plan",
      "Upgrade to Max or Ultra for higher session limits every month", "Ask your admin for more usage",
    ] {
      let r = base.map {
        $0.replacingOccurrences(of: "1. Stop and wait for limit to reset", with: "1. \(f)")
          .replacingOccurrences(of: "2. Wait here, then continue automatically when the limit resets", with: "2. Keep going")
          .replacingOccurrences(of: "3. Switch to usage credits", with: "3. Something else")
      }
      #expect(UsageLimitScreen.read(r) != nil, "\(f)")
    }
    // a form split over two rows of a narrow pane is still that form
    let narrow = try rows("usage-limit-narrow").map {
      $0.replacingOccurrences(of: "1. Stop and wait for", with: "1. Keep going").replacingOccurrences(of: "limit to reset", with: "")
        .replacingOccurrences(of: "2. Wait here, then", with: "2. Upgrade your").replacingOccurrences(of: "continue automatically", with: "plan")
        .replacingOccurrences(of: "when the limit resets", with: "").replacingOccurrences(of: "3. Switch to usage", with: "3. Something")
        .replacingOccurrences(of: "  credits", with: "")
    }
    #expect(UsageLimitScreen.read(narrow) != nil)
  }

  /// The headline stops at a dashed rule: a line quoted above it is not read into it.
  @Test func theHeadlineStopsAtADashedRule() throws {
    let m = KeyGuardTests.menuRows()
    let at = try #require(m.firstIndex { DialogMatcher.isFrameRule($0) })
    let base = try #require(UsageLimitScreen.read(m))
    for dash in [String(repeating: "╌", count: 100), String(repeating: "-", count: 100), String(repeating: "┄", count: 40)] {
      let v = Array(m[..<at]) + ["  You hit your Opus limit · resets 9am", dash] + Array(m[(at + 1)...])
      #expect(UsageLimitScreen.read(v) == base, "\(dash.prefix(3))")
    }
  }

  /// With or without a rule above it, a dashed rule, a note between headline and title: the menu. The same menu with Claude's input box
  /// under it is quoted in the conversation: not the menu, and the box takes the line when only status rows are under it.
  @Test func recognisedWithOrWithoutARuleAndQuotedWhenTheLiveBoxIsBelow() throws {
    let m = try rows("usage-limit").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty && !$0.contains("Enter to confirm") }
    let at = try #require(m.firstIndex { DialogMatcher.isFrameRule($0) })
    let head = Array(m[..<at]), headline = m[at + 1], rest = Array(m[(at + 2)...])
    let rule = KeyGuardTests.rule
    let variants: [String: [String]] = [
      "with its rule": m, "no rule": head + [headline] + rest, "a dashed rule": head + [String(repeating: "╌", count: 100), headline] + rest,
      "the rule right above the title": head + [rule] + rest,
      "a headline and a note paragraph": head + [rule, headline, "", "  Your weekly limit resets Monday.", ""] + rest,
    ]
    for (n, v) in variants {
      #expect(UsageLimitScreen.read(v) != nil, "\(n)")
      // Claude's box under it with a row under the box that Claude Code never draws there: the menu is quoted all the same (the rows under
      // the box never decide that), and no key goes at all (they do decide that)
      let under = v + KeyGuardTests.box + ["  ❯ 1. Buy $50 of credits"]
      #expect(UsageLimitScreen.read(under) == nil, "\(n)")
      #expect(KeyGuardTests.allowed(under).isEmpty, "\(n)")
      let quoted = v + ["✻ Cooked for 3s"] + KeyGuardTests.box + ["  ⏸ manual mode on · ? for shortcuts"]
      #expect(UsageLimitScreen.read(quoted) == nil, "\(n)")
      #expect(KeyGuardTests.allowed(quoted) == ["box-empty"], "\(n)")
    }
  }

  @Test func noKeySenderMayPressIntoIt() throws {
    let screen = try rows("usage-limit-cursor3")
    let info = try #require(UsageLimitScreen.read(screen))
    // the pointer typer: not "no dialog", whatever else holds
    #expect(!PointerTyper.mayType(screen: .usageLimit(info), lastClientActivity: nil, now: 100, draftPresent: false, boxVisible: true))
    // the dev-warning auto-accept decides on what classify says: never the warning
    if case .devChannels = DialogMatcher.classify(screen) { Issue.record("read as the dev-channel warning") }
    // the tap answerer reads nothing off it, so it has nothing to press
    #expect(DialogReader.read(rows: screen) == nil)
    // the computer-use Escape is only for that dialog's exact shape
    #expect(DialogMatcher.computerUseBlock(screen) == nil)
  }

  @Test func theOwnersLinesNameTheModelTheResetAndTheWayOnAndNeverAnswer() {
    let full = UsageLimitScreen.Info(model: "Fable", resets: "4pm (Europe/Paris)")
    let thread = UsageLimitScreen.threadLine(full)
    #expect(
      thread
        == "This thread's session hit the usage limit for Fable. It resets 4pm (Europe/Paris). Talos pressed nothing on that screen: one of its options spends usage credits. To go on now, press Esc in this thread's pane in Terminals, then /model <another model>."
    )
    #expect(WorkerNotice.line(screen: .usageLimit(full)) == thread)
    let main = UsageLimitScreen.mainLine(.init())
    #expect(
      main
        == "Main hit the usage limit for this session's model. Talos pressed nothing on that screen: one of its options spends usage credits. To go on now, press Esc in Main's pane, then /model <another model>."
    )
    let menu = SupervisorNotice.mainDialog("usage limit")
    #expect(menu == "Main hit a usage limit; press Esc in its pane, then /model <another model> (Talos presses nothing there: one option spends usage credits)")
    let stall = MainRestartCheck.stallPhoneLine("usage limit")
    #expect(stall == "Main restarted on request and is on the usage-limit screen at your Mac. Press Esc in Main's pane, then /model <another model>; Talos presses nothing there.")
    for line in [thread, main, menu, stall] {
      for w in Self.neverSaid { #expect(!line.lowercased().contains(w), "\(w): \(line)") }
      #expect(line.contains("Esc") && line.contains("/model <another model>"))
    }
    #expect(MainRestartCheck.Last.ownLabels.contains("usage limit"))
    #expect(DialogMatcher.Screen.answerless(label: "usage limit"))
  }

  // MARK: the watch: once per appearance, a settled miss, at most one line an hour

  @Test func oneLineAnAppearanceAtMostOneAnHour() {
    var w = UsageLimitWatch()
    do { let v = w.look(onScreen: false, now: 0); #expect(v == .none) }
    do { let v = w.look(onScreen: true, now: 1); #expect(v == .appeared) }
    do { let v = w.mayTellOwner(now: 1); #expect(v) }
    do { let v = w.look(onScreen: true, now: 2); #expect(v == .still) }
    // a torn frame is not the screen gone
    do { let v = w.look(onScreen: false, now: 3); #expect(v == .fading) }
    do { let v = w.look(onScreen: true, now: 3.5); #expect(v == .still) }
    do { let v = w.look(onScreen: false, now: 4); #expect(v == .fading) }
    do { let v = w.look(onScreen: false, now: 4 + UsageLimitWatch.goneAfter); #expect(v == .gone) }
    // a new appearance inside the hour: seen, but no second line
    do { let v = w.look(onScreen: true, now: 100); #expect(v == .appeared) }
    do { let v = w.mayTellOwner(now: 100); #expect(!v) }
    do { let v = w.mayTellOwner(now: 1 + UsageLimitWatch.window); #expect(v) }
    // a clock set back does not hand out lines
    var c = UsageLimitWatch()
    do { let v = c.mayTellOwner(now: 5000); #expect(v) }
    do { let v = c.mayTellOwner(now: 4990); #expect(!v) }
  }
}

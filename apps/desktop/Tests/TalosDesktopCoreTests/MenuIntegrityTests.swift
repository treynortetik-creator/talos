import Foundation
import Testing

@testable import TalosDesktopCore

// The top menu rebuilt itself in a loop while the terminal window was open (2026-11-02). Measured with the real AppMenu in a
// scratch run: once a window exists AppKit inserts "Close All" into the MIDDLE of Window, after Close, so a check that only
// tolerated appended items saw a replaced menu, reinstalled, and AppKit inserted it again.

@Suite("The top menu is only rebuilt when it was really replaced")
struct MenuIntegrityTests {
  // Signatures as AppMenu.signature produced them in that run.
  let want: [[String]] = [
    ["# Talos", "About Talos|a|0|menu", "-", "Settings\u{2026}|,|1048576|menu", "-", "Quit Talos|q|1048576|app"],
    ["# Edit", "Undo|z|1048576|chain", "-", "Cut|x|1048576|chain", "Paste|v|1048576|chain"],
    [
      "# Window", "Close|w|1048576|chain", "Minimize|m|1048576|chain", "-", "Show Talos|t|1048576|menu",
      "Terminals…|k|1048576|menu", "Permissions\u{2026}||0|menu",
    ],
    ["# Help", "Talos Help||0|menu", "Report a problem||0|menu"],
  ]

  /// What AppKit does to it, as measured.
  func appKitTouched() -> [[String]] {
    var have = want
    have[1] += ["-", "Start Dictation\u{2026}||0|other", "Emoji & Symbols|e|0|other"]  // Edit: appended
    have[2].insert("Close All|w|1572864|app", at: 2)  // Window: inserted after Close
    have[2] += ["-", "Probe terminal||0|other"]  // Window: the list of windows, appended
    have[3].append("Search||0|other")
    return have
  }

  @Test func appKitsOwnItemsInWindowAndEditStillCountAsIntact() {
    #expect(MenuIntegrity.holds(want, want))
    #expect(MenuIntegrity.holds(appKitTouched(), want))
  }

  @Test func anItemInsertedAtTheTopOfHelpStillCountsAsIntact() {
    var have = want
    have[3].insert("Search||0|other", at: 1)
    #expect(MenuIntegrity.holds(have, want))
  }

  @Test func aReplacedMenuIsNotIntact() {
    var swiftUI = appKitTouched()
    swiftUI[0] = ["# Talos", "About Talos|a|0|menu", "Quit Talos|q|1048576|app"]  // Settings gone
    #expect(!MenuIntegrity.holds(swiftUI, want))
    var emptied = appKitTouched()
    emptied[3] = ["# Help"]
    #expect(!MenuIntegrity.holds(emptied, want))
    var reordered = want
    reordered[2].swapAt(1, 2)
    #expect(!MenuIntegrity.holds(reordered, want))
    var retargeted = want
    retargeted[0][3] = "Settings\u{2026}|,|1048576|other"  // same title, someone else answers
    #expect(!MenuIntegrity.holds(retargeted, want))
  }

  @Test func aMissingOrExtraTopMenuIsNotIntact() {
    #expect(!MenuIntegrity.holds(Array(want.dropLast()), want))
    #expect(!MenuIntegrity.holds(want + [["# View"]], want))
    #expect(!MenuIntegrity.holds([], want))
    #expect(!MenuIntegrity.holds(want.reversed(), want))
  }

  /// A stand-in for the app: installing builds `want` and AppKit then touches it, the way it did on the Mac. Each pass is
  /// what one notification-driven repair does.
  func repairs(passes: Int, check: ([[String]], [[String]]) -> Bool, budgeted: Bool, start: [[String]]? = nil) -> (installs: Int, settledAt: Int?) {
    var current = start ?? want
    var installs = 0
    var budget = MenuRepairBudget()
    let t0 = Date(timeIntervalSince1970: 1_000)
    for pass in 0..<passes {
      if check(current, want) { return (installs, pass) }
      if budgeted, budget.request(at: t0.addingTimeInterval(Double(pass) * 0.05)) != .go { continue }
      installs += 1
      current = appKitTouched()
    }
    return (installs, nil)
  }

  @Test func repeatedRepairsOfAHealthyMenuSettleWithNoInstall() {
    let r = repairs(passes: 50, check: MenuIntegrity.holds, budgeted: false)
    #expect(r.installs == 0 && r.settledAt == 0)
  }

  @Test func theOldAppendOnlyCheckLoopedAndTheNewOneDoesNot() {
    func oldHolds(_ have: [[String]], _ want: [[String]]) -> Bool {
      have.count == want.count && zip(have, want).allSatisfy { $0.starts(with: $1) }
    }
    #expect(!oldHolds(appKitTouched(), want), "this is the disagreement that spun")
    #expect(repairs(passes: 50, check: oldHolds, budgeted: false, start: appKitTouched()).installs == 50)
    #expect(repairs(passes: 50, check: MenuIntegrity.holds, budgeted: false, start: appKitTouched()).settledAt == 0)
  }

  @Test func evenWithAChecksThatNeverAgreesTheInstallsStopAtTheBudget() {
    let never: ([[String]], [[String]]) -> Bool = { _, _ in false }
    let r = repairs(passes: 500, check: never, budgeted: true)
    #expect(r.installs == 3, "500 notifications in 25 seconds, three rebuilds")
  }
}

@Suite("The reinstall budget")
struct MenuRepairBudgetTests {
  let t0 = Date(timeIntervalSince1970: 5_000_000)

  @Test func threeInAMinuteThenStopWithOneLogLine() {
    var b = MenuRepairBudget()
    #expect(b.request(at: t0) == .go)
    #expect(b.request(at: t0 + 1) == .go)
    #expect(b.request(at: t0 + 2) == .go)
    #expect(b.request(at: t0 + 3) == .stopAndLog)
    #expect(b.request(at: t0 + 4) == .stop)
    #expect(b.request(at: t0 + 59) == .stop)
  }

  @Test func repairsResumeOnceTheWindowPasses() {
    var b = MenuRepairBudget()
    for i in 0..<3 { _ = b.request(at: t0 + Double(i)) }
    #expect(b.request(at: t0 + 10) == .stopAndLog)
    #expect(b.request(at: t0 + 61) == .go, "the first stamp aged out")
  }

  @Test func aClockThatJumpsBackDoesNotLockRepairsOut() {
    var b = MenuRepairBudget()
    for i in 0..<3 { _ = b.request(at: t0 + 3600 + Double(i)) }
    #expect(b.request(at: t0) == .go, "the stamps are in the future now; they are dropped")
  }
}

@Suite("A refused repair waits instead of being dropped")
struct MenuRepairWaitTests {
  let t0 = Date(timeIntervalSince1970: 7_000_000)

  @Test func theWaitIsUntilTheOldestInstallAgesOut() {
    var b = MenuRepairBudget()
    #expect(b.waitUntilAllowed(at: t0) == 0)
    for i in 0..<3 { _ = b.request(at: t0 + Double(i) * 10) }
    #expect(b.request(at: t0 + 25) != .go)
    let wait = b.waitUntilAllowed(at: t0 + 25)
    #expect(wait == 35, "the first install was at t0 and ages out at t0+60")
    #expect(b.request(at: t0 + 25 + wait) == .go, "the retry scheduled for then is allowed")
  }
}

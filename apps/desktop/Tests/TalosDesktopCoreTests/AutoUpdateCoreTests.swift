import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The app updater's decisions: the setting (on for a new install, off for a desktop.json from before it), the feed address, the owner's
/// lines, settling a pending update, the quiet wait and what counts as background work.
@Suite("Auto update: decisions")
struct AutoUpdateCoreTests {
  // MARK: the setting

  @Test func onForANewInstallOffForAFileFromBeforeTheSetting() throws {
    #expect(DesktopConfig.defaults.autoUpdate, "a new install updates itself")
    #expect(String(decoding: try DesktopConfig.defaults.encoded(), as: UTF8.self).contains("\"auto_update\" : true"))
    #expect(try DesktopConfig.decode(DesktopConfig.defaults.encoded()).autoUpdate, "a file written by a new install reads back on")
    let old = try DesktopConfig.decode(Data(#"{"v":1,"agent_dir":"~/a","relay_url":"https://relay.example.com"}"#.utf8))
    #expect(!old.autoUpdate, "a desktop.json from before the setting reads as off")
    let bad = try DesktopConfig.decode(Data(#"{"v":1,"agent_dir":"~/a","auto_update":"yes","auto_restart":false}"#.utf8))
    #expect(!bad.autoUpdate && !bad.autoRestart, "a bad value is off, and costs only that setting")
    #expect(try DesktopConfig.decode(Data(#"{"v":1,"auto_update":true}"#.utf8)).autoUpdate)
  }

  @Test func savingAnOldFileDoesNotTurnItOn() throws {
    let dir = TestTemp.base + "au-cfg-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/desktop.json"
    try Data(#"{"v":1,"agent_dir":"/home/alex/agent","relay_url":"https://relay.example.com"}"#.utf8).write(to: URL(fileURLWithPath: path))
    var c = try #require(try ConfigFile.load(path))
    c.keepAwakeOnAC = true  // some other change
    try ConfigFile.save(c, to: path)
    let raw = String(decoding: try Data(contentsOf: URL(fileURLWithPath: path)), as: UTF8.self)
    #expect(!raw.contains("auto_update"), "the key stays absent")
    #expect(try ConfigFile.load(path)?.autoUpdate == false)
    // the owner switches it on: now it is written
    c.autoUpdate = true
    try ConfigFile.save(c, to: path)
    #expect(try ConfigFile.load(path)?.autoUpdate == true)
  }

  @Test func aChoiceBeforeSetupIsHeld() {
    var off = DesktopConfig.defaults
    off.autoUpdate = false
    #expect(PreSetup.snapshot(of: off).applied(to: .defaults).autoUpdate == false)
    #expect(!MacSettingsText.applies(.autoUpdate).isEmpty)
  }

  // MARK: the feed

  @Test func theFeedIsHttpsOnly() {
    #expect(AutoUpdate.feedBase(nil)?.absoluteString == AutoUpdate.defaultFeed)
    #expect(AutoUpdate.feedBase("  ")?.absoluteString == AutoUpdate.defaultFeed)
    #expect(AutoUpdate.feedBase("https://example.com/rel")?.absoluteString == "https://example.com/rel/")
    #expect(AutoUpdate.feedBase("http://example.com/rel/") == nil)
    #expect(AutoUpdate.feedBase("file:///home/alex/feed/") == nil, "file:// only for tests")
    #expect(AutoUpdate.feedBase("file:///home/alex/feed/", allowLocal: true) != nil)
    #expect(AutoUpdate.feedBase("http://127.0.0.1:8080/", allowLocal: true) != nil)
    #expect(AutoUpdate.feedBase("http://example.com/", allowLocal: true) == nil)
    #expect(AutoUpdate.feedBase("https://example.com/rel/?x=1") == nil)
    #expect(AutoUpdate.feedBase("https://user@example.com/rel/") == nil)
    let base = AutoUpdate.feedBase("https://example.com/a/b")!
    #expect(AutoUpdate.fileURL(base, "latest.json")?.absoluteString == "https://example.com/a/b/latest.json")
  }

  // MARK: the lines

  @Test func theOwnersLines() {
    #expect(AutoUpdate.updatedLine("1.5.0") == "Talos updated to 1.5.0. The relay updates separately.")
    #expect(AutoUpdate.noticeLine("1.5.0") == "Talos will update to 1.5.0 in 2 minutes; send anything to postpone.")
    #expect(!AutoUpdate.noticeLine("1.5.0\nx").contains("\n") && !AutoUpdate.postponedLine("1\u{2029}x").contains("\u{2029}"))
    #expect(
      AutoUpdate.failedLine("1.5.0", why: .dirty, old: "1.4.0")
        == "Talos couldn't update to 1.5.0: the Talos code folder has changes of its own. It's still on 1.4.0.")
    #expect(!AutoUpdate.failedLine("1.5.0\nmore", why: .install, old: "1.4.0\u{2028}x").contains("\n"))
    for f in AutoUpdate.Failure.allCases { #expect(!f.words.isEmpty && !f.words.hasSuffix(".")) }
    #expect(AutoUpdate.installFailure(exit: 9) == .notarized && AutoUpdate.installFailure(exit: 8) == .relay)
    #expect(AutoUpdate.installFailure(exit: 10) == .identity && AutoUpdate.installFailure(exit: 5) == .install)
  }

  // MARK: settling

  static let pending = AutoUpdate.Pending(
    version: "1.5.0", old_version: "1.4.0", checkout: "/home/alex/talos", old_ref: "main", old_head: String(repeating: "a", count: 40),
    helper_pid: 42, started_at: "2026-11-14T20:00:00Z")

  @Test func aTranslocatedCopyIsKnownByItsPath() {
    let id = "6F1C2A9E-0B3D-4E5F-8A7B-9C0D1E2F3A4B"
    #expect(AutoUpdate.isTranslocated("/private/var/folders/xy/abc123/T/AppTranslocation/\(id)/d/Talos.app"))
    #expect(AutoUpdate.isTranslocated("/var/folders/xy/abc123/T/AppTranslocation/\(id)/d/Talos.app/"))
    #expect(!AutoUpdate.isTranslocated("/home/alex/Applications/Talos.app"))
    #expect(!AutoUpdate.isTranslocated("/home/alex/AppTranslocationNotes/Talos.app"), "a folder whose name only starts the same")
    #expect(!AutoUpdate.isTranslocated("/home/alex/Applications/AppTranslocation"), "the bundle itself, not a folder above it")
    #expect(!AutoUpdate.isTranslocated(""))
    #expect(AutoUpdate.translocatedLine.contains("move it to Applications and reopen it"))
  }

  @Test func theRunningVersionDecides() {
    let p = Self.pending
    // the new version running is not enough: the swap's ok comes only after the health gate saw its report
    #expect(AutoUpdate.settle(pending: p, result: nil, running: "1.5.0", helperAlive: true, healthy: true) == .waiting)
    #expect(AutoUpdate.settle(pending: p, result: .init(ok: true), running: "1.5.0", helperAlive: false) == .updated)
    #expect(
      AutoUpdate.settle(pending: p, result: .init(ok: false, why: "rollback_failed", restored: false), running: "1.5.0", helperAlive: false)
        == .failed(.rollbackFailed, restoreCheckout: false), "a failed rollback: the checkout stays with the installed app")
    #expect(
      AutoUpdate.settle(pending: p, result: .init(ok: false, why: "unhealthy", restored: true), running: "1.4.0", helperAlive: false)
        == .failed(.unhealthy, restoreCheckout: false))
    // the swap killed with the new version running: it counts once it reports healthy, never before
    #expect(AutoUpdate.settle(pending: p, result: nil, running: "1.5.0", helperAlive: false, healthy: false) == .waiting)
    #expect(AutoUpdate.settle(pending: p, result: nil, running: "1.5.0", helperAlive: false, healthy: true) == .updated)
    #expect(AutoUpdate.settle(pending: p, result: nil, running: "1.4.0", helperAlive: true) == .waiting)
    #expect(
      AutoUpdate.settle(pending: p, result: .init(ok: false, why: "app_check", restored: true), running: "1.4.0", helperAlive: false)
        == .failed(.notarized, restoreCheckout: false))
    #expect(
      AutoUpdate.settle(pending: p, result: .init(ok: false, why: "deps", restored: false), running: "1.4.0", helperAlive: false)
        == .failed(.deps, restoreCheckout: true), "the script could not put it back: the app tries")
    #expect(
      AutoUpdate.settle(pending: p, result: nil, running: "1.4.0", helperAlive: false) == .failed(.stopped, restoreCheckout: true),
      "killed outright, no result: said as stopped, and the checkout goes back")
    #expect(
      AutoUpdate.settle(pending: p, result: .init(ok: false, why: "no-such-reason"), running: "1.4.0", helperAlive: false)
        == .failed(.stopped, restoreCheckout: false), "an unknown reason costs the reason, not the line")
  }

  @Test func healthyMeansMainRunningAndTheBridgeLiveOnTheRelay() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func status(connected: Bool, mode: String = "live", age: Double = 5) -> BridgeStatus? {
      BridgeStatus.decode(
        Data(
          #"{"v":1,"pid":4242,"mode":"\#(mode)","relay":{"connected":\#(connected)},"updated_at":"\#(ISOTime.string(now.timeIntervalSince1970 - age))"}"#
            .utf8))
    }
    let alive: (Int32) -> Bool = { $0 == 4242 }
    #expect(AutoUpdate.healthy(mainRunning: true, bridge: status(connected: true), now: now, pidAlive: alive))
    #expect(!AutoUpdate.healthy(mainRunning: false, bridge: status(connected: true), now: now, pidAlive: alive), "Main not running")
    #expect(!AutoUpdate.healthy(mainRunning: true, bridge: status(connected: false), now: now, pidAlive: alive), "not on the relay")
    #expect(!AutoUpdate.healthy(mainRunning: true, bridge: status(connected: true, age: 120), now: now, pidAlive: alive), "stale")
    #expect(!AutoUpdate.healthy(mainRunning: true, bridge: status(connected: true), now: now, pidAlive: { _ in false }), "dead bridge")
    #expect(!AutoUpdate.healthy(mainRunning: true, bridge: nil, now: now, pidAlive: alive), "unreadable")
    #expect(AutoUpdate.healthFileName("1.5.0") == "healthy-1.5.0.json")
    #expect(
      AutoUpdate.unhealthyLine("1.5.0", old: "1.4.0")
        == "Talos 1.5.0 didn't start properly, so it went back to 1.4.0. The update is paused for a week.")
  }

  @Test func afterAnUpdateTheBridgeMustRunTheReleaseStartedAfterTheSwapUnderMain() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let commit = "0123456789abcdef0123456789abcdef01234567"
    let swap = now.addingTimeInterval(-120)
    func status(commit c: String?, started: Date) -> BridgeStatus? {
      let commitField = c.map { #","bridge_commit":"\#($0)""# } ?? ""
      return BridgeStatus.decode(
        Data(
          (#"{"v":1,"pid":4242,"mode":"live","relay":{"connected":true},"started_at":"\#(ISOTime.string(started.timeIntervalSince1970))","updated_at":"\#(ISOTime.string(now.timeIntervalSince1970 - 3))""#
            + commitField + "}").utf8))
    }
    let alive: (Int32) -> Bool = { $0 == 4242 }
    func ok(_ b: BridgeStatus?, under: Bool = true, running: Bool = true) -> Bool {
      AutoUpdate.healthyAfterUpdate(
        mainRunning: running, bridge: b, now: now, pidAlive: alive, commit: commit, since: swap, bridgeUnderMain: under)
    }
    #expect(ok(status(commit: "0123456", started: now.addingTimeInterval(-30))))
    #expect(!ok(status(commit: "fedcba9", started: now.addingTimeInterval(-30))), "the old bridge's commit")
    #expect(!ok(status(commit: nil, started: now.addingTimeInterval(-30))), "no commit known")
    #expect(!ok(status(commit: "0123456", started: now.addingTimeInterval(-600))), "started before the swap: a Main left running")
    #expect(!ok(status(commit: "0123456", started: now.addingTimeInterval(-30)), under: false), "not this app's Main's bridge")
    #expect(!ok(status(commit: "0123456", started: now.addingTimeInterval(-30)), running: false), "Main not running")
    #expect(AutoUpdate.bridgeOnOlderCode(status(commit: "fedcba9", started: now), commit: commit))
    #expect(!AutoUpdate.bridgeOnOlderCode(status(commit: "0123456", started: now), commit: commit))
  }

  @Test func aRolledBackVersionWaitsAWeekThenIsTriedOnceMore() {
    let at = 1_800_000_000.0
    #expect(AutoUpdate.skipped(["1.5.0": at], version: "1.5.0", now: at + 6 * 24 * 3600))
    #expect(!AutoUpdate.skipped(["1.5.0": at], version: "1.5.0", now: at + AutoUpdate.skipFor))
    #expect(!AutoUpdate.skipped(["1.5.0": at], version: "1.6.0", now: at + 1))
    #expect(!AutoUpdate.skipped(["1.5.0": at], version: "1.5.0", now: at - 60), "a clock set back never holds it for ever")
  }

  // MARK: the swap's liveness and the failure memory

  @Test func theSwapIsKnownByItsPidAndItsStartTimeAndOnlyForThirtyMinutes() {
    let now = 1_800_000_000.0
    var p = Self.pending
    p.helper_pid = 4242
    p.helper_started = 77.5
    p.started_at = ISOTime.string(now - 60)
    #expect(AutoUpdate.helperAlive(p, now: now) { $0 == 4242 ? 77.5 : nil })
    #expect(!AutoUpdate.helperAlive(p, now: now) { $0 == 4242 ? 78.5 : nil }, "the pid used again by another process")
    #expect(!AutoUpdate.helperAlive(p, now: now) { _ in nil }, "gone")
    p.started_at = ISOTime.string(now - AutoUpdate.applyCap)
    #expect(!AutoUpdate.helperAlive(p, now: now) { _ in 77.5 }, "over its time")
    p.helper_started = nil
    p.started_at = ISOTime.string(now - 60)
    #expect(!AutoUpdate.helperAlive(p, now: now) { _ in 77.5 }, "no start time recorded: never trusted")
  }

  @Test func aFailedVersionWaitsADay() {
    let at = 1_800_000_000.0
    let r = ["1.5.0": at]
    #expect(AutoUpdate.recentlyFailed(r, version: "1.5.0", now: at + 3600))
    #expect(!AutoUpdate.recentlyFailed(r, version: "1.5.0", now: at + AutoUpdate.retryFailedAfter))
    #expect(!AutoUpdate.recentlyFailed(r, version: "1.6.0", now: at + 1), "another version is not held")
    #expect(!AutoUpdate.recentlyFailed(r, version: "1.5.0", now: at - 10), "a clock set back never holds it for ever")
  }

  @Test func statusJsonCarriesTheOwnersLastMessageTime() {
    let base = #"{"v":1,"pid":4242,"mode":"live","relay":{"connected":true},"updated_at":"2026-11-14T20:00:00Z""#
    #expect(BridgeStatus.decode(Data((base + #","last_owner_at":"2026-11-14T19:59:00.123Z"}"#).utf8))?.lastOwnerAt == "2026-11-14T19:59:00.123Z")
    #expect(BridgeStatus.decode(Data((base + "}").utf8))?.lastOwnerAt == nil, "an older bridge")
    #expect(BridgeStatus.decode(Data((base + #","last_owner_at":"soon"}"#).utf8))?.lastOwnerAt == nil, "not a time")
  }

  // MARK: the quiet wait

  @Test func quietTwiceInARowGoes() {
    var w = QuietWait()
    #expect(w.look(quiet: true, now: 0) == .wait)
    #expect(w.look(quiet: false, now: 30) == .wait, "one busy look starts the count again")
    #expect(w.look(quiet: true, now: 60) == .wait)
    #expect(w.look(quiet: true, now: 90) == .go)
  }

  @Test func theCapCountsFromWhenTheReleaseWasReady() {
    var w = QuietWait(since: 0)
    #expect(w.look(quiet: false, now: AutoUpdate.quietCap) == .gaveUp, "the first look, two hours after it was ready, gives up")
  }

  @Test func neverQuietGivesUpAtTheCap() {
    var w = QuietWait()
    #expect(w.look(quiet: false, now: 100) == .wait)
    #expect(w.look(quiet: false, now: 100 + AutoUpdate.quietCap - 1) == .wait)
    #expect(w.look(quiet: false, now: 100 + AutoUpdate.quietCap) == .gaveUp)
  }

  // MARK: background work

  typealias P = BackgroundWork.Proc
  /// A pane as a real one looks: the pane's sh runs claude, claude runs its MCP servers (bun, node, python), caffeinate, and Bash tool shells.
  static let table: [P] = [
    P(pid: 100, ppid: 1, name: "sh"),
    P(pid: 101, ppid: 100, name: "claude"),
    P(pid: 102, ppid: 101, name: "bun", argv: ["bun", "run", "--cwd", "/home/alex/talos/apps/bridge", "src/server.ts"]),
    P(pid: 103, ppid: 101, name: "python3.12"),
    P(pid: 104, ppid: 101, name: "node", argv: ["node", "/home/alex/mcp/server.mjs", "mcp"]),
    P(pid: 105, ppid: 101, name: "caffeinate"),
    P(pid: 106, ppid: 104, name: "zsh"),  // under an MCP server: the server's own
  ]

  @Test func claudeAndItsServersAreNotWork() {
    #expect(BackgroundWork.offenders(Self.table, panes: [100]).isEmpty)
  }

  @Test func aShellUnderClaudeIsWork() {
    let t = Self.table + [P(pid: 200, ppid: 101, name: "zsh"), P(pid: 201, ppid: 200, name: "sleep")]
    #expect(BackgroundWork.offenders(t, panes: [100]).map(\.pid) == [200], "named once, at the top of its tree")
  }

  @Test func somethingElseUnderThePaneIsWork() {
    let t = Self.table + [P(pid: 300, ppid: 100, name: "sleep")]
    #expect(BackgroundWork.offenders(t, panes: [100]).map(\.pid) == [300])
  }

  @Test func claudeUnderNodeIsKnownByItsArgv() {
    let t: [P] = [
      P(pid: 10, ppid: 1, name: "node", argv: ["node", "/home/alex/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js", "--resume"]),
      P(pid: 11, ppid: 10, name: "bun"), P(pid: 12, ppid: 10, name: "bash"),
    ]
    #expect(BackgroundWork.offenders(t, panes: [10]).map(\.pid) == [12])
    // a node that is not claude, as a pane's root: everything under it is work
    let other: [P] = [P(pid: 20, ppid: 1, name: "node", argv: ["node", "build.js"]), P(pid: 21, ppid: 20, name: "esbuild")]
    #expect(BackgroundWork.offenders(other, panes: [20]).map(\.pid) == [21])
  }

  @Test func aClaudeStartedFromTheBashToolIsWork() {
    let t = Self.table + [P(pid: 400, ppid: 101, name: "claude")]
    #expect(BackgroundWork.offenders(t, panes: [100]).map(\.pid) == [400])
  }

  @Test func aGonePaneGivesNothing() {
    #expect(BackgroundWork.offenders(Self.table, panes: [999, 0, 1]).isEmpty)
  }

  // MARK: the apply script's refusals (--preflight, --prepare, --swap) in the owner's words

  @Test func theScriptsRefusalsHaveTheirOwnPlainWords() {
    let want: [(String, AutoUpdate.Failure, String)] = [
      ("checkout", .checkout, "the Talos code folder could not be moved to the new version"),
      ("checkout-config", .checkoutConfig, "the Talos code folder has settings of its own that Talos does not trust, so it was left alone"),
      ("dirty", .dirty, "the Talos code folder has changes of its own"),
      ("local-commits", .localCommits, "the Talos code folder has changes of its own that are not in the new version"),
      ("older-release", .olderRelease, "the new version is older than the Talos code folder"),
    ]
    for (raw, f, words) in want {
      #expect(AutoUpdate.Failure(rawValue: raw) == f, Comment(rawValue: raw))
      #expect(f.words == words, Comment(rawValue: raw))
      #expect(MacWords.forbiddenWords(in: f.words).isEmpty, "no engineer word in \u{201C}\(f.words)\u{201D}")
      #expect(!f.words.lowercased().contains("git") && !f.words.lowercased().contains("config"), Comment(rawValue: f.words))
    }
    #expect(AutoUpdate.failedLine("1.5.0", why: .olderRelease, old: "1.4.0") == "Talos couldn\u{2019}t update to 1.5.0: the new version is older than the Talos code folder. It\u{2019}s still on 1.4.0.".replacingOccurrences(of: "\u{2019}", with: "'"))
  }

  @Test func aSwapThatRefusedACheckoutItWillNotTouchIsNotRestoredAgain() {
    let p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: "/home/alex/talos", old_ref: "main", old_head: String(repeating: "a", count: 40),
      helper_pid: 1, started_at: "2026-11-21T10:00:00Z")
    // exit 21, why checkout-config, restored false: nothing can put it back safely, and the way back would refuse it just the same
    let refused = AutoUpdate.settle(pending: p, result: .init(ok: false, why: "checkout-config", restored: false), running: "1.4.0", helperAlive: false)
    #expect(refused == .failed(.checkoutConfig, restoreCheckout: false))
    // the control: any other swap failure that could not put the checkout back is tried once more by the app
    let other = AutoUpdate.settle(pending: p, result: .init(ok: false, why: "checkout", restored: false), running: "1.4.0", helperAlive: false)
    #expect(other == .failed(.checkout, restoreCheckout: true))
    let local = AutoUpdate.settle(pending: p, result: .init(ok: false, why: "local-commits", restored: false), running: "1.4.0", helperAlive: false)
    #expect(local == .failed(.localCommits, restoreCheckout: true))
  }
}

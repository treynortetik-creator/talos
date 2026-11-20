import Foundation
import Testing
import TalosDesktopCore

@testable import TalosSupervisor

/// "Check for Updates", "Update now", the check-now.json request and what the update window is told, on the same real rig as
/// AutoUpdaterTests (a signed file feed, a real git clone, the real apply script).
@Suite("Check for updates: the updater", .serialized)
struct AutoUpdaterCheckNowTests {
  typealias Rig = AutoUpdaterTests.Rig
  typealias Box = AutoUpdaterTests.Box

  /// Each status the updater published, in order.
  static func recorder() -> (Box<[UpdateStatus]>, @Sendable (inout AutoUpdater.Hooks) -> Void) {
    let seen = Box<[UpdateStatus]>([])
    return (seen, { h in h.onStatus = { s in seen.edit { $0.append(s) } } })
  }

  static func requestPath(_ r: Rig) -> String { r.home + "/auto-update/" + CheckNowRequest.fileName }

  static func writeRequest(_ r: Rig, _ json: String) throws {
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    try Data(json.utf8).write(to: URL(fileURLWithPath: requestPath(r)))
  }

  static func fresh(_ r: Rig, ageSeconds: Double = 2) -> String {
    #"{"v":1,"action":"check","ts":"\#(ISOTime.string(Date().timeIntervalSince1970 - ageSeconds))"}"#
  }

  // MARK: check-now.json

  @Test func aFreshRequestFileRunsExactlyOneCheckAndIsRemoved() throws {
    let r = try Rig()
    try r.publish(version: "1.4.0")  // the same as the running one: a check ends "up to date"
    let (seen, tweak) = Self.recorder()
    let u = r.updater(hooks: tweak)
    u.tick()  // the launch check
    #expect(r.fetches.get() == 2)
    try Self.writeRequest(r, Self.fresh(r))
    u.tick()
    #expect(r.fetches.get() == 4, "one more look at the feed (manifest and signature)")
    #expect(!FileManager.default.fileExists(atPath: Self.requestPath(r)), "the request is consumed")
    u.tick()
    u.tick()
    #expect(r.fetches.get() == 4, "a request is answered once")
    #expect(r.audit().contains("auto_update check_now"))
    #expect(seen.get().last == .upToDate(version: "1.4.0"))
  }

  @Test func theRequestWorksWhenNoCheckIsDueYet() throws {
    let r = try Rig()
    try r.publish(version: "1.4.0")
    let u = r.updater()
    u.tick()
    r.clock.edit { $0 += 60 }  // the next automatic check is 6 hours away
    try Self.writeRequest(r, Self.fresh(r))
    u.tick()
    #expect(r.fetches.get() == 4)
  }

  @Test func aStaleFutureOrMalformedRequestIsIgnoredAndRemoved() throws {
    let r = try Rig()
    try r.publish(version: "1.4.0")
    let u = r.updater()
    u.tick()
    let now = Date().timeIntervalSince1970
    let bad = [
      #"{"v":1,"action":"check","ts":"\#(ISOTime.string(now - 3600))"}"#,  // left behind an hour ago
      #"{"v":1,"action":"check","ts":"\#(ISOTime.string(now + 3600))"}"#,  // from the future
      #"{"v":1,"action":"install","ts":"\#(ISOTime.string(now))"}"#, #"{"v":9,"action":"check","ts":"\#(ISOTime.string(now))"}"#,
      "garbage", #"["check"]"#, String(repeating: "a", count: 5000),
    ]
    for json in bad {
      try Self.writeRequest(r, json)
      u.tick()
      #expect(r.fetches.get() == 2, "no check for \(json.prefix(50))")
      #expect(!FileManager.default.fileExists(atPath: Self.requestPath(r)), "removed: \(json.prefix(50))")
    }
    #expect(r.audit().contains("check_now_ignored why=stale") && r.audit().contains("why=ahead") && r.audit().contains("why=wrongAction"))
  }

  /// A link in the folder, or a directory, is never read as the request (it could point at any file of the owner's).
  @Test func aRequestThatIsALinkIsNeverFollowed() throws {
    let r = try Rig()
    try r.publish(version: "1.4.0")
    let u = r.updater()
    u.tick()
    let target = r.root + "/elsewhere.json"
    try Data(Self.fresh(r).utf8).write(to: URL(fileURLWithPath: target))
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: Self.requestPath(r), withDestinationPath: target)
    u.tick()
    #expect(r.fetches.get() == 2, "a link is not a request")
    #expect(FileManager.default.fileExists(atPath: target), "what it pointed at is untouched")
    #expect(r.audit().contains("check_now_ignored"))
  }

  @Test func switchedOffARequestChecksNothingAndTheWindowSaysWhy() throws {
    let r = try Rig()
    try r.publish()
    r.on.set(false)
    let (seen, tweak) = Self.recorder()
    let u = r.updater(hooks: tweak)
    try Self.writeRequest(r, Self.fresh(r))
    u.tick()
    #expect(r.fetches.get() == 0 && r.downloads.get() == 0)
    #expect(!FileManager.default.fileExists(atPath: Self.requestPath(r)))
    u.checkNow()
    u.queue.sync {}
    #expect(seen.get().last == .off, "the menu's own check says why nothing happened")
  }

  // MARK: the window's live state

  @Test func theWindowSeesCheckingDownloadingThenReady() throws {
    let r = try Rig()
    try r.publish()
    let (seen, tweak) = Self.recorder()
    let u = r.updater(hooks: tweak)
    u.tick()
    #expect(seen.get() == [.checking, .downloading(version: "1.5.0"), .ready(version: "1.5.0")])
    #expect(UpdateMenu.title(u.status) == "Update to 1.5.0\u{2026}" && UpdateMenu.showsDot(u.status))
  }

  @Test func aBusyMacShowsWaitingForAQuietMomentAndWhy() throws {
    let r = try Rig()
    try r.publish()
    r.busy.set(["background work: sleep (pid 4)"])
    let u = r.updater()
    u.tick()
    #expect(u.status == .waitingForQuiet(version: "1.5.0", why: ["background work: sleep (pid 4)"]))
    #expect(u.status.words.detail.contains("running something in the background"))
    r.busy.set([])
    r.clock.edit { $0 += 30 }
    u.tick()
    #expect(u.status == .ready(version: "1.5.0"))
  }

  @Test func aFailureIsOneLineAndTheLogPath() throws {
    let r = try Rig()
    try r.publish(sha: String(repeating: "0", count: 64))  // the zip is not the file the release names
    let (seen, tweak) = Self.recorder()
    let u = r.updater(hooks: tweak)
    u.tick()
    guard case .failed(let line, let log) = u.status else { Issue.record("not failed: \(u.status) \(seen.get())"); return }
    #expect(line == "Talos couldn't update to 1.5.0: the download is not the file the release names. It's still on 1.4.0.")
    #expect(log.hasSuffix("/audit.log"), "where the details are")
    #expect(u.status.words.detail.contains(log))
  }

  @Test func aFeedThatCannotBeReachedIsSaidNotSkipped() throws {
    let r = try Rig()  // nothing published: the feed has no latest.json
    let u = r.updater()
    u.tick()
    #expect(u.status == .failed(line: AutoUpdate.unreachableLine, logPath: u.logPathForOwner))
  }

  /// The owner's own check after a failure tries again at once; the automatic one waits out its day.
  @Test func aMenuCheckRetriesAReleaseThatFailedToday() throws {
    let r = try Rig()
    try r.publish(sha: String(repeating: "0", count: 64))
    let u = r.updater()
    u.tick()
    #expect(r.downloads.get() == 1)
    r.clock.edit { $0 += AutoUpdate.checkEvery }
    u.tick()
    #expect(r.downloads.get() == 1, "automatic: not tried again for a day")
    u.checkNow()
    u.queue.sync {}
    #expect(r.downloads.get() == 2, "the owner asked")
  }

  /// A request file is anyone's to write: it runs the check the timer would, backoff included. Only the owner's click retries a failure.
  @Test func aRequestFileDoesNotSkipTheBackoffOfAFailedRelease() throws {
    let r = try Rig()
    try r.publish(sha: String(repeating: "0", count: 64))
    let u = r.updater()
    u.tick()
    #expect(r.downloads.get() == 1)
    try Self.writeRequest(r, Self.fresh(r))
    u.tick()
    #expect(r.downloads.get() == 1, "the file was answered by a check, which honoured the one-day backoff")
    #expect(!FileManager.default.fileExists(atPath: Self.requestPath(r)))
    u.checkNow()
    u.queue.sync {}
    #expect(r.downloads.get() == 2, "the click retries")
  }

  @Test func aRelayBehindAndABusyMacShowBothReasons() throws {
    let r = try Rig()
    try r.publish()
    r.busy.set(["main running"])
    let u = r.updater(hooks: { h in h.relayBuild = { r.a } })
    u.tick()
    #expect(u.status == .relayBehind(version: "1.5.0", relay: r.a, app: r.b, why: ["main running"]))
    let t = u.status.words.detail
    #expect(t.contains("redeploy the relay") && t.contains("also waiting for a quiet moment") && t.contains("does not wait for the relay"))
  }

  @Test func twoAsksAtOnceAreOneCheck() throws {
    let r = try Rig()
    try r.publish(version: "1.4.0")
    let u = r.updater(hooks: { h in
      let fetch = h.fetch
      h.fetch = { url, max, t in
        Thread.sleep(forTimeInterval: 0.2)
        return fetch(url, max, t)
      }
    })
    u.tick()
    let before = r.fetches.get()
    u.checkNow()
    u.checkNow()  // while the first is queued
    u.queue.sync {}
    #expect(r.fetches.get() - before == 2, "manifest and signature, once")
  }

  // MARK: the relay

  @Test func aRelayBehindTheReleaseSaysSoWithBothBuilds() throws {
    let r = try Rig()
    try r.publish()
    let relay = Box<String?>(r.a)  // the relay still serves the commit before the release
    let u = r.updater(hooks: { h in h.relayBuild = { relay.get() } })
    u.tick()
    #expect(u.status == .relayBehind(version: "1.5.0", relay: r.a, app: r.b))
    let text = u.status.words.detail
    #expect(text.contains(String(r.a.prefix(7))) && text.contains(String(r.b.prefix(7))), "both builds: \(text)")
    #expect(text.contains("redeploy the relay in Railway"), "what to do")
    #expect(UpdateMenu.showsDot(u.status), "the update is still offered")
    // the owner redeploys; the next look (5 minutes on) sees the relay on the release
    relay.set(r.b)
    r.clock.edit { $0 += 301 }
    u.tick()
    #expect(u.status == .ready(version: "1.5.0"))
  }

  @Test func aRelayWeCannotPlaceIsNeverCalledBehind() throws {
    let r = try Rig()
    try r.publish()
    for build in [nil, "0.1.4", "main", "deadbeefdeadbeef", "v0.1.0-3-g" + String(repeating: "1", count: 12), r.b] as [String?] {
      let u = r.updater(hooks: { h in h.relayBuild = { build } })
      u.tick()
      if case .relayBehind = u.status { Issue.record("claimed behind for \(build ?? "nil")") }
    }
  }

  /// A relay that is AHEAD of the release (a newer deploy) is not behind it, though its commit is in the clone too.
  @Test func aRelayAheadOfTheReleaseIsNotBehind() throws {
    let r = try Rig()
    try r.publish()
    r.git(["commit", "--allow-empty", "-qm", "C"], in: r.checkout)  // C, a child of the release B, in the owner's clone
    let c = r.git(["rev-parse", "HEAD"], in: r.checkout)
    r.git(["reset", "--hard", "-q", r.a], in: r.checkout)  // the clone is back on A, as at the start; C stays in its object store
    let u = r.updater(hooks: { h in h.relayBuild = { c } })
    u.tick()
    #expect(u.status == .ready(version: "1.5.0"), "\(u.status)")
  }

  @Test func theRelayIsNotWaitedForByTheSwap() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true, hooks: { h in h.relayBuild = { r.a } })
    u.tick()
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<4 { Self.step(r, u) }
    #expect(r.spawns.get().count == 1, "Update now goes ahead with the relay behind: the phone's note is the only cost")
    _ = r.runNewApp(healthy: true)
    #expect(r.log().contains("--no-relay-wait"), "never ten minutes and then exit 8")
  }

  // MARK: Update now

  /// One tick, 30 s on.
  static func step(_ r: Rig, _ u: AutoUpdater) {
    r.clock.edit { $0 += 30 }
    u.tick()
  }

  /// Update now while Main is mid-turn moves NOTHING: the code folder stays on the old commit under the old app, no package is installed,
  /// no swap starts. When the turn ends it takes the same 2 quiet looks in a row as the automatic path, and only then the prepare and the
  /// swap come together (no 2-minute notice: the owner asked).
  @Test func updateNowWhileMainIsMidTurnMovesNothingThenTakesTwoQuietLooksThenPreparesAndSwaps() throws {
    let r = try Rig()
    try r.publish()
    r.busy.set(["main running"])  // a turn is running
    let u = r.updater(realSwap: true)
    u.tick()
    #expect(u.status.pendingVersion == "1.5.0")
    u.updateNow()
    u.queue.sync {}
    #expect(u.status == .waitingForTurn(version: "1.5.0"), "the window says so: \(u.status)")
    #expect(r.audit().contains("auto_update update_now version=1.5.0"))
    for _ in 0..<8 {
      Self.step(r, u)
      #expect(r.head() == r.a && r.branch() == "main", "the clone has not moved")
      #expect(!r.log().contains("pnpm"), "no package was installed")
      #expect(r.spawns.get().isEmpty)
    }
    r.busy.set([])  // the turn ends
    Self.step(r, u)  // quiet look 1 of 2
    #expect(r.head() == r.a && r.spawns.get().isEmpty, "one quiet look is not enough")
    Self.step(r, u)  // quiet look 2: the prepare
    #expect(r.head() == r.b, "now the clone moves")
    #expect(r.log().contains("pnpm"))
    #expect(r.spawns.get().isEmpty, "and the swap is not started in the same breath: two more quiet looks")
    Self.step(r, u)
    Self.step(r, u)
    #expect(r.spawns.get().count == 1, "swapped")
    #expect(!r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")), "no 2-minute notice: the owner just asked")
    #expect(u.status == .restarting(version: "1.5.0"))
  }

  /// A turn that starts again while the prepare ran puts the folder back and goes on waiting: nothing stays moved.
  @Test func aTurnThatStartsDuringTheLastLooksPutsTheFolderBackAndTheUpdateKeepsWaiting() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    Self.step(r, u)
    Self.step(r, u)
    #expect(r.head() == r.b, "prepared")
    r.busy.set(["main running"])  // a turn begins
    Self.step(r, u)
    #expect(r.head() == r.a && r.branch() == "main", "the folder is back")
    #expect(r.spawns.get().isEmpty && u.status == .waitingForTurn(version: "1.5.0"))
    r.busy.set([])
    for _ in 0..<4 { Self.step(r, u) }
    #expect(r.spawns.get().count == 1, "and it goes in once the turn has ended")
  }

  @Test func updateNowOnAQuietMacStillTakesTwoQuietLooks() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    #expect(r.head() == r.a && r.spawns.get().isEmpty)
    for _ in 0..<4 { Self.step(r, u) }
    #expect(r.spawns.get().count == 1 && !r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")))
  }

  /// The owner typing (a message of theirs since the last look) is not quiet either, and starts the 2 looks over.
  @Test func updateNowWaitsWhileTheOwnerIsTyping() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    Self.step(r, u)  // quiet look 1
    r.owner.set("2026-11-19T22:10:00Z")  // they wrote
    Self.step(r, u)
    #expect(r.head() == r.a, "that look was not quiet: the streak starts over")
    Self.step(r, u)
    #expect(r.head() == r.a, "one quiet look since")
    Self.step(r, u)
    #expect(r.head() == r.b, "two quiet looks since they wrote: now it prepares")
  }

  /// A forced wait does not go on for ever: after 2 hours it gives up, says so, and nothing was ever moved.
  @Test func aForcedUpdateThatNeverGetsQuietGivesUpAtTwoHoursWithNothingMoved() throws {
    let r = try Rig()
    try r.publish()
    r.busy.set(["main running"])
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    r.clock.edit { $0 += AutoUpdate.quietCap + 1 }
    u.tick()
    #expect(r.spawns.get().isEmpty && r.head() == r.a && r.branch() == "main" && !r.log().contains("pnpm"))
    #expect(u.status == .failed(line: AutoUpdate.busyLine("1.5.0", old: "1.4.0"), logPath: u.logPathForOwner))
    #expect(r.audit().contains("gave_up_waiting"))
  }

  /// A turn that keeps starting during the prepare bounces the update again and again; the 2 hours still count from the press, so it gives
  /// up on time with the clone restored, instead of moving the folder forever.
  @Test func bouncesEveryFewMinutesStillGiveUpAtTwoHoursFromThePressWithTheCloneRestored() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    u.tick()
    let press = r.clock.get()
    u.updateNow()
    u.queue.sync {}
    var cycles = 0
    while cycles < 60 {
      if case .failed = u.status { break }
      Self.step(r, u)  // quiet look 1
      Self.step(r, u)  // quiet look 2: the prepare moves the clone
      r.busy.set(["main running"])  // and a turn begins
      Self.step(r, u)  // the last look is busy: the folder is put back
      r.busy.set([])
      r.clock.edit { $0 += 240 }  // a few minutes pass
      cycles += 1
    }
    let waited = r.clock.get() - press
    #expect(cycles < 60, "it gave up (\(cycles) bounces)")
    #expect(waited <= AutoUpdate.quietCap + 900, "gave up about 2 hours from the press, not later: \(waited) s")
    #expect(waited >= AutoUpdate.quietCap, "and not before: \(waited) s")
    #expect(u.status == .failed(line: AutoUpdate.busyLine("1.5.0", old: "1.4.0"), logPath: u.logPathForOwner))
    #expect(r.head() == r.a && r.branch() == "main" && r.spawns.get().isEmpty, "the clone is back")
  }

  @Test func updateNowStillStopsWhenThisAppIsNotHealthy() throws {
    let r = try Rig()
    try r.publish()
    r.healthyNow.set(false)
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<6 { Self.step(r, u) }
    #expect(r.spawns.get().isEmpty, "the health gate is not skipped")
    #expect(r.head() == r.a && r.branch() == "main", "the code folder is back where it was")
    #expect(u.status == .failed(line: AutoUpdate.notHealthyLine, logPath: u.logPathForOwner))
    // "Check again" clears the failure and looks again (the update is still ready)
    r.healthyNow.set(true)
    u.checkNow()
    u.queue.sync {}
    if case .failed = u.status { Issue.record("still failed after Check again: \(u.status)") }
    #expect(u.status.pendingVersion == "1.5.0", "\(u.status)")
    // and the permission was not kept: a busy Mac waits again
    r.busy.set(["main running"])
    for _ in 0..<6 {
      r.clock.edit { $0 += 30 + AutoUpdate.postponeFor }
      u.tick()
    }
    #expect(r.spawns.get().isEmpty && r.head() == r.a, "busy still means waiting")
  }

  @Test func updateNowStillStopsWhenMainCouldNotComeBack() throws {
    let r = try Rig()
    try r.publish()
    r.mainCanRestart.set(false)
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<6 { Self.step(r, u) }
    #expect(r.spawns.get().isEmpty && r.head() == r.a)
    #expect(u.status == .failed(line: AutoUpdate.cannotRestartLine, logPath: u.logPathForOwner))
  }

  @Test func updateNowWithNothingDownloadedDoesNothing() throws {
    let r = try Rig()
    try r.publish(version: "1.4.0")
    let u = r.updater()
    u.tick()
    u.updateNow()
    u.queue.sync {}
    #expect(r.spawns.get().isEmpty && u.status == .upToDate(version: "1.4.0"))
  }

  // MARK: one action

  /// App, clone, packages and agent in one action: the code folder moves to the release's commit and its packages install (prepare),
  /// the app is swapped (without waiting for the relay), and the new app restarts Main onto the release.
  @Test func oneUpdateMovesTheCloneInstallsPackagesSwapsTheAppAndRestartsTheAgent() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<4 { Self.step(r, u) }
    let next = r.runNewApp(healthy: true)
    #expect(r.head() == r.b, "the clone is on the release's commit")
    #expect(r.log().contains("pnpm"), "its packages were installed")
    #expect(r.log().contains("install B --from-release"), "the app was swapped")
    #expect(r.mainRestarts.get().first == r.b, "the agent is cold-restarted onto the release")
    next.tick()
    #expect(next.status == .done(version: "1.5.0"))
  }

  // MARK: the recorded clone

  /// The updater only ever uses the clone its hook names, and never writes a record of any clone itself. An unaccepted one raises the
  /// owner's card; nothing is downloaded or moved until they say yes.
  @Test func theRecordedCloneIsNeverRepointedByTheUpdater() throws {
    let r = try Rig()
    try r.publish()
    let record = r.root + "/userhome/Library/Application Support/app.talos.desktop/checkout"
    try FileManager.default.createDirectory(atPath: (record as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data("/home/alex/talos-recorded\n".utf8).write(to: URL(fileURLWithPath: record))
    let offers = Box<[String]>([])
    let co = r.checkout
    let u = r.updater(hooks: { h in
      h.checkout = { nil }
      h.unacceptedClone = { co }
      h.offerClone = { c, _ in offers.edit { $0.append(c) } }
    })
    u.tick()
    u.checkNow()
    u.queue.sync {}
    #expect(r.downloads.get() == 0 && r.spawns.get().isEmpty && r.head() == r.a, "nothing moved without the owner's yes")
    #expect(!offers.get().isEmpty && offers.get().allSatisfy { $0 == co })
    #expect(u.status == .needsAllow(version: "1.5.0", clone: co))
    #expect(AutoUpdate.cloneNeedsOKLine(co).contains(co), "the clone is named")
    #expect(try String(contentsOfFile: record, encoding: .utf8) == "/home/alex/talos-recorded\n", "the record is as the owner left it")
  }

  // MARK: how often a Mac looks

  /// Every hour, moved by up to 10 minutes either way, drawn per check.
  @Test func theNextCheckIsAnHourOnWithAJitterOfTenMinutes() throws {
    #expect(AutoUpdate.checkEvery == 3600 && AutoUpdate.checkJitter == 600)
    for (draw, minutes) in [(0.0, 50.0), (0.5, 60.0), (0.999999, 70.0)] {
      let r = try Rig()
      try r.publish(version: "1.4.0")  // nothing to install: the check just ends
      r.random.set(draw)
      let u = r.updater(jitter: 600)
      u.tick()
      let start = r.clock.get()
      guard case .idle(let next) = u.phase else { Issue.record("not idle: \(u.phase)"); return }
      #expect(abs((next - start) / 60 - minutes) < 0.01, "draw \(draw): \((next - start) / 60) min")
      #expect((next - start) >= 50 * 60 && (next - start) <= 70 * 60, "within [50, 70] minutes")
    }
  }

  @Test func theJitterIsDrawnAgainForEachCheck() throws {
    let r = try Rig()
    try r.publish(version: "1.4.0")
    let u = r.updater(jitter: 600)
    var nexts: [Double] = []
    for draw in [0.1, 0.9] {
      r.random.set(draw)
      r.clock.edit { $0 += 4200 }
      u.tick()
      if case .idle(let n) = u.phase { nexts.append(n - r.clock.get()) }
    }
    #expect(nexts.count == 2 && nexts[0] != nexts[1], "\(nexts)")
  }

  /// A release that failed still waits a day, hourly checks or not.
  @Test func aFailedReleaseStillWaitsADayWithHourlyChecks() throws {
    let r = try Rig()
    try r.publish(sha: String(repeating: "0", count: 64))
    let u = r.updater()
    u.tick()
    #expect(r.downloads.get() == 1)
    for _ in 0..<23 {
      r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
      r.wallShift.edit { $0 += AutoUpdate.checkEvery + 1 }
      u.tick()
    }
    #expect(r.downloads.get() == 1, "23 hourly checks later it is still not tried again")
    r.wallShift.edit { $0 += AutoUpdate.checkEvery * 2 }
    r.clock.edit { $0 += AutoUpdate.checkEvery + 1 }
    u.tick()
    #expect(r.downloads.get() == 2, "after the day it is")
  }
}

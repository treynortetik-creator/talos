import Foundation
import Testing
@testable import TalosDesktopCore

private let now: Double = 1_800_000_000_000  // an injected "now", unix ms

private func request(id: String = "c1", age: Double = 1_000) -> AgentRequestFile {
  .request(AgentRequest(controlId: id, ts: now - age))
}

private func decide(
  _ file: AgentRequestFile = .absent, handled: String? = nil, loop: Bool = false, down: Double = 0, restored: Bool = false,
  stopped: Bool = false, since: Double? = nil, launched: Double = 0
) -> AgentRecovery.Action {
  AgentRecovery.decide(
    request: file, nowMs: now, lastHandledId: handled, crashLoopStopped: loop, bridgeDownFor: down, restoredOnce: restored,
    ownerStopped: stopped, sinceLastRequest: since, launchedAtMs: launched)
}

@Suite("Agent recovery decisions")
struct AgentRecoveryDecisionTests {
  // 1. once per control_id, and not when old
  @Test func aRequestIsActedOnOncePerControlId() {
    #expect(decide(request(id: "c1")) == .restart(controlId: "c1"))
    #expect(decide(request(id: "c1"), handled: "c1") == .discard, "the same control_id again does nothing")
    #expect(decide(request(id: "c2"), handled: "c1") == .restart(controlId: "c2"), "a new one is acted on")
  }

  @Test func aRequestOlderThanFiveMinutesByItsTsIsIgnoredAndCleared() {
    #expect(decide(request(age: 300_000)) == .restart(controlId: "c1"), "exactly five minutes still counts")
    #expect(decide(request(age: 300_001)) == .discard)
  }

  @Test func aRequestDatedBeforeTheLaunchIsDiscardedAndOneAtOrAfterItIsNot() {
    let launched = now - 500
    #expect(decide(request(age: 501), launched: launched) == .discard)
    #expect(decide(request(age: 501), stopped: true, launched: launched) == .discard, "no refusal line either")
    #expect(decide(request(age: 500), launched: launched) == .restart(controlId: "c1"), "dated at the launch counts")
    #expect(decide(request(age: 100), launched: launched) == .restart(controlId: "c1"))
  }

  @Test func anUnusableFileIsClearedNotActedOn() {
    #expect(decide(.invalid) == .discard)
    #expect(decide(.invalid, loop: true) == .discard, "nothing else happens in the same step")
    #expect(decide(.absent) == .none)
  }

  // 2. crash loop
  @Test func aCrashLoopRestoresExactlyOnceThenStops() {
    #expect(decide(loop: true) == .restore(.crashLoop))
    #expect(decide(loop: true, restored: true) == .none, "the latch: no second restore")
    #expect(decide(loop: false) == .none, "a running agent is left alone")
  }

  // 4. bridge down
  @Test func aBridgeDownPastTheLimitRestoresOnce() {
    #expect(decide(down: AgentRecovery.bridgeDownLimit - 0.5) == .none)
    #expect(decide(down: AgentRecovery.bridgeDownLimit) == .restore(.bridgeDown))
    #expect(decide(down: AgentRecovery.bridgeDownLimit * 3, restored: true) == .none)
  }

  // 5. restart
  @Test func aRequestRestartsAndNeverRestores() {
    #expect(decide(request()) == .restart(controlId: "c1"))
    #expect(decide(request(), restored: true) == .restart(controlId: "c1"), "not held back by the automatic latch")
  }

  @Test func aRequestComesBeforeTheAutomaticChecks() {
    #expect(decide(request(), loop: true, down: 9_999) == .restart(controlId: "c1"))
  }

  // The owner's Stop at the Mac wins over the phone. A product decision: the one `if ownerStopped` in `decide`.
  @Test func aRequestWhileTheOwnerHasStoppedTheAgentIsRefusedAndNamed() {
    #expect(decide(request(), stopped: true) == .refuse(.ownerStopped))
    #expect(decide(request(), stopped: false) == .restart(controlId: "c1"))
    #expect(decide(request(), handled: "c1", stopped: true) == .discard, "an old one is just cleared: no second notice")
    #expect(decide(request(age: 300_001), stopped: true) == .discard)
    #expect(decide(.invalid, stopped: true) == .discard)
    #expect(decide(stopped: true) == .none, "no request, nothing to refuse")
  }

  // At most one request per requestMinGap seconds of awake time.
  @Test func aRequestInsideTheWindowIsRefusedAndTheEdgeIsOpen() {
    let gap = AgentRecovery.requestMinGap
    #expect(gap == 120)
    #expect(decide(request(), since: gap - 0.001) == .refuse(.tooSoon))
    #expect(decide(request(), since: 0) == .refuse(.tooSoon))
    #expect(decide(request(), since: gap) == .restart(controlId: "c1"), "exactly the gap is outside")
    #expect(decide(request(), since: gap + 1) == .restart(controlId: "c1"))
    #expect(decide(request(), since: nil) == .restart(controlId: "c1"), "the first one ever")
    #expect(decide(request(), stopped: true, since: 5) == .refuse(.ownerStopped), "Stop is named first")
  }

  @Test func theAutomaticRestoreIsNotRateLimited() {
    #expect(decide(loop: true, since: 1) == .restore(.crashLoop))
    #expect(decide(down: AgentRecovery.bridgeDownLimit, since: 1) == .restore(.bridgeDown))
  }

  // A forged ts far ahead must not make a request live forever.
  @Test func aTimestampMoreThanAMinuteInTheFutureIsStale() {
    #expect(decide(request(age: -60_000)) == .restart(controlId: "c1"), "a minute of clock skew is allowed")
    #expect(decide(request(age: -60_001)) == .discard)
    #expect(decide(request(age: -10_000_000_000)) == .discard)
  }

}

@Suite("Agent recovery inputs")
struct AgentRecoveryInputTests {
  private func status(updatedMsAgo: Double, mode: BridgeStatus.Mode = .live, relay: Bool = true) -> BridgeStatus {
    BridgeStatus(
      pid: 4242, mode: mode, relayConnected: relay, lastConnectAt: nil, lastCloseCode: nil, queueDepth: 0, permissionRelay: false,
      updatedAt: Date(timeIntervalSince1970: (now - updatedMsAgo) / 1000))
  }
  private func health(_ s: BridgeStatus?, alive: Bool = true) -> BridgeStatus.Health? {
    AgentRecovery.bridgeHealth(s, nowMs: now, pidAlive: { _ in alive })
  }

  @Test func theHealthIsReadFromTheStatusFile() {
    #expect(health(status(updatedMsAgo: 1_000)) == .healthy)
    #expect(health(status(updatedMsAgo: 400_000)) == .stale)
    #expect(health(status(updatedMsAgo: 1_000), alive: false) == .dead, "a dead pid beats a fresh-looking file")
    #expect(health(status(updatedMsAgo: 1_000, relay: false)) == .relayDown)
    #expect(health(nil) == nil, "no status file is unknown")
    #expect(health(status(updatedMsAgo: -60_000)) == nil, "a stamp from the future says nothing about an outage")
    #expect(health(status(updatedMsAgo: -4_000)) == .healthy, "a few seconds of skew is fine")
  }

  // Counted on the awake clock from the first sighting, and only for a bridge seen up in this start.
  private func watch(_ steps: [(BridgeStatus.Health?, Bool, Double)]) -> AgentRecovery.BridgeWatch {
    var w = AgentRecovery.BridgeWatch()
    for (h, running, t) in steps { w.observe(h, running: running, awakeNow: t) }
    return w
  }

  @Test func downTimeStartsAtTheFirstSightingAfterTheBridgeWasUp() {
    let w = watch([(.healthy, true, 10), (.stale, true, 50), (.dead, true, 400)])
    #expect(w.downSince == 50, "from the first tick that saw it down, kept while it stays down")
    #expect(w.downFor(awakeNow: 400) == 350)
    #expect(AgentRecovery.BridgeWatch().downFor(awakeNow: 400) == 0)
  }

  @Test func aStatusFromBeforeThisStartIsNeverDown() {
    #expect(watch([(.dead, true, 10), (.stale, true, 400), (.dead, true, 900)]).downSince == nil)
    #expect(watch([(nil, true, 10), (.relayDown, true, 20), (.headless, true, 30), (.stale, true, 400)]).downSince == nil)
  }

  @Test func anythingButDownEndsTheStretch() {
    let ups: [BridgeStatus.Health?] = [.healthy, .relayDown, .headless, .superseded, nil]
    for up in ups {
      #expect(watch([(.healthy, true, 0), (.stale, true, 10), (up, true, 20)]).downSince == nil, "\(String(describing: up))")
    }
    let again = watch([(.healthy, true, 0), (.stale, true, 10), (.healthy, true, 20), (.stale, true, 900)])
    #expect(again.downSince == 900, "and a new stretch starts fresh")
  }

  @Test func aTickWhereTheAgentIsNotRunningStartsTheWatchOver() {
    let w = watch([(.healthy, true, 0), (.stale, true, 10), (nil, false, 20), (.stale, true, 30)])
    #expect(w.downSince == nil, "the next start has seen nothing yet, so an old file is not an outage")
    #expect(watch([(.healthy, true, 0), (nil, false, 5), (.healthy, true, 10), (.stale, true, 20)]).downSince == 20)
  }

  @Test func aStartIsHealthyOnlyAfterHoldingAndWithTheBridgeUp() {
    func ok(_ running: Bool = true, _ held: Double = 600, _ down: Bool = false) -> Bool {
      AgentRecovery.isHealthy(running: running, runningFor: held, healthyFor: 600, bridgeDown: down)
    }
    #expect(ok())
    #expect(!ok(true, 599), "not held long enough")
    #expect(!ok(false), "the live phase was not reached")
    #expect(!ok(true, 600, true), "a bridge that is down is not a healthy start")
  }
}

@Suite("Agent request file")
struct AgentRequestFileTests {
  private func parse(_ s: String) -> AgentRequest? { AgentRequest.parse(Data(s.utf8)) }
  private func good(_ id: String = "c1", _ action: String = "restart") -> String {
    #"{"v":1,"control_id":"\#(id)","action":"\#(action)","ts":1800000000000}"#
  }

  @Test func theFixedFormatParses() {
    #expect(parse(good()) == AgentRequest(controlId: "c1", ts: 1_800_000_000_000))
    #expect(parse(#"{"v":1,"control_id":"c1","action":"restart","ts":1.8e12,"extra":true}"#) != nil, "extra fields are ignored")
  }

  @Test(arguments: [
    #"{"v":2,"control_id":"c1","action":"restart","ts":1}"#, #"{"v":"1","control_id":"c1","action":"restart","ts":1}"#,
    #"{"v":true,"control_id":"c1","action":"restart","ts":1}"#, #"{"control_id":"c1","action":"restart","ts":1}"#,
    #"{"v":1,"control_id":"c1","action":"reboot","ts":1}"#, #"{"v":1,"control_id":"c1","action":"RESTART","ts":1}"#,
    #"{"v":1,"control_id":"c1","ts":1}"#, #"{"v":1,"control_id":"","action":"restart","ts":1}"#,
    #"{"v":1,"control_id":7,"action":"restart","ts":1}"#, #"{"v":1,"action":"restart","ts":1}"#,
    #"{"v":1,"control_id":"a\nb","action":"restart","ts":1}"#, #"{"v":1,"control_id":"c1","action":"restart","ts":"1"}"#,
    #"{"v":1,"control_id":"c1","action":"restart","ts":true}"#, #"{"v":1,"control_id":"c1","action":"restart"}"#,
    #"{"v":1,"control_id":"c1","action":"restart","ts":null}"#, "[1,2]", "not json", "", "{",
  ])
  func anythingElseIsNotARequest(_ text: String) {
    #expect(parse(text) == nil, "\(text)")
  }

  @Test func restoreIsNotAPhoneAction() {
    #expect(parse(good("c1", "restore_last_good")) == nil)
  }

  @Test func theIdIsShort() {
    #expect(parse(good(String(repeating: "a", count: AgentRequest.maxIdLength))) != nil)
    #expect(parse(good(String(repeating: "a", count: AgentRequest.maxIdLength + 1))) == nil)
  }

  /// The id is only compared, but it comes from a file the agent can write: letters, digits, `_` and `-` only.
  @Test(arguments: ["a/b", "../x", "..", "a b", "a;b", "a$b", "a|b", "a`b", "a'b", "a\\b", "é", "a.b", "a:b", " ", "a\u{0}b"])
  func anIdThatCouldReachAShellOrAPathIsNotAnId(_ id: String) {
    #expect(parse(good(id)) == nil, "\(id)")
  }

  @Test(arguments: ["a", "A-9_z", "0123456789", "7f1c2e4a-9b0d-4c3e-8a5f-1234567890ab"])
  func anIdOfLettersDigitsDashAndUnderscoreIsFine(_ id: String) {
    #expect(parse(good(id))?.controlId == id)
  }

  // reading the real path

  private func inTempDir(_ body: (String) throws -> Void) throws {
    let dir = NSTemporaryDirectory() + "agent-request-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    try body(dir)
  }

  @Test func readTellsAbsentFromInvalidFromARequest() throws {
    try inTempDir { dir in
      let p = dir + "/agent-request.json"
      #expect(AgentRequestFile.read(path: p) == .absent)
      try good().write(toFile: p, atomically: true, encoding: .utf8)
      #expect(AgentRequestFile.read(path: p) == .request(AgentRequest(controlId: "c1", ts: 1_800_000_000_000)))
      try "{ torn".write(toFile: p, atomically: true, encoding: .utf8)
      #expect(AgentRequestFile.read(path: p) == .invalid)
    }
  }

  @Test func aLinkADirectoryOrAHugeFileIsInvalidAndNeverFollowedOrReadWhole() throws {
    try inTempDir { dir in
      let real = dir + "/real.json"
      try good().write(toFile: real, atomically: true, encoding: .utf8)
      let link = dir + "/agent-request.json"
      try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: real)
      #expect(AgentRequestFile.read(path: link) == .invalid, "a link is not followed, even to a good request")
      #expect(AgentRequestFile.clear(path: link, ifStill: .invalid))
      #expect(FileManager.default.fileExists(atPath: real), "the link went, not what it pointed at")

      try FileManager.default.createDirectory(atPath: link, withIntermediateDirectories: false)
      #expect(AgentRequestFile.read(path: link) == .invalid)
      try FileManager.default.removeItem(atPath: link)

      // a good request, then padding past the cap: the part that would be read is a whole request, and still it is refused
      try (good() + String(repeating: " ", count: AgentRequest.maxBytes)).write(toFile: link, atomically: true, encoding: .utf8)
      #expect(AgentRequestFile.read(path: link) == .invalid)
    }
  }

  @Test func clearRemovesOnlyTheFileThatWasRead() throws {
    try inTempDir { dir in
      let p = dir + "/agent-request.json"
      try good("c1").write(toFile: p, atomically: true, encoding: .utf8)
      let seen = AgentRequestFile.read(path: p)
      try good("c2").write(toFile: p, atomically: true, encoding: .utf8)
      #expect(!AgentRequestFile.clear(path: p, ifStill: seen), "a newer request written in between is kept")
      #expect(AgentRequestFile.read(path: p) != .absent)
      let now2 = AgentRequestFile.read(path: p)
      #expect(AgentRequestFile.clear(path: p, ifStill: now2))
      #expect(AgentRequestFile.read(path: p) == .absent)
      #expect(!AgentRequestFile.clear(path: p, ifStill: now2), "already gone")
    }
  }

  @Test func anInvalidFileIsNotClearedOnceItBecomesARequest() throws {
    try inTempDir { dir in
      let p = dir + "/agent-request.json"
      try "junk".write(toFile: p, atomically: true, encoding: .utf8)
      let seen = AgentRequestFile.read(path: p)
      try good().write(toFile: p, atomically: true, encoding: .utf8)
      #expect(!AgentRequestFile.clear(path: p, ifStill: seen))
      #expect(FileManager.default.fileExists(atPath: p))
    }
  }
}

@Suite("Agent recovery notices")
struct AgentRecoveryNoticeTests {
  private let changed = AgentRecovery.RestoreResult.changed(files: ".mcp.json, .claude/settings.json", saved: "2026-11-02 17:02 UTC")
  private var all: [AgentRecovery.Outcome] {
    [
      .restartedOnRequest, .restoreFailed, .ignoredOwnerStopped, .ignoredTooSoon,
      .restored(.crashLoop, changed, restarted: true), .restored(.bridgeDown, changed, restarted: true),
      .restored(.crashLoop, .nothingToChange, restarted: true), .restored(.bridgeDown, .unknown, restarted: true),
      .restored(.bridgeDown, changed, restarted: false), .restored(.bridgeDown, .nothingToChange, restarted: false),
    ]
  }

  @Test func theRequestedActionsUseTheAgreedWords() {
    #expect(SupervisorNotice.recovery(.restartedOnRequest) == "Restarted the agent: asked from your phone")
    #expect(
      SupervisorNotice.recovery(.ignoredOwnerStopped) == "Ignored a restart request: you stopped the agent at the Mac.")
    #expect(SupervisorNotice.event(for: SupervisorNotice.ignoredOwnerStopped) == nil, "a menu line, like the other requested ones")
    #expect(
      SupervisorNotice.recovery(.ignoredTooSoon) == "Ignored a restart request: one was acted on less than 2 minutes ago.",
      "the minutes come from the rate limit")
    #expect(AgentRecovery.requestMinGap == 120)
    #expect(SupervisorNotice.event(for: SupervisorNotice.ignoredTooSoon) == nil, "a menu line only: a burst must not raise a banner each")
  }

  @Test func thePhoneHearsTheMenusLineForARestoreThatChangedSomethingOrFailed() {
    for o in all {
      switch o {
      case .restoreFailed, .restored(_, .changed, _), .restored(_, .unknown, _):
        #expect(SupervisorNotice.phoneLine(o) == SupervisorNotice.recovery(o), "\(o)")
      case .restored(_, .nothingToChange, _), .restartedOnRequest, .ignoredOwnerStopped, .ignoredTooSoon:
        #expect(SupervisorNotice.phoneLine(o) == nil, "nothing to say: \(o)")
      }
    }
  }

  @Test func theAutomaticRestoreSaysWhatItWroteAndWhen() {
    #expect(
      SupervisorNotice.recovery(.restored(.crashLoop, changed, restarted: true))
        == "Talos kept crashing, so it put back the last good setup (wrote .mcp.json, .claude/settings.json from the version saved 2026-11-02 17:02 UTC) and restarted")
    #expect(
      SupervisorNotice.recovery(.restored(.bridgeDown, .unknown, restarted: true))
        == "The bridge stayed down, so Talos put back the last good setup and restarted")
    #expect(
      SupervisorNotice.recovery(.restored(.bridgeDown, .nothingToChange, restarted: true))
        == "Tried restoring the last good setup: nothing to change. Restarted the agent.")
  }

  @Test func aRestoreTheOwnerStoppedDuringSaysItWasNotRestarted() {
    for r in [changed, .nothingToChange, .unknown] {
      let t = SupervisorNotice.recovery(.restored(.bridgeDown, r, restarted: false))
      #expect(t.contains("not restarted"), "\(t)")
      #expect(!t.hasSuffix("and restarted") && !t.contains("Restarted the agent"), "\(t)")
    }
  }

  @Test func theColdStartPostNamesTheAgentAndTheKeyPress() {
    #expect(CrashPost.coldStartText(agentName: "Ada").hasPrefix("Ada restarted"))
    #expect(CrashPost.coldStartText(agentName: nil).hasPrefix("The agent restarted"))
    #expect(CrashPost.coldStartText(agentName: "Ada").contains("press Enter on the dev-channel warning"))
  }

  @Test func eachOutcomeHasItsOwnPlainSentence() {
    let texts = all.map(SupervisorNotice.recovery)
    #expect(Set(texts).count == all.count)
    #expect(texts.allSatisfy { !$0.isEmpty && $0.count < 220 })
  }

  @Test func theAutomaticOnesAndTheFailureRaiseABannerAndTheRequestedOnesDoNot() {
    for r in [changed, .unknown] {
      #expect(SupervisorNotice.event(for: SupervisorNotice.recovery(.restored(.crashLoop, r, restarted: true))) == .autoRestored)
      #expect(SupervisorNotice.event(for: SupervisorNotice.recovery(.restored(.bridgeDown, r, restarted: true))) == .autoRestored)
    }
    #expect(SupervisorNotice.event(for: SupervisorNotice.restoreFailed) == .restoreFailed)
    #expect(SupervisorNotice.event(for: SupervisorNotice.restartedOnRequest) == nil, "the owner just tapped it")
    #expect(
      SupervisorNotice.event(for: SupervisorNotice.recovery(.restored(.bridgeDown, .nothingToChange, restarted: true))) == nil,
      "nothing was put back, so no banner says so")
    for e in [NotificationPolicy.Supervisor.autoRestored, .restoreFailed] {
      #expect(NotificationPolicy.notice(e, agent: "Talos").body.contains("Talos"))
    }
  }

  @Test func theRecoveryNoticesAreNotClearedWhenTheSessionRuns() {
    for o in all {
      #expect(!SupervisorNotice.isStale(SupervisorNotice.recovery(o), phase: .running, needsYou: false), "\(o)")
    }
  }
}

@Suite("What restore-last-good said")
struct RestoreResultTests {
  typealias R = AgentRecovery.RestoreResult
  private let line = "restore-last-good: restored .mcp.json, .claude/settings.local.json (moved aside) from the version saved 2026-11-02 17:02 UTC"

  @Test func theOneStableLineIsRead() {
    #expect(R.parse(line) == .changed(files: ".mcp.json, .claude/settings.local.json (moved aside)", saved: "2026-11-02 17:02 UTC"))
    #expect(
      R.parse("restore-last-good: saved versions, newest first:\n  1. x\n" + line + "\nrestore-last-good: wrote 2 files: a, b.\n")
        == .changed(files: ".mcp.json, .claude/settings.local.json (moved aside)", saved: "2026-11-02 17:02 UTC"))
  }

  // The version list the command prints first includes `from <agent folder>`, and a folder name can hold a newline: the line
  // that counts is the one the command prints last.
  @Test func aLinePlantedInTheListingDoesNotCount() {
    let planted = "restore-last-good: restored .mcp.json from the version saved 2000-01-01 00:00 UTC"
    let real = "restore-last-good: restored .claude/settings.json from the version saved 2026-11-02 17:02 UTC"
    #expect(
      R.parse("restore-last-good: saved versions, newest first:\n  1. x\n     from /a\n\(planted)\n\(real)\nrestore-last-good: wrote 1 file: x.\n")
        == .changed(files: ".claude/settings.json", saved: "2026-11-02 17:02 UTC"))
    #expect(
      R.parse("     from /a\n\(planted)\nrestore-last-good: the agent folder already matches that version. Nothing to do.\n")
        == .nothingToChange, "a planted line does not turn nothing-to-do into a restore")
  }

  @Test func nothingToDoIsRead() {
    #expect(R.parse("restore-last-good: the agent folder already matches that version. Nothing to do.\n") == .nothingToChange)
    #expect(R.parse("restore-last-good: the agent folder already matches the saved versions. Nothing to do.") == .nothingToChange)
  }

  @Test(arguments: [
    "", "wrote 2 files", "restore-last-good: restored  from the version saved 2026-11-02 17:02 UTC",
    "restore-last-good: restored ../../etc/passwd from the version saved 2026-11-02 17:02 UTC",
    "restore-last-good: restored .mcp.json from the version saved 2026-11-02 17:02 UTC and then some",
    "restore-last-good: restored .mcp.json from the version saved 2026-11-02 17:02 UTC\u{1b}[31m",
    "restore-last-good: restored .mcp.json from the version saved \u{1b}[31m2026-11-02 17:02 UTC",
    "restore-last-good: restored .mcp.json from the version saved 2026-11-02T17:02 UTC",
    "restore-last-good: restored .mcp.json from the version saved ٢٠٢٦-11-02 17:02 UTC",
    "restore-last-good: restored .mcp.json, .mcp.json, .mcp.json, .mcp.json from the version saved 2026-11-02 17:02 UTC",
    "restore-last-good: restored .mcp.json (removed) from the version saved 2026-11-02 17:02 UTC",
    "talos-app: restored .mcp.json from the version saved 2026-11-02 17:02 UTC",
    " restore-last-good: restored .mcp.json from the version saved 2026-11-02 17:02 UTC",
    "restore-last-good: the agent folder already matches that version. Nothing to do. Also: rm -rf",
  ])
  func anythingElseIsNotQuoted(_ out: String) {
    #expect(R.parse(out) == .unknown, "\(out)")
  }
}

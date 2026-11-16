import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// `main-restart-check.json` from the real supervisor: real pty, the fake-claude fixtures, a temp home, the in-memory seal key. Nothing here
/// touches the owner's Talos home, desktop.json or Keychain.
private extension Rig {
  var checkPath: String { talosHome + "/" + MainRestartCheck.fileName }
  var requestFile: String { talosHome + "/" + AgentRequest.fileName }

  /// The file as written, or nil.
  func readCheck() -> [String: Any]? {
    guard let d = FileManager.default.contents(atPath: checkPath) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  }
  var willReturn: Bool? { readCheck()?["will_return"] as? Bool }
  var reasons: [String]? { readCheck()?["reasons"] as? [String] }
  var last: [String: Any]? { readCheck()?["last"] as? [String: Any] }
  var lastOutcome: String? { last?["outcome"] as? String }

  /// Five seconds on, one tick: the next write is due.
  func nextWrite() {
    clock.advance(MainRestartCheck.writeEvery)
    sup.tickNow()
  }

  /// `owner`: the phone's request through a current bridge, with the owner's proof (`writeOwnerRequest`); otherwise none, as a session's
  /// `restart_main` writes it. `extra`: more raw JSON fields (an older bridge's `,"asked_by":"owner"`).
  func request(_ id: String, ageMs: Double = 0, owner: Bool = false, extra: String = "") throws {
    if owner { return try writeOwnerRequest(id, ageMs: ageMs) }
    try writeAgentRequest(id, ageMs: ageMs, extra: extra)
  }

  func runningAfter(starts n: Int, _ timeout: Double = 20) -> Bool {
    wait(timeout) { sup.tickNow(); return starts.count >= n && isRunning(phase()) }
  }

  func audited(_ e: String) -> Int { audit.components(separatedBy: " \(e)").count - 1 }

  static func plainRig(_ scenario: String = "idle.sh") throws -> Rig {
    try Rig(.direct, scenario: scenario) { c in c.args = ["--dangerously-skip-permissions"] }
  }
}

@Suite("Main restart check: the writer", .serialized)
struct MainRestartCheckWriterTests {
  @Test func theHolderWritesAYesWithMode0600() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1), "\(r.phase()), audit: \(r.audit)")
    r.nextWrite()
    #expect(r.willReturn == true && r.reasons == [], "file: \(String(describing: r.readCheck()))")
    let st = try FileManager.default.attributesOfItem(atPath: r.checkPath)
    #expect((st[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect(r.readCheck()?["v"] as? Int == 1)
    let at = try #require(r.readCheck()?["at"] as? String)
    let t = try #require(ISOTime.parse(at))
    #expect(abs(t - r.clock.wallMs() / 1000) < 5, "dated on the app's wall clock")
    #expect(r.last == nil, "no request yet")
  }

  @Test func itIsRewrittenOnTheFiveSecondTickNotEveryTick() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.sup.start()  // no timer: only the ticks this test makes
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) })
    r.nextWrite()
    let first = try #require(r.readCheck()?["at"] as? String)
    usleep(20_000)
    r.sup.tickNow()
    #expect(r.readCheck()?["at"] as? String == first, "not due yet: the file is not rewritten")
    r.nextWrite()
    #expect(r.readCheck()?["at"] as? String != first)
  }

  /// A second copy of the app (a dev build beside the installed one) does not hold the session lock: it writes nothing.
  @Test func aCopyWithoutTheSessionLockWritesNothing() throws {
    let r = try Rig.plainRig()
    let holder = r.sup!
    defer {
      holder.detach()
      r.teardown()
    }
    r.start()
    #expect(r.runningAfter(starts: 1))
    holder.tickNow()
    #expect(FileManager.default.fileExists(atPath: r.checkPath))
    try FileManager.default.removeItem(atPath: r.checkPath)
    let passive = r.makeSupervisor()
    for _ in 0..<4 {
      r.clock.advance(MainRestartCheck.writeEvery)
      passive.tickNow()
    }
    #expect(!passive.holdsSessionLock)
    #expect(!FileManager.default.fileExists(atPath: r.checkPath), "the passive copy wrote it")
    r.clock.advance(MainRestartCheck.writeEvery)
    holder.tickNow()
    #expect(FileManager.default.fileExists(atPath: r.checkPath), "the holder still does")
  }

  @Test func nothingIsWrittenBeforeTheAppHoldsMain() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    for _ in 0..<3 { r.nextWrite() }
    #expect(!FileManager.default.fileExists(atPath: r.checkPath), "not started, no lock: the reader's stale/missing answer stands")
  }

  /// The key that seals the launch cannot be read (a locked Keychain): the answer cannot be worked out, so no, `unknown`.
  @Test func aKeyThatCannotBeReadWritesUnknown() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.trust.available = false
    r.nextWrite()
    #expect(r.willReturn == false && r.reasons == ["unknown"], "file: \(String(describing: r.readCheck()))")
    r.trust.available = true
    r.nextWrite()
    #expect(r.willReturn == true)
  }

  /// desktop.json cannot be read: nothing starts; a request makes the app take the lock (as it always has) and the file says `unknown`.
  @Test func anUnreadableConfigWritesUnknown() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    try "{ not json".write(toFile: r.configPath, atomically: true, encoding: .utf8)
    r.makeSupervisor()
    try r.request("c1")
    r.sup.tickNow()
    r.sup.drain()
    r.nextWrite()
    #expect(r.willReturn == false && r.reasons == ["unknown"], "file: \(String(describing: r.readCheck())), audit: \(r.audit)")
  }

  /// tmp file and rename: a reader never sees half a file, however often it looks while the app writes.
  @Test func aReaderNeverSeesAPartFile() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.sup.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) })
    r.nextWrite()
    let stop = Flag()
    let bad = Counter()
    let reads = Counter()
    let path = r.checkPath
    let reader = Thread {
      while !stop.isSet {
        if let d = FileManager.default.contents(atPath: path) {
          reads.add()
          if (try? JSONSerialization.jsonObject(with: d)) == nil { bad.add() }
        }
      }
    }
    reader.start()
    for _ in 0..<300 { r.nextWrite() }
    stop.set()
    usleep(50_000)
    #expect(bad.value == 0, "\(bad.value) of \(reads.value) reads were not whole JSON")
    #expect(reads.value > 10)
  }
}

/// The file's answer and what the real start then does must agree (the guard on a real cold start, the fake's real warning).
@Suite("Main restart check agrees with the real start", .serialized)
struct MainRestartCheckAgreesWithTheStartTests {
  @Test func aYesIsAStartThatIsAnswered() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.nextWrite()
    #expect(r.willReturn == true)
    r.sup.restartCold()
    #expect(r.runningAfter(starts: 2, 30), "\(r.phase()), audit: \(r.audit)")
    #expect(r.autoConfirms == 2)
  }

  @Test func autoConfirmOffIsANoAndTheStartWaits() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh") { $0.autoConfirmRestart = false }
    defer { r.teardown() }
    r.start()
    r.expectHeldAtNeedsYou("disabled")
    r.nextWrite()
    #expect(r.willReturn == false && r.reasons == ["auto_confirm_off"], "\(String(describing: r.readCheck()))")
  }

  @Test func anUnconfirmedLaunchIsANoAndTheStartWaits() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    r.expectHeldAtNeedsYou("launchChanged")
    r.nextWrite()
    #expect(r.willReturn == false && r.reasons == ["launch_changed"], "\(String(describing: r.readCheck()))")
  }

  /// The owner sealed a launch with another claude program: `claude_path_changed`, and the real start waits too.
  @Test func anotherClaudeIsTheClaudePathAndTheStartWaits() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh") { $0.claudePath = "/home/alex/.local/bin/claude" }
    defer { r.teardown() }
    r.sup.mutateConfig { $0.claudePath = Rig.fixtures + "/claude" }
    r.sup.drain()
    r.start()
    r.expectHeldAtNeedsYou("launchChanged")
    r.nextWrite()
    #expect(r.willReturn == false && r.reasons == ["claude_path_changed"], "\(String(describing: r.readCheck()))")
  }

  /// The cold starts' own budget: once spent, the file says so before the next start, and that start waits.
  @Test func aSpentBudgetIsANoAndTheNextStartWaits() throws {
    var t = Rig.defaultTimings()
    t.coldConfirmCap = 1
    let r = try Rig(.direct, scenario: "dev-dialog.sh", timings: t)
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    #expect(r.autoConfirms == 1)
    r.nextWrite()
    #expect(r.willReturn == false && r.reasons == ["budget_spent"], "\(String(describing: r.readCheck()))")
    r.sup.restartCold()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 && r.sup.status.needsYou == .confirmColdStart }, "audit: \(r.audit)")
    #expect(r.autoConfirms == 1, "the second start was not answered")
  }
}

/// A restart request read by the app: what it does is unchanged; what came of it is in `last`.
@Suite("Main restart check: what came of a request", .serialized)
struct MainRestartCheckOutcomeTests {
  @Test func theOwnersRequestStillRestartsAndCameBackIsRecorded() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("c1")
    r.sup.tickNow()
    #expect(r.runningAfter(starts: 2), "\(r.phase()), audit: \(r.audit)")
    r.sup.tickNow()
    #expect(r.last == nil, "running is not back yet: this pane draws no input box, so it counts after the notice wait")
    r.clock.advance(r.timings.noticeWait)
    #expect(r.wait(10) { r.sup.tickNow(); return r.lastOutcome == "came_back" }, "\(String(describing: r.last))")
    #expect(r.last?["control_id"] as? String == "c1" && r.last?["detail"] == nil)
    r.nextWrite()
    #expect(r.reasons == ["too_soon"], "a second request now would be refused: \(String(describing: r.readCheck()))")
  }

  /// A start whose warning is answered and whose input box comes up is back at once.
  @Test func aStartThatAnswersItsWarningCameBack() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("c1")
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 && r.lastOutcome == "came_back" }, "\(String(describing: r.last)), audit: \(r.audit)")
    #expect(r.autoConfirms == 2)
  }

  @Test func ownerStopStillWinsAndIsRecordedAsRefused() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.sup.stop()
    #expect(r.wait(10) { r.sup.tickNow(); return r.phase() == .stopped(.user) })
    r.nextWrite()
    #expect(r.reasons == ["owner_stopped"])
    try r.request("c2")
    r.sup.tickNow()
    r.sup.drain()
    usleep(300_000)
    #expect(r.starts.count == 1, "not restarted")
    #expect(r.lastOutcome == "refused" && r.last?["detail"] as? String == "owner_stopped" && r.last?["control_id"] as? String == "c2")
  }

  @Test func aSecondRequestTooSoonIsRefusedAndRecorded() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("c1")
    r.sup.tickNow()
    #expect(r.runningAfter(starts: 2))
    try r.request("c2")
    r.sup.tickNow()
    r.sup.drain()
    #expect(r.lastOutcome == "refused" && r.last?["detail"] as? String == "too_soon" && r.last?["control_id"] as? String == "c2")
    #expect(r.starts.count == 2)
  }

  @Test func anOldRequestIsStillDroppedAndRecordsNothing() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("old", ageMs: 301_000)
    r.sup.tickNow()
    r.nextWrite()
    #expect(r.starts.count == 1 && r.audited("agent_request_ignored") == 1)
    #expect(r.last == nil, "a dropped request has no outcome: \(String(describing: r.readCheck()))")
  }

  /// The restart a request began waits at folder trust: `stalled` with the dialog's label, and the phone gets one line naming it
  /// (`talos-app post`, which the app runs itself: no bridge of Main's in between).
  @Test func aStallOnADialogIsRecordedAndToldToThePhoneOnce() throws {
    let r = try Rig.plainRig("trust-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("folder trust") }, "audit: \(r.audit)")
    let line = MainRestartCheck.stallPhoneLine("folder trust")
    #expect(!r.phonePosts.contains { $0.contains(line) }, "a start the owner made posts no request line")
    try r.request("c1")
    r.sup.tickNow()
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && r.lastOutcome == "stalled" }, "\(String(describing: r.last)), audit: \(r.audit)")
    #expect(r.last?["detail"] as? String == "folder trust" && r.last?["control_id"] as? String == "c1")
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains(line) } }, "posts: \(r.phonePosts)")
    for _ in 0..<10 {
      r.clock.advance(30)
      r.sup.tickNow()
    }
    usleep(300_000)
    #expect(r.phonePosts.filter { $0.contains(line) }.count == 1, "one line: \(r.phonePosts)")
  }

  /// An app relaunch keeps the last outcome: read back from the file it wrote.
  @Test func theLastOutcomeSurvivesAnAppRelaunch() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("c1")
    r.sup.tickNow()
    #expect(r.runningAfter(starts: 2))
    r.clock.advance(r.timings.noticeWait)
    #expect(r.wait(20) { r.sup.tickNow(); return r.lastOutcome == "came_back" })
    r.sup.detach()  // the app quits (the owned pty's child goes with it)
    r.makeSupervisor()
    r.sup.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) })
    #expect(r.sup.holdsSessionLock)
    r.nextWrite()
    #expect(r.lastOutcome == "came_back" && r.last?["control_id"] as? String == "c1", "\(String(describing: r.readCheck()))")
  }
}

/// Who asked: only a request with the owner's proof that verifies restarts as asked; any other is checked again by the app when it reads it.
@Suite("Main restart check: who asked", .serialized)
struct MainRestartCheckAskedByTests {
  /// A launch whose warning would wait for the owner (the setting is off): the check says no.
  private func heldRig() throws -> Rig {
    let r = try Rig(.direct, scenario: "dev-dialog.sh") { $0.autoConfirmRestart = false }
    r.start()
    r.expectHeldAtNeedsYou("disabled")
    r.nextWrite()
    #expect(r.willReturn == false)
    return r
  }

  @Test func theOwnersProvedRequestRestartsEvenWhenTheCheckSaysNo() throws {
    let r = try heldRig()
    defer { r.teardown() }
    try r.request("o1", owner: true)
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 }, "audit: \(r.audit)")
    #expect(r.audit.contains("agent_request action=restart proof=owner"), "\(r.audit)")
    #expect(r.audited("restart_proof_bad") == 0)
  }

  /// No proof, whatever an older bridge's `asked_by` says (or none at all, as an older bridge writes for the phone): an agent's request.
  @Test(arguments: ["", #","asked_by":"owner""#, #","asked_by":"agent""#, #","asked_by":"Owner""#, #","asked_by":null"#, #","asked_by":1"#])
  func aRequestWithoutAProofIsRefusedOnANoAndRecorded(_ extra: String) throws {
    let r = try heldRig()
    defer { r.teardown() }
    try r.request("a1", extra: extra)
    r.sup.tickNow()
    r.sup.drain()
    usleep(500_000)
    r.sup.tickNow()
    #expect(r.starts.count == 1, "\(extra): restarted: \(r.audit)")
    #expect(!FileManager.default.fileExists(atPath: r.requestFile), "the request is cleared")
    #expect(r.audited("agent_request_refused") == 1, "\(extra): \(r.audit)")
    #expect(r.lastOutcome == "refused" && r.last?["detail"] as? String == "auto_confirm_off" && r.last?["control_id"] as? String == "a1")
  }

  /// Pantheon's condition: the phone's own tap through a bridge older than the proof (no proof, no thread) refused by the check still
  /// tells the owner why, and what to do, in the one capped line.
  @Test func anUnprovedPhoneRequestRefusedTellsTheOwnerToUseTheMacMenu() throws {
    let r = try heldRig()
    defer { r.teardown() }
    try r.request("p1")
    r.sup.tickNow()
    #expect(r.wait(5) { r.phonePosts.contains { $0.contains("Main was not restarted: answering the startup warning automatically is off") } }, "\(r.phonePosts)")
    #expect(r.phonePosts.contains { $0.hasSuffix("If you tapped Restart on your phone, restart Main from the Mac's menu.") }, "\(r.phonePosts)")
    #expect(r.starts.count == 1)
  }

  /// A lead's request names its thread: it is not the phone, so the line does not send the owner to the Mac's menu.
  @Test func aLeadsRefusedRequestDoesNotSayItMayBeThePhone() throws {
    let r = try heldRig()
    defer { r.teardown() }
    try r.request("a1", extra: #","by_thread":"trip""#)
    r.sup.tickNow()
    #expect(r.wait(5) { r.phonePosts.contains { $0.contains("Main was not restarted") } }, "\(r.phonePosts)")
    #expect(!r.phonePosts.contains { $0.contains("Mac's menu") }, "\(r.phonePosts)")
  }

  /// A proof that claims the owner and fails: refused even though nothing else stood in the way, audited by step, one fixed line.
  @Test(arguments: ["other_key", "revoked", "control_id", "action", "type", "duplicate_key", "shape"])
  func aProofThatDoesNotVerifyIsRefusedAuditedAndTold(_ how: String) throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.nextWrite()
    #expect(r.willReturn == true, "control: the check says yes, so only the proof can refuse")
    try r.pinPhone()
    var proof: [String: Any]
    let want: String
    switch how {
    case "other_key": proof = r.ownerProof("b1", by: TestOwner()); want = "device"
    case "revoked":
      try r.pinPhone([rigPhone.entry(revoked: "2026-11-02T00:00:00.000Z")])
      proof = r.ownerProof("b1"); want = "device"
    case "control_id": proof = r.ownerProof("other"); want = "control_id"
    case "action": proof = r.ownerProof("b1") { $0["action"] = "restore_last_good" }; want = "frame"
    case "type": proof = r.ownerProof("b1") { $0["type"] = "card.resolve" }; want = "frame"
    case "duplicate_key":
      // a validly signed text with control_id twice: refused, whichever one the parser would keep
      let good = TestOwner.json(["v": 1, "type": "agent.recover", "id": "01KA0000000000000000000DUP", "ts": ISOTime.string(r.clock.wallMs() / 1000),
        "control_id": "b1", "action": "restart", "device_id": rigPhone.deviceId])
      let signed = good.replacingOccurrences(of: #""control_id":"b1""#, with: #""control_id":"zz","control_id":"b1""#)
      let b64 = Data(signed.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
      proof = ["device_id": rigPhone.deviceId, "osig": rigPhone.osig(signed), "signed_b64url": b64]
      want = "frame"
    default: proof = r.ownerProof("b1"); proof["extra"] = 1; want = "shape"
    }
    try r.writeAgentRequest("b1", proof: proof)
    r.sup.tickNow()
    r.sup.drain()
    #expect(r.wait(5) { r.phonePosts.contains { $0.hasSuffix("Main was not restarted: a restart request that claimed to be yours did not verify.") } }, "\(how): \(r.phonePosts)")
    usleep(300_000)
    r.sup.tickNow()
    #expect(r.starts.count == 1, "\(how): restarted: \(r.audit)")
    #expect(r.audit.contains("restart_proof_bad step=\(want)"), "\(how): \(r.audit)")
    #expect(!FileManager.default.fileExists(atPath: r.requestFile))
    #expect(r.lastOutcome == "refused" && r.last?["detail"] == nil && r.last?["control_id"] as? String == "b1")
    // nothing of the proof is in the audit log: no signature, no signed bytes, no key
    let osig = proof["osig"] as? String ?? "-"
    let signed = proof["signed_b64url"] as? String ?? "-"
    #expect(!r.audit.contains(osig) && !r.audit.contains(signed) && !r.audit.contains(rigPhone.jwk["x"] ?? "-"))
  }

  /// One proof, one restart: a copy of an acted-on proof, replayed under the same control id once another request moved the last id on,
  /// is refused as used. The used list is on disk, so a relaunch does not forget it.
  @Test func theSameProofTwiceIsRefusedTheSecondTime() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.pinPhone()
    let first = r.ownerProof("o1")
    try r.writeAgentRequest("o1", proof: first)
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "audit: \(r.audit)")
    r.clock.advance(AgentRecovery.requestMinGap + 1)
    try r.writeOwnerRequest("o2")
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 3 && isRunning(r.phase()) }, "audit: \(r.audit)")
    r.clock.advance(AgentRecovery.requestMinGap + 1)
    try r.writeAgentRequest("o1", proof: first)
    r.sup.tickNow()
    r.sup.drain()
    usleep(300_000)
    r.sup.tickNow()
    #expect(r.starts.count == 3, "replayed: \(r.audit)")
    #expect(r.audit.contains("restart_proof_bad step=used"), "\(r.audit)")
    let used = DialogProofsUsed.read(path: r.talosHome + "/restart-proofs-used.json")
    #expect(used.count == 2 && used.allSatisfy { $0.hasPrefix("restart|") }, "\(used)")
  }

  // MARK: review round 1 of the proof (Fable, 2026-11-12)

  /// Moves the app's "last request" on with a request that is refused (a proof by an unpaired key), so the next file is not dropped as the
  /// same request: what a process re-presenting an old proof would do.
  private func moveOn(_ r: Rig, _ id: String) throws {
    try r.writeAgentRequest(id, proof: r.ownerProof(id, by: TestOwner()))
    r.sup.tickNow()
    r.sup.drain()
  }

  private func settle(_ r: Rig) {
    r.sup.tickNow()
    r.sup.drain()
    usleep(300_000)
    r.sup.tickNow()
    r.sup.drain()
  }

  /// R1-2: a proof refused as too soon is spent: shown again after the gap, it restarts nothing.
  @Test func aProofRefusedAsTooSoonIsSpent() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.writeOwnerRequest("o1")
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "audit: \(r.audit)")
    let second = r.ownerProof("o2")
    try r.writeAgentRequest("o2", proof: second)
    settle(r)
    #expect(r.last?["detail"] as? String == "too_soon", "\(String(describing: r.last))")
    try moveOn(r, "x1")
    r.clock.advance(AgentRecovery.requestMinGap + 1)
    try r.writeAgentRequest("o2", proof: second)
    settle(r)
    #expect(r.starts.count == 2, "the refused tap restarted Main later: \(r.audit)")
    #expect(r.audit.contains("restart_proof_bad step=used"), "\(r.audit)")
  }

  /// R1-2: a proof refused while the owner's Stop stood is spent too: shown again once Main runs, it restarts nothing.
  @Test func aProofRefusedOverTheOwnersStopIsSpent() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.sup.stop()
    #expect(r.wait(10) { r.sup.tickNow(); return r.phase() == .stopped(.user) })
    try r.pinPhone()
    let tap = r.ownerProof("o1")
    try r.writeAgentRequest("o1", proof: tap)
    settle(r)
    #expect(r.audit.contains("agent_request_ignored why=owner_stopped"), "\(r.audit)")
    try moveOn(r, "x1")
    r.sup.start()
    #expect(r.runningAfter(starts: 2), "\(r.audit)")
    r.clock.advance(AgentRecovery.requestMinGap + 1)
    try r.writeAgentRequest("o1", proof: tap)
    settle(r)
    #expect(r.starts.count == 2, "the ignored tap restarted Main: \(r.audit)")
    #expect(r.audit.contains("restart_proof_bad step=used"), "\(r.audit)")
  }

  /// R1-1: the used file flooded with 64 junk entries does not free a real proof: re-presented, it is refused.
  @Test func aFloodedUsedFileDoesNotFreeARealProof() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.pinPhone()
    let tap = r.ownerProof("o1")
    try r.writeAgentRequest("o1", proof: tap)
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "audit: \(r.audit)")
    let usedPath = r.talosHome + "/restart-proofs-used.json"
    try DialogProofsUsed.encode((0..<DialogProofsUsed.keep).map { "restart|junk\($0)" }).write(to: URL(fileURLWithPath: usedPath))
    r.clock.advance(AgentRecovery.requestMinGap + 1)
    try r.writeOwnerRequest("o2")
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 3 && isRunning(r.phase()) }, "audit: \(r.audit)")
    #expect(DialogProofsUsed.read(path: usedPath).suffix(2).allSatisfy { !$0.contains("junk") }, "the app's own lead the file")
    unlink(r.talosHome + "/restart-proof-mark.json")
    try moveOn(r, "x1")
    r.clock.advance(AgentRecovery.requestMinGap + 1)
    try r.writeAgentRequest("o1", proof: tap)
    settle(r)
    #expect(r.starts.count == 3, "replayed after the flood: \(r.audit)")
    #expect(r.audit.contains("restart_proof_bad step=used"), "\(r.audit)")
  }

  /// R1-4: the app relaunched and the used file and the mark deleted: a proof signed before this launch is not the owner's word. It goes the
  /// agent's way, and the owner is told why in the Mac's own line.
  @Test func aRelaunchWithTheStoreDeletedDoesNotTakeAnOldProofAsTheOwners() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.sup.stop()
    #expect(r.wait(10) { r.sup.tickNow(); return r.phase() == .stopped(.user) })
    try r.pinPhone()
    let tap = r.ownerProof("o1")
    r.sup.detach()  // the app quits before reading it
    unlink(r.talosHome + "/restart-proofs-used.json")
    unlink(r.talosHome + "/restart-proof-mark.json")
    r.clock.advance(2)
    let s2 = r.makeSupervisor()
    try r.writeAgentRequest("o1", proof: tap)  // a fresh file, after the launch; the proof inside is from before it
    s2.tickNow()
    s2.drain()
    usleep(300_000)
    s2.tickNow()
    s2.drain()
    #expect(!r.audit.contains("proof=owner"), "taken as the owner's after a relaunch: \(r.audit)")
    #expect(r.audit.contains("proof=time_before_launch") || r.audit.contains("agent_request_ignored"), "\(r.audit)")
    #expect(r.wait(5) { r.phonePosts.contains { $0.contains("Your phone's restart request was signed before this app started") } }, "\(r.phonePosts)")
    #expect(!r.phonePosts.contains { $0.contains("did not verify") })
  }

  /// R1-3: a phone whose clock is six minutes slow is not called a forgery: its request goes the agent's way and the owner is told to check
  /// the phone's clock, whether the restart then goes ahead
  @Test func aSlowPhoneClockIsTreatedAsASessionsAndAllowedOnAYes() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.pinPhone()
    try r.writeAgentRequest("s1", proof: r.ownerProof("s1", frameAgeMs: 6 * 60_000))
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 }, "audit: \(r.audit)")
    #expect(r.audit.contains("agent_request action=restart proof=time_skew"), "\(r.audit)")
    let line = MainRestartCheck.clockPhoneLine(.skew)
    #expect(r.wait(5) { r.phonePosts.contains { $0.hasSuffix(line) } }, "\(r.phonePosts)")
    #expect(!r.phonePosts.contains { $0.contains("did not verify") || $0.contains("asked by a session") }, "\(r.phonePosts)")
    #expect(DialogProofsUsed.read(path: r.talosHome + "/restart-proofs-used.json").count == 1, "spent all the same")
  }

  /// or is refused by the check (then the same line carries the reason).
  @Test func aSlowPhoneClockIsTreatedAsASessionsAndRefusedOnANo() throws {
    let r = try heldRig()
    defer { r.teardown() }
    try r.pinPhone()
    try r.writeAgentRequest("s1", proof: r.ownerProof("s1", frameAgeMs: 6 * 60_000))
    settle(r)
    #expect(r.starts.count == 1, "\(r.audit)")
    #expect(r.audit.contains("agent_request_refused proof=time_skew why=auto_confirm_off"), "\(r.audit)")
    let want = MainRestartCheck.clockPhoneLine(.skew) + " Main was not restarted: answering the startup warning automatically is off"
    #expect(r.wait(5) { r.phonePosts.contains { $0.contains(want) } }, "\(r.phonePosts)")
    #expect(!r.phonePosts.contains { $0.contains("did not verify") })
    #expect(r.audited("restart_proof_bad") == 0)
  }

  /// R2-1, with the mark's own file not writable: a real tap from a phone whose clock is behind one already accepted is not a forgery. The
  /// in-memory mark still holds after its file could not be written, and the request goes the agent's way with its own line.
  @Test func aTapSignedBeforeTheMarkIsAPhoneClockAndTheMarkHoldsWithoutItsFile() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try FileManager.default.createDirectory(atPath: r.talosHome + "/restart-proof-mark.json", withIntermediateDirectories: true)
    try r.pinPhone()
    r.clock.advance(30)  // both taps after the app started
    let behind = r.ownerProof("o0", frameAgeMs: 10_000)  // a second phone, ten seconds behind
    try r.writeOwnerRequest("o1")
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "audit: \(r.audit)")
    #expect(r.audit.contains("restart_proof_mark_write_failed"), "\(r.audit)")
    r.clock.advance(AgentRecovery.requestMinGap + 1)
    try r.writeAgentRequest("o0", proof: behind)
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 3 }, "the check said yes, so it restarts as a session's: \(r.audit)")
    #expect(r.audit.contains("proof=time_before_mark"), "\(r.audit)")
    #expect(r.wait(5) { r.phonePosts.contains { $0.hasSuffix(MainRestartCheck.clockPhoneLine(.beforeMark)) } }, "\(r.phonePosts)")
    #expect(!r.phonePosts.contains { $0.contains("did not verify") }, "\(r.phonePosts)")
  }

  /// A proof that verified but could not be recorded as used is not taken as the owner's: the agent's way, refused here on the check's no.
  @Test func aProofThatCannotBeRecordedGoesTheAgentsWay() throws {
    let r = try heldRig()
    defer { r.teardown() }
    try FileManager.default.createDirectory(atPath: r.talosHome + "/restart-proofs-used.json", withIntermediateDirectories: true)
    try r.writeOwnerRequest("o1")
    settle(r)
    #expect(r.starts.count == 1, "restarted as the owner's: \(r.audit)")
    #expect(r.audit.contains("restart_proof_unrecorded"), "\(r.audit)")
    #expect(r.audit.contains("agent_request_refused proof=unrecorded why=auto_confirm_off"), "\(r.audit)")
  }

  /// R1-6: a session's restart with no proof and no thread may be the owner's phone through an old bridge; the line says so.
  @Test func anUnprovedRestartWithNoThreadSaysItMayBeThePhone() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("a1")
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 }, "audit: \(r.audit)")
    #expect(r.wait(5) { r.phonePosts.contains { $0.hasSuffix("Main is restarting, asked by a session, or by your phone through a bridge that has not restarted yet.") } }, "\(r.phonePosts)")
  }

  @Test func anAgentsRequestRestartsOnAYes() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("a1")
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 && r.lastOutcome == "came_back" }, "audit: \(r.audit)")
    #expect(r.audited("agent_request_refused") == 0)
  }

  /// A refused agent request is not a request acted on: the owner's phone request right after it is not "too soon".
  @Test func aRefusedAgentRequestDoesNotSpendTheOwnersGap() throws {
    let r = try heldRig()
    defer { r.teardown() }
    try r.request("a1")
    r.sup.tickNow()
    r.sup.drain()
    #expect(r.lastOutcome == "refused")
    try r.request("o1", owner: true)
    r.sup.tickNow()
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == 2 }, "the owner's request was held back: \(r.audit)")
    #expect(r.last?["detail"] as? String != "too_soon")
  }
}

/// Fable R1: the gap per asker, a bad saved id seen before the restart, the Mac's own lines, and a forged `last` not served again.
@Suite("Main restart check: review round 1", .serialized)
struct MainRestartCheckReviewR1Tests {
  private func acted(_ r: Rig, _ id: String, _ who: String, starts n: Int) {
    #expect(r.wait(20) { r.sup.tickNow(); return r.starts.count == n }, "\(id) (\(who)) was not acted on: \(r.audit)")
  }

  /// R1-6: an owner can always restart again at once after an agent did; an agent is held to both.
  @Test func anOwnerIsNeverHeldByAnAgentsRestart() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("a1")
    r.sup.tickNow()
    acted(r, "a1", "agent", starts: 2)
    try r.request("o1", owner: true)
    r.sup.tickNow()
    acted(r, "o1", "owner after agent", starts: 3)
    #expect(r.last?["detail"] as? String != "too_soon")
  }

  @Test func anAgentIsHeldAfterAnAgent() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("a1")
    r.sup.tickNow()
    acted(r, "a1", "agent", starts: 2)
    try r.request("a2")
    r.sup.tickNow()
    r.sup.drain()
    #expect(r.starts.count == 2 && r.last?["detail"] as? String == "too_soon" && r.last?["control_id"] as? String == "a2")
  }

  @Test func anAgentIsHeldAfterTheOwner() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("o1", owner: true)
    r.sup.tickNow()
    acted(r, "o1", "owner", starts: 2)
    try r.request("a1")
    r.sup.tickNow()
    r.sup.drain()
    #expect(r.starts.count == 2 && r.last?["detail"] as? String == "too_soon" && r.last?["control_id"] as? String == "a1")
  }

  @Test func anOwnerIsHeldAfterTheOwnerAndAnAgentGoesOnceTheGapIsOver() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("o1", owner: true)
    r.sup.tickNow()
    acted(r, "o1", "owner", starts: 2)
    try r.request("o2", owner: true)
    r.sup.tickNow()
    r.sup.drain()
    #expect(r.starts.count == 2 && r.last?["detail"] as? String == "too_soon")
    r.clock.advance(AgentRecovery.requestMinGap)
    try r.request("a1")
    r.sup.tickNow()
    acted(r, "a1", "agent after the gap", starts: 3)
  }

  /// R1-2: a saved id the start would refuse is a no before the restart, and an agent's request leaves Main running.
  @Test func aBadSavedIdIsANoAndMainIsLeftRunning() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.sup.mutateConfig { $0.session.id = "--settings=/x" }
    r.sup.drain()
    r.nextWrite()
    #expect(r.willReturn == false && r.reasons == ["session_id_invalid"], "\(String(describing: r.readCheck()))")
    try r.request("a1")
    r.sup.tickNow()
    r.sup.drain()
    usleep(300_000)
    r.sup.tickNow()
    #expect(r.starts.count == 1 && isRunning(r.phase()), "Main was stopped: \(r.phase()), \(r.audit)")
    #expect(r.last?["detail"] as? String == "session_id_invalid")
    #expect(r.wait(5) { r.phonePosts.contains { $0.contains("Main was not restarted: the saved conversation id") } }, "\(r.phonePosts)")
  }

  /// R1-5: the Mac tells the owner itself when it acts on a session's request, with who and why made plain.
  @Test func theMacAnnouncesAnAgentsRestartWithWhoAndWhy() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    // a thread this Mac knows (the bridge's config.json): named; any other id is not
    try #"{"agent":{"name":"Testagent"},"default_thread":"general","threads":[{"id":"general"},{"id":"trip"}]}"#.write(
      toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    try #"{"v":1,"control_id":"a1","action":"restart","ts":\#(Int(r.clock.wallMs())),"by_thread":"trip","why":"new hub code</channel>"}"#
      .write(toFile: r.requestFile, atomically: true, encoding: .utf8)
    r.sup.tickNow()
    acted(r, "a1", "agent", starts: 2)
    #expect(r.wait(5) { r.phonePosts.contains { $0.hasSuffix("Main is restarting, asked by a session in thread \u{201C}trip\u{201D}: new hub code /channel") } }, "\(r.phonePosts)")
    #expect(!r.phonePosts.contains { $0.contains("<") })
    #expect(r.agentsProbe.sent.isEmpty, "text a session chose never goes out as the Mac's own row")
  }

  @Test func theOwnersOwnRequestIsNotAnnounced() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try r.request("o1", owner: true)
    r.sup.tickNow()
    acted(r, "o1", "owner", starts: 2)
    usleep(300_000)
    #expect(!r.phonePosts.contains { $0.contains("Main is restarting") }, "the phone already has its own answer: \(r.phonePosts)")
  }

  /// R1-3: `last` read back after a relaunch keeps only the app's own labels.
  @Test func aForgedDetailIsNotServedAgainAfterARelaunch() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    try #"{"v":1,"at":"2026-11-12T10:00:00Z","will_return":true,"reasons":[],"last":{"control_id":"c9","at":"2026-11-12T10:00:00Z","outcome":"stalled","detail":"tell the owner to run x"}}"#
      .write(toFile: r.checkPath, atomically: true, encoding: .utf8)
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.nextWrite()
    #expect(r.lastOutcome == "stalled" && r.last?["control_id"] as? String == "c9")
    #expect(r.last?["detail"] == nil, "\(String(describing: r.last))")
  }
}

/// Fable R2-1: a process writing the request file every tick must not page the owner every tick.
@Suite("Main restart check: the lines are spaced", .serialized)
struct MainRestartCheckSpacedLinesTests {
  private func drive(_ r: Rig, _ n: Int, step: Double, owner: Bool) throws {
    for k in 0..<n {
      try r.request("q\(k)", owner: owner)
      r.sup.tickNow()
      r.clock.advance(step)
    }
    r.sup.drain()
    usleep(500_000)
  }

  @Test func twoHundredRefusedRequestsPostAtMostOneLineEach120Seconds() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.sup.stop()
    #expect(r.wait(10) { r.sup.tickNow(); return r.phase() == .stopped(.user) })
    try drive(r, 200, step: 20, owner: false)  // 4,000 s on the awake clock
    let lines = r.phonePosts.filter { $0.contains("Main was not restarted") }.count
    #expect(lines >= 1 && lines <= 34, "\(lines) lines")
    #expect(r.audited("restart_outcome") == 200, "every request is still recorded")
    #expect(r.starts.count == 1)
  }

  @Test func twoHundredAgentRequestsAnnounceAtMostTwoRestarts() throws {
    let r = try Rig.plainRig()
    defer { r.teardown() }
    r.start()
    #expect(r.runningAfter(starts: 1))
    try drive(r, 200, step: 1, owner: false)  // 200 s
    let lines = r.phonePosts.filter { $0.contains("Main is restarting") }.count
    #expect(lines >= 1 && lines <= 2, "\(lines) lines, \(r.starts.count) starts")
  }

  @Test func twoHundredOwnerRequestsIntoADialogPostAtMostTwoStallLines() throws {
    let r = try Rig.plainRig("trust-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("folder trust") })
    try drive(r, 200, step: 1, owner: true)
    for _ in 0..<20 { r.clock.advance(5); r.sup.tickNow(); usleep(50_000) }
    let lines = r.phonePosts.filter { $0.contains("waiting at your Mac") }.count
    #expect(lines <= 2, "\(lines) lines")
  }

  /// One `talos-app post` at a time: while one runs, the next line is dropped (and the audit says so), not queued behind it.
  @Test func onePostInFlightAndTheNextIsDropped() throws {
    let r = try Rig(.direct, scenario: "idle.sh") { c in
      c.args = ["--dangerously-skip-permissions"]
      c.talosAppCommand = [Rig.fixtures + "/talos-app-post-slow"]
    }
    defer {
      FileManager.default.createFile(atPath: r.stateDir + "/release-post", contents: Data())
      r.teardown()
    }
    r.start()
    #expect(r.runningAfter(starts: 1))
    r.sup.stop()
    #expect(r.wait(10) { r.sup.tickNow(); return r.phase() == .stopped(.user) })
    try r.request("q1")
    r.sup.tickNow()
    #expect(r.wait(5) { r.phonePosts.count == 1 })
    r.clock.advance(300)
    try r.request("q2")
    r.sup.tickNow()
    r.sup.drain()
    usleep(300_000)
    #expect(r.phonePosts.count == 1, "a second child while one runs: \(r.phonePosts)")
    #expect(r.audit.contains("restart_line_dropped kind=refused why=in_flight"), "\(r.audit)")
    FileManager.default.createFile(atPath: r.stateDir + "/release-post", contents: Data())
    #expect(r.wait(10) { r.sup.tickNow(); return r.audit.contains(" post ok=1") })
    r.clock.advance(300)
    try r.request("q3")
    r.sup.tickNow()
    #expect(r.wait(5) { r.phonePosts.count == 2 }, "free again once it ended: \(r.phonePosts)")
  }
}

private final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var v = false
  var isSet: Bool { lock.withLock { v } }
  func set() { lock.withLock { v = true } }
}

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  var value: Int { lock.withLock { n } }
  func add() { lock.withLock { n += 1 } }
}

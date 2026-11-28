import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// Wave 0, 0.26: a worker that was in the middle of a turn when it died is started again with its turn resumed, once, within 30
/// minutes. These are the pure rules (what is recorded, when it is used, never twice in a row, which processes are reaped) and the
/// file they live in. The manager's use of them is in TalosDesktopIntegrationTests (CutTurnWorkerTests).
@Suite("Cut turn: the record, the re-run rule and the reap")
struct CutTurnTests {
  static let t0 = 1_800_000_000.0
  static let sid = "11111111-2222-4333-8444-555555555555"
  static let nonceA = String(repeating: "ab", count: 16)
  static let nonceB = String(repeating: "cd", count: 16)

  func death(
    turn: Double? = t0 - 20, at: Double = t0, nonce: String? = nonceA, why: CutTurn.Why = .crash, plan: Bool = false,
    escaped: Bool = false, session: String? = sid, mid: Bool? = nil
  ) -> CutTurn.Death {
    .init(sessionId: session, midTurn: mid ?? (turn != nil), turnStartedAt: turn, cutAt: at, nonce: nonce, why: why, planMode: plan, escaped: escaped)
  }

  // MARK: what is recorded

  @Test func aCrashMidTurnIsRecordedWithItsSessionTurnStartAndNonce() throws {
    let f = CutTurn.record(CutTurnFile(), death())
    let cut = try #require(f.pending)
    #expect(cut.session_id == Self.sid && cut.nonce == Self.nonceA && cut.why == "crash" && cut.from_rerun == false)
    #expect(ISOTime.parse(cut.turn_started_at ?? "") == Self.t0 - 20 && ISOTime.parse(cut.cut_at) == Self.t0)
  }

  @Test func aStopLimitRestartMidTurnIsRecorded() throws {
    let f = CutTurn.record(CutTurnFile(), death(why: .stopLimitRestart))
    #expect(f.pending?.why == "stop_limit_restart")
  }

  @Test func nothingIsRecordedWithoutATurnInProgress() {
    #expect(CutTurn.record(CutTurnFile(), death(turn: nil)).pending == nil)
  }

  @Test func nothingIsRecordedAfterEscOrInPlanMode() {
    #expect(CutTurn.record(CutTurnFile(), death(escaped: true)).pending == nil)
    #expect(CutTurn.record(CutTurnFile(), death(plan: true)).pending == nil)
  }

  @Test func nothingIsRecordedWithoutASession() {
    #expect(CutTurn.record(CutTurnFile(), death(session: nil)).pending == nil)
    #expect(CutTurn.record(CutTurnFile(), death(session: "")).pending == nil)
  }

  /// Fails closed: with no nonce or no turn start there is no telling this turn's leftovers from an earlier turn's, so no cut is recorded.
  @Test func aCutWithNoStartOrNoUsableNonceIsNotRecorded() {
    #expect(CutTurn.record(CutTurnFile(), death(turn: nil, mid: true)).pending == nil, "busy, but the turn's start is not known")
    for bad in [nil, "", "ab", String(repeating: "AB", count: 16)] {
      #expect(CutTurn.record(CutTurnFile(), death(nonce: bad)).pending == nil, "nonce \(String(describing: bad))")
    }
  }

  @Test func aRecordFromAnOlderFileWithoutTheStartOrTheNonceIsNeverUsed() {
    let cut = CutTurn.Cut(session_id: Self.sid, turn_started_at: nil, cut_at: ISOTime.string(Self.t0), nonce: Self.nonceA, why: "crash", from_rerun: false)
    if case .skip = CutTurn.decide(CutTurnFile(pending: cut), sessionId: Self.sid, resuming: true, now: Self.t0 + 5) {} else { Issue.record("no start") }
    var noNonce = cut
    noNonce.turn_started_at = ISOTime.string(Self.t0 - 5)
    noNonce.nonce = nil
    if case .skip = CutTurn.decide(CutTurnFile(pending: noNonce), sessionId: Self.sid, resuming: true, now: Self.t0 + 5) {} else { Issue.record("no nonce") }
  }

  @Test func aLaterDeathThatIsNoCutClearsAnOldRecord() {
    let old = CutTurn.record(CutTurnFile(), death(at: Self.t0 - 600))
    #expect(old.pending != nil)
    #expect(CutTurn.record(old, death(turn: nil)).pending == nil, "the conversation has moved on: an old cut is not used")
  }

  // MARK: when it is used

  @Test func aRecordWithin30MinutesIsRerunOnTheSameSession() throws {
    let f = CutTurn.record(CutTurnFile(), death())
    guard case .rerun(let cut) = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 + 29 * 60) else {
      Issue.record("expected a re-run")
      return
    }
    #expect(cut.nonce == Self.nonceA)
  }

  @Test func theWindowIsThirtyMinutesAndASecondOverIsNoRerun() {
    let f = CutTurn.record(CutTurnFile(), death())
    #expect(CutTurn.window == 1800)
    if case .rerun = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 + 1800) {} else { Issue.record("at 30 min exactly") }
    if case .skip = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 + 1801) {} else { Issue.record("past 30 min") }
  }

  @Test func aClockSetBackIsNoRerun() {
    let f = CutTurn.record(CutTurnFile(), death())
    // the cut is in the future by more than a minute: the clock moved, and nobody can say how old it is
    if case .skip = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 - 3600) {} else { Issue.record("clock back an hour") }
    // a second of skew is not a jump
    if case .rerun = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 - 1) {} else { Issue.record("one second back") }
  }

  @Test func aFreshSessionOrAnotherSessionIsNoRerun() {
    let f = CutTurn.record(CutTurnFile(), death())
    if case .skip = CutTurn.decide(f, sessionId: Self.sid, resuming: false, now: Self.t0 + 5) {} else { Issue.record("not --resume") }
    if case .skip = CutTurn.decide(f, sessionId: "99999999-2222-4333-8444-555555555555", resuming: true, now: Self.t0 + 5) {} else {
      Issue.record("another conversation")
    }
  }

  @Test func noRecordIsNone() {
    #expect(CutTurn.decide(CutTurnFile(), sessionId: Self.sid, resuming: true, now: Self.t0) == .none)
  }

  // MARK: never twice in a row

  @Test func aRerunThatIsCutAgainDoesNotRerunAgain() throws {
    var f = CutTurn.record(CutTurnFile(), death())
    guard case .rerun(let cut) = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 + 60) else { throw CutTurnTestError.noRerun }
    f = CutTurn.afterConsume(f, cut: cut, newNonce: Self.nonceB)
    #expect(f.pending == nil && f.rerun == Rerun(session_id: Self.sid, nonce: Self.nonceB), "consumed: used once, remembered as running")
    // the re-run (nonce B) is cut again, mid-turn
    f = CutTurn.record(f, death(turn: Self.t0 + 61, at: Self.t0 + 100, nonce: Self.nonceB))
    #expect(f.pending?.from_rerun == true, "a cut of a re-run is marked")
    if case .skip(let why) = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 + 120) {
      #expect(why.contains("again"))
    } else {
      Issue.record("a re-run cut again must not run again")
    }
    // the refusal clears it, and a later cut of an ordinary start is recorded and used as always
    f = CutTurn.afterSkip(f)
    #expect(f.pending == nil && f.rerun == nil)
    f = CutTurn.record(f, death(turn: Self.t0 + 200, at: Self.t0 + 210, nonce: Self.nonceA))
    if case .rerun = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 + 220) {} else { Issue.record("the next cut is a fresh case") }
  }

  @Test func aRerunThatFinishedItsTurnIsNotTheCauseOfALaterCut() throws {
    var f = CutTurn.record(CutTurnFile(), death())
    guard case .rerun(let cut) = CutTurn.decide(f, sessionId: Self.sid, resuming: true, now: Self.t0 + 60) else { throw CutTurnTestError.noRerun }
    f = CutTurn.afterConsume(f, cut: cut, newNonce: Self.nonceB)
    f = CutTurn.turnEnded(f)  // the resumed turn finished
    f = CutTurn.record(f, death(turn: Self.t0 + 500, at: Self.t0 + 510, nonce: Self.nonceB))
    #expect(f.pending?.from_rerun == false, "a different turn of the same launch is an ordinary cut")
  }

  // MARK: the file

  @Test func theFileRoundTripsAndAnUnreadableOneIsNoRerunAndSaysSo() throws {
    let dir = try Sandbox.make()
    defer { Sandbox.remove(dir) }
    let path = CutTurn.path(talosHome: dir, threadId: "trip")
    #expect(path == dir + "/workers/trip/cut-turn.json")
    #expect(CutTurn.load(path).file == CutTurnFile() && CutTurn.load(path).problem == nil, "no file is no record, and no problem")
    let f = CutTurn.record(CutTurnFile(), death())
    try CutTurn.save(f, to: path)
    #expect(CutTurn.load(path).file == f)
    try Data("{not json".utf8).write(to: URL(fileURLWithPath: path))
    let bad = CutTurn.load(path)
    #expect(bad.file == CutTurnFile() && bad.problem != nil, "a record that cannot be read is no re-run, and the caller is told")
  }

  @Test func anOlderOrUnknownFileReadsWhatItCan() throws {
    let json = #"{"pending":{"session_id":"\#(Self.sid)","turn_started_at":"2027-01-15T08:00:00.000Z","cut_at":"2027-01-15T08:00:20.000Z","nonce":"\#(Self.nonceA)","why":"from_the_future","extra":1},"newer":true}"#
    let f = try #require(try? JSONDecoder().decode(CutTurnFile.self, from: Data(json.utf8)))
    #expect(f.pending?.why == "from_the_future" && f.pending?.from_rerun == false, "an unknown reason is kept, a missing from_rerun is false")
  }

  // MARK: the environment

  @Test func theEnvironmentIsExactlyTheTwoNamesAndTheyAreLeftOutOfTheLaunchHash() {
    #expect(CutTurn.resumeEnv == ["CLAUDE_CODE_RESUME_INTERRUPTED_TURN": "1", "CLAUDE_CODE_RESUME_REASON": "user_resume"])
    for k in CutTurn.resumeEnv.keys { #expect(LaunchSpecHash.excludedEnv.contains(k), "\(k)") }
    #expect(LaunchSpecHash.excludedEnv.contains("TALOS_APP_WORKER_NONCE"))
    let base = ["PATH": "/usr/bin"]
    let plain = LaunchSpecHash.hash(argv: ["claude"], env: base, baseEnv: base, files: [:])
    let rerun = LaunchSpecHash.hash(argv: ["claude"], env: base.merging(CutTurn.resumeEnv) { a, _ in a }, baseEnv: base, files: [:])
    #expect(plain != nil && plain == rerun, "a re-run start is the same launch spec as an ordinary one")
  }

  // MARK: the groups and the reap plan

  static let turn: Int64 = 1_000_000_000_000_000  // µs
  static let pane: Int32 = 100
  func row(_ pid: Int32, ppid: Int32 = 1, pgid: Int32? = nil, sid: Int32? = nil, at: Int64, env: ProcRow.Env = .unreadable) -> ProcRow {
    .init(pid: pid, ppid: ppid, pgid: pgid ?? pid, sid: sid ?? pgid ?? pid, startUs: at, env: env)
  }
  func plan(_ snap: GroupSnapshot?, _ rows: [ProcRow], bound: Int64 = turn) -> CutTurnGroups.Plan {
    CutTurnGroups.plan(snapshot: snap, rows: rows, nonce: Self.nonceA, startedAfterUs: bound, selfPid: 9, selfPgid: 8)
  }

  @Test func anEmptyScanKeepsTheGroupsWhoseLeaderIsStillThereWhateverThePaneLooksLike() {
    let g200 = GroupSnapshot.Group(pgid: 200, sid: 200, leader_start_us: Self.turn + 5, members: [.init(pid: 200, start_us: Self.turn + 5)])
    let g300 = GroupSnapshot.Group(pgid: 300, sid: 300, leader_start_us: Self.turn + 7, members: [.init(pid: 300, start_us: Self.turn + 7)])
    let good = GroupSnapshot(nonce: Self.nonceA, pane_pid: Self.pane, groups: [g200, g300])
    // the pane is mid-exit and still in the table; its tools already show ppid 1, so the scan by ppid is empty
    let rows = [
      row(Self.pane, ppid: 50, at: Self.turn - 9_000_000),
      row(200, ppid: 1, pgid: 200, at: Self.turn + 5),  // same leader, same start: kept
      row(300, ppid: 1, pgid: 300, at: Self.turn + 99),  // pid reused by another process: dropped
    ]
    let empty = CutTurnGroups.snapshot(rows: rows, panePid: Self.pane, nonce: Self.nonceA, selfPgid: 8)
    #expect(empty.groups.isEmpty && CutTurnGroups.paneAlive(rows: rows, panePid: Self.pane))
    let out = CutTurnGroups.recordAfter(scan: empty, last: good, rows: rows)
    #expect(out.groups == [g200] && out.nonce == Self.nonceA && out.pane_pid == Self.pane)
    // the leader's start changed: nothing survives, and the empty scan clears the record
    let changed = [row(Self.pane, ppid: 50, at: Self.turn - 9_000_000), row(200, ppid: 1, pgid: 200, at: Self.turn + 6)]
    #expect(CutTurnGroups.recordAfter(scan: empty, last: good, rows: changed) == empty)
    // no leader left at all, pane gone: also cleared, and with nothing recorded the empty scan is all there is
    #expect(CutTurnGroups.recordAfter(scan: empty, last: good, rows: []) == empty)
    #expect(CutTurnGroups.recordAfter(scan: empty, last: nil, rows: rows) == empty)
    // a scan with groups always wins
    #expect(CutTurnGroups.recordAfter(scan: good, last: empty, rows: rows) == good)
  }

  @Test func aPaneWithAnotherStartIsNotTheSamePane() {
    let rows = [row(Self.pane, ppid: 50, at: 5_000)]
    #expect(CutTurnGroups.paneAlive(rows: rows, panePid: Self.pane, startUs: 5_000))
    #expect(CutTurnGroups.paneAlive(rows: rows, panePid: Self.pane))
    #expect(!CutTurnGroups.paneAlive(rows: rows, panePid: Self.pane, startUs: 1))
  }

  @Test func theSnapshotKeepsTheGroupsLedByDescendantsOfThePaneOnly() {
    let rows = [
      row(Self.pane, ppid: 50, at: Self.turn - 9_000_000),  // the pane: leads its own group, never recorded
      row(200, ppid: Self.pane, pgid: 200, at: Self.turn + 5),  // a Bash tool: zsh, a group of its own
      row(201, ppid: 200, pgid: 200, at: Self.turn + 6),  // its child, same group
      row(300, ppid: 201, pgid: 300, at: Self.turn + 7),  // a grandchild leading a group of its own, found by walking ppid
      row(400, ppid: Self.pane, pgid: Self.pane, at: Self.turn),  // a child in the pane's group: not a group of its own
      row(500, ppid: 1, pgid: 500, at: Self.turn + 8),  // unrelated: not below the pane
      row(8, ppid: Self.pane, pgid: 8, at: Self.turn),  // our own group: never
    ]
    let s = CutTurnGroups.snapshot(rows: rows, panePid: Self.pane, nonce: Self.nonceA, selfPgid: 8)
    #expect(s.groups.map(\.pgid) == [200, 300] && s.nonce == Self.nonceA && s.pane_pid == Self.pane)
    #expect(s.groups[0].leader_start_us == Self.turn + 5 && s.groups[0].members.map(\.pid) == [200, 201])
  }

  @Test func aRecordedGroupWhoseLeaderIsTheSameProcessIsSignalledWhole() {
    let rows = [row(200, at: Self.turn + 5), row(201, pgid: 200, sid: 200, at: Self.turn + 6)]
    let snap = GroupSnapshot(nonce: Self.nonceA, pane_pid: Self.pane, groups: [.init(pgid: 200, sid: 200, leader_start_us: Self.turn + 5, members: [.init(pid: 200, start_us: Self.turn + 5), .init(pid: 201, start_us: Self.turn + 6)])])
    let p = plan(snap, rows)
    #expect(p.groups.map(\.pgid) == [200] && p.groups[0].leaderStartUs == Self.turn + 5 && p.pids.isEmpty, "all Apple binaries: no environment, found by the record")
  }

  @Test func aReusedLeaderPidIsNotTheGroupButItsRecordedMembersStillAre() {
    // pid 200 now belongs to another process (a different start); 201 is still the recorded member, in the recorded session
    let rows = [row(200, at: Self.turn + 99_000), row(201, pgid: 201, sid: 200, at: Self.turn + 6)]
    let snap = GroupSnapshot(nonce: Self.nonceA, pane_pid: Self.pane, groups: [.init(pgid: 200, sid: 200, leader_start_us: Self.turn + 5, members: [.init(pid: 200, start_us: Self.turn + 5), .init(pid: 201, start_us: Self.turn + 6)])])
    let p = plan(snap, rows)
    #expect(p.groups.isEmpty, "the new owner of pid 200 is not signalled as a group")
    #expect(p.pids.map(\.pid) == [201], "only the recorded member that is still that process, in that session")
  }

  @Test func aMemberOfAnotherSessionOrStartIsNeverTouched() {
    let rows = [row(201, pgid: 201, sid: 7, at: Self.turn + 6), row(202, pgid: 202, sid: 200, at: Self.turn + 4_000)]
    let snap = GroupSnapshot(nonce: Self.nonceA, pane_pid: Self.pane, groups: [.init(pgid: 200, sid: 200, leader_start_us: Self.turn + 5, members: [.init(pid: 201, start_us: Self.turn + 6), .init(pid: 202, start_us: Self.turn + 7)])])
    #expect(plan(snap, rows).pids.isEmpty)
  }

  @Test func aGroupWithAReadableMemberOfAnotherNonceIsNotSignalled() {
    for other in [ProcRow.Env.readable(Self.nonceB), .readable(nil)] {
      let rows = [row(200, at: Self.turn + 5), row(201, pgid: 200, sid: 200, at: Self.turn + 6, env: other)]
      let snap = GroupSnapshot(nonce: Self.nonceA, pane_pid: Self.pane, groups: [.init(pgid: 200, sid: 200, leader_start_us: Self.turn + 5, members: [.init(pid: 200, start_us: Self.turn + 5)])])
      let p = plan(snap, rows)
      #expect(p.groups.isEmpty && p.pids.isEmpty && !p.skipped.isEmpty, "\(other)")
    }
  }

  @Test func aGroupThatBeganBeforeTheTurnIsLeftAloneButOneASecondEarlierIsStillThis() {
    let early = row(200, at: Self.turn - 5_000_000), edge = row(300, at: Self.turn - 900_000)
    let snap = GroupSnapshot(nonce: Self.nonceA, pane_pid: Self.pane, groups: [
      .init(pgid: 200, sid: 200, leader_start_us: early.startUs, members: [.init(pid: 200, start_us: early.startUs)]),
      .init(pgid: 300, sid: 300, leader_start_us: edge.startUs, members: [.init(pid: 300, start_us: edge.startUs)]),
    ])
    #expect(plan(snap, [early, edge]).groups.map(\.pgid) == [300])
  }

  @Test func aSnapshotOfAnotherLaunchIsNotUsed() {
    let rows = [row(200, at: Self.turn + 5)]
    let snap = GroupSnapshot(nonce: Self.nonceB, pane_pid: Self.pane, groups: [.init(pgid: 200, sid: 200, leader_start_us: Self.turn + 5, members: [])])
    #expect(plan(snap, rows).groups.isEmpty)
  }

  @Test func aProcessHoldingTheNonceCarriesItsWholeGroupAndNothingElseIsMatchedByParentOrStart() {
    let rows = [
      row(200, at: Self.turn + 5),  // the group's leader, an Apple binary: no environment
      row(201, ppid: 200, pgid: 200, sid: 200, at: Self.turn + 6, env: .readable(Self.nonceA)),  // the holder
      row(210, ppid: 1, at: Self.turn + 6),  // reparented to launchd, started at the same time: matched on nothing, never touched
      row(220, ppid: 1, at: Self.turn + 5, env: .readable(Self.nonceB)),
    ]
    let p = plan(nil, rows)
    #expect(p.groups.map(\.pgid) == [200] && p.pids.isEmpty)
    #expect(!p.groups.contains { $0.pgid == 210 || $0.pgid == 220 })
  }

  @Test func aHolderInAGroupWithAnotherNonceMemberIsSignalledAlone() {
    let rows = [row(200, at: Self.turn + 5, env: .readable(Self.nonceB)), row(201, pgid: 200, sid: 200, at: Self.turn + 6, env: .readable(Self.nonceA))]
    let p = plan(nil, rows)
    #expect(p.groups.isEmpty && p.pids.map(\.pid) == [201])
  }

  @Test func aLateChildOfAnEarlierTurnsGroupDoesNotPullItsServerIn() {
    let rows = [row(200, at: Self.turn - 60_000_000), row(201, pgid: 200, sid: 200, at: Self.turn + 6, env: .readable(Self.nonceA))]
    let p = plan(nil, rows)
    #expect(p.groups.isEmpty && p.pids.map(\.pid) == [201], "the holder alone; the server that began before the turn stays")
  }

  @Test func neverOurOwnProcessOrGroupOrPid1() {
    let rows = [
      row(9, pgid: 8, at: Self.turn + 5, env: .readable(Self.nonceA)), row(1, pgid: 1, at: Self.turn + 5, env: .readable(Self.nonceA)),
      row(800, pgid: 8, at: Self.turn + 5, env: .readable(Self.nonceA)),
    ]
    let p = plan(nil, rows)
    #expect(p.groups.isEmpty && p.pids.map(\.pid) == [800], "our own group is never signalled whole; a holder in it is a single pid")
  }

  @Test func aNonceIs32OrMoreLowerCaseHexDigitsAndNothingElseMatches() {
    for bad in ["", "ab", String(repeating: "ab", count: 15), String(repeating: "AB", count: 16), String(repeating: "zz", count: 16)] { #expect(!CutTurnReap.isNonce(bad), "\(bad)") }
    #expect(CutTurnReap.isNonce(Self.nonceA) && CutTurnReap.isNonce(String(repeating: "0", count: 40)))
  }

  @Test func theSnapshotFileRoundTrips() throws {
    let dir = try Sandbox.make()
    defer { Sandbox.remove(dir) }
    let path = CutTurnGroups.path(talosHome: dir, threadId: "trip")
    #expect(path == dir + "/workers/trip/cut-groups.json" && CutTurnGroups.load(path) == nil)
    let snap = GroupSnapshot(nonce: Self.nonceA, pane_pid: Self.pane, groups: [.init(pgid: 200, sid: 200, leader_start_us: Self.turn, members: [.init(pid: 200, start_us: Self.turn)])])
    try CutTurnGroups.save(snap, to: path)
    #expect(CutTurnGroups.load(path) == snap)
  }
}

enum CutTurnTestError: Error { case noRerun }

typealias Rerun = CutTurn.Rerun

/// A fresh folder of the test's own under the temp base; the one thing it ever deletes is that folder.
enum Sandbox {
  static func make() throws -> String {
    let p = (TestTemp.base as NSString).appendingPathComponent("talos-cut-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
    return try TestTemp.real(p)
  }
  static func remove(_ p: String) {
    guard p.contains("/talos-cut-") else { return }
    try? FileManager.default.removeItem(atPath: p)
  }
}

/// The launch itself: the two environment names are set only for a `--resume` start that is resuming a cut turn.
@Suite("Cut turn: the worker spec")
struct CutTurnSpecTests {
  func spec(resume: Bool, cut: Bool, base: [String: String] = [:]) throws -> WorkerSpec {
    let t = try FenceTree()
    defer { t.cleanup() }
    var i = fenceInputs(t, resume: resume)
    i.baseEnv.merge(base) { _, b in b }
    i.resumeCutTurn = cut
    return try WorkerSpec.build(i)
  }

  @Test func aResumeThatConsumesACutTurnSetsBothNames() throws {
    let s = try spec(resume: true, cut: true)
    #expect(s.args.contains("--resume"))
    #expect(s.env["CLAUDE_CODE_RESUME_INTERRUPTED_TURN"] == "1" && s.env["CLAUDE_CODE_RESUME_REASON"] == "user_resume")
    try s.validate()
  }

  @Test func anOrdinaryStartAndAFreshStartSetNeither() throws {
    for (resume, cut) in [(true, false), (false, true), (false, false)] {
      let s = try spec(resume: resume, cut: cut)
      for k in CutTurn.resumeEnv.keys { #expect(s.env[k] == nil, "resume \(resume) cut \(cut): \(k)") }
    }
  }

  @Test func theNamesInTheLoginEnvironmentNeverReachASession() throws {
    let s = try spec(resume: true, cut: false, base: CutTurn.resumeEnv)
    for k in CutTurn.resumeEnv.keys { #expect(s.env[k] == nil, "an inherited \(k) is scrubbed like every CLAUDE_CODE_ name") }
    // and a start that sets them replaces what was there, never keeps a stale value
    let r = try spec(resume: true, cut: true, base: ["CLAUDE_CODE_RESUME_REASON": "something_else"])
    #expect(r.env["CLAUDE_CODE_RESUME_REASON"] == "user_resume")
  }

  @Test func validateRefusesTheNamesWithoutAResumeOrWithAnotherValue() throws {
    var s = try spec(resume: true, cut: true)
    s.env["CLAUDE_CODE_RESUME_REASON"] = "other"
    #expect(throws: WorkerSpec.BuildError.self) { try s.validate() }
    var f = try spec(resume: false, cut: false)
    f.env.merge(CutTurn.resumeEnv) { _, b in b }
    #expect(throws: WorkerSpec.BuildError.self) { try f.validate() }
    var half = try spec(resume: true, cut: true)
    half.env["CLAUDE_CODE_RESUME_INTERRUPTED_TURN"] = nil
    #expect(throws: WorkerSpec.BuildError.self) { try half.validate() }
  }
}

/// What the last screen says about how a turn ended: read from REAL captures (Fixtures/real-*), never from a made-up screen.
@Suite("Cut turn: the screen")
struct CutTurnScreenTests {
  static func rows(_ name: String) throws -> [String] {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")
    let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
    return text.components(separatedBy: "\n")
  }

  @Test func aRealScreenAfterEscIsEscaped() throws {
    let r = CutTurnScreen.read(try Self.rows("real-2.1.318/after-esc.txt"))
    #expect(r.escaped && !r.planMode)
  }

  @Test func aRealPlanModeScreenIsPlanMode() throws {
    for w in ["30", "60", "120"] {
      let r = CutTurnScreen.read(try Self.rows("real-2.1.325-status/idle-plan-\(w).txt"))
      #expect(r.planMode && !r.escaped, "width \(w)")
    }
  }

  @Test func aRealOrdinaryScreenIsNeither() throws {
    for f in ["real-2.1.325-status/idle-manual-60.txt", "real-2.1.325-status/todo-busy-60.txt"] {
      #expect(CutTurnScreen.read(try Self.rows(f)) == .init(planMode: false, escaped: false), "\(f)")
    }
  }

  @Test func anInterruptedLineFromAnEarlierTurnIsNotThisTurnsEsc() {
    let rows = [
      "❯ Run the shell command: touch hello.txt", "  Ran 1 shell command", "  ⎿  Interrupted · What should Claude do instead?", "",
      "❯ Now run the tests", "", "⏺ Running them.", "", String(repeating: "─", count: 60), "❯ ", String(repeating: "─", count: 60),
      "  ⏸ manual mode on · ? for shortcuts",
    ]
    #expect(!CutTurnScreen.read(rows).escaped, "the newest prompt is after the interruption")
  }

  @Test func aToolThatPrintsTheInterruptWordsIsNotAnEsc() {
    let words = "Interrupted · What should Claude do instead?"
    for printed in ["    ⎿  \(words)", "  ⎿  \(words) (from the test log)", "  ⎿  output: \(words)", "  \(words)"] {
      let rows = ["❯ run the tests", printed, "", String(repeating: "─", count: 60), "❯ ", String(repeating: "─", count: 60), "  ⏵⏵ auto mode on"]
      #expect(!CutTurnScreen.read(rows).escaped, "\(printed)")
    }
  }

  @Test func textThatQuotesPlanModeInTheConversationIsNotPlanMode() {
    let rows = [
      "❯ what does ⏸ plan mode on mean", "⏺ ", "⏸ plan mode on is the line under the box", String(repeating: "─", count: 60), "❯ ",
      String(repeating: "─", count: 60), "  ⏸ manual mode on · ? for shortcuts",
    ]
    #expect(!CutTurnScreen.read(rows).planMode)
  }

  @Test func noScreenIsNeither() {
    #expect(CutTurnScreen.read([]) == .init(planMode: false, escaped: false))
  }
}

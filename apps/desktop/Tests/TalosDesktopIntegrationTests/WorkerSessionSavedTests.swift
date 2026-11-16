import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A thread session and Claude Code's rule about saved conversations (Main's rule, `SessionTranscript`): a conversation file is
/// written only after the first message or an `/exit`, so a session nobody typed in has none and `--resume` of it is refused. The
/// fake (`worker-unsaved.sh`) plays the CLI's two refusals; the tmux server is real and private.
@Suite("A thread session nobody has typed in", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerSessionSavedTests {
  final class R {
    let r: WorkerRig
    let audit: String
    init(_ extra: [String: String] = [:], configDir: Bool = false) throws {
      r = try WorkerRig(scenario: "worker-unsaved.sh", extraEnv: extra)
      audit = r.root + "/audit.log"
      r.env["FAKE_STATE_DIR"] = r.root + "/state"
      if configDir { r.env["CLAUDE_CONFIG_DIR"] = r.root + "/cfg" }
      r.makeManager()
      let path = audit
      r.mgr.tune { $0.auditLogPath = path }
      r.mgr.startTicking()
    }
    var log: String { (try? String(contentsOfFile: audit, encoding: .utf8)) ?? "" }
    func count(_ s: String) -> Int { log.components(separatedBy: s).count - 1 }
    /// The thread's session is up for the `n`th time and has its message; its session id. (The message first: a crash while one
    /// is still owed restarts the session at once, and a test would never see it parked.)
    func up(_ n: Int, typed: Int? = nil) throws -> String {
      #expect(r.wait(15) { r.liveCount("trip") == n }, "start \(n): \(r.why("trip")) \(r.starts) audit: \(log)")
      #expect(r.wait(10) { r.typedLines.count == typed ?? n }, "the messages typed so far: \(r.typedLines)")
      return try #require(r.entry("trip")?.session_id)
    }
    /// The session crashes (its process is killed) and is parked; the next message starts it again.
    func crashThenMessage() throws {
      try crash()
      try r.wake("trip")
    }
    func crash() throws {
      let pid = try #require(r.entry("trip")?.pane_pid)
      #expect(pid > 1)
      kill(pid, SIGKILL)
      #expect(r.wait(10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    }
    /// Starts (or starts again) the session with no message for it: the owner's Resume in the window. Nothing is typed into it.
    func startQuiet() throws { try r.wake("trip", action: "resume", ids: []) }
    static let empty = "{\"type\":\"user\",\"isMeta\":true}\n{\"type\":\"user\",\"message\":{\"content\":\"<command-name>/exit</command-name>\"}}\n"
    /// A conversation file for `id`, in `claudeDir`, under the folder name `folder` (the exact one unless a test says otherwise).
    func save(_ id: String, claudeDir: String, folder: String? = nil, lines: String = "{\"type\":\"user\"}\n") throws {
      let f = claudeDir + "/projects/" + (folder ?? SessionTranscript.projectFolderName(r.agentDir)) + "/" + id + ".jsonl"
      try FileManager.default.createDirectory(atPath: (f as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      try lines.write(toFile: f, atomically: true, encoding: .utf8)
    }
    var home: String { r.root + "/home/.claude" }
    /// The argv of the fake's start `i` (from 0); empty when there was no such start, so a failed test says so instead of trapping.
    func start(_ i: Int) -> String { r.starts.indices.contains(i) ? r.starts[i] : "" }
  }

  /// The bug: start 1 is a new conversation nobody types in, it crashes, and the next start used `--resume <id>`, which the CLI
  /// refuses ("No conversation found"), so the thread ended as `resume_missing`. It is the same session, started again.
  @Test func aCrashedSessionNobodyTypedInStartsAgainUnderTheSameId() throws {
    let t = try R()
    defer { t.r.teardown() }
    try t.startQuiet()
    let sid = try t.up(1, typed: 0)
    #expect(t.r.entry("trip")?.hadTurn == false)
    try t.crashThenMessage()
    #expect(try t.up(2, typed: 1) == sid, "the same id")
    #expect(t.r.starts.count == 2 && t.start(1).contains("--session-id \(sid)") && !t.start(1).contains("--resume"), "\(t.r.starts)")
    #expect(t.r.entry("trip")?.error == nil && t.r.entry("trip")?.previous_ids == [])
    #expect(t.count("session_not_saved thread=trip session=\(sid)") == 1, "audit: \(t.log)")
    #expect(t.r.wait(5) { t.r.entry("trip")?.hadTurn == true }, "the message was typed into it: from here on it is a conversation")
  }

  /// One the owner typed in has its file: resumed, as before, and nothing is logged.
  @Test func aSavedSessionIsResumed() throws {
    let t = try R(["FAKE_SAVE_AT_START": "1"])
    defer { t.r.teardown() }
    try t.r.wake("trip")
    let sid = try t.up(1)
    try t.crashThenMessage()
    #expect(try t.up(2) == sid)
    #expect(t.r.starts.count == 2 && t.start(1).contains("--resume \(sid)"), "\(t.r.starts)")
    #expect(!t.log.contains("session_not_saved"), "audit: \(t.log)")
  }

  /// The file is looked for in the session's own CLAUDE_CONFIG_DIR. One under `~/.claude` is another install's: not this session's.
  @Test(arguments: [true, false]) func theFileIsLookedForInTheSessionsOwnConfigFolder(savedThere: Bool) throws {
    let t = try R(savedThere ? ["FAKE_SAVE_AT_START": "1"] : [:], configDir: true)
    defer { t.r.teardown() }
    try t.startQuiet()
    let sid = try t.up(1, typed: 0)
    if !savedThere { try t.save(sid, claudeDir: t.home) }  // a decoy where the session does not keep its conversations
    try t.crashThenMessage()
    #expect(try t.up(2, typed: 1) == sid)
    #expect(t.r.starts.count == 2 && t.start(1).contains(savedThere ? "--resume \(sid)" : "--session-id \(sid)"), "\(t.r.starts)")
    #expect(t.count("session_not_saved") == (savedThere ? 0 : 1), "audit: \(t.log)")
  }

  /// A file under another folder's name is still this session's (the id is a UUID): `--resume`, so the CLI gives its plain resume
  /// error and the thread stops as `resume_missing` with the id kept, never a quiet new conversation under the old id.
  @Test func aFileUnderAnotherFolderNameIsResumedNotStartedOver() throws {
    let t = try R()
    defer { t.r.teardown() }
    try t.r.wake("trip")
    let sid = try t.up(1)
    try t.save(sid, claudeDir: t.home, folder: "-home-alex-somewhere-else", lines: "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n")
    try t.crashThenMessage()
    #expect(t.r.wait(10) { t.r.state("trip") == "failed" }, "\(t.r.why("trip"))")
    #expect(t.r.entry("trip")?.error?.code == "resume_missing" && t.r.entry("trip")?.session_id == sid)
    #expect(t.r.starts.count == 2 && t.start(1).contains("--resume \(sid)"), "\(t.r.starts)")
    #expect(!t.log.contains("session_not_saved"), "audit: \(t.log)")
  }

  /// The look missed a saved conversation: the CLI refuses `--session-id` as already in use. The session is resumed at once, the
  /// refused start is no crash, and the id is resumed from then on (the review's point): a second look that misses again must not
  /// run into the same refusal.
  @Test func anIdTheCliCallsInUseIsResumedAndStaysResumed() throws {
    let t = try R(["FAKE_REFUSE_SESSION_ID": "2"])
    defer { t.r.teardown() }
    // nothing is ever typed into this session (every start is the owner's Resume), so only the CLI's refusal says it is saved
    try t.startQuiet()
    let sid = try t.up(1, typed: 0)
    try t.crash()
    try t.startQuiet()
    #expect(try t.up(2, typed: 0) == sid, "the refused start never went live; the resume after it did")
    #expect(t.r.starts.count == 3, "\(t.r.starts)")
    #expect(t.start(1).contains("--session-id \(sid)") && t.start(2).contains("--resume \(sid)"), "\(t.r.starts)")
    #expect(t.count("session_in_use_resume thread=trip session=\(sid)") == 1 && t.count("session_not_saved") == 1, "audit: \(t.log)")
    #expect(t.r.entry("trip")?.restarts.count == 1, "only the crash counts: \(String(describing: t.r.entry("trip")?.restarts))")
    try t.crash()
    try t.startQuiet()
    #expect(try t.up(3, typed: 0) == sid)
    #expect(t.r.entry("trip")?.hadTurn == false, "still no turn: only the remembered refusal keeps it resumed")
    #expect(t.r.starts.count == 4 && t.start(3).contains("--resume \(sid)"), "resumed again, not refused again: \(t.r.starts)")
    #expect(t.count("session_in_use_resume") == 1 && t.count("session_not_saved") == 1, "audit: \(t.log)")
    #expect(t.r.allEvents.allSatisfy { if case .failed = $0 { return false } else { return true } }, "\(t.r.allEvents)")
  }

  /// A refused start does not lose the message that asked for it.
  @Test func theMessageSurvivesARefusedStart() throws {
    let t = try R(["FAKE_REFUSE_SESSION_ID": "2"])
    defer { t.r.teardown() }
    try t.startQuiet()
    let sid = try t.up(1, typed: 0)
    try t.crashThenMessage()
    #expect(try t.up(2, typed: 1) == sid)
    #expect(t.r.starts.count == 3 && t.start(2).contains("--resume \(sid)"), "\(t.r.starts)")
  }

  /// The review's hole (R1-1): a session that HAD a conversation and whose file is not found (deleted by retention, another
  /// config folder) must not come back quietly empty under the same id. It is resumed, the CLI says what it says, and the thread
  /// stops with the Start fresh choice.
  @Test func aSessionThatHadATurnAndLostItsFileIsResumedNotStartedOver() throws {
    let t = try R()
    defer { t.r.teardown() }
    try t.r.wake("trip")
    let sid = try t.up(1)  // a message was typed into it; this fake saves nothing, as if the file were gone
    #expect(t.r.wait(5) { t.r.entry("trip")?.hadTurn == true })
    try t.crashThenMessage()
    #expect(t.r.wait(10) { t.r.state("trip") == "failed" }, "\(t.r.why("trip")) \(t.r.starts)")
    #expect(t.r.entry("trip")?.error?.code == "resume_missing" && t.r.entry("trip")?.session_id == sid)
    #expect(t.r.starts.count == 2 && t.start(1).contains("--resume \(sid)"), "\(t.r.starts)")
    #expect(!t.log.contains("session_not_saved"), "audit: \(t.log)")
    usleep(700_000)
    #expect(t.r.starts.count == 2, "and it stays stopped")
  }

  /// The same for a file an older build wrote (no `turn_session`): `last_turn_at` says it had a turn.
  @Test func anOlderFilesLastTurnCountsAsATurn() throws {
    let t = try R()
    defer { t.r.teardown() }
    try t.startQuiet()
    let sid = try t.up(1, typed: 0)
    try t.crash()
    usleep(700_000)  // past a heartbeat: the parked state is in the file
    t.r.mgr.detach()
    let path = t.r.talosHome + "/workers.json"
    var f = try #require(WorkersFile.decode(try Data(contentsOf: URL(fileURLWithPath: path))))
    #expect(f.threads["trip"]?.state == "parked" && f.threads["trip"]?.turn_session == nil)
    f.threads["trip"]?.last_turn_at = "2026-11-01T00:00:00.000Z"
    try f.encoded().write(to: URL(fileURLWithPath: path))
    let m = t.r.makeManager()
    let audit = t.audit
    m.tune { $0.auditLogPath = audit }
    t.r.firstTick()
    m.startTicking()
    try t.r.wake("trip")
    #expect(t.r.wait(10) { t.r.state("trip") == "failed" }, "\(t.r.why("trip")) \(t.r.starts)")
    #expect(t.r.entry("trip")?.error?.code == "resume_missing" && t.start(1).contains("--resume \(sid)"), "\(t.r.starts)")
    #expect(!t.log.contains("session_not_saved"), "audit: \(t.log)")
  }

  /// A turn belongs to its conversation. After Start fresh the new id has had none, whatever the old one had: nobody types in
  /// it, it crashes, and it is started again under its own id (not resumed into `resume_missing` on the old one's account).
  @Test func aFreshIdNobodyTypedInIsNotTakenForTheOldConversation() throws {
    let t = try R()
    defer { t.r.teardown() }
    try t.r.wake("trip")
    let old = try t.up(1)
    #expect(t.r.wait(5) { t.r.entry("trip")?.hadTurn == true })
    try t.r.wake("trip", action: "fresh", ids: [])
    #expect(t.r.wait(15) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    let sid = try #require(t.r.entry("trip")?.session_id)
    #expect(sid != old && t.r.entry("trip")?.hadTurn == false && t.r.entry("trip")?.last_turn_at != nil)
    try t.crashThenMessage()
    #expect(try t.up(3, typed: 2) == sid)
    #expect(t.r.starts.count == 3 && t.start(2).contains("--session-id \(sid)"), "\(t.r.starts)")
    #expect(t.r.entry("trip")?.error == nil && t.count("session_not_saved thread=trip session=\(sid)") == 1, "audit: \(t.log)")
  }

  /// An `/exit` before anything was typed leaves a file of meta lines and the command's own markup. It can never be resumed, so
  /// the id moves to `previous_ids` and one new conversation is started.
  @Test func aFileOfOnlyMetaAndSlashCommandLinesGetsANewId() throws {
    let t = try R()
    defer { t.r.teardown() }
    try t.r.wake("trip")
    let sid = try t.up(1)
    try t.save(
      sid, claudeDir: t.home,
      lines: """
        {"type":"user","isMeta":true,"message":{"content":"Caveat: the messages below were generated by the user"}}
        {"type":"user","message":{"content":"<command-name>/exit</command-name>"}}
        {"type":"user","message":{"content":"<local-command-stdout>Bye</local-command-stdout>"}}

        """)
    try t.crashThenMessage()
    let next = try t.up(2)
    #expect(next != sid && t.r.entry("trip")?.previous_ids == [sid], "\(String(describing: t.r.entry("trip")))")
    #expect(t.r.starts.count == 3, "\(t.r.starts)")
    #expect(t.start(1).contains("--resume \(sid)") && t.start(2).contains("--session-id \(next)"), "\(t.r.starts)")
    #expect(t.count("session_empty_new_id thread=trip session=\(sid)") == 1, "audit: \(t.log)")
    #expect(t.r.entry("trip")?.restarts.count == 1, "only the crash counts")
  }

  /// "Once": a new id whose own start ends the same way does not get another. Forced with a CLI that leaves an empty file for
  /// every id it is given: `--session-id` is refused as in use, the resume after it finds no conversation. The first id is
  /// replaced; the second stops the thread with the plain resume error, instead of ids being made for ever.
  @Test func theNewIdIsGivenOnceNotInALoop() throws {
    let t = try R(["FAKE_EMPTY_FILE_FROM": "2"])
    defer { t.r.teardown() }
    try t.startQuiet()
    let sid = try t.up(1, typed: 0)
    try t.crashThenMessage()
    #expect(t.r.wait(20) { t.r.state("trip") == "failed" }, "\(t.r.why("trip")) \(t.r.starts)")
    usleep(1_500_000)
    let e = try #require(t.r.entry("trip"))
    #expect(e.state == "failed" && e.error?.code == "resume_missing", "\(t.r.why("trip"))")
    #expect(e.previous_ids == [sid] && e.session_id != nil && e.session_id != sid, "\(e)")
    #expect(t.r.starts.count == 5, "new, in use, resume (empty), new id in use, resume (empty) and no more: \(t.r.starts)")
    #expect(t.count("session_empty_new_id") == 1 && t.count("session_in_use_resume") == 2, "audit: \(t.log)")
  }

  /// The once-flag is per run of refusals, not for ever (R1-2): once the new id has gone live, a later empty file gets a new id too.
  @Test func afterTheNewIdWentLiveALaterEmptyFileGetsAnotherNewId() throws {
    let t = try R()
    defer { t.r.teardown() }
    try t.r.wake("trip")
    let first = try t.up(1)
    try t.save(first, claudeDir: t.home, lines: R.empty)
    try t.crashThenMessage()
    let second = try t.up(2)
    #expect(second != first && t.r.starts.count == 3, "\(t.r.starts)")
    try t.save(second, claudeDir: t.home, lines: R.empty)
    try t.crashThenMessage()
    let third = try t.up(3)
    #expect(third != second && third != first && t.r.entry("trip")?.previous_ids == [first, second], "\(String(describing: t.r.entry("trip")))")
    #expect(t.r.starts.count == 5, "\(t.r.starts)")
    #expect(t.start(3).contains("--resume \(second)") && t.start(4).contains("--session-id \(third)"), "\(t.r.starts)")
    #expect(t.count("session_empty_new_id") == 2 && t.r.entry("trip")?.error == nil, "audit: \(t.log)")
  }

  /// An id that is not a UUID is never looked up or turned into a path: it is resumed as before (and refused by the launch
  /// check, as before), never started over as if unsaved.
  @Test func anIdThatIsNotAUuidIsNotTreatedAsUnsaved() throws {
    let t = try R()
    defer { t.r.teardown() }
    try t.r.wake("trip")
    _ = try t.up(1)
    let pid = try #require(t.r.entry("trip")?.pane_pid)
    kill(pid, SIGKILL)
    #expect(t.r.wait(10) { t.r.state("trip") == "parked" })
    #expect(t.r.wait(5) { FileManager.default.fileExists(atPath: t.r.talosHome + "/workers.json") })
    usleep(700_000)  // past a heartbeat: the parked state is in the file
    t.r.mgr.detach()
    let path = t.r.talosHome + "/workers.json"
    var f = try #require(WorkersFile.decode(try Data(contentsOf: URL(fileURLWithPath: path))))
    #expect(f.threads["trip"]?.state == "parked")
    f.threads["trip"]?.session_id = "../../not-a-uuid"
    try f.encoded().write(to: URL(fileURLWithPath: path))
    let m = t.r.makeManager()
    let audit = t.audit
    m.tune { $0.auditLogPath = audit }
    t.r.firstTick()
    m.startTicking()
    try t.r.wake("trip")
    #expect(t.r.wait(10) { t.r.state("trip") == "failed" }, "\(t.r.why("trip"))")
    #expect(t.r.entry("trip")?.error?.code == "start_failed" && t.r.entry("trip")?.session_id == "../../not-a-uuid")
    #expect(t.r.starts.count == 1 && !t.log.contains("session_not_saved"), "\(t.r.starts) audit: \(t.log)")
  }
}

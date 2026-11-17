import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The Mac halves of fixes the Linux supervisor already has, through the real seams: a private tmux server (`talos-test-…`, never
/// `-L talos`), the fake claude, a fake HOME with a fake `.claude.json`, and a fake Talos home. The owner's own Claude config, tmux and
/// bridge are never touched. Run: bash apps/desktop/scripts/test.sh --filter WorkerTwins
private let scenario = "review-worker.sh"

extension WorkerRig {
  /// The rig for these tests: the fence world, numbered argv dumps, notices kept in `log`, a short settle time and an audit log.
  static func twins(projects: [String] = ["proj-a", "proj-b"], settle: Double = 1) throws -> (WorkerRig, NoticeLog) {
    let r = try WorkerRig(scenario: scenario)
    r.env["FAKE_ARGV_DUMP"] = r.root + "/argv"
    r.env["FAKE_STATE_DIR"] = r.root + "/fake-state"
    try r.fenceWorld(projects: projects)
    let log = NoticeLog()
    r.manager(busyWindow: 0.5)
    r.trackNotices(log)
    r.mgr.tune {
      $0.launchChangeSettle = settle
      $0.auditLogPath = r.root + "/audit.log"
    }
    return (r, log)
  }

  var auditLines: [String] { lines(root + "/audit.log") }

  /// `par` (its `session_opts` as JSON text, `extra` as more keys of the thread) and its sub-thread `sub` in `subCwd`.
  func subConfig(parentOpts: String, parentExtra: String = "", subCwd: String) throws {
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},
    {"id":"par","kind":"fixed","session":"dedicated","session_opts":\(parentOpts)\(parentExtra)},
    {"id":"sub","kind":"fixed","session":"dedicated","parent_id":"par","session_opts":{"cwd":"\(subCwd)"}}]}
    """.write(toFile: talosHome + "/config.json", atomically: true, encoding: .utf8)
  }
}

@Suite("Worker twins: launch", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerTwinsLaunchTests {
  /// 3. The generated strict-plan file holds the listed servers' credentials. A start with no list removes it; the `talos-app` file a
  /// thread outside the agent folder is launched with (`workers/<id>/mcp.json`) is another file, and stays.
  @Test func aStartWithNoListRemovesTheOldGeneratedFileAndKeepsTheTalosAppOne() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    let listFile = r.talosHome + "/workers/trip/mcp/mcp.json"
    let appFile = r.talosHome + "/workers/trip/mcp.json"
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a","mcp_allow":["github"]}"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let before = String(decoding: try #require(FileManager.default.contents(atPath: listFile)), as: UTF8.self)
    #expect(before.contains("ghp_FICTIONAL_SECRET"), "the control: the file holds a credential")
    // the list is taken off: the session restarts with no list
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a"}"#)
    #expect(r.wait(15) { r.starts.count == 2 && r.up("trip") }, "\(r.why("trip"))")
    #expect(!FileManager.default.fileExists(atPath: listFile), "the file with the credentials is still on disk")
    #expect(r.auditLines.contains { $0.contains("worker_mcp_config_removed thread=trip") }, "\(r.auditLines)")
    // the talos-app file of a thread outside the agent folder is there, and is what the session was launched with
    let app = try #require(FileManager.default.contents(atPath: appFile), "the talos-app mcp.json was removed")
    let servers = (try JSONSerialization.jsonObject(with: app) as? [String: Any])?["mcpServers"] as? [String: Any]
    #expect(Set((servers ?? [:]).keys) == ["talos-app"])
    let argv = r.argv(2)
    let i = try #require(argv.firstIndex(of: "--mcp-config"))
    #expect(argv[i + 1] == appFile && !argv.contains("--strict-mcp-config"), "\(argv)")
    #expect(!r.auditLines.joined().contains("ghp_FICTIONAL_SECRET"))
  }

  /// 3, the link case: a link where the generated folder would be is not ours to follow, so nothing behind it is removed.
  @Test func aLinkInTheWayIsNeverFollowedToRemoveAFile() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    let elsewhere = r.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    try "keep me".write(toFile: elsewhere + "/mcp.json", atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(atPath: r.talosHome + "/workers/trip", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: r.talosHome + "/workers/trip/mcp", withDestinationPath: elsewhere)
    try r.fenceConfig()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(FileManager.default.fileExists(atPath: elsewhere + "/mcp.json"), "a file behind a link was removed")
    #expect(r.auditLines.contains { $0.contains("worker_mcp_config_kept thread=trip") }, "\(r.auditLines)")
  }

  /// 1, from the real entry point: a server the owner switched off for the agent folder is not one a thread can list.
  @Test func aThreadCannotListAServerSwitchedOffForTheAgentFolder() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    try r.put(
      r.home + "/.claude.json",
      ["mcpServers": ["github": ["command": "gh-mcp"], "notes": ["command": "notes-mcp"]], "projects": [r.agentDir: ["disabledMcpServers": ["github"]]]])
    try r.fenceConfig(#"{"mcp_allow":["github"]}"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "mode_escalation_denied" && r.entry("trip")?.error?.axis == "mcp")
    #expect(r.starts.isEmpty, "nothing was launched")
  }

  /// 2, from the real entry point: a server only a stale `~/.claude/.claude.json` defines is not found, and is said.
  @Test func aServerOnlyTheStaleFileDefinesIsNotLaunched() throws {
    let (r, log) = try WorkerRig.twins()
    defer { r.teardown() }
    try r.put(r.home + "/.claude/.claude.json", ["mcpServers": ["stale": ["command": "stale-mcp"]]])
    try r.fenceConfig(#"{"mcp_allow":["stale","notes"]}"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let file = try #require(FileManager.default.contents(atPath: r.talosHome + "/workers/trip/mcp/mcp.json"))
    let servers = (try JSONSerialization.jsonObject(with: file) as? [String: Any])?["mcpServers"] as? [String: Any]
    #expect(Set((servers ?? [:]).keys) == ["talos-app", "notes"])
    #expect(r.wait(5) { log.all.contains { $0.text == LaunchChange.missingServersLine(["stale"]) } }, "\(log.all)")
  }

  /// 4. The deny is in the settings a real start writes.
  @Test func theSettingsOfAStartedSessionDenyTalosAppPost() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    try r.fenceConfig()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let deny = ((r.settingsOnDisk["permissions"] as? [String: Any])?["deny"] as? [String]) ?? []
    for rule in WorkerFence.extraDeny { #expect(deny.contains(rule), "\(rule)") }
    #expect(deny.contains("Bash(talos-app post:*)"))
  }
}

@Suite("Worker twins: a setting that cannot be read", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerTwinsUnreadTests {
  /// 5a. A hand edit garbles the folder and narrows the list. The list restarts the session; the start must not resume in the agent
  /// folder (the default the garbled field reads as): it fails naming the field, and the conversation is kept.
  @Test(arguments: [(#"{"cwd":5,"mcp_allow":[]}"#, "session_opts.cwd"), (#""oops""#, "session_opts"), (#"{"cwd":"~/proj","mcp_allow":[]}"#, "session_opts.cwd")])
  func anUnreadFolderWithANarrowedListFailsTheStartNamingTheFieldAndKeepsTheConversation(_ opts: String, _ field: String) throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a"}"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let sid = try #require(r.entry("trip")?.session_id)
    try r.fenceConfig(opts)
    #expect(r.wait(15) { r.state("trip") == "failed" }, "\(opts): \(r.why("trip"))")
    let error = r.entry("trip")?.error
    #expect(error?.code == "start_failed", "\(String(describing: error))")
    #expect(error?.detail?.contains("the thread's \(field) cannot be read") == true, "\(String(describing: error))")
    #expect(r.entry("trip")?.session_id == sid && r.entry("trip")?.previous_ids == [], "the conversation was not kept")
    #expect(r.starts.count == 1, "a second session was started: \(r.starts)")
    // put right and restarted: the same conversation, in its own folder
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a","mcp_allow":[]}"#)
    try r.wakeFile("trip", action: "restart", reason: "control")
    #expect(r.wait(15) { r.starts.count == 2 && r.up("trip") }, "\(r.why("trip"))")
    #expect(r.argv(2).suffix(2) == ["--resume", sid], "\(r.argv(2))")
    #expect(r.entry("trip")?.cwd == r.home + "/proj-a")
  }

  /// 5a, the other half: with no narrowing, a garbled folder restarts nothing and loses nothing.
  @Test func anUnreadFolderAloneRestartsNothing() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a"}"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let sid = try #require(r.entry("trip")?.session_id)
    try r.fenceConfig(#"{"cwd":["\#(r.home)/proj-b"],"model":7}"#)
    usleep(4_000_000)
    #expect(r.starts.count == 1 && r.up("trip"), "\(r.why("trip"))")
    #expect(r.entry("trip")?.session_id == sid && r.entry("trip")?.previous_ids == [])
  }

  /// 5a: a thread with no conversation yet is held to it too: its first session would work in the wrong folder.
  @Test func aFirstStartWithAnUnreadFolderFailsNamingTheField() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    try r.fenceConfig(#"{"cwd":5}"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.detail?.contains("session_opts.cwd") == true)
    #expect(r.starts.isEmpty)
  }

  /// 5b. An entry an older build wrote has no `launched`. Its folder is compared with the entry's own, so a folder change made while
  /// it runs is not missed: a fresh conversation in the new folder, the old id kept in `previous_ids`.
  @Test func anEntryWithNoLaunchRecordStillSeesAFolderChange() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a"}"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(3) { r.fileOnDisk?.threads["trip"]?.launched != nil })
    let old = try #require(r.entry("trip")?.session_id)
    r.mgr.detach()
    var f = try #require(r.fileOnDisk)
    f.threads["trip"]?.launched = nil
    try f.encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-b"}"#)
    r.manager(busyWindow: 0.5)
    r.mgr.tune { $0.launchChangeSettle = 1 }
    r.firstTick()
    r.mgr.startTicking()
    #expect(r.wait(20) { r.starts.count == 2 && r.up("trip") }, "the folder change was missed: \(r.why("trip"))")
    #expect(r.entry("trip")?.cwd == r.home + "/proj-b")
    #expect(r.entry("trip")?.session_id != old && r.entry("trip")?.previous_ids == [old])
    #expect(!r.argv(2).contains("--resume"))
  }
}

@Suite("Worker twins: an entry that is not a thread", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerTwinsDroppedEntryTests {
  func config(_ r: WorkerRig, _ threads: String) throws {
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},\(threads)]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
  }
  let trip = #"{"id":"trip","name":"Trip","kind":"fixed","session":"dedicated"}"#
  let other = #"{"id":"other","name":"Other","kind":"fixed","session":"dedicated"}"#

  /// 6. The entry is left out, the rest is read (a thread beside it starts), and the owner is told once: an audit line and one line in
  /// the default thread naming the entry by its position.
  @Test func theRestIsReadAndTheOwnerIsToldOnceNamingTheEntry() throws {
    let (r, log) = try WorkerRig.twins()
    defer { r.teardown() }
    try config(r, #""a typo",\#(trip)"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "one bad entry stopped every thread: \(r.why("trip"))")
    #expect(r.wait(5) { log.all.contains { $0.thread == "general" } }, "\(log.all)")
    usleep(2_000_000)  // many ticks later: still one
    let said = log.all.filter { $0.thread == "general" }
    #expect(said.count == 1, "\(said)")
    #expect(said.first?.text == DedicatedSettings.droppedEntriesLine([2]) && said.first?.text.contains("#2") == true)
    #expect(r.auditLines.filter { $0.contains("config_threads_entries_ignored entries=2") }.count == 1, "\(r.auditLines)")
    // another set of them is a new line
    try config(r, #""a typo",\#(trip),17"#)
    #expect(r.wait(5) { log.all.contains { $0.text == DedicatedSettings.droppedEntriesLine([2, 4]) } }, "\(log.all)")
  }

  /// 6, why: before, the whole config read as unreadable and the last good list was kept, so a session whose entry the owner had
  /// just broken (or taken away) ran on. Now the narrower config is what counts: that session is parked, the one beside it runs.
  @Test func aSessionWhoseEntryIsNoLongerAThreadIsParkedNotKeptOnTheLastGoodList() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    try config(r, "\(trip),\(other)")
    r.mgr.startTicking()
    try r.wake("trip")
    try r.wake("other")
    #expect(r.wait(15) { r.up("trip") && r.up("other") }, "\(r.why("trip")) \(r.why("other"))")
    try config(r, #"["trip was here"],\#(other)"#)
    #expect(r.wait(15) { r.state("trip") == "parked" }, "kept on the last good list: \(r.why("trip"))")
    #expect(r.up("other"))
  }

  /// 6, the failure path: a post that clearly fails is tried again, and after three tries the log says so. Never silent.
  @Test func aLineThatCannotBePostedIsRetriedAndThenSaidInTheLog() throws {
    let (r, log) = try WorkerRig.twins()
    defer { r.teardown() }
    log.outcome = .failed
    r.mgr.tune { $0.noticeRetry = 1.5 }
    try config(r, #"null,\#(trip)"#)
    r.mgr.startTicking()
    #expect(r.wait(5) { log.all.count == 1 })
    usleep(700_000)
    #expect(log.all.count == 1, "a clear failure is tried again after the retry wait, not at the next tick: \(log.all.count)")
    #expect(r.wait(15) { r.auditLines.contains { $0.contains("config_threads_entries_notice_failed entries=2") } }, "\(r.auditLines)")
    usleep(1_000_000)
    #expect(log.all.filter { $0.thread == "general" }.count == 3, "\(log.all)")
    #expect(r.auditLines.filter { $0.contains("config_threads_entries_ignored") }.count == 1)
  }
}

@Suite("Worker twins: a running sub-thread the rules would not start", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerTwinsSubParkTests {
  /// `par` in `home/par`, `sub` in `home/par/s`, started and up.
  func running(settle: Double = 1, subCwd: String = "/par/s") throws -> WorkerRig {
    let (r, _) = try WorkerRig.twins(projects: ["par", "moved"], settle: settle)
    try r.subConfig(parentOpts: #"{"cwd":"\#(r.home)/par"}"#, subCwd: r.home + subCwd)
    r.mgr.startTicking()
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
    #expect(r.wait(3) { r.entry("sub")?.launched != nil })
    return r
  }

  /// 7, the orphan park: the parent is archived. The sub-thread's launch signature has not changed, so nothing restarted it before.
  @Test func aSubThreadWhoseParentIsArchivedIsParkedAndItsNextStartIsRefusedWithTheReason() throws {
    let r = try running()
    defer { r.teardown() }
    let sid = try #require(r.entry("sub")?.session_id)
    try r.subConfig(parentOpts: #"{"cwd":"\#(r.home)/par"}"#, parentExtra: #","archived":true"#, subCwd: r.home + "/par/s")
    #expect(r.wait(15) { r.state("sub") == "parked" }, "it ran on: \(r.why("sub"))")
    #expect(r.auditLines.filter { $0.contains("worker_sub_refused thread=sub") }.count == 1, "\(r.auditLines)")
    #expect(r.starts.count == 1, "no restart is queued")
    #expect(r.entry("sub")?.session_id == sid)
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(r.entry("sub")?.error?.code == "start_failed")
    #expect(r.entry("sub")?.error?.detail?.contains("the parent thread is not there any more") == true, "\(String(describing: r.entry("sub")?.error))")
    #expect(r.starts.count == 1)
  }

  @Test func aSubThreadWhoseParentIsGoneFromTheConfigIsParked() throws {
    let r = try running()
    defer { r.teardown() }
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},
    {"id":"sub","kind":"fixed","session":"dedicated","parent_id":"par","session_opts":{"cwd":"\(r.home)/par/s"}}]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    #expect(r.wait(15) { r.state("sub") == "parked" }, "\(r.why("sub"))")
  }

  /// The parent moved onto the sub-thread's own (unchanged) folder: that is now the parent's own folder, which the sub-thread shares
  /// (subthreads_shared_folder), so it is neither parked as "outside" nor refused. (An existing folder merely outside the parent's is the
  /// sub-thread's own folder and is not parked either.)
  @Test func aSubThreadWhoseFolderBecomesItsParentsOwnIsNotParkedItNowSharesIt() throws {
    let r = try running()
    defer { r.teardown() }
    try r.subConfig(parentOpts: #"{"cwd":"\#(r.home)/par/s"}"#, subCwd: r.home + "/par/s")
    // well past the settle time, and the park a refusal would have caused
    #expect(!r.wait(8) { r.state("sub") != "live" && r.state("sub") != "busy" }, "it ran on, shared: \(r.why("sub"))")
    #expect(!r.auditLines.contains { $0.contains("worker_sub_refused thread=sub") })
    #expect(r.starts.count == 1)
  }

  /// A child that shares its parent's folder, running, whose parent's folder setting then cannot be read: refused and parked after the
  /// settle time, never restarted as a folder move into the agent folder (Main's).
  @Test func aSharedFolderChildWhoseParentsFolderSettingBecomesUnreadableIsParkedNotMovedToTheAgentFolder() throws {
    let (r, _) = try WorkerRig.twins(projects: ["par"], settle: 1)
    defer { r.teardown() }
    func write(_ parentOpts: String) throws {
      try """
      {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},
      {"id":"par","kind":"fixed","session":"dedicated","session_opts":\(parentOpts)},
      {"id":"sub","kind":"fixed","session":"dedicated","parent_id":"par"}]}
      """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    }
    try write(#"{"cwd":"\#(r.home)/par"}"#)
    r.mgr.startTicking()
    try r.wake("sub")
    #expect(r.wait(10) { r.up("sub") }, "\(r.why("sub"))")
    #expect(r.entry("sub")?.launched?.cwd == r.home + "/par")
    try write(#"{"cwd":42}"#)
    #expect(r.wait(15) { r.state("sub") == "parked" }, "it ran on: \(r.why("sub"))")
    #expect(r.starts.count == 1, "no restart into another folder")
    try r.wake("sub")
    #expect(r.wait(10) { r.state("sub") == "failed" }, "\(r.why("sub"))")
    #expect(r.entry("sub")?.error?.detail?.contains("folder setting can't be read") == true, "\(String(describing: r.entry("sub")?.error))")
    #expect(r.starts.count == 1)
  }

  /// 7: a parent moved to a folder no session may use (the home folder itself) parks it, as a start would refuse.
  @Test func aParentMovedToAFolderNoSessionMayUseParksIt() throws {
    let r = try running()
    defer { r.teardown() }
    try r.subConfig(parentOpts: #"{"cwd":"\#(r.home)"}"#, subCwd: r.home + "/par/s")
    #expect(r.wait(15) { r.state("sub") == "parked" }, "\(r.why("sub"))")
  }

  /// 7, the control that keeps sessions alive: a parent's folder that cannot be resolved for a while is no verdict.
  @Test func aParentFolderThatCannotBeResolvedForAWhileNeverStopsTheSession() throws {
    let r = try running()
    defer { r.teardown() }
    // the config still names home/par; on disk it is away (a rename in progress, a mount not up)
    try FileManager.default.moveItem(atPath: r.home + "/par", toPath: r.home + "/par-away")
    usleep(4_000_000)  // four settle times
    #expect(r.up("sub") && r.starts.count == 1, "stopped on no verdict: \(r.why("sub"))")
    #expect(!r.auditLines.contains { $0.contains("worker_sub_refused") })
    try FileManager.default.moveItem(atPath: r.home + "/par-away", toPath: r.home + "/par")
    usleep(1_500_000)
    #expect(r.up("sub") && r.starts.count == 1)
  }

  /// 7: a parent that moves but still holds the sub-thread's folder changes nothing.
  @Test func aParentThatMovesButStillHoldsTheFolderChangesNothing() throws {
    let r = try running(subCwd: "/par/a/s")
    defer { r.teardown() }
    try r.subConfig(parentOpts: #"{"cwd":"\#(r.home)/par/a"}"#, subCwd: r.home + "/par/a/s")
    usleep(4_000_000)
    #expect(r.up("sub") && r.starts.count == 1, "\(r.why("sub"))")
  }

  /// 7: a refusal put right before the settle time passes changes nothing.
  @Test func aRefusalPutRightInsideTheSettleTimeChangesNothing() throws {
    let r = try running(settle: 4)
    defer { r.teardown() }
    try r.subConfig(parentOpts: #"{"cwd":"\#(r.home)/par"}"#, parentExtra: #","archived":true"#, subCwd: r.home + "/par/s")
    usleep(1_500_000)
    try r.subConfig(parentOpts: #"{"cwd":"\#(r.home)/par"}"#, subCwd: r.home + "/par/s")
    usleep(5_000_000)
    #expect(r.up("sub") && r.starts.count == 1, "\(r.why("sub"))")
    #expect(!r.auditLines.contains { $0.contains("worker_sub_refused") })
  }

  /// 7: with no record of its launch (an older build's entry), the folder the session really runs in is fenced too.
  @Test func withNoLaunchRecordTheFolderItReallyRunsInIsFenced() throws {
    let r = try running()
    defer { r.teardown() }
    r.mgr.detach()
    var f = try #require(r.fileOnDisk)
    f.threads["sub"]?.launched = nil
    try f.encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    // the parent moved onto the folder the session really runs in (home/par/s) and the sub-thread's setting moved inside it
    try FileManager.default.createDirectory(atPath: r.home + "/par/s/x", withIntermediateDirectories: true)
    try r.subConfig(parentOpts: #"{"cwd":"\#(r.home)/par/s"}"#, subCwd: r.home + "/par/s/x")
    r.manager(busyWindow: 0.5)
    r.mgr.tune {
      $0.launchChangeSettle = 1
      $0.auditLogPath = r.root + "/audit.log"
    }
    r.firstTick()
    r.mgr.startTicking()
    #expect(r.wait(15) { r.auditLines.contains { $0.contains("worker_sub_refused thread=sub") } }, "\(r.why("sub")) \(r.auditLines)")
    #expect(r.wait(15) { r.state("sub") == "parked" }, "\(r.why("sub"))")
    #expect(r.starts.count == 1, "parked for good, not restarted")
  }
}

/// 8. No thread session under a Main narrowed beyond a worker's reach: restricted mode, CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG, safe mode
/// and bare mode. A worker's environment drops all four switches (`WorkerSpec.build` scrubs every CLAUDE_CODE_* variable not on the keep
/// list) and its arguments never carry the flags, so a worker cannot be held to any of them: every start is refused, before it takes a
/// slot, and the thread is told once, naming the mode, with the way out.
@Suite("Worker twins: a narrowed Main", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerTwinsNarrowedMainTests {
  static let restricted = "restricted mode (--restricted or CLAUDE_CODE_RESTRICTED)"
  static let safe = "safe mode (--safe-mode or CLAUDE_CODE_SAFE_MODE)"
  static let bare = "bare mode (--bare or CLAUDE_CODE_SIMPLE)"
  static let personal = "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG"

  func expectRefused(_ r: WorkerRig, _ log: NoticeLog, mode: String, _ what: String) {
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(what): a session wider than Main started: \(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "start_failed" && r.entry("trip")?.error?.detail == MainNarrowed.detail(mode), "\(what): \(r.why("trip"))")
    #expect(r.starts.isEmpty, "\(what): \(r.starts)")
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/launch.sh"), "\(what): nothing is made")
    #expect(r.wait(5) { log.all.contains { $0.thread == "trip" && $0.text == MainNarrowed.line(mode) } }, "\(what): \(log.all)")
    #expect(log.all.contains { $0.text.contains(mode) }, "the line names the mode")
    #expect(r.auditLines.contains { $0.contains("worker_start_refused thread=trip why=main_narrowed") && $0.contains(mode) }, "\(what)")
  }

  /// By Main's environment: `desktop.json` `env` sets the switch. It reaches Main (and the environment a worker is built from), and
  /// the worker's spec drops it.
  @Test(arguments: [
    ("CLAUDE_CODE_RESTRICTED", "1", restricted), ("CLAUDE_CODE_RESTRICTED", " YES ", restricted),
    ("CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG", "true", personal), ("CLAUDE_CODE_SAFE_MODE", "on", safe), ("CLAUDE_CODE_SIMPLE", "1", bare),
  ])
  func narrowedByMainsEnvironmentNoThreadSessionStarts(_ name: String, _ value: String, _ mode: String) throws {
    let (r, log) = try WorkerRig.twins()
    defer { r.teardown() }
    r.env[name] = value
    r.manager(busyWindow: 0.5)
    r.trackNotices(log)
    r.mgr.tune { $0.auditLogPath = r.root + "/audit.log" }
    try r.fenceConfig()
    r.mgr.startTicking()
    try r.wake("trip")
    expectRefused(r, log, mode: mode, "\(name)=\(value)")
  }

  /// By Main's arguments.
  @Test(arguments: [(["--restricted"], restricted), (["--model", "opus", "--restricted=true"], restricted), (["--safe-mode"], safe), (["--bare"], bare)])
  func narrowedByMainsArgumentsNoThreadSessionStarts(_ args: [String], _ mode: String) throws {
    let (r, log) = try WorkerRig.twins()
    defer { r.teardown() }
    r.mgr.tune { $0.mainArgs = args }
    try r.fenceConfig()
    r.mgr.startTicking()
    try r.wake("trip")
    expectRefused(r, log, mode: mode, "\(args)")
  }

  /// The settings no longer say so, but the Main that is running was launched narrowed and has not restarted.
  @Test func aMainStillRunningNarrowedRefusesTooAndTheThreadIsToldOnce() throws {
    let (r, log) = try WorkerRig.twins()
    defer { r.teardown() }
    r.mgr.mainRunsNarrowed = { Self.safe }
    try r.fenceConfig()
    r.mgr.startTicking()
    try r.wake("trip")
    expectRefused(r, log, mode: Self.safe, "running Main")
    // asked again and again: refused each time, told once
    for _ in 0..<3 {
      try r.wakeFile("trip", action: "restart", reason: "control")
      usleep(700_000)
    }
    #expect(r.state("trip") == "failed" && r.starts.isEmpty)
    #expect(log.all.filter { $0.text == MainNarrowed.line(Self.safe) }.count == 1, "\(log.all)")
    // the way out: Main no longer narrowed, the thread restarted
    r.mgr.mainRunsNarrowed = { nil }
    try r.wakeFile("trip", action: "restart", reason: "control")
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
  }

  /// The refusal comes before the start takes a slot: with every slot taken, the cap parks no other session at once to make room
  /// for it. (The other session does go, after its turn, for the reason every session goes under a narrowed Main.)
  @Test func aRefusedStartNeverMakesTheCapParkAnotherSession() throws {
    let r = try WorkerRig(threads: ["trip", "other"], maxLive: 1, scenario: scenario)
    defer { r.teardown() }
    r.manager(busyWindow: 0.5)
    r.mgr.startTicking()
    try r.wake("other")
    #expect(r.wait(10) { r.state("other") == "live" }, "\(r.why("other"))")
    r.mgr.mainRunsNarrowed = { Self.restricted }
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.wait(15) { r.state("other") == "parked" }, "\(r.why("other"))")
    #expect(!r.allEvents.contains(.parked(thread: "other", reason: "cap")), "parked for a start that was never going to run: \(r.allEvents)")
    #expect(r.allEvents.contains(.parked(thread: "other", reason: "main_narrowed")), "\(r.allEvents)")
    #expect(r.starts.count == 1)
  }

  /// Control: values Claude Code reads as off narrow nothing.
  @Test func switchesThatAreOffStartTheSession() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    for name in MainNarrowed.variables { r.env[name] = "0" }
    r.manager(busyWindow: 0.5)
    try r.fenceConfig()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
  }
}

/// 8, Main's side: what the main session was really launched with is published, for the worker manager to read.
@Suite("Worker twins: Main says which narrowing mode it runs in", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerTwinsMainNarrowedStatusTests {
  @Test func aMainLaunchedWithASwitchOrAFlagSaysSoAndAPlainOneDoesNot() throws {
    let cases: [(String, [String: String], [String], String?)] = [
      ("desktop.json env", ["CLAUDE_CODE_RESTRICTED": "true"], [], WorkerTwinsNarrowedMainTests.restricted),
      ("the flag", [:], ["--restricted"], WorkerTwinsNarrowedMainTests.restricted),
      ("personal config", ["CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG": "1"], [], WorkerTwinsNarrowedMainTests.personal),
      ("safe mode", [:], ["--safe-mode"], WorkerTwinsNarrowedMainTests.safe), ("bare mode", ["CLAUDE_CODE_SIMPLE": "1"], [], WorkerTwinsNarrowedMainTests.bare),
      ("plain", [:], [], nil), ("off", ["CLAUDE_CODE_RESTRICTED": "0", "CLAUDE_CODE_SIMPLE": "false"], [], nil),
    ]
    for (name, env, args, want) in cases {
      let r = try Rig(.tmux, scenario: "dev-dialog.sh", env: env, configure: { $0.args += args })
      defer { r.teardown() }
      r.start()
      #expect(r.wait(10) { r.sup.status.childPid != nil }, "\(name)")
      #expect(r.sup.status.mainNarrowed == want, "\(name): \(String(describing: r.sup.status.mainNarrowed))")
    }
  }

  /// A login shell that exports a switch does not narrow Main: the app drops it (`ClaudeEnvScrub`), for Main as for a worker.
  @Test func aLoginShellsSwitchReachesNeitherMainNorItsStatus() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", loginExtra: ["CLAUDE_CODE_RESTRICTED": "1", "CLAUDE_CODE_SAFE_MODE": "1"])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.status.childPid != nil })
    #expect(r.sup.status.mainNarrowed == nil)
  }

  /// A pane found running after a relaunch of the app, when the settings no longer say what it was launched with: its real
  /// arguments say it, whatever the settings say now.
  @Test func aMainFoundRunningWithAFlagTheSettingsNoLongerHaveStillSaysSo() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", configure: { $0.args += ["--bare"] })
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.status.childPid != nil })
    r.sup.detach()
    var c = r.config
    c.args.removeAll { $0 == "--bare" }
    try ConfigFile.save(c, to: r.configPath)
    r.makeSupervisor()
    r.sup.startTicking()
    r.sup.attachOrStart(allowColdStart: false)
    #expect(r.wait(10) { r.sup.status.childPid != nil }, "\(r.sup.status)")
    #expect(r.sup.status.mainNarrowed == WorkerTwinsNarrowedMainTests.bare, "\(String(describing: r.sup.status.mainNarrowed))")
  }

  /// The same for a switch in its environment: read from the process where the system allows it, and where it does not, a launch
  /// that is not the one the settings name is not known to be in no mode. Either way it is not "none".
  @Test func aMainFoundRunningWithASwitchTheSettingsNoLongerHaveIsNeverReadAsNotNarrowed() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", env: ["CLAUDE_CODE_SAFE_MODE": "1"])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.status.childPid != nil })
    #expect(r.sup.status.mainNarrowed == WorkerTwinsNarrowedMainTests.safe)
    r.sup.detach()
    var c = r.config
    c.env["CLAUDE_CODE_SAFE_MODE"] = nil
    try ConfigFile.save(c, to: r.configPath)
    r.makeSupervisor()
    r.sup.startTicking()
    r.sup.attachOrStart(allowColdStart: false)
    #expect(r.wait(10) { r.sup.status.childPid != nil }, "\(r.sup.status)")
    let mode = r.sup.status.mainNarrowed
    #expect(mode == WorkerTwinsNarrowedMainTests.safe || mode == MainNarrowed.unknown, "read as not narrowed: \(String(describing: mode))")
  }

  /// Control: the same relaunch with nothing changed keeps the plain answer.
  @Test func aPlainMainFoundRunningWithTheSameSettingsIsNotNarrowed() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.status.childPid != nil })
    r.sup.detach()
    r.makeSupervisor()
    r.sup.startTicking()
    r.sup.attachOrStart(allowColdStart: false)
    #expect(r.wait(10) { r.sup.status.childPid != nil }, "\(r.sup.status)")
    #expect(r.sup.status.mainNarrowed == nil)
  }
}

/// From the review of these changes.
@Suite("Worker twins: review", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerTwinsReviewTests {
  final class Skew: @unchecked Sendable {
    private let lock = NSLock()
    private var extra = 0.0
    func advance(_ s: Double) { lock.withLock { extra += s } }
    func awake() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 + lock.withLock { extra } }
  }

  /// R1-2. A session already running when Main becomes narrowed is parked after its turn and its thread is told; its next start is
  /// refused. And (R1-8) a refusal after a start that ran is a new one: it is told again.
  @Test func aSessionAlreadyRunningWhenMainBecomesNarrowedIsParkedAndTold() throws {
    let (r, log) = try WorkerRig.twins()
    defer { r.teardown() }
    r.mgr.tune { $0.noticeDebounce = 0 }
    try r.fenceConfig()
    r.mgr.mainRunsNarrowed = { WorkerTwinsNarrowedMainTests.restricted }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.wait(5) { log.all.count == 1 })
    r.mgr.mainRunsNarrowed = { nil }
    try r.wakeFile("trip", action: "restart", reason: "control")
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    // Main is restarted into safe mode while the thread's session runs
    r.mgr.mainRunsNarrowed = { WorkerTwinsNarrowedMainTests.safe }
    #expect(r.wait(15) { r.state("trip") == "parked" }, "the session ran on, wider than Main: \(r.why("trip"))")
    #expect(r.wait(5) { log.all.contains { $0.text == MainNarrowed.line(WorkerTwinsNarrowedMainTests.safe) } }, "\(log.all)")
    #expect(r.auditLines.contains { $0.contains("worker_parked_main_narrowed thread=trip") })
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.starts.count == 1)
    // back to restricted after a start that ran: told again (R1-8)
    r.mgr.mainRunsNarrowed = { nil }
    try r.wakeFile("trip", action: "restart", reason: "control")
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    r.mgr.mainRunsNarrowed = { WorkerTwinsNarrowedMainTests.restricted }
    #expect(r.wait(15) { log.all.filter { $0.text == MainNarrowed.line(WorkerTwinsNarrowedMainTests.restricted) }.count == 2 }, "\(log.all)")
  }

  /// R1-4. A thread whose entry was left out (a typo in it) is parked, but not forgotten: its conversation is there when the entry is
  /// fixed. Control: a thread really taken out of the config is forgotten after the wait, as before.
  @Test(arguments: [true, false])
  func aThreadWhoseEntryWasLeftOutIsNotForgotten(_ typo: Bool) throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    let skew = Skew()
    r.manager(busyWindow: 0.5, now: { Date().timeIntervalSince1970 }, awake: { skew.awake() })
    r.mgr.tune { $0.launchChangeSettle = 1 }
    try r.fenceConfig()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let sid = try #require(r.entry("trip")?.session_id)
    let broken = typo ? #"{"id":7,"kind":"fixed","session":"dedicated"}"# : #"{"id":"elsewhere","kind":"fixed"}"#
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},\(broken)]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    #expect(r.wait(15) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    usleep(600_000)  // a tick that notes it absent
    skew.advance(700)  // past the forget wait
    if typo {
      usleep(1_500_000)
      #expect(r.entry("trip")?.session_id == sid, "the conversation of a thread with a typo in its entry was dropped")
      try r.fenceConfig()
      try r.wake("trip")
      #expect(r.wait(15) { r.starts.count == 2 && r.up("trip") }, "\(r.why("trip"))")
      #expect(r.argv(2).suffix(2) == ["--resume", sid])
    } else {
      #expect(r.wait(10) { r.entry("trip") == nil }, "the control: a thread taken out is forgotten")
    }
  }

  /// R1-9. A thread that no longer has its own session keeps no generated file with its servers' credentials.
  @Test func aThreadSwitchedBackToSharedLosesItsGeneratedFile() throws {
    let (r, _) = try WorkerRig.twins()
    defer { r.teardown() }
    let file = r.talosHome + "/workers/trip/mcp/mcp.json"
    try r.fenceConfig(#"{"mcp_allow":["github"]}"#)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(FileManager.default.fileExists(atPath: file))
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","kind":"fixed"}]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    #expect(r.wait(20) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    #expect(r.wait(5) { !FileManager.default.fileExists(atPath: file) }, "the credentials stayed on disk")
  }
}

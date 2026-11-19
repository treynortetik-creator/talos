import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The privilege ceiling and main's own `--settings`, through the real seams: the real worker manager, a private tmux server
/// (`talos-test-…`, never `-L talos`), the fake claude and a fake HOME. The Linux supervisor's cases
/// (apps/bridge/test/supervisor/workers.test.ts, workers-wiring.test.ts), driven from a wake file as the hub writes it.
@Suite("Main's own --settings at a thread session's start", .serialized, .enabled(if: Rig.hasTmux))
struct MainSettingsStartTests {
  func rig(threads: [String] = ["trip"], maxLive: Int = 3) throws -> (r: WorkerRig, log: NoticeLog, own: String, audit: String) {
    let r = try WorkerRig(threads: threads, maxLive: maxLive, scenario: "review-worker.sh")
    try r.fenceWorld()
    r.env["FAKE_ARGV_DUMP"] = r.root + "/argv"
    r.env["FAKE_STATE_DIR"] = r.root + "/fake-state"
    let log = NoticeLog()
    r.manager(busyWindow: 0.5)
    r.trackNotices(log)
    let own = r.root + "/cfg/own.json"
    let audit = r.root + "/audit.log"
    try FileManager.default.createDirectory(atPath: r.root + "/cfg", withIntermediateDirectories: true)
    r.mgr.tune {
      $0.permissionFlag = nil
      $0.mainArgs = ["--model", "opus", "--settings", own]
      $0.auditLogPath = audit
    }
    return (r, log, own, audit)
  }
  func said(_ log: NoticeLog) -> [String] { log.all.map(\.text).filter { $0.contains("Main's --settings") } }
  func settings(_ r: WorkerRig, _ id: String = "trip") -> [String: Any] {
    FileManager.default.contents(atPath: r.talosHome + "/workers/\(id)/settings.json").flatMap {
      (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]
    } ?? [:]
  }
  func refusedLines(_ r: WorkerRig, _ audit: String) -> [String] { r.lines(audit).filter { $0.contains("worker_start_refused") } }

  @Test func anUnreadableFileRefusesTheStartSaysSoOnceAndTheNextStartWorksOnceItIsFixed() throws {
    let (r, log, own, audit) = try rig()
    defer { r.teardown() }
    try "{not json".write(toFile: own, atomically: true, encoding: .utf8)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "start_failed")
    #expect((r.entry("trip")?.error?.detail ?? "").contains(own), "\(String(describing: r.entry("trip")?.error))")
    #expect(r.starts.isEmpty, "nothing was launched")
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/settings.json"), "nothing was written for it")
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/launch.sh"))
    #expect(r.wait(5) { said(log).count == 1 }, "\(log.all)")
    #expect(refusedLines(r, audit).contains { $0.contains("thread=trip") && $0.contains("why=main_settings_unreadable") && $0.contains("settings=\(own)") })
    // refused again and again: still one line in the thread, and one audit line each time
    for n in 2...3 {
      try r.wake("trip", action: "restart")
      #expect(r.wait(10) { refusedLines(r, audit).count == n }, "\(r.lines(audit))")
      #expect(r.wait(5) { r.state("trip") == "failed" })
    }
    usleep(1_000_000)
    #expect(said(log).count == 1, "\(log.all)")
    let line = said(log).first ?? ""
    #expect(line.contains(own) && line.contains("press Restart"), "the file and the fix: \(line)")
    #expect(r.starts.isEmpty)

    // fixed: the next start works, in the mode and under the deny rules the file names
    try r.put(own, ["permissions": ["defaultMode": "plan", "deny": ["Bash(curl:*)", "Read(/notes/**)"]]])
    try r.wake("trip", action: "restart")
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    let perms = settings(r)["permissions"] as? [String: Any]
    #expect(perms?["defaultMode"] as? String == "plan")
    let deny = perms?["deny"] as? [String] ?? []
    #expect(deny.contains("Bash(curl:*)") && deny.contains("Read(/\(r.root)/cfg/notes/**)"), "\(deny.filter { !$0.contains("talos-home") })")
    #expect(refusedLines(r, audit).count == 3, "a start that runs is not a refusal")

    // broken again later: a new episode, told again
    try FileManager.default.removeItem(atPath: own)
    try r.wake("trip", action: "restart")
    #expect(r.wait(20) { r.state("trip") == "failed" && r.entry("trip")?.error?.code == "start_failed" }, "\(r.why("trip"))")
    #expect(r.wait(5) { said(log).count == 2 }, "\(log.all)")
  }

  @Test func mainsOwnModeIsReadFirstAndItsDenyRulesReachTheWorker() throws {
    let (r, _, own, _) = try rig()
    defer { r.teardown() }
    // wider everywhere else main could have read a mode from
    try r.put(r.home + "/.claude/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    try r.put(r.talosHome + "/guards/settings.json", ["permissions": ["defaultMode": "bypassPermissions", "deny": ["Bash(claude plugin:*)"]]])
    try r.put(r.agentDir + "/.claude/settings.json", ["permissions": ["deny": ["Edit(*)", "Write()", "Read(.env)"]]])
    try r.put(own, ["permissions": ["defaultMode": "plan", "deny": ["Read(./secrets/**)", "NotebookEdit(*)"]]])
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let perms = settings(r)["permissions"] as? [String: Any]
    #expect(perms?["defaultMode"] as? String == "plan", "main's own, not the guards' bypass or the user's acceptEdits")
    let deny = perms?["deny"] as? [String] ?? []
    let shown = deny.filter { !$0.contains("talos-home") }
    #expect(deny.contains("Read(/\(r.agentDir)/secrets/**)") && deny.contains("NotebookEdit(*)"), "\(shown)")
    // a main made read-only: its worker cannot edit anywhere, not only in the agent folder
    #expect(deny.contains("Edit(*)") && deny.contains("Write()"), "\(shown)")
    // (the settings-file deny names the agent folder's .claude, .mcp.json and .env*: that is its own rule, not main's made narrower; and the
    // thread's own state file gets its `<file>/**` deny beside the allow for the file itself, WorkerHookState.swift)
    #expect(!deny.contains { rule in !WorkerFence.projectFiles.contains { rule.hasSuffix($0 + ")") } && !rule.contains("/hooks") && !rule.hasSuffix("/threads/trip.state.md/**)") && (rule.hasPrefix("Edit(/\(r.agentDir)") || rule.hasPrefix("Write(/\(r.agentDir)")) }, "\(shown)")
    #expect(deny.contains("Read(/\(r.agentDir)/**/.env)"), "any depth: \(shown)")
    #expect(deny.contains("Bash(claude plugin:*)"), "the guards' rules stay")
  }

  @Test func aRefusedStartTakesNoSlot_theQuietSessionIsNotParkedForIt() throws {
    let (r, log, own, _) = try rig(threads: ["a", "c"], maxLive: 1)
    defer { r.teardown() }
    try r.put(own, ["permissions": ["defaultMode": "plan"]])
    r.mgr.startTicking()
    try r.wake("a")
    #expect(r.wait(10) { r.up("a") }, "\(r.why("a"))")
    usleep(1_500_000)  // quiet: the one a start would park to make room
    try "[]".write(toFile: own, atomically: true, encoding: .utf8)
    try r.wake("c")
    #expect(r.wait(10) { r.state("c") == "failed" }, "\(r.why("c"))")
    usleep(1_500_000)
    #expect(r.up("a"), "never parked to make room for a start that cannot run: \(r.why("a"))")
    #expect(!r.allEvents.contains(.parked(thread: "a", reason: "cap")))
    #expect(said(log).count == 1 && log.all.filter { $0.text.contains("Main's --settings") }.first?.thread == "c", "\(log.all)")
  }

  @Test func aLineWhosePostFailedIsTriedAgainOnALaterTick() throws {
    let (r, log, own, _) = try rig()
    defer { r.teardown() }
    log.outcome = .failed
    try "{}{".write(toFile: own, atomically: true, encoding: .utf8)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.wait(5) { said(log).count >= 1 })
    let failedTries = said(log).count
    #expect(failedTries <= 2, "not hammered: \(failedTries)")
    log.outcome = .sent
    #expect(r.wait(5) { said(log).count == failedTries + 1 }, "tried again with no new start: \(said(log).count)")
    usleep(1_000_000)
    #expect(said(log).count == failedTries + 1, "and not again once it went")
  }

  @Test(.timeLimit(.minutes(2))) func aFifoForSettingsRefusesTheStartAndNeverHangsTheManager() throws {
    let (r, log, own, _) = try rig()
    defer { r.teardown() }
    #expect(mkfifo(own, 0o600) == 0)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "start_failed")
    #expect(r.wait(5) { said(log).count == 1 })
    #expect(r.starts.isEmpty)
  }

  @Test func settingsGivenInlineAreNeverWrittenIntoTheLogOrTheThread() throws {
    let (r, log, _, audit) = try rig()
    defer { r.teardown() }
    let inline = #"{"permissions":{"deny":"sk-FICTIONAL-INLINE"}}"#
    r.mgr.tune { $0.mainArgs = ["--settings", inline] }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.wait(5) { said(log).count == 1 })
    #expect(said(log).first?.contains("given inline") == true)
    var everything = r.lines(audit).joined() + log.all.map(\.text).joined() + (r.entry("trip")?.error?.detail ?? "")
    #expect(!everything.contains("FICTIONAL-INLINE"))
    #expect(refusedLines(r, audit).contains { $0.contains("settings=the settings given inline") })
    // text left unclosed is a file name to Claude Code, and still never shown: a second thread, refused the same way
    r.mgr.tune { $0.mainArgs = ["--settings", #"{"env":{"KEY":"sk-FICTIONAL-UNCLOSED""#] }
    try r.wake("trip", action: "restart")
    #expect(r.wait(10) { refusedLines(r, audit).count == 2 }, "\(r.lines(audit))")
    #expect(r.wait(5) { r.state("trip") == "failed" })
    everything = r.lines(audit).joined() + log.all.map(\.text).joined() + (r.entry("trip")?.error?.detail ?? "")
    #expect(!everything.contains("FICTIONAL-UNCLOSED"))
  }

  @Test func aModeNobodyKnowsStartsTheWorkerInPlanAndSaysSoInTheAuditLog() throws {
    let (r, _, own, audit) = try rig()
    defer { r.teardown() }
    try r.put(r.home + "/.claude/settings.json", ["permissions": ["defaultMode": "bypassPermissions"]])
    try r.put(own, ["permissions": ["defaultMode": "yolo\u{2028}x"]])
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect((settings(r)["permissions"] as? [String: Any])?["defaultMode"] as? String == "plan")
    #expect(r.lines(audit).contains { $0.contains("worker_ceiling_narrowed why=unknown_mode mode=yolo") }, "\(r.lines(audit))")
  }

  @Test func aFileThatReadsAgainEndsTheEpisodeEvenWhenTheStartThenFailsForAnotherReason() throws {
    let (r, log, own, _) = try rig()
    defer { r.teardown() }
    try "nope".write(toFile: own, atomically: true, encoding: .utf8)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" && said(log).count == 1 }, "\(r.why("trip")) \(log.all)")
    // fixed, but the start is refused by the ceiling: the thread's folder has an MCP server nobody approved
    try r.put(own, ["permissions": ["defaultMode": "plan"]])
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a","mcp_allow":["local-db"]}"#)
    try r.wake("trip", action: "restart")
    #expect(r.wait(10) { r.entry("trip")?.error?.code == "mode_escalation_denied" }, "\(r.why("trip"))")
    usleep(1_000_000)
    #expect(said(log).count == 1, "no line about a file that reads: \(log.all)")
    // broken again at the same path: a new episode, told again
    try "nope".write(toFile: own, atomically: true, encoding: .utf8)
    try r.wake("trip", action: "restart")
    #expect(r.wait(10) { r.entry("trip")?.error?.code == "start_failed" }, "\(r.why("trip"))")
    #expect(r.wait(5) { said(log).count == 2 }, "\(log.all)")
  }

  @Test func managedSettingsReachTheWorker_bypassRuledOutMeansNoBypassFlagOnIt() throws {
    let (r, _, _, audit) = try rig()
    defer { r.teardown() }
    let managed = r.root + "/managed"
    try r.put(managed + "/managed-settings.json", ["permissions": ["disableBypassPermissionsMode": "disable", "deny": ["Bash(curl:*)", "Edit(*)"]]])
    try r.put(managed + "/managed-settings.d/10-org.json", ["permissions": ["defaultMode": "acceptEdits"]])
    try "{nope".write(toFile: managed + "/managed-settings.d/20-bad.json", atomically: true, encoding: .utf8)
    try r.put(r.home + "/.claude/settings.json", ["permissions": ["defaultMode": "bypassPermissions"]])
    r.mgr.tune {
      $0.permissionFlag = "--dangerously-skip-permissions"
      $0.mainArgs = ["--dangerously-skip-permissions", "--model", "opus"]
      $0.managedDir = managed
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(!r.argv(1).isEmpty && !r.argv(1).contains("--dangerously-skip-permissions"), "main falls through its bypass flag, so its worker has none: \(r.argv(1))")
    let perms = settings(r)["permissions"] as? [String: Any]
    #expect(perms?["defaultMode"] as? String == "acceptEdits", "the narrowest of the managed mode and the user's, bypass ruled out")
    let deny = perms?["deny"] as? [String] ?? []
    #expect(deny.contains("Bash(curl:*)") && deny.contains("Edit(*)"))
    #expect(r.lines(audit).contains { $0.contains("managed_settings_unreadable files=1") }, "\(r.lines(audit))")
  }

  @Test func withoutAManagedFolderTheSameMainKeepsItsBypass_theControl() throws {
    let (r, _, _, _) = try rig()
    defer { r.teardown() }
    r.mgr.tune {
      $0.permissionFlag = "--dangerously-skip-permissions"
      $0.mainArgs = ["--dangerously-skip-permissions", "--model", "opus"]
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.argv(1).first == "--dangerously-skip-permissions")
  }

  @Test func aSettingsFlagAfterTheTerminatorIsThePromptAndRefusesNothing() throws {
    let (r, log, own, _) = try rig()
    defer { r.teardown() }
    // `own` does not exist: read as main's it would refuse the start
    r.mgr.tune { $0.mainArgs = ["--permission-mode", "plan", "--", "--settings", own] }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect((settings(r)["permissions"] as? [String: Any])?["defaultMode"] as? String == "plan")
    #expect(said(log).isEmpty)
  }
}

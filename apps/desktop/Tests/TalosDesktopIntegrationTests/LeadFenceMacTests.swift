import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The lead fence, Mac half, through the real seams: a private tmux server (`talos-test-…`, never `-L talos`), the fake claude, a fake
/// HOME with a fake `.claude.json`, and a fake Talos home. The owner's own Claude config, tmux and bridge are never touched.
private let scenario = "review-worker.sh"
private let secret = "ghp_FICTIONAL_SECRET_0123456789"

extension WorkerRig {
  var home: String { root + "/home" }
  func put(_ path: String, _ json: Any) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]).write(to: URL(fileURLWithPath: path))
  }

  /// The agent folder's `.mcp.json` (talos-app, as the setup writes it), the owner's user scope and a project folder with its own server.
  func fenceWorld(projects: [String] = ["proj-a", "proj-b"]) throws {
    try put(agentDir + "/.mcp.json", ["mcpServers": ["talos-app": ["command": "bun", "args": ["server.ts"], "env": ["KEEP": "yes", "TELEGRAM_BOT_TOKEN": "123:abc"]]]])
    try put(
      home + "/.claude.json",
      ["mcpServers": ["github": ["command": "npx", "args": ["-y", "gh-mcp"], "env": ["GITHUB_TOKEN": secret]], "notes": ["command": "notes-mcp"]]])
    for p in projects { try FileManager.default.createDirectory(atPath: home + "/" + p, withIntermediateDirectories: true) }
    try put(home + "/proj-a/.mcp.json", ["mcpServers": ["local-db": ["command": "db-mcp"]]])
  }

  /// The config with `trip` dedicated and `opts` as its `session_opts` (JSON text).
  func fenceConfig(_ opts: String = "{}") throws {
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","name":"Trip","kind":"fixed","session":"dedicated","session_opts":\(opts)}]}
    """.write(toFile: talosHome + "/config.json", atomically: true, encoding: .utf8)
  }

  /// The owner's record for a project folder in the fake global config: servers of his own for it, and what he approved of its .mcp.json.
  func ownerRecord(_ folder: String, local: [String: Any] = [:], approve: [String] = []) throws {
    var j = (try JSONSerialization.jsonObject(with: try Data(contentsOf: URL(fileURLWithPath: home + "/.claude.json"))) as? [String: Any]) ?? [:]
    var entry: [String: Any] = [:]
    if !local.isEmpty { entry["mcpServers"] = local }
    if !approve.isEmpty { entry["enabledMcpjsonServers"] = approve }
    j["projects"] = [folder: entry]
    try put(home + "/.claude.json", j)
  }

  var argvDump: String { root + "/argv" }
  func argv(_ n: Int) -> [String] {
    (FileManager.default.contents(atPath: argvDump + ".\(n)").flatMap { String(data: $0, encoding: .utf8) } ?? "")
      .split(separator: "\n").map { String($0.dropFirst().dropLast()) }
  }
  var settingsOnDisk: [String: Any] {
    FileManager.default.contents(atPath: talosHome + "/workers/trip/settings.json").flatMap {
      (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]
    } ?? [:]
  }
}

@Suite("Lead fence: launch", .serialized, .enabled(if: Rig.hasTmux))
struct LeadFenceLaunchTests {
  func rig(_ scenarioName: String = scenario, extra: [String: String] = [:]) throws -> WorkerRig {
    let r = try WorkerRig(scenario: scenarioName, extraEnv: extra)
    r.env["FAKE_ARGV_DUMP"] = r.root + "/argv"
    r.env["FAKE_STATE_DIR"] = r.root + "/fake-state"  // numbers the starts, so the nth start has its own argv dump
    try r.fenceWorld()
    return r
  }

  func notices(_ r: WorkerRig, settle: Double = 1) -> NoticeLog {
    let log = NoticeLog()
    r.manager(busyWindow: 0.5)
    r.trackNotices(log)
    r.mgr.tune { $0.launchChangeSettle = settle }
    return log
  }

  @Test func noListLaunchesAsTodayAndTheSettingsCarryTheFence() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig()
    _ = notices(r)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let argv = r.argv(1)
    #expect(!argv.contains("--strict-mcp-config") && !argv.contains("--no-chrome"))
    #expect(argv.first == "--dangerously-skip-permissions")
    let deny = ((r.settingsOnDisk["permissions"] as? [String: Any])?["deny"] as? [String]) ?? []
    for rule in WorkerFence.denyRules(talosHome: r.talosHome) { #expect(deny.contains(rule), "\(rule)") }
    #expect(!deny.contains { $0.hasPrefix("!") })
    #expect(r.settingsOnDisk["disableClaudeAiConnectors"] == nil)
    #expect(!r.lines(r.envLog + ".trip").contains("ENABLE_CLAUDEAI_MCP_SERVERS=false"))
    // what it was launched with is recorded
    #expect(r.wait(3) { r.entry("trip")?.launched != nil })
    let l = r.entry("trip")?.launched
    #expect(l?.cwd == r.agentDir && l?.model == "inherit" && l?.mcp_allow == nil)
  }

  @Test func aListLaunchesStrictWithTheGeneratedFileAndSaysOnceWhatWasNotFound() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig(#"{"mcp_allow":["github","nope"]}"#)
    let log = notices(r)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let file = r.talosHome + "/workers/trip/mcp/mcp.json"
    let argv = r.argv(1)
    let i = try #require(argv.firstIndex(of: "--strict-mcp-config"))
    #expect(Array(argv[i...(i + 3)]) == ["--strict-mcp-config", "--mcp-config", file, "--no-chrome"])
    #expect(argv.suffix(2).first == "--session-id")
    var st = stat()
    #expect(lstat(file, &st) == 0 && st.st_mode & 0o777 == 0o600)
    #expect(lstat(r.talosHome + "/workers/trip/mcp", &st) == 0 && st.st_mode & 0o777 == 0o700)
    let servers = (try JSONSerialization.jsonObject(with: try #require(FileManager.default.contents(atPath: file))) as? [String: Any])?["mcpServers"] as? [String: Any]
    #expect(Set(servers?.keys.map { $0 } ?? []) == ["talos-app", "github"])
    #expect(r.lines(r.envLog + ".trip").contains("ENABLE_CLAUDEAI_MCP_SERVERS=false"))
    #expect(r.settingsOnDisk["disableClaudeAiConnectors"] as? Bool == true)
    // the missing server is said once, plainly, with no value from any definition anywhere
    #expect(r.wait(5) { log.all.count >= 1 })
    usleep(1_500_000)
    let said = log.all.filter { $0.text.contains("nope") }
    #expect(said.count == 1 && said.first?.thread == "trip", "\(log.all)")
    #expect(said.first?.text == LaunchChange.missingServersLine(["nope"]))
    // no secret in anything the app writes or says
    let written = [r.talosHome + "/workers.json", r.talosHome + "/workers/trip/settings.json", r.talosHome + "/workers/trip/notice.json"]
    for p in written { #expect(!(String(data: FileManager.default.contents(atPath: p) ?? Data(), encoding: .utf8) ?? "").contains(secret), "\(p)") }
    #expect(!log.all.contains { $0.text.contains(secret) })
    #expect(!r.starts.joined().contains(secret))
    #expect(r.entry("trip")?.launched?.mcp_allow == ["github", "nope"])
  }

  @Test func anEmptyListIsStrictWithTalosAppOnly() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig(#"{"mcp_allow":[]}"#)
    _ = notices(r)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.argv(1).contains("--strict-mcp-config") && r.argv(1).contains("--no-chrome"))
    #expect(r.entry("trip")?.launched?.mcp_allow == [])
  }

  @Test func anUnapprovedProjectServerIsNotLaunchedAndTheThreadIsToldHowToFixItOnce() throws {
    let r = try rig()
    defer { r.teardown() }
    // `local-db` is in the thread folder's .mcp.json and the owner has not approved it there
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a","mcp_allow":["github","local-db"]}"#)
    let log = notices(r)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "mode_escalation_denied")
    #expect(r.entry("trip")?.error?.axis == "mcp")
    #expect(r.starts.isEmpty, "nothing was launched")
    #expect(r.wait(5) { log.all.count >= 1 })
    usleep(1_000_000)
    #expect(log.all.count == 1, "\(log.all)")
    let text = log.all.first?.text ?? ""
    #expect(text.contains("local-db") && text.contains("claude mcp add -s local local-db") && text.contains("approve it once in Claude Code"), "\(text)")
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/mcp/mcp.json") || r.starts.isEmpty)
  }

  @Test func anApprovedProjectServerAndALocalOneLaunchAndEachIsLoggedWithItsScope() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.ownerRecord(r.home + "/proj-a", local: ["scoped": ["command": "scoped-mcp"]], approve: ["local-db"])
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a","mcp_allow":["github","local-db","scoped"]}"#)
    let audit = r.root + "/audit.log"
    _ = notices(r)
    r.mgr.tune { $0.auditLogPath = audit }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    let file = r.talosHome + "/workers/trip/mcp/mcp.json"
    let servers = (try JSONSerialization.jsonObject(with: try #require(FileManager.default.contents(atPath: file))) as? [String: Any])?["mcpServers"] as? [String: Any]
    #expect(Set(servers?.keys.map { $0 } ?? []) == ["talos-app", "github", "local-db", "scoped"])
    let lines = r.lines(audit)
    #expect(lines.contains { $0.contains("thread=trip") && $0.contains("server=local-db") && $0.contains("scope=project") }, "\(lines)")
    #expect(lines.contains { $0.contains("thread=trip") && $0.contains("server=scoped") && $0.contains("scope=local") }, "\(lines)")
    #expect(!lines.contains { $0.contains("server=github") }, "a user-scope server is not an own-folder one")
    #expect(!lines.joined().contains(secret))
  }

  @Test func aNarrowerSpecThanMainLaunches() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a","mcp_allow":["github"]}"#)
    _ = notices(r)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
  }

  @Test func aGuardsDefaultModeIsMainsOwnAndLaunches_andMainsModeBeatsTheFoldersSettings() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a"}"#)
    try FileManager.default.createDirectory(atPath: r.talosHome + "/guards", withIntermediateDirectories: true)
    try #"{"permissions":{"defaultMode":"bypassPermissions"}}"#.write(toFile: r.talosHome + "/guards/settings.json", atomically: true, encoding: .utf8)
    // the thread folder asks for acceptEdits
    try r.put(r.home + "/proj-a/.claude/settings.local.json", ["permissions": ["defaultMode": "acceptEdits"]])
    _ = notices(r)
    r.mgr.tune { $0.permissionFlag = nil }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    #expect((r.settingsOnDisk["permissions"] as? [String: Any])?["defaultMode"] as? String == "bypassPermissions", "main's, not the folder's")
  }

  @Test func mainsRealLaunchArgsSetTheWorkersDefaultMode() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a"}"#)
    try r.put(r.home + "/proj-a/.claude/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    _ = notices(r)
    r.mgr.tune {
      $0.permissionFlag = nil
      $0.mainArgs = ["--model", "opus", "--permission-mode", "plan"]
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect((r.settingsOnDisk["permissions"] as? [String: Any])?["defaultMode"] as? String == "plan")
  }

  @Test func theDenyRulesOfMainsFolderAndGuardsReachTheWorker() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig()
    try r.put(r.agentDir + "/.claude/settings.json", ["permissions": ["deny": ["Bash(rm:*)", "Read(./.env)"]]])
    try r.put(r.talosHome + "/guards/settings.json", ["permissions": ["deny": ["Bash(claude plugin:*)"]]])
    _ = notices(r)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let deny = ((r.settingsOnDisk["permissions"] as? [String: Any])?["deny"] as? [String]) ?? []
    #expect(deny.contains("Bash(rm:*)") && deny.contains("Bash(claude plugin:*)"))
    #expect(deny.contains("Read(/\(r.agentDir)/.env)") && !deny.contains("Read(./.env)"), "anchored at the agent folder, not at the worker's")
    for rule in WorkerFence.denyRules(talosHome: r.talosHome) { #expect(deny.contains(rule), "\(rule)") }
  }
}

@Suite("Lead fence: a live change", .serialized, .enabled(if: Rig.hasTmux))
struct LeadFenceChangeTests {
  func rig(extra: [String: String] = [:]) throws -> WorkerRig {
    let r = try WorkerRig(scenario: scenario, extraEnv: extra)
    r.env["FAKE_ARGV_DUMP"] = r.root + "/argv"
    r.env["FAKE_STATE_DIR"] = r.root + "/fake-state"  // numbers the starts, so the nth start has its own argv dump
    try r.fenceWorld()
    return r
  }

  func go(_ r: WorkerRig, settle: Double = 1, busyWindow: Double = 0.5) -> NoticeLog {
    let log = NoticeLog()
    r.manager(busyWindow: busyWindow)
    r.trackNotices(log)
    r.mgr.tune { $0.launchChangeSettle = settle }
    return log
  }

  @Test func aNewModelOrEffortOrListRestartsTheSameConversation() throws {
    for (n, opts) in [#"{"model":"sonnet"}"#, #"{"effort":"high"}"#, #"{"mcp_allow":["notes"]}"#].enumerated() {
      let r = try rig()
      defer { r.teardown() }
      try r.fenceConfig()
      _ = go(r)
      r.mgr.startTicking()
      try r.wake("trip")
      #expect(r.wait(10) { r.up("trip") }, "\(n) \(r.why("trip"))")
      let sid = try #require(r.entry("trip")?.session_id)
      try r.fenceConfig(opts)
      #expect(r.wait(15) { r.starts.count == 2 && r.up("trip") }, "\(opts) \(r.why("trip"))")
      #expect(r.argv(2).suffix(2) == ["--resume", sid], "resumed, not fresh: \(r.argv(2))")
      #expect(r.entry("trip")?.session_id == sid && r.entry("trip")?.previous_ids == [])
      #expect(r.wait(3) { r.entry("trip")?.launched != nil })
    }
  }

  @Test func aNewFolderStartsAFreshConversationAndTheThreadIsToldOnce() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-a"}"#)
    let log = go(r)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let old = try #require(r.entry("trip")?.session_id)
    try r.fenceConfig(#"{"cwd":"\#(r.home)/proj-b"}"#)
    #expect(r.wait(15) { r.starts.count == 2 && r.up("trip") }, "\(r.why("trip"))")
    let now = try #require(r.entry("trip")?.session_id)
    #expect(now != old && r.entry("trip")?.previous_ids == [old])
    #expect(r.argv(2).contains("--session-id") && !r.argv(2).contains("--resume"))
    #expect(r.entry("trip")?.cwd == r.home + "/proj-b")
    #expect(r.wait(5) { log.all.contains { $0.text == LaunchChange.folderLine(r.home + "/proj-b") } }, "\(log.all)")
    usleep(1_500_000)
    #expect(log.all.filter { $0.text.hasPrefix("Started a new conversation") }.count == 1, "\(log.all)")
  }

  @Test func twoEditsInsideTheWaitAreOneRestartWithTheFinalConfig() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig()
    _ = go(r, settle: 3)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    try r.fenceConfig(#"{"model":"sonnet"}"#)
    usleep(1_200_000)
    #expect(r.starts.count == 1, "the wait has not run out")
    try r.fenceConfig(#"{"model":"sonnet","effort":"high"}"#)
    #expect(r.wait(20) { r.starts.count == 2 && r.up("trip") }, "\(r.why("trip"))")
    usleep(4_500_000)
    #expect(r.starts.count == 2, "one restart for two edits")
    let argv = r.argv(2)
    #expect(argv.contains("sonnet"))
    #expect((r.settingsOnDisk["effortLevel"] as? String) == "high")
  }

  @Test func anEditPutBackRestartsNothing() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig()
    _ = go(r, settle: 3)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    try r.fenceConfig(#"{"model":"sonnet"}"#)
    usleep(1_200_000)
    try r.fenceConfig()
    usleep(5_000_000)
    #expect(r.starts.count == 1 && r.up("trip"))
  }

  @Test func aBusyTurnIsNeverCutAndTheRestartWaitsForItsEnd() throws {
    let r = try rig(extra: ["FAKE_RV_NOISE": "trip", "FAKE_RV_QUIET_ONCE": "1"])
    defer { r.teardown() }
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    try r.fenceConfig()
    _ = go(r, busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "busy" }, "\(r.why("trip"))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.fenceConfig(#"{"model":"sonnet"}"#)
    #expect(r.wait(10) { r.state("trip") == "stopping" }, "\(r.why("trip"))")
    usleep(3_000_000)
    #expect(r.state("trip") == "stopping" && ProcessInspect.groupAlive(pid), "the running turn was cut")
    #expect(r.starts.count == 1)
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    #expect(r.wait(20) { r.starts.count == 2 }, "\(r.why("trip"))")
  }

  @Test func aConfigChangeNeverCutsALongTurnNotEvenAfterTheOwnersStopLimit() throws {
    let r = try rig(extra: ["FAKE_RV_NOISE": "trip", "FAKE_RV_QUIET_ONCE": "1"])
    defer { r.teardown() }
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    try r.fenceConfig()
    _ = go(r, busyWindow: 2.5)
    r.mgr.tune { $0.stopLimit = 1.5 }  // an owner's tap would give up on the turn after this long
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "busy" }, "\(r.why("trip"))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.fenceConfig(#"{"model":"sonnet"}"#)
    #expect(r.wait(10) { r.state("trip") == "stopping" }, "\(r.why("trip"))")
    usleep(5_000_000)  // well past the limit
    #expect(r.state("trip") == "stopping" && ProcessInspect.groupAlive(pid), "the running turn was cut by a config change")
    #expect(r.starts.count == 1)
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    #expect(r.wait(20) { r.starts.count == 2 }, "\(r.why("trip"))")
  }

  @Test func aWorkerWithNoRecordOfItsLaunchIsNotRestartedUntilItsNextStart() throws {
    let r = try rig()
    defer { r.teardown() }
    try r.fenceConfig()
    _ = go(r)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(3) { r.fileOnDisk?.threads["trip"]?.launched != nil })
    r.mgr.detach()
    // the file as an older build left it: no `launched`
    var f = try #require(r.fileOnDisk)
    f.threads["trip"]?.launched = nil
    try f.encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    try r.fenceConfig(#"{"model":"sonnet","effort":"low","mcp_allow":[]}"#)
    _ = go(r)
    r.firstTick()
    r.mgr.startTicking()
    usleep(4_000_000)
    #expect(r.starts.count == 1 && r.up("trip"), "a restart storm after an upgrade: \(r.why("trip"))")
    // the next start records it
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(15) { r.state("trip") == "parked" })
    try r.wake("trip")
    #expect(r.wait(15) { r.starts.count == 2 && r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(3) { r.entry("trip")?.launched?.model == "sonnet" })
    #expect(r.entry("trip")?.launched?.mcp_allow == [])
  }
}

import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// `Talos --update-check` (WorkerUpdateCheck.swift): the read-only report of what an update would restart, against sessions the real
/// start launched (real private tmux, the fake claude) and then read by a manager of its own that never ticks, as the command makes it.
@Suite("Update check report (Mac)", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUpdateCheckTests {
  static let secrets = ["SECRETNAME", "SECRETPATH", "SECRETFILE", "SECRETENV", "SECRETSETTING", "SECRETCFG", "SECRETKEY", "sha256:"]

  /// A report manager as `UpdateCheckCLI` makes one: the rig's launch settings, a tmux that only logs that it was called, the audit
  /// log the rig's manager used (so an audit would be seen), and never a tick.
  static func reportManager(_ r: WorkerRig, tmuxLog: String, launchEnv: [String: String], baseEnv: [String: String]? = nil) throws
    -> WorkerManager
  {
    let fake = (tmuxLog as NSString).deletingLastPathComponent + "/tmux"
    try "#!/bin/sh\necho called >> '\(tmuxLog)'\nexit 1\n".write(toFile: fake, atomically: true, encoding: .utf8)
    chmod(fake, 0o755)
    var o = WorkerManager.Options(
      talosHome: r.talosHome, agentDir: r.agentDir, claudePath: Rig.fixtures + "/claude", permissionFlag: "--dangerously-skip-permissions",
      tmux: fake, tmuxConf: "/nonexistent")
    o.permissionHook = r.hookSource
    o.home = r.root + "/home"
    o.auditLogPath = r.auditPath
    let e = baseEnv ?? r.env
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e })
    m.updateRestart.launchEnv = { launchEnv }
    m.postNotice = { _, _ in
      Issue.record("the report posted a line")
      return .failed
    }
    return m
  }

  static func run(_ m: WorkerManager, _ args: [String] = [], loginEnvKnown: Bool = true) -> (code: Int32, out: [String], err: [String]) {
    var out: [String] = []
    var err: [String] = []
    let code = UpdateCheckCommand.run(args, out: { out.append($0) }, err: { err.append($0) }, check: { m.updateCheck(loginEnvKnown: loginEnvKnown) })
    return (code, out, err)
  }

  static func editWorkers(_ r: WorkerRig, _ edit: (inout [String: Any]) -> Void) throws {
    let path = r.talosHome + "/workers.json"
    var root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any])
    var threads = root["threads"] as? [String: Any] ?? [:]
    edit(&threads)
    root["threads"] = threads
    try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]).write(to: URL(fileURLWithPath: path))
  }

  static func config(_ r: WorkerRig, _ threads: [(id: String, opts: String)]) throws {
    // a thread's display name, a stray setting and an entry that is not a thread (said once by the app, never by the report)
    let list = threads.map {
      "{\"id\":\"\($0.id)\",\"name\":\"SECRETNAME \($0.id)\",\"kind\":\"fixed\",\"session\":\"dedicated\",\"session_opts\":{\($0.opts)}}"
    }.joined(separator: ",")
    try """
    {"default_thread":"general","note":"SECRETCFG","dedicated":{"enabled":true,"max_live":6},"threads":[{"id":"general","kind":"fixed"},\(list),7]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
  }

  /// Five sessions the real start launched (two in the agent folder, three in folders of their own) and three records written by hand
  /// (an older build's, one whose folder is gone, one parked); then the edits that make each state. Every secret-looking string sits
  /// where a careless report could print it.
  /// `base`: the environment the sessions start on, made from the rig's (nil: the rig's own).
  static func fixture(base: ((WorkerRig) -> [String: String])? = nil) throws -> (r: WorkerRig, folders: [String: String], launchEnv: [String: String]) {
    let r = try WorkerRig(threads: [], extraEnv: ["MY_TOKEN": "SECRETENV"])
    if let base { r.env = base(r) }
    let launchEnv = ["API_KEY": "SECRETSETTING"]
    var folders: [String: String] = [:]
    for id in ["proj", "both", "turn", "gone"] {
      let d = r.root + "/home/\(id)-SECRETPATH"
      try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
      try "SECRETFILE: how to work in \(id)\n".write(toFile: d + "/CLAUDE.md", atomically: true, encoding: .utf8)
      folders[id] = d
    }
    try "SECRETFILE agent folder rules\n".write(toFile: r.agentDir + "/CLAUDE.md", atomically: true, encoding: .utf8)
    try r.instructions("agent", "You are the agent thread. SECRETFILE")
    func opts(_ id: String, model: String? = nil) -> String {
      ([folders[id].map { "\"cwd\":\"\($0)\"" }] + [model.map { "\"model\":\"\($0)\"" }]).compactMap { $0 }.joined(separator: ",")
    }
    let all = ["trip", "agent", "proj", "both", "turn", "old", "gone", "nap"]
    try config(r, all.map { ($0, opts($0)) })
    r.makeManager().updateRestart.launchEnv = { launchEnv }
    r.mgr.startTicking()
    for id in ["trip", "agent", "proj", "both", "turn"] {
      try r.wake(id)
      #expect(r.wait(15) { r.liveCount(id) == 1 }, "\(r.why(id))")
    }
    #expect(r.launched("proj")?.instructions_hash != nil, "a session outside the agent folder records its instructions' digest")
    #expect(r.launched("trip")?.instructions_hash == nil && r.launched("agent")?.instructions_hash == nil, "never in the agent folder")
    r.mgr.detach()
    usleep(300_000)
    // the edits: instructions only, instructions and a setting, a setting while in a turn, the agent folder's thread's own instructions,
    // the agent folder's own CLAUDE.md (never hashed: its sessions stay unchanged)
    try "SECRETFILE: edited\n".write(toFile: folders["proj"]! + "/CLAUDE.md", atomically: true, encoding: .utf8)
    try "SECRETFILE: edited too\n".write(toFile: folders["both"]! + "/CLAUDE.md", atomically: true, encoding: .utf8)
    try r.instructions("agent", "You are the agent thread, edited. SECRETFILE")
    try "SECRETFILE agent folder rules, edited\n".write(toFile: r.agentDir + "/CLAUDE.md", atomically: true, encoding: .utf8)
    try config(r, all.map { id in (id, opts(id, model: id == "both" || id == "turn" ? "opus" : nil)) })
    let sid = r.entry("trip")?.session_id ?? "11111111-2222-4333-8444-555555555555"
    try editWorkers(r) { threads in
      // the fake's sessions answered their first message: out of their turn (only "turn" is in one)
      for id in ["trip", "agent", "proj", "both"] {
        var e = threads[id] as? [String: Any] ?? [:]
        e["state"] = "live"
        e["turn_started_at"] = nil
        threads[id] = e
      }
      var turn = threads["turn"] as? [String: Any] ?? [:]
      turn["state"] = "busy"
      turn["turn_started_at"] = ISOTime.string(Date().timeIntervalSince1970)
      threads["turn"] = turn
      // an older build's record: running, no launch record
      threads["old"] = ["state": "live", "session_id": sid, "tmux": "t-old", "cwd": r.agentDir]
      // a running session whose folder has gone: a start now is refused
      threads["gone"] = ["state": "live", "session_id": sid, "tmux": "t-gone", "cwd": folders["gone"]!,
                         "launched": ["cwd": folders["gone"]!, "model": "inherit", "spec_hash": "sha256:" + String(repeating: "a", count: 64)]]
      // parked: its next start takes the new spec anyway, so an update restarts nothing
      threads["nap"] = ["state": "parked", "session_id": sid, "tmux": "t-nap", "cwd": r.agentDir]
      // a key that is no thread id, with text that would paint the screen
      threads["\u{1b}[31mSECRETKEY\nfake  unchanged"] = ["state": "live", "session_id": sid, "tmux": "t-x", "cwd": r.agentDir]
    }
    try FileManager.default.removeItem(atPath: folders["gone"]!)
    return (r, folders, launchEnv)
  }

  static let expected = [
    "agent  spec changed", "both  spec changed", "gone  unknown (dry plan refused)", "old  no record", "proj  instructions changed",
    "trip  unchanged", "turn  busy (would wait)", "7 sessions: 1 unchanged, 4 to restart, 1 no record, 1 unknown",
  ]

  @Test func eachStateFromRealStartsAndTheOutputHoldsOnlyIdsStatesAndTheCount() throws {
    let (r, _, launchEnv) = try Self.fixture()
    defer { r.teardown() }
    let log = r.root + "-tmux/calls"
    try FileManager.default.createDirectory(atPath: (log as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: (log as NSString).deletingLastPathComponent) }
    let m = try Self.reportManager(r, tmuxLog: log, launchEnv: launchEnv)
    let res = Self.run(m)
    #expect(res.code == 0)
    #expect(res.err == [])
    #expect(res.out == Self.expected, "\(res.out) \(r.auditLines)")
    let text = (res.out + res.err).joined(separator: "\n")
    for s in Self.secrets { #expect(!text.contains(s), "\(s) in the output") }
    for l in res.out.dropLast() { #expect(l.range(of: #"^[a-z][a-z0-9_]*  (unchanged|spec changed|instructions changed|no record|busy \(would wait\)|unknown \(dry plan refused\))$"#, options: .regularExpression) != nil, "\(l)") }
    #expect(!text.contains(r.root) && !text.contains("/"), "no path")
    #expect(!FileManager.default.fileExists(atPath: log), "tmux was run")
    // the same look twice gives the same answer (nothing of the first stayed in the manager)
    #expect(Self.run(m).out == Self.expected)
  }

  @Test func itWritesCreatesAndAuditsNothingAndTakesNoLockWhileTheAppHoldsIt() throws {
    let (r, _, launchEnv) = try Self.fixture()
    defer { r.teardown() }
    let log = r.root + "-tmux/calls"
    try FileManager.default.createDirectory(atPath: (log as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: (log as NSString).deletingLastPathComponent) }
    // the running app's lock, held: the report neither waits for it nor takes it
    let fd = open(r.talosHome + "/workers.lock", O_RDWR | O_CREAT, 0o600)
    #expect(fd >= 0 && flock(fd, LOCK_EX | LOCK_NB) == 0)
    defer { close(fd) }
    // the files a start writes for a session, gone: the dry plan must not put any back
    for f in ["settings.json", "mcp.json", "nonce"] { unlink(r.talosHome + "/workers/proj/" + f) }
    try? FileManager.default.removeItem(atPath: r.talosHome + "/workers/_hook")
    let tree = r.tree()
    let audit = r.auditLines
    let m = try Self.reportManager(r, tmuxLog: log, launchEnv: launchEnv)
    #expect(Self.run(m).out == Self.expected)
    #expect(r.tree() == tree, "\(Set(r.tree().map { "\($0.key) \($0.value)" }).symmetricDifference(tree.map { "\($0.key) \($0.value)" }))")
    #expect(r.auditLines == audit, "\(r.auditLines.dropFirst(audit.count))")
    #expect(!FileManager.default.fileExists(atPath: log))
    #expect(m.isActive == false)
  }

  @Test func exitStatusesAndTheLinesForEach() throws {
    let r = try WorkerRig(threads: ["trip"])
    defer { r.teardown() }
    let log = r.root + "/tmux-calls"
    let m = try Self.reportManager(r, tmuxLog: log, launchEnv: [:])
    // no workers.json: nothing runs, exit 0
    #expect(Self.run(m).out == ["0 sessions: 0 unchanged, 0 to restart, 0 no record, 0 unknown"])
    #expect(Self.run(m).code == 0)
    // a usage error and help: nothing is read (the check is never called)
    var called = false
    var out: [String] = []
    var err: [String] = []
    let code = UpdateCheckCommand.run(["--bogus-SECRETKEY"], out: { out.append($0) }, err: { err.append($0) }, check: {
      called = true
      return .rows([])
    })
    #expect(code == 2 && out.isEmpty && err.count == 1 && !called && !err[0].contains("SECRETKEY"))
    let help = UpdateCheckCommand.run(["--help"], out: { out.append($0) }, err: { _ in }, check: {
      called = true
      return .rows([])
    })
    #expect(help == 0 && !called)
    #expect(out.last?.contains(UpdateCheck.agentFolderNote) == true)
    // a running session, then the config unreadable, then the login shell unknown: unknown, exit 0
    let sid = "11111111-2222-4333-8444-555555555555"
    var e = WorkersFile.Entry(threadId: "trip", cwd: r.agentDir)
    e.state = "live"
    e.session_id = sid
    try WorkersFile(supervisor: .init(pid: 1, heartbeat_at: ISOTime.string(Date().timeIntervalSince1970), workers_supported: true, main_pane_pid: 0),
      threads: ["trip": e]).encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    #expect(Self.run(m).out == ["trip  no record", "1 sessions: 0 unchanged, 0 to restart, 1 no record, 0 unknown"])
    #expect(Self.run(m, loginEnvKnown: false).out == ["trip  unknown (dry plan refused)", "1 sessions: 0 unchanged, 0 to restart, 0 no record, 1 unknown"])
    let cfg = try String(contentsOfFile: r.talosHome + "/config.json", encoding: .utf8)
    try "{ half a file".write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    let noCfg = Self.run(m)
    #expect(noCfg.code == 0 && noCfg.out == ["trip  unknown (dry plan refused)", "1 sessions: 0 unchanged, 0 to restart, 0 no record, 1 unknown"])
    try cfg.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    // workers.json that cannot be read: exit 1, one line, no path
    let path = r.talosHome + "/workers.json"
    let good = try Data(contentsOf: URL(fileURLWithPath: path))
    try Data("{\"v\":1,\"threads\":".utf8).write(to: URL(fileURLWithPath: path))
    var bad = Self.run(m)
    #expect(bad.code == 1 && bad.out.isEmpty && bad.err == [UpdateCheck.unreadable])
    try good.write(to: URL(fileURLWithPath: path))
    chmod(path, 0o000)
    bad = Self.run(m)
    chmod(path, 0o600)
    #expect(bad.code == 1 && bad.out.isEmpty && bad.err == [UpdateCheck.unreadable])
    #expect(!bad.err[0].contains(r.root))
    #expect(Self.run(m).code == 0)
    #expect(!FileManager.default.fileExists(atPath: log))
  }

  // MARK: the caller's environment and desktop.json (Fable R1-1, R1-2)

  /// What the caller (a Terminal) has: the rig's home, and nothing else of its own.
  static func cleanCaller(_ r: WorkerRig) -> [String: String] {
    ["HOME": r.root + "/home", "USER": "alex", "LOGNAME": "alex", "SHELL": "/bin/zsh", "TMPDIR": NSTemporaryDirectory(), "LANG": "en_US.UTF-8"]
  }

  /// The rig's fake-claude switches, as desktop.json `env` would carry them (they ride over the login shell's).
  static func overrides(_ r: WorkerRig) -> [String: String] { r.env.filter { !["PATH", "HOME", "LANG"].contains($0.key) } }

  @Test func theLoginShellIsReadFromLaunchdsFewVariablesNeverTheCallers() throws {
    let caller = ["HOME": "/home/alex", "USER": "alex", "PATH": "/home/alex/venv/bin:/usr/bin", "CLAUDE_CONFIG_DIR": "/home/alex/other",
                  "VIRTUAL_ENV": "/home/alex/venv", "TALOS_APP_HOME": "/home/alex/elsewhere", "LANG": ""]
    let seed = UpdateCheckLaunch.seed(caller: caller)
    #expect(seed == ["HOME": "/home/alex", "USER": "alex", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"])
    var given: [String: String]?
    let built = UpdateCheckLaunch.baseEnv(caller: caller, overrides: ["X": "1"]) { s in
      given = s
      return nil
    }
    #expect(given == seed, "the shell is started with the seed alone")
    #expect(built.shell == nil && built.env["CLAUDE_CONFIG_DIR"] == nil && built.env["VIRTUAL_ENV"] == nil && built.env["X"] == "1")
  }

  @Test func aHostileCallerEnvironmentGivesTheSameStatesAsACleanOne() throws {
    // the sessions start on what a clean caller's report works out (the real login shell, from the seed)
    let (r, _, launchEnv) = try Self.fixture { r in
      UpdateCheckLaunch.baseEnv(caller: Self.cleanCaller(r), overrides: Self.overrides(r)).env
    }
    defer { r.teardown() }
    let log = r.root + "-tmux/calls"
    try FileManager.default.createDirectory(atPath: (log as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: (log as NSString).deletingLastPathComponent) }
    // a Terminal with a fake claude and python3 first on its PATH, a venv and another Claude config folder
    let bin = r.root + "/home/hostile-bin"
    try FileManager.default.createDirectory(atPath: bin, withIntermediateDirectories: true)
    for tool in ["claude", "python3"] {
      try "#!/bin/sh\nexit 0\n".write(toFile: bin + "/" + tool, atomically: true, encoding: .utf8)
      chmod(bin + "/" + tool, 0o755)
    }
    var hostile = Self.cleanCaller(r)
    hostile["PATH"] = bin + ":/usr/bin:/bin"
    hostile["CLAUDE_CONFIG_DIR"] = r.root + "/home/other-claude"
    hostile["VIRTUAL_ENV"] = r.root + "/home/venv"
    hostile["PYTHONPATH"] = r.root + "/venv-lib"
    let clean = UpdateCheckLaunch.baseEnv(caller: Self.cleanCaller(r), overrides: Self.overrides(r))
    let fromTerminal = UpdateCheckLaunch.baseEnv(caller: hostile, overrides: Self.overrides(r))
    #expect(clean.shell != nil && fromTerminal.shell != nil, "the real login shell was read")
    let a = Self.run(try Self.reportManager(r, tmuxLog: log, launchEnv: launchEnv, baseEnv: clean.env))
    let b = Self.run(try Self.reportManager(r, tmuxLog: log, launchEnv: launchEnv, baseEnv: fromTerminal.env))
    #expect(a.out == Self.expected, "\(a.out)")
    #expect(b.out == a.out, "\(b.out)")
  }

  @Test func anUnreadableDesktopJsonIsSaidOnceAndEveryRunningSessionIsUnknown() throws {
    let (r, _, launchEnv) = try Self.fixture()
    defer { r.teardown() }
    let log = r.root + "-tmux/calls"
    try FileManager.default.createDirectory(atPath: (log as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: (log as NSString).deletingLastPathComponent) }
    // the file as the CLI reads it: half a file, a value of the wrong kind, one it may not open; missing is not unreadable
    let path = r.root + "/desktop-SECRETPATH.json"
    func read() -> (DesktopConfig, Bool) { UpdateCheckLaunch.config(ConfigFile.read(path)) { DesktopConfig.defaults } }
    #expect(read().1 == true, "no file: the start-up config")
    for text in ["{ half", "{\"agent_dir\":7}", ""] {
      try text.write(toFile: path, atomically: true, encoding: .utf8)
      #expect(read().1 == false, "\(text)")
    }
    try DesktopConfig.defaults.encoded().write(to: URL(fileURLWithPath: path))
    #expect(read().1 == true)
    chmod(path, 0o000)
    #expect(read().1 == false)
    chmod(path, 0o600)
    // the report: one line on stderr, no path, every running session unknown, exit 0
    let m = try Self.reportManager(r, tmuxLog: log, launchEnv: launchEnv)
    var out: [String] = []
    var err: [String] = []
    let code = UpdateCheckCommand.run([], out: { out.append($0) }, err: { err.append($0) }) {
      m.updateCheck(loginEnvKnown: true, launchSettingsKnown: false)
    }
    #expect(code == 0)
    #expect(err == ["the app's launch settings could not be read"])
    #expect(out == [
      "agent  unknown (dry plan refused)", "both  unknown (dry plan refused)", "gone  unknown (dry plan refused)",
      "old  unknown (dry plan refused)", "proj  unknown (dry plan refused)", "trip  unknown (dry plan refused)",
      "turn  unknown (dry plan refused)", "7 sessions: 0 unchanged, 0 to restart, 0 no record, 7 unknown",
    ])
  }
}

import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// A thread session's own live state file (`<agent>/threads/<id>.state.md`) on the Mac: the seed, the hook staged from the app's sealed
/// bundle, the settings that register it, the one allowed edit, and the environment flag that is set only with the hook. The Linux twin
/// is apps/bridge/src/supervisor/{thread-state-seed,worker-hook,worker-spec,worker-policy}.ts; swift-parity.test.ts holds the two together.
/// Fictional paths (/home/alex) only.

private func tempFolder(_ tag: String) throws -> String {
  let base = (TestTemp.base as NSString).appendingPathComponent("talos-ts-\(tag)-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
  return try TestTemp.real(base)
}

private func mode(_ p: String) -> mode_t {
  var st = stat()
  return lstat(p, &st) == 0 ? st.st_mode & 0o777 : 0
}

@Suite("ThreadStateSeed")
struct ThreadStateSeedTests {
  @Test func createsTheTemplateOnceAndNeverOverwritesIt() throws {
    let agent = try tempFolder("seed")
    defer { try? FileManager.default.removeItem(atPath: agent) }
    #expect(ThreadStateSeed.seed(agentDir: agent, id: "trip", name: "Trip") == .created)
    let file = ThreadStateSeed.path(agentDir: agent, id: "trip")
    #expect(file == agent + "/threads/trip.state.md")
    #expect(try String(contentsOfFile: file, encoding: .utf8) == ThreadStateSeed.template(id: "trip", name: "Trip"))
    #expect(mode(file) == 0o600)
    #expect(mode(agent + "/threads") == 0o700)
    try "my notes\n".write(toFile: file, atomically: true, encoding: .utf8)
    #expect(ThreadStateSeed.seed(agentDir: agent, id: "trip", name: "Trip") == .exists)
    #expect(try String(contentsOfFile: file, encoding: .utf8) == "my notes\n")
  }

  /// The same text as thread-state-seed.ts (swift-parity.test.ts compares the two sources).
  @Test func theTemplateIsTheAgreedOneNamedByTheDisplayNameElseTheId() {
    #expect(
      ThreadStateSeed.template(id: "trip", name: "Trip")
        == """
        # Trip live state (thread trip)
        READ FIRST after any restart or compaction. Rule: update THIS file the same turn anything here changes (an owner ask, a
        decision, a landing, a hold). Keep it under 8,000 characters; history goes in the thread or a log, not here.

        ## Owner asks open (newest first, dated)
        ## Waiting on the owner
        ## In flight
        ## CI (optional: leave empty if this thread does no builds)
        ## Rules learned

        """)
    #expect(ThreadStateSeed.template(id: "trip", name: nil).hasPrefix("# trip live state (thread trip)\n"))
    #expect(ThreadStateSeed.template(id: "trip", name: " \n ").hasPrefix("# trip live state"))
    // a name with a line break or a control character stays one heading line
    #expect(ThreadStateSeed.template(id: "trip", name: "A\nB## x").split(separator: "\n", omittingEmptySubsequences: false)[0] == "# A B## x live state (thread trip)")
    #expect(ThreadStateSeed.template(id: "trip", name: "A\u{7f}B").hasPrefix("# A B live state"))
    // and one short line
    let long = ThreadStateSeed.template(id: "trip", name: String(repeating: "x", count: 200))
    #expect(long.split(separator: "\n")[0].count == "# ".count + 80 + " live state (thread trip)".count)
  }

  @Test func aLinkedThreadsFolderOrStateFileIsRefusedAndNothingIsWrittenThroughIt() throws {
    let agent = try tempFolder("link")
    let out = try tempFolder("out")
    defer { for d in [agent, out] { try? FileManager.default.removeItem(atPath: d) } }
    try FileManager.default.createSymbolicLink(atPath: agent + "/threads", withDestinationPath: out)
    guard case .problem = ThreadStateSeed.seed(agentDir: agent, id: "trip", name: "Trip") else {
      Issue.record("a link at threads/ was accepted")
      return
    }
    #expect(!FileManager.default.fileExists(atPath: out + "/trip.state.md"))
    unlink(agent + "/threads")
    try FileManager.default.createDirectory(atPath: agent + "/threads", withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(atPath: agent + "/threads/trip.state.md", withDestinationPath: out + "/target.md")
    guard case .problem = ThreadStateSeed.seed(agentDir: agent, id: "trip", name: "Trip") else {
      Issue.record("a link at the state file was accepted")
      return
    }
    #expect(!FileManager.default.fileExists(atPath: out + "/target.md"))
  }

  @Test func aThreadsEntryThatIsNotAFolderIsAProblemNotASeed() throws {
    let agent = try tempFolder("file")
    defer { try? FileManager.default.removeItem(atPath: agent) }
    try "x".write(toFile: agent + "/threads", atomically: true, encoding: .utf8)
    guard case .problem(let why) = ThreadStateSeed.seed(agentDir: agent, id: "trip", name: nil) else {
      Issue.record("a plain file at threads/ was accepted")
      return
    }
    #expect(why.contains("is not a plain folder"))
  }

  @Test func anAgentFolderReachedThroughALinkStillSeedsIntoTheRealOne() throws {
    let root = try tempFolder("via")
    defer { try? FileManager.default.removeItem(atPath: root) }
    try FileManager.default.createDirectory(atPath: root + "/real", withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(atPath: root + "/link", withDestinationPath: root + "/real")
    #expect(ThreadStateSeed.seed(agentDir: root + "/link", id: "trip", name: "Trip") == .created)
    #expect(FileManager.default.fileExists(atPath: root + "/real/threads/trip.state.md"))
  }

  @Test func aDryRunWritesNothingNotEvenTheFolder() throws {
    let agent = try tempFolder("dry")
    defer { try? FileManager.default.removeItem(atPath: agent) }
    #expect(ThreadStateSeed.seed(agentDir: agent, id: "trip", name: "Trip", dry: true) == .created)
    #expect(!FileManager.default.fileExists(atPath: agent + "/threads"))
  }

  /// Not an empty result: an agent folder the owner cannot write is a problem the caller audits.
  @Test func anAgentFolderThatCannotBeWrittenIsAProblem() throws {
    if getuid() == 0 { return }
    let agent = try tempFolder("ro")
    defer {
      chmod(agent, 0o700)
      try? FileManager.default.removeItem(atPath: agent)
    }
    chmod(agent, 0o500)
    guard case .problem = ThreadStateSeed.seed(agentDir: agent, id: "trip", name: "Trip") else {
      Issue.record("an unwritable agent folder read as seeded")
      return
    }
  }
}

/// The thread-state files the build puts beside the permission hook, taken from the bundle like the hook (WorkerHookSource.swift).
@Suite("WorkerHook: the thread-state hook is staged like the permission hook")
final class ThreadStateStagingTests {
  let root: String
  let app: FakeAppBundle
  var talosHome: String { root + "/talos home" }
  var hookDir: String { talosHome + "/workers/_hook" }
  let path = "/usr/bin:/bin"
  static let state: [String: Data] = [
    "thread-state.py": Data("print('state')\n".utf8), "compaction-guard.py": Data("print('guard')\n".utf8),
  ]

  init() throws {
    root = try tempFolder("stage")
    try FileManager.default.createDirectory(atPath: root + "/talos home", withIntermediateDirectories: true)
    app = try FakeAppBundle(in: root, script: Data("print('hook')\n".utf8), helper: Data("HELPER = 1\n".utf8), state: Self.state)
  }
  deinit { try? FileManager.default.removeItem(atPath: root) }

  func source() -> WorkerHook.BundleSource { .init(script: app.script, bundlePath: app.path, seal: { _ in nil }) }

  func installed(_ s: WorkerHook.BundleSource? = nil, dry: Bool = false) -> WorkerHook.Installed? {
    guard case .installed(let h, _) = WorkerHook.install(talosHome: talosHome, source: s ?? source(), path: path, dry: dry) else { return nil }
    return h
  }

  @Test func theVerifiedBytesAreCopiedBesideTheHookAndHandedBackForTheLaunchSpec() throws {
    let h = try #require(installed())
    #expect(Set((h.stateBytes ?? [:]).keys) == Set(WorkerHook.stateFileNames))
    for (name, bytes) in Self.state {
      #expect(FileManager.default.contents(atPath: hookDir + "/" + name) == bytes)
      #expect(mode(hookDir + "/" + name) == 0o600)
      #expect(h.stateBytes?[name] == bytes)
    }
    #expect(WorkerHook.stateScript(talosHome: talosHome) == hookDir + "/thread-state.py")
  }

  @Test func aDryPlanGivesTheSameBytesAndWritesNothing() throws {
    let h = try #require(installed(dry: true))
    #expect(Set((h.stateBytes ?? [:]).keys) == Set(WorkerHook.stateFileNames))
    #expect(!FileManager.default.fileExists(atPath: hookDir + "/thread-state.py"))
  }

  /// Claim: a release (bundle) with no state files gives a session with none, and no earlier copy is left to run in its place.
  @Test func aBundleWithoutThemGivesNoStateHookAndLeavesNoOldCopy() throws {
    _ = try #require(installed())
    #expect(FileManager.default.fileExists(atPath: hookDir + "/thread-state.py"))
    let old = try tempFolder("old")
    defer { try? FileManager.default.removeItem(atPath: old) }
    let bundle = try FakeAppBundle(in: old, script: Data("print('hook')\n".utf8), helper: Data("HELPER = 1\n".utf8))
    let h = try #require(installed(.init(script: bundle.script, bundlePath: bundle.path, seal: { _ in nil })))
    #expect(h.stateBytes == nil)
    for n in WorkerHook.stateFileNames { #expect(!FileManager.default.fileExists(atPath: hookDir + "/" + n), "\(n) left behind") }
  }

  @Test func withoutTheHelperTheyImportThereIsNoStateHook() throws {
    let nohelper = try tempFolder("nohelper")
    defer { try? FileManager.default.removeItem(atPath: nohelper) }
    let bundle = try FakeAppBundle(in: nohelper, script: Data("print('hook')\n".utf8), helper: nil, state: Self.state)
    let h = try #require(installed(.init(script: bundle.script, bundlePath: bundle.path, seal: { _ in nil })))
    #expect(h.stateBytes == nil)
    #expect(!FileManager.default.fileExists(atPath: hookDir + "/thread-state.py"))
  }

  @Test func oneOfTheTwoWithoutTheOtherIsNone() throws {
    unlink(app.stateFile("compaction-guard.py"))
    let h = try #require(installed())
    #expect(h.stateBytes == nil, "both or neither")
    #expect(!FileManager.default.fileExists(atPath: hookDir + "/thread-state.py"))
  }

  /// Same refusals as the hook itself: a state file that can be written or is a link fails the whole start, never a silent skip.
  @Test func aStateFileThatCanBeWrittenOrIsALinkIsRefusedLikeTheHookItself() throws {
    chmod(app.stateFile("compaction-guard.py"), 0o644)
    #expect(WorkerHook.install(talosHome: talosHome, source: source(), path: path)
      == .problem("the Talos app's \(app.stateFile("compaction-guard.py")) can be written, so the app's copy is not sealed"))
    chmod(app.stateFile("compaction-guard.py"), 0o444)
    unlink(app.stateFile("thread-state.py"))
    try FileManager.default.createSymbolicLink(atPath: app.stateFile("thread-state.py"), withDestinationPath: app.stateFile("compaction-guard.py"))
    #expect(WorkerHook.install(talosHome: talosHome, source: source(), path: path)
      == .problem("the Talos app's \(app.stateFile("thread-state.py")) is a link, not part of the signed app"))
    #expect(!FileManager.default.fileExists(atPath: hookDir + "/thread-state.py"), "nothing was copied")
  }

  /// Claim: only the bytes the signature check saw are staged; a state file edited after it is refused, nothing copied.
  @Test func aStateFileEditedAfterTheSignatureWasCheckedIsRefused() throws {
    let s = source()
    _ = try #require(installed(s))
    try FakeAppBundle.overwrite(app.stateFile("thread-state.py"), with: "print('edited')\n")
    guard case .problem(let why) = WorkerHook.install(talosHome: talosHome, source: s, path: path) else {
      Issue.record("an edited state file was staged")
      return
    }
    #expect(why.contains("changed after the app's signature was checked"))
    #expect(FileManager.default.contents(atPath: hookDir + "/thread-state.py") == Self.state["thread-state.py"], "the earlier copy is not replaced")
  }

  @Test func aLinkPlantedWhereTheHookFolderGoesIsRefusedAndNothingLandsBehindIt() throws {
    let elsewhere = try tempFolder("elsewhere")
    defer { try? FileManager.default.removeItem(atPath: elsewhere) }
    try FileManager.default.createDirectory(atPath: talosHome + "/workers", withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: hookDir, withDestinationPath: elsewhere)
    guard case .problem = WorkerHook.install(talosHome: talosHome, source: source(), path: path) else {
      Issue.record("a linked hook folder was accepted")
      return
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: elsewhere).isEmpty)
  }
}

/// The generated settings and environment.
@Suite("WorkerSpec: the thread-state hook")
struct ThreadStateSpecTests {
  static let stateBytes: [String: Data] = ["thread-state.py": Data("s".utf8), "compaction-guard.py": Data("g".utf8)]
  static func staged(_ python: String = "/usr/bin/python3") -> WorkerHook.Installed {
    .init(script: "/home/alex/.talos/workers/_hook/permission-relay.py", python: python, stateBytes: stateBytes)
  }

  /// The expected rule spellings for an agent folder: as given, then where it really is.
  func rules(_ agent: String, tail: String = "") -> [String] {
    var forms = [agent]
    if let r = realpath(agent, nil) {
      if String(cString: r) != agent { forms.append(String(cString: r)) }
      free(r)
    }
    return ["Edit", "Write"].flatMap { t in forms.map { "\(t)(/\($0)/threads/trip.state.md\(tail))" } }
  }

  func build(_ t: FenceTree, hook: WorkerHook.Installed?, base: [String: String]? = nil, cwd: String? = nil) throws -> WorkerSpec {
    var i = fenceInputs(t)
    if let hook { i.permissionHook = hook }
    if let base { i.baseEnv = base }
    if let cwd { i.cwd = cwd }
    return try WorkerSpec.build(i)
  }

  func hooks(_ s: WorkerSpec) -> [String: Any] { jsonObject(s.settingsJSON)?["hooks"] as? [String: Any] ?? [:] }
  func perms(_ s: WorkerSpec) -> [String: Any] { jsonObject(s.settingsJSON)?["permissions"] as? [String: Any] ?? [:] }

  @Test(arguments: [false, true])
  func theSettingsRegisterSessionStartAndPreCompactForAThreadInTheAgentFolderOrItsOwn(own: Bool) throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let s = try build(t, hook: Self.staged(), cwd: own ? t.cwd : t.agentDir)
    let script = t.talosHome + "/workers/_hook/thread-state.py"
    let start = try #require(hooks(s)["SessionStart"] as? [[String: Any]])
    let compact = try #require(hooks(s)["PreCompact"] as? [[String: Any]])
    #expect(start.count == 1 && compact.count == 1)
    #expect(start[0]["matcher"] as? String == "startup|resume|clear|compact|fork")
    #expect(compact[0]["matcher"] == nil)
    let inject = try #require((start[0]["hooks"] as? [[String: Any]])?.first)
    let save = try #require((compact[0]["hooks"] as? [[String: Any]])?.first)
    #expect(inject["timeout"] as? Int == 5 && save["timeout"] as? Int == 5)
    #expect(inject["type"] as? String == "command")
    let ic = try #require(inject["command"] as? String)
    let sc = try #require(save["command"] as? String)
    #expect(ic.hasPrefix("f='\(script)'; "))
    #expect(ic.hasSuffix(" inject '\(t.agentDir)' '/nonexistent'"))
    #expect(sc.hasSuffix(" save '\(t.agentDir)' '/nonexistent'"))
    for c in [ic, sc] {
      #expect(c.contains("-B -X \"pycache_prefix=$4\""))
      #expect(c.contains("CLAUDE_PROJECT_DIR='\(t.agentDir)'"))
      #expect(c.contains("TALOS_SESSION_ROLE=worker") && c.contains("TALOS_APP_WORKER_THREAD='trip'"))
      #expect(c.contains("/usr/bin/env -i"))
    }
    // the permission hook is still there, once
    #expect((hooks(s)["PermissionRequest"] as? [Any])?.count == 1)
  }

  @Test func theEnvironmentFlagIsSetExactlyWhenTheHookIsRegistered() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let with = try build(t, hook: Self.staged())
    #expect(with.env[WorkerHook.threadStateEnv] == "1")
    let none = try build(t, hook: nil)
    #expect(none.env[WorkerHook.threadStateEnv] == nil)
    #expect(hooks(none)["SessionStart"] == nil && hooks(none)["PreCompact"] == nil)
    #expect(perms(none)["allow"] == nil)
  }

  /// Claim: never inherited. A login environment that already carries the flag must not give it to a worker without the hook.
  @Test func aFlagInTheLoginEnvironmentIsNeverInheritedIntoASessionWithoutTheHook() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let base = ["PATH": "/usr/bin:/bin", "HOME": t.home, WorkerHook.threadStateEnv: "1"]
    #expect(try build(t, hook: nil, base: base).env[WorkerHook.threadStateEnv] == nil)
    #expect(try build(t, hook: Self.staged(), base: ["PATH": "/usr/bin:/bin", "HOME": t.home, WorkerHook.threadStateEnv: "0"]).env[WorkerHook.threadStateEnv] == "1")
  }

  @Test func theAllowRulesAreExactlyTheStateFileAndWhatIsUnderItIsDenied() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let s = try build(t, hook: Self.staged())
    #expect(perms(s)["allow"] as? [String] == rules(t.agentDir))
    let deny = perms(s)["deny"] as? [String] ?? []
    for r in rules(t.agentDir, tail: "/**") { #expect(deny.contains(r), "\(r)") }
    #expect(WorkerHook.stateAllowRules(agentDir: t.agentDir, threadId: "trip") == rules(t.agentDir))
    #expect(WorkerHook.stateDenyRules(agentDir: t.agentDir, threadId: "trip") == rules(t.agentDir, tail: "/**"))
  }

  /// Claim: the allow does not cover a sibling (another thread's file, a backup, a parent path), and no deny rule names the file itself.
  @Test func noDenyRuleCoversTheFileAndNoAllowRuleCoversASibling() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let s = try build(t, hook: Self.staged())
    let file = t.agentDir + "/threads/trip.state.md"
    func covers(_ rule: String, _ path: String) -> Bool {
      guard let open = rule.firstIndex(of: "("), rule.hasSuffix(")") else { return false }
      var p = String(rule[rule.index(after: open)..<rule.index(before: rule.endIndex)])
      p.removeFirst()  // the leading "/" of the `//abs` spelling
      if p.hasSuffix("/**") { return path.hasPrefix(String(p.dropLast(3)) + "/") }
      return path == p || path.hasPrefix(p + "/")
    }
    for r in perms(s)["deny"] as? [String] ?? [] where r.hasPrefix("Edit(") || r.hasPrefix("Write(") {
      #expect(!covers(r, file), "a deny rule covers the state file: \(r)")
    }
    let allow = perms(s)["allow"] as? [String] ?? []
    for sibling in ["threads/other.state.md", "threads/trip.state.md.bak", "threads/trip.state.md/x", "threads/../x", "threads", "CLAUDE.md"] {
      let denied = (perms(s)["deny"] as? [String] ?? []).contains { covers($0, t.agentDir + "/" + sibling) }
      let allowed = allow.contains { covers($0, t.agentDir + "/" + sibling) }
      #expect(!(allowed && !denied), "\(sibling) is writable without a prompt")
    }
  }

  /// A folder name Claude Code reads as a glob cannot be named by a rule: no allow rule (the session asks, the safe side).
  @Test func anAgentFolderWithAGlobCharacterGetsNoAllowRule() {
    for bad in ["/home/al*ex/agent", "/home/alex/a[1]/agent", "/home/alex/a(b)", "/home/alex/a b\"c", "/home/alex/a\nb", "relative/agent"] {
      #expect(WorkerHook.stateAllowRules(agentDir: bad, threadId: "trip").isEmpty, Comment(rawValue: bad))
      #expect(WorkerHook.stateDenyRules(agentDir: bad, threadId: "trip").isEmpty, Comment(rawValue: bad))
    }
    #expect(WorkerHook.stateAllowRules(agentDir: "/home/alex/agent", threadId: "../x").isEmpty)
    #expect(WorkerHook.stateAllowRules(agentDir: "/home/alex/agent", threadId: "Trip").isEmpty)
    #expect(WorkerHook.stateAllowRules(agentDir: "/home/alex/agent/", threadId: "trip") == ["Edit(//home/alex/agent/threads/trip.state.md)", "Write(//home/alex/agent/threads/trip.state.md)"])
  }

  /// The command the settings run. The Linux twin is the same text with its locale (swift-parity.test.ts holds the two together).
  @Test func theCommandIsTheCleanShellLineWithTheFixedValuesAsText() {
    let session = WorkerHook.Session(home: "/home/alex", talosHome: "/home/alex/.talos", threadId: "trip")
    let cmd = WorkerHook.stateCommand(
      script: "/home/alex/.talos/workers/_hook/thread-state.py", python: "/opt/homebrew/bin/python3.13", mode: "inject", session: session,
      agentDir: "/home/alex/agent")
    #expect(
      cmd == "f='/home/alex/.talos/workers/_hook/thread-state.py'; exec /usr/bin/env -i HOME='/home/alex' PATH=/usr/bin:/bin LANG=en_US.UTF-8 TALOS_SESSION_ROLE=worker TALOS_APP_WORKER_THREAD='trip' CLAUDE_PROJECT_DIR='/home/alex/agent' XDG_STATE_HOME=\"${XDG_STATE_HOME-}\" /bin/sh -c '[ -f \"$0\" ] || exit 0; exec \"$1\" -B -X \"pycache_prefix=$4\" -I -S \"$0\" \"$2\" \"$3\"' \"$f\" '/opt/homebrew/bin/python3.13' inject '/home/alex/agent' '/nonexistent'")
    let outer = cmd.components(separatedBy: " /bin/sh -c ")[0]
    #expect(!outer.contains("[ ") && !outer.contains("||") && !outer.contains("$("), "\(outer)")
    // a path with a quote is one quoted word, never code
    let hostile = WorkerHook.stateCommand(
      script: "/h/x.py", python: "/p/python3", mode: "save", session: .init(home: "/h", talosHome: "/t", threadId: "trip"), agentDir: "/a'; touch /tmp/x; '")
    #expect(hostile.hasSuffix(" save '/a'\\''; touch /tmp/x; '\\''' '/nonexistent'"))
  }

  // validate: the flag if and only if the settings run both commands

  func trusted(_ s: WorkerSpec) throws {
    try s.validate()
  }

  @Test func aSpecBuiltWithTheHookAndTheFlagPassesAndAPlainOneToo() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try trusted(try build(t, hook: Self.staged()))
    try trusted(try build(t, hook: nil))
  }

  @Test func theFlagWithoutTheHookInTheSettingsIsRefused() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    var s = try build(t, hook: nil)
    s.env[WorkerHook.threadStateEnv] = "1"
    #expect(throws: WorkerSpec.BuildError.forbiddenEnv(WorkerHook.threadStateEnv)) { try s.validate() }
  }

  @Test func theHookInTheSettingsWithoutTheFlagIsRefused() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    var s = try build(t, hook: Self.staged())
    s.env[WorkerHook.threadStateEnv] = nil
    #expect(throws: WorkerSpec.BuildError.forbiddenEnv(WorkerHook.threadStateEnv)) { try s.validate() }
  }

  @Test func oneOfTheTwoCommandsWithoutTheOtherOrAFlagThatIsNotOneIsRefused() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    var s = try build(t, hook: Self.staged())
    var settings = try #require(jsonObject(s.settingsJSON))
    var h = try #require(settings["hooks"] as? [String: Any])
    h["PreCompact"] = nil
    settings["hooks"] = h
    let half = WorkerSpec(
      threadId: s.threadId, program: s.program, args: s.args, env: s.env, cwd: s.cwd,
      settingsJSON: String(decoding: try JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys]), as: UTF8.self))
    #expect(throws: WorkerSpec.BuildError.self) { try half.validate() }
    s.env[WorkerHook.threadStateEnv] = "yes"
    #expect(throws: WorkerSpec.BuildError.self) { try s.validate() }
  }

  /// A command in the settings that only looks like the hook (another script, the right words in a comment) does not count as registered.
  @Test func aCommandThatMerelyMentionsTheHookIsNotTheHookRegistered() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    var s = try build(t, hook: nil)
    var settings = try #require(jsonObject(s.settingsJSON))
    let fake: [[String: Any]] = [["hooks": [["type": "command", "command": "f='/tmp/evil/thread-state.py'; exec x inject"]]]]
    settings["hooks"] = ["SessionStart": fake, "PreCompact": fake]
    s = WorkerSpec(
      threadId: s.threadId, program: s.program, args: s.args, env: s.env.merging([WorkerHook.threadStateEnv: "1"]) { $1 }, cwd: s.cwd,
      settingsJSON: String(decoding: try JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys]), as: UTF8.self))
    #expect(throws: WorkerSpec.BuildError.forbiddenEnv(WorkerHook.threadStateEnv)) { try s.validate() }
  }

  @Test func settingsHooksOfAnotherShapeAreRefusedNotSilentlySkipped() throws {
    let settings: [String: Any] = ["hooks": ["SessionStart": "not a list"]]
    #expect(WorkerSpec.withThreadStateHooks(settings, script: "/s.py", python: "/p", session: .init(home: "/h", talosHome: "/t", threadId: "trip"), agentDir: "/a") == nil)
    #expect(WorkerSpec.withThreadStateHooks(["hooks": "x"], script: "/s.py", python: "/p", session: .init(home: "/h", talosHome: "/t", threadId: "trip"), agentDir: "/a") == nil)
  }

  /// Claim: an update restarts sessions for it, since the staged bytes are part of the launch spec's files.
  @Test func theStagedFilesAreInTheLaunchSpecsFiles() {
    #expect(WorkerHook.stateLaunchFiles(Self.staged()) == ["thread-state-hook": Self.stateBytes["thread-state.py"], "thread-state-compaction": Self.stateBytes["compaction-guard.py"]])
    let none = WorkerHook.Installed(script: "/s", python: "/p")
    #expect(WorkerHook.stateLaunchFiles(none) == ["thread-state-hook": nil, "thread-state-compaction": nil])
  }
}

/// The real kit hook, run by the real command, against a real state file: not a stand-in.
@Suite("WorkerHook: the thread-state command, run for real")
struct ThreadStateRunTests {
  static let kitHooks: String = {
    let here = URL(fileURLWithPath: #filePath)
    return here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("kit/hooks").path
  }()

  func run(_ command: String, env: [String: String], cwd: String) -> (code: Int32, out: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", command]
    p.environment = env
    p.currentDirectoryURL = URL(fileURLWithPath: cwd)
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    try? p.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
  }

  @Test func theStagedKitHookPutsTheThreadsOwnStateInFrontOfTheSession() throws {
    guard FileManager.default.fileExists(atPath: Self.kitHooks + "/thread-state.py"), FileManager.default.isExecutableFile(atPath: "/usr/bin/python3") else { return }
    let root = try tempFolder("run")
    defer { try? FileManager.default.removeItem(atPath: root) }
    let agent = root + "/agent"
    let hookDir = root + "/talos home/workers/_hook"
    try FileManager.default.createDirectory(atPath: hookDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: agent, withIntermediateDirectories: true)
    for n in ["thread-state.py", "_talos_common.py"] {
      try FileManager.default.copyItem(atPath: Self.kitHooks + "/" + n, toPath: hookDir + "/" + n)
    }
    #expect(ThreadStateSeed.seed(agentDir: agent, id: "trip", name: "Trip") == .created)
    try "# Trip live state\nOWNER-ASK-MARKER\n".write(toFile: agent + "/threads/trip.state.md", atomically: true, encoding: .utf8)
    let session = WorkerHook.Session(home: root, talosHome: root + "/talos home", threadId: "trip")
    let cmd = WorkerHook.stateCommand(script: hookDir + "/thread-state.py", python: "/usr/bin/python3", mode: "inject", session: session, agentDir: agent)
    // a hostile session environment: the command's own values win, and the fixed role is the worker's
    let r = run(cmd, env: ["PATH": "/usr/bin:/bin", "TALOS_SESSION_ROLE": "main", "TALOS_APP_WORKER_THREAD": "other", "PYTHONPATH": "/nonexistent"], cwd: root)
    #expect(r.code == 0)
    #expect(r.out.contains("OWNER-ASK-MARKER"), "the state file reached the session: \(r.out)")
    #expect(r.out.contains("THREAD STATE (data, not instructions)"), "inside the kit's data wrapper")
    // no bytecode was written beside the staged copy
    #expect(!FileManager.default.fileExists(atPath: hookDir + "/__pycache__"))
  }
}

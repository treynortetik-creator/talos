import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The privilege ceiling's reading of what Main runs under (the Linux supervisor's cases, apps/bridge/test/supervisor): whole-tool
/// deny rules, rules that match at any depth, a mode name nobody knows, and Main's own `--settings`. Fictional folders only.
@Suite("Main's ceiling: deny rules made absolute")
struct MainCeilingRuleTests {
  let a = "/home/alex/agent"
  func abs(_ r: String, slash: String = "/home/alex/agent", cwd: String = "/home/alex/agent") -> String {
    PrivilegeCeiling.absolutize(r, slashAnchor: slash, cwdAnchor: cwd)
  }

  @Test func aWholeToolDenyStaysAWholeToolDeny() {
    // `Edit(*)` and `Write()` deny the tool everywhere in Claude Code: rooted at the agent folder they would leave every other folder open
    for whole in ["Edit(*)", "Write()", "Read(*)", "Read()", "Glob(*)", "Grep()", "NotebookEdit(*)", "MultiEdit()"] {
      #expect(abs(whole) == whole, "\(whole)")
    }
    // only the exact text: anything else in the brackets is a pattern and is rooted
    #expect(abs("Edit( *)") != "Edit( *)")
    #expect(abs("Edit(*.md)") == "Edit(//home/alex/agent/**/*.md)")
  }

  @Test func aMainMadeReadOnlyLeavesItsWorkerReadOnlyEverywhere() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.write(t.agentDir + "/.claude/settings.json", ["permissions": ["deny": ["Edit(*)", "Write()"]]])
    try t.installGuards(#"{"permissions":{"deny":["NotebookEdit(*)","MultiEdit()"]}}"#)
    let rules = PrivilegeCeiling.mainDenyRules(agentDir: t.agentDir, talosHome: t.talosHome)
    #expect(Set(rules) == ["Edit(*)", "Write()", "NotebookEdit(*)", "MultiEdit()"], "\(rules)")
    // and in the settings the worker is launched with: main's, and the guards' own copy that `anchoring` writes
    let deny = denyList(try WorkerSpec.build(fenceInputs(t, mainDeny: rules)))
    for whole in ["Edit(*)", "Write()", "NotebookEdit(*)", "MultiEdit()"] { #expect(deny.contains(whole), "\(whole): \(deny)") }
    // (the settings-file deny names the agent folder's .claude, .mcp.json and .env*: that is its own rule, not main's made narrower)
    #expect(!deny.contains { !isFenceRule($0) && ($0.hasPrefix("Edit(/\(t.agentDir)") || $0.hasPrefix("Write(/\(t.agentDir)")) }, "\(deny)")
    let anchored = WorkerFence.anchoring(["permissions": ["deny": ["Edit(*)", "Write()"]]], slashAnchor: "/g", cwdAnchor: t.agentDir)
    #expect((anchored["permissions"] as? [String: Any])?["deny"] as? [String] == ["Edit(*)", "Write()"])
  }

  @Test func aPatternWithNoSlashMatchesAtAnyDepthBelowItsFolder() {
    #expect(abs("Read(.env)") == "Read(//home/alex/agent/**/.env)")
    #expect(abs("Read(./.env)") == "Read(//home/alex/agent/**/.env)", "a leading ./ aside")
    #expect(abs("Read(*.pem)") == "Read(//home/alex/agent/**/*.pem)")
    #expect(abs("Edit(secrets/)") == "Edit(//home/alex/agent/**/secrets/)", "a trailing / aside")
    #expect(abs("Read(**)") == "Read(//home/alex/agent/**/**)")
    // one with a slash in it stays where it is
    #expect(abs("Read(./config/.env)") == "Read(//home/alex/agent/config/.env)")
    #expect(abs("Edit(**/secrets/**)") == "Edit(//home/alex/agent/**/secrets/**)")
    // a /-rule is rooted at its file's folder, at the top
    #expect(abs("Read(/.env)", slash: "/home/alex/cfg") == "Read(//home/alex/cfg/.env)")
  }
}

@Suite("Main's ceiling: a mode name nobody knows")
struct MainCeilingModeTests {
  let m = PrivilegeCeiling.Mode.self

  @Test func forMainItRanksAsPlanNeverAsTheWidest() {
    let plan = m.from(args: ["--permission-mode", "plan"], settingsDefault: nil)
    for main in [
      PrivilegeCeiling.Main(defaultMode: "yolo"), PrivilegeCeiling.Main(defaultMode: "Plan"),
      PrivilegeCeiling.Main(permissionArgs: ["--permission-mode", "somethingnew"]),
      PrivilegeCeiling.Main(permissionArgs: ["--permission-mode=somethingnew"], defaultMode: "bypassPermissions"),
    ] {
      #expect(main.mode.rank == 0 && main.mode == plan, "\(main)")
      #expect(main.mode.name == "plan", "the name a worker's settings get is one Claude Code knows: \(main)")
    }
    // the names it does know are as they were
    #expect(PrivilegeCeiling.Main(defaultMode: "manual").mode.name == "default")
    #expect(PrivilegeCeiling.Main(defaultMode: "acceptEdits").mode.rank == 2)
    #expect(PrivilegeCeiling.Main().mode.name == nil && PrivilegeCeiling.Main().mode.rank == 1)
    // bypass reachable by key is bypass whatever the name
    #expect(PrivilegeCeiling.Main(permissionArgs: ["--allow-dangerously-skip-permissions"], defaultMode: "yolo").mode.rank == 4)
  }

  @Test func forAWorkerItIsStillTheWidest() {
    #expect(m.from(args: [], settingsDefault: "yolo").rank == 4)
    let d = PrivilegeCeiling.check(
      args: [], settings: ["permissions": ["defaultMode": "yolo"]], mcpAllowed: [], mcpOwnFolder: [],
      main: .init(defaultMode: "acceptEdits"))
    #expect(d?.axis == .permissionMode)
  }

  @Test func aWorkerUnderAMainWithAnUnknownModeStartsInPlan() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let spec = try WorkerSpec.build(fenceInputs(t, flag: nil, mainMode: "yolo"))
    #expect(((jsonObject(spec.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String) == "plan")
    // a folder that asks for more is not let through by it
    try t.write(t.cwd + "/.claude/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    let again = try WorkerSpec.build(fenceInputs(t, flag: nil, mainMode: "yolo"))
    #expect(((jsonObject(again.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String) == "plan")
    // the owner's bypass flag on a worker under such a main is wider than main
    #expect(escalation { _ = try WorkerSpec.build(fenceInputs(t, mainArgs: ["--permission-mode", "somethingnew"])) }?.axis == .permissionMode)
  }
}

@Suite("Main's ceiling: main's own --settings")
struct MainOwnSettingsTests {
  /// A fence tree with a folder for settings files that is neither the agent folder nor the Talos home.
  func tree() throws -> (t: FenceTree, cfg: String) {
    let t = try FenceTree()
    let cfg = t.root + "/cfg"
    try FileManager.default.createDirectory(atPath: cfg, withIntermediateDirectories: true)
    return (t, cfg)
  }
  func text(_ path: String, _ s: String) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data(s.utf8).write(to: URL(fileURLWithPath: path))
  }
  func read(_ t: FenceTree, _ args: [String], env: [String: String] = [:]) -> MainOwnSettings {
    MainOwnSettings.read(args: args, agentDir: t.agentDir, env: env, uid: 501)
  }
  func mode(_ t: FenceTree, _ args: [String]) -> String? {
    MainOwnSettings.ceiling(read(t, args), args: args, agentDir: t.agentDir, talosHome: t.talosHome, claudeDir: t.claudeDir, managedDir: nil).defaultMode
  }
  func isUnreadable(_ s: MainOwnSettings) -> Bool { if case .unreadable = s { return true } else { return false } }

  @Test func noSettingsInTheArgumentsIsNone() throws {
    let (t, _) = try tree()
    defer { t.cleanup() }
    #expect(read(t, []) == .none)
    #expect(read(t, ["--model", "opus", "--permission-mode", "plan"]) == .none)
    // a value that only looks like the flag is a value
    #expect(MainOwnSettings.value(in: ["--settings", "a.json", "--settings=b.json"]) == "b.json", "the last one is the one main runs with")
    #expect(MainOwnSettings.value(in: ["--settings"]) == "")
  }

  @Test func theGuardsFileIsNotMainsWhenMainHasItsOwnSettings() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    try t.installGuards(#"{"permissions":{"defaultMode":"bypassPermissions"}}"#)
    try t.write(t.claudeDir + "/settings.json", ["permissions": ["defaultMode": "default"]])
    try text(cfg + "/own.json", "{}")
    #expect(mode(t, ["--settings", cfg + "/own.json"]) == "default")
    #expect(mode(t, []) == "bypassPermissions", "with none, the guards' file is main's --settings")
  }

  @Test func aModeInMainsOwnSettingsIsReadFirstAndIsMainsMode() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    // wider everywhere else: the user's, the project's and the guards'
    try t.write(t.claudeDir + "/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    try t.write(t.agentDir + "/.claude/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    try t.installGuards(#"{"permissions":{"defaultMode":"bypassPermissions"}}"#)
    try t.write(cfg + "/own.json", ["permissions": ["defaultMode": "plan"]])
    #expect(mode(t, ["--settings=" + cfg + "/own.json"]) == "plan")
    // relative to main's folder, the agent folder; and given inline
    try t.write(t.agentDir + "/rel.json", ["permissions": ["defaultMode": "plan"]])
    #expect(mode(t, ["--settings", "rel.json"]) == "plan")
    #expect(mode(t, ["--settings", #"{"permissions":{"defaultMode":"plan"}}"#]) == "plan")
    #expect(mode(t, ["--settings", cfg + "/nope.json", "--settings", cfg + "/own.json"]) == "plan", "the last --settings")
    // and the worker built under it starts in plan, whatever its folder asks for
    try t.write(t.cwd + "/.claude/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    let args = ["--settings", cfg + "/own.json"]
    let c = MainOwnSettings.ceiling(read(t, args), args: args, agentDir: t.agentDir, talosHome: t.talosHome, claudeDir: t.claudeDir, managedDir: nil)
    let spec = try WorkerSpec.build(fenceInputs(t, flag: nil, mainDeny: c.denyRules, mainArgs: args, mainMode: c.defaultMode))
    #expect(((jsonObject(spec.settingsJSON)?["permissions"] as? [String: Any])?["defaultMode"] as? String) == "plan")
    // a permission flag in main's arguments still outranks the file
    let flagged = PrivilegeCeiling.Main(permissionArgs: args + ["--permission-mode", "acceptEdits"], defaultMode: c.defaultMode)
    #expect(flagged.mode.name == "acceptEdits")
  }

  @Test func oneWithNoModeFallsThroughToTheProjectsAndTheUsers() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    try t.write(t.claudeDir + "/settings.json", ["permissions": ["defaultMode": "acceptEdits"]])
    try t.write(cfg + "/own.json", ["permissions": ["deny": ["Bash(rm:*)"]]])
    #expect(mode(t, ["--settings", cfg + "/own.json"]) == "acceptEdits")
    try t.write(cfg + "/bare.json", ["model": "opus"])
    #expect(read(t, ["--settings", cfg + "/bare.json"]) == .readable(mode: nil, deny: []))
  }

  @Test func aModeNobodyKnowsInItKeepsThePlanCeiling() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    try t.write(t.claudeDir + "/settings.json", ["permissions": ["defaultMode": "bypassPermissions"]])
    try t.write(cfg + "/own.json", ["permissions": ["defaultMode": "yolo"]])
    let c = MainOwnSettings.ceiling(read(t, ["--settings", cfg + "/own.json"]), args: ["--settings", cfg + "/own.json"], agentDir: t.agentDir, talosHome: t.talosHome, claudeDir: t.claudeDir, managedDir: nil)
    #expect(PrivilegeCeiling.Main(permissionArgs: ["--settings", cfg + "/own.json"], defaultMode: c.defaultMode).mode.name == "plan")
  }

  @Test func itsDenyRulesAreInTheCeilingMadeAbsoluteWhereTheyWereDefined() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    try t.write(t.agentDir + "/.claude/settings.json", ["permissions": ["deny": ["Bash(rm:*)"]]])
    try t.installGuards(#"{"permissions":{"deny":["Bash(claude plugin:*)"]}}"#)
    try text(cfg + "/own.json", #"{"permissions":{"deny":["Read(./secrets/**)","Read(/notes/**)","Bash(curl:*)",7,"Edit(*)","Read(.env)"]}}"#)
    let agent = try #require(MainOwnSettings.real(t.agentDir))
    let folder = try #require(MainOwnSettings.real(cfg))
    let c = MainOwnSettings.ceiling(read(t, ["--settings", cfg + "/own.json"]), args: ["--settings", cfg + "/own.json"], agentDir: t.agentDir, talosHome: t.talosHome, claudeDir: t.claudeDir, managedDir: nil)
    #expect(c.denyRules.contains("Read(/\(agent)/secrets/**)"), "relative: main's folder, as the kernel has it: \(c.denyRules)")
    #expect(c.denyRules.contains("Read(/\(folder)/notes/**)"), "/-rooted: the file's own folder")
    #expect(c.denyRules.contains("Bash(curl:*)") && c.denyRules.contains("Edit(*)") && c.denyRules.contains("Read(/\(agent)/**/.env)"))
    #expect(c.denyRules.contains("Bash(rm:*)") && c.denyRules.contains("Bash(claude plugin:*)"), "the project's and the guards' stay")
    // and they reach the worker's settings
    let spec = try WorkerSpec.build(fenceInputs(t, mainDeny: c.denyRules))
    for r in ["Read(/\(folder)/notes/**)", "Bash(curl:*)", "Edit(*)"] { #expect(denyList(spec).contains(r), "\(r)") }
  }

  @Test func settingsGivenInlineRootTheirSlashRulesWhereClaudeCodeWritesThem() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    let inline = #" {"permissions":{"deny":["Read(/x/**)","Read(keys/**)"]}} "#
    guard case .readable(_, let deny, _) = read(t, ["--settings", inline], env: ["TMPDIR": cfg + "/"]) else {
      Issue.record("inline settings were not read")
      return
    }
    #expect(deny.contains("Read(/\(cfg)/claude-501/x/**)"), "\(deny)")
    #expect(deny.contains("Read(//tmp/claude-501/x/**)") && deny.contains("Read(//private/tmp/claude-501/x/**)"), "\(deny)")
    #expect(deny.contains("Read(/\(try #require(MainOwnSettings.real(t.agentDir)))/keys/**)"), "a relative one is main's folder")
    // a superset, in case another version writes them elsewhere: the bare temp folders and the agent folder (the Linux port's roots)
    #expect(deny.contains("Read(/\(cfg)/x/**)") && deny.contains("Read(//tmp/x/**)") && deny.contains("Read(/\(t.agentDir)/x/**)"), "\(deny)")
    // CLAUDE_CODE_TMPDIR, when main's environment has one
    let moved = MainOwnSettings.inlineFolders(env: ["CLAUDE_CODE_TMPDIR": "/home/alex/tmp"], uid: 502, agentDir: "/home/alex/agent")
    #expect(moved.first == "/home/alex/tmp/claude-502" && moved.contains("/tmp/claude-502") && moved.contains("/home/alex/agent"))
    // text that only starts like JSON is a file name to Claude Code (so: not found), but it is never shown as one: it can hold a key
    #expect(read(t, ["--settings", #"{"env":{"KEY":"sk-FICTIONAL""#]) == .unreadable(what: MainOwnSettings.inlineName))
    #expect(read(t, ["--settings", "\u{FEFF} " + #"{"env":{"KEY":"sk-FICTIONAL""#]) == .unreadable(what: MainOwnSettings.inlineName))
    #expect(read(t, ["--settings", "{oops}"]) == .unreadable(what: MainOwnSettings.inlineName), "never the inline text itself")
  }

  @Test func aFileReachedThroughALinkRootsItsSlashRulesWhereItReallyIs() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    try t.write(cfg + "/main.json", ["permissions": ["deny": ["Read(/secrets/**)"]]])
    try FileManager.default.createSymbolicLink(atPath: t.agentDir + "/main.json", withDestinationPath: cfg + "/main.json")
    guard case .readable(_, let deny, _) = read(t, ["--settings", "main.json"]) else {
      Issue.record("not read through the link")
      return
    }
    // where it really is, and where the arguments say it is: whichever Claude Code roots at, the worker has the rule
    #expect(deny.contains("Read(/\(try #require(MainOwnSettings.real(cfg)))/secrets/**)"), "\(deny)")
    #expect(deny.contains("Read(/\(t.agentDir)/secrets/**)"), "\(deny)")
  }

  @Test func oneThatCannotBeReadIsUnreadableNeverEmpty() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    try text(cfg + "/bad.json", "{not json")
    try text(cfg + "/list.json", "[]")
    try text(cfg + "/empty.json", "")
    try t.write(cfg + "/num.json", ["permissions": ["defaultMode": 7]])
    try t.write(cfg + "/perms.json", ["permissions": ["deny"]])
    try t.write(cfg + "/deny.json", ["permissions": ["deny": "Read(**)"]])
    try t.write(cfg + "/denyobj.json", ["permissions": ["defaultMode": "plan", "deny": ["Read(**)": true]]])
    try text(cfg + "/locked.json", "{}")
    chmod(cfg + "/locked.json", 0)
    for f in ["missing.json", "bad.json", "list.json", "empty.json", "num.json", "perms.json", "deny.json", "denyobj.json", "locked.json"] {
      #expect(read(t, ["--settings", cfg + "/" + f]) == .unreadable(what: cfg + "/" + f), "\(f)")
    }
    #expect(isUnreadable(read(t, ["--settings"])), "the flag with nothing after it")
    #expect(isUnreadable(read(t, ["--settings="])))
    #expect(read(t, ["--settings", #"{"permissions":{"deny":"Read(**)"}}"#]) == .unreadable(what: MainOwnSettings.inlineName))
    // the line the thread gets names the file and the fix, and never the inline text
    let line = MainOwnSettings.unreadableLine(what: "/home/alex/own.json")
    #expect(line.contains("/home/alex/own.json") && line.contains("Restart") && line.contains("--settings"))
    #expect(MainOwnSettings.unreadableLine(what: MainOwnSettings.inlineName).contains("given inline"))
  }

  @Test func theLastOfTwoSameNamedKeysWinsAsInClaudeCode() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    // main runs in plan with Edit denied (JSON.parse keeps the last `permissions`); Foundation would read the first: bypass, no rules
    let twice = #"{"permissions":{"defaultMode":"bypassPermissions"},"permissions":{"defaultMode":"plan","deny":["Edit(*)"],"deny":["Edit(*)","Bash(curl:*)"]}}"#
    try text(cfg + "/own.json", twice)
    #expect(read(t, ["--settings", cfg + "/own.json"]) == .readable(mode: "plan", deny: ["Edit(*)", "Bash(curl:*)"]))
    #expect(read(t, ["--settings", twice]) == .readable(mode: "plan", deny: ["Edit(*)", "Bash(curl:*)"]))
    // the same for the files main reads without a flag: the project's, the guards' and the user's
    try text(t.agentDir + "/.claude/settings.json", #"{"permissions":{"deny":[]},"permissions":{"defaultMode":"plan","deny":["Bash(rm:*)"]}}"#)
    try t.installGuards(#"{"permissions":{"deny":[]},"permissions":{"deny":["Bash(claude plugin:*)"]}}"#)
    #expect(Set(PrivilegeCeiling.mainDenyRules(agentDir: t.agentDir, talosHome: t.talosHome)) == ["Bash(rm:*)", "Bash(claude plugin:*)"])
    #expect(PrivilegeCeiling.mainDefaultMode(agentDir: t.agentDir, talosHome: t.talosHome, claudeDir: t.claudeDir) == "plan")
    // the reader itself: nesting, escapes, and nothing Foundation would not take
    let o = SettingsJSON.object(Data(#"{"a":{"k":1,"k":[true,null,"x\"é\\"]},"ab":-1.5e2,"ab":"last"}"#.utf8))
    #expect(((o?["a"] as? [String: Any])?["k"] as? [Any])?.last as? String == #"x"é\"#)
    #expect(o?["ab"] as? String == "last", "a key spelled with an escape is the same key")
    for bad in ["", "[]", "{", #"{"a":}"#, #"{"a":1,}"#, #"{"a":1} x"#, "7"] { #expect(SettingsJSON.object(Data(bad.utf8)) == nil, "\(bad)") }
  }

  @Test func anEntryThatIsNotTextIsLeftOutOnItsOwnNeverTheWholeList() throws {
    let (t, _) = try tree()
    defer { t.cleanup() }
    try text(t.agentDir + "/.claude/settings.json", #"{"permissions":{"deny":["Read(./.env)",7,"Bash(rm:*)"]}}"#)
    let rules = PrivilegeCeiling.mainDenyRules(agentDir: t.agentDir, talosHome: t.talosHome)
    #expect(rules == ["Read(/\(t.agentDir)/**/.env)", "Bash(rm:*)"], "\(rules)")
  }

  @Test func aSlashRuleUnderAFolderNoRuleCanNameIsUnreadableAndAnUnreadableReadIsNeverWiderThanPlan() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    let odd = cfg + "/own [v2]"
    try FileManager.default.createDirectory(atPath: odd, withIntermediateDirectories: true)
    try t.write(odd + "/a.json", ["permissions": ["deny": ["Read(/secrets/**)"]]])
    #expect(read(t, ["--settings", odd + "/a.json"]) == .unreadable(what: odd + "/a.json"), "[v2] would be read as a glob: the rule would match nothing")
    // rules that are not rooted at the file's folder are as they were
    try t.write(odd + "/b.json", ["permissions": ["deny": ["Bash(/bin/rm:*)", "Read(//etc/x)", "Edit(*)"]]])
    #expect(read(t, ["--settings", odd + "/b.json"]) == .readable(mode: nil, deny: ["Bash(/bin/rm:*)", "Read(//etc/x)", "Edit(*)"]))
    // never asked for (the start is refused first), and never wider if it is
    try t.write(t.claudeDir + "/settings.json", ["permissions": ["defaultMode": "bypassPermissions"]])
    let c = MainOwnSettings.ceiling(.unreadable(what: "x"), args: [], agentDir: t.agentDir, talosHome: t.talosHome, claudeDir: t.claudeDir, managedDir: nil)
    #expect(c.defaultMode == "plan")
  }

  @Test(.timeLimit(.minutes(1))) func aFifoOrAFolderIsNeverReadAndNeverHangs() throws {
    let (t, cfg) = try tree()
    defer { t.cleanup() }
    let fifo = cfg + "/pipe"
    #expect(mkfifo(fifo, 0o600) == 0)
    let t0 = Date()
    #expect(read(t, ["--settings", fifo]) == .unreadable(what: fifo))
    #expect(read(t, ["--settings", cfg]) == .unreadable(what: cfg), "a folder")
    // a link to the pipe is the pipe
    try FileManager.default.createSymbolicLink(atPath: cfg + "/link.json", withDestinationPath: fifo)
    #expect(read(t, ["--settings", cfg + "/link.json"]) == .unreadable(what: cfg + "/link.json"))
    #expect(Date().timeIntervalSince(t0) < 5)
    // a pipe with settings text waiting in it is still not a file
    let w = open(fifo, O_RDWR | O_NONBLOCK)
    #expect(w >= 0)
    defer { close(w) }
    let wide = #"{"permissions":{"defaultMode":"bypassPermissions"}}"#
    #expect(wide.withCString { write(w, $0, strlen($0)) } == wide.utf8.count)
    #expect(read(t, ["--settings", fifo]) == .unreadable(what: fifo))
    // a file too big to be settings is not read into memory
    FileManager.default.createFile(atPath: cfg + "/huge.json", contents: nil)
    #expect(truncate(cfg + "/huge.json", off_t(MainOwnSettings.maxBytes) + 1) == 0)
    #expect(read(t, ["--settings", cfg + "/huge.json"]) == .unreadable(what: cfg + "/huge.json"))
  }
}

@Suite("Main's ceiling: one read per start")
struct MainOwnSettingsOneReadTests {
  /// The refusal and the ceiling must see the same read: a file saved between two reads could pass the refusal and then leave the
  /// ceiling without its deny rules. The manager's sources have exactly one place that reads main's own `--settings`, and `start`
  /// is handed that read instead of making its own.
  @Test func theManagerReadsMainsOwnSettingsInOnePlaceAndHandsItToTheStart() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosSupervisor")
    var reads = 0
    var manager = ""
    for f in try FileManager.default.contentsOfDirectory(atPath: dir.path) where f.hasSuffix(".swift") {
      let text = try String(contentsOf: dir.appendingPathComponent(f), encoding: .utf8)
      reads += text.components(separatedBy: "MainOwnSettings.read(").count - 1
      if f == "WorkerManager.swift" { manager = text }
    }
    #expect(reads == 1)
    #expect(manager.components(separatedBy: "mainSettingsOrRefuse(").count - 1 == 1, "asked once, in requestStart")
    #expect(manager.components(separatedBy: "start(id, s, resume: resume, now: t, own: own)").count - 1 == 3, "every start gets that read")
    #expect(!manager.contains("PrivilegeCeiling.mainDenyRules(") && !manager.contains("PrivilegeCeiling.mainDefaultMode("), "the ceiling comes from the read")
  }
}

/// One of the rules that keep a session from editing a folder's Claude Code files (`WorkerFence.projectFiles`).
func isFenceRule(_ rule: String) -> Bool {
  WorkerFence.projectFiles.contains { rule.hasSuffix($0 + ")") } || rule.contains("/hooks)") || rule.contains("/hooks/**)")
}

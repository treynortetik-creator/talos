import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The Mac halves of fixes the Linux supervisor (apps/bridge/src/supervisor) already has, the pure part: main's MCP ceiling, the one
/// global config file Claude Code reads, the `talos-app post` deny, a session option that cannot be read, a `config.threads` entry that
/// is not a thread, and the folder fence's verdict for a session that runs. Fictional folders and servers only.
/// Run: bash apps/desktop/scripts/test.sh --filter WorkerTwins
@Suite("Worker twins core")
struct WorkerTwinsCoreTests {
  /// The agent folder with `talos-app` and a server of its own `.mcp.json`; the owner's user scope with `github` and `notes`.
  func tree(agentEntry: [String: Any] = [:]) throws -> FenceTree {
    let t = try FenceTree()
    try t.write(t.agentDir + "/.mcp.json", ["mcpServers": ["talos-app": ["command": "bun"], "agent-only": ["command": "agent-mcp"]]])
    var global: [String: Any] = ["mcpServers": ["github": ["command": "gh-mcp"], "notes": ["command": "notes-mcp"]]]
    if !agentEntry.isEmpty { global["projects"] = [t.agentDir: agentEntry] }
    try t.write(t.home + "/.claude.json", global)
    return t
  }

  func mainNames(_ t: FenceTree) -> Set<String> { WorkerMcp.visibleNames(cwd: t.agentDir, home: t.home, claudeDir: t.claudeDir) }

  // MARK: 1. main's MCP ceiling

  @Test func aServerTheOwnerSwitchedOffForTheAgentFolderIsNotInMainsCeiling() throws {
    let t = try tree(agentEntry: ["disabledMcpServers": ["github", 7]])
    defer { t.cleanup() }
    let names = mainNames(t)
    #expect(!names.contains("github"), "switched off with /mcp for the agent folder: \(names)")
    #expect(names.contains("notes") && names.contains("talos-app"))
  }

  @Test func aWorkerCannotListAServerMainHasSwitchedOff() throws {
    let t = try tree(agentEntry: ["disabledMcpServers": ["github"]])
    defer { t.cleanup() }
    let plan = try #require(t.plan(["github"]))
    #expect(plan.allowed == ["github"])
    let denial = escalation { _ = try WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: mainNames(t))) }
    #expect(denial?.axis == .mcp, "\(String(describing: denial))")
    // control: with the server on for main, the same list starts
    try t.write(t.home + "/.claude.json", ["mcpServers": ["github": ["command": "gh-mcp"]]])
    #expect(escalation { _ = try WorkerSpec.build(fenceInputs(t, mcp: plan, mainMcp: mainNames(t))) } == nil)
  }

  @Test func theAgentFoldersOwnMcpJsonCountsOnlyOnceApproved() throws {
    let t = try tree()
    defer { t.cleanup() }
    #expect(!mainNames(t).contains("agent-only"), "not approved: main cannot use it")
    #expect(mainNames(t).contains("talos-app"), "talos-app is always there")
    try t.write(
      t.home + "/.claude.json", ["mcpServers": ["github": ["command": "gh-mcp"]], "projects": [t.agentDir: ["enabledMcpjsonServers": ["agent-only"]]]])
    #expect(mainNames(t).contains("agent-only"))
    // a rejection beats an approval
    try t.write(
      t.home + "/.claude.json",
      ["projects": [t.agentDir: ["enabledMcpjsonServers": ["agent-only"], "disabledMcpjsonServers": ["agent-only"]]]])
    #expect(!mainNames(t).contains("agent-only"))
  }

  // MARK: 2. the one global config file

  @Test func aStaleClaudeJsonInsideTheConfigFolderDefinesAndApprovesNothing() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.write(t.cwd + "/.mcp.json", ["mcpServers": ["local-db": ["command": "db-mcp"]]])
    // not Claude Code's file: ~/.claude/.claude.json
    try t.write(
      t.claudeDir + "/.claude.json",
      [
        "mcpServers": ["stale": ["command": "stale-mcp"]],
        "projects": [t.cwd: ["mcpServers": ["stale-local": ["command": "x"]], "enabledMcpjsonServers": ["local-db"]]],
      ])
    let names = Set(WorkerMcp.entries(cwd: t.cwd, home: t.home, claudeDir: t.claudeDir).keys)
    #expect(!names.contains("stale") && !names.contains("stale-local"), "\(names)")
    #expect(names.contains("github"), "the real file is still read")
    #expect(!WorkerMcp.projectApproved("local-db", cwd: t.cwd, home: t.home, claudeDir: t.claudeDir), "a stale file approves nothing")
    #expect(t.plan(["stale"])?.missing == ["stale"])
    #expect(t.plan(["local-db"])?.refusal != nil, "not launched on a stale approval")
    #expect(WorkerMcp.globalConfigFiles(home: t.home, claudeDir: t.claudeDir) == [t.home + "/.claude.json"])
    #expect(WorkerMcp.globalConfigFiles(home: t.home + "/", claudeDir: t.claudeDir + "//") == [t.home + "/.claude.json"])
  }

  @Test func withAConfigFolderOfItsOwnOnlyItsClaudeJsonIsRead() throws {
    let t = try tree()
    defer { t.cleanup() }
    let custom = t.root + "/cc-config"
    try t.write(custom + "/.claude.json", ["mcpServers": ["custom": ["command": "c-mcp"]]])
    #expect(WorkerMcp.globalConfigFiles(home: t.home, claudeDir: custom) == [custom + "/.claude.json"])
    let names = Set(WorkerMcp.entries(cwd: t.cwd, home: t.home, claudeDir: custom).keys)
    #expect(names.contains("custom") && !names.contains("github"), "\(names)")
  }

  /// R1-3. `CLAUDE_CONFIG_DIR` set to `~/.claude` itself is still a config folder that was named: its `.claude.json` is the one read.
  @Test func aConfigFolderNamedByTheVariableIsReadEvenWhenItIsTheDefaultOne() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.write(t.claudeDir + "/.claude.json", ["mcpServers": ["named": ["command": "n-mcp"]]])
    #expect(WorkerMcp.configDirSet(env: ["CLAUDE_CONFIG_DIR": t.claudeDir]) && !WorkerMcp.configDirSet(env: [:]))
    #expect(!WorkerMcp.configDirSet(env: ["CLAUDE_CONFIG_DIR": "relative/dir"]), "the same rule as claudeDir")
    #expect(WorkerMcp.globalConfigFiles(home: t.home, claudeDir: t.claudeDir, configDirSet: true) == [t.claudeDir + "/.claude.json"])
    let named = WorkerMcp.visibleNames(cwd: t.agentDir, home: t.home, claudeDir: t.claudeDir, configDirSet: true)
    #expect(named.contains("named") && !named.contains("github"), "\(named)")
    let plan = WorkerMcp.plan(
      allow: ["named", "github"], agentDir: t.agentDir, cwd: t.cwd, home: t.home, claudeDir: t.claudeDir, talosHome: t.talosHome,
      threadId: "trip", configDirSet: true)
    #expect(plan?.allowed == ["named"] && plan?.missing == ["github"])
    // control: not named, the home folder's file
    #expect(mainNames(t).contains("github") && !mainNames(t).contains("named"))
  }

  // MARK: 4. no `talos-app post` from a thread's shell

  @Test func everyWorkersSettingsDenyTalosAppPostAndItsPlainSpellings() throws {
    let t = try tree()
    defer { t.cleanup() }
    let deny = denyList(try WorkerSpec.build(fenceInputs(t)))
    for rule in ["Bash(talos-app post:*)", "Bash(*talos-app post*)", "Bash(*cli.ts post*)"] { #expect(deny.contains(rule), "\(rule)") }
    #expect(WorkerFence.extraDeny.count == 3)
    // best effort, so not part of the checked fence: settings without them still pass the fence check
    let fenceOnly = try #require(WorkerFence.applying([:], talosHome: t.talosHome))
    let text = String(decoding: try JSONSerialization.data(withJSONObject: fenceOnly), as: UTF8.self)
    #expect(WorkerFence.missing(settingsJSON: text, talosHome: t.talosHome).isEmpty)
  }

  // MARK: 5. a session option that cannot be read

  func settings(_ opts: String) -> ThreadSessionSettings? {
    let cfg = #"{"dedicated":{"enabled":true},"threads":[{"id":"trip","kind":"fixed","session":"dedicated","session_opts":\#(opts)}]}"#
    return DedicatedSettings.readable(Data(cfg.utf8))?.threads["trip"]
  }

  @Test func theLaunchFieldsThatCannotBeReadAreNamed() {
    #expect(settings("{}")?.optsUnread == [])
    #expect(settings(#"{"cwd":"/home/alex/proj","model":"sonnet","effort":"high"}"#)?.optsUnread == [])
    #expect(settings(#"{"cwd":null,"model":null}"#)?.optsUnread == [], "absent or null is the default the owner chose")
    #expect(settings(#"{"cwd":5}"#)?.optsUnread == ["cwd"])
    #expect(settings(#"{"cwd":"~/proj"}"#)?.optsUnread == ["cwd"])
    #expect(settings(#"{"model":7,"effort":["high"]}"#)?.optsUnread == ["model", "effort"])
    #expect(settings(#""oops""#)?.optsUnread == ["session_opts"])
    #expect(settings("[]")?.optsUnread == ["session_opts"])
    #expect(settings(#"{"cwd":5}"#)?.unreadFolderField == "session_opts.cwd")
    #expect(settings(#""oops""#)?.unreadFolderField == "session_opts")
    #expect(settings(#"{"model":7}"#)?.unreadFolderField == nil)
    // the list is never "unread": one that cannot be read is the empty list
    #expect(settings(#""oops""#)?.mcpAllow == [] && settings(#"{"mcp_allow":"x"}"#)?.mcpAllow == [])
  }

  @Test func anUnreadFieldRestartsNothingButANarrowedListStillDoes() {
    let launched = WorkersFile.Launched(cwd: "/home/alex/proj", model: "sonnet", effort: "high", mcp_allow: nil)
    // what a garbled session_opts reads as: the default folder, model and effort, and the empty list
    let folderUnknown = LaunchChange.Signature(cwd: nil, model: "inherit", effort: nil, mcpAllow: nil)
    #expect(LaunchChange.compare(launched: launched, wanted: folderUnknown, unread: ["session_opts"]) == .none)
    let narrowed = LaunchChange.Signature(cwd: nil, model: "inherit", effort: nil, mcpAllow: [])
    #expect(
      LaunchChange.compare(launched: launched, wanted: narrowed, unread: ["session_opts"]) == .restart(wanted: narrowed, changed: ["mcp_allow"]),
      "never a fresh conversation in the default folder")
    // one field: only that one is left out
    let oneField = LaunchChange.Signature(cwd: "/home/alex/proj", model: "inherit", effort: "low", mcpAllow: nil)
    #expect(LaunchChange.compare(launched: launched, wanted: oneField, unread: ["model"]) == .restart(wanted: oneField, changed: ["effort"]))
    // control: a default that CAN be read is the owner's setting
    let agent = LaunchChange.Signature(cwd: "/home/alex/agent", model: "sonnet", effort: "high", mcpAllow: nil)
    #expect(LaunchChange.compare(launched: launched, wanted: agent) == .fresh(wanted: agent))
  }

  @Test func anEntryWithNoLaunchRecordHasItsFolderComparedWithTheEntrysOwn() {
    let moved = LaunchChange.Signature(cwd: "/home/alex/other", model: "opus", effort: nil, mcpAllow: [])
    #expect(LaunchChange.compare(launched: nil, wanted: moved, entryCwd: "/home/alex/proj") == .fresh(wanted: moved))
    // the rest is not known for such an entry: no restart storm after an upgrade
    let same = LaunchChange.Signature(cwd: "/home/alex/proj", model: "opus", effort: "low", mcpAllow: [])
    #expect(LaunchChange.compare(launched: nil, wanted: same, entryCwd: "/home/alex/proj") == .none)
    #expect(LaunchChange.compare(launched: nil, wanted: moved) == .none, "no session yet: nothing to compare")
    #expect(LaunchChange.compare(launched: nil, wanted: moved, unread: ["cwd"], entryCwd: "/home/alex/proj") == .none)
    let unknown = LaunchChange.Signature(cwd: nil, model: "opus", effort: nil, mcpAllow: [])
    #expect(LaunchChange.compare(launched: nil, wanted: unknown, entryCwd: "/home/alex/proj") == .none)
  }

  // MARK: 6. a config.threads entry that is not a thread

  @Test func anEntryThatIsNotAThreadIsLeftOutAndTheRestIsRead() throws {
    let cfg = """
      {"default_thread":"home","dedicated":{"enabled":true},"threads":[{"id":"home","kind":"fixed"},7,
      {"id":"trip","kind":"fixed","session":"dedicated"},"x",{"kind":"fixed"},null,[],
      {"id":"sub","kind":"fixed","session":"dedicated","parent_id":"trip","session_opts":{"cwd":"/home/alex/t/s"}}]}
      """
    let s = try #require(DedicatedSettings.readable(Data(cfg.utf8)), "one bad entry must not make the whole config unreadable")
    #expect(Set(s.threads.keys) == ["trip", "sub"])
    #expect(s.droppedEntries == [2, 4, 5, 6, 7])
    #expect(s.defaultThread == "home")
    #expect(DedicatedSettings.droppedEntriesLine([2]).contains("entry #2 isn't a thread object"))
    #expect(DedicatedSettings.droppedEntriesLine([2, 4]).contains("entries #2, #4 aren't thread objects"))
    // nothing dropped: nothing to say; no default thread named: general
    let clean = try #require(DedicatedSettings.readable(Data(#"{"dedicated":{"enabled":true},"threads":[{"id":"trip","kind":"fixed","session":"dedicated"}]}"#.utf8)))
    #expect(clean.droppedEntries == [] && clean.defaultThread == "general")
  }

  @Test func aParentLeftOutMakesItsSubThreadsOrphansWhichFailClosed() throws {
    let cfg = """
      {"dedicated":{"enabled":true},"threads":["was the parent",
      {"id":"sub","kind":"fixed","session":"dedicated","parent_id":"par","session_opts":{"cwd":"/home/alex/par/s","mcp_allow":["github"]}},
      {"id":"bare","kind":"fixed","session":"dedicated","parent_id":"par","session_opts":{"cwd":"/home/alex/par/b"}}]}
      """
    let s = try #require(DedicatedSettings.readable(Data(cfg.utf8)))
    #expect(s.droppedEntries == [1])
    #expect(s.threads["sub"]?.sub?.refusal?.contains("the parent thread is not there any more") == true)
    #expect(s.threads["bare"]?.mcpAllow == [], "no list of its own and no parent: the empty list, never none")
  }

  @Test func aThreadsValueThatIsNotAListIsStillUnreadable() {
    for threads in [#"{}"#, #""x""#, "3"] {
      #expect(DedicatedSettings.readable(Data(#"{"dedicated":{"enabled":true},"threads":\#(threads)}"#.utf8)) == nil, "\(threads)")
    }
  }

  // MARK: 7. the folder fence for a session that runs

  @Test func onlyAFirmVerdictSaysOutside() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let root = try #require(realpath(t.root, nil).map { p -> String in defer { free(p) }; return String(cString: p) })
    for d in ["/par/s", "/elsewhere/s"] { try FileManager.default.createDirectory(atPath: root + d, withIntermediateDirectories: true) }
    #expect(SubThreadFolder.fence(cwd: root + "/par/s", parentCwd: root + "/par") == .inside)
    #expect(SubThreadFolder.fence(cwd: root + "/par/not-made-yet", parentCwd: root + "/par") == .inside, "it would be made inside")
    #expect(SubThreadFolder.fence(cwd: root + "/elsewhere/s", parentCwd: root + "/par") == .inside, "an existing folder outside is its own, kept")
    #expect(SubThreadFolder.fence(cwd: root + "/elsewhere/gone", parentCwd: root + "/par") == .outside, "missing, outside: never made")
    #expect(SubThreadFolder.fence(cwd: root + "/par", parentCwd: root + "/par") == .outside, "the parent's own folder is not inside it")
    #expect(SubThreadFolder.fence(cwd: root + "/par/new/../../elsewhere", parentCwd: root + "/par") == .outside)
    #expect(SubThreadFolder.fence(cwd: "par/s", parentCwd: root + "/par") == .outside, "not absolute")
    // a parent that cannot be resolved now is no verdict
    #expect(SubThreadFolder.fence(cwd: root + "/par/s", parentCwd: root + "/gone") == .unknown)
    // a link that leads out is outside, firmly
    try FileManager.default.createSymbolicLink(atPath: root + "/par/link", withDestinationPath: root + "/elsewhere")
    #expect(SubThreadFolder.fence(cwd: root + "/par/link/s", parentCwd: root + "/par") == .outside)
  }
}

@Suite("Worker twins core: a narrowed Main")
struct WorkerTwinsNarrowedCoreTests {
  @Test func eachModeIsItsFlagOrItsSwitchOnAsClaudeCodeReadsIt() {
    for v in ["1", "true", "TRUE", "yes", "On", " 1 "] {
      for name in MainNarrowed.variables { #expect(MainNarrowed.mode(args: [], env: [name: v]) != nil, "\(name)=\(v)") }
    }
    for v in ["0", "false", "no", "off", "", "2"] {
      for name in MainNarrowed.variables { #expect(MainNarrowed.mode(args: [], env: [name: v]) == nil, "\(name)=\(v)") }
    }
    #expect(MainNarrowed.mode(args: ["--model", "opus", "--restricted"], env: [:])?.hasPrefix("restricted mode") == true)
    #expect(MainNarrowed.mode(args: ["--restricted=1"], env: [:]) != nil)
    #expect(MainNarrowed.mode(args: ["--safe-mode"], env: [:])?.hasPrefix("safe mode") == true)
    #expect(MainNarrowed.mode(args: ["--bare"], env: [:])?.hasPrefix("bare mode") == true)
    #expect(MainNarrowed.mode(args: [], env: ["CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG": "1"]) == "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG")
    #expect(MainNarrowed.mode(args: ["--restricted-thing", "--barely", "--safe-mode-ish", "--append-system-prompt"], env: ["OTHER": "1"]) == nil)
    // read as Claude Code reads them: another flag's value, or the prompt after `--`, narrows nothing
    #expect(MainNarrowed.mode(args: ["--append-system-prompt", "--restricted"], env: [:]) == nil)
    #expect(MainNarrowed.mode(args: ["--model", "opus", "--", "--bare"], env: [:]) == nil)
    let line = MainNarrowed.line("safe mode (--safe-mode or CLAUDE_CODE_SAFE_MODE)")
    #expect(line.contains("safe mode") && line.contains("turn that mode off") && line.contains("restart"))
  }

  /// Why a worker cannot be held to any of them: the spec drops every switch and never carries a flag, whatever it is built from.
  /// If this ever changes for one mode, the refusal can be narrowed for that mode.
  @Test func aWorkersSpecCarriesNoneOfTheSwitchesOrFlags() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.write(t.agentDir + "/.mcp.json", ["mcpServers": ["talos-app": ["command": "bun"]]])
    var i = fenceInputs(t, mainArgs: ["--dangerously-skip-permissions"] + MainNarrowed.flags)
    for name in MainNarrowed.variables { i.baseEnv[name] = "1" }
    let spec = try WorkerSpec.build(i)
    for name in MainNarrowed.variables { #expect(spec.env[name] == nil, "\(name)") }
    for flag in MainNarrowed.flags { #expect(!spec.args.contains(flag), "\(flag)") }
  }
}

@Suite("Worker twins core: a Main found running")
struct WorkerTwinsFoundRunningCoreTests {
  /// R1-1. What a pane found running is taken to be, case by case. Not known is never "none".
  @Test func aLaunchThatCannotBeReadIsNotTakenAsNotNarrowed() {
    let safe = "safe mode (--safe-mode or CLAUDE_CODE_SAFE_MODE)"
    // its real arguments or environment say so, whatever the settings say
    #expect(MainNarrowed.found(argv: ["claude", "--safe-mode"], env: [:], sameLaunch: false, configured: nil) == safe)
    #expect(MainNarrowed.found(argv: ["claude"], env: ["CLAUDE_CODE_SAFE_MODE": "1"], sameLaunch: true, configured: nil) == safe)
    // the launch the settings name: what they say
    #expect(MainNarrowed.found(argv: ["claude"], env: [:], sameLaunch: true, configured: safe) == safe)
    #expect(MainNarrowed.found(argv: ["claude"], env: [:], sameLaunch: true, configured: nil) == nil)
    // another launch: none only when both were read
    #expect(MainNarrowed.found(argv: ["claude"], env: ["PATH": "/usr/bin"], sameLaunch: false, configured: safe) == nil)
    #expect(MainNarrowed.found(argv: ["claude"], env: [:], sameLaunch: false, configured: nil) == MainNarrowed.unknown)
    #expect(MainNarrowed.found(argv: ["claude"], env: nil, sameLaunch: false, configured: nil) == MainNarrowed.unknown)
    #expect(MainNarrowed.found(argv: nil, env: nil, sameLaunch: false, configured: nil) == MainNarrowed.unknown)
    #expect(MainNarrowed.line(MainNarrowed.unknown).contains("restart the main session"))
  }
}

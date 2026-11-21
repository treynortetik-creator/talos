import Foundation
import Testing
@testable import TalosDesktopCore

/// What another Claude session's shell leaves in the environment (observed 2026-11-03: Claude Code turned transcript
/// saving off because of CLAUDE_CODE_CHILD_SESSION).
let pollutedClaudeEnv: [String: String] = [
  "CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_SESSION_ID": "0f1e2d3c-4b5a-4968-8776-655443322110",
  "CLAUDE_CODE_SESSION_ATTENDED": "1", "CLAUDE_CODE_BRIDGE_SESSION_ID": "bridge_x",
  "CLAUDE_CODE_MESSAGING_SOCKET": "/tmp/s.sock", "CLAUDE_CODE_MESSAGING_TOKEN": "tok",
  "CLAUDE_CODE_EXECPATH": "/home/alex/.local/bin/claude", "CLAUDE_CODE_ENTRYPOINT": "cli",
  "CLAUDE_CODE_SSE_PORT": "5555", "CLAUDE_CODE_SOMETHING_NEW": "1", "CLAUDECODE": "1", "CLAUDE_PID": "123",
  "CLAUDE_EFFORT": "high", "TMUX": "/tmp/tmux-1/x,1,0", "TMUX_PANE": "%3",
]

let claudeKeepList: [String: String] = [
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400000", "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "64000",
]

@Suite("ClaudeEnvScrub")
struct ClaudeEnvScrubTests {
  let base = ["PATH": "/usr/bin:/bin", "HOME": "/home/alex", "LANG": "en_US.UTF-8", "CLAUDE_CONFIG_DIR": "/home/alex/.claude-x"]

  @Test func buildDropsEveryMarkerButKeepsPathHomeAndTheKeepList() {
    let shell = base.merging(pollutedClaudeEnv) { a, _ in a }.merging(claudeKeepList) { a, _ in a }
    let env = LoginShellEnv.build(shellEnv: shell, overrides: ["TALOS_APP_BRIDGE": "1"])
    for k in pollutedClaudeEnv.keys { #expect(env[k] == nil, "\(k) leaked into the launch env") }
    #expect(env["PATH"] == "/usr/bin:/bin")
    #expect(env["HOME"] == "/home/alex")
    #expect(env["LANG"] == "en_US.UTF-8")
    #expect(env["CLAUDE_CONFIG_DIR"] == "/home/alex/.claude-x")
    for (k, v) in claudeKeepList { #expect(env[k] == v, "\(k) dropped") }
    #expect(env["TALOS_APP_BRIDGE"] == "1")
  }

  @Test func unknownFutureMarkersAreDroppedByPattern() {
    let env = LoginShellEnv.build(shellEnv: ["CLAUDE_CODE_BRAND_NEW_MARKER_2027": "1", "PATH": "/bin"], overrides: [:])
    #expect(env["CLAUDE_CODE_BRAND_NEW_MARKER_2027"] == nil)
  }

  @Test func theOwnersDesktopJsonEnvStillWinsForDeliberateVariables() {
    let env = LoginShellEnv.build(shellEnv: ["PATH": "/bin"], overrides: ["CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"])
    #expect(env["CLAUDE_CODE_DISABLE_TERMINAL_TITLE"] == "1")
  }

  @Test func aSessionMarkerInDesktopJsonIsStillRefused() {
    // An older adopt could have copied it from a polluted process into the owner's file.
    let env = LoginShellEnv.build(
      shellEnv: ["PATH": "/bin"], overrides: ["CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_SESSION_ID": "x"])
    #expect(env["CLAUDE_CODE_CHILD_SESSION"] == nil)
    #expect(env["CLAUDE_CODE_SESSION_ID"] == nil)
  }

  @Test func adoptDoesNotCopyMarkersIntoDesktopJson() {
    let snap = ProcessSnapshot(
      pid: 42, ppid: 1, pgid: 42, startTime: 1, argv: ["/home/alex/.local/bin/claude", "--x"],
      env: base.merging(pollutedClaudeEnv) { a, _ in a }.merging(claudeKeepList) { a, _ in a }
        .merging(["TALOS_APP_BRIDGE": "1"]) { a, _ in a },
      cwd: "/home/alex/agent")
    let p = AdoptPlan.from(snapshot: snap, agentsEntry: nil, loginEnv: ["PATH": "/usr/bin:/bin"])
    for k in pollutedClaudeEnv.keys { #expect(p?.env[k] == nil, "\(k) copied by adopt") }
    #expect(p?.env["TALOS_APP_BRIDGE"] == "1")
    #expect(p?.env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] == "400000")
  }

  /// Every place the app builds an environment to start claude (or run it) goes through `LoginShellEnv.build`. The GUI
  /// target cannot be linked here, so the paths are pinned by source: each file must call the shared helper and none
  /// may hand `ProcessInfo.processInfo.environment` to a claude launch directly.
  @Test(arguments: [
    ("TalosSupervisor/Supervisor.swift", "LoginShellEnv.build("), ("TalosDesktop/SupervisorController.swift", "LoginShellEnv.build("),
    ("TalosDesktop/TalosAppCLI.swift", "LoginShellEnv.build("), ("TalosDesktop/Onboarding.swift", "LoginShellEnv.build("),
    // "open claude here" starts from the app's own environment, so it scrubs that first, then asks for the shared recipe.
    ("TalosDesktop/TerminalWindow.swift", "ClaudeEnvScrub.scrub("),
    ("TalosDesktop/TerminalWindow.swift", "ThreadSessions.claudeEnvironment("),
  ])
  func everyLaunchPathUsesTheSharedBuilder(file: String, token: String) throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Sources")
    let text = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
    #expect(text.contains(token), "\(file) must use \(token)")
  }

  @Test func workersAndTmuxPanesScrubToo() throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Sources")
    let host = try String(contentsOf: sources.appendingPathComponent("TalosSupervisor/TmuxPtyHost.swift"), encoding: .utf8)
    // `env -i` and a launch file: a marker the tmux server holds never reaches a pane, and nothing is set on the server
    #expect(host.contains("LaunchFile.tmuxArgv"), "the tmux host must launch through the launch file")
    let tm = try String(contentsOf: sources.appendingPathComponent("TalosDesktopCore/TmuxCommands.swift"), encoding: .utf8)
    #expect(!tm.contains("set-environment") && !tm.contains("env: [String: String]"), "no tmux command may carry or set an environment")
  }

  // MARK: "open claude here" (ThreadSessions.claudeEnvironment)

  @Test func theHandOpenedClaudeDropsEveryInheritedMarkerAndKeepsTheKeepList() {
    let shell = base.merging(pollutedClaudeEnv) { a, _ in a }.merging(claudeKeepList) { a, _ in a }
    let env = ThreadSessions.claudeEnvironment(from: shell, talosHome: "/home/alex/.config/talos/app")
    for k in pollutedClaudeEnv.keys { #expect(env[k] == nil, "\(k) reached the hand-opened claude") }
    #expect(env["PATH"] == "/usr/bin:/bin")
    #expect(env["CLAUDE_CONFIG_DIR"] == "/home/alex/.claude-x")
    for (k, v) in claudeKeepList { #expect(env[k] == v, "\(k) dropped") }
  }

  @Test func theHandOpenedClaudeKeepsDeliberateSettingsButRefusesDeliberateMarkers() {
    let env = ThreadSessions.claudeEnvironment(
      from: ["PATH": "/bin", "CLAUDE_EFFORT": "high", "CLAUDE_CODE_CHILD_SESSION": "1"],
      deliberate: ["CLAUDE_EFFORT": "max", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1", "CLAUDE_CODE_SESSION_ID": "x"])
    #expect(env["CLAUDE_EFFORT"] == "max", "the owner's own setting survives")
    #expect(env["CLAUDE_CODE_DISABLE_TERMINAL_TITLE"] == "1")
    #expect(env["CLAUDE_CODE_CHILD_SESSION"] == nil)
    #expect(env["CLAUDE_CODE_SESSION_ID"] == nil)
  }

  // MARK: CLAUDE_EFFORT

  @Test func aDeliberateClaudeEffortInDesktopJsonIsKeptButAnInheritedOneIsDropped() {
    let kept = LoginShellEnv.build(shellEnv: ["PATH": "/bin", "CLAUDE_EFFORT": "low"], overrides: ["CLAUDE_EFFORT": "high"])
    #expect(kept["CLAUDE_EFFORT"] == "high")
    let dropped = LoginShellEnv.build(shellEnv: ["PATH": "/bin", "CLAUDE_EFFORT": "low"], overrides: [:])
    #expect(dropped["CLAUDE_EFFORT"] == nil)
  }

  // MARK: Copy Terminal command

  @Test func copyTerminalCommandDropsMarkersFromEnvAndUnsetsThemInThePastedShell() {
    let spec = LaunchSpec(
      agentDir: "/home/alex/agent",
      env: ["CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_SESSION_ID": "x", "CLAUDE_EFFORT": "high", "FOO": "bar"],
      program: "claude", args: ["--x"], resumeId: nil)
    let text = spec.render()
    #expect(!text.contains("CLAUDE_CODE_CHILD_SESSION=") && !text.contains("CLAUDE_CODE_SESSION_ID="), "\(text)")
    #expect(text.contains("CLAUDE_EFFORT=high"), "a deliberate setting stays: \(text)")
    #expect(text.contains("FOO=bar"))
    let words = text.split(separator: " ").map(String.init)
    let unset = words.indices.dropLast().filter { words[$0] == "-u" }.map { words[$0 + 1] }
    for k in ClaudeEnvScrub.sessionMarkers { #expect(unset.contains(k), "\(k) is not unset in: \(text)") }
    #expect(!unset.contains("CLAUDE_EFFORT"), "unsetting a setting the command also sets")
    #expect(text.hasPrefix("cd /home/alex/agent && env -u "), "\(text)")
    #expect(text.hasSuffix("claude --x"))
  }

  @Test func theUnsetPrefixStillParsesBackToTheSameFields() throws {
    let spec = LaunchSpec(agentDir: "/home/alex/agent", env: ["FOO": "bar"], program: "claude", args: ["--x"], resumeId: nil)
    #expect(try LaunchSpec.parse(spec.render(), home: "/home/alex") == spec)
  }

  // MARK: one list, checked from both sides (the bridge test reads this file's lists; this reads the bridge's)

  @Test func theNameListsMatchTheBridgesClaudeEnvTs() throws {
    let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let ts = try String(contentsOf: repo.appendingPathComponent("apps/bridge/src/claude-env.ts"), encoding: .utf8)
    func tsList(_ name: String) throws -> [String] {
      let at = try #require(ts.range(of: "const \(name) ="), "\(name) not found in claude-env.ts")
      let open = try #require(ts[at.upperBound...].firstIndex(of: "["))
      let close = try #require(ts[open...].firstIndex(of: "]"))
      return ts[open..<close].split(separator: "'").enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) }.sorted()
    }
    #expect(try tsList("ALWAYS_DROP") == ClaudeEnvScrub.alwaysDrop.sorted())
    #expect(try tsList("KEEP") == ClaudeEnvScrub.keep.sorted())
    #expect(try tsList("KEEP_PREFIXES") == ClaudeEnvScrub.keepPrefixes.sorted())
    #expect(try tsList("SESSION_MARKERS") == ClaudeEnvScrub.sessionMarkers.sorted())
  }
}

/// Main's environment is the login shell's plus `desktop.json` `env`, and never a thread session's identity: `install.sh` run from a thread
/// session left TALOS_APP_WORKER_THREAD (with the role and the nonce) in the app's environment, and Main's bridge refused to be the live one.
@Suite("Main's launch env never carries a thread session's identity")
struct MainLaunchEnvTests {
  static let worker: [String: String] = [
    "TALOS_APP_WORKER_THREAD": "talos", "TALOS_SESSION_ROLE": "worker", "TALOS_APP_WORKER_NONCE": "0123abcd",
  ]

  @Test func theLoginEnvAndDesktopJsonEnvAreMergedWithoutTheWorkerIdentity() {
    let shell = ["PATH": "/usr/bin:/bin", "HOME": "/home/alex", "MY_LOGIN_VAR": "1"].merging(Self.worker) { a, _ in a }
    let env = LoginShellEnv.build(shellEnv: shell, overrides: ["PATH": "/opt/bun/bin:/usr/bin:/bin", "TALOS_APP_BRIDGE": "1"])
    for k in Self.worker.keys { #expect(env[k] == nil, "\(k) leaked into Main's env") }
    #expect(env["PATH"] == "/opt/bun/bin:/usr/bin:/bin", "desktop.json env wins over the login env")
    #expect(env["MY_LOGIN_VAR"] == "1" && env["HOME"] == "/home/alex" && env["TALOS_APP_BRIDGE"] == "1")
  }

  @Test func desktopJsonCannotSetThemEither() {
    let env = LoginShellEnv.build(shellEnv: ["PATH": "/bin"], overrides: Self.worker.merging(["KEEP": "1"]) { a, _ in a })
    for k in Self.worker.keys { #expect(env[k] == nil, "\(k) set from desktop.json") }
    #expect(env["KEEP"] == "1")
  }

  /// What a worker launch sets for itself (WorkerSpec): the no-channel state dirs and the claude.ai connectors switch. Main gets none of them from
  /// a leaked environment; `desktop.json` can still set them on purpose, and a state dir that is the owner's own stays.
  @Test func aWorkersChannelSwitchesDoNotReachMain() {
    let shell = [
      "PATH": "/bin", "TELEGRAM_STATE_DIR": "/h/.config/talos/app/workers/_nochannel",
      "IMESSAGE_STATE_DIR": "/h/.config/talos/app/workers/_nochannel", "ENABLE_CLAUDEAI_MCP_SERVERS": "false",
    ]
    let env = LoginShellEnv.build(shellEnv: shell, overrides: [:])
    #expect(env["TELEGRAM_STATE_DIR"] == nil && env["IMESSAGE_STATE_DIR"] == nil && env["ENABLE_CLAUDEAI_MCP_SERVERS"] == nil)
    let own = LoginShellEnv.build(shellEnv: ["TELEGRAM_STATE_DIR": "/h/.claude/channels/telegram", "PATH": "/bin"], overrides: [:])
    #expect(own["TELEGRAM_STATE_DIR"] == "/h/.claude/channels/telegram", "the owner's own state dir stays")
    let set = LoginShellEnv.build(shellEnv: shell, overrides: ["ENABLE_CLAUDEAI_MCP_SERVERS": "true"])
    #expect(set["ENABLE_CLAUDEAI_MCP_SERVERS"] == "true", "desktop.json sets it on purpose")
  }

  @Test func theMarkersAreInheritedNames() {
    for k in Self.worker.keys { #expect(ClaudeEnvScrub.isInherited(k)) }
  }
}

@Suite("Main running without its bridge: the owner's line")
struct BridgeNotLiveWordingTests {
  @Test func saysItWithAndWithoutTheReason() {
    #expect(SupervisorNotice.bridgeNotLive(nil) == "Your agent is running but Talos on your Mac didn't start")
    #expect(
      SupervisorNotice.bridgeNotLive("Executable not found in $PATH: \"bun\"")
        == "Your agent is running but Talos on your Mac didn't start: Executable not found in $PATH: \"bun\"")
  }
}

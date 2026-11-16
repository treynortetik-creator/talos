import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// How an agent pane is launched, against a real private tmux server. tmux runs only `/usr/bin/env -i /bin/sh <launch file>`:
/// the launch's environment is in that file, never in the tmux server's own environment (which every later pane of the shared
/// server would see) and never in an argv (which `ps` shows to any local process).
@Suite("Pane launch: the environment stays out of tmux", .serialized, .enabled(if: Rig.hasTmux))
struct PaneLaunchEnvTests {
  static let secretName = "TALOS_TEST_LAUNCH_ONLY"
  static let secret = "launch-only-\(UUID().uuidString.prefix(8))"

  /// A tmux wrapper that logs each invocation's argv (one line, elements joined by a unit separator), and for a pane command
  /// the launch file it was handed: whether it exists, its mode, its folder's mode and its first line.
  static func loggingShim(root: String, failNewSession: Bool = false) throws -> (shim: String, argvLog: String, fileLog: String) {
    let shim = root + "/tmux-log"
    let argvLog = root + "/tmux-argv.log"
    let fileLog = root + "/tmux-file.log"
    try """
    #!/bin/bash
    (IFS=$'\\x1f'; printf '%s\\n' "$*") >> '\(argvLog)'
    prev=
    for a in "$@"; do
      if [ "$prev" = /bin/sh ]; then
        if [ -f "$a" ]; then
          printf 'seen %s %s %s\\n' "$(stat -f '%Lp' "$a")" "$(stat -f '%Lp' "$(dirname "$a")")" "$(head -n 1 "$a")" >> '\(fileLog)'
        else
          echo missing >> '\(fileLog)'
        fi
      fi
      prev=$a
    done
    if \(failNewSession ? "true" : "false"); then
      for a in "$@"; do [ "$a" = new-session ] && { echo "refused by the test" >&2; exit 1; }; done
    fi
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    return (shim, argvLog, fileLog)
  }

  /// The pane commands (new-session, new-window, respawn-pane) in a shim's argv log.
  static func paneCommands(_ argvLog: String) -> [[String]] {
    let log = (try? String(contentsOfFile: argvLog, encoding: .utf8)) ?? ""
    return log.split(separator: "\n").map { $0.components(separatedBy: "\u{1f}") }
      .filter { $0.contains("new-session") || $0.contains("respawn-pane") || $0.contains("new-window") }
  }

  static func launchFiles(_ r: Rig) -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: r.launchDir)) ?? []
  }

  static func directHost(_ r: Rig, tmux: String? = nil, session: String = "probe") -> TmuxPtyHost {
    TmuxPtyHost(
      commands: TmuxCommands(tmux: tmux ?? Rig.tmuxPath!, socket: r.socket, configPath: Rig.tmuxConf, session: session),
      launchDir: r.launchDir, baseEnv: r.loginEnv, pollInterval: 0.2)
  }

  private func dumped(_ r: Rig, _ n: Int) -> String? {
    guard let s = try? String(contentsOfFile: r.agentDir + "-envdump.\(n)", encoding: .utf8), s.contains("PATH=") else { return nil }
    return s
  }

  /// In the app's own environment (the login env the host is made with), not a setting of the launch.
  static let appOnly = "TALOS_TEST_APP_ONLY"

  private func rig() throws -> Rig {
    try Rig(.tmux, scenario: "dev-dialog.sh", env: [Self.secretName: Self.secret], loginExtra: [Self.appOnly: "1"]) { c in
      c.env["FAKE_ENV_DUMP"] = c.agentDir + "-envdump"
    }
  }

  /// Main's own variables (its config's `env`) reach Main, and only Main: not the shared tmux server's global environment, which
  /// the server takes from the process that starts it, and not the session's. A cold start and a restart (respawn-pane).
  @Test func mainsEnvironmentNeverBecomesTheTmuxServers() throws {
    let r = try rig()
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(10) { dumped(r, 1) != nil }, "claude started")
    #expect(dumped(r, 1)?.contains("\(Self.secretName)=\(Self.secret)") == true, "the launch's own variable reached Main")
    for args in [["show-environment", "-g"], ["show-environment", "-t", "agent"]] {
      let out = r.tmuxRun(args)
      #expect(out.ok, "\(args): \(out.err)")
      #expect(!out.out.contains(Self.secret) && !out.out.contains(Self.secretName), "\(args) holds Main's variable: \(out.out)")
      #expect(!out.out.contains(Self.appOnly), "\(args): the server runs with more than the plain basics: \(out.out)")
    }
    r.sup.restartCold()
    #expect(r.wait(20) { r.sup.tickNow(); return dumped(r, 2) != nil }, "second start: \(r.phase()) \(r.audit)")
    #expect(dumped(r, 2)?.contains("\(Self.secretName)=\(Self.secret)") == true)
    #expect(!r.tmuxRun(["show-environment", "-g"]).out.contains(Self.secret), "a restart put it there")
  }

  /// No variable's value is in the argv of any tmux command the host runs; the pane command is exactly the launch file's.
  @Test func noEnvironmentValueIsInAnyTmuxArgv() throws {
    let r = try rig()
    defer { r.teardown() }
    let s = try Self.loggingShim(root: r.root)
    r.tmuxBin = s.shim
    r.makeSupervisor()
    try coldStartConfirmed(r)
    #expect(r.wait(10) { dumped(r, 1) != nil })
    r.sup.restartCold()
    #expect(r.wait(20) { r.sup.tickNow(); return dumped(r, 2) != nil }, "second start: \(r.phase()) \(r.audit)")
    let log = (try? String(contentsOfFile: s.argvLog, encoding: .utf8)) ?? ""
    #expect(!log.contains(Self.secret), "an env value was in a tmux argv")
    #expect(!log.contains(r.agentsDir), "FAKE_AGENTS_DIR's value was in a tmux argv")
    let panes = Self.paneCommands(s.argvLog)
    #expect(panes.count >= 2, "a start and a restart: \(panes)")
    for argv in panes {
      #expect(!argv.contains("-e"), "\(argv)")
      let cmd = Array(argv.drop { $0 != "--" }.dropFirst().prefix(4))
      #expect(Array(cmd.prefix(3)) == ["/usr/bin/env", "-i", "/bin/sh"], "\(argv)")
      #expect(cmd.count == 4 && cmd[3].hasPrefix(r.launchDir + "/"), "\(argv)")
    }
  }

  /// tmux runs a one-element command through `sh -c`, so a path is read by the shell. The agent runs as named, every time.
  @Test(arguments: [[], ["a b", "$HOME", "it's;", "`echo x`", "\"q\""]])
  func anAgentPathWithShellCharactersRunsAsNamed(args: [String]) throws {
    let r = try rig()
    defer { r.teardown() }
    let dir = r.root + "/odd $HOME 'q' \"d\" `echo b`; x"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let prog = dir + "/agent $1"
    let out = r.root + "/argv-out"
    try "#!/bin/sh\nprintf '%s\\n' \"$0\" \"$@\" > '\(out).tmp' && mv '\(out).tmp' '\(out)'\nexec /bin/sleep 300\n"
      .write(toFile: prog, atomically: true, encoding: .utf8)
    chmod(prog, 0o755)
    let h = Self.directHost(r)
    defer { h.close() }
    try h.start(executable: prog, args: args, env: r.loginEnv, cwd: r.agentDir)
    #expect(r.wait(10) { FileManager.default.fileExists(atPath: out) }, "the agent ran: \(r.tmuxRun(["list-panes", "-a"]).out)")
    let got = (try? String(contentsOfFile: out, encoding: .utf8)) ?? ""
    #expect(got == ([prog] + args).map { $0 + "\n" }.joined())
  }

  /// The launch file is 0600 in a 0700 folder, starts by removing itself, and is gone once the pane has started.
  @Test func theLaunchFileIsPrivateAndGoneOnceStarted() throws {
    let r = try rig()
    defer { r.teardown() }
    let s = try Self.loggingShim(root: r.root)
    let h = Self.directHost(r, tmux: s.shim)
    defer { h.close() }
    try h.start(executable: "/bin/sleep", args: ["300"], env: r.loginEnv, cwd: r.agentDir)
    let seen = (try? String(contentsOfFile: s.fileLog, encoding: .utf8)) ?? ""
    #expect(seen == "seen 600 700 rm -f -- \"$0\"\n", "\(seen)")
    #expect(r.wait(5) { Self.launchFiles(r).isEmpty }, "left behind: \(Self.launchFiles(r))")
    #expect(h.childPid != nil)
  }

  /// A file an earlier start of this session left (its pane died before reading it) goes; another session's stays.
  @Test func aStaleLaunchFileOfThisSessionIsRemovedAtTheNextStart() throws {
    let r = try rig()
    defer { r.teardown() }
    try FileManager.default.createDirectory(atPath: r.launchDir, withIntermediateDirectories: true)
    chmod(r.launchDir, 0o700)
    let stale = LaunchFile.newPath(in: r.launchDir, session: "probe")
    let other = LaunchFile.newPath(in: r.launchDir, session: "probe-b")
    for p in [stale, other] { FileManager.default.createFile(atPath: p, contents: Data("x\n".utf8)) }
    let h = Self.directHost(r)
    defer { h.close() }
    try h.start(executable: "/bin/sleep", args: ["300"], env: r.loginEnv, cwd: r.agentDir)
    #expect(r.wait(5) { Self.launchFiles(r) == [(other as NSString).lastPathComponent] }, "\(Self.launchFiles(r))")
  }

  /// tmux refused the launch: the file it was handed is removed, and nothing is left in the folder.
  @Test func aFailedLaunchLeavesNoFile() throws {
    let r = try rig()
    defer { r.teardown() }
    let s = try Self.loggingShim(root: r.root, failNewSession: true)
    let h = Self.directHost(r, tmux: s.shim)
    defer { h.close() }
    #expect(throws: (any Error).self) {
      try h.start(executable: "/bin/sleep", args: ["300"], env: r.loginEnv, cwd: r.agentDir)
    }
    let seen = (try? String(contentsOfFile: s.fileLog, encoding: .utf8)) ?? ""
    #expect(seen.hasPrefix("seen 600 700"), "tmux was handed a launch file: \(seen)")
    #expect(Self.launchFiles(r).isEmpty, "left behind: \(Self.launchFiles(r))")
  }

  /// A name the shell can't `export` is refused before anything starts: no pane, no file.
  @Test(arguments: ["BAD-NAME", "1A", "A B", "A=B", "", "NAME;"])
  func aBadEnvironmentNameIsRefused(name: String) throws {
    let r = try rig()
    defer { r.teardown() }
    let h = Self.directHost(r)
    defer { h.close() }
    #expect(throws: (any Error).self) {
      try h.start(executable: "/bin/sleep", args: ["300"], env: r.loginEnv.merging([name: "x"]) { _, b in b }, cwd: r.agentDir)
    }
    #expect(!h.sessionExists(), "a pane started with \(name)")
    #expect(Self.launchFiles(r).isEmpty, "left behind: \(Self.launchFiles(r))")
  }
}

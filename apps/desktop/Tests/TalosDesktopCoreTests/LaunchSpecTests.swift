import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("LaunchSpec")
struct LaunchSpecTests {
  let home = "/home/example"
  let uuid = "0f1e2d3c-4b5a-4968-8776-655443322110"

  @Test func parsesAnOwnerShapedCommand() throws {
    let cmd =
      "cd ~/agent-folder && TALOS_APP_BRIDGE=1 MCP_PROTOCOL_NEGOTIATION=legacy claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official --dangerously-load-development-channels server:talos-app --resume \(uuid.uppercased())"
    let s = try LaunchSpec.parse(cmd, home: home)
    #expect(s.agentDir == "/home/example/agent-folder")
    #expect(s.env == ["TALOS_APP_BRIDGE": "1", "MCP_PROTOCOL_NEGOTIATION": "legacy"])
    #expect(s.program == "claude")
    #expect(
      s.args == [
        "--dangerously-skip-permissions", "--channels", "plugin:telegram@claude-plugins-official",
        "--dangerously-load-development-channels", "server:talos-app",
      ])
    #expect(s.resumeId == uuid)
  }

  @Test func quotesAndTildes() throws {
    let s = try LaunchSpec.parse(#"cd "/tmp/my folder" && A='x y' B="q\"z" ~/.local/bin/claude --name 'it'"'"'s'"#, home: home)
    #expect(s.agentDir == "/tmp/my folder")
    #expect(s.env == ["A": "x y", "B": "q\"z"])
    #expect(s.program == "/home/example/.local/bin/claude")
    #expect(s.args == ["--name", "it's"])
    #expect(s.resumeId == nil)
    let t = try LaunchSpec.parse("V=~/x claude", home: home)
    #expect(t.env["V"] == "/home/example/x")
  }

  @Test(arguments: [
    "claude; rm -rf /", "claude | tee x", "claude $(whoami)", "claude `id`", "claude > out", "claude < in",
    "claude &", "claude\nrm x", "claude --x $HOME", "claude \"$(id)\"", "claude *", "(claude)", "claude && claude",
    "cd a && cd b && claude", "cd && claude", "echo claude", "", "FOO=1", "claude -p hi", "claude --print",
    "claude --resume not-a-uuid", "claude --resume", "claude 'unterminated",
  ])
  func refusesWhatAShellWouldDoMoreWith(_ cmd: String) {
    #expect(throws: LaunchSpec.ParseError.self) { try LaunchSpec.parse(cmd, home: home) }
  }

  @Test func renderRoundTrips() throws {
    let s = LaunchSpec(
      agentDir: "/tmp/a b", env: ["X": "it's", "Y": "1"], program: "claude",
      args: ["--name", "two words", "--channels", "plugin:t@x"], resumeId: uuid)
    let text = s.render()
    #expect(text.hasPrefix("cd '/tmp/a b' && env -u "))
    #expect(text.contains(" X='it'\\''s' Y=1 claude --name 'two words'"))
    #expect(text.hasSuffix("--resume \(uuid)"))
    #expect(try LaunchSpec.parse(text, home: home) == s)
  }
}

@Suite("ResumeRewrite")
struct ResumeRewriteTests {
  @Test func stripsEverySessionFlagThenAppendsOne() {
    let args = ["--a", "--resume", "x", "-r", "y", "--session-id=z", "--continue", "-c", "--fork-session", "--b"]
    #expect(ResumeRewrite.strip(args) == ["--a", "--b"])
    #expect(ResumeRewrite.apply(args, .resume("id1")) == ["--a", "--b", "--resume", "id1"])
    #expect(ResumeRewrite.apply(args, .newSession("id2")) == ["--a", "--b", "--session-id", "id2"])
  }

  @Test func aFollowingFlagIsNotAValue() {
    #expect(ResumeRewrite.strip(["--resume", "--verbose"]) == ["--verbose"])
    #expect(ResumeRewrite.sessionId(in: ["--resume", "--verbose"]) == nil)
    #expect(ResumeRewrite.sessionId(in: ["--resume=abc", "--session-id", "def"]) == "def")
  }
}

@Suite("LoginShellEnv")
struct LoginShellEnvTests {
  @Test func parsesAfterTheMarkerAndDropsTheDenylist() throws {
    var raw = Data("rc noise\nmore".utf8)
    raw += Data((LoginShellEnv.marker + "\u{0}").utf8)
    for kv in [
      "PATH=/usr/bin:/bin", "HOME=/home/example", "TERM_PROGRAM=Apple_Terminal", "SHLVL=2", "PWD=/x", "_=/usr/bin/env",
      "TMUX=/tmp/x", "CLAUDECODE=1", "MULTI=a=b", "EMPTY=",
    ] {
      raw += Data((kv + "\u{0}").utf8)
    }
    let shell = try #require(LoginShellEnv.parse(raw))
    #expect(shell["MULTI"] == "a=b")
    #expect(shell["EMPTY"] == "")
    let env = LoginShellEnv.build(shellEnv: shell, overrides: ["TALOS_APP_BRIDGE": "1", "PATH": "/opt/bin"])
    for k in ["TERM_PROGRAM", "SHLVL", "PWD", "_", "TMUX", "CLAUDECODE"] { #expect(env[k] == nil, "\(k) kept") }
    #expect(env["PATH"] == "/opt/bin", "desktop.json env wins")
    #expect(env["TALOS_APP_BRIDGE"] == "1")
    #expect(env["TERM"] == "xterm-256color")
    #expect(env["COLORTERM"] == "truecolor")
  }

  @Test func noMarkerMeansTheShellFailed() {
    #expect(LoginShellEnv.parse(Data("PATH=/x\u{0}".utf8)) == nil)
  }

  @Test func whichUsesPathOnly() {
    let exe: Set = ["/b/claude", "/abs/claude"]
    #expect(LoginShellEnv.which("claude", path: "/a:/b", isExecutable: exe.contains) == "/b/claude")
    #expect(LoginShellEnv.which("/abs/claude", path: nil, isExecutable: exe.contains) == "/abs/claude")
    #expect(LoginShellEnv.which("claude", path: "/a", isExecutable: exe.contains) == nil)
  }
}

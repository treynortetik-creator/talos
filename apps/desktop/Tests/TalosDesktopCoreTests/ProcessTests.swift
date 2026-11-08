import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("AgentsList")
struct AgentsListTests {
  @Test func tolerantDecode() throws {
    let json = """
      [{"pid":123,"cwd":"/a","kind":"interactive","startedAt":1,"sessionId":"ABC","status":"busy"},
       {"id":"j1","cwd":"/a","kind":"background","startedAt":2,"sessionId":"x","state":"working"},
       {"pid":456,"cwd":"/b","kind":"background","startedAt":3,"status":"idle","state":"working"},
       "junk", {"kind":"interactive"}]
      """
    let e = try #require(AgentsList.decode(Data(json.utf8)))
    #expect(e.count == 4)
    #expect(AgentsList.interactive(e, pid: 123)?.sessionId == "abc")
    #expect(AgentsList.interactive(e, pid: 456) == nil, "background entries are never the interactive one")
    #expect(e[1].pid == nil && e[1].state == "working")
  }

  @Test func onlyBackgroundEntries() throws {
    let e = try #require(AgentsList.decode(Data(#"[{"id":"j","kind":"background","state":"working"}]"#.utf8)))
    #expect(AgentsList.interactive(e, pid: 1) == nil)
    #expect(AgentsList.decode(Data("not json".utf8)) == nil, "unreadable is not 'no sessions'")
    #expect(AgentsList.decode(Data(#"{"agents":[]}"#.utf8)) == [])
  }
}

@Suite("ProcessInspect")
struct ProcessInspectTests {
  @Test func parsesProcArgs2() throws {
    var b: [UInt8] = [2, 0, 0, 0]
    b += Array("/bin/claude".utf8) + [0, 0, 0]
    b += Array("claude".utf8) + [0] + Array("--x".utf8) + [0]
    // One piece at a time: the whole chain in one expression is too much for some toolchains to type-check in reasonable time.
    b += Array("A=1".utf8)
    b += [0]
    b += Array("B=x=y".utf8)
    b += [0, 0]
    b += Array("ptr_munge=".utf8)
    b += [0]
    let (argv, env) = try #require(ProcessInspect.parseProcArgs2(b))
    #expect(argv == ["claude", "--x"])
    #expect(env == ["A": "1", "B": "x=y"])
    #expect(ProcessInspect.parseProcArgs2([1, 0]) == nil)
  }

  @Test func readsOurselves() throws {
    let me = try #require(ProcessInspect.snapshot(getpid()))
    #expect(me.pgid == getpgrp())
    #expect(me.ppid == getppid())
    #expect(me.startTime > 1_700_000_000)
    #expect(!me.argv.isEmpty)
    #expect(me.cwd == FileManager.default.currentDirectoryPath || me.cwd != nil)
    #expect(ProcessInspect.basic(0) == nil)
    #expect(ProcessInspect.alive(getpid()))
    #expect(!ProcessInspect.groupAlive(0) && !ProcessInspect.groupAlive(1))
  }

  @Test func psInfoSplitsLikeTheBridge() {
    let p = PsInfo.parse("Thu Oct 29 10:00:00 2026     bun apps/bridge/src/server.ts\n")
    #expect(p == PsInfo(lstart: "Thu Oct 29 10:00:00 2026", command: "bun apps/bridge/src/server.ts"))
    #expect(PsInfo.parse("  \n") == nil)
  }
}

@Suite("TakeoverCheck")
struct TakeoverCheckTests {
  let ours: Int32 = 500
  func snap(_ pid: Int32, pgid: Int32, start: Double = 1000, argv: [String], cwd: String? = nil) -> ProcessSnapshot {
    ProcessSnapshot(pid: pid, ppid: 1, pgid: pgid, startTime: start, argv: argv, cwd: cwd)
  }
  var poller: [String] { ["bun", "run", "--cwd", "/x", "server.ts"] }

  @Test func aPollerInAnotherGroupBlocks() {
    let i = TakeoverCheck.Inputs(
      ourPgids: [ours], botPid: .init(pid: 42, fileModifiedAt: 1001, holder: snap(42, pgid: 40, argv: poller)),
      bridgePid: nil, agents: nil, processes: [40: snap(40, pgid: 40, argv: ["claude"], cwd: "/other")])
    let b = TakeoverCheck.check(i)
    #expect(b.count == 1)
    #expect(b.first?.resource == .telegram)
    #expect(b.first?.sessionPid == 40)
    #expect(b.first?.message == "Another Claude session (pid 40, folder /other) holds Telegram. Quit it first, or press \u{201C}Find a running session\u{201D} to take it over.")
  }

  @Test func aPollerInsideOurGroupOrTheJustExitedOneDoesNot() {
    let i = TakeoverCheck.Inputs(
      ourPgids: [ours, 77], botPid: .init(pid: 42, fileModifiedAt: 1001, holder: snap(42, pgid: 77, argv: poller)),
      bridgePid: nil, agents: nil, processes: [:])
    #expect(TakeoverCheck.check(i).isEmpty)
  }

  @Test func aRecycledBotPidIsIgnored() {
    // bot.pid names a pid that now belongs to a process started after the file was written.
    let i = TakeoverCheck.Inputs(
      ourPgids: [ours],
      botPid: .init(pid: 42, fileModifiedAt: 1000, holder: snap(42, pgid: 40, start: 5000, argv: poller)),
      bridgePid: nil, agents: nil, processes: [:])
    #expect(TakeoverCheck.check(i).isEmpty)
    let notAPoller = TakeoverCheck.Inputs(
      ourPgids: [ours], botPid: .init(pid: 42, fileModifiedAt: 1001, holder: snap(42, pgid: 40, argv: ["vim"])),
      bridgePid: nil, agents: nil, processes: [:])
    #expect(TakeoverCheck.check(notAPoller).isEmpty)
  }

  @Test func theBridgeNeedsTheSameStartTimeAndEntry() {
    let rec = TakeoverCheck.BridgePidRecord(pid: 9, startedAt: "Thu Oct 29 10:00:00 2026", instance: "i")
    let live = PsInfo(lstart: "Thu Oct 29 10:00:00 2026", command: "bun apps/bridge/src/server.ts")
    let h = snap(9, pgid: 8, argv: ["bun", "apps/bridge/src/server.ts"])
    func run(_ ps: PsInfo?, _ g: Set<Int32> = [500]) -> [TakeoverCheck.Blocker] {
      TakeoverCheck.check(
        .init(ourPgids: g, botPid: nil, bridgePid: .init(record: rec, ps: ps, holder: h), agents: nil, processes: [:]))
    }
    #expect(run(live).map(\.resource) == [.bridge])
    #expect(run(live, [8]).isEmpty, "inside our group")
    #expect(run(PsInfo(lstart: "Fri Oct 30 10:00:00 2026", command: live.command)).isEmpty, "recycled pid")
    #expect(run(PsInfo(lstart: rec.startedAt, command: "sleep 9")).isEmpty, "not a bridge")
    #expect(run(nil).isEmpty, "gone")
  }

  @Test func anInteractiveSessionAnywhereWithChannelsBlocks() {
    let agents = [
      AgentEntry(kind: "interactive", pid: 60, sessionId: "s", status: "idle", cwd: "/elsewhere"),
      AgentEntry(kind: "interactive", pid: 61, sessionId: "t", status: "idle", cwd: "/quiet"),
      AgentEntry(kind: "interactive", pid: ours, sessionId: "u", status: "idle", cwd: "/ours"),
      AgentEntry(kind: "background", pid: 62, sessionId: "v", status: nil, cwd: "/bg"),
    ]
    let procs: [Int32: ProcessSnapshot] = [
      60: snap(60, pgid: 60, argv: ["claude", "--dangerously-load-development-channels", "server:talos-app"]),
      61: snap(61, pgid: 61, argv: ["claude", "--model", "x"]),
      ours: snap(ours, pgid: ours, argv: ["claude", "--channels", "plugin:t@x"]),
      62: snap(62, pgid: 62, argv: ["claude", "--channels", "x"]),
    ]
    let b = TakeoverCheck.check(.init(ourPgids: [ours], botPid: nil, bridgePid: nil, agents: agents, processes: procs))
    #expect(b.map(\.sessionPid) == [60])
    #expect(b.first?.folder == "/elsewhere")
    #expect(TakeoverCheck.argvHoldsChannels(["--channels=plugin:x"]))
    #expect(TakeoverCheck.argvHoldsChannels(["a,server:talos-app"]))
    #expect(!TakeoverCheck.argvHoldsChannels(["server:talos-app-evil"]))
  }
}

@Suite("TmuxCommands")
struct TmuxCommandsTests {
  let t = TmuxCommands(tmux: "/opt/tmux", socket: "talos", configPath: "/app/tmux.conf")

  @Test func everyCommandNamesOurSocketAndConfig() {
    for argv in [
      t.hasSession(), t.newSession(argv: ["claude"], env: [:], cwd: "/a"), t.respawnPane(argv: ["c"], env: [:], cwd: "/a"),
      t.paneState(), t.capturePane(), t.sendBytes([13]), t.killSession(), t.attach(), t.setOption("k", "v"),
      t.showOption("k"), t.clearHistory(), t.captureRecent(lines: 10),
    ] {
      #expect(Array(argv.prefix(5)) == ["/opt/tmux", "-L", "talos", "-f", "/app/tmux.conf"])
    }
  }

  @Test func respawnClearsHistoryInTheSameInvocation() {
    // One tmux invocation (one `;` list): a later call could wipe the line a child that exits at once has printed.
    let a = t.withPane("%7").respawnPane(argv: ["c", "--resume", "id"], env: [:], cwd: "/a")
    #expect(a.suffix(8) == ["--", "c", "--resume", "id", ";", "clear-history", "-t", "%7"])
  }

  @Test func argvNotAShellString() {
    let a = t.newSession(argv: ["/bin/claude", "--name", "a b"], env: ["B": "2", "A": "1"], cwd: "/x y")
    #expect(
      a.suffix(14) == [
        "-x", "120", "-y", "40", "-c", "/x y", "-e", "A=1", "-e", "B=2", "--", "/bin/claude", "--name", "a b",
      ])
    #expect(t.sendBytes([0x0d, 0x1b]).suffix(3) == ["-H", "0d", "1b"])
    // Leave-copy-mode-then-send is ONE tmux invocation (one binary, one `;` list): two would leave a gap for a wheel-up.
    let one = t.withPane("%7").sendBytesLeavingMode([0x0d])
    #expect(one.filter { $0 == "/opt/tmux" }.count == 1)
    #expect(
      Array(one.dropFirst(5)) == [
        "if-shell", "-F", "-t", "%7", "#{pane_in_mode}", "send-keys -t %7 -X cancel", ";", "send-keys", "-t", "%7", "-H", "0d",
      ])
    #expect(t.paneTarget == "=agent:")
    #expect(t.sessionTarget == "=agent")
    // Once the pane exists, every pane command names it by id, never "the active pane".
    let p = t.withPane("%7")
    for argv in [p.paneState(), p.capturePane(), p.sendBytes([13]), p.respawnPane(argv: ["c"], env: [:], cwd: "/"),
      p.clearHistory(), p.captureRecent(lines: 5)]
    {
      #expect(argv.contains("%7") && !argv.contains("=agent:"), "\(argv)")
    }
    #expect(t.withPane("=agent:").paneId == nil, "only a real %N id is accepted")
    #expect(t.newSession(argv: ["c"], env: [:], cwd: "/").contains("#{pane_id}"))
    #expect(TmuxCommands.parsePaneState("12|0|||1|2|%3")?.paneId == "%3")
  }

  // tmux ends a command at an argv element ending in `;` and starts the next command after it (OBSERVED, tmux 3.8: `be brief;`
  // then `plain` ran as a command named `plain`). One backslash before that last `;` is removed by tmux and the element arrives
  // as typed, including one that already ended in `\;` (it is sent as `\\;`).
  static let semicolons = ["be brief;", ";", "a\\;", "mid;dle", "two;;", "-p", ""]
  static let semicolonsSent = ["be brief\\;", "\\;", "a\\\\;", "mid;dle", "two;\\;", "-p", ""]

  @Test func everyUserElementOfAPaneCommandIsEscapedForTmux() {
    let p = t.withPane("%7")
    let env = ["A": "x;", "B": "y"]
    let sentEnv = ["-e", "A=x\\;", "-e", "B=y"]
    let s = t.newSession(argv: Self.semicolons, env: env, cwd: "/a;")
    #expect(s.contains("/a\\;"))
    #expect(s.suffix(Self.semicolons.count) == Self.semicolonsSent[...])
    #expect(Array(s[s.firstIndex(of: "-e")!..<s.firstIndex(of: "--")!]) == sentEnv)
    let w = t.newWindow(argv: Self.semicolons, env: env, cwd: "/a;")
    #expect(w.suffix(Self.semicolons.count) == Self.semicolonsSent[...])
    #expect(Array(w[w.firstIndex(of: "-e")!..<w.firstIndex(of: "--")!]) == sentEnv)
    #expect(w.contains("/a\\;"))
    let r = p.respawnPane(argv: Self.semicolons, env: env, cwd: "/a;")
    // the agent's elements are escaped; the `;` that starts the clear-history command is a real separator and stays one
    #expect(r.suffix(4) == [";", "clear-history", "-t", "%7"])
    #expect(Array(r.dropLast(4).suffix(Self.semicolons.count)) == Self.semicolonsSent)
    #expect(Array(r[r.firstIndex(of: "-e")!..<r.firstIndex(of: "--")!]) == sentEnv)
    #expect(r.contains("/a\\;"))
  }

  @Test func otherTextInACommandListIsEscapedAndTheSeparatorsAreNot() {
    #expect(t.sendLiteral("hello;").suffix(2) == ["--", "hello\\;"])
    #expect(t.setOption("k", "v;").suffix(2) == ["@k", "v\\;"])
    #expect(t.withPane("%7").sendBytesLeavingMode([0x0d]).contains(";"), "the if-shell separator stays a separator")
    #expect(!t.newSession(argv: ["c"], env: [:], cwd: "/a").contains { $0.contains("\\") })
  }

  @Test func parsesPaneState() {
    #expect(
      TmuxCommands.parsePaneState("123|0|||1793368655|1793368600\n")
        == .init(pid: 123, dead: false, exitStatus: nil, exitSignal: nil, activity: 1_793_368_655, sessionCreated: 1_793_368_600))
    // A dead pane prints an empty pid (tmux 3.8) and a signal name.
    let d = TmuxCommands.parsePaneState("|1||kill|1|2")
    #expect(d?.dead == true && d?.pid == nil && d?.exitSignal == 9)
    #expect(TmuxCommands.parsePaneState("|1|3||1|2")?.exitStatus == 3)
    #expect(TmuxCommands.parsePaneState("garbage") == nil)
    // tmux 3.8 answers a missing pane with exit 0 and empty fields: that is "gone"; other unparseable rows are not
    #expect(TmuxCommands.isEmptyPaneRow("||||||\n"))
    #expect(TmuxCommands.isEmptyPaneRow("|||||"))
    #expect(!TmuxCommands.isEmptyPaneRow(""))
    #expect(!TmuxCommands.isEmptyPaneRow("garbage"))
    #expect(!TmuxCommands.isEmptyPaneRow("|0|||1|2|%3"))
    #expect(!TmuxCommands.isEmptyPaneRow("12||||||"))
    #expect(TmuxCommands.parsePaneState("|0||||") == nil)
    #expect(TmuxCommands.parseSignal("term") == 15 && TmuxCommands.parseSignal("SIGSEGV") == 11)
  }

  @Test func versions() {
    #expect(TmuxCommands.versionIsSupported("tmux 3.8"))
    #expect(TmuxCommands.versionIsSupported("tmux 3.3a"))
    #expect(TmuxCommands.versionIsSupported("tmux next-3.6"))
    #expect(!TmuxCommands.versionIsSupported("tmux 3.1c"))
    #expect(!TmuxCommands.versionIsSupported("tmux 2.9"))
    #expect(!TmuxCommands.versionIsSupported(""))
    #expect(TmuxCommands.isValidSessionName("t-my_project"))
    for bad in ["a:b", "a.b", "t-a.b", "t-c:d", "%1", "$1", "@1", "1abc", "", "a b", "é", String(repeating: "a", count: 41)] {
      #expect(!TmuxCommands.isValidSessionName(bad), "\(bad)")
    }
  }
}

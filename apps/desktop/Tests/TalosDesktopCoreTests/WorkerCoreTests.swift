import Foundation
import Testing
@testable import TalosDesktopCore

/// Option C (docs/OPTION-C.md), the pure half: WorkerSpec, the shared files (decoded from the protocol package's own
/// fixtures), the cap and the pointer guard.
let protocolFixtures: String = {
  let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  return here.appendingPathComponent("../../../../packages/protocol/fixtures/option-c").standardized.path
}()

@Suite("WorkerSpec")
struct WorkerSpecTests {
  let sid = "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41"
  var base: [String: String] {
    [
      "PATH": "/usr/bin:/bin", "HOME": "/home/example", "TALOS_APP_BRIDGE": "1", "MCP_PROTOCOL_NEGOTIATION": "legacy",
      "TELEGRAM_BOT_TOKEN": "123:abc", "TELEGRAM_STATE_DIR": "/home/example/.claude/channels/telegram",
      "IMESSAGE_ACCESS": "x", "FOO": "bar",
    ]
  }
  func inputs(resume: Bool = false, model: String = "inherit", effort: String? = nil) -> WorkerSpec.Inputs {
    .init(
      threadId: "trip", claudePath: "/usr/local/bin/claude", baseEnv: base, talosHome: "/home/example/.talos",
      agentDir: "/home/example/agent", model: model, effort: effort, permissionFlag: "--dangerously-skip-permissions",
      sessionId: sid, resume: resume, nonce: "n0nce-0123456789abcdef", preamble: "Be the trip thread.")
  }

  @Test func neverChannelsHeadlessOrATelegramToken() throws {
    for resume in [false, true] {
      for model in ["inherit", "sonnet"] {
        let s = try WorkerSpec.build(inputs(resume: resume, model: model, effort: model == "sonnet" ? "high" : nil))
        for bad in ["--channels", "--dangerously-load-development-channels", "-p", "--print", "--bg"] {
          #expect(!s.args.contains(bad), "\(bad)")
        }
        #expect(!s.args.contains { $0.hasPrefix("server:") || $0.hasPrefix("plugin:") })
        for k in ["TALOS_APP_BRIDGE", "MCP_PROTOCOL_NEGOTIATION", "TELEGRAM_BOT_TOKEN", "IMESSAGE_ACCESS"] {
          #expect(s.env[k] == nil, "\(k)")
        }
        #expect(s.env["TELEGRAM_STATE_DIR"] == "/home/example/.talos/workers/_nochannel")
        #expect(s.env["IMESSAGE_STATE_DIR"] == "/home/example/.talos/workers/_nochannel")
        #expect(s.env["TALOS_APP_WORKER_THREAD"] == "trip")
        #expect(s.env["TALOS_SESSION_ROLE"] == "worker")
        #expect(s.env["TALOS_APP_WORKER_NONCE"] == "n0nce-0123456789abcdef")
        #expect(s.env["FOO"] == "bar")
        let settings = jsonObject(s.settingsJSON)
        let plugins = settings?["enabledPlugins"] as? [String: Bool]
        #expect(plugins?["telegram@claude-plugins-official"] == false)
        #expect(plugins?["imessage@claude-plugins-official"] == false)
      }
    }
  }

  @Test func aWorkerNeverInheritsAnotherSessionsMarkers() throws {
    var i = inputs()
    i.baseEnv = i.baseEnv.merging(pollutedClaudeEnv) { a, _ in a }.merging(claudeKeepList) { a, _ in a }
    let s = try WorkerSpec.build(i)
    for k in pollutedClaudeEnv.keys { #expect(s.env[k] == nil, "\(k) reached the worker") }
    #expect(s.env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] == "400000")
    #expect(!s.launchScript().contains("CLAUDE_CODE_CHILD_SESSION"))
  }

  @Test func argsCarryTheNameModelAndSession() throws {
    let fresh = try WorkerSpec.build(inputs())
    #expect(fresh.args.first == "--dangerously-skip-permissions")
    #expect(fresh.args.contains("--settings"))
    #expect(fresh.args.suffix(2) == ["--session-id", sid])
    #expect(fresh.args.contains("talos-trip"))
    #expect(!fresh.args.contains("--model"))  // inherit = main's default, never /model
    let resumed = try WorkerSpec.build(inputs(resume: true, model: "sonnet", effort: "high"))
    #expect(resumed.args.suffix(2) == ["--resume", sid])
    #expect(resumed.args.contains("--model") && resumed.args.contains("sonnet"))
    #expect(jsonObject(resumed.settingsJSON)?["effortLevel"] as? String == "high")
    #expect(resumed.tmuxSession == "t-trip")
    #expect(TmuxCommands.isValidSessionName(resumed.tmuxSession))
  }

  @Test func refusesBadInputs() {
    var i = inputs()
    i.threadId = "Trip; rm"
    #expect(throws: WorkerSpec.BuildError.self) { try WorkerSpec.build(i) }
    i = inputs()
    i.sessionId = "not-a-uuid"
    #expect(throws: WorkerSpec.BuildError.self) { try WorkerSpec.build(i) }
    i = inputs(model: "--channels")
    #expect(throws: WorkerSpec.BuildError.self) { try WorkerSpec.build(i) }
    i = inputs(effort: "HIGH")
    #expect(throws: WorkerSpec.BuildError.self) { try WorkerSpec.build(i) }
    i = inputs()
    i.permissionFlag = "--channels"
    #expect(throws: WorkerSpec.BuildError.forbiddenArg("--channels")) { try WorkerSpec.build(i) }
    i = inputs()
    i.permissionFlag = "-p"
    #expect(throws: WorkerSpec.BuildError.forbiddenArg("-p")) { try WorkerSpec.build(i) }
  }

  @Test func validateCatchesATamperedSpec() throws {
    var s = try WorkerSpec.build(inputs())
    s.args.append("--dangerously-load-development-channels")
    #expect(throws: WorkerSpec.BuildError.self) { try s.validate() }
    s = try WorkerSpec.build(inputs())
    s.env["TELEGRAM_BOT_TOKEN"] = "x"
    #expect(throws: WorkerSpec.BuildError.self) { try s.validate() }
    s = try WorkerSpec.build(inputs())
    s.settingsJSON = "{}"
    #expect(throws: WorkerSpec.BuildError.self) { try s.validate() }
  }

  @Test func mainShapedArgvIsRecognised() {
    #expect(WorkerSpec.argvLooksLikeMain(["claude", "--channels", "plugin:telegram@claude-plugins-official"]))
    #expect(WorkerSpec.argvLooksLikeMain(["claude", "--dangerously-load-development-channels", "server:talos-app"]))
    #expect(!WorkerSpec.argvLooksLikeMain(["claude", "--name", "talos-trip", "--resume", sid]))
  }
}

@Suite("Worker folder re-check")
struct WorkerFolderTests {
  @Test func refusesWhatTheBridgeRefusesEvenAfterASwap() throws {
    let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("oc-folder-\(UUID().uuidString.prefix(8))")
    let fm = FileManager.default
    let home = base + "/home"
    let talos = home + "/.talos-app"
    for d in [home + "/Projects/trip", home + "/.claude/projects", talos] {
      try fm.createDirectory(atPath: d, withIntermediateDirectories: true)
    }
    defer { try? fm.removeItem(atPath: base) }
    #expect(WorkerSpec.folderProblem(home + "/Projects/trip", home: home, talosHome: talos) == nil)
    #expect(WorkerSpec.folderProblem(home, home: home, talosHome: talos) != nil)
    #expect(WorkerSpec.folderProblem(home + "/nope", home: home, talosHome: talos) != nil)
    #expect(WorkerSpec.folderProblem(home + "/.claude/projects", home: home, talosHome: talos) != nil)
    #expect(WorkerSpec.folderProblem(home + "/.CLAUDE/projects", home: home, talosHome: talos) != nil)
    #expect(WorkerSpec.folderProblem(talos, home: home, talosHome: talos) != nil)
    #expect(WorkerSpec.folderProblem(home + "/Projects/../..", home: home, talosHome: talos) != nil)
    // swapped for a symlink into ~/.claude after the bridge checked it
    try fm.removeItem(atPath: home + "/Projects/trip")
    try fm.createSymbolicLink(atPath: home + "/Projects/trip", withDestinationPath: home + "/.claude")
    #expect(WorkerSpec.folderProblem(home + "/Projects/trip", home: home, talosHome: talos) != nil)
  }
}

@Suite("Option C files")
struct WorkerFilesTests {
  @Test func decodesTheProtocolFixtures() throws {
    let data = try #require(FileManager.default.contents(atPath: protocolFixtures + "/workers.json"))
    let f = try #require(WorkersFile.decode(data))
    #expect(f.supervisor.workers_supported)
    #expect(f.threads["trip"]?.state == "live")
    #expect(f.threads["garden"]?.previous_ids.count == 1)
    #expect(f.threads["taxes"]?.error?.code == "resume_missing")
    // round trip keeps every field
    let again = try #require(WorkersFile.decode(try f.encoded()))
    #expect(again == f)
    let wake = try #require(FileManager.default.contents(atPath: protocolFixtures + "/wake.json"))
    let w = try #require(WakeFile.decode(wake))
    #expect(w.message_ids.count == 2 && w.action == "pointer")
  }

  @Test func refusesTornAndOddFiles() throws {
    let data = try #require(FileManager.default.contents(atPath: protocolFixtures + "/workers.json"))
    #expect(WorkersFile.decode(data.prefix(data.count / 2)) == nil)
    #expect(WorkersFile.decode(Data("{\"v\":2,\"supervisor\":{\"pid\":1,\"heartbeat_at\":\"x\"},\"threads\":{}}".utf8)) == nil)
    #expect(WakeFile.decode(Data("{\"v\":1,\"thread_id\":\"trip\",\"message_ids\":[],\"at\":\"x\"}".utf8)) == nil)
    #expect(WakeFile.decode(Data("{\"v\":1,\"thread_id\":\"Trip!\",\"message_ids\":[\"m_1\"],\"at\":\"x\"}".utf8)) == nil)
    #expect(
      WakeFile.decode(Data("{\"v\":1,\"thread_id\":\"trip\",\"message_ids\":[],\"at\":\"x\",\"action\":\"park\"}".utf8))?
        .action == "park")
  }

  @Test func dedicatedSettingsFollowTheFrontDoorRules() {
    let cfg = """
      {"default_thread":"daily","dedicated":{"enabled":true,"max_live":2},"threads":[
        {"id":"daily","kind":"fixed","session":"dedicated"},
        {"id":"general","kind":"fixed","session":"dedicated"},
        {"id":"inbox","kind":"system","session":"dedicated"},
        {"id":"old","kind":"fixed","session":"dedicated","archived":true},
        {"id":"trip","kind":"fixed","session":"dedicated","session_opts":{"model":"sonnet","idle_park_min":45,"cwd":"/home/example/trip"}},
        {"id":"garden","kind":"agent","session":"shared"}]}
      """
    let s = DedicatedSettings.parse(Data(cfg.utf8))
    #expect(s.enabled && s.maxLive == 2)
    #expect(Array(s.threads.keys) == ["trip"])
    #expect(s.threads["trip"] == ThreadSessionSettings(threadId: "trip", cwd: "/home/example/trip", model: "sonnet", idleParkMin: 45))
    #expect(DedicatedSettings.parse(Data(cfg.replacingOccurrences(of: "\"enabled\":true", with: "\"enabled\":false").utf8)) == .off)
    #expect(DedicatedSettings.parse(Data("{}".utf8)) == .off)
    #expect(DedicatedSettings.parse(Data("not json".utf8)) == .off)
  }
}

@Suite("Worker rules")
struct WorkerRulesTests {
  @Test func capParksTheLongestIdleNonBusyWorker() {
    let live = [
      WorkerPolicy.Live(threadId: "a", busy: false, lastActive: 100),
      WorkerPolicy.Live(threadId: "b", busy: false, lastActive: 50),
      WorkerPolicy.Live(threadId: "c", busy: true, lastActive: 10),
    ]
    #expect(WorkerPolicy.planStart(live: Array(live.prefix(2)), maxLive: 3) == .start)
    #expect(WorkerPolicy.planStart(live: live, maxLive: 3) == .parkThenStart("b"))
    let allBusy = live.map { WorkerPolicy.Live(threadId: $0.threadId, busy: true, lastActive: $0.lastActive) }
    #expect(WorkerPolicy.planStart(live: allBusy, maxLive: 3) == .hold)
  }

  @Test func fiveRestartsInTheWindowIsACrashLoop() {
    #expect(WorkerPolicy.crashLooping(restarts: [1, 2, 3, 4, 5], now: 10))
    #expect(!WorkerPolicy.crashLooping(restarts: [1, 2, 3, 4, 5], now: 2000))
  }

  @Test func pointerNeverDuringADialogOrRecentTyping() {
    #expect(PointerTyper.mayType(screen: .none, lastClientActivity: nil, now: 100))
    #expect(PointerTyper.mayType(screen: .none, lastClientActivity: 80, now: 100))
    #expect(!PointerTyper.mayType(screen: .none, lastClientActivity: 95, now: 100))
    for s: DialogMatcher.Screen in [.trust, .mcpConsent, .loginExpired, .bypassDisclaimer, .unknownSelection] {
      #expect(!PointerTyper.mayType(screen: s, lastClientActivity: nil, now: 100))
    }
  }

  @Test func thePointerIsOneFixedLine() {
    let t = PointerTyper.text
    #expect(t == "Talos: new message in this thread. Call read_inbound.")
    #expect(!t.contains("\n") && !t.contains("\r"))
    #expect(t.first != "/")  // never a slash command
  }

  @Test func theLaunchScriptReplacesTheEnvironmentAndQuotesEverything() throws {
    let s = try WorkerSpec.build(
      .init(
        threadId: "trip", claudePath: "/usr/local/bin/claude", baseEnv: ["PROMPT_COMMAND": "history -a;", "A": "it's"],
        talosHome: "/home/example/.talos", agentDir: "/home/example/agent", sessionId: "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41",
        resume: false, nonce: "n0nce-0123456789abcdef", preamble: "Line one.\nLine two;"))
    let text = s.launchScript()
    #expect(text.hasPrefix("#!/bin/sh\nexec /usr/bin/env -i "))
    #expect(text.contains("'PROMPT_COMMAND=history -a;'"))
    #expect(text.contains("'Line one.\nLine two;'"))
    #expect(!text.contains("TELEGRAM_BOT_TOKEN"))
  }

  @Test func aDialogNeedsItsShapeInAWorker() {
    let quoted = ["  earlier: the test says Not logged in, then Please run /login", " > "]
    #expect(DialogMatcher.classify(quoted) == .loginExpired)
    #expect(DialogMatcher.workerScreen(quoted) == .none)
    #expect(DialogMatcher.workerScreen(["Not logged in · Please run /login"]) == .loginExpired)
    #expect(DialogMatcher.workerScreen(["we said Yes, I trust this folder earlier", " > "]) == .none)
    #expect(DialogMatcher.workerScreen([" ❯ 1. Yes, I trust this folder", "   2. No, exit"]) == .trust)
  }
}

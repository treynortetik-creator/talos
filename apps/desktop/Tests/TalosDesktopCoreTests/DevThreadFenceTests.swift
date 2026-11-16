import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The developer thread fence, Mac half (owner ruling 2026-11-15; the Linux twin is apps/bridge worker-config.ts `threadFenceOn` and
/// worker-spec.ts). Off ONLY for config.json's `"dev": {"thread_fence": false}`: a thread session then gets no Talos-home deny and so
/// the same access Main has. Main's deny rules, the guards, `extraDeny`, the settings-file deny and a lead folder's own deny stay.
@Suite("Developer thread fence")
struct DevThreadFenceTests {
  static let guards = #"""
    {"permissions":{"deny":["Bash(claude plugin:*)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/home/alex/guard.sh"}]}]}}
    """#

  func off(_ t: FenceTree, mainDeny: [String] = []) -> WorkerSpec.Inputs {
    var i = fenceInputs(t, mainDeny: mainDeny)
    i.threadFence = false
    return i
  }

  @Test func onlyTheLiteralFalseTurnsItOff() throws {
    let on: [String?] = [
      nil,  // no file, or one that cannot be read
      "", "{", "not json", "[]", "null", "false", #""dev""#,
      "{}", #"{"dev":null}"#, #"{"dev":false}"#, #"{"dev":[]}"#, #"{"dev":"off"}"#, #"{"dev":{}}"#,
      #"{"dev":{"thread_fence":true}}"#, #"{"dev":{"thread_fence":"false"}}"#, #"{"dev":{"thread_fence":0}}"#,
      #"{"dev":{"thread_fence":0.0}}"#, #"{"dev":{"thread_fence":null}}"#, #"{"dev":{"thread_fence":[false]}}"#,
      #"{"dev":{"thread_fence":{"on":false}}}"#, #"{"dev":{"Thread_Fence":false}}"#, #"{"thread_fence":false}"#,
    ]
    for text in on {
      #expect(WorkerFence.threadFenceOn(configJSON: text.map { Data($0.utf8) }), "\(text ?? "<unreadable>")")
    }
    #expect(!WorkerFence.threadFenceOn(configJSON: Data(#"{"dev":{"thread_fence":false}}"#.utf8)))
    #expect(!WorkerFence.threadFenceOn(configJSON: Data(#"{"threads":[],"dev":{"thread_fence":false,"later_row":true}}"#.utf8)))
  }

  @Test func aConfigFileThatCannotBeReadKeepsTheFence() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let path = t.talosHome + "/config.json"
    try Data(#"{"dev":{"thread_fence":false}}"#.utf8).write(to: URL(fileURLWithPath: path))
    #expect(!WorkerFence.threadFenceOn(configJSON: FileManager.default.contents(atPath: path)))
    chmod(path, 0o000)
    defer { chmod(path, 0o600) }
    // root reads anything; elsewhere the read fails and the fence holds
    if getuid() != 0 { #expect(WorkerFence.threadFenceOn(configJSON: FileManager.default.contents(atPath: path))) }
  }

  @Test func offDropsTheTalosHomeDenyAndNothingElse() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    try t.installGuards(Self.guards)
    let mainDeny = ["Read(//home/alex/.aws/**)", "Bash(rm -rf:*)"]
    let fenced = try WorkerSpec.build(fenceInputs(t, mainDeny: mainDeny))
    let open = try WorkerSpec.build(off(t, mainDeny: mainDeny))
    let home = WorkerFence.denyRules(talosHome: t.talosHome)
    let denyOn = denyList(fenced), denyOff = denyList(open)
    for r in home { #expect(denyOn.contains(r) && !denyOff.contains(r), "\(r)") }
    // exactly the Talos-home rules are gone: Main's deny (the ceiling), the guards, the extra deny, the settings-file deny all stay
    #expect(denyOn.filter { !home.contains($0) } == denyOff)
    for r in mainDeny + WorkerFence.extraDeny + WorkerFence.deniedTools + ["Bash(claude plugin:*)"] { #expect(denyOff.contains(r), "\(r)") }
    #expect(denyOff.contains { $0.hasPrefix("Edit(/") && $0.hasSuffix("/.claude/**)") }, "the settings-file deny stays")
    let hooks = try #require(jsonObject(open.settingsJSON)?["hooks"] as? [String: Any])
    #expect((hooks["PreToolUse"] as? [Any])?.count == 1, "the guards' hook stays")
    #expect((hooks["PermissionRequest"] as? [Any])?.count == 1, "the permission hook stays")
    // the rest of the spec is the same start
    func bare(_ s: WorkerSpec) -> [String] { LaunchSpecHash.argvWithoutPrompt(s.argv, token: s.promptToken).argv }
    #expect(bare(open) == bare(fenced) && open.env == fenced.env && open.main == fenced.main)
    #expect(!open.settingsJSON.contains("\"\(WorkerSpec.telegramPlugin)\":true"))
  }

  @Test func aLeadKeepsItsOwnFenceWithTheThreadFenceOff() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    // a lead's folder settings in the shape `talos-app lead init` writes (lead/settings.ts): its roots include the Talos home, the
    // vault and the credential folders, denied whole to the readers and the writers
    let roots = [t.talosHome, t.home + "/private-agent-vault", t.home + "/.ssh"]
    let leadDeny = ["Read", "Grep", "Glob", "Edit", "Write"].flatMap { tool in roots.flatMap { ["\(tool)(/\($0)/**)", "\(tool)(/\($0))"] } }
    try t.write(t.cwd + "/.claude/settings.json", ["permissions": ["deny": leadDeny]])
    let spec = try WorkerSpec.build(off(t))
    let deny = denyList(spec)
    for r in ["Read(/\(t.talosHome)/**)", "Read(/\(t.home)/private-agent-vault/**)", "Read(/\(t.home)/.ssh/**)"] {
      #expect(deny.contains(r), "\(r)")
    }
    for r in leadDeny { #expect(deny.contains(r), "\(r)") }
  }

  @Test func aSpecBuiltOffIsRefusedWhereTheSupervisorsReadIsOn() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let open = try WorkerSpec.build(off(t))
    try open.validate(threadFence: false)
    // the spec cannot vouch for itself: without the supervisor's own "off" it is checked as fenced, and refused
    #expect(throws: WorkerSpec.BuildError.fenceMissing) { try open.validate() }
    #expect(throws: WorkerSpec.BuildError.fenceMissing) { try open.validate(threadFence: true) }
    // a fenced spec passes either way: more deny is never refused
    let fenced = try WorkerSpec.build(fenceInputs(t))
    try fenced.validate(threadFence: false)
    try fenced.validate()
  }

  @Test func offStillRefusesEverythingElseTheCheckRefuses() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    var open = try WorkerSpec.build(off(t))
    open.args.append("--channels")
    #expect(throws: WorkerSpec.BuildError.forbiddenArg("--channels")) { try open.validate(threadFence: false) }
    // and Main's ceiling: a spec off that lost one of Main's deny rules is wider than Main
    var narrow = try WorkerSpec.build(off(t, mainDeny: ["Read(//home/alex/.aws/**)"]))
    var obj = try #require(jsonObject(narrow.settingsJSON))
    var perms = try #require(obj["permissions"] as? [String: Any])
    perms["deny"] = (perms["deny"] as? [String] ?? []).filter { $0 != "Read(//home/alex/.aws/**)" }
    obj["permissions"] = perms
    narrow.settingsJSON = String(decoding: try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), as: UTF8.self)
    #expect(escalation { try narrow.validate(threadFence: false) }?.axis == .denyRules)
  }

  @Test func offStillDeniesWritesToItsOwnHookSettingsAndMcpConfig() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    let want = WorkerFence.workerFilesDeny(talosHome: t.talosHome)
    let h = t.talosHome
    // the whole workers folder (the hook copy, every session's settings, MCP config, nonce, launch file), as the Linux twin has it
    for tool in ["Edit", "Write", "NotebookEdit", "MultiEdit"] {
      for r in ["\(tool)(/\(h)/workers/**)", "\(tool)(/\(h)/workers)", "\(tool)(/\(h.lowercased())/workers/**)"] {
        #expect(want.contains(r), "\(r)")
      }
    }
    // the hook copy's folder and a session's settings are where the supervisor really puts them
    #expect(WorkerHook.dir(talosHome: h) == h + "/workers/_hook")
    #expect(WorkerSpec.settingsPath(talosHome: h, threadId: "trip") == h + "/workers/trip/settings.json")
    for spec in [try WorkerSpec.build(off(t)), try WorkerSpec.build(fenceInputs(t))] {
      let deny = denyList(spec)
      for r in want { #expect(deny.contains(r), "\(r)") }
    }
  }

  @Test func aSpecThatLeavesItsOwnHookOrSettingsWritableIsRefused_fenceOnOrOff() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    func stripped(_ spec: WorkerSpec, _ drop: (String) -> Bool) throws -> WorkerSpec {
      var out = spec
      var obj = try #require(jsonObject(spec.settingsJSON))
      var perms = try #require(obj["permissions"] as? [String: Any])
      perms["deny"] = (perms["deny"] as? [String] ?? []).filter { !drop($0) }
      obj["permissions"] = perms
      out.settingsJSON = String(decoding: try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), as: UTF8.self)
      return out
    }
    let all = Set(WorkerFence.workerFilesDeny(talosHome: t.talosHome))
    let open = try WorkerSpec.build(off(t))
    #expect(throws: WorkerSpec.BuildError.workerFilesOpen) { try stripped(open) { all.contains($0) }.validate(threadFence: false) }
    // one rule short is refused too
    let hook = "Write(/\(t.talosHome)/workers/**)"
    #expect(throws: WorkerSpec.BuildError.workerFilesOpen) { try stripped(open) { $0 == hook }.validate(threadFence: false) }
    let fenced = try WorkerSpec.build(fenceInputs(t))
    #expect(throws: WorkerSpec.BuildError.workerFilesOpen) { try stripped(fenced) { all.contains($0) }.validate() }
  }

  @Test func theSpecHashChangesWithTheFence() throws {
    let t = try FenceTree()
    defer { t.cleanup() }
    func hash(_ s: WorkerSpec) -> String? {
      LaunchSpecHash.Parts(argv: s.argv, env: s.env, baseEnv: [:], files: ["settings.json": Data(s.settingsJSON.utf8)], token: s.promptToken).hash
    }
    let a = try #require(hash(try WorkerSpec.build(fenceInputs(t))))
    let b = try #require(hash(try WorkerSpec.build(off(t))))
    #expect(a != b)
    #expect(hash(try WorkerSpec.build(off(t))) == b, "the same switch is the same spec")
  }
}

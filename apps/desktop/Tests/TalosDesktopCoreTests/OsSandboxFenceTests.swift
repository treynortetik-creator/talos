import Foundation
import Testing
@testable import TalosDesktopCore

/// The clone fence (the twin of apps/bridge/test/os-sandbox-clone-fence.test.ts): a folder that holds or sits inside the Talos code folder or
/// the pinned bun is refused with one exact line, and the clone, its bridge folder and the bun are write-protected whatever the folder.
/// Every tree is a fresh `SbxTree` (own mkdtemp folder), removed by its own cleanup.
@Suite("Clone fence: the folder checks and the write blocks")
struct OsSandboxFenceTests {
  let clone = "This folder contains the Talos code, or is inside it. Pick another folder and start again."
  let bun = "This folder contains the program Talos runs on, or is inside it. Pick another folder and start again."

  func record(_ clone: String, bun: String, extra: [String] = []) -> OsSandboxFolder.Trusted {
    .init(bun: bun, bridgeDir: clone + "/apps/bridge", extraBuns: extra)
  }

  @Test func theFolderHoldsTheCloneIsInsideItOrIsItsBridgeFolder() {
    let r = record("/x/Agent/clone", bun: "/x/Bun/bin/bun")
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Agent", r) == clone)
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Agent/clone/work", r) == clone)
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Agent/clone", r) == clone)
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Agent/clone/apps/bridge", r) == clone)
  }

  @Test func theFolderHoldsTheBunOrIsInsideItsFolder() {
    let r = record("/x/Clone", bun: "/x/Bun/bin/bun")
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Bun", r) == bun)
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Bun/bin/bun", r) == bun)
    #expect(OsSandboxFolder.cloneFenceProblem("/x", r) == clone, "the clone is named first when both are held")
  }

  @Test func anUnrelatedFolderOrNoRecordStarts() {
    let r = record("/x/Clone", bun: "/x/Bun/bin/bun")
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Clone2", r) == nil, "a name that only starts the same is not inside")
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Agent", r) == nil)
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Clone", nil) == nil)
  }

  @Test func theRootFolderHoldsEverything() {
    let r = record("/x/Clone", bun: "/x/Bun/bin/bun")
    #expect(OsSandboxFolder.cloneFenceProblem("/", r) == clone)
    #expect(OsSandboxFolder.fenceUnder("/x", "/") && OsSandboxFolder.fenceUnder("/", "/"))
    #expect(!"/x".hasPrefix("//"), "the plain prefix test that missed the root")
  }

  @Test func caseAndUnicodeFormAreIgnoredOnTheMac() {
    let r = record("/x/Caf\u{E9}/Clone", bun: "/x/Bun/bin/bun")  // precomposed record
    #expect(OsSandboxFolder.cloneFenceProblem("/X/CAFE\u{301}/clone/work", r) == clone, "decomposed, other case, inside")
    #expect(OsSandboxFolder.cloneFenceProblem("/x/cafe\u{301}", r) == clone, "decomposed folder that holds it")
    #expect(OsSandboxFolder.cloneFenceProblem("/x/BUN/BIN", r) == bun)
  }

  @Test func everyBunIsFencedAndAFolderThatNamesNoneStarts() {
    let r = record("/x/Clone", bun: "/x/Bun/bin/bun", extra: ["/x/Other/bun"])
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Other", r) == bun)
    #expect(OsSandboxFolder.cloneFenceProblem("/x/Elsewhere", r) == nil)
  }

  @Test func aFolderReachedThroughALinkOrARecordSpelledThroughOneIsFenced() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.talosBridge()
    try t.link("ViaLink", to: t.root + "/Clone")
    var i = t.input()
    i.writableRoots = []
    i.folder = t.root + "/ViaLink/apps"  // a folder inside the clone, reached through a link
    #expect(OsSandbox.prepare(i, dry: true, kitDir: t.kit) == .refused(clone))
    i.folder = t.root + "/ViaLink"
    #expect(OsSandbox.prepare(i, dry: true, kitDir: t.kit) == .refused(clone))
    // the record spelled through the link, the folder by its real path
    i.trustedBridge = .init(bun: t.root + "/Bun/bin/bun", bridgeDir: t.root + "/ViaLink/apps/bridge")
    i.folder = t.root + "/Clone/apps"
    #expect(OsSandbox.prepare(i, dry: true, kitDir: t.kit) == .refused(clone))
  }

  @Test func theCloneBridgeAndBunAreDeniedForEveryFolderEvenInsideTheClone() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.talosBridge()
    for folder in [t.agent, t.root + "/Clone", t.root + "/Clone/apps"] {
      var i = t.input()
      i.folder = folder
      let deny = (try OsSandbox.settings(i).sandbox["filesystem"] as? [String: Any])?["denyWrite"] as? [String] ?? []
      let wants = [t.root + "/Clone", t.root + "/Clone/apps/bridge", t.root + "/Bun/bin/bun"]
      for w in wants { #expect(deny.contains(w), "\(w) missing for \(folder)") }
      let at = wants.map { deny.firstIndex(of: $0) ?? -1 }
      #expect(at == at.sorted() && !at.contains(-1), "clone, bridge folder, bun in that order: \(at)")
      #expect(deny.contains(t.root.lowercased() + "/clone"), "the lower-case form too")
    }
  }

  @Test func aSecondBunIsDeniedToo() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.talosBridge()
    try t.file("Other/bin/bun", "#!/bin/sh\n")
    var i = t.input()
    i.trustedBridge = .init(bun: t.root + "/Bun/bin/bun", bridgeDir: t.root + "/Clone/apps/bridge", extraBuns: [t.root + "/Other/bin/bun"])
    let deny = (try OsSandbox.settings(i).sandbox["filesystem"] as? [String: Any])?["denyWrite"] as? [String] ?? []
    #expect(deny.contains(t.root + "/Other/bin/bun"))
  }

  @Test func theFenceRunsAfterTheOtherChecks() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.talosBridge()
    // a project settings command that is not the kit's, in a folder that also holds the clone: the command line wins
    try t.file("Clone/.claude/settings.json", "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"/bin/evil\"}]}]}}")
    var i = t.input()
    i.folder = t.root + "/Clone"
    guard case .refused(let why) = OsSandbox.prepare(i, dry: true, kitDir: t.kit) else { Issue.record("started"); return }
    #expect(why.contains("is not the kit's own") && why != clone, Comment(rawValue: why))
  }

  // MARK: the talos-app entry's env key and a bun in a temp folder

  func entry(_ t: SbxTree, cache: String?) throws {
    var env = "\"TALOS_APP_HOME\":\"\(t.home)\",\"TALOS_AGENT_DIR\":\"\(t.agent)\""
    if let c = cache { env += ",\"BUN_RUNTIME_TRANSPILER_CACHE_PATH\":\"\(c)\"" }
    try t.file(
      "Agent/.mcp.json",
      "{\"mcpServers\":{\"talos-app\":{\"command\":\"\(t.root)/Bun/bin/bun\",\"args\":[\"--no-env-file\",\"--config=\(t.root)/Clone/apps/bridge/bunfig.toml\",\"\(t.root)/Clone/apps/bridge/src/server.ts\"],\"env\":{\(env)}}}}")
  }

  @Test func theBunCacheSwitchIsAllowedOnlyAsZeroAndNeverRequired() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.talosBridge()
    try entry(t, cache: nil)
    #expect(t.prepare().pieces != nil, "an older entry without the key still starts")
    try entry(t, cache: "0")
    #expect(t.prepare().pieces != nil)
    for bad in ["1", "", "0 "] {
      try entry(t, cache: bad)
      #expect(
        t.prepare()
          == .refused("\(t.agent)/.mcp.json has a talos-app server that is not Talos's own (its env sets BUN_RUNTIME_TRANSPILER_CACHE_PATH to something else); run talos-app adopt for this folder, then start again"),
        "value \(bad.debugDescription)")
    }
  }

  @Test func aRecordedBunInATempFolderRefusesTheEntryButNotAFolderWithoutOne() throws {
    let t = try SbxTree()
    defer { t.cleanup() }
    try t.talosBridge()
    t.trusted?.bunInTemp = true
    #expect(t.prepare().pieces != nil, "no talos-app server: starts")
    try entry(t, cache: "0")
    #expect(
      t.prepare()
        == .refused("\(t.agent)/.mcp.json has a talos-app server that is not Talos's own (its bun is in a shared temp folder); run talos-app adopt for this folder, then start again"))
  }

  @Test func theGuardHookPinsAreReadThroughTheCacheSwitchPrefix() {
    let cmd = "[ -f \"/b/bun\" ] && [ -x \"/b/bun\" ] && [ -f \"/c/apps/bridge/src/cli.ts\" ] && BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec \"/b/bun\" \"/c/apps/bridge/src/cli.ts\" guard-hook --config \"/r\" --sha ab"
    let p = GuardsRefresh.pins(command: cmd)
    #expect(p?.bun == "/b/bun" && p?.cli == "/c/apps/bridge/src/cli.ts", "\(String(describing: p))")
  }
}

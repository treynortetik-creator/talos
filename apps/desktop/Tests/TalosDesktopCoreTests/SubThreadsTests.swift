import Foundation
import Testing
@testable import TalosDesktopCore

/// Sub-threads, the pure half: the effective options a sub-thread starts with (the Swift side of `effectiveSessionOpts`), the folder it
/// gets, and the flag the Mac sets once it can launch one.

/// A config thread as JSON text turned into the dictionary the launcher reads.
private func thread(_ id: String, parent: Any? = nil, archived: Bool = false, opts: Any? = nil) -> [String: Any] {
  var t: [String: Any] = ["id": id, "name": id, "kind": "fixed", "session": "dedicated"]
  if let parent { t["parent_id"] = parent }
  if archived { t["archived"] = true }
  if let opts { t["session_opts"] = opts }
  return t
}

private func eff(_ id: String, _ all: [[String: Any]]) -> SubThreads.Opts {
  SubThreads.effective(all.first { $0["id"] as? String == id }!, in: all)
}

@Suite("Sub-threads: effective options")
struct SubThreadEffectiveTests {
  @Test func aThreadWithNoParentIsItsOwnOptions() {
    let all = [thread("a", opts: ["cwd": "/home/alex/a", "model": "sonnet", "effort": "high", "mcp_allow": ["x"]])]
    let o = eff("a", all)
    #expect(o.cwd == "/home/alex/a" && o.model == "sonnet" && o.effort == "high" && o.mcpAllow == ["x"] && o.inherited.isEmpty)
    #expect(SubThreads.launch(all[0], in: all) == nil)
  }

  @Test func aSubInheritsWhatItDoesNotSetFromItsLiveParent() {
    let all = [
      thread("p", opts: ["cwd": "/home/alex/p", "model": "opus", "effort": "low", "mcp_allow": ["a", "b"]]),
      thread("s", parent: "p"),
    ]
    let o = eff("s", all)
    #expect(o.cwd == "/home/alex/p" && o.model == "opus" && o.effort == "low" && o.mcpAllow == ["a", "b"])
    #expect(o.inherited == ["cwd", "model", "effort", "mcp_allow"])
  }

  @Test func whatTheSubSetsItKeepsAndOnlyTheRestIsInherited() {
    let all = [
      thread("p", opts: ["cwd": "/home/alex/p", "model": "opus", "effort": "low"]),
      thread("s", parent: "p", opts: ["model": "haiku", "effort": "high"]),
    ]
    let o = eff("s", all)
    #expect(o.model == "haiku" && o.effort == "high" && o.cwd == "/home/alex/p")
    #expect(o.inherited == ["cwd"])
  }

  @Test func aParentWithNothingSetGivesNothingToInherit() {
    let all = [thread("p"), thread("s", parent: "p")]
    let o = eff("s", all)
    #expect(o.cwd == nil && o.model == nil && o.effort == nil && o.mcpAllow == nil && o.inherited.isEmpty)
  }

  @Test func aParentThatHasAParentIsNotFollowed() {
    let all = [
      thread("g", opts: ["model": "opus", "cwd": "/home/alex/g", "mcp_allow": ["a", "b", "c"]]),
      thread("p", parent: "g", opts: ["effort": "low"]), thread("s", parent: "p"), thread("t", parent: "p", opts: ["mcp_allow": ["a"]]),
    ]
    let o = eff("s", all)
    #expect(o.model == nil && o.cwd == nil && o.effort == nil && o.inherited.isEmpty, "nothing comes from a parent that is itself a sub-thread")
    #expect(o.mcpAllow == [], "like an orphan: no list of its own is the empty list")
    #expect(eff("t", all).mcpAllow == ["a"], "like an orphan: its own list is its own")
    let l = SubThreads.launch(all[2], in: all)
    #expect(l?.refusal != nil && l?.parentCwd == nil)
  }

  @Test func theMcpListIsTheSubsOwnLimitedToTheParentsAndSaysWhatWasDropped() {
    let all = [thread("p", opts: ["mcp_allow": ["a", "b"]]), thread("s", parent: "p", opts: ["mcp_allow": ["z", "b", "y", "a"]])]
    let o = eff("s", all)
    #expect(o.mcpAllow == ["b", "a"], "the sub's own order")
    #expect(o.dropped == ["z", "y"])
    #expect(!o.inherited.contains("mcp_allow"))
  }

  @Test func aParentWithNoListIsNoLimitAndAnEmptyListIsAllLimit() {
    let open = [thread("p"), thread("s", parent: "p", opts: ["mcp_allow": ["a"]])]
    #expect(eff("s", open).mcpAllow == ["a"] && eff("s", open).dropped.isEmpty)
    let shut = [thread("p", opts: ["mcp_allow": [String]()]), thread("s", parent: "p", opts: ["mcp_allow": ["a"]])]
    #expect(eff("s", shut).mcpAllow == [] && eff("s", shut).dropped == ["a"])
    let shutInherit = [thread("p", opts: ["mcp_allow": [String]()]), thread("s", parent: "p")]
    #expect(eff("s", shutInherit).mcpAllow == [], "an empty list is inherited as an empty list, not as no list")
  }

  @Test func aParentListThatCannotBeReadLeavesTheSubNothing() {
    // not a list of names, or a list with a repeated name, reads as the empty list
    for bad: Any in ["github", [1, 2], ["a", "a"], NSNull()] {
      let all = [thread("p", opts: ["mcp_allow": bad]), thread("s", parent: "p", opts: ["mcp_allow": ["a"]]), thread("t", parent: "p")]
      #expect(eff("s", all).mcpAllow == [], "\(bad)")
      #expect(eff("t", all).mcpAllow == [], "\(bad)")
    }
    let notAnObject = [thread("p", opts: "oops"), thread("s", parent: "p", opts: ["mcp_allow": ["a"]])]
    #expect(eff("s", notAnObject).mcpAllow == [])
    // the sub's own settings that cannot be read are the empty list too, not its parent's list
    let ownBroken = [thread("p", opts: ["mcp_allow": ["a", "b"]]), thread("s", parent: "p", opts: "oops")]
    #expect(eff("s", ownBroken).mcpAllow == [])
  }

  @Test func anOrphanWithNoListOfItsOwnGetsTheEmptyList() {
    let archived = [thread("p", archived: true, opts: ["mcp_allow": ["a"], "model": "opus"]), thread("s", parent: "p")]
    let o = eff("s", archived)
    #expect(o.mcpAllow == [], "not the archived parent's list and not no list")
    #expect(o.model == nil && o.inherited.isEmpty, "nothing else is inherited from a parent that is gone")
    let gone = [thread("s", parent: "nope")]
    #expect(eff("s", gone).mcpAllow == [])
    // its own list is its own
    let own = [thread("s", parent: "nope", opts: ["mcp_allow": ["a"]])]
    #expect(eff("s", own).mcpAllow == ["a"])
  }

  @Test func aParentLinkThatCannotBeReadFailsClosed() {
    for bad: Any in [7, ["p"], "BAD ID", "", "all"] {
      let all = [thread("p", opts: ["mcp_allow": ["a"]]), thread("s", parent: bad, opts: ["mcp_allow": ["a"]]), thread("t", parent: bad)]
      #expect(eff("s", all).mcpAllow == [], "\(bad)")
      #expect(eff("t", all).mcpAllow == [], "\(bad)")
      #expect(SubThreads.launch(all[1], in: all) != nil, "still a sub-thread: \(bad)")
    }
  }

  @Test func aParentIsTheFirstThreadWithThatIdAndAnythingButFalseOrAbsentArchivesIt() {
    // the protocol takes the first thread with the id, then looks at whether it is archived
    let dup = [
      thread("p", archived: true, opts: ["model": "opus", "mcp_allow": ["a"]]), thread("p", opts: ["model": "haiku", "mcp_allow": ["a", "b"]]),
      thread("s", parent: "p"),
    ]
    #expect(eff("s", dup).model == nil && eff("s", dup).mcpAllow == [], "an orphan, not the second copy")
    for archived: Any in ["yes", 1, ["x"], true] {
      var p = thread("p", opts: ["model": "opus", "mcp_allow": ["a"]])
      p["archived"] = archived
      let all = [p, thread("s", parent: "p")]
      #expect(eff("s", all).model == nil && eff("s", all).mcpAllow == [], "archived = \(archived)")
    }
    for live: Any in [false, 0, NSNull()] {
      var p = thread("p", opts: ["model": "opus"])
      p["archived"] = live
      #expect(eff("s", [p, thread("s", parent: "p")]).model == "opus", "archived = \(live)")
    }
  }

  @Test func aLoopIsAParentThatHasAParent() {
    let loop = [thread("a", parent: "b", opts: ["mcp_allow": ["x"]]), thread("b", parent: "a")]
    #expect(eff("a", loop).mcpAllow == ["x"])
    #expect(eff("b", loop).mcpAllow == [])
    let selfParent = [thread("a", parent: "a")]
    #expect(eff("a", selfParent).mcpAllow == [])
    // a thread that is its own parent: not even its own list stands (the protocol's rule: no telling what a parent would allow)
    let selfWithList = [thread("a", parent: "a", opts: ["mcp_allow": ["x", "y"], "model": "opus"])]
    #expect(eff("a", selfWithList).mcpAllow == [] && eff("a", selfWithList).dropped == ["x", "y"])
    #expect(eff("a", selfWithList).model == "opus")
  }

  @Test func idleTimeAndOpsReadAreNeverInherited() {
    let all = [thread("p", opts: ["idle_park_min": 90, "ops_read": true, "cwd": "/home/alex/p"]), thread("s", parent: "p")]
    #expect(SubThreads.idleParkMin(all[1]) == 30)
    #expect(SubThreads.idleParkMin(all[0]) == 90)
    #expect(SubThreads.idleParkMin(thread("x", opts: ["idle_park_min": 1])) == 5)
    #expect(SubThreads.idleParkMin(thread("x", opts: ["idle_park_min": 5000])) == 720)
  }

  @Test func theLaunchSaysWhetherTheFolderIsTheSubsOwnAndWhatItMustBeInside() throws {
    let all = [
      thread("p", opts: ["cwd": "/home/alex/p"]), thread("own", parent: "p", opts: ["cwd": "/home/alex/p/own"]),
      thread("inh", parent: "p"), thread("orphan", parent: "x", opts: ["cwd": "/home/alex/x"]), thread("orphanInh", parent: "x"),
    ]
    let own = try #require(SubThreads.launch(all[1], in: all))
    #expect(own.ownCwd && own.parentCwd == "/home/alex/p" && own.refusal == nil && own.parentId == "p")
    let inh = try #require(SubThreads.launch(all[2], in: all))
    #expect(!inh.ownCwd && inh.shares && inh.inherited == ["cwd"], "no folder of its own: it runs in its parent's")
    #expect(inh.refusal == nil && inh.parentCwd == "/home/alex/p")
    #expect(!own.shares)
    let orphan = try #require(SubThreads.launch(all[3], in: all))
    #expect(orphan.refusal != nil, "a folder of its own with no parent folder to be inside")
    #expect(try #require(SubThreads.launch(all[4], in: all)).refusal != nil, "no folder of its own, and no parent folder either")
  }

  @Test func aFolderEqualToTheParentsIsTheSharedFolderAndOnlyThatExactSpellingIs() throws {
    for cwd in ["/home/alex/p", "/home/alex/p/"] {
      let all = [thread("p", opts: ["cwd": "/home/alex/p"]), thread("s", parent: "p", opts: ["cwd": cwd])]
      let l = try #require(SubThreads.launch(all[1], in: all))
      #expect(l.shares && !l.ownCwd && l.refusal == nil, "\(cwd)")
    }
    for cwd in ["/home/alex/p/../p", "/home/alex/./p", "/home/alex/p2", "/home/alex/P"] {
      let all = [thread("p", opts: ["cwd": "/home/alex/p"]), thread("s", parent: "p", opts: ["cwd": cwd])]
      let l = try #require(SubThreads.launch(all[1], in: all))
      #expect(!l.shares && l.ownCwd, "\(cwd) stays under the strict folder check")
    }
  }

  /// The same table as swift-parity.test.ts (Linux `folderSame`): the two sides must agree on every row.
  @Test func theSameFolderRuleIsTheLinuxTables() {
    let table: [(String, String, Bool)] = [
      ("/home/alex/p", "/home/alex/p", true), ("/home/alex/p/", "/home/alex/p", true), ("/home/alex/p", "/home/alex/p/", true),
      ("/home/alex/p/../p", "/home/alex/p", false), ("/home/alex/./p", "/home/alex/p", false), ("/home/alex/p2", "/home/alex/p", false),
      ("/home/alex/P", "/home/alex/p", false), ("p", "p", false), ("/home/alex/p", "home/alex/p", false),
    ]
    for (child, parent, same) in table { #expect(SubThreads.sameFolder(child, parent) == same, "\(child) \(parent)") }
  }

  @Test func noFolderUnderAParentWithNoneRunsInTheAgentFolderAndAnOrphanIsStillRefused() throws {
    let all = [thread("p"), thread("s", parent: "p")]
    let l = try #require(SubThreads.launch(all[1], in: all))
    #expect(l.shares && l.parentCwd == nil && l.refusal == nil)
    let orphan = [thread("s", parent: "gone")]
    let o = try #require(SubThreads.launch(orphan[0], in: orphan))
    #expect(o.refusal != nil && !o.shares)
  }

  @Test func theFolderClaimIsLiftedForOneFamilyOnly() throws {
    func settings(_ json: String) -> [String: ThreadSessionSettings] {
      DedicatedSettings.parse(Data(json.utf8)).threads
    }
    let t = settings("""
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},
     {"id":"p","kind":"fixed","session":"dedicated","session_opts":{"cwd":"/home/alex/p"}},
     {"id":"a","kind":"fixed","session":"dedicated","parent_id":"p"},
     {"id":"b","kind":"fixed","session":"dedicated","parent_id":"p","session_opts":{"cwd":"/home/alex/p/"}},
     {"id":"sub","kind":"fixed","session":"dedicated","parent_id":"p","session_opts":{"cwd":"/home/alex/p/sub"}},
     {"id":"sub2","kind":"fixed","session":"dedicated","parent_id":"p","session_opts":{"cwd":"/home/alex/p/sub"}},
     {"id":"q","kind":"fixed","session":"dedicated","session_opts":{"cwd":"/home/alex/q"}},
     {"id":"c","kind":"fixed","session":"dedicated","parent_id":"q"},
     {"id":"x","kind":"fixed","session":"dedicated","session_opts":{"cwd":"/home/alex/p"}}]}
    """)
    func fam(_ a: String, _ b: String) -> Bool { SubThreads.sameFamily(t[a]!, t[b]) }
    #expect(fam("a", "p") && fam("p", "a"), "parent and child")
    #expect(fam("a", "b") && fam("b", "a"), "siblings that both run in the parent's folder")
    #expect(!fam("sub", "sub2"), "two with the same SUBfolder are claimed against each other")
    #expect(!fam("sub", "p") && !fam("p", "sub"), "a child with a folder of its own is not in the parent's folder")
    #expect(!fam("c", "a") && !fam("a", "c"), "children of different parents")
    #expect(!fam("x", "p") && !fam("x", "a") && !fam("a", "x"), "an unrelated thread in the same folder")
    #expect(!SubThreads.sameFamily(t["a"]!, t["a"]) && !SubThreads.sameFamily(t["a"]!, nil))
  }

  @Test func aFolderSettingThatIsNotTextIsRefusedAndNeverTakesTheParentsFolder() throws {
    let cases: [(Any, String)] = [(7, "7"), (true, "1"), (["a"], "a"), (["x": 1], "x")]
    for (bad, shown) in cases {
      let all = [thread("p", opts: ["cwd": "/home/alex/p"]), thread("s", parent: "p", opts: ["cwd": bad])]
      let o = eff("s", all)
      #expect(o.cwd == nil, "not the parent's folder: \(bad)")
      #expect(!o.inherited.contains("cwd"), "\(bad)")
      let l = try #require(SubThreads.launch(all[1], in: all))
      #expect(l.refusal?.contains(shown) == true, "names the bad value \(shown): \(String(describing: l.refusal))")
      #expect(l.refusal?.contains("can't be read") == true, "\(String(describing: l.refusal))")
    }
    // null is not set: no folder of its own
    let unset = [thread("p", opts: ["cwd": "/home/alex/p"]), thread("s", parent: "p", opts: ["cwd": NSNull()])]
    let unsetLaunch = try #require(SubThreads.launch(unset[1], in: unset))
    #expect(unsetLaunch.refusal == nil && unsetLaunch.shares)
    let notObject = [thread("p", opts: ["cwd": "/home/alex/p"]), thread("s", parent: "p", opts: "oops")]
    #expect(eff("s", notObject).cwd == nil)
    #expect(try #require(SubThreads.launch(notObject[1], in: notObject)).refusal?.contains("oops") == true)
  }

  @Test func aModelOrEffortSettingThatIsNotValidTakesTheParentsAndIsLogged() throws {
    let bad: [(String, Any, String)] = [
      ("model", 7, "7"), ("model", ["x"], "x"), ("model", "-no", "-no"), ("model", "has space", "has space"), ("model", "", ""),
      ("effort", 7, "7"), ("effort", "High", "High"), ("effort", "", ""), ("effort", "abcdefghijklmnopq", "abcdefghijklmnopq"),
    ]
    for (key, value, shown) in bad {
      var opts: [String: Any] = ["cwd": "/home/alex/p/s"]
      opts[key] = value
      let all = [thread("p", opts: ["cwd": "/home/alex/p", "model": "opus", "effort": "low"]), thread("s", parent: "p", opts: opts)]
      let o = eff("s", all)
      #expect(o.model == "opus" && o.effort == "low", "\(key)=\(value) takes the parent's")
      let l = try #require(SubThreads.launch(all[1], in: all))
      #expect(l.refusal == nil)
      #expect(l.unreadable == [key: shown], "\(key)=\(value): \(l.unreadable)")
    }
    let fine = [
      thread("p", opts: ["cwd": "/home/alex/p"]),
      thread("s", parent: "p", opts: ["cwd": "/home/alex/p/s", "model": "claude-opus-4.1[1m]", "effort": "high"]),
    ]
    #expect(try #require(SubThreads.launch(fine[1], in: fine)).unreadable.isEmpty)
    #expect(eff("s", fine).model == "claude-opus-4.1[1m]" && eff("s", fine).effort == "high")
  }

  @Test func aModelOfInheritMeansNotSetAndTakesTheParents() throws {
    let all = [
      thread("p", opts: ["cwd": "/home/alex/p", "model": "opus"]), thread("s", parent: "p", opts: ["cwd": "/home/alex/p/s", "model": "inherit"]),
    ]
    #expect(eff("s", all).model == "opus" && eff("s", all).inherited.contains("model"))
    #expect(try #require(SubThreads.launch(all[1], in: all)).unreadable.isEmpty, "inherit is not junk")
    let top = [thread("a", opts: ["model": "inherit"])]
    #expect(eff("a", top).model == nil)
  }

  @Test func aSubWithItsOwnFolderUnderAParentThatIsItselfASubIsRefused() throws {
    let all = [
      thread("g", opts: ["cwd": "/home/alex/g"]), thread("p", parent: "g", opts: ["cwd": "/home/alex/g/p"]),
      thread("s", parent: "p", opts: ["cwd": "/home/alex/g/p/s"]),
    ]
    let l = try #require(SubThreads.launch(all[2], in: all))
    #expect(l.refusal?.contains("itself a sub-thread") == true && l.parentCwd == nil, "\(String(describing: l.refusal))")
    #expect(try #require(SubThreads.launch(all[1], in: all)).refusal == nil, "a sub of a top-level thread is fine")
  }

  @Test func aPlainThreadsModelAndEffortAreReadAsBeforeSoABadOneStillFailsAtLaunch() throws {
    let config = """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[
      {"id":"general","kind":"fixed"},
      {"id":"a","kind":"fixed","session":"dedicated","session_opts":{"model":"claude opus","effort":"High"}},
      {"id":"b","kind":"fixed","session":"dedicated","session_opts":{"model":"inherit"}}]}
    """
    let d = DedicatedSettings.parse(Data(config.utf8))
    #expect(d.threads["a"]?.model == "claude opus" && d.threads["a"]?.effort == "High")
    #expect(d.threads["b"]?.model == "inherit" && d.threads["b"]?.effort == nil)
  }

  @Test func aParentWithNoFolderOfItsOwnMeansItsSubsAreRefused() throws {
    let all = [thread("p"), thread("s", parent: "p", opts: ["cwd": "/home/alex/p/s"])]
    let l = try #require(SubThreads.launch(all[1], in: all))
    #expect(l.refusal?.contains("give the parent a folder first") == true, "\(String(describing: l.refusal))")
    let junkParent = [thread("p", opts: ["cwd": 7]), thread("s", parent: "p", opts: ["cwd": "/home/alex/p/s"])]
    #expect(SubThreads.launch(junkParent[1], in: junkParent)?.refusal?.contains("folder setting can't be read") == true)
  }

  @Test func aParentWhoseFolderSettingCannotBeReadRefusesAChildWithNoFolderTooNeverTheAgentFolder() throws {
    let parents: [Any] = [["cwd": 42], "oops", ["cwd": ["a"]]]
    let children: [[String: Any]?] = [nil, ["cwd": "/home/alex/p"], ["cwd": "/home/alex/p/s"]]
    for parentOpts in parents {
      for childOpts in children {
        let all = [thread("p", opts: parentOpts), childOpts.map { thread("s", parent: "p", opts: $0) } ?? thread("s", parent: "p")]
        let l = try #require(SubThreads.launch(all[1], in: all))
        #expect(!l.shares, "\(parentOpts) / \(String(describing: childOpts))")
        #expect(l.refusal?.contains("parent thread's folder setting can't be read") == true, "\(parentOpts) / \(String(describing: childOpts)): \(String(describing: l.refusal))")
      }
    }
  }

  @Test func theLaunchSettingsOfASubAreTheEffectiveOnesAndNeverTheRawOnes() throws {
    let config = """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[
      {"id":"general","kind":"fixed"},
      {"id":"p","kind":"fixed","session":"dedicated","session_opts":{"cwd":"/home/alex/p","model":"opus","mcp_allow":["a","b"],"idle_park_min":90}},
      {"id":"s","kind":"fixed","session":"dedicated","parent_id":"p","session_opts":{"mcp_allow":["b","z"]}},
      {"id":"o","kind":"fixed","session":"dedicated","parent_id":"gone","session_opts":{"model":"haiku"}}]}
    """
    let d = DedicatedSettings.parse(Data(config.utf8))
    let s = try #require(d.threads["s"])
    #expect(s.cwd == "/home/alex/p", "no folder of its own: it runs in its parent's, and follows it")
    #expect(s.model == "opus" && s.mcpAllow == ["b"] && s.idleParkMin == 30)
    #expect(s.sub?.dropped == ["z"] && s.sub?.ownCwd == false && s.sub?.shares == true && s.sub?.parentCwd == nil, "judged against nothing")
    let o = try #require(d.threads["o"])
    #expect(o.mcpAllow == [] && o.model == "haiku", "an orphan with no list: the empty list, not no list")
    #expect(d.threads["p"]?.mcpAllow == ["a", "b"] && d.threads["p"]?.sub == nil)
  }
}

@Suite("Sub-threads: folder")
struct SubThreadFolderMakeTests {
  func tree() throws -> SubThreadFolderTests.Tree { try SubThreadFolderTests.Tree() }
  func exists(_ p: String) -> Bool { FileManager.default.fileExists(atPath: p) }

  @Test func aMissingFolderInsideTheParentIsMadeAndReturnedResolved() throws {
    let t = try tree()
    defer { t.cleanup() }
    let one = try SubThreadFolder.prepare(cwd: t.parent + "/fresh", parentCwd: t.parent).get()
    #expect(one == t.parent + "/fresh" && exists(one))
    let deep = try SubThreadFolder.prepare(cwd: t.parent + "/a/b/c", parentCwd: t.parent).get()
    #expect(deep == t.parent + "/a/b/c" && exists(deep))
    let again = try SubThreadFolder.prepare(cwd: t.parent + "/a/b/c", parentCwd: t.parent).get()
    #expect(again == deep, "an existing one is left as it is")
    #expect(try SubThreadFolder.prepare(cwd: t.parent + "/child/./deep/../deep", parentCwd: t.parent).get() == t.parent + "/child/deep")
  }

  @Test func checkingMakesNothingAndRefusesTheParentsOwnFolderHoweverItIsNamed() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.link("viaparent", to: t.parent)
    for path in [t.parent, t.parent + "/", t.root + "/viaparent", t.parent + "/child/.."] {
      #expect(SubThreadFolder.check(cwd: path, parentCwd: t.parent) != nil, "\(path)")
    }
    #expect(SubThreadFolder.check(cwd: t.parent + "/not/made/yet", parentCwd: t.parent) == nil)
    #expect(!exists(t.parent + "/not"), "check makes nothing")
  }

  @Test func theParentItselfIsRefusedAndNothingIsMade() throws {
    let t = try tree()
    defer { t.cleanup() }
    #expect(throws: SubThreadFolder.Refusal.self) { try SubThreadFolder.prepare(cwd: t.parent, parentCwd: t.parent).get() }
    #expect(throws: SubThreadFolder.Refusal.self) { try SubThreadFolder.prepare(cwd: t.parent + "/", parentCwd: t.parent).get() }
  }

  @Test func aFolderOutsideTheParentIsRefusedWithNothingMade() throws {
    let t = try tree()
    defer { t.cleanup() }
    for path in [t.root + "/outside/new", t.root + "/parent2/new", t.root + "/new", t.root + "/parent2/../new"] {
      #expect(throws: SubThreadFolder.Refusal.self, "\(path)") { try SubThreadFolder.prepare(cwd: path, parentCwd: t.parent).get() }
    }
    #expect(!exists(t.root + "/outside/new") && !exists(t.root + "/parent2/new") && !exists(t.root + "/new"))
  }

  @Test func aDotDotInTheMissingPartCannotLeadOutAndMakesNothing() throws {
    let t = try tree()
    defer { t.cleanup() }
    for path in [t.parent + "/nope/../../outside/made", t.parent + "/child/../../outside/made", t.parent + "/nope/..", t.parent + "/a/../b"] {
      #expect(throws: SubThreadFolder.Refusal.self, "\(path)") { try SubThreadFolder.prepare(cwd: path, parentCwd: t.parent).get() }
    }
    #expect(!exists(t.root + "/outside/made") && !exists(t.parent + "/nope") && !exists(t.parent + "/a") && !exists(t.parent + "/b"))
  }

  @Test func aLinkThatLeadsOutCannotMakeAFolderOutsideTheParent() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.link("parent/escape", to: t.root + "/outside")
    #expect(throws: SubThreadFolder.Refusal.self) { try SubThreadFolder.prepare(cwd: t.parent + "/escape/made", parentCwd: t.parent).get() }
    #expect(throws: SubThreadFolder.Refusal.self) { try SubThreadFolder.prepare(cwd: t.parent + "/escape/a/b", parentCwd: t.parent).get() }
    #expect(!exists(t.root + "/outside/made") && !exists(t.root + "/outside/a"))
    // a link that stays inside is fine
    try t.link("parent/inlink", to: t.parent + "/child")
    #expect(try SubThreadFolder.prepare(cwd: t.parent + "/inlink/made", parentCwd: t.parent).get() == t.parent + "/child/made")
  }

  @Test func aLinkInTheWayOfTheNewFolderIsRefusedNotFollowed() throws {
    let t = try tree()
    defer { t.cleanup() }
    try t.link("parent/dangling", to: t.root + "/outside/not-there")
    #expect(throws: SubThreadFolder.Refusal.self) { try SubThreadFolder.prepare(cwd: t.parent + "/dangling", parentCwd: t.parent).get() }
    #expect(!exists(t.root + "/outside/not-there"))
    try t.link("parent/tofile", to: t.root + "/parent2")
    try Data("x".utf8).write(to: URL(fileURLWithPath: t.parent + "/afile"))
    #expect(throws: SubThreadFolder.Refusal.self) { try SubThreadFolder.prepare(cwd: t.parent + "/afile/sub", parentCwd: t.parent).get() }
  }

  @Test func aMissingOrRelativeParentIsRefused() throws {
    let t = try tree()
    defer { t.cleanup() }
    #expect(throws: SubThreadFolder.Refusal.self) { try SubThreadFolder.prepare(cwd: t.root + "/gone/x", parentCwd: t.root + "/gone").get() }
    #expect(throws: SubThreadFolder.Refusal.self) { try SubThreadFolder.prepare(cwd: "x", parentCwd: t.parent).get() }
    #expect(!exists(t.root + "/gone"))
  }
}

@Suite("Sub-threads: workers.json flag")
struct SubThreadsFlagTests {
  func file(_ extra: String) -> Data {
    Data("""
    {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-11-01T00:00:00Z","workers_supported":true,"main_pane_pid":2\(extra)},"threads":{}}
    """.utf8)
  }

  @Test func theFlagIsFalseWhenAbsentAndWhenAnythingButABoolean() throws {
    #expect(try JSONDecoder().decode(WorkersFile.self, from: file("")).supervisor.subthreads_supported == false)
    for junk in ["\"true\"", "1", "null", "[true]", "{}"] {
      let f = try JSONDecoder().decode(WorkersFile.self, from: file(",\"subthreads_supported\":\(junk)"))
      #expect(!f.supervisor.subthreads_supported, "\(junk)")
    }
    #expect(try JSONDecoder().decode(WorkersFile.self, from: file(",\"subthreads_supported\":true")).supervisor.subthreads_supported)
  }

  @Test func theFlagIsWrittenOnlyWhenTrue() throws {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    #expect(!String(decoding: try f.encoded(), as: UTF8.self).contains("subthreads_supported"))
    f.supervisor.subthreads_supported = true
    let text = String(decoding: try f.encoded(), as: UTF8.self)
    #expect(text.contains("\"subthreads_supported\" : true"))
    #expect(try JSONDecoder().decode(WorkersFile.self, from: Data(text.utf8)).supervisor.subthreads_supported)
  }
}

@Suite("Sub-threads: workers.json own-folder flag")
struct SubThreadsOwnFolderFlagTests {
  func file(_ extra: String) -> Data {
    Data("""
    {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-11-01T00:00:00Z","workers_supported":true,"main_pane_pid":2\(extra)},"threads":{}}
    """.utf8)
  }

  @Test func absentAndAnythingButABooleanReadFalse() throws {
    #expect(try JSONDecoder().decode(WorkersFile.self, from: file("")).supervisor.subthreads_own_folder == false)
    for junk in ["\"true\"", "1", "null", "[true]"] {
      #expect(try !JSONDecoder().decode(WorkersFile.self, from: file(",\"subthreads_own_folder\":\(junk)")).supervisor.subthreads_own_folder, "\(junk)")
    }
    #expect(try JSONDecoder().decode(WorkersFile.self, from: file(",\"subthreads_own_folder\":true")).supervisor.subthreads_own_folder)
  }

  @Test func writtenOnlyWhenTrue() throws {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    #expect(!String(decoding: try f.encoded(), as: UTF8.self).contains("subthreads_own_folder"))
    f.supervisor.subthreads_own_folder = true
    #expect(String(decoding: try f.encoded(), as: UTF8.self).contains("\"subthreads_own_folder\" : true"))
  }

  @Test func theSharedFolderFlagReadsFalseUnlessALiteralTrueAndIsWrittenOnlyWhenTrue() throws {
    #expect(try JSONDecoder().decode(WorkersFile.self, from: file("")).supervisor.subthreads_shared_folder == false)
    for junk in ["\"true\"", "1", "null", "[true]"] {
      #expect(try !JSONDecoder().decode(WorkersFile.self, from: file(",\"subthreads_shared_folder\":\(junk)")).supervisor.subthreads_shared_folder, "\(junk)")
    }
    #expect(try JSONDecoder().decode(WorkersFile.self, from: file(",\"subthreads_shared_folder\":true")).supervisor.subthreads_shared_folder)
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    #expect(!String(decoding: try f.encoded(), as: UTF8.self).contains("subthreads_shared_folder"))
    f.supervisor.subthreads_shared_folder = true
    #expect(String(decoding: try f.encoded(), as: UTF8.self).contains("\"subthreads_shared_folder\" : true"))
  }
}

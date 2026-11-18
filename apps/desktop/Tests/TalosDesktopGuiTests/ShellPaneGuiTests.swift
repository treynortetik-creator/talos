import AppKit
import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport
import WebKit
@testable import TalosDesktop

/// The owner's shell in the Terminal pane, driven the way the page drives it: JSON through the real decoder into the real
/// window controller, with real ptys. The stand-in shell is `/bin/sh` running a script that records where it started, what it
/// inherited and every byte it reads; two tests run a real interactive zsh. The web view is in no window and nothing is shown.
/// Needs TALOS_GUI_TESTS=1.
@MainActor
@Suite("Shell pane and the web window", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct ShellPaneGuiTests {
  /// One test's world: a scratch folder, thread folders in it, and a controller whose shells record into it.
  @MainActor
  final class Rig {
    let dir: String
    let c = WebController()
    let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 1400, height: 900), configuration: WKWebViewConfiguration())
    var shell = ShellPane.Shell(executable: "/bin/sh", execName: "-sh")
    var args: [String]
    var sent: [NativeToWeb] = []

    init(window: NSWindow? = nil, visible: Bool = true) {
      dir = (TestTemp.base as NSString).appendingPathComponent("talos-shellpane-\(UUID().uuidString.prefix(8))")
      try? FileManager.default.createDirectory(atPath: dir + "/agent", withIntermediateDirectories: true)
      // records the folder, the environment and its pid, then copies everything it reads to `in.<pid>`; a child sleeps beside it
      let script = dir + "/shell.sh"
      let body = """
        d='\(dir)'
        pwd -P > "$d/pwd.$$"
        env > "$d/env.$$"
        /bin/sleep 600 &
        echo $! > "$d/child.$$"
        : > "$d/in.$$"
        printf '\\033]52;c;%s\\007' "$(printf 'talos-pane-test-clip' | /usr/bin/base64)"
        printf '\\033]52;c;?\\007'
        echo $$ > "$d/up.$$"
        exec /bin/cat >> "$d/in.$$"
        """
      try? body.write(toFile: script, atomically: true, encoding: .utf8)
      args = [script]
      if let window { window.contentView = wv }
      c.useWebViewForTest(wv, windowVisible: visible, window: window)
      c.deliveredForTest = { [weak self] m in self?.sent.append(m) }
      // the fixtures hold `pick_folder` and `open_external`: no real open panel, no real browser
      c.folderPanel = { _ in nil }
      c.openExternal = { _ in }
      c.shellPane.source = OwnerShellPane.Source(
        folder: { [dir] thread in
          let own = dir + "/" + thread
          return FileManager.default.fileExists(atPath: own) ? own : dir + "/agent"
        },
        shell: { [unowned self] in self.shell }, args: args,
        environment: {
          ShellPane.environment(from: [
            "PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory(), "CLAUDE_CODE_SESSION_ID": "s1", "CLAUDECODE": "1",
            "TALOS_APP_WORKER_THREAD": "trip", "TMUX": "/tmp/x,1,0",
          ])
        },
        now: { [unowned self] in self.now })
    }
    /// The clock the page's start limit reads; a test moves it.
    var now = Date(timeIntervalSince1970: 1_800_000_000)

    func folder(for thread: String) -> String {
      let p = dir + "/" + thread
      try? FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
      return p
    }

    /// What the page does: a JSON message, through the decoder the bridge uses. false = refused.
    @discardableResult
    func page(_ json: String) -> Bool {
      guard let m = WebToNative.decode(json: Data(json.utf8)) else { return false }
      c.nativeMessage(m)
      return true
    }
    func signIn() { page(#"{"type":"ready","shell_api":1,"features":["shell-pane/1"],"signed_in":true}"#) }
    func slot(_ thread: String, x: Int = 800, extra: String = "") -> String {
      #"{"type":"shell_pane","thread_id":"\#(thread)","rect":{"x":\#(x),"y":300,"width":560,"height":500}\#(extra)}"#
    }
    func hidden(_ thread: String) -> String { #"{"type":"shell_pane","thread_id":"\#(thread)","rect":null}"# }
    func close(_ thread: String) -> String { #"{"type":"shell_pane_close","thread_id":"\#(thread)"}"# }

    var pane: OwnerShellPane { c.shellPane }
    func pids(_ thread: String) -> [Int32] { pane.viewsForTest(thread).map { $0.process.shellPid } }
    func file(_ name: String, _ pid: Int32) -> String? {
      (try? String(contentsOfFile: "\(dir)/\(name).\(pid)", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /// Every byte any shell of this rig has read.
    func allInput() -> String {
      let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
      return names.filter { $0.hasPrefix("in.") }.compactMap { try? String(contentsOfFile: dir + "/" + $0, encoding: .utf8) }.joined()
    }
    func up(_ thread: String) -> Bool {
      let p = pids(thread)
      return !p.isEmpty && p.allSatisfy { file("up", $0) != nil }
    }
    func end() {
      pane.closeAll()
      try? FileManager.default.removeItem(atPath: dir)
    }
  }

  func waitFor(_ cond: () -> Bool, seconds: Double = 10) async {
    let end = Date().addingTimeInterval(seconds)
    while !cond(), Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
  }
  func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

  // MARK: where and with what the shell starts

  @Test func aSignedInPageThatAsksGetsAShellInTheFolderThisMacNamesNotTheOneThePageNames() async throws {
    let r = Rig()
    defer { r.end() }
    let trip = r.folder(for: "trip")
    r.signIn()
    #expect(r.page(r.slot("trip", extra: #","cwd":"/private/tmp""#)))
    #expect(r.pane.showing == "trip")
    #expect(r.pane.container.superview === r.wv)
    await waitFor { r.up("trip") }
    let pid = try #require(r.pids("trip").first)
    #expect(r.file("pwd", pid) == PathUtil.canonical(trip), "started where the Mac says, whatever `cwd` the page sent")
    let env = try #require(r.file("env", pid))
    for marker in ["CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "TALOS_APP_WORKER_THREAD", "TMUX="] {
      #expect(!env.contains(marker), "\(marker) reached the owner's shell")
    }
    #expect(env.contains("TERM=xterm-256color"))
    #expect(r.pane.tabsForTest("trip").first?.title == "trip")
  }

  @Test func aThreadWithNoFolderOfItsOwnStartsInTheAgentFolder() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("general"))
    await waitFor { r.up("general") }
    #expect(r.file("pwd", try #require(r.pids("general").first)) == PathUtil.canonical(r.dir + "/agent"))
  }

  @Test func aPageThatIsNotReadyOrNotSignedInOrInAHiddenWindowStartsNoShell() {
    let r = Rig()
    defer { r.end() }
    r.page(r.slot("trip"))
    #expect(r.pane.shellCountForTest == 0, "not ready")
    r.page(#"{"type":"ready","shell_api":1,"features":[],"signed_in":false}"#)
    #expect(r.pane.shellCountForTest == 0 && r.pane.showing == nil, "ready but signed out")
    let h = Rig(visible: false)
    defer { h.end() }
    h.signIn()
    h.page(h.slot("trip"))
    #expect(h.pane.shellCountForTest == 0 && h.pane.showing == nil, "a window that is not on screen")
  }

  // MARK: no remote path to the shell

  @Test func noMessageThePageCanSendEverPutsAByteIntoAShell() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    await waitFor { r.up("trip") }
    // every message the bridge knows, from the fixtures the web app is built against
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    let fx = try #require(
      try JSONSerialization.jsonObject(with: Data(contentsOf: url.appending(path: "packages/protocol/fixtures/native/messages.json")))
        as? [String: Any])
    var accepted = 0
    for dir in ["web_to_native", "native_to_web"] {
      for (_, entry) in try #require(fx[dir] as? [String: Any]) {
        let sample = try #require((entry as? [String: Any])?["sample"])
        if let m = WebToNative.decode(sample), !["ready"].contains((sample as? [String: Any])?["type"] as? String ?? "") {
          r.c.nativeMessage(m)
          accepted += 1
        }
      }
    }
    #expect(accepted >= 10, "the fixtures were driven (\(accepted))")
    // and what a hostile page would try: text, keys, commands, on the pane's messages and on the agent terminal's
    let hostile = [
      r.slot("trip", extra: #","input":"touch pwned\n""#), r.slot("trip", extra: #","text":"id\n""#),
      r.slot("trip", extra: #","command":"/bin/sh""#), r.slot("trip", extra: #","keys":"\u0003""#),
      #"{"type":"shell_pane_input","thread_id":"trip","data":"id\n"}"#, #"{"type":"shell_input","text":"id\n"}"#,
      #"{"type":"shell_pane_write","thread_id":"trip","text":"id\n"}"#, #"{"type":"terminal_input","text":"id\n"}"#,
      #"{"type":"compose","thread_id":"trip","text":"id\n"}"#, #"{"type":"terminal_select","session":"trip"}"#,
      #"{"type":"shell_pane","thread_id":"trip; id","rect":null}"#,
    ]
    for h in hostile { #expect(!r.page(h), "\(h) must be refused") }
    r.page(r.slot("trip", x: 700))  // placing it again is all the page can do
    r.page(r.hidden("trip"))
    r.page(r.slot("trip"))
    try? await Task.sleep(nanoseconds: 400_000_000)
    #expect(r.allInput().isEmpty, "a page message reached a shell's input: \(r.allInput().debugDescription)")
    #expect(r.sent.allSatisfy { !$0.object.description.lowercased().contains("shell") }, "nothing about the shell went to the page")
    // the control: this harness does see input. The same view, fed the way AppKit feeds it a typed line.
    let view = try #require(r.pane.viewsForTest("trip").first)
    view.send(txt: "typed by the owner\n")
    await waitFor { r.allInput().contains("typed by the owner") }
    #expect(r.allInput().contains("typed by the owner"))
  }

  @Test func placingHidingMovingAndClosingThePaneNeverAsksForTheKeyboard() async {
    let window = KeyWindowSpy(contentRect: CGRect(x: 0, y: 0, width: 1400, height: 900), styleMask: [.titled], backing: .buffered, defer: true)
    let r = Rig(window: window)
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    r.page(r.slot("work"))
    r.page(r.slot("trip", x: 600))
    r.wv.setFrameSize(NSSize(width: 1200, height: 900))
    r.c.windowDidResize(Notification(name: NSWindow.didResizeNotification))
    r.page(r.hidden("trip"))
    r.page(r.slot("trip"))
    r.page(r.close("work"))
    #expect(window.asked.isEmpty, "the page can place the pane but never move the owner's typing into a shell")
    // the owner's own press on + is what gives a new shell the keyboard
    r.pane.pressPlusForTest()
    #expect(window.asked.count == 1 && window.asked.first.flatMap { $0 } === r.pane.viewsForTest("trip").last)
  }

  @Test func aPageThatAsksForPaneAfterPaneStartsOnlySoManyShells() async {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    for i in 0..<40 {
      r.now += ShellPane.pageStartWindow  // well apart: this test is about the count, not the rate
      r.page(r.slot("t\(i)"))
    }
    #expect(r.pane.shellCountForTest == ShellPane.maxShells)
    #expect(r.pane.openThreadsForTest.count == ShellPane.maxShells, "a pane that got no shell is not kept either")
    #expect(r.pane.noteTextForTest == OwnerShellPane.fullNote, "the owner is told why the last pane is empty")
    // room again: the same slot, reported again, now gets its shell
    r.page(r.close("t0"))
    #expect(r.pane.shellCountForTest == ShellPane.maxShells - 1)
    r.page(r.slot("t39"))
    #expect(r.pane.tabsForTest("t39").isEmpty, "a shell that was told to end still counts until it has had its two seconds")
    await waitFor({ r.page(r.slot("t39")); return r.pane.tabsForTest("t39").count == 1 }, seconds: 6)
    #expect(r.pane.tabsForTest("t39").count == 1 && r.pane.noteTextForTest == nil)
  }

  @Test func aPageThatOpensAndClosesAPaneInALoopIsHeldToAFewStartsAMinuteAndTheOwnersPlusIsNot() async {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    var started = 0
    for _ in 0..<40 {
      r.page(r.slot("trip"))
      started += r.pane.tabsForTest("trip").count
      r.page(r.close("trip"))
      r.now += 0.5
    }
    #expect(started == ShellPane.maxPageStarts, "\(started) login shells were started by page messages in 20 seconds")
    r.page(r.slot("trip"))
    #expect(r.pane.tabsForTest("trip").isEmpty && r.pane.noteTextForTest == OwnerShellPane.tooFastNote, "and the owner is told why the pane is empty")
    #expect(r.pane.openThreadsForTest.isEmpty, "a pane that got no shell is not kept")
    r.now += ShellPane.pageStartWindow
    await waitFor({ r.page(r.slot("trip")); return r.pane.tabsForTest("trip").count == 1 }, seconds: 6)  // the ended ones leave the count
    #expect(r.pane.tabsForTest("trip").count == 1, "a minute on, the page's next ask starts one")
    r.pane.pressPlusForTest()
    #expect(r.pane.tabsForTest("trip").count == 2, "the owner's own + is never held back by what the page did")
  }

  @Test func panesWhoseShellNeverRanAreNotKeptOnceAnotherPaneOpens() async {
    let r = Rig()
    defer { r.end() }
    r.shell = .init(executable: "/usr/bin/false", execName: "-false")
    r.signIn()
    for i in 0..<8 {
      r.page(r.slot("t\(i)"))
      await waitFor { r.pane.noteTextForTest != nil }
    }
    #expect(r.pane.openThreadsForTest.count <= 1, "\(r.pane.openThreadsForTest) were kept")
  }

  @Test func whatAShellPrintsCannotSetTheClipboardOrHaveItTypedIn() async throws {
    // every stand-in shell prints OSC 52 twice when it starts: "set the clipboard to …" and "send me the clipboard"
    let before = NSPasteboard.general.changeCount
    let held = NSPasteboard.general.string(forType: .string)
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    await waitFor { r.up("trip") }
    try? await Task.sleep(nanoseconds: 500_000_000)
    let changed = NSPasteboard.general.changeCount != before
    if changed, NSPasteboard.general.string(forType: .string) == "talos-pane-test-clip" {
      // broken code set the clipboard: put back what was there before failing
      NSPasteboard.general.clearContents()
      if let held { NSPasteboard.general.setString(held, forType: .string) }
    }
    #expect(!changed, "text printed in the shell set the Mac's clipboard")
    #expect(r.allInput().isEmpty, "the clipboard was written into the shell's input: \(r.allInput().debugDescription)")
  }

  // MARK: hide keeps, close ends

  @Test func hidingTheSlotKeepsTheShellAndClosingThePaneEndsItAndWhatRunsInIt() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    await waitFor { r.up("trip") }
    let pid = try #require(r.pids("trip").first)
    let childText = try #require(r.file("child", pid))
    let child = try #require(Int32(childText))
    r.page(r.hidden("trip"))
    #expect(r.pane.showing == nil && r.pane.container.superview == nil)
    #expect(alive(pid) && r.pids("trip") == [pid], "hidden, not ended")
    r.page(r.slot("trip"))
    #expect(r.pids("trip") == [pid], "the same shell comes back")
    r.page(r.close("trip"))
    #expect(r.pane.openThreadsForTest.isEmpty && r.pane.showing == nil)
    await waitFor { !alive(pid) && !alive(child) }
    #expect(!alive(pid), "the shell ended")
    #expect(!alive(child), "and so did what was running in it")
    r.page(r.slot("trip"))
    await waitFor { r.up("trip") }
    #expect(r.pids("trip").count == 1 && r.pids("trip") != [pid], "opening the pane again is a new shell")
  }

  @Test func eachThreadKeepsItsOwnShellsAndClosingOneThreadLeavesTheOthers() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    r.pane.pressPlusForTest()
    r.page(r.slot("work"))
    await waitFor { r.up("trip") && r.up("work") }
    let trip = r.pids("trip")
    let work = r.pids("work")
    #expect(trip.count == 2 && work.count == 1 && r.pane.showing == "work")
    #expect(r.pane.tabsForTest("trip").map(\.title) == ["agent", "agent 2"])
    // a close for a thread that has no pane, or that is not showing, touches nothing else
    r.page(r.close("nosuch"))
    #expect(r.pids("trip") == trip && r.pids("work") == work && r.pane.showing == "work")
    r.page(r.close("trip"))
    await waitFor { trip.allSatisfy { !alive($0) } }
    #expect(trip.allSatisfy { !alive($0) })
    #expect(alive(work[0]) && r.pane.showing == "work", "the thread on screen keeps its shell")
    r.page(r.slot("trip"))
    #expect(r.pane.showing == "trip" && r.pids("work") == work, "switching back hides work's shell, it does not end it")
  }

  @Test func plusAddsTabsUpToTheLimitAndClosingATabEndsOnlyThatShell() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    for _ in 0..<10 { r.pane.pressPlusForTest() }
    #expect(r.pids("trip").count == ShellPane.maxTabsPerThread)
    await waitFor { r.up("trip") }
    let tabs = r.pane.tabsForTest("trip")
    let gone = r.pane.viewsForTest("trip")[1].process.shellPid
    r.pane.pressCloseForTest(tab: tabs[1].id)
    await waitFor { !alive(gone) }
    #expect(!alive(gone))
    #expect(r.pids("trip").count == ShellPane.maxTabsPerThread - 1 && r.pids("trip").allSatisfy(alive))
  }

  // MARK: off reaches the shells

  @Test func aSignedOutPageOrANewDocumentHidesThePaneAndSigningOutFromTheMacEndsEveryShell() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    r.page(r.slot("work"))
    await waitFor { r.up("trip") && r.up("work") }
    let all = r.pids("trip") + r.pids("work")
    r.page(#"{"type":"ready","shell_api":1,"features":[],"signed_in":false}"#)
    #expect(r.pane.showing == nil, "nothing of a shell shows over a signed-out page")
    r.signIn()
    #expect(r.pane.showing == "work", "the slot the page asked for is still its latest word")
    r.c.webView(r.wv, didCommit: nil)
    #expect(r.pane.showing == nil && r.c.shellPaneSlot == nil, "the slot belonged to the document that is gone")
    r.signIn()
    #expect(r.pane.showing == nil, "the new page has not asked")
    #expect(all.allSatisfy(alive), "the owner's shells outlive a reload")
    r.c.configure(relay: RelayOrigin(try #require(URL(string: "http://127.0.0.1:9"))))
    let out = Task { @MainActor in await r.c.signOut() }
    await Task.yield()
    r.page(r.slot("trip"))  // the page is still alive during the logout and may ask again
    #expect(r.pane.shellCountForTest == 0 && r.pane.showing == nil, "signed out: no shell, and none can be started")
    r.signIn()  // and it may say it is signed in again: `signed_in` is only the page's word
    r.page(r.slot("trip"))
    #expect(r.pane.shellCountForTest == 0 && r.pane.showing == nil, "not until a new document has loaded")
    r.c.webView(r.wv, didCommit: nil)
    r.signIn()
    r.page(r.slot("trip"))
    #expect(r.pane.shellCountForTest == 1, "the next page, signed in, gets its pane")
    r.page(r.close("trip"))
    await waitFor { all.allSatisfy { !alive($0) } }
    #expect(all.allSatisfy { !alive($0) }, "every shell ended with the sign-out")
    out.cancel()
  }

  @Test func aShellPaneCloseFromAPageThatIsNotSignedInIsIgnoredAndASignedInOneEndsTheShell() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    await waitFor { r.up("trip") }
    let pids = r.pids("trip")
    r.page(#"{"type":"ready","shell_api":1,"features":[],"signed_in":false}"#)
    r.page(r.close("trip"))
    #expect(r.pane.openThreadsForTest == ["trip"] && pids.allSatisfy(alive), "signed out: the close is ignored")
    r.signIn()
    r.page(r.close("trip"))
    await waitFor { pids.allSatisfy { !alive($0) } }
    #expect(r.pane.openThreadsForTest.isEmpty && pids.allSatisfy { !alive($0) }, "signed in: the close ends the shell")
  }

  @Test func forgettingThisMacEndsEveryShell() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    await waitFor { r.up("trip") }
    let pid = try #require(r.pids("trip").first)
    r.c.configure(relay: RelayOrigin(try #require(URL(string: "http://127.0.0.1:9"))))
    await r.c.wipeSiteData()  // what Forget this Mac runs once the device is revoked
    #expect(r.pane.shellCountForTest == 0 && r.pane.showing == nil && r.c.shellPaneSlot == nil)
    await waitFor { !alive(pid) }
    #expect(!alive(pid))
  }

  @Test func hidingTheWindowHidesThePaneAndKeepsTheShell() async throws {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    await waitFor { r.up("trip") }
    let pid = try #require(r.pids("trip").first)
    _ = r.c.windowShouldClose(NSWindow())
    #expect(r.pane.showing == nil && alive(pid))
    r.page(r.slot("trip"))
    #expect(r.pane.showing == "trip" && r.pids("trip") == [pid])
  }

  @Test func aSlotTooSmallForAShellShowsNothingAndStartsNothing() {
    let r = Rig()
    defer { r.end() }
    r.signIn()
    r.page(#"{"type":"shell_pane","thread_id":"trip","rect":{"x":800,"y":300,"width":60,"height":20}}"#)
    #expect(r.pane.showing == nil && r.pane.shellCountForTest == 0)
    r.page(#"{"type":"shell_pane","thread_id":"trip","rect":{"x":19000,"y":300,"width":560,"height":500}}"#)
    #expect(r.pane.showing == nil, "a slot outside the window is cut to nothing")
  }

  // MARK: failures the owner must see

  @Test func aShellThatCannotRunSaysSoInThePaneAndPlusTriesAgain() async {
    let r = Rig()
    defer { r.end() }
    r.shell = .init(executable: "/usr/bin/false", execName: "-false")
    r.signIn()
    r.page(r.slot("trip"))
    await waitFor { r.pane.noteTextForTest != nil }
    #expect(r.pane.noteTextForTest == OwnerShellPane.failedNote("/usr/bin/false"))
    #expect(r.pane.tabsForTest("trip").isEmpty)
    r.page(r.slot("trip", x: 700))
    #expect(r.pane.shellCountForTest == 0, "the page moving the slot does not start shell after shell")
    r.shell = .init(executable: "/bin/sh", execName: "-sh")
    r.pane.pressPlusForTest()
    await waitFor { r.up("trip") }
    #expect(r.pids("trip").count == 1 && r.pane.noteTextForTest == nil)
  }

  // MARK: the real thing: an interactive login zsh

  /// A real `zsh -l`-style login shell (argv[0] "-zsh"), with an empty ZDOTDIR so no profile of this machine is read.
  func zshRig() -> Rig {
    let r = Rig()
    let zdot = r.folder(for: "zdot")
    r.shell = .init(executable: "/bin/zsh", execName: "-zsh")
    r.pane.source.args = []
    r.pane.source.environment = { ShellPane.environment(from: ["PATH": "/usr/bin:/bin", "HOME": zdot, "ZDOTDIR": zdot]) }
    return r
  }

  @Test func aRealLoginZshStartsInTheThreadFolderTakesTypedKeysAndItsTabGoesWhenItExits() async throws {
    let r = zshRig()
    defer { r.end() }
    let trip = r.folder(for: "trip")
    r.signIn()
    r.page(r.slot("trip"))
    let view = try #require(r.pane.viewsForTest("trip").first)
    let pid = view.process.shellPid
    view.send(txt: "print -r -- \"$PWD|$0|${CLAUDECODE-unset}\" > '\(r.dir)/zsh.out'\n")
    await waitFor { FileManager.default.fileExists(atPath: r.dir + "/zsh.out") }
    let out = (try String(contentsOfFile: r.dir + "/zsh.out", encoding: .utf8)).trimmingCharacters(in: .whitespacesAndNewlines)
    #expect(out == "\(PathUtil.canonical(trip))|-zsh|unset" || out == "\(trip)|-zsh|unset", "\(out)")
    view.send(txt: "exit\n")
    await waitFor { r.pane.tabsForTest("trip").isEmpty }
    #expect(r.pane.tabsForTest("trip").isEmpty && !alive(pid))
    #expect(r.pane.noteTextForTest == OwnerShellPane.endedNote, "the pane says the shell ended; it does not sit empty")
    #expect(r.pane.showing == "trip")
  }

  @Test func closingThePaneEndsARealInteractiveZshAndItsForegroundJobOnTheHangupNotTheForcedKill() async throws {
    let r = zshRig()
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    let view = try #require(r.pane.viewsForTest("trip").first)
    let pid = view.process.shellPid
    view.send(txt: "/bin/sh -c 'echo $$ > \(r.dir)/job; exec /bin/sleep 600'\n")  // something in the foreground
    await waitFor { FileManager.default.fileExists(atPath: r.dir + "/job") }
    let jobText = try String(contentsOfFile: r.dir + "/job", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    let job = try #require(Int32(jobText))
    #expect(alive(pid) && alive(job))
    r.page(r.close("trip"))
    await waitFor({ !alive(pid) && !alive(job) }, seconds: 8)
    #expect(!alive(pid), "the shell ended")
    #expect(!alive(job), "and the job that held the terminal")
    #expect(r.pane.forcedKillsForTest == 0, "an interactive shell ignores SIGTERM: it must go on the hangup, not wait for the kill")
  }
}

/// R1-3: an agent that can click and type in Talos (`screen_click`, `screen_type`) still cannot reach the owner's own login shell, which
/// would run what it is given as the owner with no card. `docs/TERMINAL-PANE.md` "No remote path to the shell" stays true.
extension ShellPaneGuiTests {
  @Test func nothingAnAgentTypesOrClicksReachesTheOwnersShell() async throws {
    let window = WebNSWindow(contentRect: CGRect(x: 0, y: 0, width: 1400, height: 900), styleMask: [.titled], backing: .buffered, defer: true)
    window.isReleasedWhenClosed = false
    let r = Rig(window: window)
    defer { r.end() }
    r.signIn()
    r.page(r.slot("trip"))
    await waitFor { r.up("trip") }
    let view = try #require(r.pane.viewsForTest("trip").first)
    window.makeFirstResponder(view)
    #expect(window.firstResponder === view)
    // the agent: a command and its Return, as keys (what `screen_type` and `screen_key` post), and a click in the pane
    let t = SyntheticInput.flight.begin()
    SyntheticInput.flight.expect(t, answers: 1)
    SyntheticInput.flight.end()
    for (c, code) in [("t", UInt16(17)), ("\r", UInt16(36))] {
      window.sendEvent(try guiKey(.keyDown, in: window, chars: c, code: code, pid: ownPid, token: t))
      window.sendEvent(try guiKey(.keyUp, in: window, chars: c, code: code, pid: ownPid, token: t))
    }
    try? await Task.sleep(nanoseconds: 500_000_000)
    #expect(r.allInput().isEmpty, "the owner's shell read \(r.allInput().debugDescription)")
    #expect(SyntheticInput.flight.wait([t], timeout: 0) == .dropped, "and the agent is told")
    SyntheticInput.flight.forget([t])
    // the control: the owner's own key, through the same window, arrives
    for (c, code) in [("t", UInt16(17)), ("\r", UInt16(36))] {  // the shell's line discipline holds "t" until Return
      window.sendEvent(try guiKey(.keyDown, in: window, chars: c, code: code))
      window.sendEvent(try guiKey(.keyUp, in: window, chars: c, code: code))
    }
    await waitFor { r.allInput().contains("t") }
    #expect(r.allInput().contains("t"), "the same window delivers a person's key")
  }
}

import Foundation
import Testing
@testable import TalosDesktopCore

/// The owner's shell in the Terminal pane: what the page's two messages may carry, and what the shell is started with.
@Suite("Shell pane")
struct ShellPaneTests {
  let rect: [String: Any] = ["x": 760, "y": 420, "width": 520, "height": 360]
  var pane: [String: Any] { ["type": "shell_pane", "thread_id": "trip", "rect": rect] }

  // MARK: the messages

  @Test func theSlotDecodesAndANullRectIsAHiddenSlot() {
    #expect(WebToNative.decode(pane) == .shellPane(threadId: "trip", rect: TerminalViewRect(x: 760, y: 420, width: 520, height: 360)))
    var hidden = pane
    hidden["rect"] = NSNull()
    #expect(WebToNative.decode(hidden) == .shellPane(threadId: "trip", rect: nil))
    #expect(WebToNative.decode(["type": "shell_pane_close", "thread_id": "trip"]) == .shellPaneClose(threadId: "trip"))
  }

  @Test func thePagesFolderIsReadForShapeAndThenDropped() {
    var with = pane
    with["cwd"] = "/home/alex/elsewhere"
    #expect(WebToNative.decode(with) == WebToNative.decode(pane), "nothing of `cwd` survives decoding")
    for bad in ["elsewhere", "", "/a\u{0}b"] as [Any] + [7, NSNull(), ["/x"]] {
      with["cwd"] = bad
      #expect(WebToNative.decode(with) == nil, "cwd \(bad) must refuse the message")
    }
  }

  @Test func aSlotMessageWithAnyOtherFieldIsRefusedWhole() {
    for (k, v) in [
      ("input", "ls\n"), ("text", "ls"), ("command", "/bin/sh"), ("args", ["-c", "id"]), ("env", ["PATH": "/tmp"]), ("tab", 2),
      ("focus", true), ("session", "main"), ("shell", "/bin/sh"), ("keys", "\u{3}"),
    ] as [(String, Any)] {
      var m = pane
      m[k] = v
      #expect(WebToNative.decode(m) == nil, "shell_pane with `\(k)` must be refused")
      #expect(WebToNative.decode(["type": "shell_pane_close", "thread_id": "trip", k: v]) == nil, "shell_pane_close with `\(k)`")
    }
  }

  @Test func theThreadMustBeAThreadIdAndTheRectAWholeRectInsideTheLimit() {
    for id in ["all", "../x", "t-trip", "=agent", "", "Trip", "main session"] as [Any] + [7, NSNull()] {
      var m = pane
      m["thread_id"] = id
      #expect(WebToNative.decode(m) == nil, "thread \(id)")
      #expect(WebToNative.decode(["type": "shell_pane_close", "thread_id": id]) == nil, "close thread \(id)")
    }
    #expect(WebToNative.decode(["type": "shell_pane", "rect": NSNull()]) == nil, "no thread")
    #expect(WebToNative.decode(["type": "shell_pane", "thread_id": "trip"]) == nil, "no rect")
    for bad in [
      ["x": -1, "y": 0, "width": 1, "height": 1], ["x": 0, "y": 0, "width": TerminalViewRect.max + 1, "height": 1],
      ["x": 0.5, "y": 0, "width": 1, "height": 1], ["x": 0, "y": 0, "width": 1], ["x": 0, "y": 0, "width": 1, "height": 1, "z": 1],
      ["x": true, "y": 0, "width": 1, "height": 1],
    ] as [[String: Any]] {
      var m = pane
      m["rect"] = bad
      #expect(WebToNative.decode(m) == nil, "rect \(bad)")
    }
  }

  @Test func oneRefusedSlotMessageDoesNotChangeHowTheOthersDecode() {
    // an older or newer page: its other messages still decode beside a shell_pane this app refuses
    #expect(WebToNative.decode(["type": "shell_pane", "thread_id": "trip", "rect": rect, "v": 2]) == nil)
    #expect(WebToNative.decode(["type": "badge", "count": 3]) == .badge(3))
    #expect(WebToNative.decode(["type": "terminal_view", "rect": rect]) != nil, "the agent terminal's message is untouched")
  }

  @Test func theAppTellsThePageItHasTheShellPane() {
    #expect(WebPolicy.shellFeatures.contains("shell-pane"))
    #expect(WebPolicy.userAgentApplicationName(version: "1.2.3").contains("TalosFeatures/pick-folder,shell-pane"))
  }

  // MARK: what the shell starts with

  @Test func theShellInheritsNoClaudeOrTalosSessionMarkerAndNoOtherTerminal() {
    let env = ShellPane.environment(from: [
      "PATH": "/usr/bin:/bin", "HOME": "/home/alex", "EDITOR": "vi", "CLAUDECODE": "1", "CLAUDE_CODE_SESSION_ID": "s1",
      "CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_MESSAGING_SOCKET": "/tmp/sock", "CLAUDE_CODE_MESSAGING_TOKEN": "t",
      "CLAUDE_CODE_SSE_PORT": "1", "CLAUDE_CODE_SOMETHING_NEW": "1", "CLAUDE_PID": "9", "TMUX": "/tmp/tmux-1/talos,1,0",
      "TMUX_PANE": "%1", "TALOS_APP_WORKER_THREAD": "trip", "TALOS_SESSION_ROLE": "worker", "TALOS_APP_WORKER_NONCE": "n",
      "ENABLE_CLAUDEAI_MCP_SERVERS": "0", "TERM_PROGRAM": "Apple_Terminal", "TERM_SESSION_ID": "x", "SHLVL": "3", "PWD": "/x",
      "OLDPWD": "/y", "TALOS_APP_BRIDGE": "/tmp/b.sock", "TALOS_APP_HOME": "/home/alex/.config/talos/app", "TALOS_APP_RELAY_URL": "https://relay.example.com",
      "MCP_PROTOCOL_NEGOTIATION": "1",
    ])
    #expect(env["PATH"] == "/usr/bin:/bin" && env["HOME"] == "/home/alex" && env["EDITOR"] == "vi", "the owner's own stays")
    #expect(env["TERM"] == "xterm-256color" && env["LANG"] == "en_US.UTF-8")
    let gone = Set(env.keys).intersection([
      "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_SOMETHING_NEW", "CLAUDE_PID", "TMUX", "TMUX_PANE",
      "TALOS_APP_WORKER_THREAD", "TALOS_SESSION_ROLE", "TALOS_APP_WORKER_NONCE", "ENABLE_CLAUDEAI_MCP_SERVERS", "TERM_PROGRAM",
      "TERM_SESSION_ID", "SHLVL", "PWD", "OLDPWD", "TALOS_APP_BRIDGE", "TALOS_APP_HOME", "TALOS_APP_RELAY_URL", "MCP_PROTOCOL_NEGOTIATION",
    ])
    #expect(gone.isEmpty, "\(gone.sorted()) reached the owner's shell")
    #expect(ShellPane.environment(from: ["LC_ALL": "C"])["LANG"] == nil, "a locale the owner set is not overridden")
  }

  @Test func theLoginShellIsTheAccountsThenShellThenZshAndIsToldItIsALoginShell() {
    let exists: (String) -> Bool = { ["/bin/zsh", "/opt/bin/fish", "/bin/bash"].contains($0) }
    #expect(ShellPane.loginShell(account: "/opt/bin/fish", env: "/bin/bash", isExecutable: exists) == .init(executable: "/opt/bin/fish", execName: "-fish"))
    #expect(ShellPane.loginShell(account: "/gone/sh", env: "/bin/bash", isExecutable: exists).executable == "/bin/bash")
    #expect(ShellPane.loginShell(account: nil, env: "bash", isExecutable: { _ in true }).executable == "/bin/zsh", "a bare name is not looked up")
    #expect(ShellPane.loginShell(account: nil, env: nil, isExecutable: exists) == .init(executable: "/bin/zsh", execName: "-zsh"))
  }

  // MARK: the folder

  func config(_ threads: [[String: Any]]) -> Data { try! JSONSerialization.data(withJSONObject: ["threads": threads]) }
  let folders: Set<String> = ["/home/alex", "/home/alex/agent", "/home/alex/trip", "/home/alex/trip/sub"]
  func folder(_ id: String, _ threads: [[String: Any]]?, agentDir: String = "~/agent") -> String {
    ShellPane.folder(
      threadId: id, config: threads.map(config), agentDir: agentDir, home: "/home/alex", isFolder: { self.folders.contains($0) })
  }

  @Test func aThreadWithItsOwnSessionStartsInItsOwnFolderAndEveryOtherInTheAgentFolder() {
    let threads: [[String: Any]] = [
      ["id": "general", "kind": "fixed"],
      ["id": "trip", "kind": "agent", "session": "dedicated", "session_opts": ["cwd": "/home/alex/trip"]],
      ["id": "leg", "kind": "agent", "session": "dedicated", "parent_id": "trip"],
      ["id": "side", "kind": "agent", "session": "dedicated", "parent_id": "trip", "session_opts": ["cwd": "/home/alex/trip/sub"]],
    ]
    #expect(folder("trip", threads) == "/home/alex/trip")
    #expect(folder("general", threads) == "/home/alex/agent", "Main's thread has no folder of its own")
    #expect(folder("leg", threads) == "/home/alex/trip", "a sub-thread that sets none takes its parent's")
    #expect(folder("side", threads) == "/home/alex/trip/sub")
    #expect(folder("nosuch", threads) == "/home/alex/agent", "a thread this Mac does not know")
  }

  @Test func aFolderOnAThreadWithoutItsOwnSessionWasNeverCheckedAndIsNotUsed() {
    // the bridge checks a folder (refused roots, on disk) only for a thread that has its own session
    #expect(folder("trip", [["id": "trip", "kind": "agent", "session_opts": ["cwd": "/home/alex/trip"]]]) == "/home/alex/agent")
    #expect(folder("trip", [["id": "trip", "kind": "agent", "session": "shared", "session_opts": ["cwd": "/home/alex/trip"]]]) == "/home/alex/agent")
    let parentNot: [[String: Any]] = [
      ["id": "trip", "kind": "agent", "session_opts": ["cwd": "/home/alex/trip"]],
      ["id": "leg", "kind": "agent", "session": "dedicated", "parent_id": "trip"],
    ]
    #expect(folder("leg", parentNot) == "/home/alex/agent", "nor a parent's that was never checked")
  }

  @Test func aFolderThatIsMissingOrUnreadableFallsBackAndNeverFails() {
    func one(_ extra: [String: Any]) -> [[String: Any]] { [["id": "trip", "kind": "agent", "session": "dedicated"].merging(extra) { $1 }] }
    #expect(folder("trip", one(["session_opts": ["cwd": "/home/alex/trip"]])) == "/home/alex/trip", "the control: this shape is read")
    #expect(folder("trip", one(["session_opts": ["cwd": "/home/alex/gone"]])) == "/home/alex/agent")
    #expect(folder("trip", one(["session_opts": ["cwd": "trip"]])) == "/home/alex/agent", "relative")
    #expect(folder("trip", one(["session_opts": ["cwd": 7]])) == "/home/alex/agent", "not text")
    #expect(folder("trip", one(["session_opts": "x"])) == "/home/alex/agent")
    #expect(folder("trip", one(["archived": true, "session_opts": ["cwd": "/home/alex/trip"]])) == "/home/alex/agent")
    #expect(folder("trip", nil) == "/home/alex/agent", "no config.json")
    #expect(
      ShellPane.folder(threadId: "trip", config: Data("{not json".utf8), agentDir: "~/agent", home: "/home/alex", isFolder: { self.folders.contains($0) })
        == "/home/alex/agent")
    #expect(folder("trip", nil, agentDir: "/home/alex/nowhere") == "/home/alex", "no agent folder either: home")
    #expect(folder("trip", nil, agentDir: "") == "/home/alex")
  }

  @Test func thePagesOwnStartsAreHeldToAFewAMinute() {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let full = (0..<ShellPane.maxPageStarts).map { t0.addingTimeInterval(Double($0)) }
    #expect(ShellPane.pageMayStart(now: t0, earlier: []))
    #expect(ShellPane.pageMayStart(now: t0.addingTimeInterval(20), earlier: Array(full.dropLast())))
    #expect(!ShellPane.pageMayStart(now: t0.addingTimeInterval(20), earlier: full))
    #expect(!ShellPane.pageMayStart(now: t0.addingTimeInterval(59.9), earlier: full), "the first is still inside the minute")
    #expect(ShellPane.pageMayStart(now: t0.addingTimeInterval(60), earlier: full), "the first has left the minute")
    #expect(!ShellPane.pageMayStart(now: t0.addingTimeInterval(-3600), earlier: full), "a clock that jumped back does not open the gate")
  }

  @Test func aTabIsNamedForItsFolderWithoutControlCharacters() {
    #expect(ShellPane.tabTitle(folder: "/home/alex/trip", number: 1) == "trip")
    #expect(ShellPane.tabTitle(folder: "/home/alex/trip", number: 3) == "trip 3")
    #expect(ShellPane.tabTitle(folder: "/", number: 1) == "/")
    #expect(ShellPane.tabTitle(folder: "/home/alex/a\u{1b}[31mb\u{7}", number: 1) == "a[31mb")
    #expect(ShellPane.tabTitle(folder: "/x/" + String(repeating: "n", count: 90), number: 1).count == 24)
  }
}

/// "No remote path to the shell": the page, the relay, the bridge and the agent have no way to put a byte into the owner's
/// shell or read one out of it. The decoder tests above hold the message shape; these hold the code around the pane.
@Suite("Shell pane reach")
struct ShellPaneReachTests {
  static let repo: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url
  }()

  static func read(_ rel: String) throws -> String { try String(contentsOf: repo.appending(path: rel), encoding: .utf8) }

  /// Swift source without its `//` comments (a comment may say "tmux" or "send"; code may not).
  static func code(_ rel: String) throws -> String {
    try read(rel).split(separator: "\n", omittingEmptySubsequences: false).map { line -> Substring in
      guard let r = line.range(of: "//") else { return line }
      return line[..<r.lowerBound]
    }.joined(separator: "\n")
  }

  static func files(under rel: String, ext: Set<String>) -> [String] {
    let root = repo.appending(path: rel)
    guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
    var out: [String] = []
    for case let u as URL in e {
      if u.pathComponents.contains("node_modules") || u.pathComponents.contains(".build") || u.pathComponents.contains("dist") { continue }
      if ext.contains(u.pathExtension) { out.append(String(u.path.dropFirst(repo.path.count + 1))) }
    }
    return out
  }

  static let paneFiles = ["apps/desktop/Sources/TalosDesktop/OwnerShellPane.swift", "apps/desktop/Sources/TalosDesktop/WebWindowShellPane.swift"]

  @Test func thePaneNeverWritesToAShellAndNeverHandsItsScreenToAnyone() throws {
    // writing to the pty, reading the screen back, talking to the page, the network, tmux, or another process
    let banned = [
      ".send(", "sendInput", ".feed(", "deliver(", "evaluateJavaScript", "callAsyncJavaScript", "NativeToWeb", "URLSession", "URLRequest",
      "getTerminal", "getText", "getLine", "getSelection", "selectedText", "NSPasteboard", "tmux", " Process(", "posix_spawn", "socket(",
      "FileHandle", "NotificationCenter", "DistributedNotification", "NSXPC", "write(",
    ]
    for f in Self.paneFiles {
      let src = try Self.code(f)
      #expect(src.count > 500, "\(f) was read")
      for b in banned { #expect(!src.contains(b), "\(f) uses \(b)") }
    }
  }

  @Test func onlyTheWindowHoldsThePaneAndItOnlyPlacesHidesAndClosesIt() throws {
    let allowed: Set<String> = [
      "shellPane.hide()", "shellPane.closeAll()", "shellPane.close(thread: thread)", "shellPane.show(thread: slot.thread, in: wv, frame: frame)",
    ]
    // the name on its own (handed on, or given another name) would step around the list of calls below; `shellPane(` is the message's enum case
    let bare = try NSRegularExpression(pattern: #"\bshellPane\b(?![.(])"#)
    var seen: Set<String> = []
    for f in Self.files(under: "apps/desktop/Sources", ext: ["swift"]) where f != Self.paneFiles[0] && !f.hasSuffix("/ShellClipboardGuard.swift") {
      let src = try Self.code(f)
      if src.contains("OwnerShellPane") {
        #expect(f.hasSuffix("/WebWindow.swift") || f.hasSuffix("/WebWindowShellPane.swift"), "\(f) reaches for the pane")
      }
      for hook in ["tabsForTest", "viewsForTest", "ShellClipboardGuard", "pressPlusForTest", "pressTabForTest", "pressCloseForTest"] {
        #expect(!src.contains(hook), "\(f) uses \(hook)")
      }
      for line in src.split(separator: "\n") {
        let text = String(line)
        if bare.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil {
          #expect(text.trimmingCharacters(in: .whitespaces) == "let shellPane = OwnerShellPane()", "\(f): `\(text)` hands the pane on")
        }
        var rest = line[...]
        while let r = rest.range(of: "shellPane.") {
          let call = String(rest[r.lowerBound...].prefix { $0 != "/" }).trimmingCharacters(in: .whitespaces)
          let known = allowed.first { call.hasPrefix($0) }
          #expect(known != nil, "\(f): `\(call)` is not placing, hiding or closing the pane")
          if let known { seen.insert(known) }
          rest = rest[r.upperBound...]
        }
      }
    }
    #expect(seen == allowed, "the window's calls changed: \(allowed.subtracting(seen))")
  }

  @Test func everyShellViewHasTheClipboardGuardAndTheWayToAViewIsNotInTheAppThatShips() throws {
    let src = try Self.code(Self.paneFiles[0])
    // one place makes a tab, and it puts the guard on the tab's view
    #expect(src.components(separatedBy: "Tab(id:").count == 2, "tabs are made in one place")
    #expect(src.contains("clipboardGuard = ShellClipboardGuard(guarding: view)"))
    // the test hooks that hand out a view sit inside `#if DEBUG`
    let debug = try #require(src.range(of: "#if DEBUG"))
    for hook in ["func tabsForTest", "func viewsForTest", "func pressPlusForTest"] {
      let at = try #require(src.range(of: hook), "\(hook)")
      #expect(at.lowerBound > debug.lowerBound, "\(hook) is compiled into the release app")
    }
    #expect(src.contains("fileprivate let view: SafeTerminalView"), "a tab's view is not reachable from another file")
    // the guard itself: the clipboard answers nothing, and its only write to a shell is passing on what the view was given
    let g = try Self.code("apps/desktop/Sources/TalosDesktop/ShellClipboardGuard.swift")
    #expect(g.contains("func clipboardCopy(source: TerminalView, content: Data) {}"))
    #expect(g.contains("func clipboardRead(source: TerminalView) -> Data? { nil }"))
    #expect(g.components(separatedBy: ".send(").count == 2 && g.contains("{ inner.send(source: source, data: data) }"))
    for b in ["NSPasteboard", "evaluateJavaScript", "URLSession", "NativeToWeb", "deliver(", ".feed(", "getText", "FileHandle"] {
      #expect(!g.contains(b), "the guard uses \(b)")
    }
  }

  @Test func nothingAboutTheShellIsEverSentToThePage() throws {
    let src = try Self.code("apps/desktop/Sources/TalosDesktopCore/NativeMessages.swift")
    let toWeb = try #require(src.range(of: "public enum NativeToWeb"))
    let end = try #require(src.range(of: "public enum NotifyPermission"))
    let body = src[toWeb.lowerBound..<end.lowerBound].lowercased()
    #expect(body.count > 2000)
    #expect(!body.contains("shell_pane") && !body.contains("shellpane"))
    let ts = try Self.read("packages/protocol/src/native.ts")
    let table = try #require(ts.range(of: "export const NATIVE_TO_WEB = {"))
    #expect(!ts[table.lowerBound...].contains("shell_pane"), "no native -> web message for the shell")
  }

  @Test func theRelayTheBridgeTheAgentsPluginAndTheWireProtocolDoNotKnowThePaneExists() throws {
    var checked = 0
    for dir in ["apps/relay", "apps/bridge", "plugins", "kit", "packages/integrations", "packages/testkit", "apps/desktop/Sources/TalosSupervisor"] {
      for f in Self.files(under: dir, ext: ["ts", "tsx", "js", "mjs", "swift", "sh", "json", "sql", "py"]) {
        let s = try Self.read(f).lowercased()
        checked += 1
        for word in ["shell_pane", "shell-pane", "shellpane", "ownershell"] { #expect(!s.contains(word), "\(f) mentions \(word)") }
      }
    }
    #expect(checked > 200, "the scan read the relay and bridge sources (\(checked) files)")
    // in the shared protocol, only the web <-> shell file (and what is generated from it): not a frame, not a route
    for f in Self.files(under: "packages/protocol/src", ext: ["ts"]) where !f.hasSuffix("/native.ts") {
      #expect(!(try Self.read(f)).contains("shell_pane"), "\(f) mentions shell_pane")
    }
  }
}

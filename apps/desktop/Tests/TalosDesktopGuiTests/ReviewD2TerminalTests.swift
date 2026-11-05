import AppKit
import Foundation
import SwiftTerm
import Testing
import TalosDesktopCore
import TalosSupervisor
@testable import TalosDesktop

/// One process-wide scratch world for the real TerminalWindowController + SupervisorController.
///
/// HARD SAFETY. SupervisorController always names socket `talos`, so it is only ever handed a shim `tmux` that DROPS every
/// `-L` it is given and adds a private `talos-test-*` socket; the shim refuses to run if that file is missing. HOME and
/// CFFIXED_USER_HOME point at the scratch folder, so `desktop.json` doesn't exist and nothing starts. `world()` fails the
/// test before a controller exists if the config path isn't inside the scratch folder. The process can't be activated
/// (`cannotTakeTheKeyboard`), so a test can never take the keyboard from a live session; keys are delivered to the view.
@MainActor
final class TmuxWorld {
  nonisolated static let realTmux = "/opt/homebrew/bin/tmux"
  static let root: String = {
    let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-rv-world-\(UUID().uuidString.prefix(8))")
    try? FileManager.default.createDirectory(atPath: base + "/bin", withIntermediateDirectories: true)
    setenv("HOME", base, 1)
    setenv("CFFIXED_USER_HOME", base, 1)
    setenv("PATH", base + "/bin:" + (getenv("PATH").map { String(cString: $0) } ?? "/usr/bin:/bin"), 1)
    writeScript(base + "/bin/tmux", """
      #!/bin/bash
      # Review shim: every call goes to a private socket. "-L talos" can never reach tmux.
      [ "$1" = "-V" ] && exec \(TmuxWorld.realTmux) -V
      sock="$(cat '\(base)/socket' 2>/dev/null)"
      case "$sock" in talos-test-*) ;; *) echo "no private socket" >&2; exit 1 ;; esac
      echo "$*" >> '\(base)/tmux-calls.log'
      args=()
      while [ $# -gt 0 ]; do
        if [ "$1" = "-L" ]; then shift 2; continue; fi
        args+=("$1"); shift
      done
      exec \(TmuxWorld.realTmux) -L "$sock" "${args[@]}"
      """)
    return base
  }()
  static let conf: String = {
    let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    return here.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/tmux.conf").path
  }()
  nonisolated(unsafe) private static var bundleHooked = false

  /// Bundle.main (the test runner) has no tmux.conf; the app's does.
  static func hookBundle() {
    if bundleHooked { return }
    bundleHooked = true
    let conf = Self.conf
    let m = class_getInstanceMethod(Bundle.self, #selector(Bundle.path(forResource:ofType:)))!
    let old = method_getImplementation(m)
    typealias F = @convention(c) (AnyObject, Selector, NSString?, NSString?) -> NSString?
    let orig = unsafeBitCast(old, to: F.self)
    let sel = #selector(Bundle.path(forResource:ofType:))
    let block: @convention(block) (AnyObject, NSString?, NSString?) -> NSString? = { me, a, b in
      if a == "tmux", b == "conf" { return conf as NSString }
      return orig(me, sel, a, b)
    }
    method_setImplementation(m, imp_implementationWithBlock(block))
  }

  let dir: String
  let sock = "talos-test-rv-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
  var keysPath: String { dir + "/keys" }
  var sizesPath: String { dir + "/sizes" }
  let model: SupervisorController

  /// The agent: a pane that records every byte typed at it and the size it was given. Bounded, ends with its tty.
  init() throws {
    cannotTakeTheKeyboard()
    _ = Self.root
    Self.hookBundle()
    dir = Self.root + "/\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try sock.write(toFile: Self.root + "/socket", atomically: true, encoding: .utf8)
    FileManager.default.createFile(atPath: dir + "/keys", contents: nil)
    FileManager.default.createFile(atPath: dir + "/sizes", contents: nil)
    writeScript(dir + "/agent.sh", """
      #!/bin/bash
      stty raw -echo
      ( for i in $(seq 1 1200); do stty size </dev/tty >> '\(dir)/sizes' 2>/dev/null || exit 0; sleep 0.05; done ) &
      printf 'AGENT \\342\\235\\257 READY\\r\\n'
      exec cat >> '\(dir)/keys'
      """)
    Self.direct(sock, ["-f", Self.conf, "new-session", "-d", "-s", "agent", "-x", "120", "-y", "40", "--", "/bin/bash", dir + "/agent.sh"])
    try #require(SupervisorController.configPath.hasPrefix(Self.root), "refusing to build a controller on the real config")
    try #require(!FileManager.default.fileExists(atPath: SupervisorController.configPath))
    model = SupervisorController()
    try #require(model.hostKind == .tmux)
    try #require(model.configured == false)
    model.status.childPid = 1
    TerminalWindowController.shared.attach(model: model)
  }

  @discardableResult
  nonisolated static func direct(_ sock: String, _ a: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: realTmux)
    p.arguments = ["-L", sock] + a
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    try? p.run()
    let d = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: d, as: UTF8.self)
  }
  func tmux(_ a: String...) -> String { Self.direct(sock, a) }

  var keys: String { (try? String(contentsOfFile: keysPath, encoding: .isoLatin1)) ?? "" }
  var minCols: Int {
    let rows = ((try? String(contentsOfFile: sizesPath, encoding: .utf8)) ?? "").split(separator: "\n")
    return rows.compactMap { $0.split(separator: " ").last.flatMap { Int($0) } }.min() ?? -1
  }
  var clients: Int { tmux("list-clients").split(separator: "\n").count }
  var panePid: String { tmux("display-message", "-p", "-t", "=agent:", "#{pane_pid}").trimmingCharacters(in: .whitespacesAndNewlines) }
  var window: NSWindow? { NSApp.windows.first { $0.title == "Talos Terminal" } }

  /// The status timer resets childPid from the (idle) supervisor; keep claiming a live agent while time passes.
  func run(_ seconds: Double) async {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      model.status.childPid = 1
      await pump(0.05)
    }
  }
  func until(_ seconds: Double, _ ok: @MainActor () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if ok() { return true }
      await run(0.05)
    }
    return ok()
  }

  /// A real key event, handed to whatever AppKit says has the keyboard in this window.
  func type(_ text: String) {
    guard let w = window else { return }
    for ch in text {
      let s = String(ch)
      let code: UInt16 = ch == "\r" ? 36 : 16
      let e = NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber, context: nil,
        characters: s, charactersIgnoringModifiers: s, isARepeat: false, keyCode: code)!
      w.firstResponder?.keyDown(with: e)
    }
  }

  func close() {
    if let w = window, w.isVisible { w.performClose(nil) }
    for w in NSApp.windows where w.title == "Talos" { w.orderOut(nil) }
    _ = tmux("kill-server")  // private socket only
    try? FileManager.default.removeItem(atPath: "/tmp/tmux-\(getuid())/\(sock)")
  }
}

extension GuiSerial {
@MainActor
@Suite("Review D2: terminal window", .serialized, .enabled(if: guiTestsEnabled && FileManager.default.isExecutableFile(atPath: TmuxWorld.realTmux)))
struct ReviewD2TerminalTests {
  func viewer() -> LocalProcessTerminalView? { allTerminalViews().first { $0.process.running } }

  /// Control: with only the agent tab, typing reaches the agent.
  @Test func typingInTheAgentTabReachesTheAgent() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    TerminalWindowController.shared.show()
    #expect(await w.until(5) { w.clients == 1 })
    await w.run(0.5)
    w.type("h")
    #expect(await w.until(2) { w.keys == "h" }, "keys: \(w.keys.debugDescription)")
  }

  /// Nothing may reach the agent from attaching, sitting there or closing: tmux's terminal queries are answered by the view.
  @Test func openingSittingAndClosingTypesNothing() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    TerminalWindowController.shared.show()
    #expect(await w.until(5) { w.clients == 1 })
    await w.run(2)
    w.window?.performClose(nil)
    #expect(await w.until(3) { w.clients == 0 })
    await w.run(0.3)
    #expect(w.keys.isEmpty, "keys: \(w.keys.debugDescription)")
  }

  /// WP-D2 acceptance: closing the pane detaches the viewer and the agent keeps running; reopening re-attaches.
  @Test func closingTheWindowLeavesTheSessionAndReopenReattaches() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    TerminalWindowController.shared.show()
    #expect(await w.until(5) { w.clients == 1 })
    let pid = w.panePid
    #expect(!pid.isEmpty)
    w.window?.performClose(nil)
    #expect(await w.until(3) { w.clients == 0 })
    #expect(w.panePid == pid, "the agent's pane is untouched")
    #expect(w.tmux("has-session", "-t", "=agent").isEmpty)
    await w.run(1.1)
    TerminalWindowController.shared.show()
    #expect(await w.until(5) { w.clients == 1 }, "re-attached")
    #expect(w.panePid == pid)
  }

  /// A viewer killed from outside: the open window re-attaches by itself.
  @Test func aDetachedViewerReattachesWhileTheWindowIsOpen() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    TerminalWindowController.shared.show()
    #expect(await w.until(5) { w.clients == 1 })
    _ = w.tmux("detach-client", "-s", "=agent")
    #expect(await w.until(5) { w.clients == 1 })
  }

  /// Finder-launched apps get no LANG, LC_ALL or LC_CTYPE, and the viewer doesn't set one or pass `tmux -u`. tmux then
  /// treats the client as not UTF-8 and draws every non-ASCII cell as `_`: Claude's ❯, boxes and bullets.
  @Test func unicodeSurvivesAFinderLaunch() async throws {
    let saved: [(String, String?)] = ["LANG", "LC_ALL", "LC_CTYPE"].map { k in (k, getenv(k).map { String(cString: $0) }) }
    for (k, _) in saved { unsetenv(k) }
    defer { for (k, v) in saved { if let v { setenv(k, v, 1) } } }
    let w = try TmuxWorld()
    defer { w.close() }
    TerminalWindowController.shared.show()
    #expect(await w.until(5) { w.clients == 1 })
    await w.run(1)
    let v = try #require(viewer())
    let text = String(decoding: v.getBufferAsData(), as: UTF8.self)
    #expect(text.contains("AGENT"), "control: \(text.prefix(80).debugDescription)")
    #expect(text.contains("\u{276F}"), "the prompt glyph is gone: \(text.prefix(80).debugDescription)")
  }

  /// No session to look at (not set up, or stopped): the window says so, attaches nothing, and touches no tmux session. Held.
  @Test func withNoSessionTheWindowAttachesNothing() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    _ = w.tmux("kill-session", "-t", "=agent")  // no session at all (a session with a dead pane is attached: audit D43)
    w.model.status.childPid = nil
    try? FileManager.default.removeItem(atPath: TmuxWorld.root + "/tmux-calls.log")
    TerminalWindowController.shared.show()
    await pump(1.8)
    let calls = (try? String(contentsOfFile: TmuxWorld.root + "/tmux-calls.log", encoding: .utf8)) ?? ""
    #expect(!calls.contains("attach-session"), "\(calls)")
    #expect(w.tmux("list-sessions").contains("no server") || w.tmux("list-sessions").contains("error"), "nothing was started either")
  }

  /// Audit D43: the supervisor has no child (a failed start) but tmux still holds the session and its dead pane. The window
  /// attaches to it instead of saying "No agent session yet".
  @Test func aSessionWithNoLiveChildIsStillAttached() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    w.model.status.childPid = nil
    TerminalWindowController.shared.show()
    var attached = false
    for _ in 0..<40 where !attached {
      w.model.status.childPid = nil
      await pump(0.15)
      attached = w.clients == 1
    }
    #expect(attached, "tmux lists the session but the window did not attach")
  }

  /// Audit D8: `open_terminal_on_dialog` is a setting that nothing handled. The supervisor's event now opens the pane.
  @Test func theOpenTerminalEventShowsTheTerminalWindow() async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    #expect(TerminalWindowController.shared.isVisible == false)
    w.model.handle(.openTerminal)
    #expect(TerminalWindowController.shared.isVisible, "the event did nothing")
  }

  /// The sign-in flow. The pane says "type y here and press Return", but nothing gives it the keyboard, and the agent viewer
  /// started by the same show() calls makeFirstResponder on a view that isn't in the window (tab 1 is hidden), which leaves
  /// the window itself as first responder. OBSERVED: the keys go nowhere. They don't reach the agent (held).
  @Test func theOwnersYGoesToTheSignInPaneNotTheAgent() async throws {
    try await signInWorld { w, home in
      await w.run(0.5)
      w.type("y\r")
      await w.run(1)
      #expect(w.keys.isEmpty, "the pairing answer was typed into the agent: \(w.keys.debugDescription)")
      let answer = (try? String(contentsOfFile: home + "/answer", encoding: .utf8)) ?? ""
      #expect(answer.hasPrefix("y"), "the enroll prompt never got it: \(answer.debugDescription)")
    }
  }

  /// Same flow after the owner clicked the pane: a viewer re-attach behind tab 2 must not move the keyboard.
  @Test func aViewerReattachDoesNotTakeTheKeyboardFromTheSignInPane() async throws {
    try await signInWorld { w, _ in
      await w.run(0.5)
      let pane = try #require(allTerminalViews().first { $0.process.running && !isViewer($0, w) })
      w.window?.makeFirstResponder(pane)
      #expect(w.window?.firstResponder === pane)
      _ = w.tmux("detach-client", "-s", "=agent")
      #expect(await w.until(5) { w.clients == 1 }, "the viewer came back")
      await w.run(0.3)
      let same = w.window?.firstResponder === pane
      #expect(same, "the keyboard left the sign-in pane (OBSERVED: the window itself becomes first responder)")
      w.type("y\r")
      await w.run(0.7)
      #expect(w.keys.isEmpty, "the pairing answer was typed into the live agent: \(w.keys.debugDescription)")
    }
  }

  /// Sign-in opens the window on tab 2, so tab 1 hasn't been laid out when the viewer attaches. Held: the agent keeps a sane size.
  @Test func signingInDoesNotSqueezeTheAgent() async throws {
    try await signInWorld { w, _ in
      await w.run(0.5)
      #expect(w.minCols >= 40, "the agent was squeezed to \(w.minCols) columns")
      #expect(w.tmux("display-message", "-p", "-t", "=agent:", "#{window_width}").trimmingCharacters(in: .whitespacesAndNewlines) != "1")
    }
  }

  func isViewer(_ v: LocalProcessTerminalView, _ w: TmuxWorld) -> Bool {
    // The viewer lives in tab 1, whose view is a plain holder.
    guard let tabs = w.window?.contentView as? NSTabView, let holder = tabs.tabViewItem(at: 0).view else { return false }
    return v.isDescendant(of: holder)
  }

  func signInWorld(_ body: @MainActor (TmuxWorld, String) async throws -> Void) async throws {
    let w = try TmuxWorld()
    defer { w.close() }
    let home = w.dir
    let relay = try FakeRelay { _ in
      .init(body: "<script>window.talosNative={receive:function(j){(window.__got=window.__got||[]).push(j)}};\(talosPost)({type:'ready',shell_api:1,features:[],signed_in:false})</script>")
    }
    defer { relay.stop() }
    let web = WebController()
    web.openExternal = { _ in }
    web.configure(relay: relay.relay)
    web.prepare()
    #expect(await pumpUntil(4) { web.pageReady })
    writeScript(home + "/talos-app", """
      #!/bin/bash
      echo 'Open this link on the device you want to add (it works once, for 10 minutes):'
      echo '\(relay.origin)/enroll#0123456789ABCDEFGHJKMNPQRS'
      printf 'Pin "Mac app" [a b c d]? [y/N] '
      IFS= read -r ans
      printf '%s' "$ans" > '\(home)/answer'
      """)
    var cfg = DesktopConfig.defaults
    cfg.talosAppCommand = [home + "/talos-app"]
    let p = PairingController.shared
    p.start(config: cfg, web: web)
    #expect(await w.until(8) { p.isRunning })
    #expect(await w.until(5) { w.clients == 1 }, "the agent viewer started behind the sign-in tab")
    try await body(w, home)
    p.cancel()
  }
}
}

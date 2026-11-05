import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore
import WebKit

@testable import TalosDesktop

// Mac settings get one home, with the real AppKit pieces. Runs only with TALOS_GUI_TESTS=1. Nothing here activates the app. The
// controller is built on the scratch HOME that `TmuxWorld.root` sets, and refuses to run on the real desktop.json.

@MainActor
private func scratchModel(_ store: SettingsStore = MemoryStore()) throws -> SupervisorController {
  cannotTakeTheKeyboard()
  _ = TmuxWorld.root
  TmuxWorld.hookBundle()
  try #require(SupervisorController.configPath.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
  try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
  return SupervisorController(store: store)
}

@MainActor
private func removeScratchConfig() {
  let dir = (SupervisorController.configPath as NSString).deletingLastPathComponent
  chmod(dir, 0o700)
  try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
}

/// Receives the test page's own report of what the app sent it.
private final class Probe: NSObject, WKScriptMessageHandler {
  var onMessage: ((String) -> Void)?
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { onMessage?(m.body as? String ?? "") }
}

@MainActor
@Suite("Mac settings: every door", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct MacHomesDoorsGuiTests {
  final class Opened { var ids: [String] = [] }

  @Test func everyOpenerLandsOnTheMatchingTab() throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    for (action, tab) in [
      (AppMenuSpec.Action.permissions, SettingsNavigator.Tab.permissions), (.showTalos, .connection),
    ] {
      SettingsNavigator.shared.selected = .general
      let o = Opened()
      AppMenuActions.perform(action, model: m, open: { o.ids.append($0) })
      #expect(SettingsNavigator.shared.selected == tab, "\(action)")
      #expect(o.ids == ["settings"], "\(action) opens the one settings window and nothing else: \(o.ids)")
    }
    for (action, id) in [(AppMenuSpec.Action.settings, "settings"), (.setupChecklist, "onboarding")] {
      let o = Opened()
      AppMenuActions.perform(action, model: m, open: { o.ids.append($0) })
      #expect(o.ids == [id])
    }
  }

  @Test func helpWithNoRelayAddressSaysWhyAndLandsOnConnection() throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    try #require(!WebController.shared.hasRelay, "this test needs a Mac with no relay address")
    SettingsNavigator.shared.selected = .general
    let o = Opened()
    AppMenuActions.perform(.help, model: m, open: { o.ids.append($0) })
    #expect(o.ids == ["settings"], "Help has no window of its own: \(o.ids)")
    #expect(SettingsNavigator.shared.selected == .connection)
    #expect(m.notice == HelpPage.noRelay)
  }

  /// The with-a-relay path, in a real WKWebView whose origin is faked (no network): Help is asked for while the page is still
  /// loading, and the page gets one navigate message to /help once it says it is ready, with no notice and no Mac settings window.
  @Test func helpWithARelayReachesThePageOnceItIsReady() async throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer {
      removeScratchConfig()
      for w in NSApp.windows { w.orderOut(nil) }
    }
    let web = WebController()
    web.configure(relay: RelayOrigin("https://relay.example.com")!)
    web.prepare()
    let wv = try #require(web.webView)
    let o = Opened()
    HelpRouter.open(model: m, via: { o.ids.append($0) }, web: web)
    #expect(o.ids.isEmpty, "with a relay Help is a page, not a window: \(o.ids)")
    #expect(m.notice.isEmpty)
    #expect(!web.pageReady, "asked for before the page was ready")
    // The page reports what it receives through a second message handler, and the test waits on that message itself: no
    // polling and no time limit of its own. A navigate that never arrives would hang here, which is the failure.
    let probe = Probe()
    wv.configuration.userContentController.add(probe, name: "probe")
    defer { wv.configuration.userContentController.removeScriptMessageHandler(forName: "probe") }
    let first: String = await withCheckedContinuation { cont in
      var resumed = false
      probe.onMessage = { text in
        if !resumed {
          resumed = true
          cont.resume(returning: text)
        }
      }
      wv.loadHTMLString(
        """
        <html><body><script>
        window.__got = [];
        window.talosNative = { receive: function (j) { window.__got.push(j); window.webkit.messageHandlers.probe.postMessage(j); return true } };
        window.webkit.messageHandlers.talos.postMessage({type:'ready',shell_api:1,features:[],signed_in:false});
        </script></body></html>
        """, baseURL: URL(string: "https://relay.example.com/")!)
    }
    let count = (try? await wv.evaluateJavaScript("window.__got.length") as? Int) ?? -1
    #expect(count == 1, "the page got \(count) messages, expected the one navigate")
    #expect(first.contains("/help") && first.contains("navigate"), "got \(first)")
  }

  @Test func everyHelpDoorGoesThroughOneRouter() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop")
    for f in ["App.swift", "Onboarding.swift", "AppMenuActions.swift"] {
      let t = try String(contentsOf: root.appendingPathComponent(f), encoding: .utf8)
      #expect(t.contains("HelpRouter.open("), "\(f) opens Help through HelpRouter")
    }
  }

  @Test func theRemovedWindowsAreNeverAsked() throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    let o = Opened()
    for a in [AppMenuSpec.Action.settings, .help, .setupChecklist, .permissions, .showTalos] {
      AppMenuActions.perform(a, model: m, open: { o.ids.append($0) })
    }
    SettingsRouter.open(.hotkeys, via: { o.ids.append($0) })
    SettingsRouter.openAdopt(model: m, via: { o.ids.append($0) })
    #expect(Set(o.ids).isSubset(of: ["settings", "onboarding"]), "\(o.ids)")
  }

  @Test func noRelayWordsTheNoticeAndLandsOnConnection() throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    try #require(!WebController.shared.hasRelay, "this test needs a Mac with no relay address")
    AppMenuActions.perform(.showTalos, model: m, open: { _ in })
    #expect(m.notice == MacSettingsText.noRelayYet)
    #expect(!m.notice.contains("desktop.json") && m.notice.contains("Connection"))
  }

  @Test func findARunningSessionWorksFromTheMenuBarAndFromTheChecklist() throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    // one door: the same function the menu bar's button and the setup checklist's button call
    for _ in 0..<2 {
      SettingsNavigator.shared.selected = .general
      m.adoptNote = ""
      let o = Opened()
      SettingsRouter.openAdopt(model: m, via: { o.ids.append($0) })
      #expect(SettingsNavigator.shared.selected == .session)
      #expect(o.ids == ["settings"])
      #expect(!m.adoptNote.isEmpty, "the search ran and said what it found")
    }
    // and from the Session tab itself the button is still there: its label comes from the one constant
    let src = try String(contentsOfFile: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Sources/TalosDesktop/App.swift").path, encoding: .utf8)
    #expect(src.contains("Button(BlockedText.adoptButton) { model.findSessionToAdopt() }"))
    let onboarding = try String(contentsOfFile: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Sources/TalosDesktop/Onboarding.swift").path, encoding: .utf8)
    #expect(onboarding.contains("SettingsRouter.openAdopt(model: model)"))
    #expect(src.contains("SettingsRouter.openAdopt(model: model)"))
  }
}

// MARK: Cmd-V without the web window's own Edit menu

@MainActor
@Suite("Cmd-V through the top menu", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct EditMenuGuiTests {
  func cmd(_ key: String, window: NSWindow) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: window.windowNumber, context: nil,
      characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: 9)!
  }

  func allMenuItems(_ m: NSMenu) -> [NSMenuItem] { m.items.flatMap { [$0] + ($0.submenu.map(allMenuItems) ?? []) } }

  func snapshot(_ pb: NSPasteboard) -> [[(NSPasteboard.PasteboardType, Data)]] {
    (pb.pasteboardItems ?? []).map { item in item.types.compactMap { t in item.data(forType: t).map { (t, $0) } } }
  }
  func restore(_ saved: [[(NSPasteboard.PasteboardType, Data)]], to pb: NSPasteboard) {
    pb.clearContents()
    let items = saved.map { entries -> NSPasteboardItem in
      let i = NSPasteboardItem()
      for (t, d) in entries { i.setData(d, forType: t) }
      return i
    }
    if !items.isEmpty { pb.writeObjects(items) }
  }

  /// A real WKWebView in a real window, one text box focused. With AppMenu's Edit menu as the only one, Cmd-V pastes. The
  /// control: with no Edit menu at all it does not, so the test goes red if the menu stops doing the job.
  @Test func cmdVPastesIntoTheWebPageThroughAppMenuAlone() async throws {
    _ = NSApplication.shared
    cannotTakeTheKeyboard()
    let before = NSApp.mainMenu
    defer { NSApp.mainMenu = before }
    let am = AppMenu()
    am.host = AppMenu.Host(run: { _ in }, companionOn: { false }, signedIn: { false }, offersSignIn: { false }, hasRelay: { false })

    let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: 120), configuration: WKWebViewConfiguration())
    let w = NSWindow(contentRect: wv.frame, styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false  // a window made in code is released by `close` by default, and AppKit then frees it twice
    w.animationBehavior = .none
    MacHomesScreensGuiTests.keep.append(w)  // never freed mid-test: AppKit may still be animating it
    w.contentView = wv
    wv.loadHTMLString("<html><body><input id='i' type='text' autofocus></body></html>", baseURL: URL(string: "https://example.invalid/"))
    w.orderFrontRegardless()
    w.makeKey()
    await pump(0.6)
    _ = try? await wv.evaluateJavaScript("document.getElementById('i').focus()")
    _ = w.makeFirstResponder(wv)

    let pb = NSPasteboard.general
    let saved = snapshot(pb)
    defer { restore(saved, to: pb) }
    let word = "pasted-\(UUID().uuidString.prefix(8))"
    pb.clearContents()
    pb.setString(word, forType: .string)

    func value() async -> String { (try? await wv.evaluateJavaScript("document.getElementById('i').value") as? String) ?? "?" }

    // control: no Edit menu, no paste
    NSApp.mainMenu = NSMenu(title: "Empty")
    _ = NSApp.mainMenu!.performKeyEquivalent(with: cmd("v", window: w))
    await pump(0.4)
    #expect(await value() == "", "without an Edit menu Cmd-V does nothing, so the next check means something")

    // AppMenu alone
    NSApp.mainMenu = am.build()
    #expect(NSApp.mainMenu?.items.map(\.title).filter { $0 == "Edit" }.count == 1, "exactly one Edit menu")
    let keyed = NSApp.mainMenu!.performKeyEquivalent(with: cmd("v", window: w))
    #expect(keyed, "the menu took the key")
    // This test process cannot be the active app (it must not take the keyboard from the owner's session), so AppKit has no key
    // window to route a nil-target action to. Do the routing by hand: find the item the key belongs to, check it has no target
    // of its own (so, running for real, it goes down the responder chain), and send its action to the web view's responder.
    let paste = try #require(allMenuItems(NSApp.mainMenu!).first { $0.keyEquivalent == "v" && $0.keyEquivalentModifierMask == .command })
    #expect(paste.target == nil && paste.action == #selector(NSText.paste(_:)))
    #expect(NSApp.sendAction(paste.action!, to: w.firstResponder, from: paste), "the page's view takes paste:")
    await pump(0.6)
    let got = await value()
    #expect(got == word, "Cmd-V pasted into the page: '\(got)'")
  }
}

// MARK: quitting

@MainActor
@Suite("Every quit is the same safe stop", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct QuitGuiTests {
  final class World {
    var stops = 0
    var stopped = false
    var replies: [Bool] = []
    var clock = 5_000.0
    var tmux = false
    var active = true
  }

  func wire(_ w: World) {
    let q = QuitCoordinator.shared
    q.resetForTests()
    q.hooks = QuitCoordinator.Hooks(
      inputs: { QuitPlan.Inputs(hostKeepsAgent: w.tmux, sessionActive: w.active) },
      stop: { w.stops += 1 }, isStopped: { w.stopped }, reply: { w.replies.append($0) }, uptime: { w.clock }, limit: 15)
  }

  @Test func theDockAndSystemQuitHoldUntilTheAgentIsStopped() async throws {
    _ = NSApplication.shared
    let w = World()
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    let d = TalosAppDelegate()
    #expect(d.applicationShouldTerminate(NSApp) == .terminateLater, "an owned terminal is stopped first")
    #expect(d.applicationShouldTerminate(NSApp) == .terminateLater, "a second Quit joins the same stop")
    #expect(w.stops == 1, "the stop ran once")
    await pump(0.5)
    #expect(w.replies.isEmpty, "still stopping")
    w.stopped = true
    await pump(0.6)
    #expect(w.replies == [true], "released once, by a reply, not by calling terminate again")
    #expect(d.applicationShouldTerminate(NSApp) == .terminateNow, "and the quit that follows does not hold again")
    #expect(w.stops == 1)
  }

  @Test func neverHangsWhenTheAgentWillNotStop() async throws {
    _ = NSApplication.shared
    let w = World()
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    let d = TalosAppDelegate()
    #expect(d.applicationShouldTerminate(NSApp) == .terminateLater)
    w.clock += 14
    await pump(0.5)
    #expect(w.replies.isEmpty)
    w.clock += 2  // past 15 s on the monotonic clock
    await pump(0.5)
    #expect(w.replies == [true], "quit anyway")
  }

  @Test func tmuxLetsTheAgentRunAndNothingIsHeld() {
    _ = NSApplication.shared
    let w = World()
    w.tmux = true
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    #expect(TalosAppDelegate().applicationShouldTerminate(NSApp) == .terminateNow)
    #expect(w.stops == 0)
  }

  @Test func quitAndStopHoldsEvenWithTmuxAndTerminatesOnce() async throws {
    _ = NSApplication.shared
    let w = World()
    w.tmux = true
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    let d = TalosAppDelegate()
    var terminateCalls = 0
    // "Quit and stop the agent": it asks AppKit to terminate (here: the delegate directly) and does not call terminate again itself
    QuitCoordinator.shared.quitAndStop(terminate: {
      terminateCalls += 1
      #expect(d.applicationShouldTerminate(NSApp) == .terminateLater)
    })
    #expect(terminateCalls == 1 && w.stops == 1)
    w.stopped = true
    await pump(0.6)
    #expect(w.replies == [true] && terminateCalls == 1, "no second terminate, so nothing re-enters")
  }

  @Test func aLogoutNeverWaitsAndReleasesAHeldQuit() async throws {
    _ = NSApplication.shared
    let w = World()
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    let d = TalosAppDelegate()
    #expect(d.applicationShouldTerminate(NSApp) == .terminateLater)
    QuitCoordinator.shared.systemWillPowerOff()
    #expect(w.replies == [true], "a quit already waiting is released the moment the system says it is powering off")
    // and a quit that arrives after the announcement never holds
    wire(w)
    w.replies = []
    QuitCoordinator.shared.systemWillPowerOff()
    #expect(d.applicationShouldTerminate(NSApp) == .terminateNow)
    #expect(w.stops >= 1, "the stop was at least asked for on the way out")
  }

  @Test func aCancelledLogoutDoesNotSkipTheSafeStopOfEveryLaterQuit() async throws {
    _ = NSApplication.shared
    let w = World()
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    let d = TalosAppDelegate()
    QuitCoordinator.shared.systemWillPowerOff()  // another app blocked the logout: Talos keeps running
    w.clock += QuitCoordinator.powerOffWindow + 1
    #expect(d.applicationShouldTerminate(NSApp) == .terminateLater, "a normal quit afterwards stops the agent safely again")
    w.stopped = true
    await pump(0.6)
    #expect(w.replies == [true] && w.stops == 1)
  }

  @Test func anIdleSessionQuitsAtOnce() {
    _ = NSApplication.shared
    let w = World()
    w.active = false
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    #expect(TalosAppDelegate().applicationShouldTerminate(NSApp) == .terminateNow)
    #expect(w.stops == 0)
  }

  @Test func theAgentThatWasAlreadyStoppedDoesNotHoldTheQuit() {
    _ = NSApplication.shared
    let w = World()
    w.stopped = true
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    #expect(TalosAppDelegate().applicationShouldTerminate(NSApp) == .terminateNow)
    #expect(w.replies.isEmpty, "answered by the return value, never by a reply as well")
  }

  /// What `NSApp.terminate` asks the app's delegate. This one says "not now", so nothing quits the test process, and counts.
  final class RefusingDelegate: NSObject, NSApplicationDelegate {
    var asked = 0
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
      asked += 1
      return .terminateCancel
    }
  }

  /// Arms the app's own rescue helper (a fake app and an opener that does nothing) and swaps the app's delegate for a refusing
  /// one while `body` runs. Everything is put back after.
  func withRescueArmed(_ body: (RefusingDelegate) -> Void) {
    _ = NSApplication.shared
    let rescue = RelaunchGuard.shared
    let saved = (rescue.appPath, rescue.opener)
    rescue.appPath = "/Applications/Fake.app"
    rescue.opener = "/usr/bin/true"
    let old = NSApp.delegate
    let refusing = RefusingDelegate()
    NSApp.delegate = refusing
    rescue.arm()
    defer {
      rescue.disarm()
      (rescue.appPath, rescue.opener) = saved
      NSApp.delegate = old
    }
    body(refusing)
  }

  @Test func theTopMenuQuitCancelsTheRescueAndReachesAppKitsTerminate() throws {
    let m = try scratchModel()
    defer { removeScratchConfig() }
    withRescueArmed { app in
      #expect(RelaunchGuard.shared.isArmed, "the helper is up before the owner quits")
      AppMenuActions.perform(.quit, model: m, open: { _ in })  // the Quit item's own action
      #expect(app.asked == 1, "the menu's Quit ends in NSApp.terminate, which asks the app's delegate")
      #expect(!RelaunchGuard.shared.isArmed, "the owner asked, so no rescue brings Talos back")
    }
  }

  @Test func quitAndStopCancelsTheRescueAndReachesAppKitsTerminate() throws {
    let m = try scratchModel()
    defer {
      removeScratchConfig()
      QuitCoordinator.shared.resetForTests()
    }
    withRescueArmed { app in
      #expect(RelaunchGuard.shared.isArmed)
      m.stopThenQuit()
      #expect(app.asked == 1, "the menu bar's stop-and-quit ends in NSApp.terminate too")
      #expect(QuitCoordinator.shared.stopRequested, "with the stop forced, even with tmux")
      #expect(!RelaunchGuard.shared.isArmed)
    }
  }

  /// The delegate is where a quit from the Dock or Activity Monitor arrives; the sender decides if the owner asked.
  @Test(arguments: ["com.apple.dock", "com.apple.ActivityMonitor"])
  func aQuitFromTheDockOrActivityMonitorCancelsTheRescue(sender: String) {
    let w = World()
    w.stopped = true
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    withRescueArmed { _ in
      #expect(RelaunchGuard.shared.isArmed)
      let delegate = TalosAppDelegate()
      delegate.quitSender = { sender }
      _ = delegate.applicationShouldTerminate(NSApp)
      #expect(!RelaunchGuard.shared.isArmed, "the owner quit Talos from \(sender): no rescue brings it back")
    }
  }

  @Test func aQuitSystemSettingsAsksForKeepsTheRescue() {
    let w = World()
    w.stopped = true
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    withRescueArmed { _ in
      let delegate = TalosAppDelegate()
      delegate.quitSender = { "com.apple.systempreferences" }  // Quit & Reopen after a grant
      _ = delegate.applicationShouldTerminate(NSApp)
      #expect(RelaunchGuard.shared.isArmed, "this is the quit the rescue exists for")
    }
  }

  @Test func aPoliteQuitFromMacOSKeepsTheRescue() {
    let w = World()
    w.stopped = true  // nothing to hold: the answer comes back at once
    wire(w)
    defer { QuitCoordinator.shared.resetForTests() }
    withRescueArmed { _ in
      // no Apple event is being handled, so the sender is unknown
      _ = TalosAppDelegate().applicationShouldTerminate(NSApp)
      #expect(RelaunchGuard.shared.isArmed, "this is the quit the rescue exists for")
    }
  }
}

// MARK: Import, Adopt, pre-setup, launch edit, with the real controller

@MainActor
@Suite("Mac settings: setup through the real controller", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct SetupGuiTests {
  func disk() -> DesktopConfig? { (try? ConfigFile.load(SupervisorController.configPath)) ?? nil }

  @Test func settingsChangedBeforeSetupSurviveAQuitAndNeverCreateTheFile() throws {
    let store = MemoryStore()
    let first = try scratchModel(store)
    defer { removeScratchConfig() }
    #expect(!first.configured)
    first.saveSetting { $0.autoRestart = false; $0.host = .direct; $0.notifyThread = "daily"; $0.agentDir = "/home/alex/held" }
    #expect(!FileManager.default.fileExists(atPath: SupervisorController.configPath), "a toggle must never create desktop.json")
    // a quit and a relaunch: a new controller over the same store
    let second = SupervisorController(store: store)
    let c = second.supervisor.currentConfig()
    #expect(!second.configured)
    #expect(!c.autoRestart && c.host == .direct && c.notifyThread == "daily" && c.agentDir == "/home/alex/held")
    #expect(second.hostKind == .direct, "the held host choice is honoured at launch")
    #expect(!FileManager.default.fileExists(atPath: SupervisorController.configPath))
  }

  @Test func importMergesWhatWasHeldAndSaysItSaved() throws {
    let store = MemoryStore()
    store.setString("ctrl+opt+shift+k", forKey: PreSetup.hotkeyKey)
    let m = try scratchModel(store)
    defer { removeScratchConfig() }
    m.saveSetting { $0.keepAwakeOnAC = true; $0.agentDir = "/home/alex/held" }
    #expect(m.importNote.isEmpty)
    #expect(m.importCommand("claude --dangerously-skip-permissions") == nil)
    #expect(m.importNote == SetupText.importSavedNotStarted, "U7: Import gives a success message")
    #expect(m.configured)
    let d = try #require(disk())
    #expect(d.keepAwakeOnAC && d.agentDir == "/home/alex/held", "held settings joined the file")
    #expect(d.hotkeys.compose == "ctrl+opt+shift+k", "a hotkey set before setup no longer reverts")
    #expect(d.args == ["--dangerously-skip-permissions"])
    #expect(PreSetup.load(store) == nil, "and the held copy is gone")
  }

  @Test func theFoldersOfAPastedCommandBeatAHeldOne() throws {
    let m = try scratchModel()
    defer { removeScratchConfig() }
    m.saveSetting { $0.agentDir = "/home/alex/held" }
    #expect(m.importCommand("cd /home/alex/pasted && claude --x") == nil)
    #expect(disk()?.agentDir == "/home/alex/pasted")
  }

  @Test func aRefusedImportSaysWhyWritesNothingAndKeepsTheHeldValues() throws {
    let store = MemoryStore()
    let m = try scratchModel(store)
    defer { removeScratchConfig() }
    m.saveSetting { $0.keepAwakeOnAC = true }
    let why = m.importCommand("claude; rm -rf /")
    #expect(why == LaunchSpec.ParseError.forbidden("`;`").description)
    #expect(m.importNote.isEmpty && !m.configured)
    #expect(!FileManager.default.fileExists(atPath: SupervisorController.configPath))
    #expect(PreSetup.load(store)?.keepAwakeOnAC == true)
  }

  @Test func heldValuesFromBeforeTheFileNeverOverwriteLiveSettingsOnALaterImport() throws {
    let store = MemoryStore()
    let m = try scratchModel(store)
    defer { removeScratchConfig() }
    #expect(m.importCommand("claude --one") == nil)
    // an older build left these behind (it never cleared the hotkey's), then the owner changed the settings for real
    m.saveSetting { $0.relayUrl = "https://new.example.com"; $0.hotkeys.compose = "cmd+shift+k" }
    store.setString("ctrl+opt+Space", forKey: PreSetup.hotkeyKey)
    var stale = DesktopConfig.defaults
    stale.relayUrl = "https://old.example.com"
    PreSetup.record(stale, in: store)
    store.setString("ctrl+opt+Space", forKey: PreSetup.hotkeyKey)
    #expect(m.importCommand("claude --two") == nil)
    let d = try #require(disk())
    #expect(d.args == ["--two"])
    #expect(d.relayUrl == "https://new.example.com" && d.hotkeys.compose == "cmd+shift+k", "the live file wins over anything held")
  }

  @Test func aLaunchWithAFileDropsWhatWasHeld() throws {
    let store = MemoryStore()
    let m = try scratchModel(store)
    defer { removeScratchConfig() }
    #expect(m.importCommand("claude --one") == nil)
    PreSetup.record(.defaults, in: store)
    store.setString("ctrl+opt+Space", forKey: PreSetup.hotkeyKey)
    #expect(PreSetup.load(store) != nil)
    _ = SupervisorController(store: store)  // a relaunch with desktop.json present
    #expect(PreSetup.load(store) == nil)
  }

  @Test func aSavedHostThatNeedsARelaunchRefusesToStartAndSaysWhy() throws {
    let m = try scratchModel()
    defer { removeScratchConfig() }
    #expect(m.importCommand("claude --one") == nil)
    m.tmuxUsable = true  // whichever host this run got, tmux counts as usable for the choice below
    let runningTmux = m.hostKind == .tmux
    let same: DesktopConfig.Host = runningTmux ? .tmux : .direct
    let other: DesktopConfig.Host = runningTmux ? .direct : .tmux
    m.saveSetting { $0.host = same }
    #expect(m.prepareToStart(), "nothing pending: a start goes ahead")
    m.saveSetting { $0.host = other }  // applies at the next launch
    m.notice = ""
    #expect(!m.prepareToStart())
    #expect(m.notice == HostChoice.startBlock(saved: other, runningTmux: runningTmux, tmuxUsable: true))
    #expect(m.notice.contains("quit and reopen"))
    #expect(m.supervisor.status.phase == .idle, "and nothing started")
    m.saveSetting { $0.host = same }
    #expect(m.prepareToStart(), "back to what is running: fine again")
  }

  @Test func theImportNoteGoesWhenASessionStartsAndNeverClaimsNothingStartedWhileOneRuns() throws {
    let m = try scratchModel()
    defer { removeScratchConfig() }
    #expect(m.importCommand("claude --one") == nil)
    #expect(m.importNote == SetupText.importSavedNotStarted)
    #expect(m.prepareToStart())
    #expect(m.importNote.isEmpty, "a start clears 'Nothing has started yet'")
  }

  @Test func aFailedWriteIsReportedAndLosesNothing() throws {
    let store = MemoryStore()
    let m = try scratchModel(store)
    defer { removeScratchConfig() }
    m.saveSetting { $0.keepAwakeOnAC = true }
    let dir = (SupervisorController.configPath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    chmod(dir, 0o500)  // a folder he cannot write to
    let why = m.importCommand("claude --x")
    chmod(dir, 0o700)
    #expect(why == SetupText.importNotSaved(path: SupervisorController.configPath), "forced error: the owner sees it")
    #expect(!m.configured && m.importNote.isEmpty)
    #expect(PreSetup.load(store)?.keepAwakeOnAC == true, "the held values are still there to try again")
  }

  @Test func theLaunchBoxEditsInPlaceAndKeepsEnvAndTheConversation() throws {
    let m = try scratchModel()
    defer { removeScratchConfig() }
    #expect(m.editLaunchLine("claude --a") == .refused(SetupText.launchNeedsSetup), "before setup there is nothing to edit")
    #expect(m.importCommand("FOO=secret-value claude --first --resume 11111111-2222-4333-8444-555555555555") == nil)
    let before = try #require(disk())
    #expect(before.env["FOO"] == "secret-value" && before.session.id == "11111111-2222-4333-8444-555555555555")

    #expect(m.editLaunchLine("claude --first --second") == .updated(claudePath: "auto", args: ["--first", "--second"]))
    var d = try #require(disk())
    #expect(d.args == ["--first", "--second"])
    #expect(d.env == before.env && d.session == before.session, "environment values and ids untouched")
    #expect(m.editLaunchLine("claude --first --second") == .unchanged)

    let bytes = try Data(contentsOf: URL(fileURLWithPath: SupervisorController.configPath))
    #expect(m.editLaunchLine("FOO=other claude --x") == .refused(LaunchEdit.envPointer), "points at Import")
    #expect(m.editLaunchLine("claude;") != .unchanged)
    #expect(try Data(contentsOf: URL(fileURLWithPath: SupervisorController.configPath)) == bytes, "a refusal changes nothing on disk")
    d = try #require(disk())
    #expect(d.args == ["--first", "--second"])
    #expect(m.supervisor.currentConfig().launchFingerprint(resolvedClaude: "/x") != before.launchFingerprint(resolvedClaude: "/x"), "the next start is cold")
  }
}

// MARK: the screens

@MainActor
@Suite("Mac settings: screens", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct MacHomesScreensGuiTests {
  nonisolated(unsafe) static var keep: [NSWindow] = []

  func host<V: View>(_ v: V, size: NSSize, dark: Bool) -> (NSWindow, NSHostingView<AnyView>) {
    let name: NSAppearance.Name = dark ? .darkAqua : .aqua
    let h = NSHostingView(rootView: AnyView(v.frame(width: size.width, height: size.height)))
    let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.animationBehavior = .none
    Self.keep.append(w)  // never freed mid-test: AppKit may still be animating it
    w.appearance = NSAppearance(named: name)
    w.contentView = h
    h.appearance = NSAppearance(named: name)
    h.frame = NSRect(origin: .zero, size: size)
    h.layoutSubtreeIfNeeded()
    return (w, h)
  }

  /// Lets the view load (the checklist asks the shell, the tabs build on first show), lays it out and draws it once.
  func settle(_ h: NSView, _ seconds: Double = 1.6) async {
    await pump(seconds)
    h.layoutSubtreeIfNeeded()
    h.displayIfNeeded()
    await pump(0.2)
    h.layoutSubtreeIfNeeded()
  }

  func png(_ h: NSView) throws -> Data {
    let rep = try #require(h.bitmapImageRepForCachingDisplay(in: h.bounds))
    h.cacheDisplay(in: h.bounds, to: rep)
    return try #require(rep.representation(using: .png, properties: [:]))
  }

  /// All six tabs, light and dark, and the states that matter: not set up, set up, a refused launch line, a narrow window.
  @Test func everyTabRendersInBothThemes() async throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    let shots = ProcessInfo.processInfo.environment["TALOS_SHOT_DIR"]
    if let d = shots { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
    var sizes: [String: Int] = [:]
    for dark in [false, true] {
      for tab in [SettingsNavigator.Tab.session, .connection, .permissions, .hotkeys, .companion, .general] {
        SettingsNavigator.shared.selected = tab
        let (w, h) = host(SettingsView(model: m), size: NSSize(width: 700, height: 600), dark: dark)
        _ = w
        await pump(1.0)
        h.layoutSubtreeIfNeeded()
        let data = try png(h)
        #expect(data.count > 4_000, "\(tab) \(dark ? "dark" : "light") is not blank")
        sizes["\(tab)-\(dark)"] = data.count
        if let d = shots { try data.write(to: URL(fileURLWithPath: d + "/mac-\(tab.rawValue)-\(dark ? "dark" : "light").png")) }
      }
    }
    #expect(sizes["session-false"] != sizes["session-true"], "the dark theme really drew differently")
  }

  /// The screens' words are asserted in the core tests (`MacHomesCoreTests`) and the pictures are read by a person: this checks
  /// the states draw something different from each other and from a blank view, and writes them out when TALOS_SHOT_DIR is set.
  @Test func notSetUpSetUpAndRefusedStatesAllDrawAndDiffer() async throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    let dir = ProcessInfo.processInfo.environment["TALOS_SHOT_DIR"]
    SettingsNavigator.shared.selected = .session
    func shot(_ name: String, _ v: SettingsView, size: NSSize, dark: Bool) async throws -> Data {
      let (_, h) = host(v, size: size, dark: dark)
      await settle(h)
      let d = try png(h)
      if let dir { try d.write(to: URL(fileURLWithPath: dir + "/\(name).png")) }
      return d
    }
    let notSet = try await shot("mac-session-not-set-up-light", SettingsView(model: m), size: NSSize(width: 700, height: 600), dark: false)
    #expect(m.importCommand("SECRET=secret-value claude --x") == nil)
    let setUp = try await shot("mac-session-set-up-light", SettingsView(model: m), size: NSSize(width: 700, height: 600), dark: false)
    let refused = try await shot("mac-session-refused-dark", SettingsView(model: m, typedLaunchLine: "claude; ls"), size: NSSize(width: 700, height: 600), dark: true)
    let narrow = try await shot("mac-session-narrow-light", SettingsView(model: m), size: NSSize(width: 640, height: 520), dark: false)
    for d in [notSet, setUp, refused, narrow] { #expect(d.count > 8_000) }
    #expect(notSet != setUp && setUp != refused)
    #expect(m.supervisor.currentConfig().args == ["--x"], "the refused line changed nothing")
    #expect(m.supervisor.currentConfig().env["SECRET"] == "secret-value")
  }

  /// SwiftUI text is not reachable offscreen (no accessibility client, and text recognition did not work), so the note is told
  /// by its pixels: the same Session tab with the same saved line, drawn right after a successful edit and drawn fresh.
  @Test func aSuccessfulLaunchEditKeepsItsSavedNoteOnScreen() async throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    #expect(m.importCommand("claude --x") == nil)
    SettingsNavigator.shared.selected = .session
    let size = NSSize(width: 700, height: 700)
    let (_, h1) = host(SettingsView(model: m, typedLaunchLine: "claude --y"), size: size, dark: false)
    await settle(h1, 2.5)
    #expect(m.supervisor.currentConfig().args == ["--y"], "the edit was saved")
    let afterEdit = try png(h1)
    let (_, h2) = host(SettingsView(model: m), size: size, dark: false)
    await settle(h2, 2.5)
    let fresh = try png(h2)
    #expect(afterEdit != fresh, "right after the edit the window carries the Saved / cold-start note that a fresh one does not")
    if let d = ProcessInfo.processInfo.environment["TALOS_SHOT_DIR"] {
      try afterEdit.write(to: URL(fileURLWithPath: d + "/mac-session-launch-saved-light.png"))
    }
  }

  @Test func openingMacSettingsNeverRunsTmuxOnTheMainThread() async throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    #expect(m.importCommand("claude --x") == nil)
    let before = SupervisorController.findTmuxCalls
    for tab in [SettingsNavigator.Tab.session, .general] {
      SettingsNavigator.shared.selected = tab
      let (_, h) = host(SettingsView(model: m), size: NSSize(width: 700, height: 600), dark: false)
      await settle(h, 2.8)  // past two of the controller's 1 s status republishes, each of which redraws the view
      m.saveSetting { $0.autoRestart.toggle() }  // and a change redraws it too
      await pump(0.3)
    }
    #expect(SupervisorController.findTmuxCalls == before, "tmux is looked for once at launch, never by a view")
  }

  @Test func theChecklistOffersTheDockIconOffByDefault() async throws {
    _ = NSApplication.shared
    let m = try scratchModel()
    defer { removeScratchConfig() }
    let key = "showDockIcon"
    let had = UserDefaults.standard.object(forKey: key)
    UserDefaults.standard.removeObject(forKey: key)
    defer { if let had { UserDefaults.standard.set(had, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) } }
    let (_, h) = host(OnboardingView(model: m), size: NSSize(width: 560, height: 1100), dark: false)
    await settle(h, 3.0)
    #expect(UserDefaults.standard.bool(forKey: key) == false, "still off by default (O7)")
    let src = try String(contentsOfFile: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Sources/TalosDesktop/Onboarding.swift").path, encoding: .utf8)
    #expect(src.contains("\"Show a Dock icon\"") && src.contains("ActivationPolicyController.shared.refresh()"))
    if let d = ProcessInfo.processInfo.environment["TALOS_SHOT_DIR"] { try png(h).write(to: URL(fileURLWithPath: d + "/mac-checklist-light.png")) }
  }
}

import Foundation
import Testing

@testable import TalosDesktopCore

// The top menu, Help, sign-in help, the Blocked text, the Settings text boxes and the Quit & Reopen helper
// (fix/mac-settings-menu, from the owner's first real Mac run, 2026-11-01).

@Suite("Settings text boxes follow the config")
struct SettingsDraftsTests {
  func cfg(dir: String, relay: String = "https://relay.example.com", cli: [String] = []) -> DesktopConfig {
    var c = DesktopConfig.defaults
    c.agentDir = dir
    c.relayUrl = relay
    c.talosAppCommand = cli
    return c
  }

  @Test func anAdoptAfterTheWindowOpenedShowsTheNewFolder() {
    var d = SettingsDrafts(from: .defaults)  // window opened before setup: the default folder
    #expect(d.dir == "~/talos-agent")
    d.follow(cfg(dir: "/home/alex/agent"))  // Adopt rewrote desktop.json
    #expect(d.dir == "/home/alex/agent")
  }

  @Test func aBoxHeIsTypingInIsNotOverwritten() {
    var d = SettingsDrafts(from: .defaults)
    d.relay = "https://half-typed"
    d.follow(cfg(dir: "/home/alex/agent", relay: "https://relay.other.example.com"))
    #expect(d.relay == "https://half-typed")
    #expect(d.dir == "/home/alex/agent", "the untouched box still follows")
  }

  @Test func theCommandBoxFollowsToo() {
    var d = SettingsDrafts(from: .defaults)
    d.follow(cfg(dir: "~/talos-agent", cli: ["bun", "run", "/home/alex/cli.ts"]))
    #expect(d.cli == "bun run /home/alex/cli.ts")
  }
}

@Suite("Blocked screen text")
struct BlockedTextTests {
  func blocker(_ r: TakeoverCheck.Resource, pid: Int32 = 40, folder: String? = "/home/alex/agent") -> TakeoverCheck.Blocker {
    TakeoverCheck.Blocker(resource: r, holderPid: 42, sessionPid: pid, folder: folder)
  }

  @Test func oneSessionHoldingThreeThingsIsOneLine() {
    let lines = BlockedText.lines([blocker(.telegram), blocker(.bridge), blocker(.channels)])
    #expect(lines.count == 1)
    #expect(lines[0].contains("Telegram, the Talos bridge and channels"))
    #expect(lines[0].components(separatedBy: "Another Claude session").count == 2, "the sentence appears once")
  }

  @Test func twoSessionsAreTwoLines() {
    #expect(BlockedText.lines([blocker(.telegram, pid: 40), blocker(.bridge, pid: 41)]).count == 2)
  }

  @Test func theWordsMatchTheButton() {
    let line = BlockedText.lines([blocker(.telegram)])[0]
    #expect(line.contains("\u{201C}\(BlockedText.adoptButton)\u{201D}"))
    #expect(BlockedText.adoptButton == "Find a running session")
    #expect(!line.contains("Adopt it"))
    #expect(blocker(.telegram).message.contains(BlockedText.adoptButton), "the per-holder message says it too")
  }

  @Test func theNoticeThatRepeatsItIsDroppedOnlyWhileBlocked() {
    let n = "\(SupervisorNotice.blocked): Another Claude session (pid 40) holds Telegram."
    #expect(BlockedText.notice(n, whileBlocked: true) == "")
    #expect(BlockedText.notice(n, whileBlocked: false) == n)
    #expect(BlockedText.notice("Something else", whileBlocked: true) == "Something else")
  }

  @Test func theWholeScreenSaysItOnce() {
    let bs = [blocker(.telegram), blocker(.bridge), blocker(.channels)]
    let notice = "\(SupervisorNotice.blocked): \(bs[0].message)"
    let screen = ([BlockedText.notice(notice, whileBlocked: true)] + BlockedText.lines(bs)).joined(separator: "\n")
    #expect(screen.components(separatedBy: "Another Claude session").count == 2)
  }
}

@Suite("Sign-in help")
struct SignInHelpTests {
  @Test func theDefaultCommandIsTheExactOneToType() {
    #expect(SignInHelp.command(resolved: nil) == "talos-app enroll --label 'Mac app'")
  }

  @Test func aFoundTalosAppKeepsItsPathUnlessTheTerminalFindsTheName() {
    // The Terminal's PATH may not be Talos's: a shortened path is "command not found" for a binary found under ~/.bun/bin.
    #expect(
      SignInHelp.command(resolved: ["/home/alex/.bun/bin/talos-app"]) == "/home/alex/.bun/bin/talos-app enroll --label 'Mac app'")
    #expect(
      SignInHelp.command(resolved: ["/opt/homebrew/bin/talos-app"], onTerminalPath: true) == "talos-app enroll --label 'Mac app'")
  }

  @Test func aScriptCommandKeepsItsPaths() {
    #expect(
      SignInHelp.command(resolved: ["/opt/bun/bin/bun", "run", "/home/alex/talos-app/apps/bridge/src/cli.ts"])
        == "/opt/bun/bin/bun run /home/alex/talos-app/apps/bridge/src/cli.ts enroll --label 'Mac app'")
  }

  @Test func theFallbackCarriesTheCommand() {
    let c = SignInHelp.command(resolved: nil)
    let f = SignInHelp.fallback(command: c, why: "It didn't start.")
    #expect(f.contains(c) && f.hasPrefix("It didn't start."))
  }
}

@Suite("Talos Help")
struct HelpPageTests {
  @Test func helpIsOnePageInTheTalosWindow() {
    #expect(HelpPage.path == "/help")
    #expect(AppPath.isValid(HelpPage.path), "the window accepts a navigate to it")
    #expect(NativeToWeb.navigate(path: HelpPage.path).javascript() != nil, "and the message reaches the page")
  }

  @Test func withARelayItShowsThePageAndWithoutOneItSaysWhy() {
    #expect(HelpPage.plan(hasRelay: true) == .showPage(path: "/help"))
    guard case .needsRelay(let notice) = HelpPage.plan(hasRelay: false) else {
      Issue.record("expected needsRelay")
      return
    }
    #expect(notice == HelpPage.noRelay)
    #expect(notice.contains(MacSettingsText.connectionPath), "it points at the tab that sets the relay address")
  }

  @Test func theConnectionTabShowsWhyHelpSentTheOwnerThereOnlyWhileThereIsNoRelay() {
    #expect(MacSettingsText.connectionNotice(HelpPage.noRelay, hasRelay: false) == HelpPage.noRelay)
    #expect(MacSettingsText.connectionNotice(MacSettingsText.noRelayYet, hasRelay: false) == MacSettingsText.noRelayYet)
    #expect(MacSettingsText.connectionNotice(HelpPage.noRelay, hasRelay: true).isEmpty, "stale once an address is set")
    #expect(MacSettingsText.connectionNotice("Bridge log not written yet", hasRelay: false).isEmpty, "other notices stay where they are")
    #expect(MacSettingsText.connectionNotice("", hasRelay: false).isEmpty)
  }

  @Test func theConnectionTabReallyDrawsThatNotice() throws {
    let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop/SettingsView.swift")
    let t = try String(contentsOf: src, encoding: .utf8)
    let tab = try #require(t.range(of: "private var connection: some View"))
    let body = String(t[tab.lowerBound...].prefix(900))
    #expect(body.contains("MacSettingsText.connectionNotice(model.liveNotice, hasRelay: web.hasRelay)"))
    #expect(body.contains("Text(why)"), "the notice is drawn, not only computed")
  }

  @Test func theFailureScreenCarriesTheOutageFixesBecauseHelpCannotLoadThen() {
    #expect(PageState.outageHelp.count == 3)
    let all = PageState.outageHelp.joined(separator: " ")
    for word in ["Start session", "talos-app status", "talos-app doctor", "talos-app logs", "menu bar"] { #expect(all.contains(word), Comment(rawValue: word)) }
    #expect(PageState.outageHelp.allSatisfy { !$0.contains("/Users/") })
  }

  @Test func theMacKeepsNoSecondCopyOfTheText() throws {
    let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources")
    let files = FileManager.default.enumerator(at: src, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? []
    let names = files.map(\.lastPathComponent)
    #expect(!names.contains("HelpContent.swift") && !names.contains("HelpView.swift"))
    for f in files where f.pathExtension == "swift" {
      let t = try String(contentsOf: f, encoding: .utf8)
      #expect(!t.contains(#"id: "help""#) && !t.contains("HelpView("), "\(f.lastPathComponent) opens a Help window of its own")
    }
  }
}

@Suite("Top menu spec")
struct AppMenuSpecTests {
  @Test func settingsIsInTheTalosMenuWithCommandComma() {
    let s = AppMenuSpec.talosMenu.items.compactMap { $0 }.first { $0.action == .settings }
    #expect(s?.title == "Settings\u{2026}")
    #expect(s?.key == ",")
  }

  @Test func thereIsAHelpMenuWithTalosHelp() {
    #expect(AppMenuSpec.helpMenu.title == "Help")
    let titles = AppMenuSpec.helpMenu.items.compactMap { $0?.title }
    #expect(titles == ["Talos Help"])
  }

  @Test func closeAndMinimizeAreThereSoCommandWWorks() {
    let items = AppMenuSpec.windowMenu.items.compactMap { $0 }
    #expect(items.contains { $0.action == .closeWindow && $0.key == "w" })
    #expect(items.contains { $0.action == .minimize && $0.key == "m" })
  }

  @Test func everyActionIsOfferedOnce() {
    let all: [AppMenuSpec.Action] = AppMenuSpec.all.flatMap { m in m.items.compactMap { $0?.action } }
    #expect(Set(all) == Set(AppMenuSpec.Action.allCases))
    #expect(all.count == Set(all).count)
  }

  @Test func noTwoItemsShareAShortcut() {
    let keyed: [AppMenuSpec.Item] = AppMenuSpec.all.flatMap { m in m.items.compactMap { $0 } }.filter { !$0.key.isEmpty }
    let ids = keyed.map { "\($0.key)|\($0.shift)|\($0.option)" }
    #expect(ids.count == Set(ids).count)
  }
}

@Suite("Permissions reopen note")
struct ReopenNoteTests {
  @Test func saysWhatToExpect() {
    #expect(PermissionsModel.reopenNote.contains("Quit & Reopen"))
  }
}

@Suite("Quit & Reopen helper", .serialized)
struct RelaunchWatchdogTests {
  /// A fake `open` that writes the app path it was given into a marker file.
  func rig() throws -> (dir: URL, opener: String, marker: URL) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("relaunch-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let marker = dir.appendingPathComponent("opened")
    let opener = dir.appendingPathComponent("fake-open.sh")
    try "#!/bin/sh\necho \"$1 $2 $3\" > '\(marker.path)'\n".write(to: opener, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: opener.path)
    return (dir, opener.path, marker)
  }

  func victim() throws -> Process {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sleep")
    p.arguments = ["60"]
    try p.run()
    return p
  }

  func wait(_ s: Double, _ cond: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(s)
    while Date() < end { if cond() { return true }; Thread.sleep(forTimeInterval: 0.05) }
    return cond()
  }

  @Test func opensTheAppAfterTheAppIsKilled() throws {
    let r = try rig()
    defer { try? FileManager.default.removeItem(at: r.dir) }
    let v = try victim()
    defer { if v.isRunning { v.terminate() } }
    let w = try #require(
      RelaunchWatchdog.start(pid: v.processIdentifier, app: "/Applications/Fake.app", settleSeconds: "0.1", opener: r.opener))
    defer { if w.isRunning { w.terminate() } }
    Thread.sleep(forTimeInterval: 0.5)
    #expect(!FileManager.default.fileExists(atPath: r.marker.path), "nothing opens while the app is alive")
    kill(v.processIdentifier, SIGKILL)  // what macOS does for Quit & Reopen
    #expect(wait(8) { FileManager.default.fileExists(atPath: r.marker.path) }, "the app was not reopened")
    let said = (try? String(contentsOf: r.marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    // The reopened app is told it is a rescue, so it never cold-starts an agent by itself.
    #expect(said == "/Applications/Fake.app --args \(RelaunchWatchdog.relaunchFlag)")
  }

  @Test func aQuitTheOwnerAskedForNeverReopens() throws {
    let r = try rig()
    defer { try? FileManager.default.removeItem(at: r.dir) }
    let v = try victim()
    let w = try #require(
      RelaunchWatchdog.start(pid: v.processIdentifier, app: "/Applications/Fake.app", settleSeconds: "0.1", opener: r.opener))
    w.terminate()  // the quit path ends the helper first
    w.waitUntilExit()
    kill(v.processIdentifier, SIGKILL)
    v.waitUntilExit()
    Thread.sleep(forTimeInterval: 1.0)
    #expect(!FileManager.default.fileExists(atPath: r.marker.path))
  }

  @Test func givesUpAfterTheDeadline() throws {
    let r = try rig()
    defer { try? FileManager.default.removeItem(at: r.dir) }
    let v = try victim()
    defer { if v.isRunning { v.terminate() } }
    let w = try #require(
      RelaunchWatchdog.start(pid: v.processIdentifier, app: "/Applications/Fake.app", maxSeconds: 1, settleSeconds: "0.1", opener: r.opener))
    #expect(wait(6) { !w.isRunning }, "the helper must end on its own")
    kill(v.processIdentifier, SIGKILL)
    v.waitUntilExit()
    Thread.sleep(forTimeInterval: 0.6)
    #expect(!FileManager.default.fileExists(atPath: r.marker.path))
  }

  @Test func onlyAnAppBundleIsRelaunched() {
    #expect(RelaunchWatchdog.start(app: "/home/alex/.build/debug/TalosDesktop") == nil)
  }
}

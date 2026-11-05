import Foundation
import Testing
@testable import TalosDesktopCore

/// R4: the Mac half of D48 (notification permission), D62 (Open Log) and D63 (the Keep awake setting).
@Suite("R4 settings and Mac app, core")
struct R4SettingsCoreTests {
  // D48: the page is told what macOS says, in the words the web schema allows.
  @Test func authorizationStatusMapsTheWayNotifierActs() {
    #expect(NotifyPermission(authorizationStatusRaw: 0) == .notAsked)
    #expect(NotifyPermission(authorizationStatusRaw: 1) == .denied)
    // authorized, provisional, ephemeral: the three statuses Notifier.show posts for
    for raw in [2, 3, 4] { #expect(NotifyPermission(authorizationStatusRaw: raw) == .granted) }
    // a status this build does not know posts nothing, so it must not read as allowed
    #expect(NotifyPermission(authorizationStatusRaw: 99) == .denied)
  }

  @Test func notifyPermissionGoesToThePageAsTheSchemaSpellsIt() throws {
    for (p, word) in [(NotifyPermission.granted, "granted"), (.denied, "denied"), (.notAsked, "not_asked")] {
      let m = NativeToWeb.notifyPermission(p)
      #expect(m.object["state"] as? String == word)
      let js = try #require(m.javascript())
      #expect(js.hasPrefix("window.talosNative && window.talosNative.receive("))
      #expect(js.contains("notify_permission"))
    }
  }

  // D62: Open Log reveals the file the bridge really writes.
  @Test func bridgeLogFollowsTheSameHomeAsTheBridge() {
    let home = "/home/alex"
    #expect(BridgeLog.path(configEnv: [:], processEnv: [:], home: home) == "/home/alex/.config/talos/app/bridge.log")
    #expect(BridgeLog.path(configEnv: [:], processEnv: ["TALOS_APP_HOME": "/srv/t"], home: home) == "/srv/t/bridge.log")
    // desktop.json's env wins over the process environment, like SupervisorController's talosHome
    #expect(
      BridgeLog.path(configEnv: ["TALOS_APP_HOME": "/srv/cfg"], processEnv: ["TALOS_APP_HOME": "/srv/t"], home: home)
        == "/srv/cfg/bridge.log")
    // an empty value is not a folder
    #expect(
      BridgeLog.path(configEnv: ["TALOS_APP_HOME": ""], processEnv: [:], home: home) == "/home/alex/.config/talos/app/bridge.log")
    #expect(BridgeLog.path(configEnv: ["TALOS_APP_HOME": "~/t"], processEnv: [:], home: home) == "/home/alex/t/bridge.log")
  }

  // D63: the setting is off by default, survives a round trip, and an old desktop.json without it still loads.
  @Test func keepAwakeIsOffByDefaultAndRoundTrips() throws {
    #expect(DesktopConfig.defaults.keepAwakeOnAC == false)
    var c = DesktopConfig.defaults
    c.keepAwakeOnAC = true
    let back = try DesktopConfig.decode(try c.encoded())
    #expect(back.keepAwakeOnAC)
    let text = String(decoding: try c.encoded(), as: UTF8.self)
    #expect(text.contains("\"keep_awake_on_ac\" : true"))
  }

  @Test func anOldFileWithoutTheKeyLoadsWithItOff() throws {
    let old = Data(#"{"v":1,"agent_dir":"~/a"}"#.utf8)
    #expect(try DesktopConfig.decode(old).keepAwakeOnAC == false)
  }
}

// "Open the Talos window at launch" (2026-11-02): the owner launched Talos and saw no window.
@Suite("Open the Talos window at launch")
struct OpenWindowAtLaunchTests {
  @Test func onByDefaultAndRoundTrips() throws {
    #expect(DesktopConfig.defaults.openWindowAtLaunch)
    var c = DesktopConfig.defaults
    c.openWindowAtLaunch = false
    let back = try DesktopConfig.decode(try c.encoded())
    #expect(!back.openWindowAtLaunch)
    #expect(String(decoding: try c.encoded(), as: UTF8.self).contains("\"open_window_at_launch\" : false"))
  }

  @Test func anOldFileOrABadValueLoadsWithItOn() throws {
    #expect(try DesktopConfig.decode(Data(#"{"v":1,"agent_dir":"~/a"}"#.utf8)).openWindowAtLaunch)
    let bad = try DesktopConfig.decode(Data(#"{"v":1,"agent_dir":"~/a","open_window_at_launch":"maybe","auto_restart":false}"#.utf8))
    #expect(bad.openWindowAtLaunch && !bad.autoRestart, "one bad value costs that setting only")
  }

  @Test func aChoiceMadeBeforeSetupIsHeldAndApplied() {
    var off = DesktopConfig.defaults
    off.openWindowAtLaunch = false
    #expect(PreSetup.snapshot(of: off).applied(to: .defaults).openWindowAtLaunch == false)
    #expect(PreSetup().applied(to: off).openWindowAtLaunch == false, "nothing held leaves it as it is")
  }

  @Test func opensOncePerLaunchAndOnlyWithARelayAndTheSettingOn() {
    var g = LaunchWindowGate()
    let off = g.shouldOpen(enabled: false, hasRelay: true)
    let noRelay = g.shouldOpen(enabled: true, hasRelay: false)
    let first = g.shouldOpen(enabled: true, hasRelay: true)
    let second = g.shouldOpen(enabled: true, hasRelay: true)
    var fresh = LaunchWindowGate()
    let next = fresh.shouldOpen(enabled: true, hasRelay: true)
    #expect(!off, "turned off")
    #expect(!noRelay, "no relay yet")
    #expect(first, "the launch was not used up by the refusals")
    #expect(!second, "once per launch")
    #expect(next, "the next launch is a new gate")
  }

  @Test func notOnAFirstRunAndNotOnARescueRelaunch() {
    var g = LaunchWindowGate()
    let firstRun = g.shouldOpen(enabled: true, hasRelay: true, setUp: false)
    let rescue = g.shouldOpen(enabled: true, hasRelay: true, rescueRelaunch: true)
    let normal = g.shouldOpen(enabled: true, hasRelay: true, setUp: true, rescueRelaunch: false)
    #expect(!firstRun && !rescue && normal)
  }

  @Test func theSettingHasAnAppliesNote() {
    #expect(!MacSettingsText.applies(.openWindowAtLaunch).isEmpty)
  }
}

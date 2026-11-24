import Foundation
import Testing

@testable import TalosDesktopCore

/// TALOS_APP_BUNDLE: the Mac tells the agent it starts where the app is installed, and the live bridge (the only writer of
/// status.json) copies it there as `app_path` for `talos-app facts`. It is a runtime variable: it must never reach what the owner
/// confirmed (desktop.json) nor a thread session's launch hash.
@Suite("AppBundleEnv")
struct AppBundleEnvTests {
  let shell = ["PATH": "/usr/bin:/bin", "HOME": "/home/alex"]

  @Test func aRealAppFolderBecomesTheVariableAndAnythingElseIsNone() throws {
    let dir = NSTemporaryDirectory() + "talos-appbundle-" + UUID().uuidString
    try FileManager.default.createDirectory(atPath: dir + "/Talos.app/Contents", withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }  // a folder this test made
    let real = (dir as NSString).resolvingSymlinksInPath + "/Talos.app"
    #expect(AppBundle.resolve(bundlePath: dir + "/Talos.app") == real)
    // a link to the app stands for the real folder
    try FileManager.default.createSymbolicLink(atPath: dir + "/Link.app", withDestinationPath: dir + "/Talos.app")
    #expect(AppBundle.resolve(bundlePath: dir + "/Link.app") == real)
    // a test runner, a debug build and a plain folder are not an installed app
    for p in [dir + "/Talos.xctest", dir + "/plain", "/home/alex/.build/debug", "", "Talos.app", dir + "/Missing.app"] {
      #expect(AppBundle.resolve(bundlePath: p) == nil, "\(p)")
    }
    #expect(AppBundle.path == nil, "the test runner is not a .app")
  }

  @Test func buildSetsItForAnAppAndNeverOtherwise() {
    let with = LoginShellEnv.build(shellEnv: shell, overrides: [:], appBundle: "/home/alex/Applications/Talos.app")
    #expect(with["TALOS_APP_BUNDLE"] == "/home/alex/Applications/Talos.app")
    #expect(LoginShellEnv.build(shellEnv: shell, overrides: [:], appBundle: nil)["TALOS_APP_BUNDLE"] == nil)
  }

  @Test func aValueFromTheShellOrDesktopJsonNeverStandsInForTheApp() {
    let forged = ["TALOS_APP_BUNDLE": "/home/alex/Evil.app"]
    // not an app run (Linux, a dev build): a leftover from the login shell or the file is dropped, so no stale path is announced
    #expect(LoginShellEnv.build(shellEnv: shell.merging(forged) { a, _ in a }, overrides: forged, appBundle: nil)["TALOS_APP_BUNDLE"] == nil)
    // an app run: the app's own folder wins over both
    let env = LoginShellEnv.build(shellEnv: shell.merging(forged) { a, _ in a }, overrides: forged, appBundle: "/Applications/Talos.app")
    #expect(env["TALOS_APP_BUNDLE"] == "/Applications/Talos.app")
  }

  @Test func theLaunchHashAndTheConfirmedLaunchDoNotMoveWithIt() {
    let files: [String: Data?] = ["mcp.json": Data("{}".utf8)]
    func hash(_ bundle: String?) -> String? {
      let base = LoginShellEnv.build(shellEnv: shell, overrides: ["TALOS_APP_BRIDGE": "1"], appBundle: bundle)
      var env = base
      env["TALOS_APP_HOME"] = "/home/alex/.config/talos/app"  // what a start sets over the login env
      return LaunchSpecHash.hash(argv: ["claude", "--name", "talos-x"], env: env, baseEnv: base, files: files)
    }
    let none = hash(nil)
    #expect(none != nil)
    #expect(hash("/Applications/Talos.app") == none, "restart-on-update would restart every session because of a variable that is not a setting")
    #expect(hash("/home/alex/Applications/Talos.app") == none)
    // the owner's confirmed launch is made from desktop.json only: neither the required bridge variables nor an import carry it
    #expect(BridgeEnv.required["TALOS_APP_BUNDLE"] == nil)
    #expect(BridgeEnv.merged(["A": "1"])["TALOS_APP_BUNDLE"] == nil)
    let c = DesktopConfig(
      v: 1, agentDir: "/home/alex/agent", claudePath: "auto", args: [], env: BridgeEnv.merged([:]), session: .init(id: nil, previousIds: []),
      autoRestart: true, autoConfirmRestart: false, startSessionOnLaunch: true, openTerminalOnDialog: false, relayUrl: "")
    #expect(c.launchFingerprint(resolvedClaude: "/home/alex/.local/bin/claude").count > 0)
    #expect(!c.launchParts(resolvedClaude: "/home/alex/.local/bin/claude").keys.contains("TALOS_APP_BUNDLE"))
  }
}

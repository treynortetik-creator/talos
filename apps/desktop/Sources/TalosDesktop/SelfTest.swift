import AppKit
import ServiceManagement
import SwiftTerm
import TalosDesktopCore
import TalosSupervisor
import UserNotifications

enum SelfTest {
  /// Prints one JSON line and returns the exit code. No windows, no session, no login-item registration.
  static func run() -> Int32 {
    let bundleId = Bundle.main.bundleIdentifier ?? "none"
    let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"

    // Referencing a SwiftTerm type proves the library linked into this binary.
    let swiftterm = String(describing: SwiftTerm.Terminal.self).contains("Terminal")

    let defaultsDecode = (try? DesktopConfig.decode(DesktopConfig.defaults.encoded())) == DesktopConfig.defaults

    // UNUserNotificationCenter traps outside a bundled app, so only ask when we are one.
    var notifications = false
    if Bundle.main.bundleIdentifier != nil {
      let sem = DispatchSemaphore(value: 0)
      UNUserNotificationCenter.current().getNotificationSettings { _ in sem.signal() }
      notifications = sem.wait(timeout: .now() + 3) == .success
    }

    // The thread sessions' permission hook as every start checks it: in this bundle, read-only, inside a signature that holds.
    let hook: String
    switch WorkerHook.appSource.verified() {
    case .ok: hook = "ok"
    case .problem(let why): hook = why
    }

    let report = SelfTestReport(
      version: version, bundleId: bundleId, swiftterm: swiftterm,
      notificationsReachable: notifications,
      loginItemStatus: SMAppService.mainApp.status.rawValue,
      configDefaultsDecode: defaultsDecode, workerHook: hook)

    // Test hook for scripts/guards-test.sh: proves build-app.sh really fails when the selftest fails.
    if ProcessInfo.processInfo.environment["TALOS_SELFTEST_FORCE_FAIL"] == "1" {
      print("selftest: forced failure")
      return 1
    }
    guard let line = try? report.jsonLine() else { return 1 }
    print(line)
    return report.ok ? 0 : 1
  }
}

import Foundation
import ServiceManagement
import TalosDesktopCore

/// The real seams for `LoginItemManager`: `SMAppService.mainApp` and the user's LaunchAgents folder.
struct SMMainAppService: LoginItemService {
  var status: LoginItemPlan.Service {
    switch SMAppService.mainApp.status {
    case .enabled: return .enabled
    case .requiresApproval: return .requiresApproval
    case .notFound: return .notFound  // an ad-hoc app outside /Applications reports this (OBSERVED, DESKTOP-SPEC 6.5)
    default: return .notRegistered
    }
  }
  func register() throws { try SMAppService.mainApp.register() }
  func unregister() throws { try SMAppService.mainApp.unregister() }
}

struct RealLaunchAgentFiles: LaunchAgentFiles {
  func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
  func write(_ data: Data, to path: String) throws {
    let dir = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
  }
  func remove(_ path: String) throws { try FileManager.default.removeItem(atPath: path) }
}

@MainActor
final class LoginItemController: ObservableObject {
  static let shared = LoginItemController()
  @Published private(set) var isOn = false
  @Published private(set) var message = ""

  private var manager: LoginItemManager {
    LoginItemManager(
      service: SMMainAppService(), files: RealLaunchAgentFiles(), home: NSHomeDirectory(),
      bundleId: Bundle.main.bundleIdentifier ?? "app.talos.desktop",
      executable: Bundle.main.executablePath ?? CommandLine.arguments[0])
  }

  /// Reads the system's answer again, every time Mac settings opens. A switch that waits for macOS approval says so on every
  /// look, not only right after it was pressed (M27).
  func refresh() {
    let m = manager
    isOn = m.isOn
    if m.isPendingApproval {
      message = MacSettingsText.loginPending
    } else if message == MacSettingsText.loginPending {
      message = ""
    }
  }

  /// Only ever called from the owner's switch in Settings.
  func set(_ on: Bool) {
    let m = manager
    if on {
      switch m.turnOn() {
      case .registered: message = "Talos will start when you log in."
      case .needsApproval(let s): message = s
      case .fellBackToLaunchAgent: message = "Talos will start when you log in (through a LaunchAgent)."
      case .failed(let e): message = "Couldn't turn it on: \(e)"
      }
    } else {
      if case .failed(let e)? = m.turnOff() { message = "Couldn't turn it off: \(e)" } else { message = "" }
    }
    refresh()
  }
}
